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
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { applyConfigToEnv, loadConfig, type ParaConfig } from "./config.ts";
import { execExitCode, EXTENSION_PATH, listParaTools, probeDoctor, runExec } from "./exec.ts";

const require = createRequire(import.meta.url);

function piCliPath(): string {
	const entry = require.resolve("@earendil-works/pi-coding-agent");
	return join(dirname(entry), "bundle", "cli.js");
}

function printHelp(): void {
	process.stdout.write(`Para — iOS GUI agent on pi

Usage:
  para [chat] [pi-args...]   Interactive session (pi CLI + Para extension)
  para exec -m "<prompt>"    One turn; JSON on stdout
  para doctor [--json]       Inspector + API-key probe
  para tools                 List tools this extension registers

Config: ~/.ios-inspector/config.toml, then env
  PARA_INSPECTOR_HOST / INSPECTOR_HOST   (default localhost)
  PARA_INSPECTOR_PORT / INSPECTOR_PORT   (default 8765)
  PARA_DEVICE_UDID / INSPECTOR_DEVICE
  PARA_INSPECTOR_PLATFORM / --platform   auto | ios | android
  PARA_INSPECTOR_REMOTE_PORT / --remote-port
  PARA_MODE / --para-mode          gui (device) or code (repo)
  ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL
  OPENAI_API_KEY / OPENAI_BASE_URL
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

function runInteractive(piArgs: string[]): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [piCliPath(), "-e", EXTENSION_PATH, ...piArgs], {
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
	return [
		`inspector  ${d.inspector.base_url}  ${ping}`,
		`llm        provider=${d.llm.provider}  ${llm}`,
		`tunnel     ${d.tunnel.action ?? "?"}  ${d.tunnel.detail ?? ""}`,
		`result     ${d.ok ? "ok" : d.code}`,
		"",
	].join("\n");
}

async function main(argv: string[]): Promise<number> {
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
	applyConfigToEnv(cfg);
	return runInteractive(rest);
}

const code = await main(process.argv.slice(2));
process.exit(code);
