import { describe, expect, test } from "bun:test";
import {
	COMPACT_LIMIT,
	compactPayload,
	compactToolResultContent,
} from "../src/compact/payload.ts";

describe("compactPayload", () => {
	test("minifies JSON and leaves small payloads alone", () => {
		const payload = { ok: true, data: { class: "UIButton", address: "0x1" } };
		expect(compactPayload(payload, "tap")).toBe(JSON.stringify(payload));
	});

	test("full-dump tools are never degraded", () => {
		const huge = {
			ok: true,
			data: {
				class: "UIWindow",
				children: Array.from({ length: 400 }, (_, i) => ({
					class: "UILabel",
					address: `0x${i.toString(16)}`,
					text: "x".repeat(80),
				})),
			},
		};
		const out = compactPayload(huge, "view_hierarchy");
		expect(out.length).toBeGreaterThan(COMPACT_LIMIT);
		expect(JSON.parse(out).data.children).toHaveLength(400);
	});

	test("oversized non-dump view-shaped payload keeps a skeleton", () => {
		const huge = {
			ok: true,
			_meta: { total_nodes: 200 },
			class: "UIWindow",
			address: "0xroot",
			children: Array.from({ length: 80 }, (_, i) => ({
				class: "UILabel",
				address: `0x${i.toString(16)}`,
				text: "row ".repeat(40),
				children: [{ class: "UIView", address: `0xc${i}` }],
			})),
		};
		const parsed = JSON.parse(compactPayload(huge, "vc_hierarchy"));
		expect(parsed._truncated).toBe(true);
		expect(parsed.ok).toBe(true);
		expect(parsed.skeleton.class).toBe("UIWindow");
		expect(parsed.skeleton.address).toBe("0xroot");
		expect(parsed.skeleton.children.length).toBeLessThanOrEqual(10);
	});

	test("oversized dict that is not a view tree reports keys", () => {
		const huge = { ok: true, blob: "z".repeat(COMPACT_LIMIT) };
		const parsed = JSON.parse(compactPayload(huge, "ping"));
		expect(parsed._truncated).toBe(true);
		expect(parsed.keys.blob).toMatch(/^<str len=/);
	});

	test("oversized tap_with_diff keeps identifiers and drops frames", () => {
		const entry = (i: number) => ({
			class: "UILabel",
			address: `0x${i.toString(16)}`,
			text: `row-${i}`,
			frame: [0, i * 20, 400, 20],
			hidden: false,
			alpha: 1,
			on_screen: true,
		});
		const payload = {
			ok: true,
			data: {
				target_address: "0xb",
				vc_changed: false,
				post_check: { kind: "view_hierarchy_diff", ok: true, changed: true },
				view_diff: {
					kind: "view_hierarchy_diff",
					ok: true,
					changed: true,
					summary: "view changed",
					before_nodes: 10,
					after_nodes: 200,
					diff: {
						added_count: 80,
						removed_count: 0,
						changed_count: 0,
						unchanged_count: 10,
						added: Array.from({ length: 80 }, (_, i) => ({
							...entry(i),
							pad: "x".repeat(200),
						})),
						removed: [],
						changed: [],
					},
				},
			},
		};
		const raw = JSON.stringify(payload);
		expect(raw.length).toBeGreaterThan(COMPACT_LIMIT);
		const parsed = JSON.parse(compactPayload(payload, "tap_with_diff"));
		expect(parsed.ok).toBe(true);
		expect(parsed.data.view_diff._slimmed_for_size).toContain("do NOT");
		expect(parsed.data.view_diff.diff.added_count).toBe(80);
		const first = parsed.data.view_diff.diff.added[0];
		expect(first.text).toMatch(/^row-/);
		expect(first.address).toBeDefined();
		expect(first.frame).toBeUndefined();
	});
});

describe("compactToolResultContent", () => {
	test("rewrites an oversized JSON text block", () => {
		const payload = { ok: true, blob: "z".repeat(COMPACT_LIMIT) };
		const content = [{ type: "text", text: JSON.stringify(payload) }];
		const out = compactToolResultContent("ping", content);
		expect(out).not.toBe(content);
		expect(JSON.parse(out[0]!.text!)._truncated).toBe(true);
	});

	test("leaves screenshot image blocks untouched", () => {
		const content = [{ type: "image", data: "AAAA", mimeType: "image/jpeg" }];
		expect(compactToolResultContent("screenshot", content)).toBe(content);
	});

	test("returns the same array when nothing shrinks", () => {
		const content = [{ type: "text", text: JSON.stringify({ ok: true, data: 1 }) }];
		expect(compactToolResultContent("tap", content)).toBe(content);
	});
});
