import { describe, expect, test } from "bun:test";
import { DEFAULT_SWIPE_FRAME, pickDefaultScrollView, scrollDeltaToSwipePoints } from "../src/tools/scroll-motion.ts";
import { ViewNode } from "../src/models.ts";

describe("scrollDeltaToSwipePoints", () => {
	test("positive dy swipes upward from below center (reveals lower content)", () => {
		const pts = scrollDeltaToSwipePoints(0, 400, DEFAULT_SWIPE_FRAME);
		expect(pts.start_y).toBeGreaterThan(pts.end_y);
		expect(pts.start_x).toBe(pts.end_x);
	});

	test("zero delta collapses to the center", () => {
		const pts = scrollDeltaToSwipePoints(0, 0, DEFAULT_SWIPE_FRAME);
		expect(pts.start_x).toBe(pts.end_x);
		expect(pts.start_y).toBe(pts.end_y);
	});
});

describe("pickDefaultScrollView", () => {
	test("vertical scroll prefers collection over a named horizontal pager", () => {
		const tree = ViewNode.fromDict({
			class: "UIWindow",
			address: "0x1",
			frame: { x: 0, y: 0, width: 428, height: 926 },
			children: [
				{
					class: "ScrollControllableScrollView",
					address: "0xhoriz",
					frame: { x: 0, y: 0, width: 428, height: 848 },
					propertyName: "horizontalScrollView",
					onScreen: true,
				},
				{
					class: "ScrollControllableCollectionView",
					address: "0xfeed",
					frame: { x: 0, y: 0, width: 428, height: 856 },
					propertyName: "collectionView",
					onScreen: true,
				},
			],
		});
		expect(pickDefaultScrollView(tree, 0, 400)?.address).toBe("0xfeed");
	});
});
