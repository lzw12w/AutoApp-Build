# Para

自然语言驱动正在运行的 iOS / Android App。
读控件树，不看像素；点击自带验证；并把页面关系记住。

Agent 循环和模型层来自 [pi](https://github.com/earendil-works/pi)。本仓库负责 Inspector 传输、GUI 工具和知识图谱。

<video src="docs/demo.mp4" controls width="720">
  <a href="docs/demo.mp4">30 秒演示</a>
</video>

把录屏放到 [`docs/demo.mp4`](docs/demo.mp4)（或 `docs/demo.gif`）即可在 GitHub 上直接播放。

## 30 秒

需要：[Bun](https://bun.sh)、真机 USB（iOS：macOS 自带的 usbmuxd，无需额外安装；Android：`adb`）、目标 App 以 Debug 打开 Inspector HTTP（默认 `:8765`）、以及 LLM 密钥。

```bash
bun install
bun src/cli.ts doctor                 # Inspector + 密钥
bun src/cli.ts exec -m "当前是什么页面，不要点"
```

密钥写在 `~/.para/agent/models.json`（或 `pi auth`），不要进仓库。用 `PARA_AGENT_DIR` 可改这个目录。Para 不读 `ANTHROPIC_*` / `OPENAI_*`，避免和别的代理抢环境变量。

### 模型配置：你只需要改两个文件

| 文件 | 归属 | 放什么 | 要手改吗 |
| --- | --- | --- | --- |
| `~/.para/config.toml` | Para | 用哪个模型（`llm_model`）、连哪台设备 | 要 |
| `~/.para/agent/models.json` | pi | provider 定义 + baseUrl + apiKey | 要 |
| `~/.para/agent/models-store.json` | pi 自动写 | 远程模型目录缓存（带 etag） | **不要手改**，删掉无副作用 |

分工是：**`models.json` 说"有哪些模型、怎么连"，`config.toml` 说"这次用哪个"**。密钥只出现在前者，Para 自己不碰凭据。

加一个模型：在 `models.json` 的 `providers` 下加一项，`api` 取 `anthropic-messages` / `openai-responses` / `openai-completions` 之一。

```jsonc
{ "providers": { "my-provider": {
    "baseUrl": "https://api.example.com/anthropic",
    "api": "anthropic-messages",
    "apiKey": "sk-...",
    "models": [{ "id": "some-model-id", "name": "some-model-id",
                 "contextWindow": 200000, "maxTokens": 32768 }]
} } }
```

然后确认它真的可用——**`models.json` 里配了不等于能用**（可能没权限、key 失效、id 写错）：

```bash
para models        # 带 * 的是当前选中；只列出凭据可用的
```

选模型改 `config.toml` 的 `llm_model`，或临时用 `PARA_LLM_MODEL=xxx`。名字写错会直接报 `model_not_found` 并列出可选项，不会静默换成别的模型。

## 不是什么

- 不是 XCUITest / Espresso 替代，也不改你的 App 源码
- 不是 Computer Use：默认不用截图当点击坐标
- 不是通用手机远控：目标 App 必须开 Inspector

## 怎么看、怎么点、怎么记

1. **看** — `screen_digest` 给出当前屏的阅读序和稳定 `aid=`（导航 / 交互用）。需要精确几何或样式时再用 `view_hierarchy`。
2. **点** — `tap_with_diff` 是唯一的点击入口。返回里的 `post_check` 已经说明页面有没有跳、树上有没有变。不要再点一次「看看」。
3. **记** — 探索过程写入按 App 分的知识图谱（`~/.para/knowledge/*.db`）。下次到同一页，可先 `navigate_to_page`。

截图是最后手段：树读不到的 WebView / 游戏画面 / 纯视觉 bug 才用。

## 设备

两台同时插着时必须 `--device`（iOS UDID 或 adb serial）。每台设备上的 Inspector 都在远端 `8765`；Para 从本机 `8765` 起分配不冲突的本地端口，记在 `~/.para/locks/device_ports.json`，不必手填 `--port`。

```bash
bun src/cli.ts doctor --device <adb-serial>
bun src/cli.ts doctor --device <ios-udid>
```

Para 直接通过 usbmuxd（iOS）/ adb（Android）连到设备上的 Inspector 端口，不建本地端口转发，也不起 `iproxy` 子进程。因此多台设备可以共用同一个设备端口（默认 `8765`），插上即可用，不需要配端口。平台会从 `--device` 或当前连接的设备自动判断。

如果你已经自己做了端口转发，可以用 `PARA_INSPECTOR_TRANSPORT=tcp` 让 Para 改连 `PARA_INSPECTOR_HOST:PARA_INSPECTOR_PORT`。

## CLI

```
para exec -m "<prompt>"      一轮，JSON stdout
para serve [--serve-host H] [--serve-port P]   Web UI，默认 127.0.0.1:7777
para doctor [--json]         Inspector + 密钥
para tools                   已注册工具名
para [chat] [pi-args...]     交互（pi TUI + 本仓库 extension）
```

常用参数：`--host` `--port` `--device` / `-d` `--platform` `--remote-port`。

## 配置

先读 `~/.para/config.toml`，再被环境变量覆盖。

| 项 | 环境变量 |
|---|---|
| `inspector_host` / `inspector_port` | `PARA_INSPECTOR_HOST` / `PARA_INSPECTOR_PORT` |
| `inspector_device` | `PARA_DEVICE_UDID` |
| `inspector_platform` | `PARA_INSPECTOR_PLATFORM`（`auto` \| `ios` \| `android`） |
| `inspector_remote_port` | `PARA_INSPECTOR_REMOTE_PORT` |
| `bundle_id` | `PARA_BUNDLE_ID` |
| `llm_provider` / `llm_model` | `PARA_LLM_PROVIDER` / `PARA_LLM_MODEL` |

`NOTE.md`（默认 `~/.para/NOTE.md`）在会话开始时进入 prompt。本轮 `record_knowledge` 写入磁盘，下一轮启动才出现在 `<project_knowledge>`。

## 开发

```bash
bun run check    # tsc --noEmit
bun test
```

SQLite：Bun 用 `bun:sqlite`，经 `pi -e` 走 Node 时用 `node:sqlite`。不要改成静态只 import `bun:sqlite`。
