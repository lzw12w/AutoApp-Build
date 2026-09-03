/**
 * Three-layer page fingerprinting. Ported from
 * ios_inspector_agent/knowledge/fingerprint.py.
 *
 *  - **Skeleton**: data-invariant structural hash (class-tree shape with
 *    sibling counts bucketed). Scrolling / paginating / swapping cards must
 *    NOT change it.
 *  - **Semantic**: content-blind template identity (top VC class, container
 *    chain, role-aids). Distinguishes pages sharing a skeleton.
 *  - **Visual**: optional tie-breaker computed elsewhere (screenshot pipeline).
 *
 * Each layer is a 64-bit hex string; hamming distance is a cheap XOR+popcount.
 *
 * HASH NOTE: Python used stdlib `blake2b(digest_size=8)`. We use node:crypto
 * blake2b512 truncated to 64 bits so Bun tests and Node (pi) share one path.
 * The hex differs from Python's — fingerprints are only compared within this
 * store, never against Python-produced hashes.
 */
import type { VCNode, ViewNode } from "../models.ts";
import { h64 } from "./hash.ts";

export interface PageFingerprint {
	skeletonHash: string;
	semanticHash: string;
	visualHash: string | null;
	// Explanatory metadata — never participates in hashing.
	vcClass: string;
	title: string | null;
	keyTexts: string[];
	depth: number;
	leafCount: number;
}

// ---- hashing primitives ------------------------------------------------

/** Bit-level hamming distance between two equal-length hex strings. */
export function hammingDistance(a: string, b: string): number {
	if (a.length !== b.length) return Math.max(a.length, b.length) * 4;
	const xor = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
	let bits = 0;
	let v = xor;
	while (v > 0n) {
		bits += Number(v & 1n);
		v >>= 1n;
	}
	return bits;
}

// ---- skeleton hash — pure structure, data-invariant -------------------

function bucket(n: number): string {
	if (n <= 1) return "1";
	if (n <= 5) return "S";
	if (n <= 20) return "M";
	return "L";
}

const FP_DEPTH_CAP = 8;
const FP_TRUNC_SENTINEL = "…";

function* walkCapped(node: ViewNode, depth = 0): Generator<ViewNode> {
	yield node;
	if (depth + 1 >= FP_DEPTH_CAP) return;
	for (const c of node.children) yield* walkCapped(c, depth + 1);
}

function skeletonVisible(node: ViewNode): boolean {
	if (node.hidden) return false;
	if (node.alpha <= 0.01) return false;
	if (node.onScreen === false) return false;
	if (node.frame.area <= 1.0) return false;
	return true;
}

function serializeSkeleton(node: ViewNode, depth = 0): string {
	if (depth + 1 >= FP_DEPTH_CAP) return `${node.cls}${FP_TRUNC_SENTINEL}`;

	const children = node.children.filter(skeletonVisible);

	const grouped: string[] = [];
	let i = 0;
	while (i < children.length) {
		const runCls = children[i]!.cls;
		let j = i;
		while (j < children.length && children[j]!.cls === runCls) j += 1;
		const run = children.slice(i, j);
		if (run.length > 1) {
			const allLeaves = run.every((c) => c.children.length === 0);
			if (allLeaves) {
				grouped.push(`${runCls}*${bucket(run.length)}()`);
			} else {
				const repSerializations = run.map((c) => serializeSkeleton(c, depth + 1)).sort();
				grouped.push(`${runCls}*${bucket(run.length)}(${repSerializations[0]})`);
			}
		} else {
			grouped.push(serializeSkeleton(run[0]!, depth + 1));
		}
		i = j;
	}

	if (grouped.length === 0) return node.cls;
	return `${node.cls}[${grouped.join(",")}]`;
}

export function skeletonHash(view: ViewNode): string {
	return h64(serializeSkeleton(view));
}

function computeDepth(node: ViewNode, level = 0): number {
	if (level + 1 >= FP_DEPTH_CAP) return 1;
	if (node.children.length === 0) return 1;
	return 1 + Math.max(...node.children.map((c) => computeDepth(c, level + 1)));
}

function computeLeafCount(node: ViewNode, level = 0): number {
	if (level + 1 >= FP_DEPTH_CAP || node.children.length === 0) return 1;
	return node.children.reduce((sum, c) => sum + computeLeafCount(c, level + 1), 0);
}

// ---- volatile text / aid predicates (kept for testability) ------------

const VOLATILE_PATTERNS: RegExp[] = [
	/\d{2,}/,
	/[¥$€£￥]/,
	/\d{1,2}[:：]\d{2}/,
	/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/,
	/\b\d{1,2}[-/月]\d{1,2}\b/,
	/@\S+\.\S+/,
	/https?:\/\//,
	/^\+?\d[\d\-\s]{6,}$/,
];

export function isVolatileText(text: string): boolean {
	if (!text) return true;
	const s = text.trim();
	if (!s) return true;
	if (s.length > 16) return true;
	return VOLATILE_PATTERNS.some((p) => p.test(s));
}

const VOLATILE_AID_PATTERNS: RegExp[] = [/\d{6,}/, /[0-9a-f]{8}-[0-9a-f]{4}/, /:[\w-]{4,}$/, /_[0-9a-f]{12,}/];

export function isVolatileAid(aid: string): boolean {
	if (!aid) return true;
	const s = aid.trim();
	if (!s) return true;
	if (s.length > 48) return true;
	return VOLATILE_AID_PATTERNS.some((p) => p.test(s));
}

// ---- content-blind role-aid identification ----------------------------

/**
 * Developer-assigned role ids, including Odyssey dotted paths
 * (`mainTab.item.feed`, `playInfoBar.likeButton`). Still reject content
 * ids (digit runs, uuid/hex). MixedCase *without* a leading lowercase
 * segment (`MixedCase`) stays out — those are type names, not role keys.
 */
const ROLE_AID_PATTERN =
	/^[a-z][A-Za-z0-9_-]{0,47}(\.[A-Za-z][A-Za-z0-9_-]{0,47}){0,8}$/;
const ROLE_AID_REJECT_PATTERNS: RegExp[] = [/\d{4,}/, /[0-9a-f]{8}/, /(^|[._-])uuid([._-]|$)/];

export function isRoleAid(aid: string): boolean {
	if (!aid) return false;
	const s = aid.trim();
	if (s.length > 80) return false;
	if (!ROLE_AID_PATTERN.test(s)) return false;
	return !ROLE_AID_REJECT_PATTERNS.some((p) => p.test(s));
}

function structuralRoles(view: ViewNode, limit = 12): string[] {
	const roles: string[] = [];
	for (const n of walkCapped(view)) {
		if (!skeletonVisible(n)) continue;
		if (n.accessibilityId && isRoleAid(n.accessibilityId)) {
			roles.push(`${n.cls}:${n.accessibilityId.trim()}`);
		} else {
			roles.push(n.cls);
		}
		if (roles.length >= limit) break;
	}
	return roles;
}

// ---- semantic hash — content-blind ------------------------------------

function activeChild(vc: VCNode): VCNode {
	if (vc.children.length === 0) return vc.selectedChild ?? vc;
	const cls = (vc.cls || "").toLowerCase();
	if (cls.includes("tabbar") || cls.includes("tab_bar")) {
		if (vc.selectedChild !== null) return vc.selectedChild;
		for (const child of vc.children) {
			if (child.selected) return child;
		}
		const idx = vc.selectedIndex;
		if (idx !== null && idx >= 0 && idx < vc.children.length) return vc.children[idx]!;
		return vc.children[0]!;
	}
	if (vc.selectedChild !== null) return vc.selectedChild;
	return vc.children[vc.children.length - 1]!;
}

function topVc(vc: VCNode): VCNode {
	let cur = vc;
	while (cur.presented !== null) cur = cur.presented;
	while (cur.children.length > 0) cur = activeChild(cur);
	return cur;
}

function vcContainerChain(vc: VCNode): string[] {
	const chain: string[] = [];
	let cur: VCNode | null = vc;
	while (cur !== null) {
		if (cur.presented !== null) {
			if (cur.cls && cur.cls !== "Empty" && cur.cls !== "Unknown") chain.push(cur.cls);
			cur = cur.presented;
			continue;
		}
		if (cur.children.length === 0) break;
		if (cur.cls && cur.cls !== "Empty" && cur.cls !== "Unknown") chain.push(cur.cls);
		cur = activeChild(cur);
	}
	return chain;
}

function collectSemanticSignals(view: ViewNode, vc: VCNode | null): string[] {
	const signals: string[] = [];
	if (vc !== null) {
		const top = topVc(vc);
		if (top.cls && top.cls !== "Empty" && top.cls !== "Unknown") signals.push(`vc:${top.cls}`);
		const chain = vcContainerChain(vc);
		if (chain.length) signals.push(`vcchain:${chain.join(">")}`);
	}
	const aids = new Set<string>();
	for (const n of walkCapped(view)) {
		if (!skeletonVisible(n)) continue;
		if (n.accessibilityId && isRoleAid(n.accessibilityId)) aids.add(n.accessibilityId.trim());
	}
	for (const a of [...aids].sort()) signals.push(`aid:${a}`);
	return signals;
}

export function semanticHash(view: ViewNode, vc: VCNode | null = null): string {
	return h64(collectSemanticSignals(view, vc).join("\n"));
}

// ---- top-level entry point --------------------------------------------

export function computeFingerprint(
	view: ViewNode,
	vc: VCNode | null = null,
	options: { visualHash?: string | null; keyTextsLimit?: number } = {},
): PageFingerprint {
	const keyTexts = structuralRoles(view, options.keyTextsLimit ?? 8);
	const top = vc !== null ? topVc(vc) : null;
	const vcClass = top && top.cls !== "" && top.cls !== "Empty" && top.cls !== "Unknown" ? top.cls : "";
	return {
		skeletonHash: skeletonHash(view),
		semanticHash: semanticHash(view, vc),
		visualHash: options.visualHash ?? null,
		vcClass,
		title: null,
		keyTexts,
		depth: computeDepth(view),
		leafCount: computeLeafCount(view),
	};
}
