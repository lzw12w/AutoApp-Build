/**
 * Page matcher + weighted Dijkstra path planner over the persisted transition
 * graph. Ported from ios_inspector_agent/knowledge/graph.py.
 *
 * The matcher decides whether a new fingerprint belongs to an existing page.
 * Current policy: page identity IS the visible ViewController class (the
 * legacy hamming/jaccard tiers were retired). The planner finds the cheapest
 * A→B path with a transparent multi-term cost and a per-step breakdown.
 */
import type { PageFingerprint } from "./fingerprint.ts";
import {
	attemptCount,
	avgLatencyMs,
	type KnowledgeStore,
	type PageRecord,
	successRate,
	type TransitionRecord,
} from "./store.ts";

export type MatchTier = "vc_class" | "new";

export interface MatchResult {
	decision: MatchTier;
	pageId: string | null;
	tier: MatchTier;
	distance: number;
	jaccard: number;
	reason: string;
	candidatesConsidered: number;
}

export function isHit(m: MatchResult): boolean {
	return m.decision !== "new";
}

export class PageMatcher {
	constructor(private readonly store: KnowledgeStore) {}

	match(fp: PageFingerprint): MatchResult {
		if (!fp.vcClass) {
			return {
				decision: "new",
				pageId: null,
				tier: "new",
				distance: -1,
				jaccard: -1,
				reason: "current view controller class is unavailable",
				candidatesConsidered: 0,
			};
		}
		const candidates = this.store.findPagesByVcClass(fp.vcClass);
		if (candidates.length > 0) {
			const page = candidates[0]!;
			return {
				decision: "vc_class",
				pageId: page.pageId,
				tier: "vc_class",
				distance: 0,
				jaccard: 1,
				reason: `same current view controller class: ${fp.vcClass}`,
				candidatesConsidered: candidates.length,
			};
		}
		return {
			decision: "new",
			pageId: null,
			tier: "new",
			distance: -1,
			jaccard: -1,
			reason: `no known page with current view controller class: ${fp.vcClass}`,
			candidatesConsidered: 0,
		};
	}
}

export interface EdgeWeights {
	baseStep: number;
	latencyPerSec: number;
	failurePenalty: number;
	lowEvidencePenalty: number;
	minEvidence: number;
	recencyHalfLifeDays: number;
}

export const DEFAULT_WEIGHTS: EdgeWeights = {
	baseStep: 1.0,
	latencyPerSec: 0.5,
	failurePenalty: 5.0,
	lowEvidencePenalty: 2.0,
	minEvidence: 3,
	recencyHalfLifeDays: 7.0,
};

export interface CostBreakdown {
	base: number;
	latency: number;
	failure: number;
	evidence: number;
	recency: number;
}

export function costTotal(c: CostBreakdown): number {
	return c.base + c.latency + c.failure + c.evidence + c.recency;
}

export interface PlannedStep {
	transition: TransitionRecord;
	cost: CostBreakdown;
}

export interface PathResult {
	fromPage: string;
	toPage: string;
	steps: PlannedStep[];
	totalCost: number;
}

export function pathHops(p: PathResult): number {
	return p.steps.length;
}

export function explainPath(p: PathResult): string {
	if (p.steps.length === 0) return `${p.fromPage} == ${p.toPage} (already there)`;
	const lines = [`plan: ${p.fromPage} → ${p.toPage} (${pathHops(p)} hops, total cost ${p.totalCost.toFixed(2)})`];
	p.steps.forEach((s, i) => {
		const tr = s.transition;
		const hint = tr.actionParams.text_hint ?? tr.actionParams.address ?? "";
		lines.push(
			`  ${i + 1}. ${tr.fromPage} --[${tr.actionType} ${hint}]--> ${tr.toPage} ` +
				`(cost ${costTotal(s.cost).toFixed(2)}; sr=${successRate(tr).toFixed(2)}, n=${attemptCount(tr)}, ` +
				`avg_lat=${avgLatencyMs(tr).toFixed(0)}ms)`,
		);
	});
	return lines.join("\n");
}

const MS_PER_DAY = 86_400_000;

export class PathPlanner {
	private readonly store: KnowledgeStore;
	private readonly w: EdgeWeights;
	private readonly nowMsFixed?: number;

	constructor(store: KnowledgeStore, options: { weights?: EdgeWeights; nowMs?: number } = {}) {
		this.store = store;
		this.w = options.weights ?? DEFAULT_WEIGHTS;
		this.nowMsFixed = options.nowMs;
	}

	private now(): number {
		return this.nowMsFixed ?? Date.now();
	}

	private cost(tr: TransitionRecord): CostBreakdown {
		const w = this.w;
		const latency = w.latencyPerSec * (avgLatencyMs(tr) / 1000);
		const sr = attemptCount(tr) > 0 ? successRate(tr) : 0;
		const failure = w.failurePenalty * (1 - sr);
		const evidence = attemptCount(tr) < w.minEvidence ? w.lowEvidencePenalty : 0;
		let recency = 0;
		if (w.recencyHalfLifeDays > 0 && tr.lastUsed > 0) {
			const ageDays = Math.max(0, (this.now() - tr.lastUsed) / MS_PER_DAY);
			recency = ageDays / w.recencyHalfLifeDays;
		}
		return { base: w.baseStep, latency, failure, evidence, recency };
	}

	/** Cheapest path A → B. Returns null if unreachable within maxSteps. */
	findPath(fromPage: string, toPage: string, maxSteps = 8): PathResult | null {
		if (fromPage === toPage) return { fromPage, toPage, steps: [], totalCost: 0 };

		// Min-heap keyed on cumulative cost; `best` is keyed on (page, hops) so a
		// costlier-but-shorter route survives a cheap long one (both may matter
		// for landing the target within maxSteps).
		interface Entry {
			cost: number;
			hops: number;
			tiebreak: number;
			page: string;
			path: PlannedStep[];
		}
		const heap: Entry[] = [{ cost: 0, hops: 0, tiebreak: 0, page: fromPage, path: [] }];
		const best = new Map<string, number>([[`${fromPage}:0`, 0]]);
		let tiebreak = 0;

		const popMin = (): Entry => {
			// Linear pop is fine at our scale (<2k edges); keeps deps out.
			let minIdx = 0;
			for (let i = 1; i < heap.length; i++) {
				const a = heap[i]!;
				const b = heap[minIdx]!;
				if (a.cost < b.cost || (a.cost === b.cost && a.hops < b.hops) || (a.cost === b.cost && a.hops === b.hops && a.tiebreak < b.tiebreak)) {
					minIdx = i;
				}
			}
			return heap.splice(minIdx, 1)[0]!;
		};

		while (heap.length > 0) {
			const { cost, hops, page, path } = popMin();
			if (page === toPage) return { fromPage, toPage, steps: path, totalCost: cost };
			if (hops >= maxSteps) continue;
			if (cost > (best.get(`${page}:${hops}`) ?? Number.POSITIVE_INFINITY)) continue;
			for (const tr of this.store.edgesFrom(page)) {
				const stepCost = this.cost(tr);
				const ncost = cost + costTotal(stepCost);
				const nhops = hops + 1;
				const key = `${tr.toPage}:${nhops}`;
				if (ncost >= (best.get(key) ?? Number.POSITIVE_INFINITY)) continue;
				best.set(key, ncost);
				tiebreak += 1;
				heap.push({ cost: ncost, hops: nhops, tiebreak, page: tr.toPage, path: [...path, { transition: tr, cost: stepCost }] });
			}
		}
		return null;
	}

	/** Resolve a fuzzy name → candidate pages → top-k cheapest paths. */
	findPathsToNamed(fromPage: string, targetName: string, options: { topK?: number; maxSteps?: number } = {}): PathResult[] {
		const target = targetName.trim().toLowerCase();
		if (!target) return [];
		const topK = options.topK ?? 3;
		const maxSteps = options.maxSteps ?? 8;

		const scored: [number, PageRecord][] = [];
		for (const page of this.store.listPages(500)) {
			let score = 0;
			if (page.canonicalName) {
				const lname = page.canonicalName.toLowerCase();
				if (lname === target) score += 10;
				else if (lname.includes(target) || target.includes(lname)) score += 5;
			}
			for (const variant of page.fingerprints) {
				if (variant.title && variant.title.toLowerCase().includes(target)) score += 3;
				for (const t of variant.keyTexts) {
					if (t.toLowerCase().includes(target)) score += 1;
				}
			}
			if (score > 0) scored.push([score, page]);
		}
		scored.sort((a, b) => b[0] - a[0]);

		const results: PathResult[] = [];
		const seen = new Set<string>();
		for (const [, page] of scored) {
			if (seen.has(page.pageId) || page.pageId === fromPage) continue;
			seen.add(page.pageId);
			const path = this.findPath(fromPage, page.pageId, maxSteps);
			if (path !== null) results.push(path);
			if (results.length >= topK) break;
		}
		results.sort((a, b) => a.totalCost - b.totalCost);
		return results;
	}
}
