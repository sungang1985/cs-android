#!/usr/bin/env python3
"""
package_apk.py - assemble an *unsigned* APK (a plain zip) from a binary AndroidManifest.xml,
one or more classes*.dex files and an assets directory. Python 3 stdlib only.

  package_apk.py build  --out unsigned.apk --manifest AndroidManifest.xml --dex classes.dex [--dex ...]
                        --assets-dir /path/to/www [--assets-prefix assets/www]
  package_apk.py add-v1 --apk unsigned.apk --from jarsigned.apk --out v1.apk
                        rebuild unsigned.apk with the JAR-signature entries (META-INF/MANIFEST.MF,
                        *.SF, *.RSA/.DSA/.EC) that jarsigner wrote into its own output placed first
                        (as signapk/apksig do), keeping every other entry aligned.

Entries are written deterministically (fixed timestamps, sorted paths). Files whose extension is
in aapt's "do not compress" list are STORED and 4-byte aligned (zipalign semantics, using the same
0xd935 extra-field padding apksig/zipalign use); everything else is DEFLATED. resources.arsc is
intentionally absent: this pipeline has no aapt2.
"""

import argparse
import os
import re
import struct
import sys
import zipfile

# aapt's default no-compress extensions plus already-compressed web assets.
NO_COMPRESS_EXT = {
    "jpg", "jpeg", "png", "gif", "webp", "wav", "mp2", "mp3", "ogg", "aac", "mpg", "mpeg", "mid", "midi",
    "smf", "jet", "rtttl", "imy", "xmf", "mp4", "m4a", "m4v", "3gp", "3gpp", "3g2", "3gpp2", "amr", "awb",
    "wma", "wmv", "webm", "mkv", "woff", "woff2",
}
ALIGNMENT_EXTRA_ID = 0xD935
ALIGN = 4
FIXED_DATE = (2000, 1, 1, 0, 0, 0)


def add_entry(zf, arcname, data, compress):
    info = zipfile.ZipInfo(arcname, date_time=FIXED_DATE)
    info.compress_type = zipfile.ZIP_DEFLATED if compress else zipfile.ZIP_STORED
    info.external_attr = 0o644 << 16
    if not compress:
        # Local header: 30 fixed bytes + name + extra. Pad the extra field so that the entry's
        # data starts on a 4-byte boundary (what zipalign -4 does).
        header_offset = zf.fp.tell()
        data_start = header_offset + 30 + len(arcname.encode("utf-8")) + 6
        pad = (-data_start) % ALIGN
        info.extra = struct.pack("<HHH", ALIGNMENT_EXTRA_ID, 2 + pad, ALIGN) + b"\x00" * pad
    zf.writestr(info, data)
    return info


def check_alignment(path):
    """Every STORED entry must have its data 4-byte aligned. Returns an error string or None."""
    with open(path, "rb") as fh, zipfile.ZipFile(fh) as zf:
        for info in zf.infolist():
            if info.compress_type != zipfile.ZIP_STORED:
                continue
            fh.seek(info.header_offset)
            sig, _v, _f, _m, _t, _d, _crc, _cs, _us, name_len, extra_len = struct.unpack("<IHHHHHIIIHH", fh.read(30))
            if sig != 0x04034B50:
                return "bad local header for %s" % info.filename
            data_off = info.header_offset + 30 + name_len + extra_len
            if data_off % ALIGN:
                return "%s is not %d-byte aligned (offset %d)" % (info.filename, ALIGN, data_off)
    return None


def is_v1_signature_entry(name):
    if not name.startswith("META-INF/") or "/" in name[len("META-INF/"):]:
        return False
    upper = name.upper()
    return upper == "META-INF/MANIFEST.MF" or upper.endswith((".SF", ".RSA", ".DSA", ".EC"))


def cmd_add_v1(args):
    with zipfile.ZipFile(args.src) as src:
        sig_entries = [i for i in src.infolist() if is_v1_signature_entry(i.filename)]
        if not any(i.filename.upper() == "META-INF/MANIFEST.MF" for i in sig_entries) or \
                not any(i.filename.upper().endswith(".SF") for i in sig_entries):
            print("package_apk: %s does not contain a JAR signature (META-INF/MANIFEST.MF + *.SF)" % args.src, file=sys.stderr)
            return 1
        payload = [(i.filename, src.read(i)) for i in sorted(sig_entries, key=lambda i: i.filename)]
    with zipfile.ZipFile(args.apk) as base:
        base_names = [i.filename for i in base.infolist()]
        if any(is_v1_signature_entry(n) for n in base_names):
            print("package_apk: %s already contains signature entries" % args.apk, file=sys.stderr)
            return 1
    # jarsigner must have digested exactly the entries we packaged.
    with zipfile.ZipFile(args.src) as src:
        src_names = sorted(n for n in src.namelist() if not is_v1_signature_entry(n))
    if sorted(base_names) != src_names:
        print("package_apk: entry lists of %s and %s differ" % (args.apk, args.src), file=sys.stderr)
        return 1
    def sig_order(item):
        upper = item[0].upper()
        return (0 if upper == "META-INF/MANIFEST.MF" else 1 if upper.endswith(".SF") else 2, item[0])

    tmp = args.out + ".tmp"
    with zipfile.ZipFile(args.apk) as base, open(tmp, "wb") as raw, \
            zipfile.ZipFile(raw, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for name, data in sorted(payload, key=sig_order):
            add_entry(zf, name, data, compress=True)
        for info in base.infolist():
            add_entry(zf, info.filename, base.read(info), compress=info.compress_type != zipfile.ZIP_STORED)
    err = check_alignment(tmp)
    if err:
        print("package_apk: " + err, file=sys.stderr)
        return 1
    os.replace(tmp, args.out)
    print("package_apk: wrote %s (%d bytes) = %s + %s (signature entries first, stored entries re-aligned)" % (
        args.out, os.path.getsize(args.out), ", ".join(n for n, _ in sorted(payload, key=sig_order)), os.path.basename(args.apk)))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="assemble an unsigned APK")
    b.add_argument("--out", required=True)
    b.add_argument("--manifest", required=True, help="binary AndroidManifest.xml")
    b.add_argument("--dex", action="append", required=True, help="classes.dex (repeat for classes2.dex ...)")
    b.add_argument("--assets-dir", required=True)
    b.add_argument("--assets-prefix", default="assets/www")
    v = sub.add_parser("add-v1", help="append jarsigner's META-INF signature entries to an aligned APK")
    v.add_argument("--apk", required=True, help="the aligned unsigned APK")
    v.add_argument("--from", dest="src", required=True, help="jarsigner's -signedjar output for the same APK")
    v.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    if args.cmd == "add-v1":
        return cmd_add_v1(args)

    if not os.path.isdir(args.assets_dir):
        print("package_apk: assets dir not found: %s" % args.assets_dir, file=sys.stderr)
        return 1

    entries = []  # (arcname, path)
    for root, dirs, files in os.walk(args.assets_dir):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for f in sorted(files):
            if f.startswith("."):
                continue
            path = os.path.join(root, f)
            rel = os.path.relpath(path, args.assets_dir).replace(os.sep, "/")
            entries.append((args.assets_prefix.rstrip("/") + "/" + rel, path))
    if not entries:
        print("package_apk: no files under %s" % args.assets_dir, file=sys.stderr)
        return 1

    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    tmp = args.out + ".tmp"
    stored = deflated = 0
    with open(tmp, "wb") as raw, zipfile.ZipFile(raw, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        with open(args.manifest, "rb") as fh:
            add_entry(zf, "AndroidManifest.xml", fh.read(), compress=True)
        deflated += 1
        dex_names = [os.path.basename(d) for d in args.dex]
        if "classes.dex" not in dex_names or any(not re.fullmatch(r"classes\d*\.dex", n) for n in dex_names):
            print("package_apk: dex files must be named classes.dex, classes2.dex, ...: %s" % dex_names, file=sys.stderr)
            return 1
        for dex in args.dex:
            with open(dex, "rb") as fh:
                add_entry(zf, os.path.basename(dex), fh.read(), compress=True)
            deflated += 1
        for arcname, path in entries:
            ext = arcname.rsplit(".", 1)[-1].lower() if "." in arcname.rsplit("/", 1)[-1] else ""
            compress = ext not in NO_COMPRESS_EXT
            with open(path, "rb") as fh:
                add_entry(zf, arcname, fh.read(), compress=compress)
            if compress:
                deflated += 1
            else:
                stored += 1
    err = check_alignment(tmp)
    if err:
        print("package_apk: " + err, file=sys.stderr)
        return 1
    os.replace(tmp, args.out)
    print("package_apk: wrote %s (%d bytes, %d entries: %d deflated, %d stored+aligned)" % (
        args.out, os.path.getsize(args.out), 1 + len(args.dex) + len(entries), deflated, stored))
    return 0


if __name__ == "__main__":
    sys.exit(main())
