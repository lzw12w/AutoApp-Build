/**
 * Convert a scroll delta into swipe start/end points.
 * Ported from ios_inspector_agent/actions/interact.py::_scroll_delta_to_swipe_points.
 */
import { Frame, type ViewNode } from "../models.ts";

const DEFAULT_SWIPE_FRAME = { x: 0, y: 0, width: 390, height: 844 };
const SWIPE_EDGE_INSET = 24;

function clamp(value: number, low: number, high: number): number {
	if (high < low) return low;
	return Math.min(Math.max(value, low), high);
}

function frameTuple(frame: Frame): { x: number; y: number; width: number; height: number } | null {
	if (frame.width > 0 && frame.height > 0) return { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
	return null;
}

/** Screen-space rectangle for a gesture. Local cell frames are not used. */
export function screenFrameForMotion(node: ViewNode): { x: number; y: number; width: number; height: number } | null {
	const visible = Frame.fromAny(node.extra.visibleFrame ?? node.extra.visible_frame);
	const vis = frameTuple(visible);
	if (vis) return vis;
	if (node.isKeyWindow || node.cls.endsWith("Window")) return frameTuple(node.frame);
	return null;
}

export function scrollDeltaToSwipePoints(
	dx: number,
	dy: number,
	frame: { x: number; y: number; width: number; height: number } = DEFAULT_SWIPE_FRAME,
): { start_x: number; start_y: number; end_x: number; end_y: number } {
	const inset = Math.min(SWIPE_EDGE_INSET, Math.max(0, frame.width / 4), Math.max(0, frame.height / 4));
	const minX = frame.x + inset;
	const maxX = frame.x + Math.max(frame.width - inset, 0);
	const minY = frame.y + inset;
	const maxY = frame.y + Math.max(frame.height - inset, 0);
	const centerX = clamp(frame.x + frame.width / 2, minX, maxX);
	const centerY = clamp(frame.y + frame.height / 2, minY, maxY);
	const spanX = Math.min(Math.abs(dx), Math.max(0, maxX - minX));
	const spanY = Math.min(Math.abs(dy), Math.max(0, maxY - minY));
	const signX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
	const signY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
	const halfX = spanX / 2;
	const halfY = spanY / 2;
	return {
		start_x: clamp(centerX + signX * halfX, minX, maxX),
		start_y: clamp(centerY + signY * halfY, minY, maxY),
		end_x: clamp(centerX - signX * halfX, minX, maxX),
		end_y: clamp(centerY - signY * halfY, minY, maxY),
	};
}

function isScrollableClass(cls: string): boolean {
	const c = cls.toLowerCase();
	return c.includes("collectionview") || c.includes("tableview") || c.includes("scrollview");
}

function looksHorizontalScroller(node: ViewNode): boolean {
	const prop = String(node.extra.propertyName ?? node.extra.property_name ?? "");
	const blob = `${node.cls} ${node.accessibilityId ?? ""} ${prop}`.toLowerCase();
	if (blob.includes("horizontal") || blob.includes("pager")) return true;
	return node.frame.width > node.frame.height * 1.4 && node.frame.height < 120;
}

/**
 * Pick the scroller a bare `scroll(dy=)` should hit. Prefers the main
 * vertical collection/table over a full-screen horizontal pager.
 */
export function pickDefaultScrollView(root: ViewNode, dx: number, dy: number): ViewNode | null {
	const vertical = Math.abs(dy) >= Math.abs(dx);
	const candidates: ViewNode[] = [];
	for (const n of root.walk()) {
		if (n.hidden || n.onScreen === false) continue;
		if (!isScrollableClass(n.cls)) continue;
		if (n.frame.area < 10_000) continue;
		candidates.push(n);
	}
	if (candidates.length === 0) return null;
	let best: ViewNode | null = null;
	let bestScore = -Infinity;
	for (const n of candidates) {
		const cls = n.cls.toLowerCase();
		let score = n.frame.area;
		if (cls.includes("collectionview") || cls.includes("tableview")) score += 1_000_000_000;
		if (vertical && looksHorizontalScroller(n)) score -= 2_000_000_000;
		if (!vertical && looksHorizontalScroller(n)) score += 500_000_000;
		if (score > bestScore) {
			bestScore = score;
			best = n;
		}
	}
	return best;
}

export { DEFAULT_SWIPE_FRAME };
