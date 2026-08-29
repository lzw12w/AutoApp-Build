/**
 * Domain models for the iOS view/VC hierarchy. Ported from
 * ios_inspector_agent/core/models.py.
 *
 * These mirror the server's JSON shapes (camelCase from Swift
 * JSONSerialization, with snake_case fallbacks). Instances are treated as
 * immutable: build via the static `fromDict` factories, never mutate.
 */

export class Frame {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;

	constructor(x: number, y: number, width: number, height: number) {
		this.x = x;
		this.y = y;
		this.width = width;
		this.height = height;
	}

	static fromAny(value: unknown): Frame {
		if (value === null || value === undefined) return new Frame(0, 0, 0, 0);
		if (typeof value === "object" && !Array.isArray(value)) {
			const v = value as Record<string, unknown>;
			return new Frame(
				num(v.x),
				num(v.y),
				num(v.width ?? v.w),
				num(v.height ?? v.h),
			);
		}
		if (Array.isArray(value) && value.length >= 4) {
			return new Frame(num(value[0]), num(value[1]), num(value[2]), num(value[3]));
		}
		return new Frame(0, 0, 0, 0);
	}

	get area(): number {
		return Math.max(0, this.width) * Math.max(0, this.height);
	}
}

export interface ViewNodeInit {
	address: string;
	cls: string;
	frame: Frame;
	text?: string | null;
	textSource?: string | null;
	accessibilityId?: string | null;
	hidden?: boolean;
	alpha?: number;
	isKeyWindow?: boolean;
	windowLevel?: number | null;
	windowClass?: string | null;
	containsPresentedSheet?: boolean;
	presentedViews?: ViewNode[];
	onScreen?: boolean | null;
	offscreenChildCount?: number;
	extra?: Record<string, unknown>;
	children?: ViewNode[];
}

export class ViewNode {
	readonly address: string;
	readonly cls: string;
	readonly frame: Frame;
	readonly text: string | null;
	/**
	 * Where `text` was sourced from server-side. `null` means the native
	 * UIKit text property (authoritative). "attributedText" / "a11y" are
	 * best-effort fallbacks for non-standard text views.
	 */
	readonly textSource: string | null;
	readonly accessibilityId: string | null;
	readonly hidden: boolean;
	readonly alpha: number;
	readonly isKeyWindow: boolean;
	readonly windowLevel: number | null;
	readonly windowClass: string | null;
	readonly containsPresentedSheet: boolean;
	readonly presentedViews: readonly ViewNode[];
	readonly onScreen: boolean | null;
	readonly offscreenChildCount: number;
	readonly extra: Record<string, unknown>;
	readonly children: readonly ViewNode[];

	constructor(init: ViewNodeInit) {
		this.address = init.address;
		this.cls = init.cls;
		this.frame = init.frame;
		this.text = init.text ?? null;
		this.textSource = init.textSource ?? null;
		this.accessibilityId = init.accessibilityId ?? null;
		this.hidden = init.hidden ?? false;
		this.alpha = init.alpha ?? 1.0;
		this.isKeyWindow = init.isKeyWindow ?? false;
		this.windowLevel = init.windowLevel ?? null;
		this.windowClass = init.windowClass ?? null;
		this.containsPresentedSheet = init.containsPresentedSheet ?? false;
		this.presentedViews = init.presentedViews ?? [];
		this.onScreen = init.onScreen ?? null;
		this.offscreenChildCount = init.offscreenChildCount ?? 0;
		this.extra = init.extra ?? {};
		this.children = init.children ?? [];
	}

	static fromDict(raw: unknown): ViewNode {
		if (!isRecord(raw)) {
			return new ViewNode({ address: "", cls: "Empty", frame: new Frame(0, 0, 0, 0) });
		}

		const childrenRaw = asArray(raw.children ?? raw.subviews);
		const children = childrenRaw.filter(isRecord).map((c) => ViewNode.fromDict(c));

		const presentedRaw = raw.presentedViews;
		const presentedViews = Array.isArray(presentedRaw)
			? presentedRaw.filter(isRecord).map((p) => ViewNode.fromDict(p))
			: [];

		const clsName = raw.class ?? raw.cls;
		const address = raw.address;
		if (!clsName && !address && children.length === 0 && presentedViews.length === 0) {
			// Almost certainly a wrapper dict (e.g. {"windows": [...]}) leaked in.
			return new ViewNode({ address: "", cls: "Empty", frame: new Frame(0, 0, 0, 0) });
		}

		const known = new Set([
			"address", "class", "cls", "frame", "text",
			"textSource", "text_source",
			"accessibility_id", "accessibilityIdentifier",
			"hidden", "alpha",
			"isKeyWindow", "is_key_window",
			"windowLevel", "window_level",
			"windowClass", "window_class",
			"containsPresentedSheet", "contains_presented_sheet",
			"presentedViews", "presented_views",
			"onScreen", "on_screen",
			"offscreenChildCount", "offscreen_child_count",
			"children", "subviews",
		]);
		const extra: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(raw)) {
			if (!known.has(k)) extra[k] = v;
		}

		const alpha = numOr(raw.alpha, 1.0);
		const windowLevelRaw = raw.windowLevel ?? raw.window_level;
		const windowLevel = windowLevelRaw === null || windowLevelRaw === undefined ? null : numOrNull(windowLevelRaw);
		const onScreenRaw = raw.onScreen ?? raw.on_screen;
		const onScreen = onScreenRaw === null || onScreenRaw === undefined ? null : Boolean(onScreenRaw);
		const offscreenChildCount = intOr(raw.offscreenChildCount ?? raw.offscreen_child_count, 0);

		return new ViewNode({
			address: String(address ?? ""),
			cls: String(clsName ?? "Unknown"),
			frame: Frame.fromAny(raw.frame),
			text: (raw.text ?? null) as string | null,
			textSource: (raw.textSource ?? raw.text_source ?? null) as string | null,
			accessibilityId: (raw.accessibility_id ?? raw.accessibilityIdentifier ?? null) as string | null,
			hidden: Boolean(raw.hidden ?? false),
			alpha,
			isKeyWindow: Boolean(raw.isKeyWindow ?? raw.is_key_window ?? false),
			windowLevel,
			windowClass: (raw.windowClass ?? raw.window_class ?? null) as string | null,
			containsPresentedSheet: Boolean(raw.containsPresentedSheet ?? raw.contains_presented_sheet ?? false),
			presentedViews,
			onScreen,
			offscreenChildCount,
			extra,
			children,
		});
	}

	/** Shallow copy with a replaced `extra` map (models are immutable). */
	withExtra(extra: Record<string, unknown>): ViewNode {
		return new ViewNode({ ...this.toInit(), extra });
	}

	private toInit(): ViewNodeInit {
		return {
			address: this.address,
			cls: this.cls,
			frame: this.frame,
			text: this.text,
			textSource: this.textSource,
			accessibilityId: this.accessibilityId,
			hidden: this.hidden,
			alpha: this.alpha,
			isKeyWindow: this.isKeyWindow,
			windowLevel: this.windowLevel,
			windowClass: this.windowClass,
			containsPresentedSheet: this.containsPresentedSheet,
			presentedViews: [...this.presentedViews],
			onScreen: this.onScreen,
			offscreenChildCount: this.offscreenChildCount,
			extra: this.extra,
			children: [...this.children],
		};
	}

	/**
	 * Depth-first traversal that ALSO yields presented sheet/modal subtrees.
	 * Callers building an on-screen address whitelist would otherwise miss
	 * sheet content entirely.
	 */
	*walk(): Generator<ViewNode> {
		yield this;
		for (const c of this.children) yield* c.walk();
		for (const p of this.presentedViews) yield* p.walk();
	}

	/** Heuristic visibility check. Useful for filtering search results. */
	isVisible(): boolean {
		if (this.hidden) return false;
		if (this.alpha <= 0.01) return false;
		if (this.frame.width <= 0 || this.frame.height <= 0) return false;
		return true;
	}

	totalNodeCount(): number {
		let n = 1;
		for (const c of this.children) n += c.totalNodeCount();
		return n;
	}
}

export interface VCNodeInit {
	address: string;
	cls: string;
	title?: string | null;
	presented?: VCNode | null;
	children?: VCNode[];
	selected?: boolean;
	selectedIndex?: number | null;
	selectedChild?: VCNode | null;
	extra?: Record<string, unknown>;
}

export class VCNode {
	readonly address: string;
	readonly cls: string;
	readonly title: string | null;
	readonly presented: VCNode | null;
	readonly children: readonly VCNode[];
	readonly selected: boolean;
	readonly selectedIndex: number | null;
	readonly selectedChild: VCNode | null;
	readonly extra: Record<string, unknown>;

	constructor(init: VCNodeInit) {
		this.address = init.address;
		this.cls = init.cls;
		this.title = init.title ?? null;
		this.presented = init.presented ?? null;
		this.children = init.children ?? [];
		this.selected = init.selected ?? false;
		this.selectedIndex = init.selectedIndex ?? null;
		this.selectedChild = init.selectedChild ?? null;
		this.extra = init.extra ?? {};
	}

	static fromDict(raw: unknown): VCNode {
		if (!isRecord(raw)) return new VCNode({ address: "", cls: "Empty" });

		const childrenRaw = asArray(
			raw.children ?? raw.childViewControllers ?? raw.viewControllers,
		);
		const children = childrenRaw.filter(isRecord).map((c) => VCNode.fromDict(c));

		const presentedRaw = raw.presented ?? raw.presentedViewController;
		const presented = isRecord(presentedRaw) ? VCNode.fromDict(presentedRaw) : null;

		const selectedChildRaw =
			raw.selectedViewController ??
			raw.selected_view_controller ??
			raw.activeViewController ??
			raw.active_view_controller;
		const selectedChild = isRecord(selectedChildRaw) ? VCNode.fromDict(selectedChildRaw) : null;

		let selectedIndex: number | null = null;
		let selectedIndexRaw = raw.selectedIndex ?? raw.selected_index;
		if (selectedIndexRaw === null || selectedIndexRaw === undefined) {
			selectedIndexRaw = raw.activeIndex ?? raw.active_index;
		}
		if (selectedIndexRaw !== null && selectedIndexRaw !== undefined) {
			selectedIndex = numOrNull(selectedIndexRaw);
			if (selectedIndex !== null) selectedIndex = Math.trunc(selectedIndex);
		}

		let selectedRaw: unknown = raw.isSelected;
		if ((selectedRaw === null || selectedRaw === undefined) && typeof raw.selected === "boolean") {
			selectedRaw = raw.selected;
		}

		const clsName = raw.class ?? raw.cls;
		const address = raw.address;
		if (!clsName && !address && children.length === 0 && !presented && !selectedChild) {
			return new VCNode({ address: "", cls: "Empty" });
		}

		const known = new Set([
			"address", "class", "cls", "title",
			"presented", "presentedViewController",
			"children", "childViewControllers", "viewControllers",
			"selected", "isSelected",
			"selectedIndex", "selected_index",
			"activeIndex", "active_index",
			"selectedViewController", "selected_view_controller",
			"activeViewController", "active_view_controller",
		]);
		const extra: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(raw)) {
			if (!known.has(k)) extra[k] = v;
		}

		return new VCNode({
			address: String(address ?? ""),
			cls: String(clsName ?? "Unknown"),
			title: (raw.title ?? null) as string | null,
			presented,
			children,
			selected: selectedRaw !== null && selectedRaw !== undefined ? Boolean(selectedRaw) : false,
			selectedIndex,
			selectedChild,
			extra,
		});
	}

	*walk(): Generator<VCNode> {
		yield this;
		if (this.presented) yield* this.presented.walk();
		if (this.selectedChild) yield* this.selectedChild.walk();
		for (const c of this.children) yield* c.walk();
	}

	/**
	 * Return the VC that is actually on screen. Descent order at each level:
	 *   1. `presented` (modal covers everything underneath)
	 *   2. `selectedChild` (tab/segmented active branch, index/selected fallback)
	 *   3. last `children` entry (nav-controller stack top)
	 * Capped so a pathological cycle can't hang the caller.
	 */
	visibleLeaf(): VCNode {
		// biome-ignore lint/complexity/noUselessThisAlias: intentional cursor walk
		let cur: VCNode = this;
		for (let i = 0; i < 64; i++) {
			if (cur.presented !== null) {
				cur = cur.presented;
				continue;
			}
			const picked = activeVcChild(cur);
			if (picked === cur) return cur;
			cur = picked;
		}
		return cur;
	}
}

/** Return the active child of `vc` — `vc` itself if there is none. */
function activeVcChild(vc: VCNode): VCNode {
	if (vc.selectedChild !== null) return vc.selectedChild;
	if (vc.children.length === 0) return vc;
	const clsL = (vc.cls || "").toLowerCase();
	if (clsL.includes("tabbar") || clsL.includes("tab_bar")) {
		for (const child of vc.children) {
			if (child.selected) return child;
		}
		const idx = vc.selectedIndex;
		if (idx !== null && idx >= 0 && idx < vc.children.length) return vc.children[idx]!;
		return vc.children[0]!;
	}
	return vc.children[vc.children.length - 1]!;
}

export type TapMethod = "public_api" | "gesture_reflection" | "coordinate" | "unknown";

export class TapResult {
	readonly targetAddress: string | null;
	readonly method: TapMethod;
	readonly handledBy: string | null;
	readonly raw: Record<string, unknown>;

	constructor(init: {
		targetAddress: string | null;
		method: TapMethod;
		handledBy?: string | null;
		raw?: Record<string, unknown>;
	}) {
		this.targetAddress = init.targetAddress;
		this.method = init.method;
		this.handledBy = init.handledBy ?? null;
		this.raw = init.raw ?? {};
	}

	static fromDict(raw: unknown): TapResult {
		if (!isRecord(raw)) return new TapResult({ targetAddress: null, method: "unknown" });
		let method = (raw.method ?? raw.via ?? "unknown") as string;
		if (method !== "public_api" && method !== "gesture_reflection" && method !== "coordinate") {
			method = "unknown";
		}
		return new TapResult({
			targetAddress: (raw.address ?? raw.target ?? null) as string | null,
			method: method as TapMethod,
			handledBy: (raw.handled_by ?? raw.handledBy ?? null) as string | null,
			raw,
		});
	}
}

// ---- coercion helpers -------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
	return Array.isArray(v) ? v : [];
}

function num(v: unknown): number {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
}

function numOr(v: unknown, fallback: number): number {
	if (v === null || v === undefined) return fallback;
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

function numOrNull(v: unknown): number | null {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function intOr(v: unknown, fallback: number): number {
	if (v === null || v === undefined) return fallback;
	const n = Number(v);
	return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
