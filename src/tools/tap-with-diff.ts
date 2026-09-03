/**
 * tap_with_diff — tap plus a two-tier post-check (vc_diff, else view_diff).
 * Ported from ios_inspector_agent/actions/interact.py::TapWithDiffAction.
 *
 * Schema does NOT expose depth / max_entries / settle_ms: those are
 * correctness knobs, not LLM decisions. Past models truncated trees or
 * re-tapped after reading omitted_for_display.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { InspectorClient } from "../client.ts";
import { Cancelled, InspectorError } from "../errors.ts";
import { type VCNode, ViewNode } from "../models.ts";
import {
	ambiguousFindAndTap,
	applyVisibleOnly,
	findNodeByAddress,
	hasFindSelector,
	localFindCandidates,
	rankFindCandidates,
	type FindSelector,
} from "./find.ts";
import { nodeSummary, vcSummary } from "./format.ts";
import { guard, okResult } from "./result.ts";
import { pollIntervalMs, pollUntil, settleVcDiffMs } from "./poll.ts";
import { DIFF_MAX_ENTRIES, diffViewTrees, treeSignature, type ViewDiff } from "./view-diff.ts";
import { reportTapTarget, type TapTargetHook } from "../knowledge/tap-target.ts";

export const DIFF_DEPTH = 40;

type Details = { ok: boolean } & Record<string, unknown>;

function fingerprintVc(vc: VCNode | null): string {
	if (!vc) return "";
	return JSON.stringify(vcSummary(vc));
}

function topVcLabel(vc: VCNode | null): string {
	if (!vc) return "unknown";
	return vc.visibleLeaf().cls || "UnknownVC";
}

async function probeVcDiff(
	client: InspectorClient,
	before: VCNode | null,
	opts: { settleMs: number; pollMs: number; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
	const beforeFp = fingerprintVc(before);
	try {
		const { value: after, polls, elapsedMs } = await pollUntil(
			() => client.vcHierarchy(opts.signal),
			(vc) => fingerprintVc(vc) !== beforeFp,
			opts,
		);
		const changed = fingerprintVc(after) !== beforeFp;
		const fromLabel = topVcLabel(before);
		const toLabel = topVcLabel(after);
		return {
			kind: "vc_diff",
			ok: true,
			changed,
			summary: changed ? `VC changed: ${fromLabel} → ${toLabel}` : `VC unchanged (${toLabel})`,
			from_vc: fromLabel,
			to_vc: toLabel,
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

async function viewDiffAfterAction(
	client: InspectorClient,
	beforeView: ViewNode,
	opts: {
		depth: number;
		includeHidden: boolean;
		onScreenOnly: boolean;
		maxEntries: number;
		settleMs: number;
		pollMs: number;
		stability: boolean;
		signal?: AbortSignal;
	},
): Promise<ViewDiff & { polls: number; settled_after_ms: number; stable: boolean }> {
	const state: {
		lastSignature: string | null;
		lastView: ViewNode | null;
		stable: boolean;
		diff: ViewDiff | null;
	} = { lastSignature: null, lastView: null, stable: false, diff: null };

	const sample = async (): Promise<ViewDiff> => {
		const afterView = await client.viewHierarchy({
			depth: opts.depth,
			includeHidden: opts.includeHidden,
			onScreenOnly: opts.onScreenOnly,
			signal: opts.signal,
		});
		const diff = diffViewTrees(beforeView, afterView, opts.maxEntries);
		const signature = treeSignature(afterView);
		state.stable = state.lastSignature !== null && signature === state.lastSignature;
		state.lastSignature = signature;
		state.lastView = afterView;
		state.diff = diff;
		return diff;
	};

	const isDone = (diff: ViewDiff): boolean => {
		if (!diff.changed) return false;
		return opts.stability ? state.stable : true;
	};

	try {
		const { value: diff, polls, elapsedMs } = await pollUntil(sample, isDone, {
			settleMs: opts.settleMs,
			pollMs: opts.pollMs,
			signal: opts.signal,
		});
		const out = { ...(state.diff ?? diff) } as ViewDiff & {
			polls: number;
			settled_after_ms: number;
			stable: boolean;
		};
		out.polls = polls;
		out.settled_after_ms = elapsedMs;
		out.stable = opts.stability ? state.stable : false;
		if (opts.stability && out.changed && !out.stable) {
			out.summary = `${out.summary} (not stable before deadline)`;
		}
		return out;
	} catch (e) {
		if (e instanceof Cancelled) throw e;
		return {
			kind: "view_hierarchy_diff",
			ok: false,
			changed: false,
			summary: `view_diff probe failed: ${e instanceof Error ? e.message : String(e)}`,
			before_nodes: 0,
			after_nodes: 0,
			diff: {
				added_count: 0,
				removed_count: 0,
				changed_count: 0,
				unchanged_count: 0,
				added: [],
				removed: [],
				changed: [],
				omitted_for_display: {
					added: 0,
					removed: 0,
					changed: 0,
					hint: "",
				},
			},
			polls: 0,
			settled_after_ms: 0,
			stable: false,
		};
	}
}

function postCheckFromViewDiff(viewDiff: {
	ok: boolean;
	changed: boolean;
	summary: string;
	polls: number;
	settled_after_ms: number;
}): Record<string, unknown> {
	return {
		kind: "view_hierarchy_diff",
		ok: Boolean(viewDiff.ok),
		changed: Boolean(viewDiff.changed),
		summary: viewDiff.summary,
		polls: viewDiff.polls,
		settled_after_ms: viewDiff.settled_after_ms,
	};
}

export async function resolveFinderTarget(
	client: InspectorClient,
	beforeView: ViewNode,
	sel: FindSelector,
	index: number | undefined,
	signal?: AbortSignal,
): Promise<ViewNode> {
	let candidates = rankFindCandidates(localFindCandidates(beforeView, sel, true), sel);
	if (candidates.length === 0) {
		try {
			// Mirror Python _view_search_candidates: filter server results to
			// on-screen (fall back to all if none), THEN rank — otherwise an
			// explicit index= picks a different node and ambiguity counts drift.
			const searched = await client.viewSearch(
				{
					text: sel.text,
					cls: sel.cls,
					accessibilityId: sel.accessibilityId,
					propertyName: sel.propertyName,
				},
				signal,
			);
			candidates = rankFindCandidates(applyVisibleOnly(searched, true), sel);
		} catch {
			candidates = [];
		}
	}
	if (candidates.length === 0) {
		throw new InspectorError(
			`no view matched text=${JSON.stringify(sel.text)} aid=${JSON.stringify(sel.accessibilityId)} class=${JSON.stringify(sel.cls)} property_name=${JSON.stringify(sel.propertyName)}`,
			"E_TARGET_NOT_FOUND",
		);
	}
	if (index !== undefined && (index < 0 || index >= candidates.length)) {
		throw new InspectorError(`index=${index} but only ${candidates.length} candidates matched`, "E_INDEX_OUT_OF_RANGE", {
			candidates: candidates.slice(0, 5).map(nodeSummary),
		});
	}
	if (ambiguousFindAndTap(candidates, sel, index)) {
		throw new InspectorError(
			`${candidates.length} candidates matched a weak selector; pass text/accessibility_id/property_name or index`,
			"E_AMBIGUOUS",
			{ candidates: candidates.slice(0, 5).map(nodeSummary) },
		);
	}
	return candidates[index ?? 0]!;
}

export function tapWithDiffTool(client: InspectorClient, hooks: { onTapTarget?: TapTargetHook } = {}) {
	return defineTool({
		name: "tap_with_diff",
		label: "Tap with diff",
		description:
			"Tap a view AND verify the result in one tool call. Replaces the common " +
			"screen_digest/view_hierarchy → tap → view_hierarchy triple when you need to see what changed. " +
			"Provide either `address`, both `x`/`y`, or a finder selector (`text`, `accessibility_id`, `class`, `property_name`). " +
			"Return shape is two-tier (read `post_check.kind` first): " +
			"(1) if the tap navigated (push / present / tab switch), `post_check.kind=\"vc_diff\"` with from_vc → to_vc and " +
			"NO `view_diff` — the after page is a different screen; call screen_digest yourself if you need to plan on it. " +
			"(2) if the VC stayed the same, `post_check.kind=\"view_hierarchy_diff\"` and `view_diff` carries added / removed / " +
			"changed nodes (bounded examples; full counts exact). " +
			"**Mutating**: this FIRES THE TAP. " +
			"`diff.omitted_for_display.{added,removed,changed} > 0` means samples were display-capped (totals are exact); " +
			"it is NOT a failure and MUST NOT be a reason to re-call tap_with_diff — that would tap a second time. " +
			"To inspect an omitted node, use view_inspect(address=) / find_view.",
		parameters: Type.Object({
			address: Type.Optional(Type.String()),
			x: Type.Optional(Type.Number()),
			y: Type.Optional(Type.Number()),
			text: Type.Optional(Type.String()),
			accessibility_id: Type.Optional(Type.String()),
			class: Type.Optional(Type.String()),
			property_name: Type.Optional(Type.String({ description: "Substring match on reflected Swift property name." })),
			index: Type.Optional(Type.Integer({ minimum: 0, description: "Tap the Nth ranked candidate when the selector matches multiple views." })),
			stability: Type.Optional(Type.Boolean({ default: true, description: "Require two consecutive matching after snapshots before early return." })),
		}),
		execute: (_id, params, signal) =>
			guard<Details>(async () => {
				const sel: FindSelector = {
					text: params.text,
					cls: params.class,
					accessibilityId: params.accessibility_id,
					propertyName: params.property_name,
				};
				let address = params.address;
				let x = params.x;
				let y = params.y;
				const hasPoint = x !== undefined && y !== undefined;
				if (!address && !hasPoint && !hasFindSelector(sel)) {
					throw new InspectorError(
						"tap_with_diff requires address, both x/y, or a finder selector",
						"E_INVALID_ARGUMENT",
					);
				}

				const depth = DIFF_DEPTH;
				const includeHidden = false;
				const onScreenOnly = true;
				const settleMs = settleVcDiffMs();
				const pollMs = pollIntervalMs();
				const stability = params.stability ?? true;

				const [beforeView, beforeVc] = await Promise.all([
					client.viewHierarchy({ depth, includeHidden, onScreenOnly, signal }),
					client.vcHierarchy(signal).catch(() => null),
				]);

				let target = findNodeByAddress(beforeView, address);
				if (target === null && address) {
					try {
						target = ViewNode.fromDict(await client.viewInspect(address, signal));
					} catch {
						target = null;
					}
				}

				if (!address && hasFindSelector(sel)) {
					target = await resolveFinderTarget(client, beforeView, sel, params.index, signal);
					address = target.address;
					x = undefined;
					y = undefined;
				}

				const result = await client.tap({ address, x, y, signal });
				reportTapTarget(hooks.onTapTarget, "tap", target, beforeView, { x: params.x, y: params.y });

				const vcProbe = await probeVcDiff(client, beforeVc, { settleMs, pollMs, signal });
				let viewDiff: (ViewDiff & { polls: number; settled_after_ms: number; stable: boolean }) | null = null;
				let postCheck: Record<string, unknown>;
				if (vcProbe.changed) {
					postCheck = vcProbe;
				} else {
					viewDiff = await viewDiffAfterAction(client, beforeView, {
						depth,
						includeHidden,
						onScreenOnly,
						maxEntries: DIFF_MAX_ENTRIES,
						settleMs,
						pollMs,
						stability,
						signal,
					});
					postCheck = postCheckFromViewDiff(viewDiff);
					postCheck.vc_diff = vcProbe;
				}

				const payload: Record<string, unknown> = {
					target_address: result.targetAddress,
					method: result.method,
					handled_by: result.handledBy,
					vc_changed: Boolean(vcProbe.changed),
					vc_diff: vcProbe,
					post_check: postCheck,
				};
				if (viewDiff !== null) payload.view_diff = viewDiff;
				if (target !== null) payload.tapped = nodeSummary(target);
				return payload;
			}, (data) => okResult(data)),
	});
}
