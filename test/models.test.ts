import { describe, expect, test } from "bun:test";
import { Frame, TapResult, VCNode, ViewNode } from "../src/models.ts";

describe("Frame", () => {
	test("fromAny handles dict, list, null, and w/h aliases", () => {
		expect(Frame.fromAny({ x: 1, y: 2, width: 3, height: 4 })).toMatchObject({ x: 1, y: 2, width: 3, height: 4 });
		expect(Frame.fromAny({ x: 1, y: 2, w: 3, h: 4 })).toMatchObject({ width: 3, height: 4 });
		expect(Frame.fromAny([5, 6, 7, 8])).toMatchObject({ x: 5, y: 6, width: 7, height: 8 });
		expect(Frame.fromAny(null)).toMatchObject({ x: 0, y: 0, width: 0, height: 0 });
	});

	test("area clamps negatives to zero", () => {
		expect(new Frame(0, 0, 10, 20).area).toBe(200);
		expect(new Frame(0, 0, -10, 20).area).toBe(0);
	});
});

describe("ViewNode.fromDict", () => {
	test("maps camelCase and snake_case fields", () => {
		const n = ViewNode.fromDict({
			class: "UILabel",
			address: "0x1",
			frame: { x: 0, y: 0, width: 100, height: 20 },
			text: "Hello",
			textSource: "attributedText",
			accessibilityIdentifier: "greeting",
			isKeyWindow: true,
			windowLevel: 1.5,
			onScreen: true,
			offscreenChildCount: 3,
			customField: "kept",
		});
		expect(n.cls).toBe("UILabel");
		expect(n.address).toBe("0x1");
		expect(n.text).toBe("Hello");
		expect(n.textSource).toBe("attributedText");
		expect(n.accessibilityId).toBe("greeting");
		expect(n.isKeyWindow).toBe(true);
		expect(n.windowLevel).toBe(1.5);
		expect(n.onScreen).toBe(true);
		expect(n.offscreenChildCount).toBe(3);
		expect(n.extra.customField).toBe("kept");
	});

	test("subviews alias and recursion", () => {
		const n = ViewNode.fromDict({
			class: "UIView",
			address: "0x1",
			subviews: [{ class: "UILabel", address: "0x2" }],
		});
		expect(n.children.length).toBe(1);
		expect(n.children[0]!.cls).toBe("UILabel");
	});

	test("wrapper dict collapses to Empty", () => {
		const n = ViewNode.fromDict({ windows: [] });
		expect(n.cls).toBe("Empty");
		expect(n.address).toBe("");
	});

	test("walk yields presented subtrees", () => {
		const n = ViewNode.fromDict({
			class: "UIWindow",
			address: "0x1",
			children: [{ class: "A", address: "0xa" }],
			presentedViews: [{ class: "Sheet", address: "0xs" }],
		});
		const classes = [...n.walk()].map((x) => x.cls);
		expect(classes).toContain("Sheet");
		expect(classes).toContain("A");
	});

	test("isVisible heuristic", () => {
		expect(ViewNode.fromDict({ class: "V", address: "1", frame: { width: 10, height: 10 } }).isVisible()).toBe(true);
		expect(ViewNode.fromDict({ class: "V", address: "1", hidden: true, frame: { width: 10, height: 10 } }).isVisible()).toBe(false);
		expect(ViewNode.fromDict({ class: "V", address: "1", alpha: 0, frame: { width: 10, height: 10 } }).isVisible()).toBe(false);
		expect(ViewNode.fromDict({ class: "V", address: "1", frame: { width: 0, height: 10 } }).isVisible()).toBe(false);
	});

	test("withExtra returns a copy without mutating", () => {
		const n = ViewNode.fromDict({ class: "V", address: "1" });
		const n2 = n.withExtra({ resolved: true });
		expect(n2.extra.resolved).toBe(true);
		expect(n.extra.resolved).toBeUndefined();
		expect(n2.cls).toBe("V");
	});
});

describe("VCNode.visibleLeaf", () => {
	test("presented modal wins", () => {
		const root = VCNode.fromDict({
			class: "Root",
			address: "0x1",
			presented: { class: "Modal", address: "0x2" },
		});
		expect(root.visibleLeaf().cls).toBe("Modal");
	});

	test("tab bar picks selected child", () => {
		const root = VCNode.fromDict({
			class: "UITabBarController",
			address: "0x1",
			children: [
				{ class: "Tab0", address: "0xa" },
				{ class: "Tab1", address: "0xb", isSelected: true },
			],
		});
		expect(root.visibleLeaf().cls).toBe("Tab1");
	});

	test("tab bar falls back to selectedIndex", () => {
		const root = VCNode.fromDict({
			class: "UITabBarController",
			address: "0x1",
			selectedIndex: 1,
			children: [
				{ class: "Tab0", address: "0xa" },
				{ class: "Tab1", address: "0xb" },
			],
		});
		expect(root.visibleLeaf().cls).toBe("Tab1");
	});

	test("nav controller picks last child", () => {
		const root = VCNode.fromDict({
			class: "UINavigationController",
			address: "0x1",
			viewControllers: [
				{ class: "First", address: "0xa" },
				{ class: "Top", address: "0xb" },
			],
		});
		expect(root.visibleLeaf().cls).toBe("Top");
	});

	test("selectedViewController preferred over index", () => {
		const root = VCNode.fromDict({
			class: "Container",
			address: "0x1",
			selectedViewController: { class: "Active", address: "0xc" },
			children: [{ class: "Other", address: "0xa" }],
		});
		expect(root.visibleLeaf().cls).toBe("Active");
	});
});

describe("TapResult.fromDict", () => {
	test("normalizes method and reads target/handledBy", () => {
		const r = TapResult.fromDict({ method: "public_api", address: "0x1", handledBy: "UIButton" });
		expect(r.method).toBe("public_api");
		expect(r.targetAddress).toBe("0x1");
		expect(r.handledBy).toBe("UIButton");
	});

	test("unknown method for unexpected values", () => {
		expect(TapResult.fromDict({ method: "weird" }).method).toBe("unknown");
		expect(TapResult.fromDict(null).method).toBe("unknown");
	});

	test("via alias maps to method", () => {
		expect(TapResult.fromDict({ via: "coordinate" }).method).toBe("coordinate");
	});
});
