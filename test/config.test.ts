import { describe, expect, test } from "bun:test";
import { applyAgentDir, applyConfigToEnv, loadConfig, parseFlatToml, syncInspectorEnv } from "../src/config.ts";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defaultSessionDir,
	findRecentSessionFileForTest,
	findSessionFileForTest,
	resolveExecModel,
} from "../src/exec.ts";

describe("parseFlatToml", () => {
	test("reads strings, numbers, bools, strips comments", () => {
		const data = parseFlatToml(`
inspector_host = "127.0.0.1" # comment
inspector_port = 9000
disable_knowledge = true
llm_provider = 'anthropic'
`);
		expect(data.inspector_host).toBe("127.0.0.1");
		expect(data.inspector_port).toBe(9000);
		expect(data.disable_knowledge).toBe(true);
		expect(data.llm_provider).toBe("anthropic");
	});

	test("does not strip # inside quoted values", () => {
		const data = parseFlatToml(`
note_path = "/foo#bar"
base_url = 'https://x/y#frag' # trailing comment
`);
		expect(data.note_path).toBe("/foo#bar");
		expect(data.base_url).toBe("https://x/y#frag");
	});
});

describe("loadConfig", () => {
	test("PARA_* overrides INSPECTOR_* and defaults", () => {
		const cfg = loadConfig({
			tomlPath: "/this/does/not/exist.toml",
			env: {
				INSPECTOR_HOST: "10.0.0.1",
				PARA_INSPECTOR_HOST: "localhost",
				PARA_INSPECTOR_PORT: "8777",
			},
		});
		expect(cfg.inspectorHost).toBe("localhost");
		expect(cfg.inspectorPort).toBe(8777);
	});

	test("does not read ANTHROPIC_* / OPENAI_* env (pi owns LLM config)", () => {
		const cfg = loadConfig({
			tomlPath: "/this/does/not/exist.toml",
			env: {
				ANTHROPIC_API_KEY: "sk-should-be-ignored",
				ANTHROPIC_BASE_URL: "http://127.0.0.1:15721/claude-desktop",
				OPENAI_API_KEY: "sk-openai-ignored",
			},
		});
		expect(cfg).not.toHaveProperty("anthropicApiKey");
		expect(cfg).not.toHaveProperty("anthropicBaseUrl");
		expect(cfg).not.toHaveProperty("openaiApiKey");
	});

	test("PARA_INSPECTOR_PLATFORM and remote port map through", () => {
		const cfg = loadConfig({
			tomlPath: "/this/does/not/exist.toml",
			env: {
				PARA_INSPECTOR_PLATFORM: "android",
				PARA_INSPECTOR_REMOTE_PORT: "8765",
				PARA_DEVICE_UDID: "SERIAL",
			},
		});
		expect(cfg.inspectorPlatform).toBe("android");
		expect(cfg.inspectorRemotePort).toBe(8765);
		expect(cfg.inspectorDevice).toBe("SERIAL");
	});

	test("PARA_MODE env maps through", () => {
		const cfg = loadConfig({
			tomlPath: "/this/does/not/exist.toml",
			env: { PARA_MODE: "code" },
		});
		expect(cfg.mode).toBe("code");
	});

	test("INSPECTOR_DISABLE_VH_ELISION and keep-recent env map through", () => {
		const cfg = loadConfig({
			tomlPath: "/this/does/not/exist.toml",
			env: {
				INSPECTOR_DISABLE_VH_ELISION: "1",
				INSPECTOR_ELIDE_KEEP_RECENT: "4",
			},
		});
		expect(cfg.elideOldViewHierarchies).toBe(false);
		expect(cfg.elideKeepRecent).toBe(4);
	});

	test("applyConfigToEnv sets inspector keys and never touches ANTHROPIC_*", () => {
		const env: NodeJS.ProcessEnv = {};
		applyConfigToEnv(loadConfig({ tomlPath: "/nope", env: {} }), env);
		expect(env.PARA_INSPECTOR_HOST).toBe("localhost");
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
	});

	test("syncInspectorEnv overwrites the assigned port", () => {
		const env: NodeJS.ProcessEnv = { PARA_INSPECTOR_PORT: "8765" };
		const cfg = loadConfig({ tomlPath: "/nope", env: {} });
		cfg.inspectorPort = 8766;
		cfg.inspectorDevice = "SERIAL";
		cfg.inspectorPlatform = "android";
		cfg.inspectorRemotePort = 8765;
		syncInspectorEnv(cfg, env);
		expect(env.PARA_INSPECTOR_PORT).toBe("8766");
		expect(env.PARA_DEVICE_UDID).toBe("SERIAL");
		expect(env.PARA_INSPECTOR_PLATFORM).toBe("android");
		expect(env.PARA_INSPECTOR_REMOTE_PORT).toBe("8765");
	});
});

describe("applyAgentDir", () => {
	test("skips pi version checks unless the user already set PI_SKIP_VERSION_CHECK", () => {
		const env: NodeJS.ProcessEnv = { PARA_AGENT_DIR: "/tmp/para-skip-version-test" };
		applyAgentDir(env);
		expect(env.PI_SKIP_VERSION_CHECK).toBe("1");

		const kept: NodeJS.ProcessEnv = {
			PARA_AGENT_DIR: "/tmp/para-skip-version-test",
			PI_SKIP_VERSION_CHECK: "0",
		};
		applyAgentDir(kept);
		expect(kept.PI_SKIP_VERSION_CHECK).toBe("0");
	});
});

describe("resolveExecModel", () => {
	test("matches llm_model against pi's available catalog by id", () => {
		const available = [
			{ id: "qwen3.8-max", name: "qwen3.8-max" },
			{ id: "model_api/experimental_0630", name: "Experimental 0630" },
		] as unknown as Parameters<typeof resolveExecModel>[1];
		const model = resolveExecModel(
			{ ...loadConfig({ tomlPath: "/nope", env: {} }), llmModel: "qwen3.8-max" },
			available,
		);
		expect(model?.id).toBe("qwen3.8-max");
	});

	test("returns undefined when llm_model is unset", () => {
		const model = resolveExecModel(loadConfig({ tomlPath: "/nope", env: {} }), []);
		expect(model).toBeUndefined();
	});

	// The caller distinguishes these two undefined cases: unset means "let pi
	// pick", but a requested-and-unmatched name is a typo that runExec reports
	// as model_not_found instead of silently using another model.
	test("returns undefined when llm_model matches nothing", () => {
		const available = [
			{ id: "deepseek-v4-flash", name: "deepseek-v4-flash" },
		] as unknown as Parameters<typeof resolveExecModel>[1];
		const model = resolveExecModel(
			{ ...loadConfig({ tomlPath: "/nope", env: {} }), llmModel: "deepseek-v4-flashh" },
			available,
		);
		expect(model).toBeUndefined();
	});

	test("matches by name substring, not just exact id", () => {
		const available = [
			{ id: "model_api/experimental_0630", name: "Experimental 0630 (256K context)" },
		] as unknown as Parameters<typeof resolveExecModel>[1];
		const model = resolveExecModel(
			{ ...loadConfig({ tomlPath: "/nope", env: {} }), llmModel: "Experimental 0630" },
			available,
		);
		expect(model?.id).toBe("model_api/experimental_0630");
	});
});

describe("defaultSessionDir", () => {
	// exec mirrors pi's cwd-encoding scheme because pi does not export the
	// helper. If pi ever changes it, sessions would be written where nothing
	// looks for them and --session-id would silently start a fresh session
	// every call. Pin it against a directory pi itself created.
	test("matches the layout pi actually uses", () => {
		expect(defaultSessionDir("/home/u/.para/agent", "/Users/bytedance/para-v2/para-ios")).toBe(
			"/home/u/.para/agent/sessions/--Users-bytedance-para-v2-para-ios--",
		);
	});

	test("flattens separators and colons", () => {
		expect(defaultSessionDir("/a", "/x/y")).toBe("/a/sessions/--x-y--");
	});
});

describe("session file discovery", () => {
	// --session-id needs to find a session whose filename it does not know:
	// pi names files <timestamp>_<id>.jsonl, so the id alone is not a path.
	test("matches a session by its id suffix, not by exact filename", () => {
		const dir = mkdtempSync(join(tmpdir(), "para-sess-"));
		writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_wanted.jsonl"), "{}\n");
		writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_other.jsonl"), "{}\n");
		expect(findSessionFileForTest(dir, "wanted")).toBe(
			join(dir, "2026-01-01T00-00-00-000Z_wanted.jsonl"),
		);
		expect(findSessionFileForTest(dir, "absent")).toBeUndefined();
		rmSync(dir, { recursive: true, force: true });
	});

	test("--continue picks the newest file, and tolerates a missing dir", () => {
		const dir = mkdtempSync(join(tmpdir(), "para-sess-"));
		const older = join(dir, "2026-01-01T00-00-00-000Z_a.jsonl");
		const newer = join(dir, "2026-01-02T00-00-00-000Z_b.jsonl");
		writeFileSync(older, "{}\n");
		writeFileSync(newer, "{}\n");
		// Order by mtime, not by name — a caller-chosen id can sort anywhere.
		utimesSync(older, new Date(1000), new Date(1000));
		utimesSync(newer, new Date(2000), new Date(2000));
		expect(findRecentSessionFileForTest(dir)).toBe(newer);
		expect(findRecentSessionFileForTest(join(dir, "nope"))).toBeUndefined();
		rmSync(dir, { recursive: true, force: true });
	});
});
