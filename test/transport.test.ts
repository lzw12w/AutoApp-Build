import { afterEach, describe, expect, test } from "bun:test";
import { HTTPStatusError, InspectorError, Timeout, Unreachable } from "../src/errors.ts";
import { Transport } from "../src/transport.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
	globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
		handler(String(input), init ?? {})) as typeof fetch;
}

describe("Transport", () => {
	test("rejects non-local hosts", () => {
		expect(() => new Transport({ host: "example.com" })).toThrow(InspectorError);
	});

	test("accepts localhost / 127.0.0.1 / ::1", () => {
		expect(() => new Transport({ host: "localhost" })).not.toThrow();
		expect(() => new Transport({ host: "127.0.0.1" })).not.toThrow();
		expect(() => new Transport({ host: "::1" })).not.toThrow();
	});

	test("GET parses JSON body", async () => {
		mockFetch(async () => new Response(JSON.stringify({ ok: true, pong: 1 }), { status: 200 }));
		const t = new Transport();
		const result = (await t.get("/api/ping")) as Record<string, unknown>;
		expect(result).toEqual({ ok: true, pong: 1 });
	});

	test("empty body returns {}", async () => {
		mockFetch(async () => new Response("", { status: 200 }));
		const t = new Transport();
		expect(await t.get("/api/ping")).toEqual({});
	});

	test("4xx is not retriable and raises HTTPStatusError", async () => {
		let calls = 0;
		mockFetch(async () => {
			calls++;
			return new Response("bad request", { status: 400 });
		});
		const t = new Transport();
		await expect(t.get("/api/x", { retries: 3 })).rejects.toBeInstanceOf(HTTPStatusError);
		expect(calls).toBe(1);
	});

	test("5xx retries then raises", async () => {
		let calls = 0;
		mockFetch(async () => {
			calls++;
			return new Response("boom", { status: 500 });
		});
		const t = new Transport();
		await expect(t.get("/api/x", { retries: 2 })).rejects.toBeInstanceOf(HTTPStatusError);
		expect(calls).toBe(3); // initial + 2 retries
	});

	test("5xx then success returns on retry", async () => {
		let calls = 0;
		mockFetch(async () => {
			calls++;
			if (calls === 1) return new Response("boom", { status: 500 });
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		});
		const t = new Transport();
		expect(await t.get("/api/x", { retries: 2 })).toEqual({ ok: true });
		expect(calls).toBe(2);
	});

	test("connection failure maps to Unreachable", async () => {
		mockFetch(async () => {
			throw new TypeError("fetch failed");
		});
		const t = new Transport({ timeoutMs: 200 });
		await expect(t.get("/api/x", { retries: 0 })).rejects.toBeInstanceOf(Unreachable);
	});

	test("timeout maps to Timeout and does not retry", async () => {
		let calls = 0;
		mockFetch((_url, init) => {
			calls++;
			return new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			});
		});
		const t = new Transport({ timeoutMs: 50 });
		await expect(t.get("/api/x", { retries: 3 })).rejects.toBeInstanceOf(Timeout);
		expect(calls).toBe(1); // timed-out attempt is not retried
	});

	test("non-idempotent POST does not retry", async () => {
		let calls = 0;
		mockFetch(async () => {
			calls++;
			return new Response("boom", { status: 500 });
		});
		const t = new Transport();
		await expect(t.post("/api/tap", { body: { x: 1 } })).rejects.toBeInstanceOf(HTTPStatusError);
		expect(calls).toBe(1);
	});

	test("idempotent POST retries", async () => {
		let calls = 0;
		mockFetch(async () => {
			calls++;
			return new Response("boom", { status: 500 });
		});
		const t = new Transport();
		await expect(t.post("/api/x", { idempotent: true })).rejects.toBeInstanceOf(HTTPStatusError);
		expect(calls).toBe(3); // initial + 2 retries
	});

	test("diagnose hook enriches terminal error", async () => {
		mockFetch(async () => new Response("boom", { status: 500 }));
		const t = new Transport({ onFailure: () => ({ crashed: true }) });
		try {
			await t.get("/api/x", { retries: 0 });
			throw new Error("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(HTTPStatusError);
			expect((e as HTTPStatusError).detail.diagnosis).toEqual({ crashed: true });
		}
	});

	test("query params are normalized", async () => {
		let seenUrl = "";
		mockFetch(async (url) => {
			seenUrl = url;
			return new Response("{}", { status: 200 });
		});
		const t = new Transport();
		await t.get("/api/x", { params: { a: 1, b: true, c: false, d: null, e: [1, 2], f: "" } });
		const u = new URL(seenUrl);
		expect(u.searchParams.get("a")).toBe("1");
		expect(u.searchParams.get("b")).toBe("true");
		expect(u.searchParams.get("c")).toBe("false");
		expect(u.searchParams.has("d")).toBe(false);
		expect(u.searchParams.get("e")).toBe("1,2");
		expect(u.searchParams.has("f")).toBe(false);
	});
});
