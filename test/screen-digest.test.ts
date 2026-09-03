import { describe, expect, test } from "bun:test";
import { ViewNode } from "../src/models.ts";
import { buildScreenDigest, vcLabelFromVc } from "../src/screen-digest.ts";

function node(raw: Record<string, unknown>): ViewNode {
	return ViewNode.fromDict(raw);
}

describe("buildScreenDigest", () => {
	test("drops hidden / off-screen / transparent subtrees", () => {
		const tree = node({
			class: "UIWindow",
			address: "0x1",
			frame: { x: 0, y: 0, width: 400, height: 800 },
			children: [
				{ class: "UILabel", address: "0xa", frame: { x: 0, y: 0, width: 100, height: 20 }, text: "Visible" },
				{ class: "UILabel", address: "0xb", frame: { x: 0, y: 30, width: 100, height: 20 }, text: "Hidden", hidden: true },
				{ class: "UILabel", address: "0xc", frame: { x: 0, y: 60, width: 100, height: 20 }, text: "Offscreen", onScreen: false },
				{ class: "UILabel", address: "0xd", frame: { x: 0, y: 90, width: 100, height: 20 }, text: "Transparent", alpha: 0 },
			],
		});
		const digest = buildScreenDigest(tree, "HomeVC");
		expect(digest).toContain('"Visible"');
		expect(digest).not.toContain("Hidden");
		expect(digest).not.toContain("Offscreen");
		expect(digest).not.toContain("Transparent");
	});

	test("drops pure-layout containers but keeps interesting descendants", () => {
		const tree = node({
			class: "UIWindow",
			address: "0x1",
			frame: { x: 0, y: 0, width: 400, height: 800 },
			children: [
				{
					class: "UIStackView",
					address: "0xstack",
					frame: { x: 0, y: 0, width: 400, height: 100 },
					children: [{ class: "UIButton", address: "0xbtn", frame: { x: 0, y: 0, width: 80, height: 40 }, text: "Go" }],
				},
			],
		});
		const digest = buildScreenDigest(tree);
		expect(digest).toContain("UIButton");
		expect(digest).toContain('"Go"');
		expect(digest).not.toContain("UIStackView");
	});

	test("drops full-screen layout container that only has a Tap recognizer", () => {
		const tree = node({
			class: "UIWindow",
			address: "0x1",
			frame: { x: 0, y: 0, width: 400, height: 800 },
			children: [
				{
					class: "UILayoutContainerView",
					address: "0xlayout",
					frame: { x: 0, y: 0, width: 400, height: 800 },
					gestureRecognizers: ["UITapGestureRecognizer"],
					children: [{ class: "UIButton", address: "0xbtn", frame: { x: 10, y: 10, width: 80, height: 40 }, text: "Go" }],
				},
			],
		});
		const digest = buildScreenDigest(tree);
		expect(digest).toContain('"Go"');
		expect(digest).not.toContain("UILayoutContainerView");
		expect(digest).not.toContain("0xlayout");
	});

	test("folds leaf-only cell (icon + label) into one line", () => {
		const tree = node({
			class: "UIWindow",
			address: "0x1",
			frame: { x: 0, y: 0, width: 400, height: 800 },
			children: [
				{
					class: "StoryCell",
					address: "0xcell",
					frame: { x: 0, y: 0, width: 400, height: 60 },
					children: [
						{ class: "UIImageView", address: "0ximg", frame: { x: 0, y: 0, width: 40, height: 40 }, imageAssetName: "icon_x" },
						{ class: "UILabel", address: "0xlbl", frame: { x: 50, y: 0, width: 200, height: 40 }, text: "Debug" },
					],
				},
			],
		});
		const digest = buildScreenDigest(tree);
		const lines = digest.split("\n").filter((l) => l.includes("StoryCell") || l.includes("0ximg") || l.includes("0xlbl"));
		// The cell line carries the folded text + asset; children are suppressed.
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("StoryCell");
		expect(lines[0]).toContain('"Debug"');
		expect(lines[0]).toContain("asset=icon_x");
	});

	test("folding a labeled child keeps its role aid on the parent line", () => {
		const tree = node({
			class: "UIWindow",
			address: "0x1",
			frame: { x: 0, y: 0, width: 400, height: 800 },
			children: [
				{
					class: "UIView",
					address: "0xwrap",
					frame: { x: 0, y: 100, width: 380, height: 80 },
					propertyName: "contentView",
					children: [
						{
							class: "YYLabel",
							address: "0xlbl",
							frame: { x: 8, y: 8, width: 360, height: 64 },
							text: "（你和旧友出门吃夜宵，Chloe看向远处）",
							accessibilityIdentifier: "messageBubble.text",
						},
					],
				},
			],
		});
		const digest = buildScreenDigest(tree);
		expect(digest).toContain("aid=messageBubble.text");
		expect(digest).toContain("Chloe");
	});

	test("empty screen renders a placeholder line", () => {
		const tree = node({ class: "UIWindow", address: "0x1", frame: { x: 0, y: 0, width: 400, height: 800 } });
		const digest = buildScreenDigest(tree);
		expect(digest).toContain("(no content-bearing views on screen)");
	});

	test("header reports node counts and VC label", () => {
		const tree = node({
			class: "UIWindow",
			address: "0x1",
			frame: { x: 0, y: 0, width: 400, height: 800 },
			children: [{ class: "UILabel", address: "0xa", frame: { x: 0, y: 0, width: 100, height: 20 }, text: "Hi" }],
		});
		const digest = buildScreenDigest(tree, "MyVC");
		expect(digest.split("\n")[0]).toContain("VC: MyVC");
		expect(digest.split("\n")[0]).toContain("nodes=");
		expect(digest.split("\n")[0]).toContain("shown=");
	});
});

describe("vcLabelFromVc", () => {
	test("prefers visible leaf title", () => {
		const vc = {
			visibleLeaf: () => ({ title: "Order Detail", cls: "OrderVC" }),
		};
		expect(vcLabelFromVc(vc)).toBe("Order Detail");
	});
	test("falls back to class when no title", () => {
		const vc = { visibleLeaf: () => ({ title: null, cls: "FeedVC" }) };
		expect(vcLabelFromVc(vc)).toBe("FeedVC");
	});
	test("null vc yields null", () => {
		expect(vcLabelFromVc(null)).toBeNull();
	});
});
