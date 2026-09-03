import { describe, expect, test } from "bun:test";
import { Frame, ViewNode } from "../src/models.ts";
import {
	findAncestorChain,
	stableNodeSummary,
	tapIdentity,
	tapLabel,
	tapTargetAttribution,
} from "../src/knowledge/tap-target.ts";

function node(init: Record<string, unknown>): ViewNode {
	return ViewNode.fromDict(init);
}

function feedTree(): { root: ViewNode; label: ViewNode } {
	const label = node({
		class: "UILabel",
		address: "0xLABEL",
		frame: { x: 160, y: 320, width: 80, height: 24 },
		text: "今天最热的 10 条新闻",
	});
	const card = new ViewNode({
		address: "0xCARD",
		cls: "FeedCardView",
		frame: new Frame(0, 300, 375, 80),
		children: [label],
	});
	const cell = new ViewNode({
		address: "0xCELL",
		cls: "FeedCell",
		frame: new Frame(0, 300, 375, 80),
		children: [card],
	});
	const listv = new ViewNode({
		address: "0xLIST",
		cls: "FeedListView",
		frame: new Frame(0, 0, 375, 800),
		children: [cell],
	});
	const root = new ViewNode({
		address: "0xROOT",
		cls: "UIWindow",
		frame: new Frame(0, 0, 375, 812),
		children: [listv],
	});
	return { root, label };
}

describe("stableNodeSummary", () => {
	test("carries structural fields and drops volatile text", () => {
		const { root, label } = feedTree();
		const chain = findAncestorChain(root, label.address);
		const summary = stableNodeSummary(label, chain);
		expect(summary.class).toBe("UILabel");
		expect(summary.frame).toEqual([160, 320, 80, 24]);
		expect(summary.aid).toBeNull();
		expect(summary.ancestor_chain).toEqual(["FeedCardView", "FeedCell", "FeedListView"]);
		expect(summary.text).toBeUndefined();
	});

	test("keeps role-level control hints", () => {
		const icon = node({
			class: "UIImageView",
			address: "0xICON",
			frame: { x: 20, y: 40, width: 44, height: 44 },
			propertyName: "cartButton",
			accessibilityLabel: "购物车",
			imageSymbolName: "cart.fill",
		});
		const summary = stableNodeSummary(icon, ["HomeVC"]);
		expect(summary.property_name).toBe("cartButton");
		expect(summary.accessibility_label).toBe("购物车");
		expect(summary.image_symbol_name).toBe("cart.fill");
		const label = tapLabel(summary);
		expect(label).toContain("cartButton");
		expect(label).toContain("cart.fill");
		expect(label).toContain("购物车");
	});

	test("keeps short UI copy and drops prices", () => {
		const buy = node({ class: "UIButton", address: "0xBUY", frame: { x: 0, y: 0, width: 80, height: 40 }, text: "立即购买" });
		const price = node({ class: "UILabel", address: "0xPRICE", frame: { x: 0, y: 0, width: 80, height: 20 }, text: "¥199" });
		expect(stableNodeSummary(buy).text).toBe("立即购买");
		expect(stableNodeSummary(price).text).toBeUndefined();
	});
});

describe("tapIdentity", () => {
	test("empty when the control has no role handle", () => {
		const { root, label } = feedTree();
		const summary = stableNodeSummary(label, findAncestorChain(root, label.address));
		expect(tapIdentity(summary)).toEqual({});
	});

	test("splits on property_name", () => {
		const icon = node({
			class: "UIImageView",
			address: "0xICON",
			frame: { x: 20, y: 40, width: 44, height: 44 },
			propertyName: "cartButton",
		});
		const summary = stableNodeSummary(icon, ["Toolbar"]);
		expect(tapIdentity(summary)).toEqual({
			class: "UIImageView",
			property_name: "cartButton",
			ancestor_chain: ["Toolbar"],
		});
	});

	test("splits on role-aid, not content-bearing aid", () => {
		const role = node({
			class: "UIButton",
			address: "0xA",
			frame: { x: 0, y: 0, width: 40, height: 40 },
			accessibilityIdentifier: "btn_like",
		});
		const content = node({
			class: "UIButton",
			address: "0xB",
			frame: { x: 0, y: 0, width: 40, height: 40 },
			accessibilityIdentifier: "aweme_cell_7234567891234",
		});
		expect(tapIdentity(stableNodeSummary(role))).toEqual({ class: "UIButton", aid: "btn_like" });
		expect(tapIdentity(stableNodeSummary(content))).toEqual({});
	});
});

describe("tapTargetAttribution", () => {
	test("drops address from params", () => {
		const { root, label } = feedTree();
		const { params, identity } = tapTargetAttribution(label, root);
		expect(params.action_label).toContain("点击 UILabel");
		expect(params.target).toMatchObject({ class: "UILabel" });
		expect(JSON.stringify(params)).not.toContain("0xLABEL");
		expect(identity).toEqual({});
	});

	test("coordinate tap without a node stays identity-empty", () => {
		const { params, identity } = tapTargetAttribution(null, null, { x: 12, y: 34 });
		expect(params).toEqual({ action_label: "点击坐标 (12, 34)" });
		expect(identity).toEqual({});
	});
});
