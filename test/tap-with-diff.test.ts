import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InspectorClient } from "../src/client.ts";
import { buildTools } from "../src/tools/index.ts";
import { Transport } from "../src/transport.ts";

class ScriptedTransport extends Transport {
	views: unknown[] = [];
	vcs: unknown[] = [];
	search: unknown[] = [];
	viewI = 0;
	vcI = 0;
	taps = 0;
	tapResponse: unknown = { method: "public_api", address: "0xb", handledBy: "UIButton" };

	constructor() {
		super({ host: "localhost" });
	}

	override async get(path: string): Promise<unknown> {
		if (path.includes("view_hierarchy")) {
			const i = Math.min(this.viewI, Math.max(0, this.views.length - 1));
			this.viewI++;
			return this.views[i] ?? { windows: [] };
		}
		if (path.includes("vc_hierarchy")) {
			const i = Math.min(this.vcI, Math.max(0, this.vcs.length - 1));
			this.vcI++;
			return this.vcs[i] ?? { windows: [] };
		}
		if (path.includes("view_search")) return { results: this.search };
		return {};
	}

	override async post(path: string): Promise<unknown> {
		if (path.includes("/tap")) {
			this.taps += 1;
			return this.tapResponse;
		}
		return {};
	}
}

function windowTree(children: Record<string, unknown>[]): Record<string, unknown> {
	return {
		windows: [
			{
				class: "UIWindow",
				address: "0x1",
				frame: { x: 0, y: 0, width: 400, height: 800 },
				children,
			},
		],
	};
}

function vcTree(cls: string): Record<string, unknown> {
	return { windows: [{ rootViewController: { class: cls, address: "0xvc" } }] };
}

function tool(t: ScriptedTransport, name: string) {
	const found = buildTools(new InspectorClient(t)).find((x) => x.name === name);
	if (!found) throw new Error(`no tool ${name}`);
	return found;
}

function parse(result: { content: { type: string; text?: string }[] }): Record<string, unknown> {
	const first = result.content[0]!;
	if (first.type !== "text" || first.text === undefined) return {};
	return JSON.parse(first.text) as Record<string, unknown>;
}

const ctx = {} as never;
const prevSettle = process.env.INSPECTOR_SETTLE_VC_DIFF_MS;
const prevPoll = process.env.INSPECTOR_POLL_INTERVAL_MS;

describe("tap_with_diff", () => {
	beforeEach(() => {
		process.env.INSPECTOR_SETTLE_VC_DIFF_MS = "0";
		process.env.INSPECTOR_POLL_INTERVAL_MS = "1";
	});
	afterEach(() => {
		if (prevSettle === undefined) delete process.env.INSPECTOR_SETTLE_VC_DIFF_MS;
		else process.env.INSPECTOR_SETTLE_VC_DIFF_MS = prevSettle;
		if (prevPoll === undefined) delete process.env.INSPECTOR_POLL_INTERVAL_MS;
		else process.env.INSPECTOR_POLL_INTERVAL_MS = prevPoll;
	});

	test("requires address, coords, or a finder", async () => {
		const t = new ScriptedTransport();
		const result = await tool(t, "tap_with_diff").execute("c1", {}, undefined, undefined, ctx);
		const payload = parse(result);
		expect(payload.ok).toBe(false);
		expect((payload.error as { code: string }).code).toBe("E_INVALID_ARGUMENT");
		expect(t.taps).toBe(0);
	});

	test("VC change returns vc_diff and no view_diff", async () => {
		const t = new ScriptedTransport();
		t.views = [
			windowTree([
				{ class: "UIButton", address: "0xb", frame: { x: 10, y: 20, width: 100, height: 40 }, text: "Open" },
			]),
		];
		t.vcs = [vcTree("HomeVC"), vcTree("DetailVC")];
		const result = await tool(t, "tap_with_diff").execute(
			"c2",
			{ address: "0xb" },
			undefined,
			undefined,
			ctx,
		);
		const payload = parse(result) as { ok: boolean; data: Record<string, unknown> };
		expect(payload.ok).toBe(true);
		expect(t.taps).toBe(1);
		expect(payload.data.vc_changed).toBe(true);
		expect((payload.data.post_check as { kind: string }).kind).toBe("vc_diff");
		expect(payload.data.view_diff).toBeUndefined();
		expect((payload.data.vc_diff as { from_vc: string; to_vc: string }).from_vc).toBe("HomeVC");
		expect((payload.data.vc_diff as { to_vc: string }).to_vc).toBe("DetailVC");
	});

	test("same VC returns view_hierarchy_diff with added node", async () => {
		const t = new ScriptedTransport();
		const beforeKids = [
			{ class: "UIButton", address: "0xb", frame: { x: 10, y: 20, width: 100, height: 40 }, text: "Toggle" },
		];
		const afterKids = [
			...beforeKids,
			{ class: "UILabel", address: "0xl", frame: { x: 10, y: 80, width: 100, height: 20 }, text: "On" },
		];
		t.views = [windowTree(beforeKids), windowTree(afterKids)];
		t.vcs = [vcTree("HomeVC")];
		const result = await tool(t, "tap_with_diff").execute(
			"c3",
			{ address: "0xb", stability: false },
			undefined,
			undefined,
			ctx,
		);
		const payload = parse(result) as { ok: boolean; data: Record<string, unknown> };
		expect(payload.ok).toBe(true);
		expect((payload.data.post_check as { kind: string }).kind).toBe("view_hierarchy_diff");
		const viewDiff = payload.data.view_diff as { changed: boolean; diff: { added_count: number; added: Array<{ text?: string }> } };
		expect(viewDiff.changed).toBe(true);
		expect(viewDiff.diff.added_count).toBe(1);
		expect(viewDiff.diff.added[0]!.text).toBe("On");
	});

	test("finder by text taps the matching view", async () => {
		const t = new ScriptedTransport();
		t.views = [
			windowTree([
				{ class: "UIButton", address: "0xb", frame: { x: 10, y: 20, width: 100, height: 40 }, text: "Buy" },
			]),
		];
		t.vcs = [vcTree("HomeVC")];
		const result = await tool(t, "tap_with_diff").execute("c4", { text: "Buy", stability: false }, undefined, undefined, ctx);
		const payload = parse(result) as { ok: boolean; data: Record<string, unknown> };
		expect(payload.ok).toBe(true);
		expect(payload.data.target_address).toBe("0xb");
		expect((payload.data.tapped as { text: string }).text).toBe("Buy");
		expect(t.taps).toBe(1);
	});

	test("view_search fallback excludes off-screen candidates from index addressing", async () => {
		const t = new ScriptedTransport();
		// Local tree has no match → forces the view_search fallback path.
		t.views = [windowTree([{ class: "UIView", address: "0x1", frame: { x: 0, y: 0, width: 400, height: 800 } }])];
		t.vcs = [vcTree("HomeVC")];
		// One visible match + one off-screen reuse-pool match. Python filters to
		// on_screen === true before ranking, so only ONE candidate exists and
		// index=1 is out of range (rather than tapping the off-screen node).
		t.search = [
			{ class: "UIButton", address: "0xon", frame: { x: 10, y: 20, width: 100, height: 40 }, text: "Buy", onScreen: true },
			{ class: "UIButton", address: "0xoff", frame: { x: 0, y: 900, width: 100, height: 40 }, text: "Buy", onScreen: false },
		];
		const result = await tool(t, "tap_with_diff").execute("cf", { text: "Buy", index: 1, stability: false }, undefined, undefined, ctx);
		const payload = parse(result) as { ok: boolean; error?: { code: string } };
		// Without the visibility filter this would tap the off-screen node at
		// index 1; with it, index 1 is out of range.
		expect(payload.ok).toBe(false);
		expect(payload.error?.code).toBe("E_INDEX_OUT_OF_RANGE");
		expect(t.taps).toBe(0);
	});

	test("class-only selector with many hits is E_AMBIGUOUS", async () => {
		const t = new ScriptedTransport();
		t.views = [
			windowTree([
				{ class: "UILabel", address: "0xa", frame: { x: 0, y: 0, width: 40, height: 20 }, text: "A" },
				{ class: "UILabel", address: "0xb", frame: { x: 0, y: 20, width: 40, height: 20 }, text: "B" },
			]),
		];
		t.vcs = [vcTree("HomeVC")];
		const result = await tool(t, "tap_with_diff").execute("c5", { class: "UILabel" }, undefined, undefined, ctx);
		const payload = parse(result) as { ok: boolean; error: { code: string } };
		expect(payload.ok).toBe(false);
		expect(payload.error.code).toBe("E_AMBIGUOUS");
		expect(t.taps).toBe(0);
	});

	test("reports a role-level tap target without the hex address", async () => {
		const t = new ScriptedTransport();
		t.views = [
			windowTree([
				{
					class: "UIButton",
					address: "0xb",
					frame: { x: 10, y: 20, width: 100, height: 40 },
					text: "Settings",
					propertyName: "settingsButton",
					accessibilityIdentifier: "btn_settings",
				},
			]),
		];
		t.vcs = [vcTree("HomeVC")];
		let seen: { kind: string; params: Record<string, unknown>; identity: Record<string, unknown> } | null = null;
		const found = buildTools(new InspectorClient(t), {
			onTapTarget: (kind, params, identity) => {
				seen = { kind, params, identity };
			},
		}).find((x) => x.name === "tap_with_diff");
		if (!found) throw new Error("no tool tap_with_diff");
		const result = await found.execute("c6", { address: "0xb", stability: false }, undefined, undefined, ctx);
		expect(parse(result).ok).toBe(true);
		expect(seen).not.toBeNull();
		expect(seen!.kind).toBe("tap");
		expect(seen!.identity).toEqual({
			class: "UIButton",
			property_name: "settingsButton",
			aid: "btn_settings",
			ancestor_chain: ["UIWindow"],
		});
		expect(JSON.stringify(seen!.params)).not.toContain("0xb");
		expect(seen!.params.action_label).toContain("settingsButton");
	});
});
