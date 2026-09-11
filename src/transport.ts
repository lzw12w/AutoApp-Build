/**
 * HTTP transport to the on-device inspector server.
 *
 * Retries, timeouts, idempotency awareness and a best-effort diagnose hook
 * invoked once when a request fails terminally.
 *
 * Connection model: each attempt dials the device directly through usbmuxd
 * (iOS) or the adb server (Android) — see ios-runtime/device-broker.ts — and
 * speaks HTTP on the returned socket. There is no forwarded localhost port, so
 * nothing has to be allocated, owned, health-checked or reclaimed; a dead
 * socket is just a socket to close. Dialing costs well under a millisecond, so
 * one fresh connection per request is cheaper than the old model's startup
 * probe alone.
 *
 * `host`/`port`/`baseUrl` are retained because they are what users, `para
 * doctor` and error messages talk about, and because a caller may still point
 * Para at an already-forwarded localhost port via `PARA_INSPECTOR_TRANSPORT=tcp`.
 *
 * Cancellation uses an AbortSignal (pi passes one into every tool `execute`).
 * An in-flight request is aborted via the signal; between retries we also bail
 * out promptly when it fires.
 */
import { Cancelled, HTTPStatusError, InspectorError, InvalidResponse, Timeout, Unreachable } from "./errors.ts";
import { httpRequest } from "./http-over-socket.ts";
import { dialDeviceId, type DevicePlatform, DeviceUnavailable } from "./ios-runtime/device-broker.ts";
import { connect, type Socket } from "node:net";

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Invoked exactly once when a request fails terminally (after exhausting
 * retries). May return a JSON-serializable object attached to
 * `error.detail.diagnosis`. Must be cheap, best-effort, and never throw —
 * the transport swallows exceptions from it.
 */
export type DiagnoseCallback = (error: InspectorError) => Record<string, unknown> | null | undefined;

/**
 * Invoked when a request hits a hard disconnect mid-session (an `Unreachable`,
 * not a timeout or HTTP error) — the device was unplugged, the app died, or the
 * daemon dropped us. The callback should resolve `true` when the device looks
 * usable again; the transport then retries the request once, independent of the
 * retry budget, which is safe even for non-idempotent POSTs because an
 * `Unreachable` means the request never landed.
 *
 * Must be cheap and never throw — exceptions are swallowed and treated as a
 * failed reconnect. Fires at most once per request.
 */
export type ReconnectCallback = (error: InspectorError) => boolean | Promise<boolean>;

/** How the transport obtains a socket for each attempt. */
export type TransportMode = "device" | "tcp";

/** Opens a socket for one request. Replaceable in tests. */
export type SocketDialer = (signal?: AbortSignal) => Promise<Socket>;

export interface TransportOptions {
	host?: string;
	port?: number;
	/** Per-request timeout in milliseconds. */
	timeoutMs?: number;
	onFailure?: DiagnoseCallback;
	onDisconnect?: ReconnectCallback;
	/** Device selector (UDID / adb serial). Empty: the sole connected device. */
	device?: string;
	platform?: DevicePlatform;
	/** On-device inspector port. Defaults to `port`. */
	remotePort?: number;
	/**
	 * `device` (default) dials the device via usbmuxd / adb. `tcp` connects to
	 * host:port, for an externally managed forward. Overridable per process with
	 * `PARA_INSPECTOR_TRANSPORT=tcp`.
	 */
	mode?: TransportMode;
	/** Test seam: bypass both dial paths entirely. */
	dialer?: SocketDialer;
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

function resolveMode(explicit: TransportMode | undefined): TransportMode {
	if (explicit) return explicit;
	const raw = (process.env.PARA_INSPECTOR_TRANSPORT || "").trim().toLowerCase();
	return raw === "tcp" ? "tcp" : "device";
}

/** Connect to an already-forwarded localhost port (`mode: "tcp"`). */
function dialTcp(host: string, port: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const sock = connect(port, host === "localhost" ? "127.0.0.1" : host);
		const onError = (e: Error) => {
			sock.destroy();
			reject(e);
		};
		sock.once("error", onError);
		sock.once("connect", () => {
			sock.off("error", onError);
			resolve(sock);
		});
	});
}

export class Transport {
	host: string;
	port: number;
	readonly timeoutMs: number;
	device: string;
	platform?: DevicePlatform;
	remotePort?: number;
	readonly mode: TransportMode;
	private readonly onFailure?: DiagnoseCallback;
	private readonly onDisconnect?: ReconnectCallback;
	private readonly dialer?: SocketDialer;
	private diagnosing = false;

	constructor(options: TransportOptions = {}) {
		const host = options.host ?? "localhost";
		if (!ALLOWED_HOSTS.has(host)) {
			throw new InspectorError(
				`Refusing non-local inspector host ${JSON.stringify(host)}; Para dials devices over USB, not the network.`,
				"E_INVALID_ARGUMENT",
			);
		}
		this.host = host;
		this.port = options.port ?? 8765;
		this.timeoutMs = options.timeoutMs ?? 5000;
		this.onFailure = options.onFailure;
		this.onDisconnect = options.onDisconnect;
		this.device = options.device ?? "";
		this.platform = options.platform;
		this.remotePort = options.remotePort;
		this.mode = resolveMode(options.mode);
		this.dialer = options.dialer;
	}

	/** Point this transport at a different device / port after routing. */
	retarget(options: { host?: string; port?: number; device?: string; platform?: DevicePlatform; remotePort?: number }): void {
		if (options.host !== undefined) {
			if (!ALLOWED_HOSTS.has(options.host)) {
				throw new InspectorError(
					`Refusing non-local inspector host ${JSON.stringify(options.host)}; Para dials devices over USB, not the network.`,
					"E_INVALID_ARGUMENT",
				);
			}
			this.host = options.host;
		}
		if (options.port !== undefined) this.port = options.port;
		if (options.device !== undefined) this.device = options.device;
		if (options.platform !== undefined) this.platform = options.platform;
		if (options.remotePort !== undefined) this.remotePort = options.remotePort;
	}

	/**
	 * How this transport's target is named in user-facing output (`para doctor`,
	 * error messages). In `tcp` mode this is a real, connectable URL. When
	 * dialing a device there is no local listener, so a `http://localhost:…`
	 * string would be a lie — we name the device and its in-app port instead.
	 */
	get baseUrl(): string {
		if (this.mode === "tcp") return `http://${this.host}:${this.port}`;
		const who = this.device || "connected-device";
		return `usb://${who}:${this.devicePort}`;
	}

	/** The on-device port requests are addressed to. */
	get devicePort(): number {
		return this.remotePort ?? this.port;
	}

	async get(path: string, options: GetOptions = {}): Promise<unknown> {
		return this.doRequest(
			{ method: "GET", path: this.buildPath(path, options.params) },
			options.retries ?? 3,
			options.signal,
		);
	}

	async post(path: string, options: PostOptions = {}): Promise<unknown> {
		// Non-idempotent POSTs (tap, swipe, ...) MUST NOT auto-retry.
		const retries = options.retries ?? (options.idempotent ? 2 : 0);
		return this.doRequest(
			{
				method: "POST",
				path: this.buildPath(path),
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(options.body ?? {}),
			},
			retries,
			options.signal,
		);
	}

	/** Build `path?query`, normalizing booleans and arrays the way the server expects. */
	private buildPath(path: string, params?: Record<string, unknown>): string {
		// Parse against a dummy origin so we only ever emit path + query.
		const url = new URL(path, "http://device.invalid");
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
		return `${url.pathname}${url.search}`;
	}

	private async openSocket(signal?: AbortSignal): Promise<Socket> {
		if (this.dialer) return this.dialer(signal);
		if (this.mode === "tcp") return dialTcp(this.host, this.port);
		return dialDeviceId(this.device, this.devicePort, this.platform);
	}

	private async doRequest(
		request: { method: string; path: string; headers?: Record<string, string>; body?: string },
		retries: number,
		signal?: AbortSignal,
	): Promise<unknown> {
		let lastExc: InspectorError | null = null;
		let backoff = 500;
		let reconnectTried = false;

		for (let attempt = 0; attempt <= retries; attempt++) {
			if (signal?.aborted) throw new Cancelled("request cancelled by user");

			// Bound each attempt with our own timeout, merged with the caller signal.
			const timeoutController = new AbortController();
			const timer = setTimeout(() => timeoutController.abort(), this.timeoutMs);
			const merged = mergeSignals(signal, timeoutController.signal);
			let sock: Socket | null = null;

			try {
				sock = await this.openSocket(merged);
				const resp = await httpRequest(sock, { ...request, host: this.host, signal: merged });
				const text = resp.body;

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
					lastExc = new Timeout(`Request to ${this.baseUrl}${request.path} timed out after ${this.timeoutMs}ms`);
				} else {
					lastExc = new Unreachable(`Cannot reach inspector at ${this.describeTarget()}: ${describe(e)}`, {
						hint: this.unreachableHint(e),
					});
				}
			} finally {
				clearTimeout(timer);
				// One request per socket; never leave a half-open connection behind.
				sock?.destroy();
			}

			// The device can vanish mid-session (unplugged, app killed). An
			// `Unreachable` means the request never landed, so once per request we
			// ask the owner to re-check and grant one extra attempt — outside the
			// retry budget, and safe for non-idempotent POSTs.
			if (lastExc instanceof Unreachable && !reconnectTried && (await this.attemptReconnect(lastExc, signal))) {
				reconnectTried = true;
				attempt--;
				continue;
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
		const err = lastExc ?? new Unreachable(`Cannot reach inspector at ${this.describeTarget()}`);
		this.attachDiagnosis(err);
		throw err;
	}

	/** How the failing target should be named in an error message. */
	private describeTarget(): string {
		if (this.mode === "tcp") return this.baseUrl;
		const who = this.device ? `device ${this.device}` : "the connected device";
		return `${who} port ${this.devicePort}`;
	}

	private unreachableHint(cause: unknown): string {
		if (this.mode === "tcp") {
			return `PARA_INSPECTOR_TRANSPORT=tcp expects something already listening on ${this.baseUrl}.`;
		}
		// A DeviceUnavailable already carries the actionable detail; don't bury it.
		if (cause instanceof DeviceUnavailable) return cause.message;
		return "Check the device is connected and unlocked, and the instrumented app is running.";
	}

	private async attemptReconnect(error: InspectorError, signal?: AbortSignal): Promise<boolean> {
		if (!this.onDisconnect || signal?.aborted) return false;
		try {
			return (await this.onDisconnect(error)) === true;
		} catch {
			// A failed reconnect must not mask the original transport error.
			return false;
		}
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
