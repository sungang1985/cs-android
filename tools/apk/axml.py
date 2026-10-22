#!/usr/bin/env python3
"""
axml.py - a small Android binary XML (AXML) encoder/decoder. Python 3 stdlib only.

Part of the experimental SDK-less APK pipeline (tools/apk/build-apk.sh). It turns the
text manifest template into the binary AndroidManifest.xml that Android's package manager
expects, so that neither aapt nor aapt2 is needed.

Sub-commands
  encode       --template FILE --out FILE [--var KEY=VALUE ...] [--ids ids.json] [--utf16]
  dump         FILE                       decode a binary XML and print it (self-check)
  resolve-ids  --android-jar JAR --out ids.json
               run `javap -constants` on android.R$attr / android.R$style inside the given
               framework jar and write the resource ids as JSON (used to cross-check the
               built-in attribute table and to resolve @android:style/... references).

Format reference: frameworks/base/libs/androidfw/include/androidfw/ResourceTypes.h
(ResChunk_header, ResStringPool_header, ResXMLTree_node, ResXMLTree_attrExt, Res_value).

Limitations (by design): no resources.arsc, so only literal values and framework
(@android:...) references can be encoded; no text/CDATA nodes; namespaces must be declared
on the root element.
"""

import argparse
import json
import os
import re
import shutil
import struct
import subprocess
import sys
from xml.parsers import expat
from xml.sax.saxutils import escape as xml_escape

ANDROID_NS = "http://schemas.android.com/apk/res/android"

# ResChunk_header.type values
RES_STRING_POOL_TYPE = 0x0001
RES_XML_TYPE = 0x0003
RES_XML_START_NAMESPACE_TYPE = 0x0100
RES_XML_END_NAMESPACE_TYPE = 0x0101
RES_XML_START_ELEMENT_TYPE = 0x0102
RES_XML_END_ELEMENT_TYPE = 0x0103
RES_XML_CDATA_TYPE = 0x0104
RES_XML_RESOURCE_MAP_TYPE = 0x0180

# Res_value.dataType values
TYPE_NULL = 0x00
TYPE_REFERENCE = 0x01
TYPE_STRING = 0x03
TYPE_INT_DEC = 0x10
TYPE_INT_HEX = 0x11
TYPE_INT_BOOLEAN = 0x12

UTF8_FLAG = 1 << 8
NO_INDEX = 0xFFFFFFFF

# android:<name> -> (public resource id, value kind).  The ids are the stable public ids from
# android.R.attr; `resolve-ids` cross-checks them against the real framework jar at build time.
# kinds: string | reference | bool | int | enum | flags
ANDROID_ATTRS = {
    "theme": (0x01010000, "reference"),
    "label": (0x01010001, "string"),
    "icon": (0x01010002, "reference"),
    "name": (0x01010003, "string"),
    "permission": (0x01010006, "string"),
    "debuggable": (0x0101000F, "bool"),
    "exported": (0x01010010, "bool"),
    "launchMode": (0x0101001D, "enum"),
    "screenOrientation": (0x0101001E, "enum"),
    "configChanges": (0x0101001F, "flags"),
    "value": (0x01010024, "string"),
    "resource": (0x01010025, "reference"),
    "minSdkVersion": (0x0101020C, "int"),
    "versionCode": (0x0101021B, "int"),
    "versionName": (0x0101021C, "string"),
    "targetSdkVersion": (0x01010270, "int"),
    "allowBackup": (0x01010280, "bool"),
    "glEsVersion": (0x01010281, "int"),
    "required": (0x0101028E, "bool"),
    "immersive": (0x010102C0, "bool"),
    "hardwareAccelerated": (0x010102D3, "bool"),
    "supportsRtl": (0x010103AF, "bool"),
    "extractNativeLibs": (0x010104EA, "bool"),
    "usesCleartextTraffic": (0x010104EC, "bool"),
    "resizeableActivity": (0x010104F6, "bool"),
}

# Enum / flag symbol tables (frameworks/base/core/res/res/values/attrs_manifest.xml).
ENUMS = {
    "launchMode": {
        "standard": 0, "singleTop": 1, "singleTask": 2, "singleInstance": 3, "singleInstancePerTask": 4,
    },
    "screenOrientation": {
        "unspecified": -1, "landscape": 0, "portrait": 1, "user": 2, "behind": 3, "sensor": 4,
        "nosensor": 5, "sensorLandscape": 6, "sensorPortrait": 7, "reverseLandscape": 8,
        "reversePortrait": 9, "fullSensor": 10, "userLandscape": 11, "userPortrait": 12,
        "fullUser": 13, "locked": 14,
    },
}
FLAGS = {
    "configChanges": {
        "mcc": 0x0001, "mnc": 0x0002, "locale": 0x0004, "touchscreen": 0x0008, "keyboard": 0x0010,
        "keyboardHidden": 0x0020, "navigation": 0x0040, "orientation": 0x0080, "screenLayout": 0x0100,
        "uiMode": 0x0200, "screenSize": 0x0400, "smallestScreenSize": 0x0800, "density": 0x1000,
        "layoutDirection": 0x2000, "colorMode": 0x4000, "grammaticalGender": 0x8000,
        "fontWeightAdjustment": 0x10000000, "fontScale": 0x40000000,
    },
}

# Fallback for @android:style/... references when no ids.json is supplied (android.R.style).
FRAMEWORK_STYLES = {
    "Theme_Material_NoActionBar": 0x0103022E,
    "Theme_Material_NoActionBar_Fullscreen": 0x0103022F,
}


class AxmlError(Exception):
    pass


# --------------------------------------------------------------------------- parsing

class Node:
    __slots__ = ("ns", "name", "attrs", "children", "line")

    def __init__(self, ns, name, line):
        self.ns = ns          # namespace uri or None
        self.name = name
        self.attrs = []       # list of (ns uri or None, local name, value)
        self.children = []
        self.line = line


def substitute(text, variables):
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)  # comments may mention ${PLACEHOLDERS}

    def repl(m):
        key = m.group(1)
        if key not in variables:
            raise AxmlError("template placeholder ${%s} has no value (pass --var %s=...)" % (key, key))
        return xml_escape(variables[key], {'"': "&quot;"})
    return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", repl, text)


def parse_template(text):
    sep = " "  # cannot occur in XML names or namespace URIs
    parser = expat.ParserCreate(namespace_separator=sep)
    parser.ordered_attributes = True
    ns_decls = []          # (prefix, uri) in declaration order (root element only)
    stack = []
    root = [None]

    def split(qname):
        if sep in qname:
            uri, local = qname.split(sep, 1)
            return uri, local
        return None, qname

    def start_ns(prefix, uri):
        if stack:
            raise AxmlError("namespace declarations are only supported on the root element (xmlns:%s)" % prefix)
        if not prefix:
            raise AxmlError("default namespaces are not supported")
        ns_decls.append((prefix, uri))

    def start(name, attrs):
        uri, local = split(name)
        node = Node(uri, local, parser.CurrentLineNumber)
        for i in range(0, len(attrs), 2):
            auri, alocal = split(attrs[i])
            node.attrs.append((auri, alocal, attrs[i + 1]))
        if stack:
            stack[-1].children.append(node)
        else:
            root[0] = node
        stack.append(node)

    def end(_name):
        stack.pop()

    def chars(data):
        if data.strip():
            raise AxmlError("text content is not supported (line %d): %r" % (parser.CurrentLineNumber, data.strip()))

    parser.StartNamespaceDeclHandler = start_ns
    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = chars
    try:
        parser.Parse(text, True)
    except expat.ExpatError as e:
        raise AxmlError("XML parse error: %s" % e)
    if root[0] is None:
        raise AxmlError("empty document")
    return root[0], ns_decls


# --------------------------------------------------------------------------- string pool

class StringPool:
    def __init__(self):
        self.strings = []
        self.index = {}

    def add(self, s):
        if s not in self.index:
            self.index[s] = len(self.strings)
            self.strings.append(s)
        return self.index[s]

    def __getitem__(self, s):
        return self.index[s]

    @staticmethod
    def _len8(n):
        if n > 0x7FFF:
            raise AxmlError("string too long for UTF-8 pool")
        return bytes([((n >> 8) & 0x7F) | 0x80, n & 0xFF]) if n > 0x7F else bytes([n])

    @staticmethod
    def _len16(n):
        if n > 0x7FFFFFFF:
            raise AxmlError("string too long for UTF-16 pool")
        return struct.pack("<HH", ((n >> 16) & 0x7FFF) | 0x8000, n & 0xFFFF) if n > 0x7FFF else struct.pack("<H", n)

    def encode(self, utf8=True):
        offsets = []
        data = bytearray()
        for s in self.strings:
            offsets.append(len(data))
            if utf8:
                b = s.encode("utf-8")
                u16len = len(s.encode("utf-16-le")) // 2
                data += self._len8(u16len) + self._len8(len(b)) + b + b"\x00"
            else:
                u = s.encode("utf-16-le")
                data += self._len16(len(u) // 2) + u + b"\x00\x00"
        while len(data) % 4:
            data += b"\x00"
        count = len(self.strings)
        header_size = 28
        strings_start = header_size + 4 * count
        total = strings_start + len(data)
        flags = UTF8_FLAG if utf8 else 0
        header = struct.pack("<HHIIIIII", RES_STRING_POOL_TYPE, header_size, total, count, 0, flags, strings_start, 0)
        return header + b"".join(struct.pack("<I", o) for o in offsets) + bytes(data)


# --------------------------------------------------------------------------- encoding

def parse_reference(value, ids):
    """'@android:style/Theme.X' or '@android:0x0103022f' or '@0x0103022f' -> resource id."""
    m = re.match(r"^@(?:([A-Za-z_][\w.]*):)?(?:0[xX]([0-9A-Fa-f]{1,8})|([A-Za-z_]\w*)/([\w.]+))$", value)
    if not m:
        raise AxmlError("malformed resource reference %r" % value)
    pkg, hexid, rtype, rname = m.groups()
    if hexid is not None:
        rid = int(hexid, 16)
    else:
        if pkg != "android":
            raise AxmlError("reference %r needs app resources (resources.arsc), which this pipeline cannot build; "
                            "use a literal value or an @android: framework resource" % value)
        key = rname.replace(".", "_")
        table = (ids or {}).get(rtype, {})
        if key in table:
            rid = int(table[key])
        elif rtype == "style" and key in FRAMEWORK_STYLES:
            rid = FRAMEWORK_STYLES[key]
        else:
            raise AxmlError("unknown framework resource %r (not found in ids table)" % value)
    if (rid >> 24) != 0x01:
        raise AxmlError("reference %r (0x%08x) is not a framework (0x01......) resource" % (value, rid))
    return rid


def parse_int(value):
    v = value.strip()
    if re.match(r"^-?0[xX][0-9A-Fa-f]+$", v):
        return TYPE_INT_HEX, int(v, 16) & 0xFFFFFFFF
    if re.match(r"^-?\d+$", v):
        return TYPE_INT_DEC, int(v) & 0xFFFFFFFF
    raise AxmlError("not an integer: %r" % value)


def typed_value(name, kind, value, ids):
    """-> (dataType, data) for an android: attribute."""
    if value.startswith("@"):
        return TYPE_REFERENCE, parse_reference(value, ids)
    if kind == "reference":
        raise AxmlError("android:%s must be a resource reference, got %r" % (name, value))
    if kind == "string":
        return TYPE_STRING, None
    if kind == "bool":
        if value == "true":
            return TYPE_INT_BOOLEAN, 0xFFFFFFFF
        if value == "false":
            return TYPE_INT_BOOLEAN, 0
        raise AxmlError("android:%s must be true/false, got %r" % (name, value))
    if kind == "int":
        return parse_int(value)
    if kind == "enum":
        table = ENUMS[name]
        if value not in table:
            raise AxmlError("android:%s: unknown enum value %r (known: %s)" % (name, value, ", ".join(table)))
        return TYPE_INT_DEC, table[value] & 0xFFFFFFFF
    if kind == "flags":
        table = FLAGS[name]
        bits = 0
        for part in value.split("|"):
            part = part.strip()
            if part not in table:
                raise AxmlError("android:%s: unknown flag %r (known: %s)" % (name, part, ", ".join(table)))
            bits |= table[part]
        return TYPE_INT_HEX, bits
    raise AxmlError("internal: unknown kind %r" % kind)


def check_attr_ids(ids):
    """Cross-check the built-in table against ids resolved from the framework jar."""
    attr_ids = (ids or {}).get("attr")
    if not attr_ids:
        return
    for name, (rid, _kind) in ANDROID_ATTRS.items():
        real = attr_ids.get(name)
        if real is None:
            raise AxmlError("android:%s is not a public attribute of the framework jar" % name)
        if int(real) != rid:
            raise AxmlError("android:%s id mismatch: table 0x%08x, framework 0x%08x" % (name, rid, int(real)))


def encode(template_text, variables, ids=None, utf8=True):
    text = substitute(template_text, variables)
    root, ns_decls = parse_template(text)
    check_attr_ids(ids)

    # Pass 1: collect strings.  Attribute names that carry resource ids come first (that prefix
    # of the pool is what the resource-map chunk describes), sorted by id like aapt does.
    used_attr_names = set()
    plain_strings = []  # everything else, in document order

    def walk_collect(node):
        plain_strings.append(node.name)
        for ns, name, value in node.attrs:
            if ns == ANDROID_NS:
                if name not in ANDROID_ATTRS:
                    raise AxmlError("android:%s (line %d) is not in the attribute table of axml.py" % (name, node.line))
                used_attr_names.add(name)
                _rid, kind = ANDROID_ATTRS[name]
                dtype, _ = typed_value(name, kind, value, ids)
                if dtype == TYPE_STRING:
                    plain_strings.append(value)
            elif ns is None:
                plain_strings.append(name)
                plain_strings.append(value)
            else:
                raise AxmlError("attribute %s in namespace %s (line %d) is not supported" % (name, ns, node.line))
        for child in node.children:
            walk_collect(child)

    walk_collect(root)

    pool = StringPool()
    mapped = sorted(used_attr_names, key=lambda n: ANDROID_ATTRS[n][0])
    resource_ids = []
    for name in mapped:
        pool.add(name)
        resource_ids.append(ANDROID_ATTRS[name][0])
    for prefix, uri in ns_decls:
        pool.add(uri)
        pool.add(prefix)
    for s in plain_strings:
        pool.add(s)

    # Pass 2: emit chunks.
    out = bytearray()

    def node_header(chunk_type, size, line):
        return struct.pack("<HHIII", chunk_type, 16, size, line, NO_INDEX)

    def walk_emit(node):
        attrs = []
        for ns, name, value in node.attrs:
            if ns == ANDROID_NS:
                rid, kind = ANDROID_ATTRS[name]
                dtype, data = typed_value(name, kind, value, ids)
                raw = NO_INDEX
                if dtype == TYPE_STRING:
                    data = pool[value]
                    raw = data
                attrs.append(((0, rid), pool[ANDROID_NS], pool[name], raw, dtype, data))
            else:
                attrs.append(((1, name), NO_INDEX, pool[name], pool[value], TYPE_STRING, pool[value]))
        attrs.sort(key=lambda a: a[0])  # by resource id, then plain attributes by name
        ns_index = pool[node.ns] if node.ns else NO_INDEX
        size = 16 + 20 + 20 * len(attrs)
        chunk = bytearray(node_header(RES_XML_START_ELEMENT_TYPE, size, node.line))
        chunk += struct.pack("<IIHHHHHH", ns_index, pool[node.name], 20, 20, len(attrs), 0, 0, 0)
        for _key, a_ns, a_name, raw, dtype, data in attrs:
            chunk += struct.pack("<IIIHBBI", a_ns, a_name, raw, 8, 0, dtype, data)
        out.extend(chunk)
        for child in node.children:
            walk_emit(child)
        out.extend(node_header(RES_XML_END_ELEMENT_TYPE, 24, node.line) + struct.pack("<II", ns_index, pool[node.name]))

    for prefix, uri in ns_decls:
        out.extend(node_header(RES_XML_START_NAMESPACE_TYPE, 24, root.line) + struct.pack("<II", pool[prefix], pool[uri]))
    walk_emit(root)
    for prefix, uri in reversed(ns_decls):
        out.extend(node_header(RES_XML_END_NAMESPACE_TYPE, 24, root.line) + struct.pack("<II", pool[prefix], pool[uri]))

    pool_bytes = pool.encode(utf8=utf8)
    resmap = struct.pack("<HHI", RES_XML_RESOURCE_MAP_TYPE, 8, 8 + 4 * len(resource_ids))
    resmap += b"".join(struct.pack("<I", rid) for rid in resource_ids)
    body = pool_bytes + resmap + bytes(out)
    return struct.pack("<HHI", RES_XML_TYPE, 8, 8 + len(body)) + body


# --------------------------------------------------------------------------- decoding (self-check)

def decode(data):
    """Decode binary XML into a list of text lines (a simple pretty-printer)."""
    if len(data) < 8:
        raise AxmlError("file too short")
    ctype, hsize, total = struct.unpack_from("<HHI", data, 0)
    if ctype != RES_XML_TYPE or hsize != 8 or total != len(data):
        raise AxmlError("bad file header: type=0x%04x headerSize=%d size=%d (file %d bytes)" % (ctype, hsize, total, len(data)))
    pos = 8
    strings = None
    resource_ids = []
    lines = []
    depth = 0
    prefixes = {}  # uri -> prefix

    def read_pool(off):
        (ptype, phs, psize, count, style_count, flags, strings_start, _styles_start) = struct.unpack_from("<HHIIIIII", data, off)
        if ptype != RES_STRING_POOL_TYPE or phs != 28:
            raise AxmlError("bad string pool header")
        offsets = struct.unpack_from("<%dI" % count, data, off + 28)
        base = off + strings_start
        result = []
        for o in offsets:
            p = base + o
            if flags & UTF8_FLAG:
                def len8(p):
                    n = data[p]
                    return ((n & 0x7F) << 8 | data[p + 1], p + 2) if n & 0x80 else (n, p + 1)
                _u16len, p = len8(p)
                blen, p = len8(p)
                if data[p + blen] != 0:
                    raise AxmlError("UTF-8 string not null terminated")
                result.append(data[p:p + blen].decode("utf-8"))
            else:
                n = struct.unpack_from("<H", data, p)[0]
                p += 2
                if n & 0x8000:
                    n = (n & 0x7FFF) << 16 | struct.unpack_from("<H", data, p)[0]
                    p += 2
                if data[p + 2 * n:p + 2 * n + 2] != b"\x00\x00":
                    raise AxmlError("UTF-16 string not null terminated")
                result.append(data[p:p + 2 * n].decode("utf-16-le"))
        return result, psize

    def s(i):
        return None if i == NO_INDEX else strings[i]

    def fmt(dtype, raw, value):
        if dtype == TYPE_STRING:
            return s(value)
        if dtype == TYPE_REFERENCE:
            return "@0x%08x" % value
        if dtype == TYPE_INT_BOOLEAN:
            return "true" if value else "false"
        if dtype == TYPE_INT_DEC:
            return str(value - (1 << 32) if value & 0x80000000 else value)
        if dtype == TYPE_INT_HEX:
            return "0x%08x" % value
        if dtype == TYPE_NULL:
            return "@null"
        return "<type 0x%02x: 0x%08x>" % (dtype, value)

    while pos < total:
        ctype, hsize, csize = struct.unpack_from("<HHI", data, pos)
        if csize < hsize or pos + csize > total:
            raise AxmlError("bad chunk at 0x%x" % pos)
        if ctype == RES_STRING_POOL_TYPE:
            strings, _ = read_pool(pos)
        elif ctype == RES_XML_RESOURCE_MAP_TYPE:
            resource_ids = list(struct.unpack_from("<%dI" % ((csize - hsize) // 4), data, pos + hsize))
        elif ctype in (RES_XML_START_NAMESPACE_TYPE, RES_XML_END_NAMESPACE_TYPE):
            prefix, uri = struct.unpack_from("<II", data, pos + 16)
            if ctype == RES_XML_START_NAMESPACE_TYPE:
                prefixes[s(uri)] = s(prefix)
                lines.append("%sxmlns:%s=\"%s\"" % ("  " * depth, s(prefix), s(uri)))
        elif ctype == RES_XML_START_ELEMENT_TYPE:
            ns, name, attr_start, attr_size, attr_count, _id, _cls, _style = struct.unpack_from("<IIHHHHHH", data, pos + 16)
            parts = []
            p = pos + 16 + attr_start
            for _ in range(attr_count):
                a_ns, a_name, raw, _sz, _res0, dtype, value = struct.unpack_from("<IIIHBBI", data, p)
                p += attr_size
                aname = s(a_name)
                if a_ns != NO_INDEX:
                    aname = "%s:%s" % (prefixes.get(s(a_ns), s(a_ns)), aname)
                    if a_name < len(resource_ids):
                        aname += "(0x%08x)" % resource_ids[a_name]
                parts.append('%s="%s"' % (aname, fmt(dtype, raw, value)))
            tag = s(name) if ns == NO_INDEX else "%s:%s" % (prefixes.get(s(ns), s(ns)), s(name))
            lines.append("%s<%s%s>" % ("  " * depth, tag, (" " + " ".join(parts)) if parts else ""))
            depth += 1
        elif ctype == RES_XML_END_ELEMENT_TYPE:
            depth -= 1
            _ns, name = struct.unpack_from("<II", data, pos + 16)
            lines.append("%s</%s>" % ("  " * depth, s(name)))
        elif ctype == RES_XML_CDATA_TYPE:
            name = struct.unpack_from("<I", data, pos + 16)[0]
            lines.append("%s%s" % ("  " * depth, s(name)))
        else:
            raise AxmlError("unknown chunk type 0x%04x at 0x%x" % (ctype, pos))
        pos += csize
    if depth != 0:
        raise AxmlError("unbalanced elements")
    return lines


# --------------------------------------------------------------------------- resolve-ids

def resolve_ids(android_jar):
    javap = shutil.which("javap")
    if not javap and os.environ.get("JAVA_HOME"):
        cand = os.path.join(os.environ["JAVA_HOME"], "bin", "javap")
        if os.path.exists(cand):
            javap = cand
    if not javap:
        raise AxmlError("javap not found (install a JDK or set JAVA_HOME)")
    env = dict(os.environ)
    env.pop("JAVA_TOOL_OPTIONS", None)  # keep stdout clean
    cmd = [javap, "-constants", "-cp", android_jar, "android.R$attr", "android.R$style"]
    proc = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        raise AxmlError("javap failed: %s" % proc.stderr.strip())
    tables = {}
    current = None
    for line in proc.stdout.splitlines():
        m = re.search(r"class android\.R\$(\w+)", line)
        if m:
            current = m.group(1)
            tables.setdefault(current, {})
            continue
        m = re.match(r"\s*public static final int (\w+) = (-?\d+);", line)
        if m and current:
            tables[current][m.group(1)] = int(m.group(2))
    for key in ("attr", "style"):
        if not tables.get(key):
            raise AxmlError("javap output contained no android.R$%s constants" % key)
    return tables


# --------------------------------------------------------------------------- CLI

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("encode", help="compile a text manifest template into binary XML")
    e.add_argument("--template", required=True)
    e.add_argument("--out", required=True)
    e.add_argument("--var", action="append", default=[], metavar="KEY=VALUE")
    e.add_argument("--ids", help="ids.json written by resolve-ids")
    e.add_argument("--utf16", action="store_true", help="use a UTF-16 string pool (default UTF-8)")

    d = sub.add_parser("dump", help="decode a binary XML file and print it")
    d.add_argument("file")

    r = sub.add_parser("resolve-ids", help="extract android.R$attr/$style ids from a framework jar via javap")
    r.add_argument("--android-jar", required=True)
    r.add_argument("--out", required=True)

    args = ap.parse_args(argv)
    try:
        if args.cmd == "encode":
            variables = {}
            for item in args.var:
                if "=" not in item:
                    raise AxmlError("--var expects KEY=VALUE, got %r" % item)
                k, v = item.split("=", 1)
                variables[k] = v
            ids = None
            if args.ids:
                with open(args.ids, "r", encoding="utf-8") as fh:
                    ids = json.load(fh)
            with open(args.template, "r", encoding="utf-8") as fh:
                template = fh.read()
            blob = encode(template, variables, ids=ids, utf8=not args.utf16)
            decode(blob)  # self-check: must round-trip through our own decoder
            with open(args.out, "wb") as fh:
                fh.write(blob)
            print("axml: wrote %s (%d bytes, %s string pool)" % (args.out, len(blob), "UTF-16" if args.utf16 else "UTF-8"))
        elif args.cmd == "dump":
            with open(args.file, "rb") as fh:
                data = fh.read()
            for line in decode(data):
                print(line)
        elif args.cmd == "resolve-ids":
            tables = resolve_ids(args.android_jar)
            with open(args.out, "w", encoding="utf-8") as fh:
                json.dump(tables, fh, indent=1, sort_keys=True)
            print("axml: resolved %d attr ids and %d style ids from %s -> %s" % (
                len(tables["attr"]), len(tables["style"]), os.path.basename(args.android_jar), args.out))
    except AxmlError as exc:
        print("axml: error: %s" % exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
