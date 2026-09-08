/**
 * Post-action verification probes. Ported 1:1 from
 * ios_inspector_agent/actions/post_check.py.
 *
 * Each probe returns a plain dict with a common envelope
 * `{kind, ok, changed, summary, polls, settled_after_ms, ...}`. `Cancelled`
 * (AbortSignal) escapes rather than folding into a probe-failure dict; any
 * other error is captured as `ok:false`.
 *
 * Bounded settle-window polling lives in ./poll.ts (pollUntil / _poll_until).
 */
import type { InspectorClient } from "../client.ts";
import { Cancelled } from "../errors.ts";
import type { VCNode } from "../models.ts";
import { vcSummary } from "./format.ts";
import { intEnv, pollIntervalMs, pollUntil, settleVcDiffMs } from "./poll.ts";

export const DEFAULT_SETTLE_TEXT_VALUE_MS = 100;

export function settleTextValueMs(): number {
	return Math.max(0, intEnv("INSPECTOR_SETTLE_TEXT_VALUE_MS", DEFAULT_SETTLE_TEXT_VALUE_MS));
}

/** post_check.skipped — no probe was applicable. */
export function skipped(reason: string): Record<string, unknown> {
	return {
		kind: "skipped",
		ok: true,
		changed: false,
		summary: `post_check skipped: ${reason}`,
		reason,
		polls: 0,
		settled_after_ms: 0,
	};
}

type Summary = Record<string, unknown> | null;

/**
 * Walk the vc_summary DICT to the on-screen label, mirroring Python
 * `_top_vc_label`: presented → selected_view_controller → children[-1] →
 * `class` || "UnknownVC"; a non-dict summary is "unknown".
 */
function topVcLabel(summary: unknown): string {
	if (!summary || typeof summary !== "object" || Array.isArray(summary)) return "unknown";
	const s = summary as Record<string, unknown>;
	const presented = s.presented;
	if (presented && typeof presented === "object" && !Array.isArray(presented)) {
		return topVcLabel(presented);
	}
	const selected = s.selected_view_controller;
	if (selected && typeof selected === "object" && !Array.isArray(selected)) {
		return topVcLabel(selected);
	}
	const children = s.children;
	if (Array.isArray(children) && children.length > 0) {
		return topVcLabel(children[children.length - 1]);
	}
	return (s.class as string) || "UnknownVC";
}

/** Snapshot the vc_summary dict for the current screen (null if unavailable). */
export async function vcSummaryNow(client: InspectorClient, signal?: AbortSignal): Promise<Summary> {
	try {
		const vc = await client.vcHierarchy(signal);
		return vcSummary(vc);
	} catch (e) {
		if (e instanceof Cancelled) throw e;
		return null;
	}
}

/**
 * vc_diff — poll the VC tree until its summary differs from `before`, or the
 * settle window elapses. `before` is the vc_summary dict captured before the
 * action (see vcSummaryNow); pass null if it could not be captured.
 */
export async function vcDiff(
	client: InspectorClient,
	before: Summary,
	opts: { settleMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<Record<string, unknown>> {
	const settleMs = opts.settleMs ?? settleVcDiffMs();
	const pollMs = opts.pollMs ?? pollIntervalMs();
	const beforeKey = JSON.stringify(before);
	try {
		const { value: after, polls, elapsedMs } = await pollUntil(
			() => vcSummaryNow(client, opts.signal),
			(summary) => JSON.stringify(summary) !== beforeKey,
			{ settleMs, pollMs, signal: opts.signal },
		);
		const changed = JSON.stringify(after) !== beforeKey;
		const fromVc = topVcLabel(before);
		const toVc = topVcLabel(after);
		return {
			kind: "vc_diff",
			ok: true,
			changed,
			summary: changed ? `VC changed: ${fromVc} → ${toVc}` : `VC unchanged (${toVc})`,
			from_vc: fromVc,
			to_vc: toVc,
			polls,
			settled_after_ms: elapsedMs,
		};
	} catch (e) {
		if (e instanceof Cancelled) throw e;
		return {
			kind: "vc_diff",
			ok: false,
			changed: false,
			summary: `vc_diff probe failed: ${e instanceof Error ? e.message : String(e)}`,
			polls: 0,
			settled_after_ms: 0,
		};
	}
}

/**
 * text_value — poll a specific address until it reports a non-empty text/value.
 * Used to confirm an input_text landed. `address` empty → skipped.
 */
export async function textValue(
	client: InspectorClient,
	address: string | undefined | null,
	opts: { settleMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<Record<string, unknown>> {
	if (!address) return skipped("no address to probe");
	const settleMs = opts.settleMs ?? settleTextValueMs();
	const pollMs = opts.pollMs ?? pollIntervalMs();
	const state = { nonDict: false, value: null as string | null };
	const sample = async (): Promise<string | null> => {
		const raw = await client.viewInspect(address, opts.signal);
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			state.nonDict = true;
			return null;
		}
		state.nonDict = false;
		const rec = raw as Record<string, unknown>;
		const v = rec.text ?? rec.value;
		state.value = typeof v === "string" ? v : null;
		return state.value;
	};
	const isDone = (v: string | null): boolean => typeof v === "string" && v.length > 0;
	try {
		const { value, polls, elapsedMs } = await pollUntil(sample, isDone, { settleMs, pollMs, signal: opts.signal });
		if (state.nonDict) {
			return {
				kind: "text_value",
				ok: false,
				changed: false,
				summary: "view_inspect returned non-dict",
				address,
				polls,
				settled_after_ms: elapsedMs,
			};
		}
		const hasText = typeof value === "string" && value.length > 0;
		return {
			kind: "text_value",
			ok: true,
			changed: hasText,
			summary: hasText ? `value_after=${JSON.stringify(value)}` : `target ${address} has no text after input`,
			address,
			value_after: hasText ? value : null,
			polls,
			settled_after_ms: elapsedMs,
		};
	} catch (e) {
		if (e instanceof Cancelled) throw e;
		return {
			kind: "text_value",
			ok: false,
			changed: false,
			summary: `text_value probe failed: ${e instanceof Error ? e.message : String(e)}`,
			address,
			polls: 0,
			settled_after_ms: 0,
		};
	}
}
