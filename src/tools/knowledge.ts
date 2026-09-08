/**
 * Knowledge-graph tools that depend on the observer + store + planner.
 * Ported from ios_inspector_agent/actions/knowledge_actions.py.
 * Page rename/notes live here as `annotate_page`. Project-wide NOTE.md
 * writes are `record_knowledge` in note.ts.
 *
 *  - navigate_to_page:   plan the cheapest action path to a target page
 *  - recall_page_context: summarize the current page + its learned edges
 *  - annotate_page:      set the current page's canonical name or a graph note
 *
 * These need a committed "current page", which the observer establishes after
 * the first snapshot. The extension seeds that by observing once on demand.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { InspectorClient } from "../client.ts";
import { InspectorError } from "../errors.ts";
import {
	avgLatencyMs,
	type KnowledgeStore,
	successRate,
	type TransitionRecord,
} from "../knowledge/store.ts";
import { costTotal, type PathResult, PathPlanner, pathHops, type PlannedStep } from "../knowledge/graph.ts";
import type { KnowledgeObserver } from "../knowledge/observer.ts";
import { errResult, okResult } from "./result.ts";

export interface KnowledgeContext {
	client: InspectorClient;
	/**
	 * Take a fresh snapshot, commit it, and return the initialized store +
	 * observer (both are created lazily on first snapshot). Knowledge tools
	 * call this first so `observer.currentPage` is set and `store` exists.
	 */
	snapshotNow: (signal?: AbortSignal) => Promise<{ store: KnowledgeStore; observer: KnowledgeObserver }>;
}

type Details = { ok: boolean } & Record<string, unknown>;

const round3 = (x: number): number => Math.round(x * 1000) / 1000;
const round1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * Short human label for a transition. Mirrors Python
 * `_transition_action_label`: prefer the recorded `action_label`, and when it
 * is a Chinese "点击 「…」" tap label, strip the quoted target so distinct taps
 * on the same control collapse to one label.
 */
function transitionActionLabel(tr: TransitionRecord): string {
	const label = tr.actionParams.action_label;
	if (typeof label === "string" && label.trim()) {
		const l = label.trim();
		if (l.startsWith("点击 ") && l.includes("「")) {
			return l.split("「")[0]!.replace(/\s+$/, "");
		}
		return l;
	}
	return tr.actionType;
}

function stepToDict(store: KnowledgeStore, step: PlannedStep): Record<string, unknown> {
	const tr = step.transition;
	const toPage = store.getPage(tr.toPage, false);
	return {
		action_type: tr.actionType,
		action_label: transitionActionLabel(tr),
		action_params: tr.actionParams,
		expected_to_page_id: tr.toPage,
		expected_to_page_name: toPage?.canonicalName ?? null,
		expected_cost: round3(costTotal(step.cost)),
		cost_breakdown: {
			base: round3(step.cost.base),
			latency: round3(step.cost.latency),
			failure: round3(step.cost.failure),
			evidence: round3(step.cost.evidence),
			recency: round3(step.cost.recency),
		},
		evidence: {
			success: tr.successCount,
			failure: tr.failureCount,
			avg_latency_ms: round1(avgLatencyMs(tr)),
		},
	};
}

function pathToDict(store: KnowledgeStore, path: PathResult): Record<string, unknown> {
	return {
		from_page_id: path.fromPage,
		to_page_id: path.toPage,
		hops: pathHops(path),
		total_cost: round3(path.totalCost),
		steps: path.steps.map((s) => stepToDict(store, s)),
	};
}

/** Resolve a target string (page_id / VC class / canonical name / fuzzy) to a page id. */
export function resolveNavigateTarget(
	store: KnowledgeStore,
	target: string,
	fromPage?: string | null,
	topK = 3,
): { best: string | null; candidates: { page_id: string; name: string | null; vc_class_hint: string | null; score: number }[] } {
	const t = target.trim();
	if (!t) return { best: null, candidates: [] };
	if (t.startsWith("p_") && store.getPage(t, false)) {
		const page = store.getPage(t, false)!;
		return {
			best: t,
			candidates: [{ page_id: t, name: page.canonicalName, vc_class_hint: page.vcClassHint, score: 100 }],
		};
	}
	const needle = t.toLowerCase();
	const scored: { score: number; page_id: string; name: string | null; vc_class_hint: string | null }[] = [];
	for (const page of store.listPages(500)) {
		if (fromPage && page.pageId === fromPage) continue;
		let score = 0;
		if (page.vcClassHint) {
			const vcL = page.vcClassHint.toLowerCase();
			if (vcL === needle) score += 20;
			else if (needle.length >= 3 && (vcL.includes(needle) || needle.includes(vcL))) score += 8;
		}
		if (page.canonicalName) {
			const nameL = page.canonicalName.toLowerCase();
			if (nameL === needle) score += 10;
			else if (needle.length >= 2 && (nameL.includes(needle) || needle.includes(nameL))) score += 5;
		}
		if (score === 0) {
			const full = store.getPage(page.pageId, true);
			if (full) {
				for (const fp of full.fingerprints) {
					if (fp.title && fp.title.toLowerCase().includes(needle)) score += 3;
					if (fp.keyTexts.some((text) => text.toLowerCase().includes(needle))) {
						score += 1;
						break;
					}
				}
			}
		}
		for (const tr of store.edgesTo(page.pageId)) {
			const aid = tr.actionParams.accessibility_id;
			if (typeof aid !== "string" || !aid) continue;
			const last = aid.split(".").pop()?.toLowerCase() ?? "";
			if (last === needle) score += 9;
			else if (last.replace(/_/g, "").includes(needle) && needle.length >= 4) score += 6;
		}
		if (score > 0) {
			scored.push({
				score,
				page_id: page.pageId,
				name: page.canonicalName,
				vc_class_hint: page.vcClassHint,
			});
		}
	}
	scored.sort((a, b) => b.score - a.score);
	const candidates = scored.slice(0, topK);
	return { best: candidates[0]?.page_id ?? null, candidates };
}

function nameSuggestions(store: KnowledgeStore, limit = 8): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const page of store.listPages(limit)) {
		for (const value of [page.canonicalName, page.vcClassHint]) {
			if (value && !seen.has(value)) {
				seen.add(value);
				out.push(value);
			}
		}
	}
	return out;
}

function summarizeEdges(store: KnowledgeStore, edges: TransitionRecord[], direction: "out" | "in", limit: number): Record<string, unknown>[] {
	const sorted = [...edges].sort((a, b) => {
		const ra = successRate(a);
		const rb = successRate(b);
		if (rb !== ra) return rb - ra;
		return b.successCount - a.successCount;
	});
	return sorted.slice(0, limit).map((tr) => {
		const other = direction === "out" ? tr.toPage : tr.fromPage;
		const page = store.getPage(other, false);
		return {
			action_type: tr.actionType,
			action_label: transitionActionLabel(tr),
			action_params: tr.actionParams,
			other_page_id: other,
			other_page_name: page?.canonicalName ?? null,
			success_count: tr.successCount,
			failure_count: tr.failureCount,
			success_rate: Math.round(successRate(tr) * 1000) / 1000,
			avg_latency_ms: Math.round(avgLatencyMs(tr) * 10) / 10,
		};
	});
}

export function buildKnowledgeTools(kc: KnowledgeContext) {
	const tools = [];

	tools.push(
		defineTool({
			name: "navigate_to_page",
			label: "Navigate to page",
			description:
				"Plan a multi-step path from the current page to a target page using the learned state graph. " +
				"RETURNS A PLAN ONLY — does not execute. Each step includes action_type, params, expected_to_page_id, " +
				"and a cost breakdown so you can decide whether to follow it. After executing a step, call " +
				"view_hierarchy to verify the predicted target was reached, and replan if not. " +
				"Target may be a page_id (starts with 'p_'), a ViewController class name, or a free-form page name " +
				"(`Home` matches `UserHomePageViewController`). When using a non-page_id target, multiple candidates " +
				"are returned in 'alternatives'.",
			parameters: Type.Object({
				target: Type.String({ description: "Target page_id, ViewController class, canonical name, or a substring of those." }),
				max_steps: Type.Optional(Type.Integer({ default: 8, minimum: 1, maximum: 32 })),
				top_k_candidates: Type.Optional(Type.Integer({ default: 3, minimum: 1, maximum: 10 })),
			}),
			async execute(_id, params, signal) {
				try {
					const { store, observer } = await kc.snapshotNow(signal);
					const fromPage = observer.currentPage;
					if (fromPage === null) {
						return errResult(
							new InspectorError(
								"Observer has not committed a current page yet. Call view_hierarchy first (twice, due to debounce).",
								"E_NO_CURRENT_PAGE",
							),
						);
					}
					const planner = new PathPlanner(store);
					const resolved = resolveNavigateTarget(store, params.target, fromPage, params.top_k_candidates ?? 3);
					const best = resolved.best;
					if (best === null) {
						return errResult(
							new InspectorError(`No page matches target ${JSON.stringify(params.target)}.`, "E_UNKNOWN_TARGET", {
								suggestions: nameSuggestions(store),
							}),
						);
					}
					const maxSteps = params.max_steps ?? 8;
					const primary = planner.findPath(fromPage, best, maxSteps);
					// Plan to best, also try alternatives for transparency.
					const altPlans: Record<string, unknown>[] = [];
					for (const c of resolved.candidates) {
						if (c.page_id === best) continue;
						const p = planner.findPath(fromPage, c.page_id, maxSteps);
						if (p !== null) altPlans.push({ candidate: c, path: pathToDict(store, p) });
					}
					if (primary === null) {
						return errResult(
							new InspectorError(
								`No path from ${fromPage} to ${best} within max_steps=${maxSteps}. ` +
									"The graph may need more exploration before this destination is reachable.",
								"E_NO_PATH",
								{ candidates_considered: resolved.candidates, alternatives: altPlans },
							),
						);
					}
					const fromRec = store.getPage(fromPage, false);
					const toRec = store.getPage(best, false);
					return okResult<Details>({
						status: "ok",
						from_page_id: fromPage,
						from_page_name: fromRec?.canonicalName ?? null,
						to_page_id: best,
						to_page_name: toRec?.canonicalName ?? null,
						hops: pathHops(primary),
						total_cost: round3(primary.totalCost),
						steps: primary.steps.map((s) => stepToDict(store, s)),
						candidates_considered: resolved.candidates,
						alternatives: altPlans,
					});
				} catch (e) {
					return errResult(e);
				}
			},
		}),
	);

	tools.push(
		defineTool({
			name: "recall_page_context",
			label: "Recall page context",
			description:
				"Summarize the current page and its outgoing (and optionally incoming) edges in the learned state " +
				"graph. Use to ground 'what can I do from here' / 'where did I come from'.",
			parameters: Type.Object({
				include_inbound: Type.Optional(Type.Boolean({ default: false })),
				edge_limit: Type.Optional(Type.Integer({ default: 8, minimum: 1, maximum: 50 })),
			}),
			async execute(_id, params, signal) {
				try {
					const { store, observer } = await kc.snapshotNow(signal);
					const pageId = observer.currentPage;
					if (pageId === null) {
						return okResult<Details>({ status: "no_current_page", hint: "Call view_hierarchy first (twice, due to debounce)." });
					}
					const page = store.getPage(pageId, true);
					if (page === null) {
						return errResult(new InspectorError(`Current page ${pageId} not found in store.`, "E_PAGE_GONE"));
					}
					const title = page.fingerprints.find((fp) => fp.title)?.title ?? null;
					const limit = params.edge_limit ?? 8;
					const result: Record<string, unknown> = {
						status: "ok",
						page: {
							page_id: page.pageId,
							name: page.canonicalName,
							title,
							vc_class_hint: page.vcClassHint,
							notes: page.notes,
						},
						outbound: summarizeEdges(store, store.edgesFrom(pageId), "out", limit),
						stats: observer.stats,
					};
					if (params.include_inbound) {
						result.inbound = summarizeEdges(store, store.edgesTo(pageId), "in", limit);
					}
					return okResult<Details>(result);
				} catch (e) {
					return errResult(e);
				}
			},
		}),
	);

	tools.push(
		defineTool({
			name: "annotate_page",
			label: "Annotate page",
			description:
				"Attach a durable note to the current page in the knowledge graph (e.g. 'this is the checkout screen') " +
				"or set the page's canonical name used by navigate_to_page. This is page-local graph metadata — " +
				"project-wide conventions go to record_knowledge (NOTE.md).",
			parameters: Type.Object({
				note: Type.Optional(Type.String({ description: "Free-form note appended to the current page." })),
				name: Type.Optional(Type.String({ description: "Set the page's canonical name." })),
			}),
			async execute(_id, params, signal) {
				try {
					const { store, observer } = await kc.snapshotNow(signal);
					const pageId = observer.currentPage;
					if (pageId === null) return okResult<Details>({ status: "no_current_page" });
					if (params.name) store.renamePage(pageId, params.name);
					if (params.note) store.appendNote(pageId, params.note);
					if (!params.name && !params.note) {
						return okResult<Details>({ status: "noop", message: "provide note and/or name" });
					}
					return okResult<Details>({ status: "ok", page_id: pageId });
				} catch (e) {
					return okResult<Details>({ status: "error", message: e instanceof Error ? e.message : String(e) });
				}
			},
		}),
	);

	return tools;
}
