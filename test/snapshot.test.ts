import { afterEach, describe, expect, test } from "bun:test";
import { ViewNode } from "../src/models.ts";
import { Cancelled } from "../src/errors.ts";
import {
	STABILITY_MAX_ROUNDS,
	STABILITY_MIN_NODES,
	snapshotStable,
	setSnapshotTestHooks,
} from "../src/tools/snapshot.ts";

afterEach(() => {
	setSnapshotTestHooks(null);
});

function tree(childCount: number): ViewNode {
	const children = Array.from({ length: Math.max(0, childCount) }, (_, i) => ({
		class: "UILabel",
		address: `0x${i + 1}`,
		frame: { x: 0, y: i * 20, width: 100, height: 20 },
		text: `n${i}`,
	}));
	return ViewNode.fromDict({
		class: "UIWindow",
		address: "0xwin",
		frame: { x: 0, y: 0, width: 400, height: 800 },
		children,
	});
}

describe("snapshotStable", () => {
	test("stability off fetches once", async () => {
		setSnapshotTestHooks({ retryDelayMs: 0 });
		let n = 0;
		const node = await snapshotStable(
			async () => {
				n += 1;
				return tree(STABILITY_MIN_NODES);
			},
			{ stability: false },
		);
		expect(n).toBe(1);
		expect(node.totalNodeCount()).toBe(STABILITY_MIN_NODES + 1);
	});

	test("two agreeing snapshots at/above the floor return on round 2", async () => {
		setSnapshotTestHooks({ retryDelayMs: 0 });
		let n = 0;
		await snapshotStable(async () => {
			n += 1;
			return tree(5);
		});
		expect(n).toBe(2);
	});

	test("waits until node-count stops changing", async () => {
		setSnapshotTestHooks({ retryDelayMs: 0 });
		const sizes = [2, 6, 6];
		let n = 0;
		const node = await snapshotStable(async () => {
			const size = sizes[Math.min(n, sizes.length - 1)]!;
			n += 1;
			return tree(size);
		});
		expect(n).toBe(3);
		expect(node.totalNodeCount()).toBe(7);
	});

	test("below the floor never confirms; returns the last snapshot", async () => {
		setSnapshotTestHooks({ retryDelayMs: 0 });
		let n = 0;
		const node = await snapshotStable(async () => {
			n += 1;
			return tree(1);
		});
		expect(n).toBe(STABILITY_MAX_ROUNDS);
		expect(node.totalNodeCount()).toBe(2);
	});

	test("abort during retry delay raises Cancelled", async () => {
		setSnapshotTestHooks({ retryDelayMs: 200 });
		const ac = new AbortController();
		const pending = snapshotStable(async () => tree(5), { signal: ac.signal });
		setTimeout(() => ac.abort(), 20);
		await expect(pending).rejects.toBeInstanceOf(Cancelled);
	});
});
