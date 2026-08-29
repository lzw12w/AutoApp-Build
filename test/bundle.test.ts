import { describe, expect, test } from "bun:test";
import { extractBundleId, resolveBundleId } from "../src/knowledge/bundle.ts";

describe("extractBundleId", () => {
	test("reads common app_state keys", () => {
		expect(extractBundleId({ bundle_id: "com.foo" })).toBe("com.foo");
		expect(extractBundleId({ CFBundleIdentifier: "com.bar" })).toBe("com.bar");
		expect(extractBundleId({ packageName: "com.android.app" })).toBe("com.android.app");
	});

	test("reads ping.app as a reverse-DNS string", () => {
		expect(extractBundleId({ app: "com.parallel.odyssey", version: "2.25.0" })).toBe(
			"com.parallel.odyssey",
		);
	});

	test("walks nested app object like Python", () => {
		expect(extractBundleId({ app: { bundle_id: "com.nested" } })).toBe("com.nested");
	});

	test("ignores empty and unknown shapes", () => {
		expect(extractBundleId({})).toBeNull();
		expect(extractBundleId({ app: "" })).toBeNull();
		expect(extractBundleId({ foreground: true })).toBeNull();
		expect(extractBundleId(null)).toBeNull();
	});
});

describe("resolveBundleId", () => {
	test("configured id wins over device payloads", async () => {
		const id = await resolveBundleId(
			{
				appState: async () => ({ bundle_id: "com.from.state" }),
				ping: async () => ({ app: "com.from.ping" }),
			},
			"com.from.config",
		);
		expect(id).toBe("com.from.config");
	});

	test("falls back to ping.app when app_state has no identifier", async () => {
		const id = await resolveBundleId(
			{
				appState: async () => ({ foreground: true, version: "2.25.0" }),
				ping: async () => ({ app: "com.parallel.odyssey" }),
			},
			"",
		);
		expect(id).toBe("com.parallel.odyssey");
	});

	test("returns unknown_app when every source is empty", async () => {
		const id = await resolveBundleId(
			{
				appState: async () => {
					throw new Error("down");
				},
				ping: async () => ({}),
			},
			"  ",
		);
		expect(id).toBe("unknown_app");
	});
});
