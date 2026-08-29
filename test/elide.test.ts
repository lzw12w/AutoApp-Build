import { describe, expect, test } from "bun:test";
import { elideOldViewHierarchies, vhElisionSummary } from "../src/compact/elide.ts";

function assistantVh(id: string, name = "view_hierarchy") {
	return { role: "assistant" as const, content: [{ type: "toolCall" as const, id, name, arguments: {} }] };
}

function toolResult(id: string, name: string, payload: unknown) {
	return {
		role: "toolResult" as const,
		toolCallId: id,
		toolName: name,
		content: [{ type: "text" as const, text: JSON.stringify(payload) }],
		isError: false,
	};
}

function bigVh(addr: string, n = 60) {
	return {
		ok: true,
		data: {
			_meta: { total_nodes: n * 3, window_class: "UIWindow" },
			class: "UIWindow",
			address: addr,
			children: Array.from({ length: n }, (_, i) => ({ class: `V${i}`, address: `0x${i.toString(16)}` })),
		},
	};
}

describe("elideOldViewHierarchies", () => {
	test("single view_hierarchy stays intact (same array)", () => {
		const msgs = [
			{ role: "user" as const, content: "look" },
			assistantVh("vh-1"),
			toolResult("vh-1", "view_hierarchy", bigVh("0xaaa")),
		];
		expect(elideOldViewHierarchies(msgs)).toBe(msgs);
	});

	test("exactly keepRecent returns the same array", () => {
		const msgs = [
			assistantVh("vh-1"),
			toolResult("vh-1", "view_hierarchy", bigVh("0xaaa")),
			assistantVh("vh-2"),
			toolResult("vh-2", "view_hierarchy", bigVh("0xbbb")),
		];
		expect(elideOldViewHierarchies(msgs, { keepRecent: 2 })).toBe(msgs);
	});

	test("only oldest view_hierarchy is elided", () => {
		const first = bigVh("0xaaa");
		const second = bigVh("0xbbb");
		const third = bigVh("0xccc");
		const msgs = [
			assistantVh("vh-1"),
			toolResult("vh-1", "view_hierarchy", first),
			assistantVh("vh-2"),
			toolResult("vh-2", "view_hierarchy", second),
			assistantVh("vh-3"),
			toolResult("vh-3", "view_hierarchy", third),
		];
		const out = elideOldViewHierarchies(msgs, { keepRecent: 2 });
		const elided = JSON.parse((out[1] as { content: { text: string }[] }).content[0]!.text);
		expect(elided._elided).toBe("view_hierarchy");
		expect(elided.total_nodes).toBe(180);
		expect(elided.children).toBeUndefined();
		expect(JSON.parse((out[3] as { content: { text: string }[] }).content[0]!.text)).toEqual(second);
		expect(JSON.parse((out[5] as { content: { text: string }[] }).content[0]!.text)).toEqual(third);
	});

	test("non-vh results are never elided even when large", () => {
		const find = { ok: true, count: 60, results: Array.from({ length: 60 }, (_, i) => ({ address: `0x${i}` })) };
		const msgs = [
			assistantVh("find-1", "find_view"),
			toolResult("find-1", "find_view", find),
			assistantVh("vh-1"),
			toolResult("vh-1", "view_hierarchy", bigVh("0xaaa")),
			assistantVh("vh-2"),
			toolResult("vh-2", "view_hierarchy", bigVh("0xbbb")),
			assistantVh("vh-3"),
			toolResult("vh-3", "view_hierarchy", bigVh("0xccc")),
		];
		const out = elideOldViewHierarchies(msgs, { keepRecent: 2 });
		expect(out[1]).toBe(msgs[1]);
		const elided = JSON.parse((out[3] as { content: { text: string }[] }).content[0]!.text);
		expect(elided._elided).toBe("view_hierarchy");
	});

	test("intervening non-vh calls do not displace vh from the window", () => {
		const msgs = [
			assistantVh("vh-1"),
			toolResult("vh-1", "view_hierarchy", bigVh("0xaaa")),
			assistantVh("tap-1", "tap"),
			toolResult("tap-1", "tap", { ok: true }),
			assistantVh("vh-2"),
			toolResult("vh-2", "view_hierarchy", bigVh("0xbbb")),
		];
		expect(elideOldViewHierarchies(msgs, { keepRecent: 2 })).toBe(msgs);
	});

	test("small out-of-window vh is not rewritten", () => {
		const small = { ok: true, data: { _meta: { total_nodes: 8 }, address: "0xa1" } };
		const msgs = [
			assistantVh("vh-addr"),
			toolResult("vh-addr", "view_hierarchy", small),
			assistantVh("vh-2"),
			toolResult("vh-2", "view_hierarchy", bigVh("0xbbb")),
			assistantVh("vh-3"),
			toolResult("vh-3", "view_hierarchy", bigVh("0xccc")),
		];
		const out = elideOldViewHierarchies(msgs, { keepRecent: 2 });
		expect(out[1]).toBe(msgs[1]);
	});
});

describe("vhElisionSummary", () => {
	test("reads Para {ok,data} wrapping and Python top-level trees", () => {
		const wrapped = vhElisionSummary(
			JSON.stringify({ ok: true, data: { class: "UIWindow", address: "0x1", _meta: { total_nodes: 12 } } }),
		);
		expect(JSON.parse(wrapped)).toMatchObject({ _elided: "view_hierarchy", ok: true, class: "UIWindow", total_nodes: 12 });

		const flat = vhElisionSummary(
			JSON.stringify({ ok: true, class: "UIWindow", address: "0x2", _meta: { total_nodes: 9 } }),
		);
		expect(JSON.parse(flat)).toMatchObject({ class: "UIWindow", total_nodes: 9 });
	});
});
