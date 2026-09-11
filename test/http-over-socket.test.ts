import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { Socket } from "node:net";
import { HttpProtocolError, httpRequest } from "../src/http-over-socket.ts";

/** Duplex stand-in: captures the request, lets the test script the response. */
function fakeSocket() {
	const sock = new PassThrough() as unknown as PassThrough & { written: string };
	sock.written = "";
	sock.write = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
		sock.written += typeof chunk === "string" ? chunk : String(chunk);
		const done = typeof enc === "function" ? enc : cb;
		if (typeof done === "function") (done as () => void)();
		return true;
	}) as never;
	return sock;
}

/** Run one request while `script` feeds the response after listeners attach. */
function exchange(script: (sock: PassThrough & { written: string }) => void, options?: Partial<Parameters<typeof httpRequest>[1]>) {
	const sock = fakeSocket();
	setImmediate(() => script(sock));
	return httpRequest(sock as unknown as Socket, { method: "GET", path: "/api/ping", ...options });
}

describe("httpRequest", () => {
	test("parses status, headers and a Content-Length body", async () => {
		const res = await exchange((sock) => {
			sock.push('HTTP/1.1 200 OK\r\nContent-Length: 15\r\nContent-Type: application/json\r\n\r\n{"status":"ok"}');
			sock.push(null);
		});
		expect(res.status).toBe(200);
		expect(res.headers["content-type"]).toBe("application/json");
		expect(res.body).toBe('{"status":"ok"}');
	});

	test("headers are lowercased for stable lookup", async () => {
		const res = await exchange((sock) => {
			sock.push("HTTP/1.1 200 OK\r\nX-Weird-CASE: yes\r\nContent-Length: 0\r\n\r\n");
			sock.push(null);
		});
		expect(res.headers["x-weird-case"]).toBe("yes");
	});

	test("reassembles a body split across TCP segments", async () => {
		const res = await exchange((sock) => {
			// Split mid-header and mid-body: the parser must not care.
			sock.push("HTTP/1.1 200 OK\r\nContent-Len");
			setImmediate(() => {
				sock.push("gth: 9\r\n\r\n{\"a\":");
				setImmediate(() => {
					sock.push('1234}');
					sock.push(null);
				});
			});
		});
		expect(res.body).toBe('{"a":1234}'.slice(0, 9));
	});

	test("decodes a chunked body", async () => {
		const res = await exchange((sock) => {
			sock.push("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
			sock.push("5\r\nhello\r\n");
			sock.push("6\r\n world\r\n");
			sock.push("0\r\n\r\n");
		});
		expect(res.body).toBe("hello world");
	});

	test("chunk-size extensions are tolerated", async () => {
		const res = await exchange((sock) => {
			sock.push("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
			sock.push("5;name=value\r\nhello\r\n0\r\n\r\n");
		});
		expect(res.body).toBe("hello");
	});

	test("a large chunked body survives arbitrary fragmentation", async () => {
		const payload = "x".repeat(5000);
		const res = await exchange((sock) => {
			sock.push("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
			const raw = `${payload.length.toString(16)}\r\n${payload}\r\n0\r\n\r\n`;
			// Feed 512 bytes at a time.
			let i = 0;
			const pump = () => {
				if (i >= raw.length) return;
				sock.push(raw.slice(i, i + 512));
				i += 512;
				setImmediate(pump);
			};
			pump();
		});
		expect(res.body).toBe(payload);
		expect(res.body.length).toBe(5000);
	});

	test("a body with no length ends at EOF", async () => {
		const res = await exchange((sock) => {
			sock.push("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nbare body");
			sock.push(null);
		});
		expect(res.body).toBe("bare body");
	});

	test("204 has no body even without Content-Length", async () => {
		const res = await exchange((sock) => {
			sock.push("HTTP/1.1 204 No Content\r\n\r\n");
		});
		expect(res.status).toBe(204);
		expect(res.body).toBe("");
	});

	test("truncated Content-Length body rejects", async () => {
		await expect(
			exchange((sock) => {
				sock.push("HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\nshort");
				sock.push(null);
			}),
		).rejects.toBeInstanceOf(HttpProtocolError);
	});

	test("close mid-chunk rejects", async () => {
		await expect(
			exchange((sock) => {
				sock.push("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel");
				sock.push(null);
			}),
		).rejects.toBeInstanceOf(HttpProtocolError);
	});

	test("close before any header rejects", async () => {
		await expect(
			exchange((sock) => {
				sock.push(null);
			}),
		).rejects.toBeInstanceOf(HttpProtocolError);
	});

	test("a malformed status line rejects", async () => {
		await expect(
			exchange((sock) => {
				sock.push("GARBAGE\r\nContent-Length: 0\r\n\r\n");
				sock.push(null);
			}),
		).rejects.toBeInstanceOf(HttpProtocolError);
	});

	test("a socket error rejects", async () => {
		await expect(
			exchange((sock) => {
				sock.emit("error", new Error("ECONNRESET"));
			}),
		).rejects.toThrow(/ECONNRESET/);
	});

	test("an already-aborted signal rejects immediately", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(exchange(() => {}, { signal: controller.signal })).rejects.toBeInstanceOf(HttpProtocolError);
	});

	test("aborting mid-flight rejects", async () => {
		const controller = new AbortController();
		const pending = exchange(
			(sock) => {
				sock.push("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n");
				setImmediate(() => controller.abort());
			},
			{ signal: controller.signal },
		);
		await expect(pending).rejects.toBeInstanceOf(HttpProtocolError);
	});

	test("request line, Host and Connection: close are emitted", async () => {
		const sock = fakeSocket();
		setImmediate(() => {
			sock.push("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
			sock.push(null);
		});
		await httpRequest(sock as unknown as Socket, { method: "GET", path: "/api/tree?depth=2", host: "127.0.0.1" });
		expect(sock.written).toContain("GET /api/tree?depth=2 HTTP/1.1");
		expect(sock.written).toContain("Host: 127.0.0.1");
		expect(sock.written).toContain("Connection: close");
	});

	test("a POST body sets Content-Length from byte length, not character count", async () => {
		const sock = fakeSocket();
		setImmediate(() => {
			sock.push("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
			sock.push(null);
		});
		// Multi-byte text: 6 characters, 12 UTF-8 bytes.
		const body = JSON.stringify({ t: "中文字" });
		await httpRequest(sock as unknown as Socket, { method: "POST", path: "/api/x", body });
		expect(sock.written).toContain(`Content-Length: ${Buffer.byteLength(body)}`);
		expect(sock.written.endsWith(body)).toBe(true);
	});

	test("HEAD is treated as bodyless", async () => {
		const res = await exchange(
			(sock) => {
				sock.push("HTTP/1.1 200 OK\r\nContent-Length: 42\r\n\r\n");
			},
			{ method: "HEAD" },
		);
		expect(res.status).toBe(200);
		expect(res.body).toBe("");
	});
});
