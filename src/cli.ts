#!/usr/bin/env bun
/**
 * `para` CLI.
 *
 *   para                 interactive (pi CLI + this extension)
 *   para chat [...]      same, extra args forwarded to pi
 *   para exec -m "..."   one machine-stable turn (JSON on stdout)
 *   para doctor [--json] inspector + LLM-key probe
 *   para tools           list registered tool names
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAgentDir, applyConfigToEnv, loadConfig, syncInspectorEnv, type ParaConfig } from "./config.ts";
import { execExitCode, EXTENSION_PATH, listParaTools, probeDoctor, runExec } from "./exec.ts";
import { resolveIntoConfig } from "./ios-runtime/device-registry.ts";

function piCliPath(): string {
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	return join(dirname(entry), "bundle", "cli.js");
}

function printHelp(): void {
	process.stdout.write(`Para — iOS GUI agent on pi

Usage:
  para [chat] [pi-args...]   Interactive session (pi CLI + Para extension)
  para exec -m "<prompt>"    One turn; JSON on stdout
  para doctor [--json]       Inspector + API-key probe
  para tools                 List tools this extension registers

Config: ~/.para/config.toml, then env
  PARA_INSPECTOR_HOST / INSPECTOR_HOST   (default localhost)
  PARA_INSPECTOR_PORT / INSPECTOR_PORT   (default 8765; --device 会自动改写)
  PARA_DEVICE_UDID / --device            UDID 或 adb serial；多机必填，自动分配本地端口
  PARA_INSPECTOR_PLATFORM / --platform   auto | ios | android
  PARA_INSPECTOR_REMOTE_PORT / --remote-port
  PARA_MODE / --para-mode          gui (device) or code (repo)

LLM: configured in pi, from Para's own home. Add a provider (baseUrl + apiKey +
  models) to ~/.para/agent/models.json, then select it with llm_model in
  config.toml or --model. Kept separate from ~/.pi/agent; Para never reads
  ANTHROPIC_* / OPENAI_*, so a separate proxy can own those.
  (override home with PARA_AGENT_DIR)
`);
}

function takeFlag(argv: string[], names: string[]): { value: string | undefined; rest: string[] } {
	const rest: string[] = [];
	let value: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (names.includes(arg)) {
			value = argv[i + 1];
			i++;
			continue;
		}
		const hit = names.find((n) => arg.startsWith(`${n}=`));
		if (hit) {
			value = arg.slice(hit.length + 1);
			continue;
		}
		rest.push(arg);
	}
	return { value, rest };
}

function hasFlag(argv: string[], name: string): boolean {
	return argv.includes(name);
}

function withCliOverrides(argv: string[]): { cfg: ParaConfig; rest: string[] } {
	let rest = argv;
	const host = takeFlag(rest, ["--host"]);
	rest = host.rest;
	const port = takeFlag(rest, ["--port"]);
	rest = port.rest;
	const device = takeFlag(rest, ["--device", "-d"]);
	rest = device.rest;
	const platform = takeFlag(rest, ["--platform"]);
	rest = platform.rest;
	const remotePort = takeFlag(rest, ["--remote-port"]);
	rest = remotePort.rest;
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (host.value) env.PARA_INSPECTOR_HOST = host.value;
	if (port.value) env.PARA_INSPECTOR_PORT = port.value;
	if (device.value) env.PARA_DEVICE_UDID = device.value;
	if (platform.value) env.PARA_INSPECTOR_PLATFORM = platform.value;
	if (remotePort.value) env.PARA_INSPECTOR_REMOTE_PORT = remotePort.value;
	return { cfg: loadConfig({ env }), rest };
}

/**
 * Derive pi's thinking level from the Para config, matching exec.ts exactly:
 * a budget only enables thinking at the Anthropic minimum (>=1024), and stays
 * OFF otherwise. This keeps interactive (`para` / `para chat`) aligned with
 * `para exec` and with the original Python default (thinking off), instead of
 * inheriting pi's coding-agent DEFAULT_THINKING_LEVEL="medium".
 */
function configThinkingLevel(cfg: ParaConfig): "off" | "medium" | "high" {
	const budget = cfg.anthropicThinkingBudget ?? 0;
	if (budget >= 8192) return "high";
	if (budget >= 1024) return "medium";
	return "off";
}

function hasArg(argv: string[], name: string): boolean {
	return argv.some((a) => a === name || a.startsWith(`${name}=`));
}

function runInteractive(cfg: ParaConfig, piArgs: string[]): Promise<number> {
	const injected: string[] = [];
	// Pin the model from Para config so interactive matches `para exec`, instead
	// of letting pi fall through to its provider default. The model id and its
	// provider both resolve through Para's own ~/.para/agent/models.json (which
	// carries the gateway baseUrl + apiKey), so no env/provider injection here.
	// Skip only when the user drove model selection themselves (--model/--models).
	if (cfg.llmModel.trim() && !hasArg(piArgs, "--model") && !hasArg(piArgs, "--models")) {
		if (cfg.llmProvider.trim() && !hasArg(piArgs, "--provider")) {
			injected.push("--provider", cfg.llmProvider);
		}
		injected.push("--model", cfg.llmModel);
	}
	// Only inject our thinking default when the user did not set --thinking
	// themselves; pi treats an explicit --thinking as the final override (main.js).
	if (!hasArg(piArgs, "--thinking")) {
		injected.push("--thinking", configThinkingLevel(cfg));
	}
	return new Promise((resolve, reject) => {
		const child = spawn(piCliPath(), ["-e", EXTENSION_PATH, ...injected, ...piArgs], {
			stdio: "inherit",
			env: process.env,
		});
		child.on("error", reject);
		child.on("close", (code) => resolve(code ?? 1));
	});
}

function formatDoctorText(d: Awaited<ReturnType<typeof probeDoctor>>): string {
	const ping = d.inspector.reachable ? "ok" : `fail (${JSON.stringify(d.inspector.error)})`;
	const llm = d.llm.key_set ? "key set" : d.llm.error;
	const device = d.device
		? `${d.device.platform} ${d.device.id} → 127.0.0.1:${d.device.local_port} (remote ${d.device.remote_port})`
		: "unspecified";
	return [
		`inspector  ${d.inspector.base_url}  ${ping}`,
		`device     ${device}`,
		`llm        provider=${d.llm.provider}  ${llm}`,
		`tunnel     ${d.tunnel.action ?? "?"}  ${d.tunnel.detail ?? ""}`,
		`result     ${d.ok ? "ok" : d.code}`,
		"",
	].join("\n");
}

async function main(argv: string[]): Promise<number> {
	// Point pi at Para's own agent home (~/.para/agent) before any pi code —
	// ModelRuntime, getAgentDir, or a spawned child pi — reads its config.
	applyAgentDir();

	const head = argv[0];
	if (head === "-h" || head === "--help" || head === "help") {
		printHelp();
		return 0;
	}

	if (head === "tools") {
		const { cfg } = withCliOverrides(argv.slice(1));
		for (const name of listParaTools(cfg.disableKnowledge)) process.stdout.write(`${name}\n`);
		return 0;
	}

	if (head === "doctor") {
		const json = hasFlag(argv, "--json");
		const { cfg } = withCliOverrides(argv.slice(1).filter((a) => a !== "--json"));
		const result = await probeDoctor(cfg);
		process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : formatDoctorText(result));
		return result.ok ? 0 : execExitCode(result);
	}

	if (head === "exec") {
		const sliced = argv.slice(1);
		const msg = takeFlag(sliced, ["-m", "--message", "--prompt"]);
		const { cfg } = withCliOverrides(msg.rest.filter((a) => a !== "--json"));
		const result = await runExec(cfg, msg.value ?? "");
		process.stdout.write(`${JSON.stringify(result)}\n`);
		return execExitCode(result);
	}

	const chatArgs = head === "chat" ? argv.slice(1) : argv;
	const { cfg, rest } = withCliOverrides(chatArgs);
	const deviceError = await resolveIntoConfig(cfg, { missingOk: !cfg.inspectorDevice.trim() });
	if (deviceError) {
		process.stderr.write(`${deviceError}\n`);
		return 1;
	}
	applyConfigToEnv(cfg);
	syncInspectorEnv(cfg);
	return runInteractive(cfg, rest);
}

const code = await main(process.argv.slice(2));
process.exit(code);
