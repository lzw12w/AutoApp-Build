/**
 * Shared tool-result helpers. Para's ActionResult (ok/data/error) is preserved
 * as structured JSON content returned to the model — pi's AgentToolResult has
 * no isError field, and throwing would collapse the structure to a bare
 * string, so recoverable failures are surfaced as ok:false content instead.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { InspectorError } from "../errors.ts";

export function okResult<T>(data: unknown, details?: T): AgentToolResult<T> {
	return {
		content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }],
		details: (details ?? { ok: true }) as T,
	};
}

/** Plain-text result (e.g. screen_digest) — kept out of JSON so it reads cleanly. */
export function textResult<T>(text: string, details?: T): AgentToolResult<T> {
	return {
		content: [{ type: "text", text }],
		details: (details ?? { ok: true }) as T,
	};
}

export function errResult<T>(e: unknown): AgentToolResult<T> {
	const err = e instanceof InspectorError ? e : new InspectorError(String(e instanceof Error ? e.message : e));
	return {
		content: [
			{ type: "text", text: JSON.stringify({ ok: false, error: { code: err.code, message: err.message, detail: err.detail } }) },
		],
		details: { ok: false, code: err.code, message: err.message } as T,
	};
}

/** Run an async producer, mapping thrown errors to an ok:false result. */
export async function guard<T>(
	fn: () => Promise<unknown>,
	toResult: (data: unknown) => AgentToolResult<T> = (d) => okResult<T>(d),
): Promise<AgentToolResult<T>> {
	try {
		return toResult(await fn());
	} catch (e) {
		return errResult<T>(e);
	}
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Hex address, whether Inspector returned a string or a nested view dict. */
export function inspectorAddress(value: unknown): string | null {
	if (typeof value === "string" && value) return value;
	if (isRecord(value) && typeof value.address === "string" && value.address) return value.address;
	return null;
}

/**
 * Inspector mutating endpoints often 200 with `{success:false, error}` and a
 * full view dump in `target`. Collapse that to a small dict the model can use,
 * and raise so `guard` surfaces ok:false.
 */
export function compactInspectorAction(raw: unknown): Record<string, unknown> {
	if (!isRecord(raw)) return { value: raw };
	if (raw.success === false) {
		throw new InspectorError(String(raw.error ?? "action failed"), "E_ACTION_FAILED", isRecord(raw) ? raw : {});
	}
	const target = raw.target ?? raw.address ?? raw.viewController ?? raw.scrollView;
	const out: Record<string, unknown> = {};
	for (const key of ["success", "timestamp", "animated", "method", "selectedIndex", "mode", "naturalTarget"]) {
		if (raw[key] !== undefined) out[key] = raw[key];
	}
	const addr = inspectorAddress(target);
	if (addr) out.address = addr;
	if (isRecord(target)) {
		if (typeof target.class === "string") out.class = target.class;
		if (typeof target.title === "string" && target.title) out.title = target.title;
	}
	if (raw.gesture !== undefined) out.gesture = raw.gesture;
	if (raw.error) out.error = raw.error;
	return out;
}

/** True when a tool result is a structured Para `{ok:false}` JSON text block. */
export function contentLooksFailed(content: { type: string; text?: string }[] | undefined): boolean {
	if (!content) return false;
	for (const block of content) {
		if (block.type !== "text" || !block.text) continue;
		const trimmed = block.text.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(trimmed) as { ok?: unknown };
			if (parsed && parsed.ok === false) return true;
		} catch {
			// not JSON
		}
	}
	return false;
}
