# para-ios

Para — App-runtime GUI agent for iOS, rebuilt as a [pi](https://github.com/earendil-works/pi) extension.

Para drives a running iOS app in natural language and builds a knowledge graph as
it explores. The agent loop, multi-provider LLM layer, compaction, and tool
execution come from pi (`@earendil-works/pi-*`); this package owns the iOS
domain: device transport, tools, and the knowledge graph.

## Status

Phases 0–5 of the rewrite plan:

| Phase | What | State |
|---|---|---|
| 0 | Scaffold + `ping` proving `registerTool` | done |
| 1 | Device layer (`transport` / `client` / `models` / `iproxy` tunnel) | done |
| 2 | Inspect + interact tools | done (assertions / vision / skills / shell deferred) |
| 3 | Knowledge graph + observer + navigate/recall tools | done |
| 4 | System prompt + `~/.ios-inspector/config.toml` / env mapping | done |
| 5 | `para` CLI (`chat` / `exec` / `doctor` / `tools`) | done |
| 6 | Web/Host FastAPI+SPA | deferred, as planned |

SQLite uses `bun:sqlite` under Bun and `node:sqlite` under Node. That split is
required: `pi -e` loads extensions with Node/jiti, so a static `bun:sqlite`
import would crash the real CLI.

## Layout

```
src/
  index.ts              extension entry
  cli.ts                `para` CLI
  exec.ts               doctor + one-shot exec (JSON)
  config.ts             toml + env
  prompts.ts            system prompt
  transport.ts          HTTP to SAInspector
  client.ts             typed inspector client
  models.ts             Frame / ViewNode / VCNode / TapResult
  tools/                registerTool wrappers
  knowledge/            fingerprint, graph, store, observer
  ios-runtime/tunnel.ts USB port-forward (iproxy)
test/
```

## Develop

```bash
bun install
bun run check      # tsc --noEmit
bun test           # unit + extension smoke tests
```

## Run

```bash
# Interactive (pi TUI + this extension)
bun src/cli.ts
# or
bunx pi -e ./src/index.ts

# One-shot JSON (host/CI contract)
bun src/cli.ts exec -m "what page is shown?"

# Connectivity
bun src/cli.ts doctor
bun src/cli.ts doctor --json

# Tool list
bun src/cli.ts tools
```

The target iOS app must be running in Debug with `SAInspectorHTTPServer` on
port 8765. Real devices: `iproxy 8765 8765` (or let Para start it).

## Config

File `~/.ios-inspector/config.toml` (same path as the Python agent), then env.
Env wins. Useful keys:

| Key | Env |
|---|---|
| `inspector_host` / `inspector_port` | `PARA_INSPECTOR_HOST`, `PARA_INSPECTOR_PORT` (or `INSPECTOR_*`) |
| `inspector_device` | `PARA_DEVICE_UDID` / `INSPECTOR_DEVICE` |
| `bundle_id` | `PARA_BUNDLE_ID` / `INSPECTOR_BUNDLE_ID` |
| `anthropic_api_key` / `anthropic_base_url` | `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` |
| `openai_api_key` / `openai_base_url` | `OPENAI_API_KEY` / `OPENAI_BASE_URL` |
| `llm_model` | `PARA_LLM_MODEL` / `INSPECTOR_LLM_MODEL` |
| `disable_knowledge` | `PARA_DISABLE_KNOWLEDGE` |

A custom Anthropic-compatible `base_url` is applied via `pi.registerProvider("anthropic", { baseUrl })`.
Project lore is snapshotted from `PARA_NOTE_PATH` or `~/.ios-inspector/NOTE.md` at session start.
