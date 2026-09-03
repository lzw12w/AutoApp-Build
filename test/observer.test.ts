import { describe, expect, test } from "bun:test";
import { VCNode, ViewNode } from "../src/models.ts";
import { KnowledgeObserver } from "../src/knowledge/observer.ts";
import { KnowledgeStore } from "../src/knowledge/store.ts";

function page(vcClass: string, label: string): { view: ViewNode; vc: VCNode } {
	const view = ViewNode.fromDict({
		class: "UIWindow",
		address: "0x1",
		frame: { x: 0, y: 0, width: 400, height: 800 },
		children: [{ class: "UILabel", address: "0xa", frame: { x: 0, y: 0, width: 100, height: 20 }, accessibilityIdentifier: label }],
	});
	const vc = VCNode.fromDict({ class: vcClass, address: "0xvc" });
	return { view, vc };
}

describe("KnowledgeObserver", () => {
	test("first observe commits a page, no transition", () => {
		const store = new KnowledgeStore(":memory:");
		const obs = new KnowledgeObserver(store);
		const home = page("HomeVC", "home");
		obs.observe(home.view, home.vc, { postAction: true });
		expect(obs.currentPage).not.toBeNull();
		expect(obs.stats.pageCommits).toBe(1);
		expect(obs.stats.transitionsRecorded).toBe(0);
		store.close();
	});

	test("post-action navigation records an attributed transition", () => {
		const store = new KnowledgeStore(":memory:");
		const obs = new KnowledgeObserver(store);
		const home = page("HomeVC", "home");
		const detail = page("DetailVC", "detail");

		obs.observe(home.view, home.vc, { postAction: true });
		const homeId = obs.currentPage;

		// A tap fires, then we observe the new page.
		obs.recordAction("tap", { address: "0xbtn" }, {});
		obs.observe(detail.view, detail.vc, { postAction: true });

		expect(obs.currentPage).not.toBe(homeId);
		expect(obs.stats.transitionsRecorded).toBe(1);
		const edges = store.edgesFrom(homeId!);
		expect(edges.length).toBe(1);
		expect(edges[0]!.actionType).toBe("tap");
		store.close();
	});

	test("role-level tap identity splits chrome buttons; feed cells collapse", () => {
		const store = new KnowledgeStore(":memory:");
		const obs = new KnowledgeObserver(store);
		const home = page("HomeVC", "home");
		const detail = page("DetailVC", "detail");
		obs.observe(home.view, home.vc, { postAction: true });
		const homeId = obs.currentPage!;

		obs.recordAction("tap", { address: "0xdead", stability: true }, {});
		obs.enrichLatestAction(
			"tap",
			{ action_label: "点击 UIButton (settingsButton)", target: { class: "UIButton", property_name: "settingsButton" } },
			{ class: "UIButton", property_name: "settingsButton" },
		);
		obs.observe(detail.view, detail.vc, { postAction: true });

		obs.recordAction("tap", {}, {});
		obs.observe(home.view, home.vc, { postAction: true });

		obs.recordAction("tap", { address: "0xcell1" }, {});
		obs.enrichLatestAction("tap", { action_label: "点击 UILabel in FeedCell", target: { class: "UILabel" } }, {});
		obs.observe(detail.view, detail.vc, { postAction: true });

		obs.recordAction("tap", {}, {});
		obs.observe(home.view, home.vc, { postAction: true });

		obs.recordAction("tap", { address: "0xcell7" }, {});
		obs.enrichLatestAction("tap", { action_label: "点击 UILabel in FeedCell", target: { class: "UILabel", text: "other" } }, {});
		obs.observe(detail.view, detail.vc, { postAction: true });

		const edges = store.edgesFrom(homeId).filter((e) => e.actionType === "tap");
		expect(edges.length).toBe(2);
		const chrome = edges.find((e) => (e.actionParams.target as { property_name?: string } | undefined)?.property_name === "settingsButton");
		const cell = edges.find((e) => e.actionParams.action_label === "点击 UILabel in FeedCell");
		expect(chrome).toBeDefined();
		expect(cell).toBeDefined();
		expect(cell!.successCount).toBe(2);
		expect(JSON.stringify(cell!.actionParams)).not.toContain("0xcell");
		store.close();
	});

	test("re-observing the same page does not double-commit", () => {
		const store = new KnowledgeStore(":memory:");
		const obs = new KnowledgeObserver(store);
		const home = page("HomeVC", "home");
		obs.observe(home.view, home.vc, { postAction: true });
		const commits = obs.stats.pageCommits;
		obs.observe(home.view, home.vc, { postAction: true });
		expect(obs.stats.pageCommits).toBe(commits); // no new commit
		store.close();
	});

	test("transition with no recorded action is unattributed", () => {
		const store = new KnowledgeStore(":memory:");
		const obs = new KnowledgeObserver(store);
		const home = page("HomeVC", "home");
		const detail = page("DetailVC", "detail");
		obs.observe(home.view, home.vc, { postAction: true });
		const homeId = obs.currentPage;
		// Navigate without recording an action.
		obs.observe(detail.view, detail.vc, { postAction: true });
		const edges = store.edgesFrom(homeId!);
		expect(edges.length).toBe(1);
		expect(edges[0]!.actionType).toBe("unattributed_no_action");
		expect(obs.stats.unattributedNoAction).toBe(1);
		store.close();
	});

	test("first post-action observe without a prior page records no edge", () => {
		const store = new KnowledgeStore(":memory:");
		const obs = new KnowledgeObserver(store);
		const feed = page("MainFeedVC", "feed");
		const explore = page("DiscoveryVC", "explore");

		obs.recordAction("switch_tab", { index: 1 }, {});
		obs.observe(explore.view, explore.vc, { postAction: true });
		expect(obs.stats.transitionsRecorded).toBe(0);
		expect(store.stats().pages).toBe(1);

		obs.recordAction("switch_tab", { index: 4 }, {});
		obs.observe(feed.view, feed.vc, { postAction: true });
		expect(obs.stats.transitionsRecorded).toBe(1);
		store.close();
	});

	test("round-trip A→B→A collapses to a stable two-page graph", () => {
		const store = new KnowledgeStore(":memory:");
		const obs = new KnowledgeObserver(store);
		const a = page("AVC", "a");
		const b = page("BVC", "b");
		obs.observe(a.view, a.vc, { postAction: true });
		obs.recordAction("tap", {}, {});
		obs.observe(b.view, b.vc, { postAction: true });
		obs.recordAction("back", {}, {});
		obs.observe(a.view, a.vc, { postAction: true });
		expect(store.stats().pages).toBe(2);
		expect(store.stats().transitions).toBe(2); // A->B and B->A
		store.close();
	});

	test("failed action records a self-loop edge", () => {
		const store = new KnowledgeStore(":memory:");
		const obs = new KnowledgeObserver(store);
		const home = page("HomeVC", "home");
		obs.observe(home.view, home.vc, { postAction: true });
		const homeId = obs.currentPage!;
		obs.recordAction("tap", { accessibility_id: "missing" }, { aid: "missing" });
		obs.recordFailedTransition();
		const edges = store.edgesFrom(homeId);
		expect(edges.length).toBe(1);
		expect(edges[0]!.fromPage).toBe(homeId);
		expect(edges[0]!.toPage).toBe(homeId);
		expect(edges[0]!.failureCount).toBe(1);
		expect(edges[0]!.successCount).toBe(0);
		expect(obs.stats.failedTransitions).toBe(1);
		store.close();
	});
});
