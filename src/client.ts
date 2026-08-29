/**
 * High-level inspector client. Methods return typed results (models.ts) and
 * raise the typed errors from errors.ts. Ported from
 * ios_inspector_agent/core/client.py.
 *
 * Every high-level call funnels through `this.transport` so the transport can
 * be swapped or mocked in tests. An optional AbortSignal is threaded through
 * to support pi's per-tool cancellation.
 */
import { InvalidArgument, InvalidResponse } from "./errors.ts";
import { TapResult, VCNode, ViewNode } from "./models.ts";
import { Transport } from "./transport.ts";
import type { TransportOptions } from "./transport.ts";

// Well-known UIKit-internal windows that must not be mistaken for the app's
// main window.
const OVERLAY_WINDOW_CLASSES = new Set([
	"UITextEffectsWindow",
	"UIRemoteKeyboardWindow",
	"_UIAlertControllerShimPresenterWindow",
	"UITransitionView",
]);

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nodeArea(node: unknown): number {
	if (!isRecord(node)) return 0;
	const frame = isRecord(node.frame) ? node.frame : {};
	const w = Number(frame.width ?? 0) || 0;
	const h = Number(frame.height ?? 0) || 0;
	return w * h;
}

function nodeSubviewCount(node: unknown): number {
	if (!isRecord(node)) return 0;
	const kids = node.subviews ?? node.children;
	return Array.isArray(kids) ? kids.length : 0;
}

/**
 * Pick the most relevant window from the server's window list. Selection
 * priority: presented sheet/modal owner → isKeyWindow → exclude overlays →
 * largest visible footprint → first window.
 */
export function pickMainWindow(windows: unknown[]): Json {
	if (!windows || windows.length === 0) {
		throw new InvalidResponse("server returned empty windows list");
	}

	// 1. window owning a presented sheet/modal trumps everything else
	for (const w of windows) {
		if (isRecord(w) && w.containsPresentedSheet) return w;
	}
	for (const w of windows) {
		if (isRecord(w)) {
			const presented = w.presentedViews;
			if (Array.isArray(presented) && presented.length > 0) return w;
		}
	}

	// 2. explicit isKeyWindow hint from server
	for (const w of windows) {
		if (isRecord(w) && w.isKeyWindow) return w;
	}

	// 3. exclude obvious overlays unless they're all we have
	let candidates = windows.filter(
		(w): w is Json => isRecord(w) && !OVERLAY_WINDOW_CLASSES.has(String(w.class ?? "")),
	);
	if (candidates.length === 0) candidates = windows.filter(isRecord);
	if (candidates.length === 0) throw new InvalidResponse("no valid window dicts in response");

	// 4. footprint + subview-count heuristic
	let best = candidates[0]!;
	let bestKey: [number, number] = [nodeArea(best), nodeSubviewCount(best)];
	for (const w of candidates) {
		const key: [number, number] = [nodeArea(w), nodeSubviewCount(w)];
		if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
			best = w;
			bestKey = key;
		}
	}
	return best;
}

/** Coerce a server hierarchy response into a single root node dict. */
export function normalizeHierarchyResponse(raw: unknown, kind: string): Json {
	if (!isRecord(raw)) {
		throw new InvalidResponse(`${kind} returned non-object: ${typeof raw}`);
	}

	if ("windows" in raw) {
		const wins = raw.windows ?? [];
		if (!Array.isArray(wins)) throw new InvalidResponse(`${kind}.windows is not a list`);
		if (wins.length === 0) {
			throw new InvalidResponse(
				`${kind}: server reported no visible windows (app may be backgrounded or still launching)`,
			);
		}
		return pickMainWindow(wins);
	}

	if ("root" in raw && isRecord(raw.root)) return raw.root;

	if ("class" in raw || "address" in raw || "subviews" in raw || "children" in raw) {
		return raw;
	}

	throw new InvalidResponse(
		`${kind}: response has no 'windows', 'root', or node fields. keys=${Object.keys(raw).slice(0, 8).join(",")}`,
	);
}

export interface ViewHierarchyOptions {
	depth?: number;
	includeHidden?: boolean;
	onScreenOnly?: boolean;
	signal?: AbortSignal;
}

export interface PointTarget {
	address?: string;
	x?: number;
	y?: number;
}

export class InspectorClient {
	readonly transport: Transport;
	private platform: string | null = null;
	private endpoints: ReadonlySet<string> | null = null;

	constructor(transportOrOptions: Transport | TransportOptions = {}) {
		this.transport =
			transportOrOptions instanceof Transport ? transportOrOptions : new Transport(transportOrOptions);
	}

	get baseUrl(): string {
		return this.transport.baseUrl;
	}

	// ---- health / state -------------------------------------------------

	async ping(signal?: AbortSignal): Promise<Json> {
		return asJson(await this.transport.get("/api/ping", { retries: 3, signal }));
	}

	async serverHealth(signal?: AbortSignal): Promise<Json> {
		return asJson(await this.transport.get("/api/server_health", { retries: 0, signal }));
	}

	async appState(signal?: AbortSignal): Promise<Json> {
		return asJson(await this.transport.get("/api/app_state", { signal }));
	}

	/** Device identity & environment: biz_uid/uid/did/iid, env, lane, build metadata. */
	async deviceInfo(signal?: AbortSignal): Promise<Json> {
		return asJson(await this.transport.get("/api/device_info", { signal }));
	}

	async memoryUsage(signal?: AbortSignal): Promise<Json> {
		return asJson(await this.transport.get("/api/memory_usage", { signal }));
	}

	// ---- structure ------------------------------------------------------

	async viewHierarchy(options: ViewHierarchyOptions = {}): Promise<ViewNode> {
		const raw = await this.transport.get("/api/view_hierarchy", {
			params: {
				depth: options.depth ?? 8,
				include_hidden: options.includeHidden ?? false,
				on_screen_only: options.onScreenOnly ?? true,
			},
			signal: options.signal,
		});
		return ViewNode.fromDict(normalizeHierarchyResponse(raw, "view_hierarchy"));
	}

	/** Raw response with all windows. Useful for diagnostics. */
	async viewHierarchyRaw(options: ViewHierarchyOptions = {}): Promise<Json> {
		return asJson(
			await this.transport.get("/api/view_hierarchy", {
				params: {
					depth: options.depth ?? 8,
					include_hidden: options.includeHidden ?? false,
					on_screen_only: options.onScreenOnly ?? true,
				},
				signal: options.signal,
			}),
		);
	}

	async vcHierarchy(signal?: AbortSignal): Promise<VCNode> {
		const raw = await this.transport.get("/api/vc_hierarchy", { signal });
		// vc_hierarchy returns {"windows": [{"rootViewController": {...}, ...}]}
		if (isRecord(raw) && "windows" in raw) {
			const wins = Array.isArray(raw.windows) ? raw.windows : [];
			if (wins.length === 0) {
				throw new InvalidResponse("vc_hierarchy: no windows with rootViewController returned");
			}
			let chosen: unknown = null;
			for (const w of wins) {
				if (isRecord(w) && isRecord(w.rootViewController)) {
					chosen = w.rootViewController;
					break;
				}
			}
			if (chosen === null) chosen = isRecord(wins[0]) ? wins[0] : {};
			return VCNode.fromDict(chosen);
		}
		if (isRecord(raw) && "root" in raw) return VCNode.fromDict(raw.root);
		return VCNode.fromDict(isRecord(raw) ? raw : {});
	}

	async viewInspect(address: string, signal?: AbortSignal): Promise<Json> {
		if (!address) throw new InvalidArgument("address is required");
		return asJson(await this.transport.get("/api/view_inspect", { params: { address }, signal }));
	}

	/** Pull the view subtree rooted at `address`. */
	async viewSubtree(
		address: string,
		options: ViewHierarchyOptions = {},
	): Promise<ViewNode> {
		if (!address) throw new InvalidArgument("address is required");
		const raw = await this.transport.get("/api/view_subtree", {
			params: {
				address,
				depth: options.depth ?? 8,
				include_hidden: options.includeHidden ?? false,
				on_screen_only: options.onScreenOnly ?? false,
			},
			signal: options.signal,
		});
		if (!isRecord(raw)) throw new InvalidResponse(`view_subtree returned non-object: ${typeof raw}`);
		const node = raw.root;
		if (!isRecord(node)) {
			throw new InvalidResponse(
				`view_subtree response missing 'root'. keys=${Object.keys(raw).slice(0, 8).join(",")}`,
			);
		}
		// Server-side VC->view fallback markers: surface them on the node's extra
		// so the action layer can report them and the agent stops passing VC
		// addresses.
		if (raw.resolvedFromViewController) {
			const base = ViewNode.fromDict(node);
			const extra: Json = { ...base.extra, resolved_from_view_controller: true };
			if (raw.resolvedViewAddress) extra.resolved_view_address = raw.resolvedViewAddress;
			if (raw.viewControllerClass) extra.view_controller_class = raw.viewControllerClass;
			if (raw.hint) extra.resolve_hint = raw.hint;
			return base.withExtra(extra);
		}
		return ViewNode.fromDict(node);
	}

	async viewSearch(
		criteria: {
			cls?: string;
			text?: string;
			accessibilityId?: string;
			tag?: number;
			propertyName?: string;
		},
		signal?: AbortSignal,
	): Promise<ViewNode[]> {
		const params: Json = {};
		if (criteria.cls) params.class = criteria.cls;
		if (criteria.text) params.text = criteria.text;
		if (criteria.accessibilityId) params.accessibility_id = criteria.accessibilityId;
		if (criteria.tag !== undefined && criteria.tag !== null) params.tag = criteria.tag;
		if (criteria.propertyName) params.property_name = criteria.propertyName;
		const raw = await this.transport.get("/api/view_search", { params, signal });
		const items = isRecord(raw) ? raw.results : raw;
		if (!Array.isArray(items)) throw new InvalidResponse("view_search did not return a list");
		return items.filter(isRecord).map((it) => ViewNode.fromDict(it));
	}

	async screenshot(options: { quality?: number; signal?: AbortSignal } = {}): Promise<Json> {
		return asJson(
			await this.transport.get("/api/screenshot", {
				params: { quality: options.quality ?? 0.7 },
				signal: options.signal,
			}),
		);
	}

	// ---- interaction ----------------------------------------------------

	async tap(
		target: PointTarget & { full?: boolean; signal?: AbortSignal },
	): Promise<TapResult> {
		const body = pointBody(target);
		body.compact = !target.full;
		const raw = await this.transport.post("/api/tap", { body, idempotent: false, signal: target.signal });
		return TapResult.fromDict(raw);
	}

	async longPress(
		target: PointTarget & { duration?: number; signal?: AbortSignal },
	): Promise<Json> {
		const body = pointBody(target);
		body.duration = target.duration ?? 0.6;
		return asJson(
			await this.transport.post("/api/long_press", { body, idempotent: false, signal: target.signal }),
		);
	}

	async swipe(options: {
		address?: string;
		startX?: number;
		startY?: number;
		endX?: number;
		endY?: number;
		dx?: number;
		dy?: number;
		duration?: number;
		signal?: AbortSignal;
	}): Promise<Json> {
		const body: Json = { duration: options.duration ?? 0.25 };
		if (options.address) body.address = options.address;
		const map: [string, number | undefined][] = [
			["start_x", options.startX],
			["start_y", options.startY],
			["end_x", options.endX],
			["end_y", options.endY],
			["dx", options.dx],
			["dy", options.dy],
		];
		for (const [k, v] of map) {
			if (v !== undefined && v !== null) body[k] = v;
		}
		return asJson(
			await this.transport.post("/api/swipe", { body, idempotent: false, signal: options.signal }),
		);
	}

	/** Legacy direct content-offset endpoint. Prefer swipe() for motion. */
	async scroll(options: {
		dx?: number;
		dy?: number;
		address?: string;
		animated?: boolean;
		signal?: AbortSignal;
	} = {}): Promise<Json> {
		const body: Json = {
			dx: options.dx ?? 0.0,
			dy: options.dy ?? 400.0,
			animated: options.animated ?? true,
		};
		if (options.address) body.address = options.address;
		return asJson(
			await this.transport.post("/api/scroll", { body, idempotent: false, signal: options.signal }),
		);
	}

	async inputText(options: {
		text: string;
		submit?: boolean;
		clear?: boolean;
		append?: boolean;
		address?: string;
		x?: number;
		y?: number;
		signal?: AbortSignal;
	}): Promise<Json> {
		const body: Json = {
			text: options.text,
			submit: options.submit ?? false,
			clear_existing: options.clear ?? false,
			append: options.append ?? false,
		};
		if (options.address) body.address = options.address;
		if (options.x !== undefined && options.y !== undefined) {
			body.x = options.x;
			body.y = options.y;
		}
		return asJson(
			await this.transport.post("/api/input_text", { body, idempotent: false, signal: options.signal }),
		);
	}

	async dismiss(animated = true, signal?: AbortSignal): Promise<Json> {
		return asJson(
			await this.transport.post("/api/dismiss", { body: { animated }, idempotent: false, signal }),
		);
	}

	async back(animated = true, signal?: AbortSignal): Promise<Json> {
		return asJson(
			await this.transport.post("/api/back", { body: { animated }, idempotent: false, signal }),
		);
	}

	async switchTab(options: { index?: number; title?: string; signal?: AbortSignal }): Promise<Json> {
		const body: Json = {};
		if (options.index !== undefined && options.index !== null) body.index = options.index;
		if (options.title) body.title = options.title;
		if (Object.keys(body).length === 0) throw new InvalidArgument("provide index or title");
		return asJson(
			await this.transport.post("/api/switch_tab", { body, idempotent: false, signal: options.signal }),
		);
	}

	async openUrl(url: string, animated = true, signal?: AbortSignal): Promise<Json> {
		if (!url) throw new InvalidArgument("url is required");
		return asJson(await this.transport.post("/api/open_url", { body: { url, animated }, signal }));
	}

	/**
	 * Set the lane of a target env (`env` is 'boe' or 'ppe'). `lane`
	 * null/empty clears the lane (env default).
	 */
	async setLane(env: string, lane?: string | null, signal?: AbortSignal): Promise<Json> {
		if (!env) throw new InvalidArgument("env is required (boe|ppe)");
		const body: Json = { env };
		if (lane !== undefined && lane !== null) body.lane = lane;
		return asJson(
			await this.transport.post("/api/set_lane", { body, idempotent: false, signal }),
		);
	}

	// ---- read state -----------------------------------------------------

	async networkLog(limit = 20, signal?: AbortSignal): Promise<Json> {
		return asJson(await this.transport.get("/api/network_log", { params: { limit }, signal }));
	}

	async consoleLog(limit = 50, signal?: AbortSignal): Promise<Json> {
		return asJson(await this.transport.get("/api/console_log", { params: { limit }, signal }));
	}

	async userDefaults(
		options: { prefix?: string; keys?: string[]; limit?: number; signal?: AbortSignal } = {},
	): Promise<Json> {
		const params: Json = { limit: options.limit ?? 50 };
		if (options.prefix) params.prefix = options.prefix;
		if (options.keys) params.keys = options.keys;
		return asJson(await this.transport.get("/api/user_defaults", { params, signal: options.signal }));
	}

	async appointFeedStories(options: {
		storyIds: string[];
		switchTab?: boolean;
		animated?: boolean;
		signal?: AbortSignal;
	}): Promise<Json> {
		const body: Json = {
			story_ids: [...options.storyIds],
			switch_tab: options.switchTab ?? true,
			animated: options.animated ?? false,
		};
		return asJson(
			await this.transport.post("/api/appoint_feed_stories", { body, idempotent: false, signal: options.signal }),
		);
	}

	async abExperiments(
		options: { keys?: string[]; limit?: number; signal?: AbortSignal } = {},
	): Promise<Json> {
		const params: Json = { limit: options.limit ?? 30 };
		if (options.keys) params.keys = options.keys;
		return asJson(await this.transport.get("/api/ab_experiments", { params, signal: options.signal }));
	}

	async featureFlags(
		options: { keys?: string[]; limit?: number; signal?: AbortSignal } = {},
	): Promise<Json> {
		const params: Json = { limit: options.limit ?? 30 };
		if (options.keys) params.keys = options.keys;
		return asJson(await this.transport.get("/api/feature_flags", { params, signal: options.signal }));
	}

	// ---- platform / endpoint discovery ----------------------------------

	/** Cached platform ("ios"/"android"/"") or null when never probed. */
	get inspectorPlatform(): string | null {
		return this.platform || null;
	}

	/** Cached endpoint set, or null when discovery never produced a list. */
	get inspectorEndpoints(): ReadonlySet<string> | null {
		return this.endpoints;
	}

	/** Actively probe the server platform, caching the result. */
	async serverPlatform(signal?: AbortSignal): Promise<string | null> {
		if (this.platform !== null) return this.platform || null;
		let payload: unknown;
		try {
			payload = await this.ping(signal);
		} catch {
			return null;
		}
		const platform = isRecord(payload) ? payload.platform : null;
		this.platform = platform ? String(platform).toLowerCase() : "";
		return this.platform || null;
	}

	async serverEndpoints(signal?: AbortSignal): Promise<Set<string> | null> {
		let payload: unknown;
		try {
			payload = await this.transport.get("/api", { retries: 0, signal });
		} catch {
			return null;
		}
		const endpoints = isRecord(payload) ? payload.endpoints : null;
		if (!Array.isArray(endpoints)) return null;
		return new Set(endpoints.map(String));
	}
}

/** Build the {address} or {x,y} body for a point-based interaction. */
function pointBody(target: PointTarget): Json {
	if (!target.address && (target.x === undefined || target.y === undefined)) {
		throw new InvalidArgument("provide address or both x/y");
	}
	const body: Json = {};
	if (target.address) body.address = target.address;
	if (target.x !== undefined && target.y !== undefined) {
		body.x = target.x;
		body.y = target.y;
	}
	return body;
}

function asJson(v: unknown): Json {
	return isRecord(v) ? v : {};
}
