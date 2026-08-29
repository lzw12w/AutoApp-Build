/**
 * Formatters shared by view/VC tools. Ported from the `_node_summary` /
 * `_vc_summary` helpers in ios_inspector_agent/actions/base.py — compact,
 * LLM-facing projections of ViewNode / VCNode.
 */
import type { VCNode, ViewNode } from "../models.ts";

function halfUpRound(v: number): number {
	return Math.floor(v + 0.5);
}

/** Compact view-node dict for LLM consumption. Frame as [x,y,w,h] in points. */
export function nodeSummary(node: ViewNode): Record<string, unknown> {
	const out: Record<string, unknown> = { address: node.address, class: node.cls };
	const fw = node.frame.width;
	const fh = node.frame.height;
	if (fw > 0 && fh > 0) {
		out.frame = [halfUpRound(node.frame.x), halfUpRound(node.frame.y), halfUpRound(fw), halfUpRound(fh)];
	}
	const text = (node.text || "").slice(0, 80);
	if (text) {
		out.text = text;
		if (node.textSource) out.text_source = node.textSource;
	}
	if (node.accessibilityId) out.aid = node.accessibilityId;
	const a11yLabel = node.extra.accessibilityLabel ?? node.extra.accessibility_label;
	if (a11yLabel) out.accessibility_label = a11yLabel;
	const propertyName = node.extra.propertyName ?? node.extra.property_name;
	if (propertyName) out.property_name = propertyName;
	if (node.hidden) out.hidden = true;
	if (node.onScreen === false) out.on_screen = false;
	if (node.alpha < 0.99) out.alpha = Math.round(node.alpha * 1000) / 1000;
	if (node.offscreenChildCount) out.offscreen_child_count = node.offscreenChildCount;
	const symbolName = node.extra.imageSymbolName ?? node.extra.image_symbol_name;
	if (symbolName) out.image_symbol_name = symbolName;
	const assetName = node.extra.imageAssetName ?? node.extra.image_asset_name;
	if (assetName) out.image_asset_name = assetName;
	let hasImage = node.extra.hasImage;
	if (hasImage === undefined) hasImage = node.extra.has_image;
	if (hasImage === false) out.has_image = false;
	const contentMode = node.extra.contentMode ?? node.extra.content_mode;
	if (contentMode && contentMode !== "scaleToFill") out.content_mode = contentMode;
	return out;
}

/** Recursive node → nested dict, capped at `depth`. */
export function nodeToDict(node: ViewNode, depth: number): Record<string, unknown> {
	const out = nodeSummary(node);
	if (depth > 0 && node.children.length > 0) {
		out.children = node.children.map((c) => nodeToDict(c, depth - 1));
	}
	return out;
}

/** Compact VC-tree dict; `root` adds a `visible_vc` pointer to the on-screen leaf. */
export function vcSummary(vc: VCNode, root = true): Record<string, unknown> {
	const out: Record<string, unknown> = { class: vc.cls, address: vc.address, title: vc.title };
	if (vc.selected) out.selected = true;
	if (vc.selectedIndex !== null) out.selected_index = vc.selectedIndex;
	if (vc.selectedChild !== null) out.selected_view_controller = vcSummary(vc.selectedChild, false);
	if (vc.children.length > 0) out.children = vc.children.map((c) => vcSummary(c, false));
	if (vc.presented) out.presented = vcSummary(vc.presented, false);
	if (root) {
		const leaf = vc.visibleLeaf();
		if (leaf !== vc) {
			const v: Record<string, unknown> = { class: leaf.cls, address: leaf.address };
			if (leaf.title) v.title = leaf.title;
			out.visible_vc = v;
		}
	}
	return out;
}
