import { describe, expect, test } from "bun:test";
import type { PageFingerprint } from "../src/knowledge/fingerprint.ts";
import { KnowledgeStore } from "../src/knowledge/store.ts";

function fp(overrides: Partial<PageFingerprint> = {}): PageFingerprint {
	return {
		skeletonHash: "aaaaaaaaaaaaaaaa",
		semanticHash: "bbbbbbbbbbbbbbbb",
		visualHash: null,
		vcClass: "HomeVC",
		title: null,
		keyTexts: ["UIWindow", "UIButton:btn_go"],
		depth: 3,
		leafCount: 5,
		...overrides,
	};
}

function memStore(): KnowledgeStore {
	return new KnowledgeStore(":memory:");
}

describe("KnowledgeStore", () => {
	test("upsertPage is deterministic and idempotent", () => {
		const store = memStore();
		const id1 = store.upsertPage(fp());
		const id2 = store.upsertPage(fp());
		expect(id1).toBe(id2);
		const page = store.getPage(id1);
		expect(page?.visitCount).toBe(2);
		expect(page?.fingerprints.length).toBe(1);
		store.close();
	});

	test("distinct fingerprints → distinct pages", () => {
		const store = memStore();
		const a = store.upsertPage(fp({ skeletonHash: "1111111111111111" }));
		const b = store.upsertPage(fp({ skeletonHash: "2222222222222222" }));
		expect(a).not.toBe(b);
		expect(store.stats().pages).toBe(2);
		store.close();
	});

	test("findPagesByVcClass", () => {
		const store = memStore();
		store.upsertPage(fp({ vcClass: "HomeVC" }));
		store.upsertPage(fp({ vcClass: "DetailVC", skeletonHash: "cccccccccccccccc" }));
		expect(store.findPagesByVcClass("HomeVC").length).toBe(1);
		expect(store.findPagesByVcClass("Nope").length).toBe(0);
		store.close();
	});

	test("recordTransition dedups on content-blind identity", () => {
		const store = memStore();
		const from = store.upsertPage(fp({ skeletonHash: "1111111111111111", vcClass: "A" }));
		const to = store.upsertPage(fp({ skeletonHash: "2222222222222222", vcClass: "B" }));
		// Two taps on different cells (different address) but empty __identity__
		// collapse into ONE edge.
		store.recordTransition(from, to, { actionType: "tap", actionParams: { address: "0xa", __identity__: {} }, latencyMs: 100 });
		store.recordTransition(from, to, { actionType: "tap", actionParams: { address: "0xb", __identity__: {} }, latencyMs: 200 });
		const edges = store.edgesFrom(from);
		expect(edges.length).toBe(1);
		expect(edges[0]!.successCount).toBe(2);
		// __identity__ is stripped from the persisted human-visible params.
		expect(edges[0]!.actionParams.__identity__).toBeUndefined();
		store.close();
	});

	test("different structural identity → separate edges", () => {
		const store = memStore();
		const from = store.upsertPage(fp({ skeletonHash: "1111111111111111", vcClass: "A" }));
		const to = store.upsertPage(fp({ skeletonHash: "2222222222222222", vcClass: "B" }));
		store.recordTransition(from, to, { actionType: "scroll", actionParams: { __identity__: { axis: "y", direction: 1 } } });
		store.recordTransition(from, to, { actionType: "scroll", actionParams: { __identity__: { axis: "y", direction: -1 } } });
		expect(store.edgesFrom(from).length).toBe(2);
		store.close();
	});

	test("rename and note persist", () => {
		const store = memStore();
		const id = store.upsertPage(fp());
		store.renamePage(id, "Home");
		store.appendNote(id, "the main tab");
		store.appendNote(id, "buy button top-right");
		const page = store.getPage(id);
		expect(page?.canonicalName).toBe("Home");
		expect(page?.notes).toBe("the main tab\nbuy button top-right");
		store.close();
	});
});
