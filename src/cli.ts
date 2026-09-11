#!/usr/bin/env bun
/**
 * `para` CLI.
 *
 *   para exec -m "..."   one machine-stable turn (JSON on stdout)
 *   para serve           Web UI + agent/graph API
 *   para doctor [--json] inspector + LLM-key probe
 *   para tools           list registered tool names
 *   para [chat] [...]    interactive (pi CLI + this extension)
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { coerceParams, listCallableTools, runCall, type ToolSpec } from "./call.ts";
import { applyAgentDir, applyConfigToEnv, loadConfig, syncInspectorEnv, type ParaConfig } from "./config.ts";
import {
	execExitCode,
	EXTENSION_PATH,
	listModels,
	listParaTools,
	probeDoctor,
	runExec,
} from "./exec.ts";
import { resolveIntoConfig } from "./ios-runtime/device-registry.ts";

function piCliPath(): string {
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	return join(dirname(entry), "bundle", "cli.js");
}

function printHelp(): void {
	process.stdout.write(`Para — drive a live iOS/Android app with natural language

Usage:
  para exec -m "<prompt>" [--session-id <id> | -c]   One turn; JSON on stdout
  para serve [--serve-host H] [--serve-port P]  Web UI, default 127.0.0.1:7777
  para doctor [--json]       Inspector + API-key probe
  para models [--all]        Which models llm_model can name right now
  para tools                 List registered tool names
  para [chat] [pi-args...]   Interactive (pi TUI + this extension)

Config: ~/.para/config.toml, then env
  PARA_DEVICE_UDID / --device            UDID or adb serial; required with multiple devices
  PARA_INSPECTOR_PLATFORM / --platform   auto | ios | android
  PARA_INSPECTOR_REMOTE_PORT / --remote-port  On-device inspector port (default 8765)
  PARA_INSPECTOR_TRANSPORT               device (default) | tcp — dial the device
                                         over USB, or connect to an existing
                                         localhost forward
  PARA_INSPECTOR_HOST / PARA_INSPECTOR_PORT   Only used when transport=tcp

LLM: providers and keys live in ~/.para/agent/models.json (or \`pi auth\`); Para
  only selects one, via llm_model in config.toml, PARA_LLM_MODEL, or --model.
  Run \`para models\` to see what is usable right now. Separate from ~/.pi/agent;
  Para does not read ANTHROPIC_* / OPENAI_*. Override home with PARA_AGENT_DIR.
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
		? `${d.device.platform} ${d.device.id} → port ${d.device.remote_port} (direct, no port forward)`
		: "unspecified";
	const lines = [
		`inspector  ${d.inspector.base_url}  ${ping}`,
		`device     ${device}`,
		`llm        provider=${d.llm.provider}  ${llm}`,
		`transport  ${d.tunnel.action ?? "?"}  ${d.tunnel.detail ?? ""}`,
		`result     ${d.ok ? "ok" : d.code}`,
	];
	// List every attachment only when the selected one is not the whole story:
	// several plugged in, or one that is present but unusable. With a single
	// ready device the `device` line above already said it.
	const worthListing = d.devices.length > 1 || d.devices.some((x) => !x.ready);
	if (worthListing) {
		lines.push("", "attached");
		for (const x of d.devices) {
			const mark = x.selected ? "*" : " ";
			const state = x.ready ? "" : `  NOT READY (${x.connection})`;
			lines.push(`  ${mark} ${x.platform.padEnd(7)} ${x.id}${x.model ? `  ${x.model}` : ""}${state}`);
		}
	}
	lines.push("");
	return lines.join("\n");
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

	if (head === "call") {
		const rest = argv.slice(1);
		const json = hasFlag(rest, "--json-out");
		const wantList = hasFlag(rest, "--list");
		const positional = rest.filter((a) => !a.startsWith("-"));
		const toolName = positional[0];

		// --list, and `call` with no tool, both mean "what can I call?".
		// Progressive discovery: names and one-line purpose here, full
		// parameters only when asked for a specific tool via --help.
		if (wantList || !toolName) {
			const { cfg } = withCliOverrides(rest.filter((a) => a !== "--list" && a !== "--json-out"));
			const specs = await listCallableTools(cfg);
			if (json) {
				process.stdout.write(`${JSON.stringify(specs, null, 2)}\n`);
				return 0;
			}
			for (const t of specs as ToolSpec[]) {
				const req = t.params.filter((p: ToolSpec["params"][number]) => p.required).map((p) => `--${p.name} <${p.type}>`);
				const opt = t.params.filter((p: ToolSpec["params"][number]) => !p.required).length;
				const sig = [...req, opt ? `[+${opt} optional]` : ""].filter(Boolean).join(" ");
				process.stdout.write(`${t.name.padEnd(20)}${sig}\n`);
			}
			process.stdout.write(`\nUse \`para call <tool> --help\` for parameters.\n`);
			return 0;
		}

		// Per-tool --help, generated from the tool's own schema so it cannot
		// drift from the implementation.
		if (hasFlag(rest, "--help") || hasFlag(rest, "-h")) {
			const { cfg } = withCliOverrides(rest.filter((a) => a !== "--help" && a !== "-h" && a !== toolName));
			const spec = (await listCallableTools(cfg)).find((t) => t.name === toolName);
			if (!spec) {
				process.stderr.write(`unknown tool "${toolName}" — run \`para call --list\`\n`);
				return 2;
			}
			process.stdout.write(`${spec.name} — ${spec.label}\n\n${spec.description}\n`);
			if (spec.params.length) {
				process.stdout.write("\nparameters\n");
				for (const p of spec.params) {
					const mark = p.required ? "*" : " ";
					const choices = p.enum ? ` (${p.enum.join("|")})` : "";
					process.stdout.write(`  ${mark} --${p.name.padEnd(20)} ${p.type}${choices}\n`);
					if (p.description) process.stdout.write(`      ${p.description}\n`);
				}
				process.stdout.write("\n  * required. Use --json '{...}' for nested or exclusive params.\n");
			} else {
				process.stdout.write("\ntakes no parameters\n");
			}
			return 0;
		}

		// Params come either as one --json blob or as individual flags.
		const jsonFlag = takeFlag(rest, ["--json"]);
		let params: Record<string, unknown> = {};
		const flagPairs: Record<string, string | boolean> = {};
		const passthrough: string[] = [];
		if (jsonFlag.value) {
			try {
				params = JSON.parse(jsonFlag.value) as Record<string, unknown>;
			} catch (e) {
				process.stderr.write(`--json is not valid JSON: ${e instanceof Error ? e.message : String(e)}\n`);
				return 2;
			}
			passthrough.push(...jsonFlag.rest);
		} else {
			// Split "--flag value" / "--flag" from config overrides, which
			// withCliOverrides owns. Tool params are whatever the schema names.
			const words = jsonFlag.rest.filter((a) => a !== toolName && a !== "--json-out");
			const { cfg: probeCfg } = withCliOverrides([]);
			const spec = (await listCallableTools(probeCfg)).find((t) => t.name === toolName);
			const known = new Set(spec?.params.map((p: ToolSpec["params"][number]) => p.name) ?? []);
			for (let i = 0; i < words.length; i++) {
				const w = words[i];
				if (!w?.startsWith("--")) {
					passthrough.push(w ?? "");
					continue;
				}
				const key = w.slice(2);
				if (!known.has(key)) {
					passthrough.push(w);
					const next = words[i + 1];
					if (next && !next.startsWith("--")) {
						passthrough.push(next);
						i++;
					}
					continue;
				}
				const next = words[i + 1];
				if (next && !next.startsWith("--")) {
					flagPairs[key] = next;
					i++;
				} else {
					flagPairs[key] = true;
				}
			}
		}

		const { cfg } = withCliOverrides(passthrough);
		if (!jsonFlag.value && Object.keys(flagPairs).length) {
			const spec = (await listCallableTools(cfg)).find((t) => t.name === toolName);
			const schema = {
				properties: Object.fromEntries(
					(spec?.params ?? []).map((p: ToolSpec["params"][number]) => [
						p.name,
						p.enum ? { type: "string", enum: p.enum } : { type: p.type },
					]),
				),
			};
			try {
				params = coerceParams(flagPairs, schema);
			} catch (e) {
				process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
				return 2;
			}
		}

		const result = await runCall(cfg, toolName, params);
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return result.ok ? 0 : 1;
	}

	if (head === "models") {
		const json = hasFlag(argv, "--json");
		const all = hasFlag(argv, "--all");
		const { cfg } = withCliOverrides(argv.slice(1).filter((a) => a !== "--json" && a !== "--all"));
		const listing = await listModels(cfg, { includeUnauthenticated: all });
		if (json) {
			process.stdout.write(`${JSON.stringify(listing, null, 2)}\n`);
			return listing.unresolved ? 1 : 0;
		}
		if (listing.available.length === 0) {
			process.stdout.write(
				"No model has a usable credential.\nAdd a provider with an apiKey to ~/.para/agent/models.json, then re-run.\n",
			);
		} else {
			process.stdout.write("Usable now (llm_model can name any of these):\n");
			for (const m of listing.available) {
				process.stdout.write(`  ${m.selected ? "*" : " "} ${m.provider}/${m.id}\n`);
			}
		}
		if (listing.unresolved) {
			process.stdout.write(`\nllm_model = "${listing.requested}" matches none of the above.\n`);
		} else if (!listing.requested) {
			process.stdout.write("\nllm_model is unset; pi picks the model.\n");
		}
		// pi ships a large builtin catalog, so this list is long and mostly
		// irrelevant. Summarise unless asked for the whole thing.
		if (listing.unauthenticatedCount > 0) {
			if (all && listing.unauthenticated) {
				process.stdout.write("\nKnown but not authenticated:\n");
				for (const m of listing.unauthenticated) {
					process.stdout.write(`    ${m.provider}/${m.id}\n`);
				}
			} else {
				process.stdout.write(
					`\n${listing.unauthenticatedCount} more model(s) known but lacking a credential — see --all.\n`,
				);
			}
		}
		return listing.unresolved ? 1 : 0;
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
		const sid = takeFlag(msg.rest, ["--session-id", "--session"]);
		const cont = sid.rest.includes("--continue") || sid.rest.includes("-c");
		const { cfg } = withCliOverrides(
			sid.rest.filter((a) => a !== "--json" && a !== "--continue" && a !== "-c"),
		);
		const sessionId = sid.value?.trim();
		const result = await runExec(cfg, msg.value ?? "", {
			...(sessionId ? { sessionId } : {}),
			...(cont ? { continueRecent: true } : {}),
		});
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
