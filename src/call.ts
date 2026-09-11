/**
 * `para call <tool>` — invoke one tool directly, without an LLM.
 *
 * `para exec` hands a task to Para's own agent, which decides which tools to
 * use. This is the other end: the caller already knows what it wants, so it
 * pays for no model tokens and no agent turn. Written for another agent
 * driving Para over the CLI, and for debugging a tool in isolation.
 *
 * Every registered tool is reachable, not a hand-picked subset — the caller is
 * in a better position than we are to decide which one fits. The one exception
 * is `switch_mode`, which mutates per-session agent state that a one-shot
 * process does not have.
 *
 * Two things this must not lose relative to the agent path:
 *
 *   1. Knowledge growth. index.ts records page transitions from pi's
 *      tool_call / tool_result events; nothing here goes through pi, so the
 *      before/after snapshots are replayed explicitly around mutating tools.
 *      Skipping this would leave the graph frozen while a caller drives the
 *      app entirely over `call`, and `navigate_to_page` would later fail to
 *      plan a route through screens it never learned.
 *   2. Failure shape. Same JSON envelope and same exit codes as `exec`, so a
 *      caller can branch on `ok` / `code` without special-casing.
 */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { InspectorClient } from "./client.ts";
import type { ParaConfig } from "./config.ts";
import { applyConfigToEnv, syncInspectorEnv } from "./config.ts";
import { resolveIntoConfig } from "./ios-runtime/device-registry.ts";
import { KnowledgeObserver } from "./knowledge/observer.ts";
import { KnowledgeStore } from "./knowledge/store.ts";
import { resolveBundleId } from "./knowledge/bundle.ts";
import { identityForAction, safeParams } from "./knowledge/attribution.ts";
import { buildTools } from "./tools/index.ts";
import { buildKnowledgeTools, type KnowledgeContext } from "./tools/knowledge.ts";
import { recordKnowledgeTool } from "./tools/note.ts";
import { contentLooksFailed } from "./tools/result.ts";

/**
 * Tools whose result reflects a changed screen, so the knowledge graph wants a
 * before/after pair around them. Mirrors MUTATING_TOOL_NAMES in index.ts.
 */
const MUTATING = new Set([
	"tap_with_diff",
	"long_press",
	"scroll",
	"swipe",
	"input_text",
	"dismiss",
	"back",
	"switch_tab",
	"open_url",
	"set_lane",
	"appoint_feed_story",
]);

/**
 * Tools that only mean something inside a live agent session:
 *   switch_mode — changes the permission mode for the rest of the session
 *   todo_write  — maintains that session's task list
 * A `call` process exits immediately, so there is no session for either to act
 * on. Offering them would imply a guarantee we cannot keep. Both remain fully
 * available through `para exec`.
 */
const NOT_CALLABLE = new Set(["switch_mode", "todo_write"]);

export interface CallResult {
	ok: boolean;
	code: string;
	tool: string;
	params: Record<string, unknown>;
	result: unknown;
	error: string | null;
}

export interface ToolSpec {
	name: string;
	label: string;
	description: string;
	params: Array<{
		name: string;
		type: string;
		required: boolean;
		description?: string;
		enum?: string[];
	}>;
}

type AnyTool = {
	name: string;
	label: string;
	description: string;
	parameters: { properties?: Record<string, unknown>; required?: string[] };
	execute: (
		id: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: undefined,
	) => Promise<AgentToolResult<unknown>>;
};

/**
 * Every callable tool, with knowledge hooks attached when knowledge is on.
 *
 * Deliberately close to index.ts's registration block: the same client, the
 * same hooks, the same knowledge tools. A caller reaching a tool through
 * `call` should get the behaviour it would get through the agent.
 */
async function collectTools(
	cfg: ParaConfig,
	client: InspectorClient,
): Promise<{
	tools: AnyTool[];
	getObserver: () => Promise<KnowledgeObserver>;
	snapshot: (postAction?: boolean) => Promise<void>;
}> {
	let observer: KnowledgeObserver | null = null;
	let store: KnowledgeStore | null = null;

	async function ensureObserver(): Promise<KnowledgeObserver> {
		if (observer) return observer;
		const bundle = await resolveBundleId(client, cfg.bundleId);
		store = KnowledgeStore.forApp(bundle, cfg.knowledgeDir);
		observer = new KnowledgeObserver(store);
		return observer;
	}

	/** Fetch the live screen and feed it to the observer. */
	async function snapshot(postAction = false): Promise<void> {
		const obs = await ensureObserver();
		const [view, vc] = await Promise.all([
			client.viewHierarchy({ depth: 8, onScreenOnly: true }),
			client.vcHierarchy().catch(() => null),
		]);
		obs.observe(view, vc, { postAction });
	}

	const tools: AnyTool[] = [];
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
		tools.push(tool as unknown as AnyTool);
	}

	// record_knowledge writes to a file, so it works standalone. notePath is
	// optional in config; the tool's own default applies when it is unset.
	if (cfg.notePath) tools.push(recordKnowledgeTool(cfg.notePath) as unknown as AnyTool);

	if (!cfg.disableKnowledge) {
		const kc: KnowledgeContext = {
			client,
			snapshotNow: async () => {
				const obs = await ensureObserver();
				const [view, vc] = await Promise.all([
					client.viewHierarchy({ depth: 8, onScreenOnly: true }),
					client.vcHierarchy().catch(() => null),
				]);
				obs.observe(view, vc, { postAction: false });
				if (!store) throw new Error("knowledge store not initialised");
				return { store, observer: obs };
			},
		};
		for (const tool of buildKnowledgeTools(kc)) {
			tools.push(tool as unknown as AnyTool);
		}
	}

	return {
		tools: tools.filter((t) => !NOT_CALLABLE.has(t.name)),
		// The observer is created lazily on first use, so hand back the getter
		// rather than the (still null) value. A transition is only committed
		// when the pre-action snapshot, the action, and the post-action
		// snapshot all land on ONE instance — currentPageId lives there, and a
		// fresh instance would have no origin page to draw the edge from.
		getObserver: ensureObserver,
		snapshot,
	};
}

/** JSON Schema type of one property, flattened for display. */
function schemaType(prop: unknown): { type: string; enum?: string[]; description?: string } {
	const p = (prop ?? {}) as Record<string, unknown>;
	const description = typeof p.description === "string" ? p.description : undefined;
	if (Array.isArray(p.enum)) {
		return { type: "enum", enum: p.enum.map(String), ...(description ? { description } : {}) };
	}
	// TypeBox unions surface as anyOf; show the member types rather than "?".
	if (Array.isArray(p.anyOf)) {
		// Dedupe: TypeBox renders Union([String, Literal("x")]) as two string
		// members, which would print as "string|string".
		const inner = [
			...new Set(
				p.anyOf
					.map((m) => (m as Record<string, unknown>).type)
					.filter((t): t is string => typeof t === "string"),
			),
		];
		return { type: inner.length ? inner.join("|") : "any", ...(description ? { description } : {}) };
	}
	const type = typeof p.type === "string" ? p.type : "any";
	return { type, ...(description ? { description } : {}) };
}

/** Describe tools for `--list` / `--help`, straight from their schemas. */
export async function listCallableTools(cfg: ParaConfig): Promise<ToolSpec[]> {
	const client = new InspectorClient({
		host: cfg.inspectorHost,
		port: cfg.inspectorPort,
		device: cfg.inspectorDevice,
		platform: cfg.inspectorPlatform === "auto" ? undefined : cfg.inspectorPlatform,
		remotePort: cfg.inspectorRemotePort,
	});
	const { tools } = await collectTools(cfg, client);
	return tools.map((t) => {
		const props = t.parameters.properties ?? {};
		const required = new Set(t.parameters.required ?? []);
		return {
			name: t.name,
			label: t.label,
			description: t.description,
			params: Object.entries(props).map(([name, prop]) => {
				const { type, enum: choices, description } = schemaType(prop);
				return {
					name,
					type,
					required: required.has(name),
					...(description ? { description } : {}),
					...(choices ? { enum: choices } : {}),
				};
			}),
		};
	});
}

/**
 * Coerce CLI strings to the types the schema asks for.
 *
 * Flags arrive as strings; a schema wanting `number` would reject "3". Only
 * the shapes a flag can express are handled — anything structured belongs in
 * `--json`, which skips this path entirely.
 */
export function coerceParams(
	raw: Record<string, string | boolean>,
	schema: { properties?: Record<string, unknown> },
): Record<string, unknown> {
	const props = schema.properties ?? {};
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		const spec = schemaType(props[key]);
		if (typeof value === "boolean") {
			out[key] = value;
			continue;
		}
		if (spec.type.includes("number") || spec.type.includes("integer")) {
			const n = Number(value);
			if (Number.isNaN(n)) throw new Error(`--${key} expects a number, got "${value}"`);
			out[key] = n;
			continue;
		}
		if (spec.type.includes("boolean")) {
			out[key] = value !== "false";
			continue;
		}
		if (spec.type.includes("array")) {
			// Comma-separated is the only array form a flag can carry.
			out[key] = value.split(",").map((s) => s.trim()).filter(Boolean);
			continue;
		}
		out[key] = value;
	}
	return out;
}

export async function runCall(
	cfg: ParaConfig,
	toolName: string,
	params: Record<string, unknown>,
): Promise<CallResult> {
	const base = { tool: toolName, params };

	if (NOT_CALLABLE.has(toolName)) {
		return {
			ok: false,
			code: "tool_not_callable",
			...base,
			result: null,
			error: `"${toolName}" changes agent state for the rest of a session, which a one-shot call does not have. Use \`para exec\` if you need it.`,
		};
	}

	const deviceError = await resolveIntoConfig(cfg, { missingOk: !cfg.inspectorDevice.trim() });
	if (deviceError) {
		return { ok: false, code: "device_unavailable", ...base, result: null, error: deviceError };
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

	const { tools, snapshot, getObserver } = await collectTools(cfg, client);
	const tool = tools.find((t) => t.name === toolName);
	if (!tool) {
		const names = tools.map((t) => t.name).sort().join(", ");
		return {
			ok: false,
			code: "tool_not_found",
			...base,
			result: null,
			error: `unknown tool "${toolName}". Available: ${names}`,
		};
	}

	const mutating = !cfg.disableKnowledge && MUTATING.has(toolName);
	if (mutating) {
		// The graph records an edge as (page before) → action → (page after).
		// Without this leading snapshot the action has no origin and the edge
		// is dropped, which is exactly the silent knowledge loss this file
		// exists to prevent.
		try {
			await snapshot(false);
			const obs = await getObserver();
			obs.recordAction(
				toolName === "tap_with_diff" ? "tap" : toolName,
				safeParams(params),
				identityForAction(toolName === "tap_with_diff" ? "tap" : toolName, params),
			);
		} catch {
			// Attribution is best-effort in the agent path too; never block.
		}
	}

	let result: AgentToolResult<unknown>;
	try {
		result = await tool.execute(`call-${Date.now()}`, params, undefined, undefined, undefined);
	} catch (e) {
		return {
			ok: false,
			code: "tool_error",
			...base,
			result: null,
			error: e instanceof Error ? e.message : String(e),
		};
	}

	// pi's AgentToolResult has no isError; Para encodes recoverable failures as
	// {ok:false} JSON content (see tools/result.ts), which is also what the
	// agent path inspects before recording a transition.
	const failed = contentLooksFailed(result.content as { type: string; text?: string }[]);
	if (mutating && !failed) {
		try {
			await snapshot(true);
		} catch {
			// A snapshot failure must not turn a successful action into one.
		}
	}

	return {
		ok: !failed,
		code: failed ? "tool_error" : "ok",
		...base,
		result: resultPayload(result),
		error: failed ? textOf(result.content) : null,
	};
}

/**
 * The data a caller actually wants.
 *
 * Tools put their payload in `content` as text — JSON for most, plain prose for
 * screen_digest — while `details` carries only render/log hints such as
 * `{ok:true}`. So content is the source, parsed back to an object when it is
 * JSON so the caller can pipe it into jq without unwrapping a string. The
 * ok/data envelope is stripped here since the outer result already reports ok.
 */
function resultPayload(result: AgentToolResult<unknown>): unknown {
	const text = textOf(result.content);
	if (text) {
		const trimmed = text.trim();
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			try {
				const parsed = JSON.parse(trimmed) as unknown;
				if (parsed && typeof parsed === "object" && "data" in (parsed as Record<string, unknown>)) {
					return (parsed as Record<string, unknown>).data;
				}
				return parsed;
			} catch {
				// Not JSON after all; fall through to the raw text.
			}
		}
		return text;
	}
	// Image-only results (screenshot) carry no text; hand back the blocks.
	return result.content ?? result.details ?? null;
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return String(content ?? "");
	return content
		.map((c) => (c as { text?: string }).text ?? "")
		.filter(Boolean)
		.join("\n");
}
