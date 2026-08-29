/**
 * wait_for — poll until a VC class / text / accessibility id appears.
 *
 * Deliberately not the full Python predicate DSL (expect_*). Enough to
 * synchronize with animation, a network round-trip, or a page transition
 * without a fixed sleep.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { InspectorClient } from "../client.ts";
import { Cancelled, InspectorError } from "../errors.ts";
import type { VCNode, ViewNode } from "../models.ts";
import { localFindCandidates, selectorMatches } from "./find.ts";
import { nodeSummary, vcSummary } from "./format.ts";
import { errResult, okResult } from "./result.ts";
import { intEnv, sleepAbortable } from "./poll.ts";

interface InspectHooks {
	onInspect?: (view: ViewNode, vc: VCNode | null) => void | Promise<void>;
}

type Details = { ok: boolean } & Record<string, unknown>;

const DEFAULT_WAIT_MAX_MS = 30000;

function waitCeilingMs(): number {
	return Math.max(0, intEnv("INSPECTOR_WAIT_MAX_MS", DEFAULT_WAIT_MAX_MS));
}

function walkVcClasses(vc: VCNode): string[] {
	return [...vc.walk()].map((n) => n.cls).filter(Boolean);
}

async function commitInspect(
	client: InspectorClient,
	hooks: InspectHooks,
	view: ViewNode | null,
	vc: VCNode | null,
	signal?: AbortSignal,
): Promise<void> {
	if (!hooks.onInspect) return;
	let nextView = view;
	let nextVc = vc;
	try {
		if (!nextView) nextView = await client.viewHierarchy({ depth: 8, onScreenOnly: true, signal });
		if (!nextVc) nextVc = await client.vcHierarchy(signal).catch(() => null);
		if (nextView) await hooks.onInspect(nextView, nextVc);
	} catch {
		// observer is best-effort
	}
}

interface WaitEvidence {
	ok: boolean;
	reason: string;
	evidence: Record<string, unknown>;
}

async function evaluateWait(
	client: InspectorClient,
	params: { vcClass?: string; text?: string; accessibilityId?: string },
	signal?: AbortSignal,
): Promise<{ result: WaitEvidence; view: ViewNode | null; vc: VCNode | null }> {
	let view: ViewNode | null = null;
	let vc: VCNode | null = null;
	const evidence: Record<string, unknown> = {};
	const reasons: string[] = [];
	let ok = true;

	if (params.vcClass) {
		vc = await client.vcHierarchy(signal);
		const classes = walkVcClasses(vc);
		evidence.vc_classes = classes.slice(0, 8);
		evidence.visible_vc = vcSummary(vc).visible_vc ?? { class: vc.visibleLeaf().cls };
		const needle = params.vcClass.toLowerCase();
		const hit = classes.some((c) => c.toLowerCase().includes(needle));
		ok = ok && hit;
		reasons.push(hit ? `vc_class present: ${params.vcClass}` : `vc_class absent: ${params.vcClass}`);
	}

	if (params.text || params.accessibilityId) {
		view = await client.viewHierarchy({ depth: 20, onScreenOnly: true, signal });
		const sel = { text: params.text, accessibilityId: params.accessibilityId };
		let matches = localFindCandidates(view, sel, true);
		if (matches.length === 0) {
			try {
				matches = (await client.viewSearch(
					{ text: params.text, accessibilityId: params.accessibilityId },
					signal,
				)).filter((n) => selectorMatches(n, sel));
			} catch {
				// local tree is the source of truth when search fails
			}
		}
		evidence.matches = matches.slice(0, 5).map(nodeSummary);
		evidence.match_count = matches.length;
		const hit = matches.length > 0;
		ok = ok && hit;
		const label = params.text
			? `text=${JSON.stringify(params.text)}`
			: `accessibility_id=${JSON.stringify(params.accessibilityId)}`;
		reasons.push(hit ? `${label} present` : `${label} absent`);
	}

	return {
		result: { ok, reason: reasons.join("; "), evidence },
		view,
		vc,
	};
}

export function waitForTool(client: InspectorClient, hooks: InspectHooks = {}) {
	return defineTool({
		name: "wait_for",
		label: "Wait for",
		description:
			"Block until a condition holds, or until timeout. Use this to synchronize with an animation, " +
			"network round-trip, or page transition — never sleep with arbitrary delays. " +
			"Provide at least one of `vc_class` (substring on any VC in the stack), `text` (substring on a visible view), " +
			"or `accessibility_id` (exact). Multiple fields are AND. On timeout returns ok=false with the last evidence. " +
			"Read-only: does not mutate the UI.",
		parameters: Type.Object({
			vc_class: Type.Optional(Type.String({ description: "Substring match against any ViewController class in the current stack." })),
			text: Type.Optional(Type.String({ description: "Substring match against visible view text." })),
			accessibility_id: Type.Optional(Type.String({ description: "Exact accessibility identifier." })),
			timeout_ms: Type.Optional(Type.Integer({ minimum: 0, default: 5000 })),
			poll_ms: Type.Optional(Type.Integer({ minimum: 50, default: 250 })),
			stable_ms: Type.Optional(
				Type.Integer({
					minimum: 0,
					default: 0,
					description: "If >0, the condition must remain true for this many ms continuously before success.",
				}),
			),
		}),
		async execute(_id, params, signal) {
			try {
				if (!params.vc_class && !params.text && !params.accessibility_id) {
					throw new InspectorError(
						"wait_for requires at least one of vc_class, text, or accessibility_id",
						"E_INVALID_ARGUMENT",
					);
				}
				const ceiling = waitCeilingMs();
				const timeoutMs = Math.min(Math.max(0, params.timeout_ms ?? 5000), ceiling);
				const pollMs = Math.max(params.poll_ms ?? 250, 50);
				const stableMs = Math.max(params.stable_ms ?? 0, 0);

				const start = Date.now();
				const deadline = start + timeoutMs;
				let firstPassAt: number | null = null;
				let attempts = 0;
				let last: WaitEvidence | null = null;
				let lastView: ViewNode | null = null;
				let lastVc: VCNode | null = null;

				while (true) {
					if (signal?.aborted) throw new Cancelled();
					attempts += 1;
					const sampled = await evaluateWait(
						client,
						{ vcClass: params.vc_class, text: params.text, accessibilityId: params.accessibility_id },
						signal,
					);
					last = sampled.result;
					if (sampled.view) lastView = sampled.view;
					if (sampled.vc) lastVc = sampled.vc;
					const now = Date.now();

					if (last.ok) {
						if (stableMs === 0) {
							await commitInspect(client, hooks, lastView, lastVc, signal);
							return okResult<Details>({
								matched_at_ms: now,
								attempts,
								evidence: last.evidence,
								reason: last.reason,
							});
						}
						if (firstPassAt === null) firstPassAt = now;
						else if (now - firstPassAt >= stableMs) {
							await commitInspect(client, hooks, lastView, lastVc, signal);
							return okResult<Details>({
								matched_at_ms: now,
								stable_for_ms: now - firstPassAt,
								attempts,
								evidence: last.evidence,
								reason: last.reason,
							});
						}
					} else {
						firstPassAt = null;
					}

					if (now >= deadline) {
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										ok: false,
										error: {
											code: "E_WAIT_TIMEOUT",
											message: `condition did not hold within ${timeoutMs}ms`,
										},
										data: { attempts, last },
									}),
								},
							],
							details: { ok: false, code: "E_WAIT_TIMEOUT" } as Details,
						};
					}

					const sleepFor = Math.min(pollMs, Math.max(0, deadline - now));
					if (sleepFor > 0) await sleepAbortable(sleepFor, signal);
				}
			} catch (e) {
				return errResult<Details>(e);
			}
		},
	});
}
