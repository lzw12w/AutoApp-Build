/**
 * Single-result payload compaction. Ported from
 * ios_inspector_agent/agent/payload_compactor.py.
 *
 * Distinct from Layer 1 (cross-turn view_hierarchy elision) and from pi's
 * LLM summary: this runs at ingest, on one tool result, before it is stored.
 *
 * Always emits valid JSON. Never mid-string truncates.
 * FULL_DUMP_TOOLS (view_hierarchy / view_inspect / find_view) are minified
 * only — the user asked for the tree. Everything else over COMPACT_LIMIT is
 * replaced with a structural summary that keeps drill-down handles.
 */
export const COMPACT_LIMIT = 16000;

export const FULL_DUMP_TOOLS: ReadonlySet<string> = new Set([
	"view_hierarchy",
	"view_inspect",
	"find_view",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function minify(value: unknown): string {
	return JSON.stringify(value);
}

/**
 * Minify, and if still over budget, degrade non-full-dump payloads.
 * Returns a JSON string.
 */
export function compactPayload(payload: unknown, toolName?: string): string {
	const s = minify(payload);
	if (toolName && FULL_DUMP_TOOLS.has(toolName)) return s;
	if (s.length <= COMPACT_LIMIT) return s;
	if (toolName === "tap_with_diff" && isRecord(payload)) {
		const slimmed = slimTapWithDiff(payload, s.length);
		if (slimmed !== null) return minify(slimmed);
	}
	return minify(summarizeOversized(payload, s.length));
}

const TAP_DIFF_KEEP_FIELDS = [
	"path",
	"class",
	"address",
	"text",
	"text_source",
	"aid",
	"accessibility_label",
	"property_name",
	"image_symbol_name",
	"image_asset_name",
] as const;

const TAP_DIFF_DROP_FIELDS = new Set([
	"frame",
	"hidden",
	"alpha",
	"on_screen",
	"has_image",
	"content_mode",
]);

function slimTapWithDiff(payload: Record<string, unknown>, originalLen: number): Record<string, unknown> | null {
	const data = isRecord(payload.data) ? payload.data : null;
	if (data === null) return null;
	const viewDiff = isRecord(data.view_diff) ? data.view_diff : null;
	if (viewDiff === null) return null;
	const rawDiff = isRecord(viewDiff.diff) ? viewDiff.diff : null;
	if (rawDiff === null) return null;

	const slimSummary = (node: unknown): unknown => {
		if (!isRecord(node)) return node;
		const out: Record<string, unknown> = {};
		for (const key of TAP_DIFF_KEEP_FIELDS) {
			if (key in node) out[key] = node[key];
		}
		return out;
	};

	const slimChanged = (entry: unknown): unknown => {
		if (!isRecord(entry)) return entry;
		const out: Record<string, unknown> = {};
		if (isRecord(entry.before)) out.before = slimSummary(entry.before);
		if (isRecord(entry.after)) out.after = slimSummary(entry.after);
		if (isRecord(entry.fields)) {
			const kept = Object.fromEntries(Object.entries(entry.fields).filter(([k]) => !TAP_DIFF_DROP_FIELDS.has(k)));
			out.fields = Object.keys(kept).length > 0 ? kept : entry.fields;
		}
		return out;
	};

	const added = Array.isArray(rawDiff.added) ? rawDiff.added.filter(isRecord).map(slimSummary) : [];
	const removed = Array.isArray(rawDiff.removed) ? rawDiff.removed.filter(isRecord).map(slimSummary) : [];
	const changed = Array.isArray(rawDiff.changed) ? rawDiff.changed.filter(isRecord).map(slimChanged) : [];

	const slimDiff: Record<string, unknown> = {
		added_count: rawDiff.added_count ?? 0,
		removed_count: rawDiff.removed_count ?? 0,
		changed_count: rawDiff.changed_count ?? 0,
		unchanged_count: rawDiff.unchanged_count ?? 0,
		added,
		removed,
		changed,
	};
	if (rawDiff.omitted_for_display !== undefined) slimDiff.omitted_for_display = rawDiff.omitted_for_display;

	const slimViewDiff: Record<string, unknown> = {};
	for (const key of [
		"kind",
		"ok",
		"changed",
		"summary",
		"before_nodes",
		"after_nodes",
		"polls",
		"settled_after_ms",
		"stable",
	] as const) {
		if (key in viewDiff) slimViewDiff[key] = viewDiff[key];
	}
	slimViewDiff.diff = slimDiff;
	slimViewDiff._slimmed_for_size =
		`payload ${originalLen} bytes exceeded ${COMPACT_LIMIT}; ` +
		"diff entries had frame/hidden/alpha/on_screen/has_image/" +
		"content_mode stripped to fit. Counts are still exact; do NOT " +
		"re-call tap_with_diff -- the tap already happened.";

	const slimData = { ...data, view_diff: slimViewDiff };
	const slimPayload: Record<string, unknown> = {};
	if ("ok" in payload) slimPayload.ok = payload.ok;
	if ("duration_ms" in payload) slimPayload.duration_ms = payload.duration_ms;
	slimPayload.data = slimData;

	let s = minify(slimPayload);
	if (s.length <= COMPACT_LIMIT) return slimPayload;

	for (const key of ["added", "removed", "changed"] as const) {
		while (true) {
			const list = slimDiff[key];
			if (!Array.isArray(list) || list.length === 0 || s.length <= COMPACT_LIMIT) break;
			slimDiff[key] = list.slice(0, Math.max(0, Math.floor(list.length / 2)));
			s = minify(slimPayload);
		}
		if (s.length <= COMPACT_LIMIT) return slimPayload;
	}
	return slimPayload;
}

export function summarizeOversized(payload: unknown, originalLen: number): unknown {
	const reason = `payload ${originalLen} bytes exceeds ${COMPACT_LIMIT}`;

	if (isRecord(payload)) {
		const tree = isRecord(payload.tree) ? payload.tree : null;
		const looksLikeView =
			tree !== null || "_meta" in payload || Array.isArray(payload.children);
		if (looksLikeView) {
			const root = tree ?? payload;
			return {
				_truncated: true,
				_reason: reason,
				_meta: payload._meta ?? null,
				ok: payload.ok,
				skeleton: skeleton(root, 2),
				hint: "tree was too large; call view_hierarchy(address=...) to drill into a subtree",
			};
		}
		return {
			_truncated: true,
			_reason: reason,
			keys: Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, describe(v)])),
		};
	}

	if (Array.isArray(payload)) {
		return {
			_truncated: true,
			_reason: `list of ${payload.length} items, ${originalLen} bytes`,
			head: payload.slice(0, 5),
			tail_count: Math.max(0, payload.length - 5),
		};
	}

	return {
		_truncated: true,
		_reason: `scalar payload ${originalLen} bytes`,
		preview: String(payload).slice(0, 500),
	};
}

function skeleton(node: unknown, depth: number): unknown {
	if (!isRecord(node)) return node;
	const out: Record<string, unknown> = {};
	for (const key of ["class", "address", "frame", "text", "aid", "chain"] as const) {
		if (key in node) out[key] = node[key];
	}
	const children = node.children;
	if (depth > 0 && Array.isArray(children)) {
		out.children = children.slice(0, 10).map((c) => skeleton(c, depth - 1));
		if (children.length > 10) out.children_truncated = children.length - 10;
	} else if (Array.isArray(children) && children.length > 0) {
		out.children_count = children.length;
	}
	return out;
}

function describe(v: unknown): unknown {
	if (typeof v === "string") return `<str len=${v.length}>`;
	if (Array.isArray(v)) return `<list len=${v.length}>`;
	if (isRecord(v)) return `<dict keys=${Object.keys(v).length}>`;
	return v;
}

export interface TextOrImage {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

/**
 * Compact the text blocks of a pi tool result. Images are left intact.
 * Returns a new content array when something shrank, otherwise the original.
 */
export function compactToolResultContent<T extends TextOrImage>(toolName: string, content: T[]): T[] {
	let changed = false;
	const next = content.map((block) => {
		if (block.type !== "text" || typeof block.text !== "string") return block;
		const original = block.text;
		let replacement: string;
		try {
			const parsed: unknown = JSON.parse(original);
			replacement = compactPayload(parsed, toolName);
		} catch {
			if (original.length <= COMPACT_LIMIT) return block;
			replacement = `${original.slice(0, COMPACT_LIMIT)}\n…[truncated ${original.length - COMPACT_LIMIT} chars; call the tool again if you need the rest]`;
		}
		if (replacement.length >= original.length) return block;
		changed = true;
		return { ...block, text: replacement };
	});
	return changed ? next : content;
}
