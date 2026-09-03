/**
 * Compact view-hierarchy diff. Ported from
 * ios_inspector_agent/actions/view_diff.py.
 *
 * Counts are exact; per-category samples are content-first sorted and capped.
 * A non-zero `omitted_for_display` is a display cap, not a failed tap.
 */
import type { ViewNode } from "../models.ts";

export const DIFF_MAX_ENTRIES = 30;

const DIFF_FIELDS = [
	"class",
	"frame",
	"text",
	"text_source",
	"aid",
	"accessibility_label",
	"property_name",
	"hidden",
	"alpha",
	"on_screen",
	"has_image",
	"image_symbol_name",
	"image_asset_name",
	"content_mode",
] as const;

type PathSeg = number | string;
type FieldBag = Record<string, unknown>;

interface FlatEntry {
	path: PathSeg[];
	fields: FieldBag;
	summary: FieldBag;
}

export interface ViewDiff {
	kind: "view_hierarchy_diff";
	ok: boolean;
	changed: boolean;
	summary: string;
	before_nodes: number;
	after_nodes: number;
	diff: {
		added_count: number;
		removed_count: number;
		changed_count: number;
		unchanged_count: number;
		added: FieldBag[];
		removed: FieldBag[];
		changed: Array<{ before: FieldBag; after: FieldBag; fields: Record<string, { before: unknown; after: unknown }> }>;
		omitted_for_display: {
			added: number;
			removed: number;
			changed: number;
			hint: string;
		};
	};
}

export function diffViewTrees(before: ViewNode, after: ViewNode, maxEntries = DIFF_MAX_ENTRIES): ViewDiff {
	const cap = Math.max(0, Math.trunc(maxEntries));
	const beforeItems = flatten(before);
	const afterItems = flatten(after);
	const beforeKeys = new Set(beforeItems.keys());
	const afterKeys = new Set(afterItems.keys());

	const addedKeys = [...afterKeys].filter((k) => !beforeKeys.has(k)).sort((a, b) => cmpEntry(afterItems.get(a)!, afterItems.get(b)!));
	const removedKeys = [...beforeKeys].filter((k) => !afterKeys.has(k)).sort((a, b) => cmpEntry(beforeItems.get(a)!, beforeItems.get(b)!));
	const commonKeys = [...beforeKeys].filter((k) => afterKeys.has(k)).sort((a, b) => cmpEntry(afterItems.get(a)!, afterItems.get(b)!));

	const changed: ViewDiff["diff"]["changed"] = [];
	for (const key of commonKeys) {
		const beforeEntry = beforeItems.get(key)!;
		const afterEntry = afterItems.get(key)!;
		const fields = changedFields(beforeEntry.fields, afterEntry.fields);
		if (Object.keys(fields).length > 0) {
			changed.push({ before: beforeEntry.summary, after: afterEntry.summary, fields });
		}
	}

	const added = addedKeys.slice(0, cap).map((k) => slimLifecycle(afterItems.get(k)!.summary));
	const removed = removedKeys.slice(0, cap).map((k) => slimLifecycle(beforeItems.get(k)!.summary));
	const changedNodes = changed.slice(0, cap);

	const addedCount = addedKeys.length;
	const removedCount = removedKeys.length;
	const changedCount = changed.length;
	const beforeCount = beforeItems.size;
	const afterCount = afterItems.size;
	const changedAny = Boolean(addedCount || removedCount || changedCount);

	return {
		kind: "view_hierarchy_diff",
		ok: true,
		changed: changedAny,
		summary: diffSummary(changedAny, {
			beforeCount,
			afterCount,
			addedCount,
			removedCount,
			changedCount,
		}),
		before_nodes: beforeCount,
		after_nodes: afterCount,
		diff: {
			added_count: addedCount,
			removed_count: removedCount,
			changed_count: changedCount,
			unchanged_count: commonKeys.length - changedCount,
			added,
			removed,
			changed: changedNodes,
			omitted_for_display: {
				added: Math.max(0, addedCount - added.length),
				removed: Math.max(0, removedCount - removed.length),
				changed: Math.max(0, changedCount - changedNodes.length),
				hint:
					"samples are display-capped (content-bearing leaves kept first); counts above are exact. Drill into a specific node with view_inspect/find_view; do NOT re-call tap_with_diff to get more entries.",
			},
		},
	};
}

/** Compact equality signature used to avoid returning mid-animation diffs. */
export function treeSignature(root: ViewNode): string {
	const entries = [...flatten(root).values()].sort(cmpEntry);
	return JSON.stringify(
		entries.map((entry) => [entry.path, Object.entries(entry.fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]),
	);
}

function flatten(root: ViewNode): Map<string, FlatEntry> {
	const out = new Map<string, FlatEntry>();

	function visit(node: ViewNode, path: PathSeg[]): void {
		let key = node.address || `path:${path.join("/")}`;
		if (out.has(key)) key = `${key}@${path.join("/")}`;
		const fields = nodeFields(node);
		out.set(key, { path, fields, summary: nodeSummaryFromFields(node, fields) });
		node.children.forEach((child, idx) => visit(child, [...path, idx]));
		node.presentedViews.forEach((presented, idx) => visit(presented, [...path, "presented", idx]));
	}

	visit(root, []);
	return out;
}

function nodeFields(node: ViewNode): FieldBag {
	const extra = node.extra ?? {};
	let hasImage = extra.hasImage;
	if (hasImage === undefined) hasImage = extra.has_image;
	if (hasImage !== undefined) hasImage = Boolean(hasImage);

	const out: FieldBag = {
		class: node.cls,
		frame: frameList(node),
		text: truncate(node.text),
		aid: node.accessibilityId || null,
		accessibility_label: extra.accessibilityLabel ?? extra.accessibility_label ?? null,
		property_name: extra.propertyName ?? extra.property_name ?? null,
		image_symbol_name: extra.imageSymbolName ?? extra.image_symbol_name ?? null,
		image_asset_name: extra.imageAssetName ?? extra.image_asset_name ?? null,
	};

	if (node.textSource && node.textSource !== "attributedText") out.text_source = node.textSource;
	if (node.hidden) out.hidden = true;
	const alpha = Math.round(node.alpha * 1000) / 1000;
	if (alpha < 0.999) out.alpha = alpha;
	if (node.onScreen === false) out.on_screen = false;
	if (hasImage !== undefined) out.has_image = hasImage;
	const contentMode = extra.contentMode ?? extra.content_mode;
	if (contentMode && contentMode !== "scaleToFill") out.content_mode = contentMode;

	return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== null && v !== undefined));
}

function nodeSummaryFromFields(node: ViewNode, fields: FieldBag): FieldBag {
	const out: FieldBag = { class: node.cls };
	if (node.address) out.address = node.address;
	for (const key of [
		"frame",
		"text",
		"text_source",
		"aid",
		"accessibility_label",
		"property_name",
		"hidden",
		"alpha",
		"on_screen",
		"image_symbol_name",
		"image_asset_name",
		"content_mode",
	] as const) {
		if (key in fields) out[key] = fields[key];
	}
	if (fields.has_image === false) out.has_image = false;
	return out;
}

function slimLifecycle(summary: FieldBag): FieldBag {
	const { frame: _frame, ...rest } = summary;
	return rest;
}

function changedFields(before: FieldBag, after: FieldBag): Record<string, { before: unknown; after: unknown }> {
	const fields: Record<string, { before: unknown; after: unknown }> = {};
	for (const key of DIFF_FIELDS) {
		const b = before[key];
		const a = after[key];
		if (!deepEqual(b, a)) fields[key] = { before: b, after: a };
	}
	return fields;
}

function hasContent(entry: FlatEntry): boolean {
	const fields = entry.fields;
	return Boolean(fields.text || fields.image_symbol_name || fields.image_asset_name || fields.accessibility_label);
}

function cmpEntry(a: FlatEntry, b: FlatEntry): number {
	const ac = hasContent(a) ? 0 : 1;
	const bc = hasContent(b) ? 0 : 1;
	if (ac !== bc) return ac - bc;
	if (a.path.length !== b.path.length) return a.path.length - b.path.length;
	const al = pathLabel(a.path);
	const bl = pathLabel(b.path);
	if (al !== bl) return al < bl ? -1 : 1;
	const af = (a.fields.frame as number[] | undefined) ?? [0, 0, 0, 0];
	const bf = (b.fields.frame as number[] | undefined) ?? [0, 0, 0, 0];
	if (af[1] !== bf[1]) return (af[1] ?? 0) - (bf[1] ?? 0);
	if (af[0] !== bf[0]) return (af[0] ?? 0) - (bf[0] ?? 0);
	const acl = String(a.fields.class ?? "");
	const bcl = String(b.fields.class ?? "");
	return acl < bcl ? -1 : acl > bcl ? 1 : 0;
}

function frameList(node: ViewNode): number[] | null {
	if (node.frame.width <= 0 || node.frame.height <= 0) return null;
	// Python _frame uses int(x+0.5) — truncate toward zero, matching negative
	// (superview-relative) offsets. Math.floor would be off-by-one below zero.
	return [
		Math.trunc(node.frame.x + 0.5),
		Math.trunc(node.frame.y + 0.5),
		Math.trunc(node.frame.width + 0.5),
		Math.trunc(node.frame.height + 0.5),
	];
}

function truncate(value: string | null, limit = 80): string | null {
	if (!value) return null;
	return value.length <= limit ? value : `${value.slice(0, limit - 1)}...`;
}

function pathLabel(path: PathSeg[]): string {
	return path.length === 0 ? "/" : `/${path.join("/")}`;
}

function diffSummary(
	changed: boolean,
	counts: { beforeCount: number; afterCount: number; addedCount: number; removedCount: number; changedCount: number },
): string {
	if (!changed) return `view unchanged (${counts.afterCount} nodes)`;
	return `view changed: +${counts.addedCount} -${counts.removedCount} ~${counts.changedCount} (nodes ${counts.beforeCount}->${counts.afterCount})`;
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		return a.every((v, i) => deepEqual(v, b[i]));
	}
	return false;
}
