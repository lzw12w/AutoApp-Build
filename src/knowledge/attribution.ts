/**
 * Content-blind action identity, ported from the `identity_param_keys` /
 * `_identity_params` logic in ios_inspector_agent/actions/*.py.
 *
 * The observer attributes a page transition to the action that caused it. To
 * avoid splitting one logical edge into N (e.g. "tap Feed cell #1" vs "#7"),
 * only STRUCTURAL params participate in edge identity — content (address, x/y,
 * text) is preserved for human inspection but excluded from the dedup key.
 *
 *   tap / long_press / swipe / open_url / back / dismiss / set_lane → {} (a tap is a tap)
 *   scroll                → { axis, direction }  (axis+sign, not pixel delta)
 *   input_text            → { submit, clear }
 *   switch_tab            → { index }
 */

export function identityForAction(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
	switch (toolName) {
		case "scroll": {
			const dx = num(input.dx);
			const dy = num(input.dy);
			if (Math.abs(dy) >= Math.abs(dx)) {
				return { axis: "y", direction: sign(dy) };
			}
			return { axis: "x", direction: sign(dx) };
		}
		case "swipe": {
			// Swipe's structural identity is also axis+direction, derived from
			// whichever delta dominates (dx/dy) or from start/end coordinates.
			const dx = num(input.dx) || num(input.end_x) - num(input.start_x);
			const dy = num(input.dy) || num(input.end_y) - num(input.start_y);
			if (Math.abs(dy) >= Math.abs(dx)) return { axis: "y", direction: sign(dy) };
			return { axis: "x", direction: sign(dx) };
		}
		case "input_text":
			return pick(input, ["submit", "clear"]);
		case "switch_tab":
			return pick(input, ["index"]);
		default:
			// tap, tap_with_diff, long_press, open_url, back, dismiss, set_lane, appoint_feed_story
			return {};
	}
}

function pick(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of keys) {
		const v = input[k];
		if (v !== undefined && v !== null && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
			out[k] = v;
		}
	}
	return out;
}

/** Shallow, JSON-safe copy of tool input for the human-visible params record. */
export function safeParams(input: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(input)) {
		if (v === null || v === undefined) continue;
		if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || Array.isArray(v) || typeof v === "object") {
			out[k] = v;
		}
	}
	return out;
}

function num(v: unknown): number {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
}

function sign(v: number): number {
	return v > 0 ? 1 : v < 0 ? -1 : 0;
}
