import { describe, expect, test } from "bun:test";
import { applyConfigToEnv, loadConfig, parseFlatToml } from "../src/config.ts";
import { resolveExecModel } from "../src/exec.ts";

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
});

describe("loadConfig", () => {
	test("PARA_* overrides INSPECTOR_* and defaults", () => {
		const cfg = loadConfig({
			tomlPath: "/this/does/not/exist.toml",
			env: {
				INSPECTOR_HOST: "10.0.0.1",
				PARA_INSPECTOR_HOST: "localhost",
				PARA_INSPECTOR_PORT: "8777",
				ANTHROPIC_API_KEY: "sk-test",
			},
		});
		expect(cfg.inspectorHost).toBe("localhost");
		expect(cfg.inspectorPort).toBe(8777);
		expect(cfg.anthropicApiKey).toBe("sk-test");
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

	test("applyConfigToEnv does not overwrite existing keys", () => {
		const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "from-env" };
		applyConfigToEnv({ ...loadConfig({ tomlPath: "/nope", env: {} }), anthropicApiKey: "from-file" }, env);
		expect(env.ANTHROPIC_API_KEY).toBe("from-env");
		expect(env.PARA_INSPECTOR_HOST).toBe("localhost");
	});
});

describe("resolveExecModel", () => {
	test("builds a gateway model from llm_model + anthropic_base_url", () => {
		const model = resolveExecModel(
			{
				...loadConfig({ tomlPath: "/nope", env: {} }),
				llmModel: "deepseek-v4-flash",
				anthropicBaseUrl: "https://api.deepseek.com/anthropic/",
				llmMaxTokens: 32768,
			},
			[],
		);
		expect(model?.id).toBe("deepseek-v4-flash");
		expect(model?.api).toBe("anthropic-messages");
		expect(model?.baseUrl).toBe("https://api.deepseek.com/anthropic");
		expect(model?.maxTokens).toBe(32768);
	});
});
