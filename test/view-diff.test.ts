import { describe, expect, test } from "bun:test";
import { ViewNode } from "../src/models.ts";
import { diffViewTrees } from "../src/tools/view-diff.ts";

function node(raw: Record<string, unknown>): ViewNode {
	return ViewNode.fromDict(raw);
}

describe("diffViewTrees", () => {
	test("unchanged trees report changed=false", () => {
		const tree = node({
			class: "UIWindow",
			address: "0x1",
			frame: { x: 0, y: 0, width: 400, height: 800 },
			children: [{ class: "UILabel", address: "0xa", frame: { x: 0, y: 0, width: 100, height: 20 }, text: "Hi" }],
		});
		const diff = diffViewTrees(tree, tree);
		expect(diff.changed).toBe(false);
		expect(diff.summary).toContain("unchanged");
		expect(diff.diff.added_count).toBe(0);
	});

	test("added content-bearing leaf beats empty container in the display cap", () => {
		const before = node({
			class: "UIWindow",
			address: "0x1",
			frame: { x: 0, y: 0, width: 400, height: 800 },
		});
		const after = node({
			class: "UIWindow",
			address: "0x1",
			frame: { x: 0, y: 0, width: 400, height: 800 },
			children: [
				{ class: "UIView", address: "0xc", frame: { x: 0, y: 0, width: 400, height: 40 } },
				{ class: "UILabel", address: "0xl", frame: { x: 0, y: 40, width: 100, height: 20 }, text: "Hello" },
			],
		});
		const diff = diffViewTrees(before, after, 1);
		expect(diff.diff.added_count).toBe(2);
		expect(diff.diff.added).toHaveLength(1);
		expect(diff.diff.added[0]!.text).toBe("Hello");
		expect(diff.diff.omitted_for_display.added).toBe(1);
		expect(diff.diff.added[0]!.frame).toBeUndefined();
	});

	test("icon swap shows up as changed fields, not added/removed", () => {
		const before = node({
			class: "UIImageView",
			address: "0xi",
			frame: { x: 0, y: 0, width: 24, height: 24 },
			imageSymbolName: "play.fill",
			hasImage: true,
		});
		const after = node({
			class: "UIImageView",
			address: "0xi",
			frame: { x: 0, y: 0, width: 24, height: 24 },
			imageSymbolName: "pause.fill",
			hasImage: true,
		});
		const diff = diffViewTrees(before, after);
		expect(diff.changed).toBe(true);
		expect(diff.diff.changed_count).toBe(1);
		expect(diff.diff.changed[0]!.fields.image_symbol_name).toEqual({
			before: "play.fill",
			after: "pause.fill",
		});
	});
});
