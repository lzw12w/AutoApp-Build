import { describe, expect, test } from "bun:test";
import { InspectorClient, normalizeHierarchyResponse, pickMainWindow } from "../src/client.ts";
import { InvalidArgument, InvalidResponse } from "../src/errors.ts";
import { Transport } from "../src/transport.ts";

/**
 * Records the last GET/POST and returns a scripted response, so client method
 * wiring (endpoint path, params/body shaping) can be asserted without a device.
 */
class RecordingTransport extends Transport {
	lastGet?: { path: string; params?: Record<string, unknown> };
	lastPost?: { path: string; body?: Record<string, unknown>; idempotent?: boolean };
	getResponse: unknown = {};
	postResponse: unknown = {};

	constructor() {
		super({ host: "localhost" });
	}
	override async get(path: string, options: { params?: Record<string, unknown> } = {}): Promise<unknown> {
		this.lastGet = { path, params: options.params };
		return this.getResponse;
	}
	override async post(
		path: string,
		options: { body?: Record<string, unknown>; idempotent?: boolean } = {},
	): Promise<unknown> {
		this.lastPost = { path, body: options.body, idempotent: options.idempotent };
		return this.postResponse;
	}
}

describe("pickMainWindow", () => {
	test("presented sheet owner wins", () => {
		const win = pickMainWindow([
			{ class: "UIWindow", frame: { width: 400, height: 800 } },
			{ class: "UIWindow", containsPresentedSheet: true },
		]);
		expect(win.containsPresentedSheet).toBe(true);
	});

	test("isKeyWindow beats footprint", () => {
		const win = pickMainWindow([
			{ class: "UIWindow", frame: { width: 400, height: 800 } },
			{ class: "UIWindow", isKeyWindow: true, frame: { width: 10, height: 10 } },
		]);
		expect(win.isKeyWindow).toBe(true);
	});

	test("overlay windows excluded", () => {
		const win = pickMainWindow([
			{ class: "UIRemoteKeyboardWindow", frame: { width: 400, height: 300 } },
			{ class: "UIWindow", frame: { width: 400, height: 800 } },
		]);
		expect(win.class).toBe("UIWindow");
	});

	test("largest footprint fallback", () => {
		const win = pickMainWindow([
			{ class: "UIWindow", frame: { width: 100, height: 100 } },
			{ class: "UIWindow", frame: { width: 400, height: 800 } },
		]);
		expect(win.frame).toMatchObject({ width: 400, height: 800 });
	});

	test("empty list throws", () => {
		expect(() => pickMainWindow([])).toThrow(InvalidResponse);
	});
});

describe("normalizeHierarchyResponse", () => {
	test("windows shape", () => {
		const node = normalizeHierarchyResponse({ windows: [{ class: "UIWindow", frame: { width: 1, height: 1 } }] }, "view_hierarchy");
		expect(node.class).toBe("UIWindow");
	});
	test("root shape", () => {
		const node = normalizeHierarchyResponse({ root: { class: "R" } }, "view_hierarchy");
		expect(node.class).toBe("R");
	});
	test("bare node shape", () => {
		const node = normalizeHierarchyResponse({ class: "Bare", address: "0x1" }, "view_hierarchy");
		expect(node.class).toBe("Bare");
	});
	test("empty windows throws", () => {
		expect(() => normalizeHierarchyResponse({ windows: [] }, "view_hierarchy")).toThrow(InvalidResponse);
	});
	test("unrecognized shape throws", () => {
		expect(() => normalizeHierarchyResponse({ foo: 1 }, "view_hierarchy")).toThrow(InvalidResponse);
	});
});

describe("InspectorClient method wiring", () => {
	test("viewHierarchy sends params and parses into ViewNode", async () => {
		const t = new RecordingTransport();
		t.getResponse = { windows: [{ class: "UIWindow", address: "0x1", frame: { width: 400, height: 800 } }] };
		const client = new InspectorClient(t);
		const node = await client.viewHierarchy({ depth: 4, includeHidden: true, onScreenOnly: false });
		expect(t.lastGet?.path).toBe("/api/view_hierarchy");
		expect(t.lastGet?.params).toMatchObject({ depth: 4, include_hidden: true, on_screen_only: false });
		expect(node.cls).toBe("UIWindow");
	});

	test("tap posts non-idempotent with compact flag and returns TapResult", async () => {
		const t = new RecordingTransport();
		t.postResponse = { method: "public_api", address: "0x9" };
		const client = new InspectorClient(t);
		const result = await client.tap({ address: "0x9" });
		expect(t.lastPost?.path).toBe("/api/tap");
		expect(t.lastPost?.idempotent).toBe(false);
		expect(t.lastPost?.body).toMatchObject({ address: "0x9", compact: true });
		expect(result.method).toBe("public_api");
		expect(result.targetAddress).toBe("0x9");
	});

	test("tap without address or coords throws", async () => {
		const client = new InspectorClient(new RecordingTransport());
		await expect(client.tap({})).rejects.toBeInstanceOf(InvalidArgument);
	});

	test("switchTab requires index or title", async () => {
		const client = new InspectorClient(new RecordingTransport());
		await expect(client.switchTab({})).rejects.toBeInstanceOf(InvalidArgument);
	});

	test("openUrl requires url", async () => {
		const client = new InspectorClient(new RecordingTransport());
		await expect(client.openUrl("")).rejects.toBeInstanceOf(InvalidArgument);
	});

	test("viewSubtree surfaces VC->view resolution markers", async () => {
		const t = new RecordingTransport();
		t.getResponse = {
			root: { class: "UIView", address: "0xview" },
			resolvedFromViewController: true,
			resolvedViewAddress: "0xview",
			viewControllerClass: "MyVC",
		};
		const client = new InspectorClient(t);
		const node = await client.viewSubtree("0xvc");
		expect(node.extra.resolved_from_view_controller).toBe(true);
		expect(node.extra.resolved_view_address).toBe("0xview");
		expect(node.extra.view_controller_class).toBe("MyVC");
	});

	test("vcHierarchy picks first window with rootViewController", async () => {
		const t = new RecordingTransport();
		t.getResponse = {
			windows: [{ class: "UIWindow" }, { rootViewController: { class: "RootVC", address: "0x1" } }],
		};
		const client = new InspectorClient(t);
		const vc = await client.vcHierarchy();
		expect(vc.cls).toBe("RootVC");
	});
});
