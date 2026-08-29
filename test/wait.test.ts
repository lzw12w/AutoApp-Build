import { describe, expect, test } from "bun:test";
import { InspectorClient } from "../src/client.ts";
import { buildTools } from "../src/tools/index.ts";
import { Transport } from "../src/transport.ts";

class ScriptedTransport extends Transport {
	views: unknown[] = [];
	vcs: unknown[] = [];
	viewI = 0;
	vcI = 0;

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
		if (path.includes("view_search")) return { results: [] };
		return {};
	}

	override async post(): Promise<unknown> {
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

function tool(t: ScriptedTransport) {
	const found = buildTools(new InspectorClient(t)).find((x) => x.name === "wait_for");
	if (!found) throw new Error("no wait_for");
	return found;
}

function parse(result: { content: { type: string; text?: string }[] }): Record<string, unknown> {
	const first = result.content[0]!;
	if (first.type !== "text" || first.text === undefined) return {};
	return JSON.parse(first.text) as Record<string, unknown>;
}

const ctx = {} as never;

describe("wait_for", () => {
	test("requires a condition", async () => {
		const result = await tool(new ScriptedTransport()).execute("w0", {}, undefined, undefined, ctx);
		const payload = parse(result) as { ok: boolean; error: { code: string } };
		expect(payload.ok).toBe(false);
		expect(payload.error.code).toBe("E_INVALID_ARGUMENT");
	});

	test("succeeds when text appears on a later poll", async () => {
		const t = new ScriptedTransport();
		t.views = [
			windowTree([{ class: "UIView", address: "0xa", frame: { x: 0, y: 0, width: 10, height: 10 } }]),
			windowTree([
				{ class: "UILabel", address: "0xb", frame: { x: 0, y: 0, width: 80, height: 20 }, text: "Loaded" },
			]),
		];
		const result = await tool(t).execute(
			"w1",
			{ text: "Loaded", timeout_ms: 400, poll_ms: 50 },
			undefined,
			undefined,
			ctx,
		);
		const payload = parse(result) as { ok: boolean; data: { attempts: number; reason: string } };
		expect(payload.ok).toBe(true);
		expect(payload.data.attempts).toBeGreaterThanOrEqual(2);
		expect(payload.data.reason).toContain("present");
	});

	test("succeeds on vc_class substring", async () => {
		const t = new ScriptedTransport();
		t.vcs = [vcTree("MainFeedContainerViewController")];
		const result = await tool(t).execute("w2", { vc_class: "Feed", timeout_ms: 0 }, undefined, undefined, ctx);
		const payload = parse(result) as { ok: boolean; data: { reason: string } };
		expect(payload.ok).toBe(true);
		expect(payload.data.reason).toContain("present");
	});

	test("times out with last evidence", async () => {
		const t = new ScriptedTransport();
		t.views = [windowTree([{ class: "UIView", address: "0xa", frame: { x: 0, y: 0, width: 10, height: 10 } }])];
		const result = await tool(t).execute("w3", { text: "Never", timeout_ms: 0 }, undefined, undefined, ctx);
		const payload = parse(result) as { ok: boolean; error: { code: string }; data: { last: { ok: boolean } } };
		expect(payload.ok).toBe(false);
		expect(payload.error.code).toBe("E_WAIT_TIMEOUT");
		expect(payload.data.last.ok).toBe(false);
	});
});
