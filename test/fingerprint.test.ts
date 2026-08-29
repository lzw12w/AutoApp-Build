import { describe, expect, test } from "bun:test";
import { VCNode, ViewNode } from "../src/models.ts";
import {
	computeFingerprint,
	hammingDistance,
	isRoleAid,
	isVolatileText,
	skeletonHash,
} from "../src/knowledge/fingerprint.ts";

function win(children: unknown[], extra: Record<string, unknown> = {}): ViewNode {
	return ViewNode.fromDict({
		class: "UIWindow",
		address: "0x1",
		frame: { x: 0, y: 0, width: 400, height: 800 },
		children,
		...extra,
	});
}

describe("hammingDistance", () => {
	test("zero for identical", () => {
		expect(hammingDistance("abcd", "abcd")).toBe(0);
	});
	test("counts differing bits", () => {
		expect(hammingDistance("0", "1")).toBe(1); // 0000 vs 0001
		expect(hammingDistance("0", "f")).toBe(4); // 0000 vs 1111
	});
	test("length mismatch is worst case", () => {
		expect(hammingDistance("ab", "abcd")).toBe(16);
	});
});

describe("skeletonHash — data invariance", () => {
	test("same structure, different text → same hash", () => {
		const a = win([
			{ class: "UILabel", address: "0xa", frame: { x: 0, y: 0, width: 100, height: 20 }, text: "Hello" },
		]);
		const b = win([
			{ class: "UILabel", address: "0xb", frame: { x: 0, y: 0, width: 100, height: 20 }, text: "Goodbye world" },
		]);
		expect(skeletonHash(a)).toBe(skeletonHash(b));
	});

	test("list length within a bucket → same hash", () => {
		const cells = (n: number) =>
			win(
				Array.from({ length: n }, (_, i) => ({
					class: "FeedCell",
					address: `0x${i}`,
					frame: { x: 0, y: i * 60, width: 400, height: 60 },
				})),
			);
		// 7 and 9 both fall in the "medium list" (6-20) bucket.
		expect(skeletonHash(cells(7))).toBe(skeletonHash(cells(9)));
	});

	test("different structure → different hash", () => {
		const a = win([{ class: "UILabel", address: "0xa", frame: { x: 0, y: 0, width: 100, height: 20 } }]);
		const b = win([{ class: "UIButton", address: "0xb", frame: { x: 0, y: 0, width: 100, height: 20 } }]);
		expect(skeletonHash(a)).not.toBe(skeletonHash(b));
	});

	test("deterministic across repeated calls", () => {
		const a = win([{ class: "UILabel", address: "0xa", frame: { x: 0, y: 0, width: 100, height: 20 } }]);
		expect(skeletonHash(a)).toBe(skeletonHash(a));
	});
});

describe("isVolatileText", () => {
	test("short UI copy is stable", () => {
		expect(isVolatileText("Send")).toBe(false);
		expect(isVolatileText("Add to library")).toBe(false);
	});
	test("data-like strings are volatile", () => {
		expect(isVolatileText("¥199")).toBe(true);
		expect(isVolatileText("2026-08-29")).toBe(true);
		expect(isVolatileText("a very long author name that exceeds limit")).toBe(true);
		expect(isVolatileText("")).toBe(true);
	});
});

describe("isRoleAid", () => {
	test("developer role aids accepted", () => {
		expect(isRoleAid("btn_like")).toBe(true);
		expect(isRoleAid("feed_cell")).toBe(true);
	});
	test("content-bearing aids rejected", () => {
		expect(isRoleAid("aweme_cell_7234567891234")).toBe(false);
		expect(isRoleAid("cell_a3f2e91d")).toBe(false);
		expect(isRoleAid("MixedCase")).toBe(false);
		expect(isRoleAid("")).toBe(false);
	});
});

describe("computeFingerprint semantic — content-blind", () => {
	function vc(cls: string): VCNode {
		return VCNode.fromDict({ class: cls, address: "0xvc" });
	}
	test("same template + VC class, different content → same semantic hash", () => {
		const a = win([{ class: "FeedCell", address: "0xa", frame: { x: 0, y: 0, width: 400, height: 60 }, text: "Cat video" }]);
		const b = win([{ class: "FeedCell", address: "0xb", frame: { x: 0, y: 0, width: 400, height: 60 }, text: "Dog video" }]);
		const fa = computeFingerprint(a, vc("FeedViewController"));
		const fb = computeFingerprint(b, vc("FeedViewController"));
		expect(fa.semanticHash).toBe(fb.semanticHash);
		expect(fa.vcClass).toBe("FeedViewController");
	});

	test("different VC class → different semantic hash", () => {
		const view = win([{ class: "UILabel", address: "0xa", frame: { x: 0, y: 0, width: 100, height: 20 } }]);
		const fa = computeFingerprint(view, vc("FeedViewController"));
		const fb = computeFingerprint(view, vc("SettingsViewController"));
		expect(fa.semanticHash).not.toBe(fb.semanticHash);
	});
});
