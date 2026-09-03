/**
 * Knowledge observer. Ported from ios_inspector_agent/knowledge/observer.py,
 * adapted to pi's event model: instead of a standalone debounce loop, the
 * extension drives `recordAction` (before a mutating tool) and `observe`
 * (after it, with a fresh view+VC snapshot). Page identity, matching, upsert,
 * and transition attribution match the Python commit path.
 *
 * The pipeline: fingerprint → match against store → upsert page → if the page
 * changed and a recent action was recorded, record a transition attributed to
 * that action (content-blind via `__identity__`; tap may later replace
 * identity with a role-level handle).
 */
import type { VCNode, ViewNode } from "../models.ts";
import { computeFingerprint, type PageFingerprint } from "./fingerprint.ts";
import { PageMatcher } from "./graph.ts";
import type { KnowledgeStore } from "./store.ts";

interface ActionEvent {
	kind: string;
	params: Record<string, unknown>;
	identity: Record<string, unknown>;
	issuedMs: number;
}

/** Fixed-capacity ring; the observer pops the most recent action on commit. */
class ActionLog {
	private events: ActionEvent[] = [];
	constructor(private readonly capacity = 4) {}
	push(event: ActionEvent): void {
		this.events.push(event);
		if (this.events.length > this.capacity) this.events.shift();
	}
	popLatest(): ActionEvent | null {
		return this.events.pop() ?? null;
	}
	peekLatest(): ActionEvent | null {
		return this.events[this.events.length - 1] ?? null;
	}
	clear(): void {
		this.events = [];
	}
	get size(): number {
		return this.events.length;
	}
}

export interface ObserverStats {
	observations: number;
	pageCommits: number;
	transitionsRecorded: number;
	unattributedStale: number;
	unattributedNoAction: number;
	failedTransitions: number;
}

export interface KnowledgeObserverOptions {
	/** Actions older than this (ms) can't plausibly have caused a commit. */
	actionStalenessMs?: number;
}

export class KnowledgeObserver {
	private readonly store: KnowledgeStore;
	private readonly matcher: PageMatcher;
	private readonly actionLog = new ActionLog();
	private readonly actionStalenessMs: number;

	private currentPageId: string | null = null;
	private currentFp: PageFingerprint | null = null;

	readonly stats: ObserverStats = {
		observations: 0,
		pageCommits: 0,
		transitionsRecorded: 0,
		unattributedStale: 0,
		unattributedNoAction: 0,
		failedTransitions: 0,
	};

	constructor(store: KnowledgeStore, options: KnowledgeObserverOptions = {}) {
		this.store = store;
		this.matcher = new PageMatcher(store);
		this.actionStalenessMs = options.actionStalenessMs ?? 8000;
	}

	get currentPage(): string | null {
		return this.currentPageId;
	}

	/** Record a UI-mutating action just before it fires (for later attribution). */
	recordAction(kind: string, params: Record<string, unknown> = {}, identity: Record<string, unknown> = {}): void {
		this.actionLog.push({ kind, params, identity, issuedMs: Date.now() });
	}

	/**
	 * Replace params/identity on the latest buffered action of `kind`.
	 * Tap tools record kwargs first, then swap in a stable node summary once
	 * the target is resolved — hex addresses must not survive into the edge.
	 */
	enrichLatestAction(kind: string, params: Record<string, unknown>, identity: Record<string, unknown> = {}): void {
		const event = this.actionLog.peekLatest();
		if (event === null || event.kind !== kind) return;
		event.params = { ...params };
		event.identity = { ...identity };
	}

	/**
	 * Observe the current screen and commit page/transition state. `postAction`
	 * true means a mutating tool just fired — commit immediately (no debounce)
	 * and don't discard the pending action as stale.
	 */
	observe(view: ViewNode, vc: VCNode | null, options: { postAction?: boolean; visualHash?: string | null } = {}): void {
		this.stats.observations += 1;
		const fp = computeFingerprint(view, vc, { visualHash: options.visualHash ?? null });

		// Same page as committed → nothing to do (recency bump is implicit via upsert).
		if (this.currentFp !== null && this.isSameCommitted(fp)) return;

		const match = this.matcher.match(fp);
		let committedPageId: string;
		if (match.decision === "new" || match.pageId === null) {
			committedPageId = this.store.upsertPage(fp);
		} else {
			this.store.upsertPage(fp, { existingPageId: match.pageId });
			committedPageId = match.pageId;
		}
		this.stats.pageCommits += 1;

		const now = Date.now();
		if (this.currentPageId !== null && this.currentPageId !== committedPageId) {
			const action = this.actionLog.popLatest();
			let attribute = action !== null;
			let actionKind: string;
			let actionParams: Record<string, unknown>;
			let latencyMs: number;

			if (action !== null && !options.postAction && now - action.issuedMs > this.actionStalenessMs) {
				// Too old to have plausibly caused this commit — stash it back.
				this.actionLog.push(action);
				attribute = false;
				this.stats.unattributedStale += 1;
				actionKind = "unattributed_stale";
				actionParams = { reason: "latest_action_older_than_staleness_window", age_ms: now - action.issuedMs, kind_hint: action.kind };
				latencyMs = 0;
			} else if (attribute && action !== null) {
				actionKind = action.kind;
				// Always inject __identity__ (even when empty) — the content-blind
				// dedup signal. Empty means "a tap is a tap", not "no info".
				actionParams = { ...action.params, __identity__: { ...action.identity } };
				latencyMs = Math.max(0, now - action.issuedMs);
			} else {
				this.stats.unattributedNoAction += 1;
				actionKind = "unattributed_no_action";
				actionParams = { reason: "action_log_empty" };
				latencyMs = 0;
			}

			try {
				this.store.recordTransition(this.currentPageId, committedPageId, {
					actionType: actionKind,
					actionParams,
					latencyMs,
					success: true,
				});
				this.stats.transitionsRecorded += 1;
			} catch {
				// best-effort: never let knowledge recording break a tool call
			}
		}

		this.currentPageId = committedPageId;
		this.currentFp = fp;
	}

	/**
	 * Record a self-loop failure edge for the latest buffered action.
	 * Planner `failurePenalty` only works if failed taps exist in the graph.
	 */
	recordFailedTransition(): void {
		if (this.currentPageId === null) return;
		const action = this.actionLog.popLatest();
		if (action === null) return;
		try {
			this.store.recordTransition(this.currentPageId, this.currentPageId, {
				actionType: action.kind,
				actionParams: { ...action.params, __identity__: { ...action.identity } },
				latencyMs: Math.max(0, Date.now() - action.issuedMs),
				success: false,
			});
			this.stats.failedTransitions += 1;
		} catch {
			// best-effort
		}
	}

	private isSameCommitted(fp: PageFingerprint): boolean {
		const cur = this.currentFp;
		if (cur === null) return false;
		// Same page identity: same vc_class (matcher policy) or identical hashes.
		if (fp.vcClass && cur.vcClass) return fp.vcClass === cur.vcClass;
		return fp.skeletonHash === cur.skeletonHash && fp.semanticHash === cur.semanticHash;
	}
}
