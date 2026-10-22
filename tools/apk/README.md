# tools/apk — 无 Android SDK 的实验性 APK 构建流水线

> **English summary at the bottom.**

## 这是什么

`tools/apk/build-apk.sh` 可以在 **没有 Android SDK、没有 Gradle、没有 Android Gradle Plugin** 的机器上，
把 `android/app` 打包成一个可安装的 debug APK（`android/app/build/outputs/apk-sdkless/cs-strike-debug.apk`）。

它的存在只有一个原因：在某些受限环境（例如本仓库曾经所在的 CI 容器）里，Google 的下载域名
（`dl.google.com`、`maven.google.com`）被网络策略屏蔽，无法安装 SDK / build-tools / AGP，
但 Maven Central、`storage.googleapis.com`、PyPI 可以访问。于是我们只用这些来源能拿到的工具重新拼出一条最小流水线。

**正常的构建方式仍然是 Android Studio + `android/` 下的 Gradle 工程**（`./gradlew :app:assembleDebug`）。
本流水线是实验性质，只用于应急出包和自动化冒烟测试，不用于发布。

```bash
npm install && npm run build:android   # 先构建 web 包并同步到 android/app/src/main/assets/www
npm run build:apk                      # == bash tools/apk/build-apk.sh
adb install -r android/app/build/outputs/apk-sdkless/cs-strike-debug.apk
```

### 前置条件

* JDK 17+（需要 `java`、`javac`、`javap`、`jar`、`keytool`、`jarsigner`）
* Python 3.8+（标准库即可；验证步骤会在缓存目录里自建 venv 并 `pip install androguard`）
* `curl` 与可以访问 Maven Central（或其 Google 镜像）、`storage.googleapis.com`、PyPI 的网络

## 流水线做了什么（按步骤）

| 步骤 | 工具 | 说明 |
|---|---|---|
| 1 | — | 检查依赖、Kotlin 源码和 web 包（缺少 `assets/www/index.html` 会直接失败并提示先运行 `npm run build:android`） |
| 2 | `curl` | 按 `toolchain.lock`（文件名 + SHA-256 + 来源）下载并校验工具链到 `$APK_TOOLCHAIN_DIR`（默认 `~/.cache/cs-apk-toolchain`）。Maven 构件依次尝试 `APK_MAVEN_MIRRORS` 里的镜像，429/5xx 会退避重试 |
| 3 | shell | 生成 `BuildConfig.kt`（AGP 的 `buildConfig` 功能由此替代） |
| 4 | `kotlin-compiler-embeddable 2.0.21` | `K2JVMCompiler -jvm-target 17`，编译 classpath 用 Robolectric 的 `android-all-14` 真机框架 jar 代替 `android.jar` |
| 5 | `D8`（`r8lib 8.5.35`） | `--debug --min-api 24`，把应用类 + `kotlin-stdlib` 打成 `classes.dex` |
| 6 | `axml.py` | 用 `javap` 从 `android-all` 里解析 `android.R$attr` / `android.R$style` 的资源 id，把 `AndroidManifest.template.xml` 编译为 Android 二进制 XML（AXML），并立即用自带解码器回读自检 |
| 7 | `package_apk.py` | 用 Python `zipfile` 组装未签名 APK：`AndroidManifest.xml`、`classes*.dex`、`assets/www/**`；已压缩格式（png/jpg/woff2 等）按 aapt 的规则 STORED 并做 4 字节对齐（zipalign 语义） |
| 8 | `jarsigner` + `apksig 2.3.0` | **v1（JAR 签名）由 JDK 的 `jarsigner` 生成**，`package_apk.py add-v1` 把它写出的 `META-INF/MANIFEST.MF`、`CERT.SF`、`CERT.RSA` 放回我们已对齐的 zip 的最前面；**v2（APK Signature Scheme v2）由 `ApkSignerCli.java`（javac 现场编译）驱动 apksig 的 `DefaultApkSignerEngine` 生成**并插入 APK Signing Block，再用 apksig 的 `ApkVerifier` 分别验证 v2（API 24+）和 v1（固定到 API 23）；调试密钥不存在时用 `keytool` 生成到缓存目录（不会进仓库） |
| 9 | `androguard` | `verify_apk.py`：用 `AXMLPrinter` 解码 manifest 并断言元素/属性、用 `DEX` 解析器确认类存在、用 `APK` 类检查 `get_package()/get_main_activity()/get_min_sdk_version()/is_signed_v1()/is_signed_v2()` 等，并检查 STORED 条目的对齐 |

所有脚本都 `set -euo pipefail`、使用绝对路径、不依赖当前目录；任何一步失败都会以非零退出码结束。重复运行是幂等的（工具链只下载一次）。

## 与 Gradle 构建的差异 / 限制（请务必阅读）

* **没有资源编译（没有 aapt2，没有 `resources.arsc`）。** 因此：
  * `res/` 目录完全不参与构建；`@string/app_name`、`@mipmap/ic_launcher`、`@style/Theme.CSStrike` 都无法引用。
  * 应用名是写死的字面量 `"CS Strike"`（`APK_APP_LABEL` 可覆盖，但不会本地化）。
  * **没有图标**：启动器显示 Android 默认图标。
  * 主题直接使用框架主题 `@android:style/Theme.Material.NoActionBar.Fullscreen`（即 `Theme.CSStrike` 的 parent），
    少了 `Theme.CSStrike` 里设置的窗口背景色/状态栏颜色；首帧可能短暂出现默认背景，WebView 加载后由网页自己接管。
* **只有 debug 签名。** 默认用 `~/.android/debug.keystore`（若存在）或缓存目录里自动生成的 `debug.keystore`
  （`android` / `androiddebugkey` / `android`）。切勿用它发布；Play 商店也不接受这样的包。
  用 `APK_KEYSTORE`、`APK_KEYSTORE_PASS`、`APK_KEY_ALIAS`、`APK_KEY_PASS` 可以换别的密钥。
* **签名方案只有 v1 + v2。** Maven Central 上 apksig 的最新版本只有 2.3.0，它没有 v3/v4 的 API（更新的 apksig 只发布在
  Google Maven 上）。v2 对 targetSdk 30+ 已经足够，所以 `targetSdkVersion` 保持 34。
  此外 apksig 2.3.0 的 v1 签名器依赖 JDK 17+ 已删除的内部类（`sun.security.pkcs.PKCS7#encodeSignedData`），
  因此 v1 改由 `jarsigner` 生成；它的 v1 **验证**器仍用到 `sun.security.{pkcs,util,x509}`，所以脚本运行它时加了
  `--add-exports java.base/...=ALL-UNNAMED`。`jarsigner` 不会在 `CERT.SF` 里写 `X-Android-APK-Signed: 2`，
  即没有 v2 防剥离保护（对 debug 包无关紧要）。
* **包名是 `com.csandroid.strike`**，没有 Gradle debug 变体的 `.debug` 后缀，因此它会和 Gradle 的 release 包“同名”，
  但签名不同——安装前需要先卸载另一种构建。`android:debuggable="true"` 会被显式写入（AGP 对 debug 构建也会注入）。
* **不做代码收缩/混淆。** `classes.dex` 包含完整的 `kotlin-stdlib`（约 2.3 MB），对应 Gradle 的 debug 构建而非 release。
* `AndroidManifest.template.xml` 是 `android/app/src/main/AndroidManifest.xml` 的手工镜像：改了正式 manifest 之后，
  需要同步修改模板（否则两者行为会漂移）。`axml.py` 只认识模板中用到的那一小组 `android:` 属性（见 `ANDROID_ATTRS`），
  新增属性要先把它的公共资源 id 加进表里（构建时会用 `javap` 交叉校验 id 是否正确）。
* 编译 classpath 用的是 Robolectric 的 `android-all` 框架 jar，而不是 SDK 的 `android.jar` stub；它包含真实实现和隐藏 API，
  编译器不会阻止你误用 `@hide` 的 API（Gradle 构建会）。
* 只在 Linux + OpenJDK 21 + Python 3.13 上测试过；AXML 编码器的验证依赖 androguard 4.1.4 的解析器和 apksig 自己的
  manifest 解析器（它在签名时会读取 `minSdkVersion`），没有在真机上安装运行过——请在设备上验证后再依赖它。

## 文件一览

| 文件 | 作用 |
|---|---|
| `build-apk.sh` | 入口脚本，串起所有步骤 |
| `toolchain.lock` | 工具链清单（文件名、SHA-256、来源 URL / Maven 路径） |
| `AndroidManifest.template.xml` | 二进制 manifest 的文本模板（`${占位符}` 由脚本替换） |
| `axml.py` | 纯标准库的 AXML 编码/解码器（`encode` / `dump` / `resolve-ids`） |
| `package_apk.py` | `build`：组装未签名 APK（zip + 对齐）；`add-v1`：把 jarsigner 的签名文件合并回对齐的 zip |
| `ApkSignerCli.java` | 用 apksig 引擎插入 v2 签名块，并用 `ApkVerifier` 验证 v1 + v2 |
| `verify_apk.py` | 用 androguard 做的独立验证 |

常用环境变量：`APK_WWW_DIR`（自定义 web 包目录，便于测试）、`APK_TOOLCHAIN_DIR`、`APK_OUT_DIR`、`APK_BUILD_DIR`、
`APK_MAVEN_MIRRORS`、`APK_VERSION_CODE` / `APK_VERSION_NAME` / `APK_MIN_SDK` / `APK_TARGET_SDK` / `APK_APP_LABEL` /
`APK_DEBUGGABLE`、`APK_JAVA_OPTS`、`APK_SKIP_VERIFY=1`。

---

## English summary

`tools/apk/build-apk.sh` (`npm run build:apk`) is an **experimental** pipeline that produces an installable
**debug** APK of `android/app` **without the Android SDK, Gradle or AGP**. It exists for environments where Google's
download hosts are blocked but Maven Central, `storage.googleapis.com` and PyPI are reachable. The supported way to
build the app remains **Android Studio with the Gradle project in `android/`**.

What it uses: a JDK (javac/javap/jar/keytool), Python 3, curl; and, downloaded into
`$APK_TOOLCHAIN_DIR` (default `~/.cache/cs-apk-toolchain`) and checksum-verified against `toolchain.lock`:
the embeddable Kotlin compiler 2.0.21, D8 from `r8lib` 8.5.35, apksig 2.3.0, Robolectric's `android-all-14`
framework jar (used as the compile classpath instead of `android.jar`), and androguard (pip, in a venv) for verification.

Steps: generate `BuildConfig.kt` → compile Kotlin (jvmTarget 17) → D8 (`--min-api 24`, app classes + kotlin-stdlib)
→ compile the manifest template to Android binary XML with the stdlib-only `axml.py` (framework resource ids looked up
with `javap` from the android-all jar) → assemble the zip with Python (`AndroidManifest.xml`, `classes.dex`,
`assets/www/**`, stored entries 4-byte aligned) → v1 JAR signature with the JDK's `jarsigner` (merged back into the
aligned zip, META-INF first) → v2 APK Signing Block via apksig's `DefaultApkSignerEngine` driven by `ApkSignerCli.java`,
verified with apksig's `ApkVerifier` (debug key generated with `keytool` into the cache, never into the repo) → verify
with androguard (AXML round-trip assertions, DEX class list, `APK.get_package()`, `get_main_activity()`,
`get_min_sdk_version()`, `is_signed_v1()`, `is_signed_v2()`, alignment).

Limitations: **no resources at all** (no aapt2 / `resources.arsc`): literal app label, **default launcher icon**, the
framework theme `@android:style/Theme.Material.NoActionBar.Fullscreen` instead of `@style/Theme.CSStrike`; **debug key
only**; **v1 + v2 signatures only** (apksig 2.3.0 is the newest release on Maven Central and has no v3 API; its own v1
signer needs JDK internals removed in JDK 17+, hence `jarsigner` for v1 and `--add-exports` flags for its verifier); no code
shrinking (full kotlin-stdlib in the dex); package id `com.csandroid.strike` without the Gradle `.debug` suffix;
the manifest template must be kept in sync with the real manifest by hand; tested on Linux/OpenJDK 21/Python 3.13 and
verified with androguard + apksig's own verifier, not yet on a physical device.
