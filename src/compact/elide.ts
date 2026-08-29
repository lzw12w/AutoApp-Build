/**
 * Layer 1 — view_hierarchy elision.
 *
 * Every LLM call: keep the most recent N `view_hierarchy` tool results
 * verbatim in the *view sent to the model*; rewrite older ones to a compact
 * `_elided` summary. The session store is untouched (pi's `context` hook
 * returns a rewritten copy).
 *
 * Window is counted among view_hierarchy calls only — a burst of tap/scroll
 * between snapshots must not push a snapshot out of the recent set.
 * Non-vh results are never rewritten. A result is rewritten only when the
 * summary is strictly smaller (small error payloads stay verbatim).
 *
 * Ported from ios_inspector_agent/llm/anthropic_client.py::elide_old_view_hierarchies
 * and loop._vh_elision_summary, adapted to pi's AgentMessage shape
 * (assistant toolCall blocks + standalone toolResult messages).
 */

export const DEFAULT_ELIDE_KEEP_RECENT = 2;

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isToolCall(v: unknown): v is { type: "toolCall"; id: string; name: string } {
	return isRecord(v) && v.type === "toolCall" && typeof v.id === "string" && typeof v.name === "string";
}

function isTextBlock(v: unknown): v is { type: "text"; text: string } {
	return isRecord(v) && v.type === "text" && typeof v.text === "string";
}

function contentText(content: unknown[]): string {
	return content.filter(isTextBlock).map((b) => b.text).join("");
}

function contentLen(content: unknown[]): number {
	return contentText(content).length;
}

/** Compact `_elided` stand-in for an old view_hierarchy result. */
export function vhElisionSummary(original: string): string {
	const summary: Record<string, unknown> = { _elided: "view_hierarchy" };
	let data: unknown = original;
	try {
		data = JSON.parse(original);
	} catch {
		data = null;
	}
	// Para tools wrap the tree as `{ ok, data }`; Python stored the tree at top level.
	const root = isRecord(data) && isRecord(data.data) ? data.data : data;
	const envelope = isRecord(data) ? data : null;
	if (envelope && "ok" in envelope) summary.ok = envelope.ok;
	const meta = isRecord(root) && isRecord(root._meta) ? root._meta : isRecord(envelope) && isRecord(envelope._meta) ? envelope._meta : null;
	if (meta) {
		for (const k of [
			"total_nodes",
			"window_class",
			"is_key_window",
			"contains_presented_sheet",
			"presented_view_count",
			"offscreen_child_count",
		]) {
			if (k in meta) summary[k] = meta[k];
		}
	}
	if (isRecord(root)) {
		for (const k of ["class", "address"] as const) {
			if (k in root) summary[k] = root[k];
		}
	}
	summary._hint =
		"earlier view_hierarchy snapshot elided to save tokens; call view_hierarchy again if details are needed";
	return JSON.stringify(summary);
}

export interface ElideOptions {
	keepRecent?: number;
	summarize?: (original: string) => string;
}

/**
 * Copy-on-write: returns the same array reference when nothing shrank.
 */
export function elideOldViewHierarchies<T>(messages: T[], options: ElideOptions = {}): T[] {
	const keepRecent = options.keepRecent ?? DEFAULT_ELIDE_KEEP_RECENT;
	const summarize = options.summarize ?? vhElisionSummary;

	const vhIds: string[] = [];
	for (const raw of messages) {
		if (!isRecord(raw) || raw.role !== "assistant") continue;
		const content = Array.isArray(raw.content) ? raw.content : [];
		for (const block of content) {
			if (isToolCall(block) && block.name === "view_hierarchy") vhIds.push(block.id);
		}
	}
	if (vhIds.length <= keepRecent) return messages;
	const elideIds = new Set(keepRecent > 0 ? vhIds.slice(0, -keepRecent) : vhIds);

	let changed = false;
	const out = messages.map((raw) => {
		if (!isRecord(raw) || raw.role !== "toolResult") return raw;
		if (raw.toolName !== "view_hierarchy") return raw;
		if (typeof raw.toolCallId !== "string" || !elideIds.has(raw.toolCallId)) return raw;
		const content = Array.isArray(raw.content) ? raw.content : [];
		const original = contentText(content);
		if (!original) return raw;
		const summary = summarize(original);
		if (summary.length >= contentLen(content)) return raw;
		changed = true;
		return { ...raw, content: [{ type: "text", text: summary }] } as T;
	});
	return changed ? out : messages;
}
