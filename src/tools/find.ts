/**
 * Local view-finder helpers for tap_with_diff / wait_for.
 * Ported from ios_inspector_agent/actions/interact.py
 * (_selector_matches, _local_find_candidates, _ambiguous_find_and_tap).
 */
import type { ViewNode } from "../models.ts";

export interface FindSelector {
	text?: string;
	cls?: string;
	accessibilityId?: string;
	propertyName?: string;
}

export function hasFindSelector(sel: FindSelector): boolean {
	return Boolean(sel.text || sel.cls || sel.accessibilityId || sel.propertyName);
}

export function findNodeByAddress(root: ViewNode | null, address: string | undefined): ViewNode | null {
	if (!root || !address) return null;
	for (const node of root.walk()) {
		if (node.address === address) return node;
	}
	return null;
}

export function selectorMatches(node: ViewNode, sel: FindSelector): boolean {
	if (sel.cls && !node.cls.toLowerCase().includes(sel.cls.toLowerCase())) return false;
	if (sel.text && (!node.text || !node.text.toLowerCase().includes(sel.text.toLowerCase()))) return false;
	if (sel.accessibilityId && node.accessibilityId !== sel.accessibilityId) return false;
	if (sel.propertyName) {
		const actual = node.extra.propertyName ?? node.extra.property_name;
		if (!actual || !String(actual).toLowerCase().includes(sel.propertyName.toLowerCase())) return false;
	}
	return true;
}

export function localFindCandidates(root: ViewNode, sel: FindSelector, visibleOnly = true): ViewNode[] {
	let results = [...root.walk()].filter((node) => selectorMatches(node, sel));
	if (visibleOnly) {
		const serverVisible = results.filter((n) => n.onScreen === true);
		results = serverVisible.length > 0 ? serverVisible : results.filter((n) => n.isVisible());
	}
	return results;
}

/**
 * A class-only selector such as class=UILabel is a discovery query, not a
 * safe tap target. Text / accessibility_id / property_name give enough
 * intent to pick the best visible candidate.
 */
export function ambiguousFindAndTap(
	candidates: ViewNode[],
	sel: FindSelector,
	index: number | undefined,
): boolean {
	if (index !== undefined || candidates.length <= 1) return false;
	return !sel.text && !sel.accessibilityId && !sel.propertyName;
}

export const FIND_TREE_DEPTH = 25;

function norm(value: unknown): string {
	return String(value ?? "").trim().toLowerCase();
}

function matchRank(value: unknown, query: unknown): number {
	const q = norm(query);
	if (!q) return 0;
	const v = norm(value);
	if (!v) return 4;
	if (v === q) return 0;
	if (v.startsWith(q)) return 1;
	if (v.includes(q)) return 2;
	return 4;
}

function boolRank(value: boolean | null): number {
	if (value === true) return 0;
	if (value === null) return 1;
	return 2;
}

function visibleRatio(node: ViewNode): number {
	const raw = node.extra.visibleRatio ?? node.extra.visible_ratio;
	if (raw === undefined || raw === null) return node.onScreen === false ? 0 : 1;
	const n = Number(raw);
	if (!Number.isFinite(n)) return node.onScreen === false ? 0 : 1;
	return Math.max(0, Math.min(1, n));
}

function interactiveRank(node: ViewNode): number {
	if (node.extra.userInteractionEnabled === false) return 3;
	const cls = node.cls.toLowerCase();
	if (["button", "control", "cell", "switch", "textfield", "textview", "collectionviewcell", "tableviewcell"].some((t) => cls.includes(t))) {
		return 0;
	}
	if (cls.includes("label") || cls.includes("imageview")) return 1;
	return 2;
}

function sizeRank(node: ViewNode): number {
	const area = node.frame.area;
	if (area <= 0) return 4;
	if (node.frame.width < 8 || node.frame.height < 8) return 3;
	if (area > 120_000) return 3;
	if (node.frame.width < 24 || node.frame.height < 18) return 1;
	return 0;
}

function findRankKey(node: ViewNode, sel: FindSelector): number[] {
	const prop = node.extra.propertyName ?? node.extra.property_name;
	return [
		node.isVisible() ? 0 : 1,
		boolRank(node.onScreen),
		matchRank(node.accessibilityId, sel.accessibilityId),
		matchRank(prop, sel.propertyName),
		matchRank(node.text, sel.text),
		matchRank(node.cls, sel.cls),
		node.textSource ? 1 : 0,
		interactiveRank(node),
		-visibleRatio(node),
		node.frame.x >= 0 && node.frame.y >= 0 ? 0 : 1,
		sizeRank(node),
		node.frame.y,
		node.frame.x,
		-Math.min(node.frame.area, 20_000),
	];
}

/** Rank like Python InspectorSession.rank_find_candidates (lower key wins). */
export function rankFindCandidates(candidates: ViewNode[], sel: FindSelector = {}): ViewNode[] {
	return [...candidates].sort((a, b) => {
		const ka = findRankKey(a, sel);
		const kb = findRankKey(b, sel);
		for (let i = 0; i < ka.length; i++) {
			if (ka[i]! !== kb[i]!) return ka[i]! - kb[i]!;
		}
		return 0;
	});
}

/** Visible-first ranking used when no query is available. */
export function rankCandidates(candidates: ViewNode[]): ViewNode[] {
	return rankFindCandidates(candidates, {});
}

export function preferVisible(nodes: ViewNode[]): ViewNode[] {
	return nodes.filter((n) => !n.hidden && n.frame.width > 0 && n.frame.height > 0);
}

export function applyVisibleOnly(nodes: ViewNode[], visibleOnly: boolean): ViewNode[] {
	if (!visibleOnly || nodes.length === 0) return nodes;
	const serverVisible = nodes.filter((n) => n.onScreen === true);
	return serverVisible.length > 0 ? serverVisible : nodes;
}

function isTabBarClass(cls: string): boolean {
	const c = cls.toLowerCase();
	return c.includes("tabbar") && !c.includes("item");
}

function isTabItemClass(cls: string): boolean {
	const c = cls.toLowerCase();
	return c.includes("tabbaritem") || c.includes("tab_bar_item");
}

/** Index of the tab-bar item that owns `target`, or null if not inside a bar. */
export function tabIndexForTarget(root: ViewNode, target: ViewNode): number | null {
	const addr = target.address;
	if (!addr) return null;
	for (const bar of root.walk()) {
		if (!isTabBarClass(bar.cls)) continue;
		const items = bar.children.filter((c) => isTabItemClass(c.cls));
		if (items.length === 0) continue;
		const idx = items.findIndex(
			(item) => item.address === addr || [...item.walk()].some((n) => n.address === addr),
		);
		if (idx >= 0) return idx;
	}
	return null;
}
