/**
 * `para call` — the flag/JSON parameter surface and the guards around it.
 *
 * The knowledge-hook behaviour (a transition must be committed when a call
 * changes pages) is only observable against a live device, so it is verified by
 * hand rather than here; see the commit message for the recorded run.
 */
import { describe, expect, test } from "bun:test";
import { coerceParams, resultPayloadForTest } from "../src/call.ts";

describe("coerceParams", () => {
	// Flags arrive as strings; a schema wanting a number rejects "3".
	test("casts to the type the schema asks for", () => {
		const schema = {
			properties: {
				limit: { type: "integer" },
				scale: { type: "number" },
				animated: { type: "boolean" },
				text: { type: "string" },
				keys: { type: "array" },
			},
		};
		expect(
			coerceParams(
				{ limit: "3", scale: "0.5", animated: "false", text: "hi", keys: "a, b ,c" },
				schema,
			),
		).toEqual({ limit: 3, scale: 0.5, animated: false, text: "hi", keys: ["a", "b", "c"] });
	});

	test("a bare flag means true", () => {
		const schema = { properties: { animated: { type: "boolean" } } };
		expect(coerceParams({ animated: true }, schema)).toEqual({ animated: true });
	});

	test("rejects a non-numeric value instead of passing NaN to the tool", () => {
		const schema = { properties: { limit: { type: "integer" } } };
		expect(() => coerceParams({ limit: "many" }, schema)).toThrow(/expects a number/);
	});

	test("unions keep their string type rather than collapsing to any", () => {
		// TypeBox renders Union([String, Literal("ppe")]) as anyOf of two
		// strings; the value must not be coerced to a number or array.
		const schema = { properties: { env: { anyOf: [{ type: "string" }, { type: "string" }] } } };
		expect(coerceParams({ env: "ppe" }, schema)).toEqual({ env: "ppe" });
	});

	test("an unknown key passes through untouched", () => {
		// The CLI filters unknown flags before this point; if one slips
		// through, forward it and let schema validation report it.
		expect(coerceParams({ mystery: "x" }, { properties: {} })).toEqual({ mystery: "x" });
	});
});

describe("resultPayload", () => {
	// screenshot returns {width,height} as text plus the pixels as an image
	// block. Returning only the text would hand back dimensions and silently
	// drop the one thing the caller asked for.
	test("keeps image data alongside the text payload", () => {
		const out = resultPayloadForTest({
			content: [
				{ type: "text", text: JSON.stringify({ ok: true, width: 128, height: 277 }) },
				{ type: "image", data: "QUJD", mimeType: "image/jpeg" },
			],
			details: { ok: true },
		});
		expect(out).toEqual({
			ok: true,
			width: 128,
			height: 277,
			images: [{ mime_type: "image/jpeg", base64: "QUJD" }],
		});
	});

	test("unwraps the ok/data envelope so callers pipe straight to jq", () => {
		const out = resultPayloadForTest({
			content: [{ type: "text", text: JSON.stringify({ ok: true, data: { count: 2 } }) }],
			details: { ok: true },
		});
		expect(out).toEqual({ count: 2 });
	});

	test("plain-text results (screen_digest) pass through as text", () => {
		const out = resultPayloadForTest({
			content: [{ type: "text", text: "VC: SomeController\n@1 UIView" }],
			details: { ok: true },
		});
		expect(out).toBe("VC: SomeController\n@1 UIView");
	});
});
