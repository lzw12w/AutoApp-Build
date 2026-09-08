/**
 * Para iOS tools, ported from ios_inspector_agent/actions/*.py to pi's
 * `defineTool` / `registerTool` shape. Each tool wraps an InspectorClient
 * call, returns Para's structured ok/data (or ok:false) result, and threads
 * the AbortSignal through for cancellation.
 *
 * Screenshot returns an ImageContent block so the model sees the pixels;
 * everything else returns JSON or plain text (screen_digest).
 *
 * `mutates_ui` tools (tap_with_diff/scroll/swipe/input/back/dismiss/switch_tab/open_url/
 * appoint_feed_story) drive UI state — the knowledge observer (Phase 3) hooks pi's
 * tool_result event to attribute page transitions to them.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { InspectorClient } from "../client.ts";
import { ViewNode, type VCNode } from "../models.ts";
import { InspectorError } from "../errors.ts";
import { buildScreenDigest, vcLabelFromVc } from "../screen-digest.ts";
import { reportTapTarget, type TapTargetHook, usableTapNode } from "../knowledge/tap-target.ts";
import {
	applyVisibleOnly,
	FIND_TREE_DEPTH,
	localFindCandidates,
	preferVisible,
	rankFindCandidates,
	resolveTapIntent,
	tabIndexForTarget,
	type FindSelector,
} from "./find.ts";
import { interactionTargetSummary, nodeSummary, nodeToDict, vcSummary } from "./format.ts";
import { compactInspectorAction, errResult, guard, okResult, textResult } from "./result.ts";
import { skipped, textValue, vcDiff, vcSummaryNow } from "./post-check.ts";
import { screenFrameForMotion, scrollDeltaToSwipePoints } from "./scroll-motion.ts";
import { DIGEST_DEPTH, snapshotStable } from "./snapshot.ts";
import { resolveFinderTarget, tapWithDiffTool } from "./tap-with-diff.ts";
import { waitForTool } from "./wait.ts";

/** Tool names that change UI state — the single source of truth (Python's MUTATING_TOOL_NAMES). */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
	"tap_with_diff", "long_press", "scroll", "swipe", "input_text", "dismiss", "back",
	"switch_tab", "open_url", "appoint_feed_story",
]);

type Details = { ok: boolean } & Record<string, unknown>;

/** Called after a successful inspect fetch so the knowledge observer can seed `currentPage`. */
export interface InspectHooks {
	onInspect?: (view: ViewNode, vc: VCNode | null) => void | Promise<void>;
	/** Swap the pending tap/long_press action for a stable target summary. */
	onTapTarget?: TapTargetHook;
}

async function feedInspect(
	hooks: InspectHooks | undefined,
	view: ViewNode,
	vc: VCNode | null,
): Promise<void> {
	try {
		await hooks?.onInspect?.(view, vc);
	} catch {
		// observer is best-effort; never fail the inspect tool
	}
}

export function buildTools(client: InspectorClient, hooks: InspectHooks = {}) {
	const tools = [];

	// ---- inspect (read-only) ------------------------------------------

	tools.push(
		defineTool({
			name: "ping",
			label: "Ping",
			description: "Health check the SAInspector HTTP server. Use first when uncertain about connectivity.",
			parameters: Type.Object({}),
			execute: (_id, _p, signal) => guard<Details>(() => client.ping(signal)),
		}),
	);

	tools.push(
		defineTool({
			name: "vc_hierarchy",
			label: "VC hierarchy",
			description: "Get the current ViewController hierarchy. Use to know which page is shown.",
			parameters: Type.Object({}),
			execute: (_id, _p, signal) =>
				guard<Details>(
					() => client.vcHierarchy(signal),
					(vc) => okResult(vcSummary(vc as never)),
				),
		}),
	);

	tools.push(
		defineTool({
			name: "screen_digest",
			label: "Screen digest",
			description:
				"Reading-order navigation overview of the CURRENT screen. Preferred entry for multi-turn UI " +
				"exploration or picking the next tap / scroll target — one stable, fully-expanded on-screen " +
				"snapshot as compact plain text (no `depth` to guess, no truncation). Only VISIBLE views are " +
				"included; pure-layout containers with no text, id, image or interactive role are dropped. " +
				"Every remaining view is one line in DFS reading order; lines may include `aid=` (prefer that " +
				"for tap_with_diff(accessibility_id=)) and always end with the real hex address. `@idx` is only a " +
				"within-snapshot label). Leaf-only cells fold into one line. Updates the current-page snapshot " +
				"like view_hierarchy. Drops geometry and styling — for design / visual QA use view_hierarchy " +
				"+ view_inspect.",
			parameters: Type.Object({}),
			execute: (_id, _params, signal) =>
				guard<Details>(
					async () => {
						const tree = await snapshotStable(
							() =>
								client.viewHierarchy({
									depth: DIGEST_DEPTH,
									includeHidden: false,
									onScreenOnly: true,
									signal,
								}),
							{ signal },
						);
						const vc = await client.vcHierarchy(signal).catch(() => null);
						await feedInspect(hooks, tree, vc);
						return { tree, vc };
					},
					(data) => {
						const { tree, vc } = data as { tree: Parameters<typeof buildScreenDigest>[0]; vc: unknown };
						const label = vc ? vcLabelFromVc(vc as never) : null;
						return textResult(buildScreenDigest(tree, label));
					},
				),
		}),
	);

	tools.push(
		defineTool({
			name: "view_hierarchy",
			label: "View hierarchy",
			description:
				"Get the current view tree as nested JSON. Preferred when the task hinges on exact geometry, " +
				"structure, hidden nodes, or a specific subtree by address. Auto-retries briefly if the snapshot " +
				"appears unstable (mid-animation). Each node has address, class, frame=[x,y,w,h] (points; omitted " +
				"for zero-sized views), text (truncated to 80 chars), accessibility id. For UIImageView nodes the " +
				"server surfaces image_symbol_name / image_asset_name so icon-only buttons can be identified.",
			parameters: Type.Object({
				depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, default: 6 })),
				include_hidden: Type.Optional(Type.Boolean({ default: false })),
				on_screen_only: Type.Optional(Type.Boolean({ default: true })),
				address: Type.Optional(Type.String({ description: "Root the tree at this hex address instead of the key window. Stability gate is skipped." })),
				stability: Type.Optional(Type.Boolean({ default: true, description: "Wait for two consecutive snapshots to agree before returning." })),
			}),
			execute: (_id, params, signal) =>
				guard<Details>(
					async () => {
						const depth = params.depth ?? 6;
						const includeHidden = params.include_hidden ?? false;
						const onScreenOnly = params.on_screen_only ?? true;
						const stability = params.address ? false : (params.stability ?? true);
						const opts = { depth, includeHidden, onScreenOnly, signal };
						const node = params.address
							? await client.viewSubtree(params.address, opts)
							: await snapshotStable(() => client.viewHierarchy(opts), { stability, signal });
						if (hooks.onInspect) {
							const vc = await client.vcHierarchy(signal).catch(() => null);
							await feedInspect(hooks, node, vc);
						}
						return { node, depth, stability };
					},
					(data) => {
						const { node, depth, stability } = data as {
							node: Parameters<typeof nodeToDict>[0];
							depth: number;
							stability: boolean;
						};
						const tree = nodeToDict(node, depth);
						const meta: Record<string, unknown> = {
							total_nodes: node.totalNodeCount(),
							is_key_window: node.isKeyWindow,
							stability_used: stability,
							on_screen_only: params.on_screen_only ?? true,
							contains_presented_sheet: node.containsPresentedSheet,
						};
						if (node.windowClass) meta.window_class = node.windowClass;
						if (node.windowLevel !== null) meta.window_level = node.windowLevel;
						if (node.presentedViews.length > 0) meta.presented_view_count = node.presentedViews.length;
						if (node.offscreenChildCount) meta.offscreen_child_count = node.offscreenChildCount;
						const extra = node.extra;
						if (extra.resolved_from_view_controller) {
							meta.resolved_from_view_controller = true;
							if (extra.resolved_view_address) meta.resolved_view_address = extra.resolved_view_address;
							if (extra.view_controller_class) meta.view_controller_class = extra.view_controller_class;
							if (extra.resolve_hint) meta.hint = extra.resolve_hint;
						}
						return okResult({ ...tree, _meta: meta });
					},
				),
		}),
	);

	tools.push(
		defineTool({
			name: "find_view",
			label: "Find view",
			description:
				"Find views matching text / class / accessibility id / property_name. Returns a ranked list of " +
				"candidates. Use before tapping by text to inspect what would actually be hit. `property_name` " +
				"matches the Swift source-level identifier the server reflects from the view's superview / owning VC.",
			parameters: Type.Object({
				text: Type.Optional(Type.String()),
				class: Type.Optional(Type.String({ description: "Substring match on UIKit class name." })),
				accessibility_id: Type.Optional(Type.String()),
				property_name: Type.Optional(Type.String({ description: "Substring match on reflected Swift property name." })),
				max_results: Type.Optional(Type.Integer({ default: 8, maximum: 30 })),
				visible_only: Type.Optional(Type.Boolean({ default: true, description: "Drop reuse-pool / off-screen hits. Default true." })),
			}),
			execute: (_id, params, signal) =>
				guard<Details>(
					async () => {
						const sel: FindSelector = {
							text: params.text,
							cls: params.class,
							accessibilityId: params.accessibility_id,
							propertyName: params.property_name,
						};
						const visibleOnly = params.visible_only ?? true;
						let results: ViewNode[] = [];
						try {
							results = await client.viewSearch(
								{
									text: params.text,
									cls: params.class,
									accessibilityId: params.accessibility_id,
									propertyName: params.property_name,
								},
								signal,
							);
						} catch {
							results = [];
						}
						if (results.length === 0) {
							const tree = await client.viewHierarchy({
								depth: FIND_TREE_DEPTH,
								onScreenOnly: visibleOnly,
								signal,
							});
							results = localFindCandidates(tree, sel, visibleOnly);
						} else {
							results = preferVisible(results);
							results = applyVisibleOnly(results, visibleOnly);
						}
						results = rankFindCandidates(results, sel);
						return { results, visibleOnly };
					},
					(data) => {
						const { results, visibleOnly } = data as { results: ViewNode[]; visibleOnly: boolean };
						const max = params.max_results ?? 8;
						return okResult({
							count: results.length,
							results: results.slice(0, max).map(nodeSummary),
							filtered_visible_only: visibleOnly,
						});
					},
				),
		}),
	);

	tools.push(
		defineTool({
			name: "view_inspect",
			label: "View inspect",
			description: "Full detail for a single view by hex address (untruncated text, all reflected properties).",
			parameters: Type.Object({ address: Type.String() }),
			execute: (_id, params, signal) => guard<Details>(() => client.viewInspect(params.address, signal)),
		}),
	);

	tools.push(
		defineTool({
			name: "screenshot",
			label: "Screenshot",
			description: "Capture a screenshot of the current screen. Returns the image so you can see the actual pixels.",
			parameters: Type.Object({
				quality: Type.Optional(Type.Number({ minimum: 0.1, maximum: 1.0, default: 0.5 })),
				scale: Type.Optional(Type.Number({ minimum: 0.25, maximum: 1.0, default: 0.5 })),
			}),
			async execute(_id, params, signal) {
				try {
					const raw = await client.screenshot({
						quality: params.quality ?? 0.5,
						scale: params.scale ?? 0.5,
						signal,
					});
					const b64 = raw.base64 ?? raw.image ?? raw.data;
					if (typeof b64 === "string" && b64) {
						return {
							content: [
								{ type: "text", text: JSON.stringify({ ok: true, width: raw.width, height: raw.height }) },
								{ type: "image", data: b64, mimeType: "image/jpeg" },
							],
							details: { ok: true, width: raw.width, height: raw.height } as Details,
						};
					}
					return okResult<Details>(raw);
				} catch (e) {
					return errResult<Details>(e);
				}
			},
		}),
	);

	// ---- read state ---------------------------------------------------

	tools.push(
		defineTool({
			name: "app_state",
			label: "App state",
			description: "Foreground app state: bundle id, active VC, environment.",
			parameters: Type.Object({}),
			execute: (_id, _p, signal) => guard<Details>(() => client.appState(signal)),
		}),
	);

	tools.push(
		defineTool({
			name: "device_info",
			label: "Device info",
			description: "Device identity & environment: biz_uid/uid/did/iid, env, lane, build metadata.",
			parameters: Type.Object({}),
			execute: (_id, _p, signal) => guard<Details>(() => client.deviceInfo(signal)),
		}),
	);

	tools.push(
		defineTool({
			name: "network_log",
			label: "Network log",
			description: "Recent network requests captured by the inspector.",
			parameters: Type.Object({ limit: Type.Optional(Type.Integer({ default: 20, maximum: 200 })) }),
			execute: (_id, params, signal) => guard<Details>(() => client.networkLog(params.limit ?? 20, signal)),
		}),
	);

	tools.push(
		defineTool({
			name: "console_log",
			label: "Console log",
			description: "Recent console / logging output captured by the inspector.",
			parameters: Type.Object({ limit: Type.Optional(Type.Integer({ default: 50, maximum: 500 })) }),
			execute: (_id, params, signal) => guard<Details>(() => client.consoleLog(params.limit ?? 50, signal)),
		}),
	);

	tools.push(
		defineTool({
			name: "user_defaults",
			label: "User defaults",
			description: "Read NSUserDefaults entries (optionally filtered by prefix or specific keys).",
			parameters: Type.Object({
				prefix: Type.Optional(Type.String()),
				keys: Type.Optional(Type.Array(Type.String())),
				limit: Type.Optional(Type.Integer({ default: 50, maximum: 500 })),
			}),
			execute: (_id, params, signal) =>
				guard<Details>(() =>
					client.userDefaults({ prefix: params.prefix, keys: params.keys, limit: params.limit ?? 50, signal }),
				),
		}),
	);

	tools.push(
		defineTool({
			name: "ab_experiments",
			label: "AB experiments",
			description: "Read active AB experiment assignments exposed by the inspector.",
			parameters: Type.Object({
				keys: Type.Optional(Type.Array(Type.String())),
				limit: Type.Optional(Type.Integer({ default: 30, maximum: 500 })),
			}),
			execute: (_id, params, signal) =>
				guard<Details>(() => client.abExperiments({ keys: params.keys, limit: params.limit ?? 30, signal })),
		}),
	);

	tools.push(
		defineTool({
			name: "feature_flags",
			label: "Feature flags",
			description: "Read feature flag values exposed by the inspector.",
			parameters: Type.Object({
				keys: Type.Optional(Type.Array(Type.String())),
				limit: Type.Optional(Type.Integer({ default: 30, maximum: 500 })),
			}),
			execute: (_id, params, signal) =>
				guard<Details>(() => client.featureFlags({ keys: params.keys, limit: params.limit ?? 30, signal })),
		}),
	);

	// ---- interaction (mutating) ---------------------------------------

	tools.push(tapWithDiffTool(client, hooks));
	tools.push(waitForTool(client, hooks));

	tools.push(
		defineTool({
			name: "long_press",
			label: "Long press",
			description:
				"Long-press a view. Prefer `accessibility_id` from screen_digest (`aid=`), otherwise `address` or `x`/`y`. **Mutating**.",
			parameters: Type.Object({
				accessibility_id: Type.Optional(Type.String({ description: "Stable aid= from screen_digest." })),
				address: Type.Optional(Type.String()),
				x: Type.Optional(Type.Number()),
				y: Type.Optional(Type.Number()),
				duration: Type.Optional(Type.Number({ default: 0.6 })),
			}),
			execute: (_id, params, signal) =>
				guard<Details>(async () => {
					const intent = resolveTapIntent(params);
					if (intent.mode === "none") {
						throw new InspectorError(
							"long_press requires address, both x/y, or accessibility_id",
							"E_INVALID_ARGUMENT",
						);
					}
					let address = intent.address;
					let x = intent.x;
					let y = intent.y;
					if (intent.mode === "selector") {
						const tree = await client.viewHierarchy({
							depth: FIND_TREE_DEPTH,
							includeHidden: false,
							onScreenOnly: true,
							signal,
						});
						const found = await resolveFinderTarget(
							client,
							tree,
							intent.selector,
							undefined,
							signal,
						);
						address = found.address;
						x = undefined;
						y = undefined;
					}
					let target: ViewNode | null = null;
					if (address) {
						try {
							target = ViewNode.fromDict(await client.viewInspect(address, signal));
						} catch {
							target = null;
						}
					}
					const result = (await client.longPress({
						address,
						x,
						y,
						duration: params.duration,
						signal,
					})) as Record<string, unknown>;
					reportTapTarget(hooks.onTapTarget, "long_press", target ? usableTapNode(target) : null, null, {
						x,
						y,
					});
					const interactionTarget = target ? interactionTargetSummary(target) : null;
					const payload = compactInspectorAction(result);
					if (interactionTarget) payload.interaction_target = interactionTarget;
					return payload;
				}),
		}),
	);

	tools.push(
		defineTool({
			name: "scroll",
			label: "Scroll",
			description:
				"Scroll via a swipe gesture. Positive dy reveals lower content; negative dy reveals earlier content. " +
				"Omit `address` to target the main vertical list (collection/table), not a horizontal pager. " +
				"**Mutating**.",
			parameters: Type.Object({
				dx: Type.Optional(Type.Number({ default: 0 })),
				dy: Type.Optional(Type.Number({ default: 400, description: "Positive = scroll down." })),
				address: Type.Optional(Type.String({ description: "Optional scroll-view address." })),
				duration: Type.Optional(Type.Number({ default: 0.25 })),
				animated: Type.Optional(Type.Boolean({ default: true })),
			}),
			execute: (_id, params, signal) =>
				guard<Details>(async () => {
					const dx = params.dx ?? 0;
					const dy = params.dy ?? 400;
					if (!dx && !dy) {
						throw new InspectorError("scroll requires a non-zero dx or dy", "E_INVALID_ARGUMENT");
					}
					let address = params.address as string | undefined;
					let frame: { x: number; y: number; width: number; height: number } | null = null;
					if (!address) {
						try {
							const tree = await client.viewHierarchy({
								depth: FIND_TREE_DEPTH,
								includeHidden: false,
								onScreenOnly: true,
								signal,
							});
							frame = screenFrameForMotion(tree);
						} catch {
							frame = null;
						}
					}
					if (address) {
						try {
							const inspected = ViewNode.fromDict(await client.viewInspect(address, signal));
							frame = screenFrameForMotion(inspected);
						} catch {
							frame = null;
						}
					}
					const points = scrollDeltaToSwipePoints(dx, dy, frame ?? undefined);
					const duration = params.animated === false ? 0 : (params.duration ?? 0.25);
					const result = (await client.swipe({
						address,
						startX: points.start_x,
						startY: points.start_y,
						endX: points.end_x,
						endY: points.end_y,
						duration,
						signal,
					})) as Record<string, unknown>;
					const payload = compactInspectorAction(result);
					payload.gesture = points;
					payload.post_check = skipped("scroll motion has no fixed target");
					return payload;
				}),
		}),
	);

	tools.push(
		defineTool({
			name: "swipe",
			label: "Swipe",
			description:
				"Swipe gesture. Provide either a target `address` + direction delta (dx/dy) or explicit " +
				"start/end coordinates. **Mutating**.",
			parameters: Type.Object({
				address: Type.Optional(Type.String()),
				start_x: Type.Optional(Type.Number()),
				start_y: Type.Optional(Type.Number()),
				end_x: Type.Optional(Type.Number()),
				end_y: Type.Optional(Type.Number()),
				dx: Type.Optional(Type.Number()),
				dy: Type.Optional(Type.Number()),
				duration: Type.Optional(Type.Number({ default: 0.25 })),
			}),
			execute: (_id, params, signal) =>
				guard<Details>(async () => {
					const result = (await client.swipe({
						address: params.address,
						startX: params.start_x,
						startY: params.start_y,
						endX: params.end_x,
						endY: params.end_y,
						dx: params.dx,
						dy: params.dy,
						duration: params.duration,
						signal,
					})) as Record<string, unknown>;
					const payload = compactInspectorAction(result);
					payload.post_check = skipped("swipe motion has no fixed target");
					return payload;
				}),
		}),
	);

	tools.push(
		defineTool({
			name: "input_text",
			label: "Input text",
			description:
				"Type text into a field. Prefer `accessibility_id` from screen_digest (`aid=`). " +
				"Otherwise target by `address` or `x`/`y`. Omit the target only when a field is already focused. " +
				"clear / append / submit are optional. **Mutating**.",
			parameters: Type.Object({
				text: Type.String(),
				submit: Type.Optional(Type.Boolean({ default: false })),
				clear: Type.Optional(Type.Boolean({ default: false })),
				append: Type.Optional(Type.Boolean({ default: false })),
				accessibility_id: Type.Optional(Type.String({ description: "Stable aid= from screen_digest." })),
				address: Type.Optional(Type.String()),
				x: Type.Optional(Type.Number()),
				y: Type.Optional(Type.Number()),
			}),
			execute: (_id, params, signal) =>
				guard<Details>(async () => {
					// `text` here is the typed string, not a finder selector.
					const intent = resolveTapIntent({
						address: params.address,
						x: params.x,
						y: params.y,
						accessibility_id: params.accessibility_id,
					});
					let address = intent.address;
					let x = intent.x;
					let y = intent.y;
					if (intent.mode === "selector") {
						const tree = await client.viewHierarchy({
							depth: FIND_TREE_DEPTH,
							includeHidden: false,
							onScreenOnly: true,
							signal,
						});
						const found = await resolveFinderTarget(
							client,
							tree,
							intent.selector,
							undefined,
							signal,
						);
						address = found.address;
						x = undefined;
						y = undefined;
					}
					const target = address
						? await client
								.viewInspect(address, signal)
								.then((raw) => ViewNode.fromDict(raw))
								.catch(() => null)
						: null;
					const result = (await client.inputText({
						text: params.text,
						submit: params.submit,
						clear: params.clear,
						append: params.append,
						address,
						x,
						y,
						signal,
					})) as Record<string, unknown>;
					const payload = compactInspectorAction(result);
					payload.post_check = address
						? await textValue(client, address, { signal })
						: skipped("input_text without address");
					const interactionTarget = target ? interactionTargetSummary(target) : null;
					if (interactionTarget) payload.interaction_target = interactionTarget;
					return payload;
				}),
		}),
	);

	tools.push(
		defineTool({
			name: "dismiss",
			label: "Dismiss",
			description:
				"Dismiss the top-most presented view controller (modal/sheet). " +
				"If nothing is presented, returns ok:false — it will not silently resign first-responder / keyboard. **Mutating**.",
			parameters: Type.Object({ animated: Type.Optional(Type.Boolean({ default: true })) }),
			execute: (_id, params, signal) =>
				guard<Details>(async () => {
					const beforeVc = await vcSummaryNow(client, signal);
					const compacted = compactInspectorAction(await client.dismiss(params.animated ?? true, signal));
					if (compacted.mode === "endEditing") {
						throw new InspectorError(
							"no presented view controller to dismiss (Inspector fell back to keyboard endEditing)",
							"E_NO_PRESENTED",
							compacted,
						);
					}
					compacted.post_check = await vcDiff(client, beforeVc, { signal });
					return compacted;
				}),
		}),
	);

	tools.push(
		defineTool({
			name: "back",
			label: "Back",
			description: "Pop the top view controller off the navigation stack (system back). **Mutating**.",
			parameters: Type.Object({ animated: Type.Optional(Type.Boolean({ default: true })) }),
			execute: (_id, params, signal) =>
				guard<Details>(async () => {
					const beforeVc = await vcSummaryNow(client, signal);
					const payload = compactInspectorAction(await client.back(params.animated ?? true, signal));
					payload.post_check = await vcDiff(client, beforeVc, { signal });
					return payload;
				}),
		}),
	);

	tools.push(
		defineTool({
			name: "switch_tab",
			label: "Switch tab",
			description:
				"Switch the tab bar by `index`, `title`, or `accessibility_id` (prefer `aid=mainTab.item.*` from " +
				"screen_digest — tab titles are often localization keys, not the visible name). **Mutating**.",
			parameters: Type.Object({
				index: Type.Optional(Type.Integer({ minimum: 0 })),
				title: Type.Optional(Type.String()),
				accessibility_id: Type.Optional(Type.String()),
			}),
			execute: (_id, params, signal) =>
				guard<Details>(async () => {
					let index = params.index as number | undefined;
					const title = params.title as string | undefined;
					if (index === undefined && !title && params.accessibility_id) {
						const tree = await client.viewHierarchy({
							depth: FIND_TREE_DEPTH,
							includeHidden: false,
							onScreenOnly: true,
							signal,
						});
						const target = await resolveFinderTarget(
							client,
							tree,
							{ accessibilityId: params.accessibility_id },
							undefined,
							signal,
						);
						const resolved = tabIndexForTarget(tree, target);
						if (resolved === null) {
							throw new InspectorError(
								`aid=${JSON.stringify(params.accessibility_id)} is not inside a tab bar; use tap_with_diff(accessibility_id=)`,
								"E_TARGET_NOT_FOUND",
							);
						}
						index = resolved;
					}
					if (index === undefined && !title) {
						throw new InspectorError("provide index, title, or accessibility_id", "E_INVALID_ARGUMENT");
					}
					const beforeVc = await vcSummaryNow(client, signal);
					const payload = compactInspectorAction(await client.switchTab({ index, title, signal }));
					payload.post_check = await vcDiff(client, beforeVc, { signal });
					return payload;
				}),
		}),
	);

	tools.push(
		defineTool({
			name: "open_url",
			label: "Open URL",
			description: "Open a deep link / universal link URL in the app. **Mutating**.",
			parameters: Type.Object({
				url: Type.String(),
				animated: Type.Optional(Type.Boolean({ default: true })),
			}),
			execute: (_id, params, signal) =>
				guard<Details>(async () => {
					// Soft guardrail: WARN (do not block) on destructive-looking routes.
					const lower = params.url.toLowerCase();
					let warning: string | null = null;
					for (const bad of ["wipe", "clear_cache", "logout", "delete_account", "internal_debug", "hard_reset"]) {
						if (lower.includes(bad)) {
							warning = `route contains sensitive keyword '${bad}'`;
							break;
						}
					}
					const beforeVc = await vcSummaryNow(client, signal);
					const result = await client.openUrl(params.url, params.animated ?? true, signal);
					const postCheck = await vcDiff(client, beforeVc, { signal });
					const payload: Record<string, unknown> = { opened: params.url, result, post_check: postCheck };
					if (warning) payload.warning = warning;
					return payload;
				}),
		}),
	);

	tools.push(
		defineTool({
			name: "set_lane",
			label: "Set lane",
			description:
				"Set the lane for a target network env. `env` is REQUIRED and must be `boe` or `ppe`. " +
				"Pass a `lane` name; omit or empty to clear (env default). Does not mutate the on-screen tree. " +
				"Call device_info to read the current env / lane.",
			parameters: Type.Object({
				env: Type.Union([Type.Literal("boe"), Type.Literal("ppe")]),
				lane: Type.Optional(Type.String()),
			}),
			execute: (_id, params, signal) => guard<Details>(() => client.setLane(params.env, params.lane ?? null, signal)),
		}),
	);

	tools.push(
		defineTool({
			name: "appoint_feed_story",
			label: "Appoint feed story",
			description:
				"Force-insert stories into the Feed. Sets the given story IDs and navigates back to the home Feed tab. " +
				"Pass multiple IDs as a comma-separated string. **Mutating**.",
			parameters: Type.Object({
				story_ids: Type.String({ description: "Story IDs to insert, comma-separated (e.g. '123,456,789')" }),
			}),
			execute: (_id, params, signal) =>
				guard<Details>(async () => {
					const rawIds = params.story_ids.replace(/，/g, ",").split(",").map((s) => s.trim());
					const validIds = rawIds.filter((sid) => /^\d+$/.test(sid));
					if (validIds.length === 0) {
						throw new InspectorError(`No valid numeric story IDs found in: ${params.story_ids}`, "E_INVALID_ARGS");
					}
					const result = await client.appointFeedStories({ storyIds: validIds, signal });
					return {
						appointed_stories: validIds,
						count: validIds.length,
						result,
						message: `appointed ${validIds.length} story(ies) to Feed; effective immediately`,
					};
				}),
		}),
	);

	return tools;
}
