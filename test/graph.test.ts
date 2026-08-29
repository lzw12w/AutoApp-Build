import { describe, expect, test } from "bun:test";
import type { PageFingerprint } from "../src/knowledge/fingerprint.ts";
import { PageMatcher, PathPlanner, pathHops } from "../src/knowledge/graph.ts";
import { KnowledgeStore } from "../src/knowledge/store.ts";

function fp(skeleton: string, vcClass: string): PageFingerprint {
	return {
		skeletonHash: skeleton,
		semanticHash: skeleton,
		visualHash: null,
		vcClass,
		title: null,
		keyTexts: [],
		depth: 1,
		leafCount: 1,
	};
}

function memStore(): KnowledgeStore {
	return new KnowledgeStore(":memory:");
}

describe("PageMatcher", () => {
	test("matches by VC class", () => {
		const store = memStore();
		const id = store.upsertPage(fp("1111111111111111", "HomeVC"));
		const matcher = new PageMatcher(store);
		const result = matcher.match(fp("9999999999999999", "HomeVC"));
		expect(result.decision).toBe("vc_class");
		expect(result.pageId).toBe(id);
		store.close();
	});
	test("new when VC class unknown", () => {
		const store = memStore();
		const matcher = new PageMatcher(store);
		expect(matcher.match(fp("1111111111111111", "MysteryVC")).decision).toBe("new");
		store.close();
	});
	test("new when vcClass empty", () => {
		const store = memStore();
		expect(new PageMatcher(store).match(fp("1", "")).decision).toBe("new");
		store.close();
	});
});

describe("PathPlanner Dijkstra", () => {
	// Build A -> B -> C (cheap chain) and A -> C (one expensive hop). The
	// planner should pick the route with the lower total cost.
	function threeNodeGraph(): { store: KnowledgeStore; a: string; b: string; c: string } {
		const store = memStore();
		const a = store.upsertPage(fp("aaaaaaaaaaaaaaaa", "A"));
		const b = store.upsertPage(fp("bbbbbbbbbbbbbbbb", "B"));
		const c = store.upsertPage(fp("cccccccccccccccc", "C"));
		// Make edges well-evidenced and fresh so recency/evidence penalties are low.
		for (let i = 0; i < 5; i++) {
			store.recordTransition(a, b, { actionType: "tap", actionParams: { __identity__: {} }, latencyMs: 10, success: true });
			store.recordTransition(b, c, { actionType: "tap", actionParams: { __identity__: {} }, latencyMs: 10, success: true });
		}
		return { store, a, b, c };
	}

	test("same page → empty path", () => {
		const { store, a } = threeNodeGraph();
		const planner = new PathPlanner(store, { nowMs: Date.now() });
		const path = planner.findPath(a, a);
		expect(path).not.toBeNull();
		expect(pathHops(path!)).toBe(0);
		store.close();
	});

	test("finds multi-hop path A → C", () => {
		const { store, a, c } = threeNodeGraph();
		const planner = new PathPlanner(store, { nowMs: Date.now() });
		const path = planner.findPath(a, c);
		expect(path).not.toBeNull();
		expect(path!.toPage).toBe(c);
		expect(pathHops(path!)).toBe(2);
		store.close();
	});

	test("unreachable within max_steps → null", () => {
		const { store, a, c } = threeNodeGraph();
		const planner = new PathPlanner(store, { nowMs: Date.now() });
		expect(planner.findPath(a, c, 1)).toBeNull();
		store.close();
	});

	test("prefers cheaper direct edge when present", () => {
		const { store, a, c } = threeNodeGraph();
		// Add a direct, well-evidenced A -> C edge; it should win on hops (and
		// total cost, since one base step < two).
		for (let i = 0; i < 5; i++) {
			store.recordTransition(a, c, { actionType: "open_url", actionParams: { __identity__: {} }, latencyMs: 10, success: true });
		}
		const planner = new PathPlanner(store, { nowMs: Date.now() });
		const path = planner.findPath(a, c);
		expect(pathHops(path!)).toBe(1);
		store.close();
	});

	test("failed edges cost more (failure penalty)", () => {
		const store = memStore();
		const a = store.upsertPage(fp("aaaaaaaaaaaaaaaa", "A"));
		const c = store.upsertPage(fp("cccccccccccccccc", "C"));
		// Reliable 2-hop via B vs a flaky direct edge.
		const b = store.upsertPage(fp("bbbbbbbbbbbbbbbb", "B"));
		for (let i = 0; i < 5; i++) {
			store.recordTransition(a, b, { actionType: "tap", actionParams: { __identity__: {} }, latencyMs: 5, success: true });
			store.recordTransition(b, c, { actionType: "tap", actionParams: { __identity__: {} }, latencyMs: 5, success: true });
		}
		// Direct edge that mostly fails.
		for (let i = 0; i < 5; i++) {
			store.recordTransition(a, c, { actionType: "tap", actionParams: { __identity__: {} }, latencyMs: 5, success: false });
		}
		const planner = new PathPlanner(store, { nowMs: Date.now() });
		const path = planner.findPath(a, c);
		// The reliable 2-hop route should beat the failing 1-hop one.
		expect(pathHops(path!)).toBe(2);
		store.close();
	});
});
