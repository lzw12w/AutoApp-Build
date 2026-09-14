/**
 * Machine-facing host API: doctor + one-shot exec.
 *
 * Stdout of `para exec` is a single JSON object (Python host_api.ExecResult).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { InspectorClient } from "./client.ts";
import { applyConfigToEnv, llmKeySet, syncInspectorEnv, type ParaConfig } from "./config.ts";
import { InspectorError } from "./errors.ts";
import { listDevices } from "./ios-runtime/device-broker.ts";
import { resolveIntoConfig } from "./ios-runtime/device-registry.ts";
import { CODE_MODE_ENABLED } from "./mode.ts";
import { buildTools } from "./tools/index.ts";
import { buildKnowledgeTools } from "./tools/knowledge.ts";
import { recordKnowledgeTool } from "./tools/note.ts";
import { TodoList, todoWriteTool } from "./tools/todo.ts";

export const EXTENSION_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));

export interface ExecResult {
	ok: boolean;
	code: string;
	reply: string;
	session_id: string | null;
	/**
	 * Set only when this call attached to a session that already had history.
	 * A caller that expected a fresh session can tell it inherited someone
	 * else's context — session ids are caller-chosen, so two scripts picking
	 * the same string would otherwise silently share a conversation.
	 */
	session_resumed?: {
		created: string;
		turns: number;
	};
	steps: Array<Record<string, unknown>>;
	step_count: number;
	busy: boolean;
	error: string | null;
}

export interface DoctorResult {
	ok: boolean;
	code: string;
	busy: boolean;
	inspector: {
		reachable: boolean;
		base_url: string;
		ping: unknown;
		error: unknown;
	};
	llm: { provider: string; key_set: boolean; error: string | null };
	tunnel: Record<string, unknown>;
	device: {
		id: string;
		platform: string;
		remote_port: number;
	} | null;
	/**
	 * Every device currently attached, not just the selected one. A caller
	 * facing "device required with multiple devices" needs the ids to choose
	 * from, and `ready: false` entries explain a device that is plugged in but
	 * unpaired / unauthorized — otherwise indistinguishable from absent.
	 */
	devices: Array<{
		id: string;
		platform: string;
		connection: string;
		model?: string;
		ready: boolean;
		selected: boolean;
	}>;
}

function preview(value: unknown, max = 160): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (!text) return "";
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function collectText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(collectText).filter(Boolean).join("");
	if (value && typeof value === "object") {
		const rec = value as Record<string, unknown>;
		if (typeof rec.text === "string") return rec.text;
		if (rec.content !== undefined) return collectText(rec.content);
	}
	return "";
}

function lastAssistantReply(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as { role?: string; content?: unknown } | undefined;
		if (msg?.role === "assistant") return collectText(msg).trim();
	}
	return "";
}

function lastAssistantError(messages: unknown[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
		if (msg?.role !== "assistant") continue;
		if (msg.stopReason === "error" && msg.errorMessage) return msg.errorMessage;
		return null;
	}
	return null;
}

/**
 * Select the model for `para exec` from pi's own catalog (which includes any
 * providers defined in ~/.para/agent/models.json). Para no longer fabricates a
 * model from its own baseUrl/apiKey — pi is the single source of LLM config —
 * so we just match cfg.llmModel against the available models by id or name.
 */
export function resolveExecModel(cfg: ParaConfig, available: readonly Model<string>[]): Model<string> | undefined {
	const wanted = cfg.llmModel.trim();
	if (!wanted) return undefined;
	const needle = wanted.toLowerCase();
	return available.find((m) => m.id.toLowerCase() === needle || m.name.toLowerCase().includes(needle));
}

export interface ModelListing {
	/** Models with a working credential — these are the ones llm_model can name. */
	available: { provider: string; id: string; selected: boolean }[];
	/** How many models pi knows of but cannot authenticate. Over a thousand in a
	 * default install, so the ids are only included when explicitly requested. */
	unauthenticatedCount: number;
	/** Populated only when `includeUnauthenticated` is set. */
	unauthenticated?: { provider: string; id: string }[];
	/** What llm_model currently says, whether or not it resolves. */
	requested: string;
	/** True when llm_model is set but matches nothing in `available`. */
	unresolved: boolean;
}

/**
 * What can `llm_model` actually name right now.
 *
 * Without this, picking a model means reading models.json by hand and guessing
 * which entries have a usable credential — the file lists what was configured,
 * not what works. pi's own catalog also contributes providers that never appear
 * in that file, so the file alone cannot answer the question.
 */
export async function listModels(
	cfg: ParaConfig,
	options: { includeUnauthenticated?: boolean } = {},
): Promise<ModelListing> {
	const runtime = await ModelRuntime.create();
	const available = await runtime.getAvailable();
	const selected = resolveExecModel(cfg, available);
	const availableKeys = new Set(available.map((m) => `${m.provider}\u0000${m.id}`));
	const others = (runtime.getModels?.() ?? [])
		.filter((m) => !availableKeys.has(`${m.provider}\u0000${m.id}`))
		.map((m) => ({ provider: m.provider, id: m.id }));
	const requested = cfg.llmModel.trim();
	return {
		available: available.map((m) => ({
			provider: m.provider,
			id: m.id,
			selected: selected?.provider === m.provider && selected?.id === m.id,
		})),
		unauthenticatedCount: others.length,
		...(options.includeUnauthenticated ? { unauthenticated: others } : {}),
		requested,
		unresolved: requested.length > 0 && selected === undefined,
	};
}

export function listParaTools(disableKnowledge = false): string[] {
	// Names only: this client is never dialed, so the device/port are irrelevant.
	const client = new InspectorClient();
	const names = buildTools(client).map((t) => t.name);
	names.push(todoWriteTool(new TodoList()).name);
	names.push(recordKnowledgeTool("/dev/null").name);
	if (CODE_MODE_ENABLED) names.push("switch_mode");
	if (disableKnowledge) return names;
	const knowledge = buildKnowledgeTools({
		client,
		snapshotNow: async () => {
			throw new Error("list-only");
		},
	});
	return [...names, ...knowledge.map((t) => t.name)];
}

function doctorDevice(cfg: ParaConfig): DoctorResult["device"] {
	if (!cfg.inspectorDevice.trim()) return null;
	return {
		id: cfg.inspectorDevice,
		platform: cfg.inspectorPlatform,
		remote_port: cfg.inspectorRemotePort ?? 8765,
	};
}

/**
 * Attached devices, annotated with which one this config resolves to.
 * Never throws: doctor's job is to report trouble, so a failing enumeration
 * degrades to an empty list rather than replacing the whole diagnosis.
 */
async function enumerateDevices(selectedId: string): Promise<DoctorResult["devices"]> {
	try {
		const found = await listDevices();
		return found.map((d) => ({
			id: d.id,
			platform: d.platform,
			connection: d.connection,
			...(d.model ? { model: d.model } : {}),
			ready: d.ready,
			selected: Boolean(selectedId) && d.id === selectedId,
		}));
	} catch {
		return [];
	}
}

export async function probeDoctor(cfg: ParaConfig): Promise<DoctorResult> {
	const keySet = llmKeySet(cfg);
	const llm = {
		provider: cfg.llmProvider,
		key_set: keySet,
		error: keySet ? null : "no LLM credential (configure ~/.para/agent/models.json or run `pi auth`)",
	};

	const deviceError = await resolveIntoConfig(cfg, { missingOk: !cfg.inspectorDevice.trim() });
	if (deviceError) {
		return {
			ok: false,
			code: "device_unavailable",
			busy: false,
			inspector: {
				reachable: false,
				base_url: "",
				ping: null,
				error: deviceError,
			},
			llm,
			tunnel: { action: "none", detail: deviceError },
			device: null,
			devices: await enumerateDevices(cfg.inspectorDevice.trim()),
		};
	}

	applyConfigToEnv(cfg);
	syncInspectorEnv(cfg);
	const client = new InspectorClient({
		host: cfg.inspectorHost,
		port: cfg.inspectorPort,
		device: cfg.inspectorDevice,
		platform: cfg.inspectorPlatform === "auto" ? undefined : cfg.inspectorPlatform,
		remotePort: cfg.inspectorRemotePort,
	});
	// Nothing to set up: `ping` below either reaches the device or it doesn't.
	// Reported under `tunnel` for output compatibility with earlier versions.
	const tunnel: Record<string, unknown> = {
		action: "direct",
		detail: `dialing ${cfg.inspectorDevice || "the connected device"} port ${cfg.inspectorRemotePort ?? cfg.inspectorPort}`,
	};

	const inspector: DoctorResult["inspector"] = {
		reachable: false,
		base_url: client.baseUrl,
		ping: null,
		error: null,
	};
	try {
		inspector.ping = await client.ping();
		inspector.reachable = true;
	} catch (e) {
		if (e instanceof InspectorError) {
			inspector.error = { code: e.code, message: e.message, detail: e.detail };
		} else {
			inspector.error = { code: "E_UNREACHABLE", message: e instanceof Error ? e.message : String(e) };
		}
	}

	let code = "ok";
	if (!inspector.reachable) code = "device_unavailable";
	else if (!keySet) code = "config_error";

	return {
		ok: inspector.reachable && keySet,
		code,
		busy: false,
		inspector,
		llm,
		tunnel: { ...tunnel },
		device: doctorDevice(cfg),
		devices: await enumerateDevices(cfg.inspectorDevice.trim()),
	};
}

export interface ExecOptions {
	/**
	 * Reuse a session on disk so successive `exec` calls share history.
	 * Created on first use, appended to afterwards. Omit for a one-shot,
	 * in-memory session that leaves nothing behind.
	 */
	sessionId?: string;
	/**
	 * Attach to the most recent session in this cwd, creating one if none
	 * exists. Saves the caller from inventing and threading an id. Ignored
	 * when sessionId is given, since that names a session outright.
	 */
	continueRecent?: boolean;
}

/**
 * Where pi keeps sessions for a given cwd: `<agentDir>/sessions/--<cwd>--`,
 * with separators flattened to `-`.
 *
 * pi computes this internally but does not export the helper, so the scheme is
 * mirrored here. It is verified against a real session directory in the tests —
 * if pi ever changes the encoding, that test fails rather than exec silently
 * writing sessions somewhere nothing will look for them.
 */
export function defaultSessionDir(agentDir: string, cwd: string): string {
	const safe = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(agentDir, "sessions", safe);
}

/**
 * Newest session file in a directory, or undefined when there is none.
 *
 * pi has its own findMostRecentSession but does not export it from the package
 * root. Mirrored here: newest mtime wins. pi additionally filters by the cwd
 * recorded in each header, which is redundant for us — defaultSessionDir()
 * already scopes the directory to one cwd.
 */
export function findRecentSessionFileForTest(dir: string): string | undefined {
	return findRecentSessionFile(dir);
}

function findRecentSessionFile(dir: string): string | undefined {
	if (!existsSync(dir)) return undefined;
	let best: { path: string; mtime: number } | undefined;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		const path = join(dir, name);
		const mtime = statSync(path).mtimeMs;
		if (!best || mtime > best.mtime) best = { path, mtime };
	}
	return best?.path;
}

/**
 * Locate a persisted session by id.
 *
 * Files are named `<timestamp>_<sessionId>.jsonl`, so the id alone does not
 * give the path — the directory has to be scanned. Returns undefined when the
 * session does not exist yet, which is the normal first-call case.
 */
export function findSessionFileForTest(dir: string, sessionId: string): string | undefined {
	return findSessionFile(dir, sessionId);
}

function findSessionFile(dir: string, sessionId: string): string | undefined {
	if (!existsSync(dir)) return undefined;
	const suffix = `_${sessionId}.jsonl`;
	for (const name of readdirSync(dir)) {
		if (name.endsWith(suffix)) return join(dir, name);
	}
	return undefined;
}

export async function runExec(
	cfg: ParaConfig,
	message: string,
	options: ExecOptions = {},
): Promise<ExecResult> {
	applyConfigToEnv(cfg);
	const trimmed = message.trim();
	if (!trimmed) {
		return {
			ok: false,
			code: "config_error",
			reply: "",
			session_id: null,
			steps: [],
			step_count: 0,
			busy: false,
			error: "empty message",
		};
	}

	const doctor = await probeDoctor(cfg);
	if (!doctor.inspector.reachable) {
		return {
			ok: false,
			code: "device_unavailable",
			reply: "",
			session_id: null,
			steps: [],
			step_count: 0,
			busy: false,
			error: typeof doctor.inspector.error === "object" && doctor.inspector.error
				? String((doctor.inspector.error as { message?: string }).message ?? "inspector unreachable")
				: "inspector unreachable",
		};
	}
	if (!doctor.llm.key_set) {
		return {
			ok: false,
			code: "config_error",
			reply: "",
			session_id: null,
			steps: [],
			step_count: 0,
			busy: false,
			error: doctor.llm.error,
		};
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		additionalExtensionPaths: [EXTENSION_PATH],
	});
	await resourceLoader.reload();

	// If the extension fails to load, pi records the error and carries on with
	// zero Para tools registered. The agent then answers from imagination and
	// exec still reports ok, which is worse than crashing: the caller cannot
	// tell a real observation from a guess. Fail loudly instead.
	//
	// `extensionsResult` is private in DefaultResourceLoader and there is no
	// public accessor for load errors, so read it structurally.
	const loaderErrors = (
		resourceLoader as unknown as {
			extensionsResult?: { errors?: { path?: string; error?: unknown }[] };
		}
	).extensionsResult?.errors;
	if (loaderErrors && loaderErrors.length > 0) {
		const detail = loaderErrors.map((e) => `${e.path ?? "?"}: ${String(e.error)}`).join("; ");
		return {
			ok: false,
			code: "extension_error",
			reply: "",
			session_id: null,
			steps: [],
			step_count: 0,
			busy: false,
			error: `Failed to load the Para extension, so no device tools are available: ${detail}`,
		};
	}

	const modelRuntime = await ModelRuntime.create();
	const available = await modelRuntime.getAvailable();
	const model = resolveExecModel(cfg, available);

	// An unset llm_model legitimately means "let pi pick". But a model that was
	// asked for and did not match is almost always a typo, and silently falling
	// back to pi's default sends the request to some other model — which comes
	// back as an opaque 403/404 from that provider instead of naming the real
	// problem. Say which name failed and what is actually selectable.
	if (!model && cfg.llmModel.trim()) {
		const catalog =
			available.length > 0
				? available.map((m) => `${m.provider}/${m.id}`).join(", ")
				: "(none — no provider in ~/.para/agent/models.json has a usable credential)";
		return {
			ok: false,
			code: "model_not_found",
			reply: "",
			session_id: null,
			steps: [],
			step_count: 0,
			busy: false,
			error: `llm_model "${cfg.llmModel.trim()}" matched no available model. Run \`para models\` to list them. Available: ${catalog}`,
		};
	}

	const thinkingLevel =
		cfg.anthropicThinkingBudget && cfg.anthropicThinkingBudget >= 8192
			? "high"
			: cfg.anthropicThinkingBudget && cfg.anthropicThinkingBudget >= 1024
				? "medium"
				: undefined;

	// Without --session-id or --continue, stay in memory: exec is a one-shot by
	// default and should not litter ~/.para/agent/sessions with a file per
	// invocation. With either, resolve to a file on disk so history carries over.
	let sessionManager: SessionManager;
	let resumed: ExecResult["session_resumed"];
	if (!options.sessionId && !options.continueRecent) {
		sessionManager = SessionManager.inMemory(cwd);
	} else {
		const sessionDir = defaultSessionDir(agentDir, cwd);
		const existing = options.sessionId
			? findSessionFile(sessionDir, options.sessionId)
			: findRecentSessionFile(sessionDir);
		if (existing) {
			sessionManager = SessionManager.open(existing, sessionDir, cwd);
			// Report what we attached to. Ids are caller-chosen, so inheriting a
			// stranger's history is a real possibility; turns=0 would mean the
			// file exists but is empty, which is not worth flagging.
			const turns = sessionManager
				.getEntries()
				.filter((e) => (e as { message?: { role?: string } }).message?.role === "user").length;
			if (turns > 0) {
				resumed = {
					created: sessionManager.getHeader()?.timestamp ?? "unknown",
					turns,
				};
			}
		} else {
			sessionManager = SessionManager.create(
				cwd,
				sessionDir,
				options.sessionId ? { id: options.sessionId } : undefined,
			);
		}
	}

	const { session } = await createAgentSession({
		cwd,
		resourceLoader,
		sessionManager,
		modelRuntime,
		noTools: "builtin",
		...(model ? { model } : {}),
		...(thinkingLevel ? { thinkingLevel } : {}),
	});

	const steps: Array<Record<string, unknown>> = [];
	const pendingArgs = new Map<string, unknown>();
	try {
		session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				pendingArgs.set(event.toolCallId, event.args);
				return;
			}
			if (event.type === "tool_execution_end") {
				if (steps.length >= 40) return;
				steps.push({
					tool: event.toolName,
					is_error: event.isError,
					args: preview(pendingArgs.get(event.toolCallId) ?? {}),
					result: preview(event.result),
				});
				pendingArgs.delete(event.toolCallId);
			}
		});
		await session.prompt(trimmed);
		const messages = session.messages as unknown[];
		const reply = lastAssistantReply(messages);
		const llmError = lastAssistantError(messages);
		if (llmError) {
			return {
				ok: false,
				code: "error",
				reply,
				session_id: session.sessionId,
			...(resumed ? { session_resumed: resumed } : {}),
				...(resumed ? { session_resumed: resumed } : {}),
				steps,
				step_count: steps.length,
				busy: false,
				error: llmError,
			};
		}
		return {
			ok: true,
			code: "ok",
			reply,
			session_id: session.sessionId,
			...(resumed ? { session_resumed: resumed } : {}),
			steps,
			step_count: steps.length,
			busy: false,
			error: null,
		};
	} catch (e) {
		return {
			ok: false,
			code: "error",
			reply: lastAssistantReply(session.messages as unknown[]),
			session_id: session.sessionId,
			steps,
			step_count: steps.length,
			busy: false,
			error: e instanceof Error ? e.message : String(e),
		};
	} finally {
		session.dispose();
	}
}

export function execExitCode(result: { ok: boolean; code: string }): number {
	if (result.ok) return 0;
	if (result.code === "device_unavailable" || result.code === "busy") return 1;
	if (result.code === "config_error" || result.code === "session_not_found") return 2;
	return 3;
}
