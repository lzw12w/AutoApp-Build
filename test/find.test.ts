import { describe, expect, test } from "bun:test";
import { ViewNode } from "../src/models.ts";
import { rankFindCandidates, tabIndexForTarget } from "../src/tools/find.ts";

function node(raw: Record<string, unknown>): ViewNode {
	return ViewNode.fromDict(raw);
}

describe("rankFindCandidates", () => {
	test("prefers exact accessibility_id over substring text", () => {
		const exact = node({
			class: "UIButton",
			address: "0xa",
			frame: { x: 0, y: 80, width: 80, height: 40 },
			accessibility_id: "send",
			text: "other",
		});
		const fuzzy = node({
			class: "UIButton",
			address: "0xb",
			frame: { x: 0, y: 0, width: 80, height: 40 },
			text: "send now",
		});
		const ranked = rankFindCandidates([fuzzy, exact], { accessibilityId: "send" });
		expect(ranked[0]!.address).toBe("0xa");
	});

	test("reading order beats larger area for the same label", () => {
		const big = node({
			class: "UILabel",
			address: "0xbig",
			frame: { x: 0, y: 200, width: 300, height: 80 },
			text: "Same",
			onScreen: true,
		});
		const front = node({
			class: "UILabel",
			address: "0xfront",
			frame: { x: 0, y: 10, width: 80, height: 20 },
			text: "Same",
			onScreen: true,
		});
		const ranked = rankFindCandidates([big, front], { text: "Same" });
		expect(ranked[0]!.address).toBe("0xfront");
	});
});

describe("tabIndexForTarget", () => {
	test("returns the item index inside ESTabBar", () => {
		const tree = node({
			class: "UIWindow",
			address: "0x1",
			frame: { x: 0, y: 0, width: 400, height: 800 },
			children: [
				{
					class: "ESTabBar",
					address: "0xbar",
					frame: { x: 0, y: 760, width: 400, height: 40 },
					children: [
						{
							class: "ESTabBarItemContainer",
							address: "0xf",
							frame: { x: 0, y: 0, width: 80, height: 40 },
							accessibilityIdentifier: "mainTab.item.feed",
						},
						{
							class: "ESTabBarItemContainer",
							address: "0xm",
							frame: { x: 320, y: 0, width: 80, height: 40 },
							accessibilityIdentifier: "mainTab.item.mine",
						},
					],
				},
			],
		});
		const mine = [...tree.walk()].find((n) => n.accessibilityId === "mainTab.item.mine")!;
		expect(tabIndexForTarget(tree, mine)).toBe(1);
		expect(tabIndexForTarget(tree, tree)).toBeNull();
	});
});
