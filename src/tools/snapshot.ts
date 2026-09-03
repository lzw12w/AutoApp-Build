/**
 * Stable view-hierarchy snapshot. Ported from
 * ios_inspector_agent/actions/inspect.py::ViewHierarchyAction._snapshot_stable.
 *
 * Mid-transition trees are tiny or still mutating. We take up to N snapshots
 * and return the first one whose node-count matches the previous round and
 * clears a minimum size floor. If nothing settles, the last snapshot is
 * returned rather than failing.
 */
import { Cancelled } from "../errors.ts";
import type { ViewNode } from "../models.ts";
import { sleepAbortable } from "./poll.ts";

/** Server caps view_hierarchy at 50; real iOS trees rarely go deeper. */
export const DIGEST_DEPTH = 50;
export const STABILITY_MIN_NODES = 4;
export const STABILITY_MAX_ROUNDS = 4;
export const STABILITY_RETRY_DELAY_MS = 250;

interface SnapshotHooks {
	retryDelayMs?: number;
}

let testHooks: SnapshotHooks | null = null;

/** Test seam. Pass `null` to restore production delay. */
export function setSnapshotTestHooks(hooks: SnapshotHooks | null): void {
	testHooks = hooks;
}

function retryDelayMs(): number {
	const override = testHooks?.retryDelayMs;
	if (override !== undefined) return Math.max(0, override);
	return STABILITY_RETRY_DELAY_MS;
}

export interface SnapshotStableOptions {
	/** When false, fetch once and return. Default true. */
	stability?: boolean;
	signal?: AbortSignal;
}

/**
 * Fetch a view tree, optionally waiting until two consecutive node-counts agree.
 *
 * `fetch` is called once per round. Cancellation via `signal` aborts between
 * rounds the same way Python waits on the session cancel event.
 */
export async function snapshotStable(
	fetch: () => Promise<ViewNode>,
	options: SnapshotStableOptions = {},
): Promise<ViewNode> {
	const stability = options.stability !== false;
	const rounds = stability ? STABILITY_MAX_ROUNDS : 1;
	let lastCount = -1;
	let lastNode: ViewNode | null = null;
	let node!: ViewNode;

	for (let i = 0; i < rounds; i++) {
		if (options.signal?.aborted) throw new Cancelled();
		node = await fetch();
		const count = node.totalNodeCount();
		if (!stability) return node;

		if (i === 0) {
			lastCount = count;
			lastNode = node;
		} else if (count === lastCount && count >= STABILITY_MIN_NODES) {
			return node;
		} else {
			lastCount = count;
			lastNode = node;
		}

		await sleepAbortable(retryDelayMs(), options.signal);
	}

	return lastNode ?? node;
}
