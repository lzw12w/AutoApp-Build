import { describe, expect, test } from "bun:test";
import { InspectorClient } from "../src/client.ts";
import { buildTools, MUTATING_TOOL_NAMES, type InspectHooks } from "../src/tools/index.ts";
import { Transport } from "../src/transport.ts";

/** Transport whose get/post return scripted values — no real network. */
class FakeTransport extends Transport {
	getResponse: unknown = {};
	postResponse: unknown = {};
	throwOn: string | null = null;
	constructor() {
		super({ host: "localhost" });
	}
	override async get(path: string): Promise<unknown> {
		if (this.throwOn && path.includes(this.throwOn)) throw new Error("boom");
		return this.getResponse;
	}
	override async post(path: string): Promise<unknown> {
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
		for (const n of ["ping", "vc_hierarchy", "screen_digest", "view_hierarchy", "find_view", "screenshot", "tap", "tap_with_diff", "wait_for", "scroll", "input_text", "open_url"]) {
			expect(names).toContain(n);
		}
	});

	test("MUTATING_TOOL_NAMES matches the mutating tools", () => {
		expect(MUTATING_TOOL_NAMES.has("tap")).toBe(true);
		expect(MUTATING_TOOL_NAMES.has("tap_with_diff")).toBe(true);
		expect(MUTATING_TOOL_NAMES.has("scroll")).toBe(true);
		expect(MUTATING_TOOL_NAMES.has("screen_digest")).toBe(false);
		expect(MUTATING_TOOL_NAMES.has("view_hierarchy")).toBe(false);
		expect(MUTATING_TOOL_NAMES.has("wait_for")).toBe(false);
		expect(MUTATING_TOOL_NAMES.has("todo_write")).toBe(false);
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
	test("returns normalized method/target on success", async () => {
		const t = new FakeTransport();
		t.postResponse = { method: "public_api", address: "0x9", handledBy: "UIButton" };
		const get = toolByName(new InspectorClient(t));
		const result = await get("tap").execute("c3", { address: "0x9" }, undefined, undefined, ctx);
		const payload = parseText(result) as { ok: boolean; data: Record<string, unknown> };
		expect(payload.ok).toBe(true);
		expect(payload.data.method).toBe("public_api");
		expect(payload.data.target_address).toBe("0x9");
		expect(payload.data.handled_by).toBe("UIButton");
	});

	test("missing address and coords surfaces ok:false", async () => {
		const get = toolByName(new InspectorClient(new FakeTransport()));
		const result = await get("tap").execute("c4", {}, undefined, undefined, ctx);
		expect(parseText(result).ok).toBe(false);
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
	test("renders a plain-text digest with VC label", async () => {
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
});
