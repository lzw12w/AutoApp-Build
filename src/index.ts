/**
 * Para — pi extension entry point.
 *
 * Para is an App-runtime GUI agent: it drives a running iOS/Android app in
 * natural language and builds a knowledge graph as it explores. Historically
 * it was a standalone Python agent; it is rebuilt as a pi extension so the
 * agent loop, multi-provider LLM layer, and tool execution come from pi
 * (@earendil-works/pi-*). Para owns the device domain (Inspector transport,
 * tools, knowledge graph) and GUI-specific context compression: Layer 1
 * view_hierarchy elision, ingest payload minify, and a GUI compaction summary.
 *
 * Load with:  pi -e ./src/index.ts   or   bun src/cli.ts
 */
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { InspectorClient } from "./client.ts";
import { compactToolResultContent } from "./compact/payload.ts";
import { elideOldViewHierarchies } from "./compact/elide.ts";
import { extractiveGuiSummary, generateGuiCompactionSummary } from "./compact/summary.ts";
import { applyConfigToEnv, defaultNotePath, loadConfig, syncInspectorEnv } from "./config.ts";
import { resolveIntoConfig } from "./ios-runtime/device-registry.ts";
import { ensureLocalInspectorTunnel } from "./ios-runtime/tunnel.ts";
import { identityForAction, safeParams } from "./knowledge/attribution.ts";
import { resolveBundleId } from "./knowledge/bundle.ts";
import { KnowledgeObserver } from "./knowledge/observer.ts";
import { KnowledgeStore } from "./knowledge/store.ts";
import {
	activeToolsForMode,
	buildCodeSystemPrompt,
	isModeContextMessage,
	modeBlockReason,
	modeContextLine,
	parseMode,
	parseModeOrDefault,
	switchModeTool,
	type ParaMode,
} from "./mode.ts";
import { buildSystemPrompt, readNoteBody } from "./prompts.ts";
import { MUTATING_TOOL_NAMES } from "./tools/index.ts";
import { buildTools } from "./tools/index.ts";
import { buildKnowledgeTools, type KnowledgeContext } from "./tools/knowledge.ts";
import { recordKnowledgeTool } from "./tools/note.ts";
import { contentLooksFailed } from "./tools/result.ts";
import { renderTodosReminder, TodoList, todoWriteTool } from "./tools/todo.ts";

const PARA_TITLE = "Para";

/** Replace pi's startup banner and terminal tab name. Layout stays pi's. */
function brandTui(ui: ExtensionUIContext | undefined, sessionName?: string): void {
	if (!ui) return;
	const cwd = basename(process.cwd()) || PARA_TITLE;
	const title = sessionName ? `${PARA_TITLE} - ${sessionName} - ${cwd}` : `${PARA_TITLE} - ${cwd}`;
	ui.setTitle?.(title);
	ui.setHeader?.((_tui, theme) => ({
		invalidate() {},
		render(): string[] {
			return [theme.bold(theme.fg("accent", PARA_TITLE)), theme.fg("dim", "drive a live iOS/Android app")];
		},
	}));
}

export default function (pi: ExtensionAPI): void {
	const cfg = loadConfig();
	applyConfigToEnv(cfg);

	const client = new InspectorClient({ host: cfg.inspectorHost, port: cfg.inspectorPort });

	// NOTE.md is snapshotted at load so mid-session record_knowledge writes
	// do not mutate the live system prompt (same contract as the Python agent).
	const notePath = defaultNotePath(cfg);
	const noteBody = readNoteBody(notePath);
	const todos = new TodoList();
	const registered: string[] = [];
	let mode: ParaMode = cfg.mode;
	let lastUi: ExtensionUIContext | undefined;

	function applyMode(next: ParaMode, reason: string, ui?: ExtensionUIContext) {
		const from = mode;
		mode = next;
		const tools = activeToolsForMode(mode, registered);
		pi.setActiveTools(tools);
		const view = ui ?? lastUi;
		view?.setStatus?.("para-mode", mode);
		if (from !== next) view?.notify?.(`Para mode: ${from} → ${next}`, "info");
		return { status: from === next ? ("unchanged" as const) : ("switched" as const), mode, from, reason, tools };
	}

	pi.registerFlag("para-mode", {
		description: "Start in gui (device) or code (repo) mode",
		type: "string",
		default: cfg.mode,
	});
	pi.registerCommand("gui", {
		description: "Switch Para to GUI mode (drive the iOS app)",
		handler: async (_args, ctx) => {
			applyMode("gui", "user /gui", ctx.ui);
		},
	});
	pi.registerCommand("code", {
		description: "Switch Para to CODE mode (edit this workspace)",
		handler: async (_args, ctx) => {
			applyMode("code", "user /code", ctx.ui);
		},
	});
	pi.registerCommand("mode", {
		description: "Show or set Para mode: /mode, /mode gui, /mode code",
		handler: async (args, ctx) => {
			const raw = args.trim();
			if (!raw) {
				ctx.ui.notify(`Para mode: ${mode}`, "info");
				return;
			}
			const parsed = parseMode(raw);
			if (!parsed) {
				ctx.ui.notify('Usage: /mode gui | /mode code', "error");
				return;
			}
			applyMode(parsed, `user /mode ${parsed}`, ctx.ui);
		},
	});

	let store: KnowledgeStore | null = null;
	let observer: KnowledgeObserver | null = null;

	async function ensureObserver(signal?: AbortSignal): Promise<KnowledgeObserver> {
		if (observer) return observer;
		const bundle = await resolveBundleId(client, cfg.bundleId, signal);
		store = KnowledgeStore.forApp(bundle, cfg.knowledgeDir);
		observer = new KnowledgeObserver(store);
		return observer;
	}

	async function snapshotNow(
		signal?: AbortSignal,
		postAction = false,
	): Promise<{ store: KnowledgeStore; observer: KnowledgeObserver }> {
		const obs = await ensureObserver(signal);
		const [view, vc] = await Promise.all([
			client.viewHierarchy({ depth: 8, onScreenOnly: true, signal }),
			client.vcHierarchy(signal).catch(() => null),
		]);
		obs.observe(view, vc, { postAction });
		return { store: store as KnowledgeStore, observer: obs };
	}

	pi.on("session_start", async (_event, ctx) => {
		// LLM provider/baseUrl/apiKey come entirely from pi's own config in
		// Para's own agent home (~/.para/agent/models.json + auth.json). Para no
		// longer injects a provider baseUrl, so it can't clobber a separate
		// proxy's ANTHROPIC_*.
		mode = parseModeOrDefault(pi.getFlag("para-mode"), cfg.mode);
		lastUi = ctx.ui;
		brandTui(ctx.ui);
		applyMode(mode, "session start", ctx.ui);
		try {
			if (cfg.autoTunnel) {
				const deviceError = await resolveIntoConfig(cfg, { missingOk: !cfg.inspectorDevice.trim() });
				if (deviceError) {
					ctx.ui.notify(deviceError, "error");
					return;
				}
				syncInspectorEnv(cfg);
				client.retarget({ host: cfg.inspectorHost, port: cfg.inspectorPort });
			}
			const status = await ensureLocalInspectorTunnel({
				host: cfg.inspectorHost,
				port: cfg.inspectorPort,
				identifier: cfg.inspectorDevice,
				platform: cfg.inspectorPlatform,
				remotePort: cfg.inspectorRemotePort,
				requireHealthy: false,
				start: cfg.autoTunnel,
			});
			const level = status.ok ? "info" : "warning";
			const device = cfg.inspectorDevice ? ` device=${cfg.inspectorDevice}` : "";
			ctx.ui.notify(
				`Para — inspector http://${cfg.inspectorHost}:${cfg.inspectorPort}${device} (tunnel: ${status.action}, mode: ${mode})`,
				level,
			);
		} catch (e) {
			ctx.ui.notify(`Para loaded — tunnel setup skipped: ${e instanceof Error ? e.message : String(e)}`, "warning");
		}
	});

	pi.on("session_info_changed", async (event, ctx) => {
		lastUi = ctx.ui;
		brandTui(ctx.ui, event.name);
	});

	pi.on("before_agent_start", async (event) => {
		if (mode === "code") {
			return { systemPrompt: buildCodeSystemPrompt(event?.systemPrompt ?? "") };
		}
		return {
			systemPrompt: buildSystemPrompt({
				noteBody,
				notePath,
				skills: event?.systemPromptOptions?.skills,
			}),
		};
	});

	pi.on("context", async (event) => {
		let messages = event.messages;
		let changed = false;
		if (cfg.elideOldViewHierarchies) {
			const next = elideOldViewHierarchies(messages, { keepRecent: cfg.elideKeepRecent });
			if (next !== messages) {
				messages = next;
				changed = true;
			}
		}
		const reminder = renderTodosReminder(todos.get());
		if (reminder) {
			messages = [
				...messages,
				{ role: "user", content: [{ type: "text", text: reminder }], timestamp: Date.now() },
			];
			changed = true;
		}
		const withoutMode = messages.filter((m) => !isModeContextMessage(m));
		messages = [
			...withoutMode,
			{ role: "user", content: [{ type: "text", text: modeContextLine(mode) }], timestamp: Date.now() },
		];
		changed = true;
		if (changed) return { messages };
		return;
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (mode === "code") return;
		const { preparation, customInstructions, signal } = event;
		const generated = await generateGuiCompactionSummary(ctx, {
			messagesToSummarize: preparation.messagesToSummarize,
			turnPrefixMessages: preparation.turnPrefixMessages,
			previousSummary: preparation.previousSummary,
			customInstructions,
			signal,
		});
		const summary =
			generated?.summary ??
			extractiveGuiSummary(
				[...preparation.messagesToSummarize, ...preparation.turnPrefixMessages],
				preparation.previousSummary,
			);
		return {
			compaction: {
				summary,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				usage: generated?.usage,
			},
		};
	});

	pi.on("tool_call", async (event) => {
		const blocked = modeBlockReason(mode, event.toolName, new Set(registered));
		if (blocked) return { block: true, reason: blocked };
		if (cfg.disableKnowledge) return;
		if (!MUTATING_TOOL_NAMES.has(event.toolName)) return;
		try {
			const obs = await ensureObserver();
			// First mutating tool has no from-page unless an inspect tool
			// already committed one. Snapshot the live screen first so the
			// subsequent post-action observe can record the edge.
			if (obs.currentPage === null) {
				await snapshotNow(undefined, false);
			}
			const input = (event.input ?? {}) as Record<string, unknown>;
			const actionName = event.toolName === "tap_with_diff" ? "tap" : event.toolName;
			obs.recordAction(actionName, safeParams(input), identityForAction(actionName, input));
		} catch {
			// attribution is best-effort; never block the tool
		}
	});

	pi.on("tool_result", async (event) => {
		if (!cfg.disableKnowledge && MUTATING_TOOL_NAMES.has(event.toolName)) {
			try {
				const failed = event.isError || contentLooksFailed(event.content as { type: string; text?: string }[]);
				if (failed) {
					const obs = await ensureObserver();
					obs.recordFailedTransition();
				} else {
					await snapshotNow(undefined, true);
				}
			} catch {
				// best-effort; a snapshot failure must not fail the turn
			}
		}
		const content = compactToolResultContent(event.toolName, event.content);
		if (content !== event.content) return { content };
		return;
	});

	for (const tool of buildTools(client, {
		onInspect: cfg.disableKnowledge
			? undefined
			: async (view, vc) => {
					const obs = await ensureObserver();
					obs.observe(view, vc, { postAction: false });
				},
		onTapTarget: cfg.disableKnowledge
			? undefined
			: (kind, params, identity) => {
					observer?.enrichLatestAction(kind, params, identity);
				},
	})) {
		pi.registerTool(tool);
		registered.push(tool.name);
	}

	pi.registerTool(todoWriteTool(todos));
	registered.push("todo_write");
	pi.registerTool(recordKnowledgeTool(notePath));
	registered.push("record_knowledge");
	pi.registerTool(
		switchModeTool({
			get: () => mode,
			apply: (next, reason) => applyMode(next, reason),
		}),
	);
	registered.push("switch_mode");

	if (!cfg.disableKnowledge) {
		const kc: KnowledgeContext = {
			client,
			snapshotNow: (signal?: AbortSignal) => snapshotNow(signal, false),
		};
		for (const tool of buildKnowledgeTools(kc)) {
			pi.registerTool(tool);
			registered.push(tool.name);
		}
	}
}
