/**
 * HTTP/1.1 over an arbitrary socket.
 *
 * The transport used to call `fetch()` against a forwarded localhost port. Now
 * that it dials the device directly (see ios-runtime/device-broker.ts) there is
 * no URL to fetch — we hold a raw socket and must speak HTTP on it ourselves.
 *
 * Deliberately minimal but correct for what an inspector server returns:
 *   - `Content-Length` bodies and `Transfer-Encoding: chunked`
 *   - `Connection: close` responses that signal end-of-body by EOF
 *   - header/body split across arbitrary TCP segment boundaries
 *   - a response that begins arriving before the request finishes writing
 *
 * Not implemented on purpose: keep-alive reuse (every request gets a fresh
 * socket — dialing costs well under a millisecond), redirects, compression,
 * trailers, and HTTP/2. If the server ever needs those, use a real client.
 */
import type { Socket } from "node:net";

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	body: string;
}

export interface HttpRequestOptions {
	method: string;
	/** Path plus query string, e.g. `/api/tree?depth=3`. */
	path: string;
	headers?: Record<string, string>;
	body?: string;
	/** Value for the `Host` header; cosmetic for a direct socket. */
	host?: string;
	signal?: AbortSignal;
}

export class HttpProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HttpProtocolError";
	}
}

const CRLF = "\r\n";
const HEADER_END = "\r\n\r\n";

/** Parse a status line + header block into a status code and lowercased headers. */
function parseHead(head: string): { status: number; headers: Record<string, string> } {
	const lines = head.split(CRLF);
	const statusLine = lines[0] ?? "";
	const match = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})/);
	if (!match) throw new HttpProtocolError(`Malformed status line: ${JSON.stringify(statusLine.slice(0, 80))}`);
	const headers: Record<string, string> = {};
	for (const line of lines.slice(1)) {
		const colon = line.indexOf(":");
		if (colon < 1) continue;
		headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
	}
	return { status: Number.parseInt(match[1]!, 10), headers };
}

/**
 * Decode a chunked body. Returns null while the terminating zero-length chunk
 * has not arrived yet, so the caller keeps reading.
 */
function decodeChunked(buf: Buffer): string | null {
	let offset = 0;
	const parts: Buffer[] = [];
	for (;;) {
		const lineEnd = buf.indexOf(CRLF, offset);
		if (lineEnd < 0) return null;
		// Chunk size may carry `;ext` parameters we ignore.
		const sizeText = buf.subarray(offset, lineEnd).toString("ascii").split(";")[0]!.trim();
		const size = Number.parseInt(sizeText, 16);
		if (!Number.isFinite(size) || size < 0) throw new HttpProtocolError(`Bad chunk size ${JSON.stringify(sizeText)}`);
		const dataStart = lineEnd + CRLF.length;
		if (size === 0) return Buffer.concat(parts).toString("utf8");
		const dataEnd = dataStart + size;
		// Need the chunk plus its trailing CRLF.
		if (buf.length < dataEnd + CRLF.length) return null;
		parts.push(buf.subarray(dataStart, dataEnd));
		offset = dataEnd + CRLF.length;
	}
}

/**
 * Issue one request on `sock` and resolve the full response.
 *
 * The socket is consumed: callers must not reuse it afterwards. Aborting via
 * `signal` destroys the socket and rejects — the transport maps that onto its
 * own cancellation error, so no HTTP-specific abort type leaks upward.
 */
export function httpRequest(sock: Socket, options: HttpRequestOptions): Promise<HttpResponse> {
	return new Promise((resolve, reject) => {
		const { method, path, body, signal } = options;
		let settled = false;
		let buf = Buffer.alloc(0);
		let head: { status: number; headers: Record<string, string> } | null = null;
		let bodyStart = 0;

		const cleanup = () => {
			sock.off("data", onData);
			sock.off("end", onEnd);
			sock.off("close", onEnd);
			sock.off("error", onError);
			signal?.removeEventListener("abort", onAbort);
		};
		const succeed = (response: HttpResponse) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(response);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			sock.destroy();
			reject(error);
		};

		function onAbort() {
			fail(new HttpProtocolError("request aborted"));
		}
		function onError(e: Error) {
			fail(e);
		}

		/** Try to complete the response from what has arrived so far. */
		function tryComplete(atEof: boolean): void {
			if (!head) {
				const split = buf.indexOf(HEADER_END);
				if (split < 0) {
					// A closed connection with no header block is a protocol error.
					if (atEof) fail(new HttpProtocolError("connection closed before response headers"));
					return;
				}
				// parseHead throws on a malformed status line. We are inside a stream
				// event handler, so that must become a rejection rather than an
				// uncaught exception.
				try {
					head = parseHead(buf.subarray(0, split).toString("utf8"));
				} catch (e) {
					fail(e instanceof Error ? e : new HttpProtocolError(String(e)));
					return;
				}
				bodyStart = split + HEADER_END.length;
			}

			const raw = buf.subarray(bodyStart);
			const { status, headers } = head;

			// 204/304 and HEAD carry no body regardless of headers.
			if (status === 204 || status === 304 || method.toUpperCase() === "HEAD") {
				succeed({ status, headers, body: "" });
				return;
			}

			if ((headers["transfer-encoding"] ?? "").toLowerCase().includes("chunked")) {
				let decoded: string | null;
				try {
					decoded = decodeChunked(raw);
				} catch (e) {
					fail(e instanceof Error ? e : new HttpProtocolError(String(e)));
					return;
				}
				if (decoded !== null) succeed({ status, headers, body: decoded });
				else if (atEof) fail(new HttpProtocolError("connection closed mid-chunk"));
				return;
			}

			const lengthText = headers["content-length"];
			if (lengthText !== undefined) {
				const expected = Number.parseInt(lengthText, 10);
				if (!Number.isFinite(expected) || expected < 0) {
					fail(new HttpProtocolError(`Bad Content-Length ${JSON.stringify(lengthText)}`));
					return;
				}
				if (raw.length >= expected) {
					succeed({ status, headers, body: raw.subarray(0, expected).toString("utf8") });
				} else if (atEof) {
					fail(new HttpProtocolError(`truncated body: got ${raw.length} of ${expected} bytes`));
				}
				return;
			}

			// No length and no chunking: the body ends at EOF.
			if (atEof) succeed({ status, headers, body: raw.toString("utf8") });
		}

		function onData(chunk: Uint8Array | string) {
			if (settled) return;
			buf = Buffer.concat([buf, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk)]);
			tryComplete(false);
		}
		function onEnd() {
			if (settled) return;
			tryComplete(true);
			// tryComplete may legitimately still be waiting; EOF ends that hope.
			if (!settled) fail(new HttpProtocolError("connection closed before a complete response"));
		}

		if (signal?.aborted) {
			fail(new HttpProtocolError("request aborted"));
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		sock.on("data", onData);
		sock.on("end", onEnd);
		sock.on("close", onEnd);
		sock.on("error", onError);

		const payload = body ?? "";
		const headers: Record<string, string> = {
			Host: options.host ?? "localhost",
			// One request per socket: ask the server to close so a body without
			// Content-Length still terminates deterministically.
			Connection: "close",
			Accept: "*/*",
			...options.headers,
		};
		if (payload) headers["Content-Length"] = String(Buffer.byteLength(payload));

		const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
		const request = `${method.toUpperCase()} ${path} HTTP/1.1${CRLF}${lines.join(CRLF)}${HEADER_END}${payload}`;
		sock.write(request, "utf8", (e) => {
			if (e) fail(e);
		});
	});
}
