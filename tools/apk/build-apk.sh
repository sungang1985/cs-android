#!/usr/bin/env bash
# =============================================================================
# build-apk.sh - EXPERIMENTAL SDK-less debug APK build for CS Strike.
#
# Builds android/app without the Android SDK / Gradle / AGP, using only:
#   * a JDK 17+ (java, javac, javap, jar, keytool, jarsigner) - must be installed
#   * Python 3                                - must be installed
#   * curl                                    - must be installed
#   * Kotlin compiler (embeddable), D8 (r8lib), apksig, and Robolectric's
#     android-all framework jar               - downloaded from Maven Central /
#                                               storage.googleapis.com into a cache
#   * androguard (pip, in a venv in the cache) - to verify the result
#
# Steps: BuildConfig.kt -> kotlinc -> D8 -> axml.py (binary manifest) -> zip
#        -> v1 signature (jarsigner) -> v2 signature (apksig engine) -> verify.
# Resources (resources.arsc) are NOT built: the manifest comes from
# tools/apk/AndroidManifest.template.xml compiled by tools/apk/axml.py, the app
# label is a literal and the launcher icon is Android's default. See README.md.
#
# Usage:   bash tools/apk/build-apk.sh          (or: npm run build:apk)
# Output:  android/app/build/outputs/apk-sdkless/cs-strike-debug.apk
#
# Environment overrides (all optional):
#   APK_TOOLCHAIN_DIR  cache dir            (default $HOME/.cache/cs-apk-toolchain)
#   APK_WWW_DIR        web bundle dir       (default android/app/src/main/assets/www)
#   APK_OUT_DIR        output dir           (default android/app/build/outputs/apk-sdkless)
#   APK_BUILD_DIR      intermediates dir    (default android/app/build/sdkless)
#   APK_MAVEN_MIRRORS  space separated Maven Central roots to try in order
#   APK_KEYSTORE / APK_KEYSTORE_PASS / APK_KEY_ALIAS / APK_KEY_PASS   signing key
#   APK_APPLICATION_ID, APK_VERSION_CODE, APK_VERSION_NAME, APK_MIN_SDK,
#   APK_TARGET_SDK, APK_APP_LABEL, APK_DEBUGGABLE                    manifest values
#   APK_JAVA_OPTS      JVM options for the compilers (default -Xmx2g)
#   APK_SKIP_VERIFY=1  skip the androguard verification step
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
APP_DIR="$ROOT/android/app"
SRC_DIR="$APP_DIR/src/main/java"
WWW_DIR="${APK_WWW_DIR:-$APP_DIR/src/main/assets/www}"
BUILD_DIR="${APK_BUILD_DIR:-$APP_DIR/build/sdkless}"
OUT_DIR="${APK_OUT_DIR:-$APP_DIR/build/outputs/apk-sdkless}"
OUT_APK="$OUT_DIR/cs-strike-debug.apk"
CACHE_DIR="${APK_TOOLCHAIN_DIR:-$HOME/.cache/cs-apk-toolchain}"
JARS_DIR="$CACHE_DIR/jars"
VENV_DIR="$CACHE_DIR/venv"
LOCK_FILE="$SCRIPT_DIR/toolchain.lock"
TEMPLATE="$SCRIPT_DIR/AndroidManifest.template.xml"
MAVEN_MIRRORS="${APK_MAVEN_MIRRORS:-https://repo.maven.apache.org/maven2 https://maven-central.storage-download.googleapis.com/maven2 https://repo1.maven.org/maven2}"
JAVA_OPTS="${APK_JAVA_OPTS:--Xmx2g}"
ANDROGUARD_VERSION="4.1.4"

# Values mirrored from android/app/build.gradle.kts (defaultConfig).
APPLICATION_ID="${APK_APPLICATION_ID:-com.csandroid.strike}"
VERSION_CODE="${APK_VERSION_CODE:-1}"
VERSION_NAME="${APK_VERSION_NAME:-1.0.0}"
MIN_SDK="${APK_MIN_SDK:-24}"
TARGET_SDK="${APK_TARGET_SDK:-34}"
APP_LABEL="${APK_APP_LABEL:-CS Strike}"
DEBUGGABLE="${APK_DEBUGGABLE:-true}"
MAIN_ACTIVITY="com.csandroid.strike.MainActivity"
KOTLIN_PACKAGE_DIR="com/csandroid/strike"

STEP=0
step() { STEP=$((STEP + 1)); printf '\n==> [%d] %s\n' "$STEP" "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf 'build-apk: ERROR: %s\n' "$*" >&2; exit 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not on PATH ($2)"; }

# The JVM prints JAVA_TOOL_OPTIONS to stderr; keep our logs readable but preserve proxy settings.
run_java() { java $JAVA_OPTS "$@" 2> >(grep -v '^Picked up JAVA_TOOL_OPTIONS' >&2); }

sha256_of() { python3 -I -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }

# download_once URL DEST -> 0 on HTTP 200. Prints the status on failure; 429/5xx/network errors
# are "retryable" (return 2), 4xx are not (return 1).
download_once() {
  local url="$1" dest="$2" code
  code=$(curl -sS -L --connect-timeout 20 --max-time 1800 -o "$dest" -w '%{http_code}' "$url" 2>/dev/null || echo "000")
  [[ "$code" == "200" ]] && return 0
  rm -f "$dest"
  info "  HTTP $code from $url"
  case "$code" in 400|401|403|404|410) return 1 ;; *) return 2 ;; esac
}

# download_with_retry DEST URL... -> tries each URL once per round (so a rate-limited mirror is
# skipped immediately in favour of the next one) and backs off between rounds.
download_with_retry() {
  local dest="$1" round url rc retryable
  shift
  for round in 1 2 3 4; do
    retryable=0
    for url in "$@"; do
      download_once "$url" "$dest" && return 0
      rc=$?
      [[ $rc -eq 2 ]] && retryable=1
    done
    [[ $retryable -eq 1 && $round -lt 4 ]] || break
    info "  retrying in $((round * round * 5))s (round $round)"
    sleep $((round * round * 5))
  done
  return 1
}

# fetch_artifact NAME SHA256 SOURCE -> ensures $JARS_DIR/NAME exists with the right checksum.
fetch_artifact() {
  local name="$1" sha="$2" source="$3" dest="$JARS_DIR/$1" tmp url actual
  if [[ -s "$dest" ]]; then
    actual=$(sha256_of "$dest")
    if [[ "$actual" == "$sha" ]]; then info "cached  $name"; return 0; fi
    info "checksum mismatch for cached $name, re-downloading"
    rm -f "$dest"
  fi
  tmp="$dest.part"
  local urls=()
  if [[ "$source" == maven:* ]]; then
    for mirror in $MAVEN_MIRRORS; do urls+=("${mirror%/}/${source#maven:}"); done
  else
    urls=("$source")
  fi
  info "fetch   $name <- ${urls[0]}"
  download_with_retry "$tmp" "${urls[@]}" || true
  [[ -s "$tmp" ]] || die "could not download $name (tried: ${urls[*]})"
  actual=$(sha256_of "$tmp")
  [[ "$actual" == "$sha" ]] || { rm -f "$tmp"; die "SHA-256 mismatch for $name: expected $sha, got $actual"; }
  mv -f "$tmp" "$dest"
  info "ok      $name ($(du -h "$dest" | cut -f1))"
}

# -----------------------------------------------------------------------------
step "Checking prerequisites"
need_cmd java "install a JDK 17+ (e.g. OpenJDK 21)"
need_cmd javac "install a JDK, not just a JRE"
need_cmd javap "part of the JDK"
need_cmd jar "part of the JDK"
need_cmd keytool "part of the JDK"
need_cmd python3 "install Python 3.8+"
need_cmd curl "install curl"
JAVA_MAJOR=$(java -version 2>&1 | grep -v JAVA_TOOL_OPTIONS | sed -nE 's/.*version "([0-9]+).*/\1/p' | head -1)
[[ "${JAVA_MAJOR:-0}" -ge 17 ]] || die "JDK 17 or newer is required (found major version '${JAVA_MAJOR:-?}')"
info "java $JAVA_MAJOR, $(python3 --version), repo $ROOT"
[[ -f "$SRC_DIR/$KOTLIN_PACKAGE_DIR/MainActivity.kt" ]] || die "Kotlin sources not found under $SRC_DIR"
[[ -f "$TEMPLATE" ]] || die "manifest template missing: $TEMPLATE"
if [[ ! -f "$WWW_DIR/index.html" ]]; then
  die "Web bundle missing: $WWW_DIR/index.html
       Run \`npm install && npm run build:android\` in $ROOT first (it builds dist/ and copies it
       into android/app/src/main/assets/www), or point APK_WWW_DIR at a directory with index.html."
fi
info "web bundle: $WWW_DIR ($(find "$WWW_DIR" -type f | wc -l | tr -d ' ') files)"

# -----------------------------------------------------------------------------
step "Toolchain (cache: $CACHE_DIR)"
mkdir -p "$JARS_DIR" "$BUILD_DIR" "$OUT_DIR"
[[ -f "$LOCK_FILE" ]] || die "missing $LOCK_FILE"
while read -r name sha source; do
  [[ -z "$name" || "$name" == \#* ]] && continue
  fetch_artifact "$name" "$sha" "$source"
done < "$LOCK_FILE"
jar_path() { # jar_path <prefix> -> the single cached jar whose name starts with <prefix>-
  local match
  match=$(ls "$JARS_DIR"/"$1"-[0-9]*.jar 2>/dev/null | head -1)
  [[ -n "$match" ]] || die "no cached jar for $1"
  printf '%s' "$match"
}
R8_JAR=$(jar_path r8lib)
ANDROID_JAR=$(jar_path android-all)
APKSIG_JAR=$(jar_path apksig)
KOTLIN_STDLIB=$(jar_path kotlin-stdlib)
KOTLINC_CP="$(jar_path kotlin-compiler-embeddable):$KOTLIN_STDLIB:$(jar_path kotlin-script-runtime):$(jar_path kotlin-reflect):$(jar_path kotlin-daemon-embeddable):$(jar_path trove4j):$(jar_path kotlinx-coroutines-core-jvm):$(jar_path annotations)"

# -----------------------------------------------------------------------------
step "Generating BuildConfig.kt"
GEN_DIR="$BUILD_DIR/gen/$KOTLIN_PACKAGE_DIR"
mkdir -p "$GEN_DIR"
cat > "$GEN_DIR/BuildConfig.kt" <<EOF
// Generated by tools/apk/build-apk.sh (there is no AGP in this pipeline). Do not edit.
package com.csandroid.strike

object BuildConfig {
    const val DEBUG = $DEBUGGABLE
    const val APPLICATION_ID = "$APPLICATION_ID"
    const val BUILD_TYPE = "debug"
    const val VERSION_CODE = $VERSION_CODE
    const val VERSION_NAME = "$VERSION_NAME"
}
EOF
info "$GEN_DIR/BuildConfig.kt (VERSION_NAME=$VERSION_NAME, VERSION_CODE=$VERSION_CODE, DEBUG=$DEBUGGABLE)"

# -----------------------------------------------------------------------------
step "Compiling Kotlin (kotlin-compiler-embeddable, jvmTarget 17, classpath = android-all + kotlin-stdlib)"
CLASSES_DIR="$BUILD_DIR/classes"
rm -rf "$CLASSES_DIR"; mkdir -p "$CLASSES_DIR"
KT_SOURCES=()
while IFS= read -r f; do KT_SOURCES+=("$f"); done < <(find "$SRC_DIR" "$BUILD_DIR/gen" -name '*.kt' | sort)
info "${#KT_SOURCES[@]} source files"
run_java -cp "$KOTLINC_CP" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler \
  -no-stdlib -no-reflect -jvm-target 17 -module-name app \
  -classpath "$ANDROID_JAR:$KOTLIN_STDLIB:$(jar_path annotations)" \
  -d "$CLASSES_DIR" "${KT_SOURCES[@]}"
CLASS_COUNT=$(find "$CLASSES_DIR" -name '*.class' | wc -l | tr -d ' ')
[[ "$CLASS_COUNT" -gt 0 ]] || die "kotlinc produced no classes"
info "$CLASS_COUNT class files"
CLASSES_JAR="$BUILD_DIR/classes.jar"
rm -f "$CLASSES_JAR"
jar --create --file "$CLASSES_JAR" -C "$CLASSES_DIR" . 2> >(grep -v '^Picked up JAVA_TOOL_OPTIONS' >&2)

# -----------------------------------------------------------------------------
step "Dexing (D8 from r8lib, --min-api $MIN_SDK, app classes + kotlin-stdlib)"
DEX_DIR="$BUILD_DIR/dex"
rm -rf "$DEX_DIR"; mkdir -p "$DEX_DIR"
run_java -cp "$R8_JAR" com.android.tools.r8.D8 --debug --min-api "$MIN_SDK" \
  --lib "$ANDROID_JAR" --output "$DEX_DIR" "$CLASSES_JAR" "$KOTLIN_STDLIB"
DEX_FILES=()
while IFS= read -r f; do DEX_FILES+=("$f"); done < <(find "$DEX_DIR" -name 'classes*.dex' | sort)
[[ ${#DEX_FILES[@]} -gt 0 && -f "$DEX_DIR/classes.dex" ]] || die "D8 produced no classes.dex"
for d in "${DEX_FILES[@]}"; do info "$(basename "$d") ($(du -h "$d" | cut -f1))"; done

# -----------------------------------------------------------------------------
step "Compiling AndroidManifest.xml (axml.py, framework ids via javap on android-all)"
IDS_JSON="$BUILD_DIR/android-ids.json"
python3 -I "$SCRIPT_DIR/axml.py" resolve-ids --android-jar "$ANDROID_JAR" --out "$IDS_JSON"
THEME_ID=$(python3 -I -c 'import json,sys; print("0x%08x" % json.load(open(sys.argv[1]))["style"]["Theme_Material_NoActionBar_Fullscreen"])' "$IDS_JSON")
info "android:style/Theme.Material.NoActionBar.Fullscreen = $THEME_ID"
MANIFEST_BIN="$BUILD_DIR/AndroidManifest.xml"
python3 -I "$SCRIPT_DIR/axml.py" encode --template "$TEMPLATE" --ids "$IDS_JSON" --out "$MANIFEST_BIN" \
  --var "APPLICATION_ID=$APPLICATION_ID" --var "VERSION_CODE=$VERSION_CODE" --var "VERSION_NAME=$VERSION_NAME" \
  --var "MIN_SDK=$MIN_SDK" --var "TARGET_SDK=$TARGET_SDK" --var "APP_LABEL=$APP_LABEL" \
  --var "DEBUGGABLE=$DEBUGGABLE" --var "MAIN_ACTIVITY=$MAIN_ACTIVITY"
info "decoded back with axml.py dump:"
python3 -I "$SCRIPT_DIR/axml.py" dump "$MANIFEST_BIN" | sed 's/^/      /'

# -----------------------------------------------------------------------------
step "Packaging unsigned APK (python zipfile; assets/www from $WWW_DIR)"
UNSIGNED_APK="$BUILD_DIR/cs-strike-unsigned.apk"
DEX_ARGS=()
for d in "${DEX_FILES[@]}"; do DEX_ARGS+=(--dex "$d"); done
python3 -I "$SCRIPT_DIR/package_apk.py" build --out "$UNSIGNED_APK" --manifest "$MANIFEST_BIN" "${DEX_ARGS[@]}" \
  --assets-dir "$WWW_DIR" --assets-prefix assets/www

# -----------------------------------------------------------------------------
step "Signing (v1: jarsigner, v2: apksig engine; debug key)"
KEYSTORE="${APK_KEYSTORE:-}"
if [[ -z "$KEYSTORE" ]]; then
  if [[ -f "$HOME/.android/debug.keystore" ]]; then
    KEYSTORE="$HOME/.android/debug.keystore"   # reuse Android Studio's debug key if present
  else
    KEYSTORE="$CACHE_DIR/debug.keystore"
  fi
fi
KEYSTORE_PASS="${APK_KEYSTORE_PASS:-android}"
KEY_ALIAS="${APK_KEY_ALIAS:-androiddebugkey}"
KEY_PASS="${APK_KEY_PASS:-android}"
if [[ ! -f "$KEYSTORE" ]]; then
  info "generating debug keystore $KEYSTORE"
  keytool -genkeypair -keystore "$KEYSTORE" -storepass "$KEYSTORE_PASS" -alias "$KEY_ALIAS" -keypass "$KEY_PASS" \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US" \
    2> >(grep -v '^Picked up JAVA_TOOL_OPTIONS' >&2)
fi
info "keystore $KEYSTORE (alias $KEY_ALIAS)"
# v1 (JAR signature): apksig 2.3.0's own v1 signer depends on JDK internals that were removed in
# JDK 17+, so the JDK's jarsigner produces it. jarsigner rewrites the zip without alignment, so only
# its META-INF/* entries are taken and appended to our aligned unsigned APK.
JARSIGNED_APK="$BUILD_DIR/cs-strike-jarsigner.apk"
V1_APK="$BUILD_DIR/cs-strike-v1.apk"
rm -f "$JARSIGNED_APK" "$V1_APK"
JARSIGNER_LOG="$BUILD_DIR/jarsigner.log"
if ! jarsigner -keystore "$KEYSTORE" -storepass "$KEYSTORE_PASS" -keypass "$KEY_PASS" \
    -sigalg SHA256withRSA -digestalg SHA-256 -sigfile CERT \
    -signedjar "$JARSIGNED_APK" "$UNSIGNED_APK" "$KEY_ALIAS" > "$JARSIGNER_LOG" 2> >(grep -v '^Picked up JAVA_TOOL_OPTIONS' >&2); then
  cat "$JARSIGNER_LOG" >&2
  die "jarsigner failed"
fi
grep -vE '^(Warning:|The signer.s certificate is self-signed|POSIX file permission|)$' "$JARSIGNER_LOG" | sed 's/^/    jarsigner: /' || true
[[ -s "$JARSIGNED_APK" ]] || die "jarsigner produced no output"
python3 -I "$SCRIPT_DIR/package_apk.py" add-v1 --apk "$UNSIGNED_APK" --from "$JARSIGNED_APK" --out "$V1_APK"
# v2 (APK Signature Scheme v2): apksig's DefaultApkSignerEngine driven by ApkSignerCli.java. The
# --add-exports flags are needed because apksig 2.3.0 touches sun.security.* even for v2-only use.
SIGNER_DIR="$BUILD_DIR/signer"
rm -rf "$SIGNER_DIR"; mkdir -p "$SIGNER_DIR"
javac -cp "$APKSIG_JAR" -d "$SIGNER_DIR" "$SCRIPT_DIR/ApkSignerCli.java" 2> >(grep -v '^Picked up JAVA_TOOL_OPTIONS' >&2)
rm -f "$OUT_APK"
run_java --add-exports java.base/sun.security.x509=ALL-UNNAMED --add-exports java.base/sun.security.pkcs=ALL-UNNAMED \
  --add-exports java.base/sun.security.util=ALL-UNNAMED \
  -cp "$APKSIG_JAR:$SIGNER_DIR" ApkSignerCli "$V1_APK" "$OUT_APK" "$KEYSTORE" "$KEYSTORE_PASS" "$KEY_ALIAS" "$KEY_PASS"
[[ -s "$OUT_APK" ]] || die "signing produced no output"
if ! jarsigner -verify "$OUT_APK" > "$JARSIGNER_LOG" 2> >(grep -v '^Picked up JAVA_TOOL_OPTIONS' >&2); then
  cat "$JARSIGNER_LOG" >&2
  die "jarsigner -verify failed on $OUT_APK"
fi
grep -q '^jar verified' "$JARSIGNER_LOG" || { cat "$JARSIGNER_LOG" >&2; die "jarsigner did not report 'jar verified' for $OUT_APK"; }
grep -vE '^(Warning:|The signer.s certificate is self-signed|POSIX file permission|)$' "$JARSIGNER_LOG" | sed 's/^/    jarsigner -verify: /' || true

# -----------------------------------------------------------------------------
step "Verifying with androguard (AXML round-trip, dex classes, APK metadata, signatures, alignment)"
if [[ "${APK_SKIP_VERIFY:-0}" == "1" ]]; then
  info "skipped (APK_SKIP_VERIFY=1)"
else
  VENV_PY="$VENV_DIR/bin/python"
  if ! "$VENV_PY" -I -c 'import androguard' >/dev/null 2>&1; then
    info "creating venv $VENV_DIR and installing androguard==$ANDROGUARD_VERSION (from PyPI)"
    python3 -m venv "$VENV_DIR"
    "$VENV_PY" -m pip install --quiet --disable-pip-version-check "androguard==$ANDROGUARD_VERSION" \
      || die "pip install androguard failed (set APK_SKIP_VERIFY=1 to build without verification)"
  fi
  "$VENV_PY" -I "$SCRIPT_DIR/verify_apk.py" --apk "$OUT_APK" \
    --package "$APPLICATION_ID" --activity "$MAIN_ACTIVITY" --label "$APP_LABEL" \
    --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
    --min-sdk "$MIN_SDK" --target-sdk "$TARGET_SDK" --theme-id "$THEME_ID" --debuggable "$DEBUGGABLE" \
    --expect-class 'Lcom/csandroid/strike/MainActivity;' \
    --expect-class 'Lcom/csandroid/strike/NativeBridge;' \
    --expect-class 'Lcom/csandroid/strike/BuildConfig;' \
    --expect-class 'Lcom/csandroid/strike/MainActivity$AssetWebViewClient;' \
    --expect-file AndroidManifest.xml --expect-file classes.dex --expect-file assets/www/index.html \
    --expect-file META-INF/CERT.SF --expect-file META-INF/CERT.RSA --expect-file META-INF/MANIFEST.MF
fi

# -----------------------------------------------------------------------------
printf '\nBUILD SUCCESSFUL\n'
printf '  APK:  %s (%s)\n' "$OUT_APK" "$(du -h "$OUT_APK" | cut -f1)"
printf '  Install: adb install -r "%s"\n' "$OUT_APK"
printf '  Note: experimental SDK-less build (debug key, default icon, no resources.arsc). The supported\n'
printf '        path is Android Studio / Gradle in android/ - see tools/apk/README.md\n'
