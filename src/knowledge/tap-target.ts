/**
 * Stable tap-target summary + role-level edge identity.
 *
 * Human-visible params (action_label / target) are ported from Python
 * `_stable_node_summary` + `_tap_label`: class, frame, role-aid, ancestor
 * chain, plus content-safe hints (property_name, a11y label, icon names,
 * non-volatile text). Hex addresses and data-like text stay out.
 *
 * Edge identity is stricter than Python (which left tap identity empty):
 * split A→B only when the control has a role-level handle (role-aid or
 * property_name). List cells without either still collapse to one edge.
 */
import type { ViewNode } from "../models.ts";
import { isRoleAid, isVolatileText } from "./fingerprint.ts";

const ANCESTOR_DEPTH = 3;

export type TapTargetHook = (
	kind: string,
	params: Record<string, unknown>,
	identity: Record<string, unknown>,
) => void;

export interface TapTargetAttribution {
	params: Record<string, unknown>;
	identity: Record<string, unknown>;
}

export function findAncestorChain(root: ViewNode | null, targetAddress: string, n = ANCESTOR_DEPTH): string[] {
	if (!root || !targetAddress) return [];
	const path: ViewNode[] = [];
	const dfs = (node: ViewNode): boolean => {
		path.push(node);
		if (node.address === targetAddress) return true;
		for (const child of node.children) {
			if (dfs(child)) return true;
		}
		path.pop();
		return false;
	};
	if (!dfs(root)) return [];
	return path
		.slice(0, -1)
		.reverse()
		.map((node) => node.cls)
		.slice(0, n);
}

function extraStr(node: ViewNode, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = node.extra[key];
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

function formatFrame(node: ViewNode): [number, number, number, number] {
	return [
		Math.round(node.frame.x),
		Math.round(node.frame.y),
		Math.round(node.frame.width),
		Math.round(node.frame.height),
	];
}

export function stableNodeSummary(node: ViewNode, ancestorChain: Iterable<string> = []): Record<string, unknown> {
	const aid = node.accessibilityId && isRoleAid(node.accessibilityId) ? node.accessibilityId : null;
	const out: Record<string, unknown> = {
		class: node.cls,
		frame: formatFrame(node),
		aid,
		ancestor_chain: [...ancestorChain],
	};

	const propertyName = extraStr(node, "propertyName", "property_name");
	if (propertyName) out.property_name = propertyName;

	const a11yLabel = extraStr(node, "accessibilityLabel", "accessibility_label");
	if (a11yLabel) out.accessibility_label = a11yLabel;

	const symbolName = extraStr(node, "imageSymbolName", "image_symbol_name");
	if (symbolName) out.image_symbol_name = symbolName;
	const assetName = extraStr(node, "imageAssetName", "image_asset_name");
	if (assetName) out.image_asset_name = assetName;

	const text = (node.text || "").trim();
	if (text && !isVolatileText(text)) out.text = text.slice(0, 40);

	return out;
}

export function tapLabel(summary: Record<string, unknown>): string {
	const cls = typeof summary.class === "string" && summary.class ? summary.class : "view";
	const aid = typeof summary.aid === "string" ? summary.aid : "";
	let head = `点击 ${cls}`;
	if (aid) head = `${head}#${aid}`;

	const hints = [
		summary.property_name,
		summary.image_symbol_name || summary.image_asset_name,
		summary.accessibility_label,
		summary.text,
	].filter((h): h is string => typeof h === "string" && h.length > 0);
	if (hints.length) head = `${head} (${hints.join(" / ")})`;

	const parts = [head];
	const chain = summary.ancestor_chain;
	if (Array.isArray(chain) && chain.length > 0) parts.push(`in ${chain.join("/")}`);
	const frame = summary.frame;
	if (Array.isArray(frame) && frame.length === 4) {
		parts.push(`@ (${frame[0]}, ${frame[1]}, ${frame[2]}, ${frame[3]})`);
	}
	return parts.join(" ");
}

/** Role-level identity. Empty unless property_name or role-aid is present. */
export function tapIdentity(summary: Record<string, unknown>): Record<string, unknown> {
	const propertyName = typeof summary.property_name === "string" ? summary.property_name : "";
	const aid = typeof summary.aid === "string" ? summary.aid : "";
	if (!propertyName && !aid) return {};
	const out: Record<string, unknown> = { class: summary.class };
	if (propertyName) out.property_name = propertyName;
	if (aid) out.aid = aid;
	const chain = summary.ancestor_chain;
	if (Array.isArray(chain) && chain.length > 0) out.ancestor_chain = chain;
	return out;
}

export function usableTapNode(node: ViewNode | null | undefined): ViewNode | null {
	if (!node) return null;
	if (!node.address) return null;
	if (node.cls === "Empty" || node.cls === "Unknown") return null;
	return node;
}

function coordinateTapParams(coords?: { x?: number; y?: number }): Record<string, unknown> {
	const x = coords?.x;
	const y = coords?.y;
	if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
		return { action_label: "点击 view" };
	}
	return { action_label: `点击坐标 (${x}, ${y})` };
}

export function tapTargetAttribution(
	node: ViewNode | null,
	root: ViewNode | null,
	coords?: { x?: number; y?: number },
): TapTargetAttribution {
	const targetNode = usableTapNode(node);
	if (!targetNode) {
		return { params: coordinateTapParams(coords), identity: {} };
	}
	const chain = findAncestorChain(root, targetNode.address);
	const target = stableNodeSummary(targetNode, chain);
	return {
		params: { action_label: tapLabel(target), target },
		identity: tapIdentity(target),
	};
}

export function reportTapTarget(
	hook: TapTargetHook | undefined,
	kind: string,
	node: ViewNode | null,
	root: ViewNode | null,
	coords?: { x?: number; y?: number },
): void {
	if (!hook) return;
	try {
		const { params, identity } = tapTargetAttribution(node, root, coords);
		hook(kind, params, identity);
	} catch {
		// attribution is best-effort; never fail the tap
	}
}
