/**
 * HTTP transport to the on-device SAInspector server.
 *
 * Ported from ios_inspector_agent/core/transport.py. Pure HTTP: retries,
 * timeouts, idempotency awareness, localhost-only guard, and a best-effort
 * diagnose hook invoked once when a request fails terminally.
 *
 * Cancellation uses an AbortSignal (pi passes one into every tool `execute`),
 * replacing the Python threading.Event. An in-flight fetch is aborted via the
 * signal; between retries we also bail out promptly when it fires.
 */
import { Cancelled, HTTPStatusError, InspectorError, InvalidResponse, Timeout, Unreachable } from "./errors.ts";

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Invoked exactly once when a request fails terminally (after exhausting
 * retries). May return a JSON-serializable object attached to
 * `error.detail.diagnosis`. Must be cheap, best-effort, and never throw —
 * the transport swallows exceptions from it.
 */
export type DiagnoseCallback = (error: InspectorError) => Record<string, unknown> | null | undefined;

export interface TransportOptions {
	host?: string;
	port?: number;
	/** Per-request timeout in milliseconds. */
	timeoutMs?: number;
	onFailure?: DiagnoseCallback;
}

export interface GetOptions {
	params?: Record<string, unknown>;
	retries?: number;
	signal?: AbortSignal;
}

export interface PostOptions {
	body?: Record<string, unknown>;
	/** Idempotent POSTs may auto-retry (default 2); non-idempotent never do. */
	idempotent?: boolean;
	retries?: number;
	signal?: AbortSignal;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Cancelled("request cancelled by user"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Cancelled("request cancelled by user"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});

export class Transport {
	readonly host: string;
	readonly port: number;
	readonly timeoutMs: number;
	private readonly onFailure?: DiagnoseCallback;
	private diagnosing = false;

	constructor(options: TransportOptions = {}) {
		const host = options.host ?? "localhost";
		if (!ALLOWED_HOSTS.has(host)) {
			throw new InspectorError(
				`Refusing non-local inspector host ${JSON.stringify(host)}; use port forwarding (iproxy) for real devices.`,
				"E_INVALID_ARGUMENT",
			);
		}
		this.host = host;
		this.port = options.port ?? 8765;
		this.timeoutMs = options.timeoutMs ?? 5000;
		this.onFailure = options.onFailure;
	}

	get baseUrl(): string {
		return `http://${this.host}:${this.port}`;
	}

	async get(path: string, options: GetOptions = {}): Promise<unknown> {
		const url = this.buildUrl(path, options.params);
		return this.doRequest(url, { method: "GET" }, options.retries ?? 3, options.signal);
	}

	async post(path: string, options: PostOptions = {}): Promise<unknown> {
		const url = this.buildUrl(path);
		// Non-idempotent POSTs (tap, swipe, ...) MUST NOT auto-retry.
		const retries = options.retries ?? (options.idempotent ? 2 : 0);
		return this.doRequest(
			url,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(options.body ?? {}),
			},
			retries,
			options.signal,
		);
	}

	private buildUrl(path: string, params?: Record<string, unknown>): string {
		const url = new URL(this.baseUrl + path);
		if (params) {
			for (const [k, v] of Object.entries(params)) {
				if (v === null || v === undefined || v === "") continue;
				if (typeof v === "boolean") {
					url.searchParams.set(k, v ? "true" : "false");
				} else if (Array.isArray(v)) {
					if (v.length) url.searchParams.set(k, v.map(String).join(","));
				} else {
					url.searchParams.set(k, String(v));
				}
			}
		}
		return url.toString();
	}

	private async doRequest(
		url: string,
		init: RequestInit,
		retries: number,
		signal?: AbortSignal,
	): Promise<unknown> {
		let lastExc: InspectorError | null = null;
		let backoff = 500;

		for (let attempt = 0; attempt <= retries; attempt++) {
			if (signal?.aborted) throw new Cancelled("request cancelled by user");

			// Bound each attempt with our own timeout, merged with the caller signal.
			const timeoutController = new AbortController();
			const timer = setTimeout(() => timeoutController.abort(), this.timeoutMs);
			const merged = mergeSignals(signal, timeoutController.signal);

			try {
				const resp = await fetch(url, { ...init, signal: merged });
				const text = await resp.text();

				if (resp.status >= 400) {
					// 4xx is not retriable.
					if (resp.status < 500) {
						const err = new HTTPStatusError(resp.status, text);
						this.attachDiagnosis(err);
						throw err;
					}
					lastExc = new HTTPStatusError(resp.status, text);
				} else {
					if (!text) return {};
					try {
						return JSON.parse(text);
					} catch (_e) {
						throw new InvalidResponse(`Non-JSON response: ${text.slice(0, 200)}`);
					}
				}
			} catch (e) {
				if (e instanceof HTTPStatusError || e instanceof InvalidResponse) throw e;
				if (signal?.aborted) throw new Cancelled("request cancelled by user");
				// Our timeout controller fired: this attempt burned the full timeout.
				if (timeoutController.signal.aborted) {
					lastExc = new Timeout(`Request to ${url} timed out after ${this.timeoutMs}ms`);
				} else {
					lastExc = new Unreachable(`Cannot reach inspector at ${this.baseUrl}: ${describe(e)}`, {
						hint: `Run \`iproxy ${this.port} ${this.port}\` for a real device.`,
					});
				}
			} finally {
				clearTimeout(timer);
			}

			// A timed-out attempt already burned the full timeout; retrying
			// multiplies the stall with almost no chance of success. Fail fast.
			if (lastExc instanceof Timeout) break;

			if (attempt < retries) {
				await sleep(backoff, signal);
				backoff *= 2;
			}
		}

		// All retries exhausted — the moment that "could mean the app crashed".
		const err = lastExc ?? new Unreachable(`Cannot reach inspector at ${this.baseUrl}`);
		this.attachDiagnosis(err);
		throw err;
	}

	private attachDiagnosis(error: InspectorError): void {
		if (!this.onFailure || this.diagnosing) return;
		this.diagnosing = true;
		try {
			const diagnosis = this.onFailure(error);
			if (diagnosis) error.detail.diagnosis = diagnosis;
		} catch {
			// Best-effort: the original transport error wins.
		} finally {
			this.diagnosing = false;
		}
	}
}

function describe(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}

/** Combine two AbortSignals into one that fires when either does. */
function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
	if (!a) return b;
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	if (a.aborted || b.aborted) controller.abort();
	a.addEventListener("abort", onAbort, { once: true });
	b.addEventListener("abort", onAbort, { once: true });
	return controller.signal;
}
