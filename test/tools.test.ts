import { afterEach, describe, expect, test } from "bun:test";
import { InspectorClient } from "../src/client.ts";
import { buildTools, MUTATING_TOOL_NAMES, type InspectHooks } from "../src/tools/index.ts";
import { setSnapshotTestHooks } from "../src/tools/snapshot.ts";
import { Transport } from "../src/transport.ts";

/** Transport whose get/post return scripted values — no real network. */
class FakeTransport extends Transport {
	getResponse: unknown = {};
	postResponse: unknown = {};
	throwOn: string | null = null;
	constructor() {
		super({ host: "localhost" });
	}
	override async get(path: string, _options?: unknown): Promise<unknown> {
		if (this.throwOn && path.includes(this.throwOn)) throw new Error("boom");
		return this.getResponse;
	}
	override async post(path: string, _options?: unknown): Promise<unknown> {
		if (this.throwOn && path.includes(this.throwOn)) throw new Error("boom");
		return this.postResponse;
	}
}

function toolByName(client: InspectorClient, hooks?: InspectHooks) {
	const map = new Map(buildTools(client, hooks).map((t) => [t.name, t]));
	return (name: string) => {
		const t = map.get(name);
		if (!t) throw new Error(`no tool ${name}`);
		return t;
	};
}

function parseText(result: { content: { type: string }[] }): Record<string, unknown> {
	const first = result.content[0]! as { type: string; text?: string };
	if (first.type !== "text" || first.text === undefined) return {};
	return JSON.parse(first.text);
}

const ctx = {} as never;

describe("tool set", () => {
	test("registers the expected core tools", () => {
		const names = buildTools(new InspectorClient(new FakeTransport())).map((t) => t.name);
		for (const n of ["ping", "vc_hierarchy", "screen_digest", "view_hierarchy", "find_view", "screenshot", "tap_with_diff", "wait_for", "scroll", "input_text", "open_url", "appoint_feed_story", "set_lane"]) {
			expect(names).toContain(n);
		}
		expect(names).not.toContain("tap");
	});

	test("MUTATING_TOOL_NAMES matches the mutating tools", () => {
		expect(MUTATING_TOOL_NAMES.has("tap")).toBe(false);
		expect(MUTATING_TOOL_NAMES.has("tap_with_diff")).toBe(true);
		expect(MUTATING_TOOL_NAMES.has("scroll")).toBe(true);
		expect(MUTATING_TOOL_NAMES.has("screen_digest")).toBe(false);
		expect(MUTATING_TOOL_NAMES.has("view_hierarchy")).toBe(false);
		expect(MUTATING_TOOL_NAMES.has("wait_for")).toBe(false);
		expect(MUTATING_TOOL_NAMES.has("todo_write")).toBe(false);
		expect(MUTATING_TOOL_NAMES.has("set_lane")).toBe(false);
		expect(MUTATING_TOOL_NAMES.has("appoint_feed_story")).toBe(true);
	});
});

describe("ping tool", () => {
	test("ok:true with device data on success", async () => {
		const t = new FakeTransport();
		t.getResponse = { pong: true, version: "1.2" };
		const get = toolByName(new InspectorClient(t));
		const result = await get("ping").execute("c1", {}, undefined, undefined, ctx);
		const payload = parseText(result);
		expect(payload.ok).toBe(true);
		expect(payload.data).toEqual({ pong: true, version: "1.2" });
	});

	test("ok:false structured error on failure", async () => {
		const t = new FakeTransport();
		t.throwOn = "/api/ping";
		const get = toolByName(new InspectorClient(t));
		const result = await get("ping").execute("c2", {}, undefined, undefined, ctx);
		const payload = parseText(result) as { ok: boolean; error: { message: string } };
		expect(payload.ok).toBe(false);
		expect(payload.error.message).toContain("boom");
	});
});

describe("tap tool", () => {
	test("is not registered; tap_with_diff is the only tap", () => {
		const names = buildTools(new InspectorClient(new FakeTransport())).map((t) => t.name);
		expect(names).not.toContain("tap");
		expect(names).toContain("tap_with_diff");
	});
});

describe("input_text tool", () => {
	test("Inspector success:false becomes ok:false", async () => {
		const t = new FakeTransport();
		t.postResponse = { success: false, error: "No current first responder found.", timestamp: "t" };
		const get = toolByName(new InspectorClient(t));
		const result = await get("input_text").execute("it1", { text: "hi" }, undefined, undefined, ctx);
		const payload = parseText(result) as { ok: boolean; error: { code: string; message: string } };
		expect(payload.ok).toBe(false);
		expect(payload.error.code).toBe("E_ACTION_FAILED");
		expect(payload.error.message).toContain("first responder");
	});

	test("resolves accessibility_id to address before posting", async () => {
		class CaptureTransport extends FakeTransport {
			body: unknown = null;
			override async post(path: string, options?: { body?: unknown }): Promise<unknown> {
				this.body = options?.body;
				return super.post(path, options as never);
			}
		}
		const t = new CaptureTransport();
		t.getResponse = {
			windows: [
				{
					class: "UIWindow",
					address: "0x1",
					frame: { x: 0, y: 0, width: 400, height: 800 },
					children: [
						{
							class: "SANewMessageTextInputView",
							address: "0xfield",
							frame: { x: 20, y: 700, width: 300, height: 40 },
							accessibilityIdentifier: "messageInput.field",
							onScreen: true,
						},
					],
				},
			],
		};
		t.postResponse = { success: true };
		const get = toolByName(new InspectorClient(t));
		const result = await get("input_text").execute(
			"it2",
			{ text: "hello", accessibility_id: "messageInput.field" },
			undefined,
			undefined,
			ctx,
		);
		expect(parseText(result).ok).toBe(true);
		expect((t.body as { address?: string }).address).toBe("0xfield");
	});
});

describe("switch_tab tool", () => {
	test("resolves accessibility_id to tab index", async () => {
		class CaptureTransport extends FakeTransport {
			body: unknown = null;
			override async post(path: string, options?: { body?: unknown }): Promise<unknown> {
				this.body = options?.body;
				return super.post(path, options as never);
			}
		}
		const t = new CaptureTransport();
		t.getResponse = {
			windows: [
				{
					class: "UIWindow",
					address: "0x1",
					frame: { x: 0, y: 0, width: 400, height: 800 },
					children: [
						{
							class: "ESTabBar",
							address: "0xbar",
							frame: { x: 0, y: 760, width: 400, height: 40 },
							children: [
								{
									class: "ESTabBarItemContainer",
									address: "0xf",
									frame: { x: 0, y: 0, width: 80, height: 40 },
									accessibilityIdentifier: "mainTab.item.feed",
									onScreen: true,
								},
								{
									class: "ESTabBarItemContainer",
									address: "0xm",
									frame: { x: 320, y: 0, width: 80, height: 40 },
									accessibilityIdentifier: "mainTab.item.mine",
									onScreen: true,
								},
							],
						},
					],
				},
			],
		};
		t.postResponse = { success: true };
		const get = toolByName(new InspectorClient(t));
		const result = await get("switch_tab").execute(
			"st1",
			{ accessibility_id: "mainTab.item.mine" },
			undefined,
			undefined,
			ctx,
		);
		expect(parseText(result).ok).toBe(true);
		expect((t.body as { index?: number }).index).toBe(1);
	});
});

describe("long_press tool", () => {
	test("resolves accessibility_id to address before posting", async () => {
		class CaptureTransport extends FakeTransport {
			body: unknown = null;
			override async post(path: string, options?: { body?: unknown }): Promise<unknown> {
				this.body = options?.body;
				return super.post(path, options as never);
			}
		}
		const t = new CaptureTransport();
		t.getResponse = {
			windows: [
				{
					class: "UIWindow",
					address: "0x1",
					frame: { x: 0, y: 0, width: 400, height: 800 },
					children: [
						{
							class: "UIImageView",
							address: "0xvoice",
							frame: { x: 20, y: 700, width: 40, height: 40 },
							accessibilityIdentifier: "messageInput.voiceModeButton",
							onScreen: true,
						},
					],
				},
			],
		};
		t.postResponse = { success: true };
		const get = toolByName(new InspectorClient(t));
		const result = await get("long_press").execute(
			"lp1",
			{ accessibility_id: "messageInput.voiceModeButton" },
			undefined,
			undefined,
			ctx,
		);
		expect(parseText(result).ok).toBe(true);
		expect((t.body as { address?: string }).address).toBe("0xvoice");
	});
});

describe("dismiss tool", () => {
	test("endEditing fallback is ok:false, not a successful dismiss", async () => {
		const t = new FakeTransport();
		t.postResponse = {
			success: true,
			mode: "endEditing",
			timestamp: "t",
			viewController: { address: "0xfeed", class: "MainFeedContainerViewController" },
		};
		const get = toolByName(new InspectorClient(t));
		const result = await get("dismiss").execute("d1", {}, undefined, undefined, ctx);
		const payload = parseText(result) as { ok: boolean; error: { code: string; message: string } };
		expect(payload.ok).toBe(false);
		expect(payload.error.code).toBe("E_NO_PRESENTED");
		expect(payload.error.message).toContain("endEditing");
	});
});

describe("screenshot tool", () => {
	test("returns an image content block", async () => {
		const t = new FakeTransport();
		t.getResponse = { base64: "AAAA", width: 100, height: 200 };
		const get = toolByName(new InspectorClient(t));
		const result = await get("screenshot").execute("c5", {}, undefined, undefined, ctx);
		const image = result.content.find((c) => c.type === "image") as { type: string; data: string; mimeType: string } | undefined;
		expect(image).toBeDefined();
		expect(image!.data).toBe("AAAA");
		expect(image!.mimeType).toBe("image/jpeg");
	});
});

describe("screen_digest tool", () => {
	afterEach(() => {
		setSnapshotTestHooks(null);
	});

	test("renders a plain-text digest with VC label", async () => {
		setSnapshotTestHooks({ retryDelayMs: 0 });
		const t = new FakeTransport();
		// One window with a labelled button.
		t.getResponse = {
			windows: [
				{
					class: "UIWindow",
					address: "0x1",
					frame: { x: 0, y: 0, width: 400, height: 800 },
					children: [
						{ class: "UIButton", address: "0xb", frame: { x: 10, y: 20, width: 100, height: 40 }, text: "Buy" },
					],
				},
			],
		};
		const client = new InspectorClient(t);
		// vc_hierarchy shares the same fake response; that's fine — digest still renders.
		const get = toolByName(client);
		const result = await get("screen_digest").execute("c6", {}, undefined, undefined, ctx);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("VC:");
		expect(text).toContain('"Buy"');
		expect(text).toContain("0xb");
	});

	test("feeds onInspect with the fetched view tree", async () => {
		setSnapshotTestHooks({ retryDelayMs: 0 });
		const t = new FakeTransport();
		t.getResponse = {
			windows: [
				{
					class: "UIWindow",
					address: "0x1",
					frame: { x: 0, y: 0, width: 400, height: 800 },
					children: [
						{ class: "UIButton", address: "0xb", frame: { x: 10, y: 20, width: 100, height: 40 }, text: "Buy" },
					],
				},
			],
		};
		const seen: string[] = [];
		const get = toolByName(new InspectorClient(t), {
			onInspect: (view) => {
				seen.push(view.cls);
			},
		});
		await get("screen_digest").execute("c7", {}, undefined, undefined, ctx);
		expect(seen).toEqual(["UIWindow"]);
	});

	test("fetches a fully-expanded tree (depth 50) and ignores a passed depth", async () => {
		setSnapshotTestHooks({ retryDelayMs: 0 });
		const depths: unknown[] = [];
		class RecordingTransport extends FakeTransport {
			override async get(path: string, options?: { params?: Record<string, unknown> }): Promise<unknown> {
				if (path.includes("view_hierarchy")) depths.push(options?.params?.depth);
				return super.get(path);
			}
		}
		const t = new RecordingTransport();
		t.getResponse = {
			windows: [
				{
					class: "UIWindow",
					address: "0x1",
					frame: { x: 0, y: 0, width: 400, height: 800 },
					children: [
						{ class: "UIButton", address: "0xb", frame: { x: 10, y: 20, width: 100, height: 40 }, text: "Buy" },
					],
				},
			],
		};
		const get = toolByName(new InspectorClient(t));
		await get("screen_digest").execute("c8", { depth: 8 }, undefined, undefined, ctx);
		expect(depths.length).toBeGreaterThan(0);
		expect(depths.every((d) => d === 50)).toBe(true);
	});
});

describe("appoint_feed_story / set_lane", () => {
	test("appoint_feed_story rejects non-numeric ids", async () => {
		const get = toolByName(new InspectorClient(new FakeTransport()));
		const result = await get("appoint_feed_story").execute("a1", { story_ids: "abc" }, undefined, undefined, ctx);
		const payload = parseText(result) as { ok: boolean; error: { code: string } };
		expect(payload.ok).toBe(false);
		expect(payload.error.code).toBe("E_INVALID_ARGS");
	});

	test("appoint_feed_story posts numeric ids", async () => {
		const t = new FakeTransport();
		t.postResponse = { ok: true };
		const get = toolByName(new InspectorClient(t));
		const result = await get("appoint_feed_story").execute("a2", { story_ids: "123，456" }, undefined, undefined, ctx);
		expect(parseText(result).ok).toBe(true);
	});
});

describe("view_hierarchy tool", () => {
	afterEach(() => setSnapshotTestHooks(null));

	test("includes presented_views and stability meta", async () => {
		setSnapshotTestHooks({ retryDelayMs: 0 });
		const t = new FakeTransport();
		t.getResponse = {
			windows: [
				{
					class: "UIWindow",
					address: "0x1",
					isKeyWindow: true,
					containsPresentedSheet: true,
					frame: { x: 0, y: 0, width: 400, height: 800 },
					children: [
						{ class: "UILabel", address: "0xa", frame: { x: 0, y: 0, width: 100, height: 20 }, text: "Under" },
					],
					presentedViews: [
						{ class: "SheetView", address: "0xs", frame: { x: 0, y: 100, width: 400, height: 400 }, text: "Sheet" },
					],
				},
			],
		};
		const get = toolByName(new InspectorClient(t));
		const result = await get("view_hierarchy").execute("vh1", { depth: 6 }, undefined, undefined, ctx);
		const payload = parseText(result) as { ok: boolean; data: { presented_views?: unknown[]; _meta: Record<string, unknown> } };
		expect(payload.ok).toBe(true);
		expect(payload.data.presented_views).toBeDefined();
		expect(payload.data._meta.stability_used).toBe(true);
		expect(payload.data._meta.contains_presented_sheet).toBe(true);
	});
});

