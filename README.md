# iOS Simulator Mirror

[![CI](https://github.com/9527001/cursor-ios-simulator/actions/workflows/ci.yml/badge.svg)](https://github.com/9527001/cursor-ios-simulator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

在 **Cursor / VS Code** 侧边栏嵌入无头 iOS Simulator 镜像：实时画面、触控、标注、设备切换。

> 独立工程。在 macOS + Xcode 上可单独克隆、开发、打包、安装。

## 安装

### Open VSX（Cursor / VSCodium 推荐）

在扩展市场搜索 **iOS Simulator Mirror**，或：

```bash
cursor --install-extension 9527001.cursor-ios-simulator
# VS Code / Codium:
code --install-extension 9527001.cursor-ios-simulator
```

Open VSX 页面：<https://open-vsx.org/extension/9527001/cursor-ios-simulator>

### GitHub Release（VSIX）

从 [Releases](https://github.com/9527001/cursor-ios-simulator/releases) 下载 `cursor-ios-simulator.vsix`，在 Cursor 中 **Extensions → … → Install from VSIX…**。

### 源码本地安装

```bash
git clone https://github.com/9527001/cursor-ios-simulator.git
cd cursor-ios-simulator
npm run install:local
```

然后 **Reload Window**，按 `Cmd+Y` 打开面板。

## 要求

- macOS
- 完整 **Xcode**（非仅 Command Line Tools）
- `sudo xcode-select -s /Applications/Xcode.app`
- 至少一个 iOS Simulator runtime
- Node.js 18+

## 开发

### F5 调试

1. 用 Cursor **单独打开本目录**（File → Open Folder → `cursor-ios-simulator`）
2. 终端执行一次：

```bash
npm run setup
```

3. 按 **F5** → 会启动 Extension Development Host
4. 在新窗口按 `Cmd+Y` 打开 iOS Simulator 侧边栏

### 常用命令

| 命令 | 说明 |
|------|------|
| `npm run setup` | 安装依赖 + 编译 TS + 编译 native helpers → `bin/` |
| `npm run build` | 同 setup 的编译步骤（不重复 npm install） |
| `npm run watch` | TS 监听编译 |
| `npm run package` | 打 VSIX（含 `bin/` 内 helper 二进制） |
| `npm run install:local` | setup + package + 安装到 Cursor |
| `npm run install:vscode` | 同上，安装到 VS Code |
| `npm run publish:openvsx` | 本地构建并发布到 Open VSX（需 `OVSX_PAT`） |
| `npm run release -- 0.4.0 --push` | 打 tag 并推送，触发 GitHub Release |

## 功能

- 无头镜像（CoreSimulator IOSurface）
- 点击 / 滑动 / Home / Lock / Side / Siri
- 键盘输入（simctl pbcopy + HID）
- 截图到桌面
- 标注 → 注入 Chat 输入框（含 a11y 元素信息，标注时 `npx xcodebuildmcp snapshot-ui`）
- 设备 picker + 无头 auto-boot
- 自适应流畅性（fps / 分辨率 / JPEG 质量）

## 设置

| 键 | 默认 | 说明 |
|----|------|------|
| `iosSimulator.autoBoot` | `true` | 无 booted 设备时在后台自动 boot（不挡首帧） |
| `iosSimulator.prefetchXcodebuildMcp` | `true` | 面板打开后后台预热 xcodebuildmcp |
| `iosSimulator.maxFps` | `20` | 帧率上限；自适应开启时为上限，关闭时为固定值 |
| `iosSimulator.adaptiveSmoothness` | `true` | 自动评估卡顿并调节 fps / 宽度 / 质量 |

## 架构

```
Extension (TypeScript)
  ├── Webview 面板 (img + Blob + rAF)
  ├── bin/sim-capture   ← 打包进 VSIX
  ├── bin/sim-input     ← 打包进 VSIX
  └── xcodebuildmcp CLI（仅标注 a11y 时 npx 拉取，非 npm 依赖）
```

Native helper 源码来自 [codex-plusplus-ios-simulator](https://github.com/b-nnett/codex-plusplus-ios-simulator)（MIT）。

## 发布（维护者）

1. 在 GitHub 创建仓库 `9527001/cursor-ios-simulator`（若尚未创建）
2. 在仓库 **Settings → Secrets** 添加 `OVSX_PAT`（可选，用于自动发布 Open VSX）
3. 本地打 release：

```bash
chmod +x scripts/release.sh
./scripts/release.sh 0.4.0 --push
```

推送 `v*` tag 后，GitHub Actions 会：

- 在 macOS 上编译 native helpers 并打包 VSIX
- 创建 GitHub Release 并上传 `.vsix`
- 若配置了 `OVSX_PAT`，同步发布到 Open VSX

也可仅本地发布 Open VSX：

```bash
OVSX_PAT=<token> npm run publish:openvsx
```

Token 申请：<https://open-vsx.org/user-settings/tokens>

## 故障排查

**Preflight 失败** → 确认 Xcode 完整安装且 `xcode-select` 指向 `.app`。

**无画面** → 检查是否有 booted 模拟器；或手动从面板顶部 picker 选择设备。

**标注 a11y 失败** → 首次需网络拉 `xcodebuildmcp`；可设 `XCODEBUILDMCP_CMD` 自定义命令（支持 `{udid}` 占位符）。

**F5 报错 helpers** → 在本目录运行 `npm run setup` 重新编译 `bin/`。

**镜像卡顿** → 降低 `iosSimulator.maxFps`，或保持 `adaptiveSmoothness` 开启（状态栏会显示当前参数）。

## License

MIT — 详见 [LICENSE](LICENSE)。Native helpers 部分基于 [codex-plusplus-ios-simulator](https://github.com/b-nnett/codex-plusplus-ios-simulator)（MIT）。
