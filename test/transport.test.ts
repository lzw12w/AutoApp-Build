import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { Socket } from "node:net";
import { HTTPStatusError, InspectorError, InvalidResponse, Timeout, Unreachable } from "../src/errors.ts";
import { Transport, type TransportOptions } from "../src/transport.ts";

/**
 * A duplex stand-in for a dialed device socket. The transport only needs
 * `write`, `destroy` and the readable events, so a PassThrough plus a captured
 * request buffer covers the contract without opening real sockets.
 */
interface FakeSocket extends PassThrough {
	written: string;
	destroyed: boolean;
}

function fakeSocket(): FakeSocket {
	const sock = new PassThrough() as unknown as FakeSocket;
	sock.written = "";
	const realWrite = sock.write.bind(sock);
	// Capture what the transport sends, but keep PassThrough's echo behaviour off:
	// responses are injected explicitly by the test's responder.
	sock.write = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
		sock.written += typeof chunk === "string" ? chunk : String(chunk);
		const done = typeof enc === "function" ? enc : cb;
		if (typeof done === "function") (done as () => void)();
		return true;
	}) as typeof realWrite;
	return sock;
}

/** Build a raw HTTP/1.1 response with a correct Content-Length. */
function httpResponse(status: number, body: string, extraHeaders: string[] = []): string {
	const reason = status === 200 ? "OK" : status === 400 ? "Bad Request" : status === 500 ? "Server Error" : "Status";
	const headers = [`Content-Length: ${Buffer.byteLength(body)}`, ...extraHeaders];
	return `HTTP/1.1 ${status} ${reason}\r\n${headers.join("\r\n")}\r\n\r\n${body}`;
}

type Responder = (sock: FakeSocket, request: string) => void;

/**
 * Wire a transport to a scripted dialer. `respond` is called once per attempt
 * with a fresh socket; it decides what (if anything) comes back.
 */
function transportWith(
	respond: Responder,
	options: TransportOptions = {},
): { t: Transport; attempts: () => number; requests: string[] } {
	let attempts = 0;
	const requests: string[] = [];
	const t = new Transport({
		timeoutMs: 200,
		...options,
		dialer: async () => {
			attempts++;
			const sock = fakeSocket();
			// Let the transport attach its listeners before data arrives.
			setImmediate(() => {
				requests.push(sock.written);
				respond(sock, sock.written);
			});
			return sock as unknown as Socket;
		},
	});
	return { t, attempts: () => attempts, requests };
}

/** Respond with a complete HTTP message, then EOF. */
function replies(status: number, body: string, extraHeaders: string[] = []): Responder {
	return (sock) => {
		sock.push(httpResponse(status, body, extraHeaders));
		sock.push(null);
	};
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
		const { t } = transportWith(replies(200, JSON.stringify({ ok: true, pong: 1 })));
		expect(await t.get("/api/ping")).toEqual({ ok: true, pong: 1 });
	});

	test("empty body returns {}", async () => {
		const { t } = transportWith(replies(200, ""));
		expect(await t.get("/api/ping")).toEqual({});
	});

	test("non-JSON body raises InvalidResponse", async () => {
		const { t } = transportWith(replies(200, "not json at all"));
		await expect(t.get("/api/ping")).rejects.toBeInstanceOf(InvalidResponse);
	});

	test("4xx is not retriable and raises HTTPStatusError", async () => {
		const { t, attempts } = transportWith(replies(400, "bad request"));
		await expect(t.get("/api/x", { retries: 3 })).rejects.toBeInstanceOf(HTTPStatusError);
		expect(attempts()).toBe(1);
	});

	test("5xx retries then raises", async () => {
		const { t, attempts } = transportWith(replies(500, "boom"));
		await expect(t.get("/api/x", { retries: 2 })).rejects.toBeInstanceOf(HTTPStatusError);
		expect(attempts()).toBe(3); // initial + 2 retries
	});

	test("5xx then success returns on retry", async () => {
		let calls = 0;
		const { t, attempts } = transportWith((sock) => {
			calls++;
			const raw = calls === 1 ? httpResponse(500, "boom") : httpResponse(200, JSON.stringify({ ok: true }));
			sock.push(raw);
			sock.push(null);
		});
		expect(await t.get("/api/x", { retries: 2 })).toEqual({ ok: true });
		expect(attempts()).toBe(2);
	});

	test("dial failure maps to Unreachable", async () => {
		const t = new Transport({
			timeoutMs: 200,
			dialer: async () => {
				throw new Error("device not connected");
			},
		});
		await expect(t.get("/api/x", { retries: 0 })).rejects.toBeInstanceOf(Unreachable);
	});

	test("socket error mid-response maps to Unreachable", async () => {
		const { t } = transportWith((sock) => {
			sock.emit("error", new Error("ECONNRESET"));
		});
		await expect(t.get("/api/x", { retries: 0 })).rejects.toBeInstanceOf(Unreachable);
	});

	test("a truncated response is Unreachable, not a bogus parse", async () => {
		// Header promises 99 bytes; peer closes after 4.
		const { t } = transportWith((sock) => {
			sock.push("HTTP/1.1 200 OK\r\nContent-Length: 99\r\n\r\nabcd");
			sock.push(null);
		});
		await expect(t.get("/api/x", { retries: 0 })).rejects.toBeInstanceOf(Unreachable);
	});

	test("timeout maps to Timeout and does not retry", async () => {
		// Never respond: the transport's own timeout must fire.
		const { t, attempts } = transportWith(() => {}, { timeoutMs: 50 });
		await expect(t.get("/api/x", { retries: 3 })).rejects.toBeInstanceOf(Timeout);
		expect(attempts()).toBe(1); // timed-out attempt is not retried
	});

	test("non-idempotent POST does not retry", async () => {
		const { t, attempts } = transportWith(replies(500, "boom"));
		await expect(t.post("/api/tap", { body: { x: 1 } })).rejects.toBeInstanceOf(HTTPStatusError);
		expect(attempts()).toBe(1);
	});

	test("idempotent POST retries", async () => {
		const { t, attempts } = transportWith(replies(500, "boom"));
		await expect(t.post("/api/x", { idempotent: true })).rejects.toBeInstanceOf(HTTPStatusError);
		expect(attempts()).toBe(3); // initial + 2 retries
	});

	test("POST sends a JSON body with the right headers", async () => {
		const { t, requests } = transportWith(replies(200, "{}"));
		await t.post("/api/tap", { body: { x: 1, y: 2 } });
		expect(requests[0]).toContain("POST /api/tap HTTP/1.1");
		expect(requests[0]).toContain("Content-Type: application/json");
		expect(requests[0]).toContain('{"x":1,"y":2}');
		expect(requests[0]).toContain("Content-Length: 13");
	});

	test("diagnose hook enriches terminal error", async () => {
		const { t } = transportWith(replies(500, "boom"), { onFailure: () => ({ crashed: true }) });
		try {
			await t.get("/api/x", { retries: 0 });
			throw new Error("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(HTTPStatusError);
			expect((e as HTTPStatusError).detail.diagnosis).toEqual({ crashed: true });
		}
	});

	test("Unreachable triggers one reconnect then retries and succeeds", async () => {
		let calls = 0;
		let reconnects = 0;
		const t = new Transport({
			timeoutMs: 200,
			onDisconnect: () => {
				reconnects++;
				return true;
			},
			dialer: async () => {
				calls++;
				if (calls === 1) throw new Error("device went away");
				const sock = fakeSocket();
				setImmediate(() => {
					sock.push(httpResponse(200, JSON.stringify({ ok: true })));
					sock.push(null);
				});
				return sock as unknown as Socket;
			},
		});
		// Non-idempotent POST with retries:0 — the extra attempt comes purely from
		// the reconnect path, not the retry budget.
		expect(await t.post("/api/tap", { body: { x: 1 } })).toEqual({ ok: true });
		expect(reconnects).toBe(1);
		expect(calls).toBe(2);
	});

	test("reconnect fires at most once per request", async () => {
		let reconnects = 0;
		const t = new Transport({
			timeoutMs: 200,
			onDisconnect: () => {
				reconnects++;
				return true;
			},
			dialer: async () => {
				throw new Error("still gone");
			},
		});
		await expect(t.get("/api/x", { retries: 2 })).rejects.toBeInstanceOf(Unreachable);
		expect(reconnects).toBe(1);
	});

	test("failed reconnect does not mask the Unreachable error", async () => {
		const t = new Transport({
			timeoutMs: 200,
			onDisconnect: () => false, // device did not come back
			dialer: async () => {
				throw new Error("gone");
			},
		});
		await expect(t.get("/api/x", { retries: 0 })).rejects.toBeInstanceOf(Unreachable);
	});

	test("reconnect callback that throws is swallowed", async () => {
		const t = new Transport({
			timeoutMs: 200,
			onDisconnect: () => {
				throw new Error("recheck blew up");
			},
			dialer: async () => {
				throw new Error("gone");
			},
		});
		await expect(t.get("/api/x", { retries: 0 })).rejects.toBeInstanceOf(Unreachable);
	});

	test("timeout does not trigger reconnect", async () => {
		let reconnects = 0;
		const { t } = transportWith(() => {}, { timeoutMs: 50, onDisconnect: () => (reconnects++, true) });
		await expect(t.get("/api/x", { retries: 3 })).rejects.toBeInstanceOf(Timeout);
		expect(reconnects).toBe(0);
	});

	test("query params are normalized", async () => {
		const { t, requests } = transportWith(replies(200, "{}"));
		await t.get("/api/x", { params: { a: 1, b: true, c: false, d: null, e: [1, 2], f: "" } });
		const line = requests[0]!.split("\r\n")[0]!;
		const query = new URL(line.split(" ")[1]!, "http://x").searchParams;
		expect(query.get("a")).toBe("1");
		expect(query.get("b")).toBe("true");
		expect(query.get("c")).toBe("false");
		expect(query.has("d")).toBe(false);
		expect(query.get("e")).toBe("1,2");
		expect(query.has("f")).toBe(false);
	});

	test("retarget switches the dialed device", () => {
		const t = new Transport({ port: 8765 });
		t.retarget({ device: "UDID-B", platform: "android", remotePort: 9000 });
		expect(t.device).toBe("UDID-B");
		expect(t.platform).toBe("android");
		expect(t.devicePort).toBe(9000);
	});

	test("baseUrl names the device, not a localhost URL nothing listens on", () => {
		// In device mode there is no local listener, so http://localhost:8765
		// would be a lie in `para doctor` output.
		const t = new Transport({ port: 8765, device: "UDID-A" });
		expect(t.baseUrl).toBe("usb://UDID-A:8765");
		t.retarget({ device: "SER-B", remotePort: 9000 });
		expect(t.baseUrl).toBe("usb://SER-B:9000");
	});

	test("baseUrl is a real connectable URL in tcp mode", () => {
		const t = new Transport({ host: "127.0.0.1", port: 18765, mode: "tcp" });
		expect(t.baseUrl).toBe("http://127.0.0.1:18765");
	});

	test("an unnamed device still yields a readable baseUrl", () => {
		expect(new Transport({ port: 8765 }).baseUrl).toBe("usb://connected-device:8765");
	});

	test("devicePort falls back to port when no remotePort is set", () => {
		expect(new Transport({ port: 8765 }).devicePort).toBe(8765);
		expect(new Transport({ port: 8765, remotePort: 9999 }).devicePort).toBe(9999);
	});
});
