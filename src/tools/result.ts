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
