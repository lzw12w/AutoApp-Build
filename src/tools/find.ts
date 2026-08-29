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

function hasReadableContent(node: ViewNode): boolean {
	const extra = node.extra ?? {};
	return Boolean(
		node.text ||
			extra.imageSymbolName ||
			extra.image_symbol_name ||
			extra.imageAssetName ||
			extra.image_asset_name ||
			extra.accessibilityLabel ||
			extra.accessibility_label,
	);
}

/** Visible + content-bearing first; original order as the remaining tiebreaker. */
export function rankCandidates(candidates: ViewNode[]): ViewNode[] {
	return candidates
		.map((node, index) => ({ node, index }))
		.sort((a, b) => {
			const av = a.node.isVisible() ? 0 : 1;
			const bv = b.node.isVisible() ? 0 : 1;
			if (av !== bv) return av - bv;
			const ac = hasReadableContent(a.node) ? 0 : 1;
			const bc = hasReadableContent(b.node) ? 0 : 1;
			if (ac !== bc) return ac - bc;
			return a.index - b.index;
		})
		.map((x) => x.node);
}
