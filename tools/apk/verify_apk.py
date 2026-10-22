#!/usr/bin/env python3
"""
verify_apk.py - independent verification of the APK produced by tools/apk/build-apk.sh, using
androguard (installed by build-apk.sh into a venv under the toolchain cache dir).

Checks:
  1. the binary AndroidManifest.xml decodes with androguard's AXMLPrinter and the round-tripped
     XML contains the expected elements/attributes (package, uses-sdk, permission, application,
     activity, intent-filter),
  2. classes.dex parses with androguard's DEX parser and contains the expected classes,
  3. the APK parses with androguard's APK class (package, main activity, sdk versions, version
     code/name, label, permissions, files) and is signed with v1 and v2,
  4. every STORED zip entry is 4-byte aligned (zipalign semantics) in the *signed* APK.

Exit status is non-zero if any check fails.
"""

import argparse
import re
import struct
import sys
import zipfile
import xml.etree.ElementTree as ET

from loguru import logger

logger.remove()
logger.add(sys.stderr, level="WARNING")

from androguard.core.apk import APK  # noqa: E402
from androguard.core.axml import AXMLPrinter  # noqa: E402
from androguard.core.dex import DEX  # noqa: E402

ANDROID_NS = "http://schemas.android.com/apk/res/android"
A = "{%s}" % ANDROID_NS

failures = []
passed = 0


def check(cond, what, actual=None):
    global passed
    if cond:
        passed += 1
        print("  ok   %s%s" % (what, "" if actual is None else " = %r" % (actual,)))
    else:
        failures.append(what)
        print("  FAIL %s%s" % (what, "" if actual is None else " (got %r)" % (actual,)))


def as_int(value):
    """androguard renders ints as '12', hex as '0x0000001F', refs as '@0103022F' or '@android:0103022F'."""
    if value is None:
        return None
    v = value.strip()
    v = re.sub(r"^@(android:)?", "", v)
    if v.lower().startswith("0x"):
        return int(v, 16)
    if re.fullmatch(r"-?\d+", v):
        return int(v)
    if re.fullmatch(r"[0-9A-Fa-f]{8}", v):
        return int(v, 16)
    raise ValueError("not an int-ish value: %r" % value)


def check_manifest(raw, args):
    print("[1/4] AndroidManifest.xml via androguard AXMLPrinter")
    printer = AXMLPrinter(raw)
    check(printer.is_valid(), "AXMLPrinter.is_valid()")
    check(not printer.is_packed(), "AXMLPrinter.is_packed() is False")
    xml_bytes = printer.get_xml()
    root = ET.fromstring(xml_bytes)
    print("  --- round-tripped XML ---")
    for line in xml_bytes.decode("utf-8").splitlines():
        print("  | " + line)
    print("  -------------------------")
    check(root.tag == "manifest", "root element is <manifest>", root.tag)
    check(root.get("package") == args.package, "manifest package", root.get("package"))
    check(as_int(root.get(A + "versionCode")) == args.version_code, "android:versionCode", root.get(A + "versionCode"))
    check(root.get(A + "versionName") == args.version_name, "android:versionName", root.get(A + "versionName"))

    sdk = root.find("uses-sdk")
    check(sdk is not None, "<uses-sdk> present")
    if sdk is not None:
        check(as_int(sdk.get(A + "minSdkVersion")) == args.min_sdk, "uses-sdk minSdkVersion", sdk.get(A + "minSdkVersion"))
        check(as_int(sdk.get(A + "targetSdkVersion")) == args.target_sdk, "uses-sdk targetSdkVersion", sdk.get(A + "targetSdkVersion"))

    perms = [p.get(A + "name") for p in root.findall("uses-permission")]
    check("android.permission.VIBRATE" in perms, "uses-permission VIBRATE", perms)
    feats = {(f.get(A + "name"), f.get(A + "glEsVersion"), f.get(A + "required")) for f in root.findall("uses-feature")}
    check(any(f[0] == "android.hardware.touchscreen" and f[2] == "true" for f in feats), "uses-feature touchscreen required", feats)
    check(any(f[1] is not None and as_int(f[1]) == 0x00030000 for f in feats), "uses-feature glEsVersion 0x00030000", feats)

    app = root.find("application")
    check(app is not None, "<application> present")
    if app is not None:
        check(app.get(A + "label") == args.label, "application android:label literal", app.get(A + "label"))
        check(app.get(A + "hardwareAccelerated") == "true", "application hardwareAccelerated", app.get(A + "hardwareAccelerated"))
        check(app.get(A + "allowBackup") == "true", "application allowBackup", app.get(A + "allowBackup"))
        check(app.get(A + "debuggable") == args.debuggable, "application debuggable", app.get(A + "debuggable"))
        check(app.get(A + "supportsRtl") == "false", "application supportsRtl", app.get(A + "supportsRtl"))
        check(app.get(A + "usesCleartextTraffic") == "false", "application usesCleartextTraffic", app.get(A + "usesCleartextTraffic"))
        theme = app.get(A + "theme")
        check(theme is not None and as_int(theme) == args.theme_id, "application theme = framework ref 0x%08x" % args.theme_id, theme)
        check(app.get(A + "icon") is None, "application has no icon (default icon)")

        acts = app.findall("activity")
        check(len(acts) == 1, "exactly one <activity>", len(acts))
        if acts:
            act = acts[0]
            check(act.get(A + "name") == args.activity, "activity android:name", act.get(A + "name"))
            check(act.get(A + "exported") == "true", "activity exported", act.get(A + "exported"))
            check(as_int(act.get(A + "launchMode")) == 2, "activity launchMode singleTask (2)", act.get(A + "launchMode"))
            check(as_int(act.get(A + "screenOrientation")) == 6, "activity screenOrientation sensorLandscape (6)", act.get(A + "screenOrientation"))
            check(as_int(act.get(A + "configChanges")) == 0x1FA0, "activity configChanges 0x1fa0", act.get(A + "configChanges"))
            check(act.get(A + "resizeableActivity") == "false", "activity resizeableActivity", act.get(A + "resizeableActivity"))
            check(act.get(A + "immersive") == "true", "activity immersive", act.get(A + "immersive"))
            actions = [a.get(A + "name") for a in act.findall("intent-filter/action")]
            cats = [c.get(A + "name") for c in act.findall("intent-filter/category")]
            check("android.intent.action.MAIN" in actions, "intent-filter action MAIN", actions)
            check("android.intent.category.LAUNCHER" in cats, "intent-filter category LAUNCHER", cats)


def check_dex(raw, args):
    print("[2/4] classes.dex via androguard DEX parser")
    d = DEX(raw)
    names = set(d.get_classes_names())
    check(len(names) > 0, "dex class count", len(names))
    for cls in args.expect_class:
        check(cls in names, "dex contains %s" % cls)
    check(any(n.startswith("Lkotlin/") for n in names), "dex contains kotlin stdlib classes")
    methods = d.get_methods()
    check(any(m.get_class_name() == args.expect_class[0] for m in methods) if args.expect_class else True,
          "dex has methods for %s" % (args.expect_class[0] if args.expect_class else "-"))


def check_apk(path, args):
    print("[3/4] APK via androguard APK class")
    a = APK(path)
    check(a.get_package() == args.package, "APK.get_package()", a.get_package())
    check(a.get_main_activity() == args.activity, "APK.get_main_activity()", a.get_main_activity())
    check(as_int(a.get_min_sdk_version()) == args.min_sdk, "APK.get_min_sdk_version()", a.get_min_sdk_version())
    check(as_int(a.get_target_sdk_version()) == args.target_sdk, "APK.get_target_sdk_version()", a.get_target_sdk_version())
    check(as_int(a.get_androidversion_code()) == args.version_code, "APK.get_androidversion_code()", a.get_androidversion_code())
    check(a.get_androidversion_name() == args.version_name, "APK.get_androidversion_name()", a.get_androidversion_name())
    check(a.get_app_name() == args.label, "APK.get_app_name()", a.get_app_name())
    check("android.permission.VIBRATE" in a.get_permissions(), "APK.get_permissions() has VIBRATE", a.get_permissions())
    check(a.is_signed_v1(), "APK.is_signed_v1()", a.is_signed_v1())
    check(a.is_signed_v2(), "APK.is_signed_v2()", a.is_signed_v2())
    print("  info APK.is_signed_v3() = %r (apksig 2.3.0 cannot produce v3)" % a.is_signed_v3())
    files = set(a.get_files())
    for f in args.expect_file:
        check(f in files, "APK contains %s" % f)
    check("resources.arsc" not in files, "APK has no resources.arsc (by design)")
    certs = a.get_certificates()
    check(len(certs) >= 1, "APK signer certificates", [c.subject.human_friendly for c in certs])


def check_alignment(path):
    print("[4/4] zip alignment of STORED entries (zipalign -c -4 semantics)")
    with open(path, "rb") as fh, zipfile.ZipFile(fh) as zf:
        stored = 0
        bad = []
        for info in zf.infolist():
            if info.compress_type != zipfile.ZIP_STORED:
                continue
            fh.seek(info.header_offset)
            sig, _v, _f, _m, _t, _d, _crc, _cs, _us, name_len, extra_len = struct.unpack("<IHHHHHIIIHH", fh.read(30))
            if sig != 0x04034B50:
                bad.append((info.filename, "bad local header"))
                continue
            data_off = info.header_offset + 30 + name_len + extra_len
            stored += 1
            if data_off % 4:
                bad.append((info.filename, data_off))
        check(not bad, "all %d stored entries 4-byte aligned" % stored, bad or None)
        check(zf.testzip() is None, "zip CRC check (testzip)")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apk", required=True)
    ap.add_argument("--package", required=True)
    ap.add_argument("--activity", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--version-code", type=int, required=True)
    ap.add_argument("--version-name", required=True)
    ap.add_argument("--min-sdk", type=int, required=True)
    ap.add_argument("--target-sdk", type=int, required=True)
    ap.add_argument("--theme-id", type=lambda s: int(s, 0), required=True)
    ap.add_argument("--debuggable", default="true")
    ap.add_argument("--expect-class", action="append", default=[], help="e.g. Lcom/csandroid/strike/MainActivity;")
    ap.add_argument("--expect-file", action="append", default=[], help="e.g. assets/www/index.html")
    args = ap.parse_args(argv)

    with zipfile.ZipFile(args.apk) as zf:
        manifest = zf.read("AndroidManifest.xml")
        dex = zf.read("classes.dex")
    check_manifest(manifest, args)
    check_dex(dex, args)
    check_apk(args.apk, args)
    check_alignment(args.apk)

    print()
    if failures:
        print("verify_apk: %d check(s) FAILED, %d passed:" % (len(failures), passed))
        for f in failures:
            print("  - " + f)
        return 1
    print("verify_apk: ALL %d CHECKS PASSED" % passed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
