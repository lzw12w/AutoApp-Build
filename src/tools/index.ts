/**
 * Para iOS tools, ported from ios_inspector_agent/actions/*.py to pi's
 * `defineTool` / `registerTool` shape. Each tool wraps an InspectorClient
 * call, returns Para's structured ok/data (or ok:false) result, and threads
 * the AbortSignal through for cancellation.
 *
 * Screenshot returns an ImageContent block so the model sees the pixels;
 * everything else returns JSON or plain text (screen_digest).
 *
 * `mutates_ui` tools (tap/scroll/swipe/input/back/dismiss/switch_tab/open_url/
 * set_lane) drive UI state — the knowledge observer (Phase 3) hooks pi's
 * tool_result event to attribute page transitions to them.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { InspectorClient } from "../client.ts";
import { ViewNode, type VCNode } from "../models.ts";
import { buildScreenDigest, vcLabelFromVc } from "../screen-digest.ts";
import { nodeSummary, nodeToDict, vcSummary } from "./format.ts";
import { errResult, guard, okResult, textResult } from "./result.ts";
import { tapWithDiffTool } from "./tap-with-diff.ts";
import { waitForTool } from "./wait.ts";

/** Tool names that change UI state — the single source of truth (Python's MUTATING_TOOL_NAMES). */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
	"tap", "tap_with_diff", "long_press", "scroll", "swipe", "input_text", "dismiss", "back",
	"switch_tab", "open_url", "set_lane", "appoint_feed_story",
]);

type Details = { ok: boolean } & Record<string, unknown>;

/** Called after a successful inspect fetch so the knowledge observer can seed `currentPage`. */
export interface InspectHooks {
	onInspect?: (view: ViewNode, vc: VCNode | null) => void | Promise<void>;
}

function placeholderWindow(): ViewNode {
	return ViewNode.fromDict({
		class: "UIWindow",
		address: "",
		frame: { x: 0, y: 0, width: 0, height: 0 },
	});
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
					async () => {
						const vc = await client.vcHierarchy(signal);
						await feedInspect(hooks, placeholderWindow(), vc);
						return vc;
					},
					(vc) => okResult(vcSummary(vc as never)),
				),
		}),
	);

	tools.push(
		defineTool({
			name: "screen_digest",
			label: "Screen digest",
			description:
				"Compact reading-order overview of the CURRENT screen: visible, content-bearing views only, " +
				"as an indented plain-text list with each node's address. Preferred first look at a page — " +
				"much cheaper than view_hierarchy. Use view_hierarchy when you need exact geometry or hidden nodes.",
			parameters: Type.Object({
				depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 40, default: 20 })),
			}),
			execute: (_id, params, signal) =>
				guard<Details>(
					async () => {
						const [tree, vc] = await Promise.all([
							client.viewHierarchy({ depth: params.depth ?? 20, onScreenOnly: true, signal }),
							client.vcHierarchy(signal).catch(() => null),
						]);
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
				"Get the current view tree as nested JSON. Use when the task hinges on exact geometry, structure, " +
				"hidden nodes, or a specific subtree by address. Each node has address, class, frame=[x,y,w,h] " +
				"(points; omitted for zero-sized views), text (truncated to 80 chars), accessibility id. For " +
				"UIImageView nodes the server surfaces image_symbol_name / image_asset_name so icon-only buttons " +
				"can be identified.",
			parameters: Type.Object({
				depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, default: 6 })),
				include_hidden: Type.Optional(Type.Boolean({ default: false })),
				on_screen_only: Type.Optional(Type.Boolean({ default: true })),
				address: Type.Optional(Type.String({ description: "Root the tree at this hex address instead of the key window." })),
			}),
			execute: (_id, params, signal) =>
				guard<Details>(
					async () => {
						const depth = params.depth ?? 6;
						const opts = {
							depth,
							includeHidden: params.include_hidden ?? false,
							onScreenOnly: params.on_screen_only ?? true,
							signal,
						};
						const node = params.address
							? await client.viewSubtree(params.address, opts)
							: await client.viewHierarchy(opts);
						if (hooks.onInspect) {
							const vc = await client.vcHierarchy(signal).catch(() => null);
							await feedInspect(hooks, node, vc);
						}
						return { node, depth };
					},
					(data) => {
						const { node, depth } = data as { node: Parameters<typeof nodeToDict>[0]; depth: number };
						const tree = nodeToDict(node, depth);
						return okResult({ ...tree, _meta: { total_nodes: node.totalNodeCount() } });
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
				"candidates. Use before tapping by text to inspect what would actually be hit.",
			parameters: Type.Object({
				text: Type.Optional(Type.String()),
				class: Type.Optional(Type.String({ description: "Substring match on UIKit class name." })),
				accessibility_id: Type.Optional(Type.String()),
				property_name: Type.Optional(Type.String({ description: "Substring match on reflected Swift property name." })),
				max_results: Type.Optional(Type.Integer({ default: 8, maximum: 30 })),
			}),
			execute: (_id, params, signal) =>
				guard<Details>(
					() =>
						client.viewSearch(
							{
								text: params.text,
								cls: params.class,
								accessibilityId: params.accessibility_id,
								propertyName: params.property_name,
							},
							signal,
						),
					(nodes) => {
						const list = nodes as Parameters<typeof nodeSummary>[0][];
						const max = params.max_results ?? 8;
						return okResult({ count: list.length, results: list.slice(0, max).map(nodeSummary) });
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
				quality: Type.Optional(Type.Number({ minimum: 0.1, maximum: 1.0, default: 0.7 })),
			}),
			async execute(_id, params, signal) {
				try {
					const raw = await client.screenshot({ quality: params.quality ?? 0.7, signal });
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
			description: "Read active A/B experiment assignments.",
			parameters: Type.Object({
				keys: Type.Optional(Type.Array(Type.String())),
				limit: Type.Optional(Type.Integer({ default: 30, maximum: 200 })),
			}),
			execute: (_id, params, signal) =>
				guard<Details>(() => client.abExperiments({ keys: params.keys, limit: params.limit ?? 30, signal })),
		}),
	);

	tools.push(
		defineTool({
			name: "feature_flags",
			label: "Feature flags",
			description: "Read feature-flag / settings values.",
			parameters: Type.Object({
				keys: Type.Optional(Type.Array(Type.String())),
				limit: Type.Optional(Type.Integer({ default: 30, maximum: 200 })),
			}),
			execute: (_id, params, signal) =>
				guard<Details>(() => client.featureFlags({ keys: params.keys, limit: params.limit ?? 30, signal })),
		}),
	);

	// ---- interaction (mutating) ---------------------------------------

	tools.push(
		defineTool({
			name: "tap",
			label: "Tap",
			description:
				"Tap a view by hex `address` or by both `x`/`y` coordinates. Prefer address (from screen_digest / " +
				"find_view / view_hierarchy) over coordinates. For a tap that also reports what changed, prefer " +
				"`tap_with_diff`. **Mutating**: fires the tap.",
			parameters: Type.Object({
				address: Type.Optional(Type.String()),
				x: Type.Optional(Type.Number()),
				y: Type.Optional(Type.Number()),
				full: Type.Optional(Type.Boolean({ default: false, description: "Return the full server tap payload." })),
			}),
			execute: (_id, params, signal) =>
				guard<Details>(
					() => client.tap({ address: params.address, x: params.x, y: params.y, full: params.full, signal }),
					(r) => {
						const tr = r as { method: string; targetAddress: string | null; handledBy: string | null };
						return okResult({ method: tr.method, target_address: tr.targetAddress, handled_by: tr.handledBy });
					},
				),
		}),
	);

	tools.push(tapWithDiffTool(client));
	tools.push(waitForTool(client, hooks));

	tools.push(
		defineTool({
			name: "long_press",
			label: "Long press",
			description: "Long-press a view by `address` or `x`/`y`. **Mutating**.",
			parameters: Type.Object({
				address: Type.Optional(Type.String()),
				x: Type.Optional(Type.Number()),
				y: Type.Optional(Type.Number()),
				duration: Type.Optional(Type.Number({ default: 0.6 })),
			}),
			execute: (_id, params, signal) =>
				guard<Details>(() =>
					client.longPress({ address: params.address, x: params.x, y: params.y, duration: params.duration, signal }),
				),
		}),
	);

	tools.push(
		defineTool({
			name: "scroll",
			label: "Scroll",
			description:
				"Scroll a scroll view by content offset delta (dx, dy). Positive dy scrolls down. Optionally target a " +
				"specific scroll view by `address`. **Mutating**.",
			parameters: Type.Object({
				dx: Type.Optional(Type.Number({ default: 0 })),
				dy: Type.Optional(Type.Number({ default: 400 })),
				address: Type.Optional(Type.String()),
				animated: Type.Optional(Type.Boolean({ default: true })),
			}),
			execute: (_id, params, signal) =>
				guard<Details>(() =>
					client.scroll({ dx: params.dx, dy: params.dy, address: params.address, animated: params.animated, signal }),
				),
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
				guard<Details>(() =>
					client.swipe({
						address: params.address,
						startX: params.start_x,
						startY: params.start_y,
						endX: params.end_x,
						endY: params.end_y,
						dx: params.dx,
						dy: params.dy,
						duration: params.duration,
						signal,
					}),
				),
		}),
	);

	tools.push(
		defineTool({
			name: "input_text",
			label: "Input text",
			description:
				"Type text into a field. Optionally target by `address` or `x`/`y`, clear existing text first, append, " +
				"or submit after typing. **Mutating**.",
			parameters: Type.Object({
				text: Type.String(),
				submit: Type.Optional(Type.Boolean({ default: false })),
				clear: Type.Optional(Type.Boolean({ default: false })),
				append: Type.Optional(Type.Boolean({ default: false })),
				address: Type.Optional(Type.String()),
				x: Type.Optional(Type.Number()),
				y: Type.Optional(Type.Number()),
			}),
			execute: (_id, params, signal) =>
				guard<Details>(() =>
					client.inputText({
						text: params.text,
						submit: params.submit,
						clear: params.clear,
						append: params.append,
						address: params.address,
						x: params.x,
						y: params.y,
						signal,
					}),
				),
		}),
	);

	tools.push(
		defineTool({
			name: "dismiss",
			label: "Dismiss",
			description: "Dismiss the top-most presented view controller (modal/sheet). **Mutating**.",
			parameters: Type.Object({ animated: Type.Optional(Type.Boolean({ default: true })) }),
			execute: (_id, params, signal) => guard<Details>(() => client.dismiss(params.animated ?? true, signal)),
		}),
	);

	tools.push(
		defineTool({
			name: "back",
			label: "Back",
			description: "Pop the top view controller off the navigation stack (system back). **Mutating**.",
			parameters: Type.Object({ animated: Type.Optional(Type.Boolean({ default: true })) }),
			execute: (_id, params, signal) => guard<Details>(() => client.back(params.animated ?? true, signal)),
		}),
	);

	tools.push(
		defineTool({
			name: "switch_tab",
			label: "Switch tab",
			description: "Switch the tab bar to a tab by `index` or `title`. **Mutating**.",
			parameters: Type.Object({
				index: Type.Optional(Type.Integer({ minimum: 0 })),
				title: Type.Optional(Type.String()),
			}),
			execute: (_id, params, signal) =>
				guard<Details>(() => client.switchTab({ index: params.index, title: params.title, signal })),
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
			execute: (_id, params, signal) => guard<Details>(() => client.openUrl(params.url, params.animated ?? true, signal)),
		}),
	);

	tools.push(
		defineTool({
			name: "set_lane",
			label: "Set lane",
			description:
				"Set the lane of a target env (`env` is 'boe' or 'ppe'). Empty `lane` clears it (env default). **Mutating**.",
			parameters: Type.Object({
				env: Type.String({ description: "'boe' or 'ppe'" }),
				lane: Type.Optional(Type.String()),
			}),
			execute: (_id, params, signal) => guard<Details>(() => client.setLane(params.env, params.lane ?? null, signal)),
		}),
	);

	return tools;
}
