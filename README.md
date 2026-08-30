# AutoApp-Build（Para）

用自然语言驱动**正在运行的 iOS / Android App**：看屏幕、点控件、等动画、记页面关系。Agent 循环和模型层来自 [pi](https://github.com/earendil-works/pi)；本仓库是 pi 的 extension，负责 Inspector 传输、GUI 工具和知识图谱。

目标 App 需以 Debug 打开 Inspector HTTP（默认本机 `8765`）。不替代 XCUITest / Espresso，也不在 GUI 模式里改你的源码。

## 两种模式（互斥）

| 模式 | 做什么 | 怎么切 |
|---|---|---|
| **GUI**（默认） | 驱动真机：`screen_digest` / `tap_with_diff` / `wait_for` / 知识图谱…，外加 `read` | `/gui`、`switch_mode(mode="gui")` |
| **CODE** | 改这个仓库：`read` / `write` / `edit` / `grep` / `find` / `ls` / `bash` | `/code`、`switch_mode(mode="code")` |

不要混用 tap 和 write。人可以 `/mode` 查看或切换；模型也可以自己 `switch_mode`。启动：`--para-mode code` 或 `PARA_MODE=code`。

## 要求

- [Bun](https://bun.sh)
- 真机 USB：iOS 需要 `iproxy`（libimobiledevice）；Android 需要 `adb`
- LLM：`ANTHROPIC_API_KEY`（或兼容 `ANTHROPIC_BASE_URL`）/ `OPENAI_API_KEY`

```bash
bun install
bun src/cli.ts doctor          # Inspector + 密钥
bun src/cli.ts                 # 交互（GUI）
bun src/cli.ts exec -m "当前是什么页面，不要点"
```

两台同时插着时，默认 `8765` 给 iOS，避免抢端口。打 Android：

```bash
bun src/cli.ts doctor --platform android --device <adb-serial> --port 18765
```

只插 Android、或不传 `--platform` 但 `--device` 能对上 `adb devices` 时，tunnel 会自己 `adb forward`。端上 inspector 端口默认仍是 `8765`。

## CLI

```
para [chat] [pi-args...]     交互
para exec -m "<prompt>"      一轮，JSON stdout
para doctor [--json]         连通性
para tools                   已注册工具名
```

常用参数：`--host` `--port` `--device` / `-d` `--platform` `--remote-port`。

等价：`bunx pi -e ./src/index.ts`。

## 配置

先读 `~/.ios-inspector/config.toml`，再被环境变量覆盖。密钥不要进仓库。

| 项 | 环境变量 |
|---|---|
| `inspector_host` / `inspector_port` | `PARA_INSPECTOR_HOST` / `PARA_INSPECTOR_PORT`（或 `INSPECTOR_*`） |
| `inspector_device` | `PARA_DEVICE_UDID` / `INSPECTOR_DEVICE` |
| `inspector_platform` | `PARA_INSPECTOR_PLATFORM`（`auto` \| `ios` \| `android`） |
| `inspector_remote_port` | `PARA_INSPECTOR_REMOTE_PORT` |
| `bundle_id` | `PARA_BUNDLE_ID` |
| `para_mode` | `PARA_MODE`（`gui` \| `code`） |
| Anthropic / OpenAI | `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、`OPENAI_API_KEY` |

`NOTE.md`（默认 `~/.ios-inspector/NOTE.md`）在会话开始时打进 prompt；本轮 `record_knowledge` 写入磁盘，但要下一轮启动才出现在 `<project_knowledge>`。

## 开发

```bash
bun run check    # tsc --noEmit
bun test
```

SQLite：Bun 用 `bun:sqlite`，`pi -e` 走 Node/jiti 时用 `node:sqlite`。不要改成静态只 import `bun:sqlite`。

## 现状

已做：Inspector 客户端、GUI 工具、知识图谱、GUI/CODE 切换、iOS `iproxy` + Android `adb forward`、`para` CLI。

刻意没做：视觉模型、`find_and_tap`、默认 bash（GUI 模式）、Web 控制台、多机自动分端口。Android 端若没有 `/api/vc_hierarchy`，`screen_digest` 仍可用。
