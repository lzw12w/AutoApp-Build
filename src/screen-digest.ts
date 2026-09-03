/**
 * Screen digest: the highest information-density projection of the current
 * screen. Ported from ios_inspector_agent/actions/screen_digest.py.
 *
 * Takes ONE fully-expanded on-screen snapshot and projects it into a compact
 * reading-order plain-text overview:
 *  - only currently-visible nodes (hidden / off-screen / alpha<=0.01 dropped);
 *  - pure-layout containers with no anchor (text/aid/a11y/prop/asset/sym/
 *    interactive class) are dropped, their interesting descendants bubble up;
 *  - kept nodes render as a flat indented list in DFS reading order;
 *  - leaf-only containers fold into a single line (icon + label);
 *  - every line keeps the real `address` at the end for tap/view_inspect.
 *
 * Output is plain text on purpose — cheaper for the model to read than JSON.
 */
import type { ViewNode } from "./models.ts";

const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

function isUuidAsset(name: unknown): boolean {
	return typeof name === "string" && UUID_RE.test(name);
}

// Classes always worth surfacing even without text. Substring, case-insensitive.
const INTERACTIVE_OR_STRUCTURAL = [
	"button", "cell", "tabbar", "tab_bar", "navigationbar", "navbar",
	"searchbar", "searchfield", "textfield", "textview", "switch", "slider",
	"stepper", "segment", "pagecontrol", "picker", "datepicker",
	"collectionview", "tableview", "alert", "actionsheet", "menu", "toolbar",
	"control",
];

// Pure-layout container classes that never carry direct content. Exact match.
const PURE_LAYOUT = new Set([
	"uiview", "uistackview", "_uistackviewcontainer", "uilayoutcontainerview",
	"uitransitionview", "uidropshadowview", "uiviewcontrollerwrapperview",
	"uiscrollview", "uicontentview",
]);

function cleanText(text: unknown): string {
	if (!text) return "";
	return String(text).split(/\s+/).filter(Boolean).join(" ");
}

function extra(node: ViewNode, ...keys: string[]): unknown {
	for (const k of keys) {
		const v = node.extra[k];
		if (v) return v;
	}
	return null;
}

/** Compact per-node summary of attached user-interactive gestures. */
function gestureHint(node: ViewNode): string | null {
	const raw = node.extra.gestureRecognizers;
	if (!raw || !Array.isArray(raw)) return null;
	const seen = new Set<string>();
	const parts: string[] = [];
	for (const item of raw) {
		const original = String(item);
		if (!original || original.startsWith("_")) continue;
		if (original.startsWith("UIScrollView")) continue;
		if (original.startsWith("UIHover")) continue;
		if (original.startsWith("UIText") && original.endsWith("Recognizer")) continue;
		if (original === "UITapAndAHalfRecognizer" || original === "UIVariableDelayLoupeGesture") continue;
		if (
			original === "UIPanGestureRecognizer" ||
			original === "UISwipeGestureRecognizer" ||
			original === "UIPinchGestureRecognizer" ||
			original === "UIRotationGestureRecognizer"
		) {
			continue;
		}
		let pretty = original;
		if (pretty.startsWith("UI")) pretty = pretty.slice(2);
		if (pretty.endsWith("GestureRecognizer")) pretty = pretty.slice(0, -"GestureRecognizer".length);
		if (!pretty || seen.has(pretty)) continue;
		seen.add(pretty);
		parts.push(pretty);
	}
	return parts.length ? parts.join("+") : null;
}

interface Anchors {
	text: string;
	textSource: string | null;
	aid: string | null;
	a11y: unknown;
	prop: unknown;
	asset: unknown;
	sym: unknown;
	gest: string | null;
}

function anchorsOf(node: ViewNode): Anchors {
	let asset = extra(node, "imageAssetName", "image_asset_name");
	if (isUuidAsset(asset)) asset = null;
	return {
		text: cleanText(node.text),
		textSource: node.textSource,
		aid: node.accessibilityId || null,
		a11y: extra(node, "accessibilityLabel", "accessibility_label"),
		prop: extra(node, "propertyName", "property_name"),
		asset,
		sym: extra(node, "imageSymbolName", "image_symbol_name"),
		gest: gestureHint(node),
	};
}

function gestureIsActionable(gest: string | null, hasPropertyName: boolean): boolean {
	if (!gest) return false;
	const tokens = gest.split("+");
	if (tokens.includes("Tap")) return true;
	const uikitShort = new Set(["Tap", "LongPress"]);
	if (tokens.some((t) => t && !uikitShort.has(t))) return true;
	return tokens.includes("LongPress") && hasPropertyName;
}

function isInteresting(node: ViewNode, anchors: Anchors): boolean {
	if (anchors.text || anchors.aid || anchors.a11y || anchors.prop || anchors.asset || anchors.sym) {
		return true;
	}
	const clsL = (node.cls || "").toLowerCase();
	if (gestureIsActionable(anchors.gest, Boolean(anchors.prop))) {
		// A full-screen UILayoutContainerView often has a Tap recognizer that
		// hit-tests to children. Keeping it makes digest line 1 an unusable
		// tap target. Custom (non Tap/LongPress) recognizers still count.
		if (!PURE_LAYOUT.has(clsL)) return true;
		const tokens = (anchors.gest || "").split("+");
		if (tokens.some((t) => t && t !== "Tap" && t !== "LongPress")) return true;
	}
	if (PURE_LAYOUT.has(clsL)) return false;
	return INTERACTIVE_OR_STRUCTURAL.some((kw) => clsL.includes(kw));
}

function primaryAndExtras(node: ViewNode, anchors: Anchors): [string, string[]] {
	const extras: string[] = [];
	let primary = "";
	if (anchors.text) {
		primary = `"${anchors.text}"`;
		if (anchors.textSource) extras.push(`src=${anchors.textSource}`);
	} else if (anchors.a11y) {
		primary = `"${cleanText(anchors.a11y)}"`;
	} else if (anchors.prop) {
		primary = String(anchors.prop);
	} else if (anchors.sym) {
		primary = `sym=${anchors.sym}`;
	} else if (anchors.asset) {
		primary = `asset=${anchors.asset}`;
	} else if (anchors.aid) {
		primary = `aid=${anchors.aid}`;
	}

	if (anchors.prop && primary !== String(anchors.prop)) extras.push(`prop=${anchors.prop}`);
	if (anchors.aid && primary !== `aid=${anchors.aid}`) extras.push(`aid=${anchors.aid}`);
	if (anchors.sym && primary !== `sym=${anchors.sym}`) extras.push(`sym=${anchors.sym}`);
	if (anchors.asset && primary !== `asset=${anchors.asset}`) extras.push(`asset=${anchors.asset}`);
	if (anchors.gest) extras.push(`gest=${anchors.gest}`);
	if (node.alpha < 0.99) extras.push(`alpha=${node.alpha.toFixed(2)}`);
	if (extra(node, "hasImage", "has_image") === false) extras.push("no-img");
	return [primary, extras];
}

class Entry {
	cls: string;
	primary: string;
	extras: string[];
	address: string;
	x: number;
	y: number;
	depth: number;
	parentAddress: string | null;

	constructor(init: {
		cls: string;
		primary: string;
		extras: string[];
		address: string;
		x: number;
		y: number;
		depth: number;
		parentAddress: string | null;
	}) {
		this.cls = init.cls;
		this.primary = init.primary;
		this.extras = init.extras;
		this.address = init.address;
		this.x = init.x;
		this.y = init.y;
		this.depth = init.depth;
		this.parentAddress = init.parentAddress;
	}
}

/** Depth-first collect interesting nodes in reading order. */
function collect(root: ViewNode): { entries: Entry[]; total: number } {
	const entries: Entry[] = [];
	let total = 0;
	const seenAddresses = new Set<string>();

	function visit(node: ViewNode, absX: number, absY: number, depth: number, parentAddr: string | null): void {
		const addr = node.address;
		if (addr) {
			if (seenAddresses.has(addr)) return;
			seenAddresses.add(addr);
		}
		if (node.hidden) return;
		if (node.onScreen === false) return;
		if (node.alpha <= 0.01) return;

		const curX = absX + node.frame.x;
		const curY = absY + node.frame.y;

		total += 1;
		const anchors = anchorsOf(node);
		let childDepth: number;
		let childParent: string | null;
		if (isInteresting(node, anchors)) {
			const [primary, extras] = primaryAndExtras(node, anchors);
			entries.push(
				new Entry({
					cls: node.cls,
					primary,
					extras,
					address: addr,
					x: Math.floor(curX + 0.5),
					y: Math.floor(curY + 0.5),
					depth,
					parentAddress: parentAddr,
				}),
			);
			childDepth = depth + 1;
			childParent = addr;
		} else {
			childDepth = depth;
			childParent = parentAddr;
		}

		if (node.presentedViews.length > 0) {
			for (const p of node.presentedViews) visit(p, 0, 0, childDepth, childParent);
		} else {
			const sorted = [...node.children].sort((a, b) => {
				const ay = Math.floor(a.frame.y / 8);
				const by = Math.floor(b.frame.y / 8);
				if (ay !== by) return ay - by;
				return a.frame.x - b.frame.x;
			});
			for (const c of sorted) visit(c, curX, curY, childDepth, childParent);
		}
	}

	visit(root, 0, 0, 0, null);
	return { entries, total };
}

function dedupeExtras(extras: string[], primary: string): string[] {
	const seen = new Set<string>();
	if (primary) seen.add(primary);
	const out: string[] = [];
	for (const token of extras) {
		if (!token || seen.has(token)) continue;
		seen.add(token);
		out.push(token);
	}
	return out;
}

function formatLine(idx: number, entry: Entry): string {
	const indent = "  ".repeat(entry.depth);
	const parts = [`${indent}@${String(idx).padEnd(3)} ${entry.cls}`];
	if (entry.primary) parts.push(entry.primary);
	const extras = dedupeExtras(entry.extras, entry.primary);
	if (extras.length) parts.push(`[${extras.join(" ")}]`);
	let line = parts.join("  ");
	if (entry.address) line = `${line}   ${entry.address}`;
	return line;
}

/** Render a compact reading-order overview of the current screen. */
export function buildScreenDigest(root: ViewNode, vcLabel?: string | null): string {
	const { entries, total } = collect(root);

	// --- Child folding: fold leaf-only containers into a single line. ---
	const addrToEntry = new Map<string, Entry>();
	for (const e of entries) {
		if (e.address) addrToEntry.set(e.address, e);
	}
	const childrenOf = new Map<string, Entry[]>();
	for (const e of entries) {
		if (e.parentAddress) {
			const list = childrenOf.get(e.parentAddress) ?? [];
			list.push(e);
			childrenOf.set(e.parentAddress, list);
		}
	}
	const isParentAddr = new Set<string>();
	for (const e of entries) {
		if (e.parentAddress) isParentAddr.add(e.parentAddress);
	}

	const folded = new Set<Entry>();
	for (const [parentAddr, kids] of childrenOf) {
		const parentEntry = addrToEntry.get(parentAddr);
		if (!parentEntry) continue;
		if (parentEntry.primary && parentEntry.primary.startsWith('"')) continue;
		const allLeaves = kids.every((k) => !k.address || !isParentAddr.has(k.address));
		if (!allLeaves) continue;
		const textKids = kids.filter((k) => k.primary && k.primary.startsWith('"'));
		if (textKids.length > 1) continue;
		const newExtras = [...parentEntry.extras];
		const mergedText = textKids.length ? textKids[0]!.primary : null;
		if (mergedText && parentEntry.primary) newExtras.push(parentEntry.primary);
		for (const k of kids) {
			if (k.primary && k.primary.startsWith('"')) {
				// Text becomes the parent's primary, but role handles (aid=)
				// must still surface — otherwise tap_with_diff(accessibility_id=)
				// cannot see the only stable identifier on the line.
				newExtras.push(...k.extras);
				folded.add(k);
				continue;
			}
			if (k.primary) newExtras.push(k.primary);
			newExtras.push(...k.extras);
			folded.add(k);
		}
		parentEntry.primary = mergedText || parentEntry.primary;
		parentEntry.extras = dedupeExtras(newExtras, parentEntry.primary);
	}

	let idx = 1;
	const bodyLines: string[] = [];
	for (const entry of entries) {
		if (folded.has(entry)) continue;
		bodyLines.push(formatLine(idx, entry));
		idx += 1;
	}

	const shown = idx - 1;
	const header = `VC: ${vcLabel || "?"}   nodes=${total} shown=${shown}`;
	if (bodyLines.length === 0) bodyLines.push("(no content-bearing views on screen)");
	return [header, ...bodyLines].join("\n");
}

/** Best-effort human label for the currently-shown view controller. */
export function vcLabelFromVc(vc: { visibleLeaf?: () => { title: string | null; cls: string } } | null): string | null {
	if (!vc) return null;
	const leaf = typeof vc.visibleLeaf === "function" ? vc.visibleLeaf() : (vc as { title: string | null; cls: string });
	const title = leaf.title;
	if (title) {
		const cleaned = cleanText(title);
		if (cleaned) return cleaned;
	}
	return leaf.cls || null;
}
