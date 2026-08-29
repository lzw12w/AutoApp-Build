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
import {
	attemptCount,
	avgLatencyMs,
	type KnowledgeStore,
	successRate,
	type TransitionRecord,
} from "../knowledge/store.ts";
import { type PathResult, PathPlanner, pathHops } from "../knowledge/graph.ts";
import type { KnowledgeObserver } from "../knowledge/observer.ts";
import { okResult } from "./result.ts";

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

function stepToDict(store: KnowledgeStore, tr: TransitionRecord): Record<string, unknown> {
	const toPage = store.getPage(tr.toPage, false);
	return {
		action_type: tr.actionType,
		action_params: tr.actionParams,
		to_page_id: tr.toPage,
		to_page_name: toPage?.canonicalName ?? null,
		success_rate: Math.round(successRate(tr) * 1000) / 1000,
		attempts: attemptCount(tr),
		avg_latency_ms: Math.round(avgLatencyMs(tr) * 10) / 10,
	};
}

function pathToDict(store: KnowledgeStore, path: PathResult): Record<string, unknown> {
	return {
		from_page_id: path.fromPage,
		to_page_id: path.toPage,
		hops: pathHops(path),
		total_cost: Math.round(path.totalCost * 1000) / 1000,
		steps: path.steps.map((s) => stepToDict(store, s.transition)),
	};
}

/** Resolve a target string (page_id / VC class / canonical name) to a page id. */
function resolveTarget(store: KnowledgeStore, target: string): string | null {
	const t = target.trim();
	if (!t) return null;
	// Direct page id.
	if (t.startsWith("p_") && store.getPage(t, false)) return t;
	// Exact VC class.
	const byClass = store.findPagesByVcClass(t);
	if (byClass.length > 0) return byClass[0]!.pageId;
	// Canonical name (exact, then substring).
	const pages = store.listPages(500);
	for (const p of pages) {
		if (p.canonicalName && p.canonicalName.toLowerCase() === t.toLowerCase()) return p.pageId;
	}
	for (const p of pages) {
		if (p.canonicalName && p.canonicalName.toLowerCase().includes(t.toLowerCase())) return p.pageId;
	}
	return null;
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
				"Plan the cheapest known action path from the current page to a target. Target may be a page_id " +
				"(starts with 'p_'), a ViewController class name, or a canonical page name. Returns the ordered steps " +
				"(does NOT execute them — issue the taps yourself). Requires the graph to have learned a route.",
			parameters: Type.Object({
				target: Type.String({ description: "Target page_id, ViewController class, or canonical name." }),
				max_steps: Type.Optional(Type.Integer({ default: 8, minimum: 1, maximum: 30 })),
				top_k_candidates: Type.Optional(Type.Integer({ default: 3, minimum: 1, maximum: 10 })),
			}),
			async execute(_id, params, signal) {
				try {
					const { store, observer } = await kc.snapshotNow(signal);
					const fromPage = observer.currentPage;
					if (fromPage === null) {
						return okResult<Details>({ status: "no_current_page", hint: "Could not identify the current page." });
					}
					const planner = new PathPlanner(store);
					const best = resolveTarget(store, params.target);
					if (best === null) {
						return okResult<Details>({
							status: "unknown_target",
							message: `No page matches target ${JSON.stringify(params.target)}.`,
							suggestions: nameSuggestions(store),
						});
					}
					const primary = planner.findPath(fromPage, best, params.max_steps ?? 8);
					if (primary === null) {
						return okResult<Details>({
							status: "no_path",
							message: `No path from ${fromPage} to ${best} within max_steps=${params.max_steps ?? 8}. The graph may need more exploration.`,
						});
					}
					const fromRec = store.getPage(fromPage, false);
					const toRec = store.getPage(best, false);
					return okResult<Details>({
						status: "ok",
						from_page_id: fromPage,
						from_page_name: fromRec?.canonicalName ?? null,
						to_page_id: best,
						to_page_name: toRec?.canonicalName ?? null,
						...pathToDict(store, primary),
					});
				} catch (e) {
					return okResult<Details>({ status: "error", message: e instanceof Error ? e.message : String(e) });
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
					if (pageId === null) return okResult<Details>({ status: "no_current_page" });
					const page = store.getPage(pageId, true);
					if (page === null) return okResult<Details>({ status: "page_gone", page_id: pageId });
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
					return okResult<Details>({ status: "error", message: e instanceof Error ? e.message : String(e) });
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
