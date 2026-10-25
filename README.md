# 弹壳 / Shell — 安卓手机 CS 风格射击游戏

一款可以在安卓手机上游玩的、Counter-Strike 风格的第一人称射击游戏：T / CT 两队、购买阶段、拆弹模式、经典武器与后坐力、人机对战。
纯前端实现（TypeScript + Three.js），**零资源下载**（贴图、模型、音效全部程序化生成），既可作为 PWA 直接在手机浏览器中安装游玩，也可打包成原生 Android APK（WebView 壳）。

> 完整设计文档见 [`docs/DESIGN.md`](docs/DESIGN.md)（约 180 KB，包含地图、武器数值、经济、AI、控制、HUD、音频、渲染、架构、测试策略）。

## 玩法一览

| 内容 | 说明 |
|---|---|
| 模式 | **爆破模式**（主模式，先赢 6 回合，5 s 准备 + 75 s 回合 + 35 s 炸弹）、**团队死斗**（4 分钟或 30 杀）、**训练场**（静态靶子，含新手引导） |
| 地图 | 「货场 / Depot」48 × 36 m：长廊（Long）、中庭（Mid）、隧道（Tunnel）三条路线，A 点位于 +1.5 m 平台 |
| 队伍 | 5v5（玩家 + 4 名友军机器人 vs 5 名敌方机器人），可选 3v3 / 2v2 |
| 武器 | 匕首、Glock-18、USP-S、沙漠之鹰、MP5-SD、AK-47、M4A4、AWP、高爆手雷、闪光弹；防弹衣 / 头盔 / 拆弹器 / C4 |
| 经济 | CS 规则：起始 $800、连败补贴阶梯、击杀奖励、安放 / 拆除奖励、15 s 购买窗口、快捷购买预设 |
| 机器人 | 状态机 AI：视野 / 视线 / 听觉感知、团队黑板、A* 寻路 + 掩体点、安放 / 拆除 / 补刀式拆弹、三档难度 |
| 操作 | 浮动摇杆 + 拖动视角 + 双开火键、点击开火、辅助瞄准（关 / 低 / 中 / 高）、陀螺仪、布局自定义、左手模式；桌面端支持键鼠 |
| 画面 | Three.js WebGL2，程序化贴图与模型、独立枪模通道、低 / 中 / 高 / 自动画质 |
| 音频 | WebAudio 合成的约 45 种音效，距离衰减、遮挡、方位声像、震动反馈 |

## 怎么玩

### 方式一：手机浏览器 / PWA（最简单）

1. 构建并托管 `dist/`（任何静态文件服务器均可，需 HTTPS 才能离线安装）：
   ```bash
   npm install
   npm run build        # 生成 dist/
   npm run dev          # 本地开发：http://localhost:8080（手机与电脑同一局域网即可访问）
   ```
2. 用手机 Chrome 打开地址，横屏；菜单「添加到主屏幕」即可离线游玩（Service Worker 预缓存全部文件）。

### 方式二：Android APK（Android Studio，推荐的正式打包方式）

```bash
npm install
npm run build:android   # 构建 web 包并同步到 android/app/src/main/assets/www
```
然后用 Android Studio 打开 `android/` 目录，`Build > Build APK(s)`（或命令行 `./gradlew assembleDebug`）。
要求：Android Studio（含 SDK 34）、JDK 17。宿主应用（Kotlin，约 300 行）负责全屏沉浸、横屏锁定、WebView 配置、从 assets 以私有 https 源加载网页、返回键 / 生命周期转发、震动桥接；**不申请 INTERNET 权限**。minSdk 24。

### 方式三：无 SDK 的实验性 APK 流水线

在无法安装 Android SDK 的环境（例如本仓库最初的 CI 容器）里，`tools/apk/` 提供一条只依赖 Maven Central / PyPI 的流水线：

```bash
npm run build:android
npm run build:apk       # 输出 android/app/build/outputs/apk-sdkless/cs-strike-debug.apk
```
它用 kotlinc-embeddable + Robolectric 框架 jar 编译、D8 打包 dex、自带的 AXML 编码器生成二进制清单、jarsigner + apksig 做 v1 + v2 签名，并用 androguard 做 58 项校验。限制：调试签名、默认图标、无资源表。详见 [`tools/apk/README.md`](tools/apk/README.md)。

## 操作说明（横屏）

| 控制 | 位置 / 手势 |
|---|---|
| 移动 | 左半屏任意位置按下出现浮动摇杆；推 12–75 % 为静步（无脚步声），推满为跑 |
| 视角 | 右半屏拖动；灵敏度 1–20 可调，支持加速曲线与陀螺仪 |
| 开火 | 右下 Fire-R（按住开火并可拖动瞄准）、左侧 Fire-L；视角区快速点击 = 单发 |
| 跳 / 蹲 / 换弹 / 切枪 / 开镜 / 手雷 | 右侧按钮组；手雷长按 ≥ 300 ms 为短抛 |
| 安放 / 拆除 / 拾取 | 底部中央情境按钮，长按 |
| 购买 | 准备阶段左下「购买」按钮（仅在出生点购买窗口内） |
| 暂停 / 计分板 | 右上 ‖；点按顶部比分 |
| 桌面端 | WASD 移动、Shift 静步、Ctrl 蹲、空格跳、R 换弹、1–4 切槽、G 丢弃、E 使用、B 购买、Tab 计分板、Esc 暂停、鼠标锁定瞄准 |

## 项目结构

```
src/
  core/      数学、确定性随机（命名流）、事件总线、固定步长主循环
  sim/       共享状态类型（冻结）、事件定义、机器人接口、模拟门面（每 tick 的执行顺序、死亡流水线、渲染快照）
  world/     地图编译器（2 m 字形网格 → 碰撞体 / 1 m 行走网格 / 区域）、碰撞世界（AABB 扫掠、射线、台阶）、玩家移动
  maps/      货场地图数据、测试用小房间
  nav/       导航图（A*、拉直、掩体、守点）
  weapons/   武器数据、散布 / 后坐力、命中判定（部位 / 穿透）、手雷、物品
  rules/     回合状态机、经济、自动购买、炸弹、模式
  ai/        机器人感知 / 策略 / 战斗 / 寻路控制、难度表
  render/    Three.js 渲染（地图、角色、枪模、特效、雷达）
  input/     触控层、键鼠、陀螺仪、辅助瞄准
  audio/     DSP 原语、音效配方、音频引擎
  ui/        HUD、菜单、购买界面、设置、布局编辑器
  platform/  本地存储、Android 桥、PWA、震动
  app/       应用壳（主循环接线、测试钩子、性能统计）
android/     Android Studio / Gradle 工程（Kotlin WebView 壳）
tools/       构建（esbuild）、静态服务器、Playwright 端到端、图标生成、APK 流水线
tests/       单元测试（vitest）、端到端场景、基准、黄金哈希
```

架构要点：模拟层是**纯 TypeScript、60 Hz 固定步长、完全确定性**（命名随机流的状态保存在世界状态里，可序列化 / 恢复 / 哈希），不依赖 DOM 与 Three.js；渲染、输入、音频、UI 只是薄适配器，通过 `InputCommand` 输入、`SimEvents` 输出与模拟交互。`tests/unit/architecture.test.ts` 和 `tsconfig.sim.json` 强制这条边界。

## 开发

```bash
npm install
npm run dev          # 监听构建 + 本地服务器
npm run typecheck    # 两套 tsconfig（含无 DOM 的纯模拟层）
npm run lint         # 架构边界检查
npm test             # 单元测试（node + jsdom）
npm run bench        # 模拟层吞吐基准（10,000 tick < 2.5 s）
npm run build        # 生产构建 → dist/
npm run size         # 体积门槛（≤ 1 MB 压缩前 / ≤ 300 KB gzip）
npm run e2e          # Playwright（Pixel 5 横屏触屏配置，软件 WebGL）
npm run check        # 以上全部
npm run golden:update  # 玩法改动后更新黄金哈希（种子 42、14,400 tick 的世界状态哈希）
npm run balance      # 机器人对战平衡统计（每档难度 N 场 5v5 全机器人爆破，默认 20 场）
```

测试概况：约 50 个 vitest 文件、600+ 用例（纯模拟层 node 项目 + jsdom UI 项目），外加 9 个 Playwright 端到端场景：

| 场景 | 覆盖 |
|---|---|
| `010-boot` | 页面加载、拿到 WebGL2、中文主菜单可见、无控制台报错 |
| `020-match-smoke` | 用测试钩子开一局爆破，同步步进 600 tick，回合阶段推进 |
| `030-weapons` | 训练场：给 AK，按住开火 1 s ≈ 10 发，换弹恢复弹匣 |
| `040-rules` | 人类 T 持 C4 在 A 点安放 → 35 s 后爆炸 → T 胜、比分 1:0、金钱结算 |
| `060-render` | 主菜单场景、比赛帧的绘制预算（≤ 60 draw calls、≤ 80 k 三角形）、特效不报错 |
| `070-touch` | 合成触摸事件：浮动摇杆移动、拖动视角转 yaw、Fire-R 按住开火、视角区点按单发 |
| `071-audio` | 真实 WebAudio：解锁并合成音库（≈ 72 个缓冲）、空间化世界音效、UI 音、环境循环 |
| `080-ui` | 各界面 DOM 截图、EN 切换、设置跨刷新持久化、购买流程、暂停 / 计分板 / 旁观 / 结算 / 引导、竖屏门、无横向溢出、文本最小尺寸 |
| `090-full-match` | 三个种子同步跑完整场比赛直至 `MATCH_END`，无异常，生涯统计落盘 |

端到端测试通过 `?test=1` 暴露 `globalThis.__cs` 调试钩子（开局、同步步进、冻结机器人、传送、给武器、读状态 / 哈希等），见 `src/app/testHooks.ts`。

## 已知限制

- 单机对战机器人，无联机。
- 一张地图；地图格式为数据驱动，可扩展。
- 无烟雾弹 / 燃烧弹，无骨骼动画（倒地为翻倒动画）。
- 实验性无 SDK APK 使用调试签名与默认图标，正式发布请用 Android Studio 构建。

## 许可证

MIT
