/**
 * Device discovery and direct socket dialing — no child processes, no local ports.
 *
 * Replaces the old `iproxy` / `adb forward` model. Both platforms already run a
 * multiplexing daemon that will hand us a socket straight to a port on the
 * device, so Para talks those protocols itself:
 *
 *   iOS      usbmuxd on /var/run/usbmuxd — `ListDevices`, `Listen`, `Connect`
 *   Android  the adb server on 5037      — `host:devices-l`, `host:track-devices-l`,
 *                                          `host:transport:<serial>` + `tcp:<port>`
 *
 * Why this removes so much machinery: the old design forwarded a device port to
 * a *local* port, which is a shared mutable resource. That forced port
 * allocation, a persisted registry, a file lock, ownership detection by
 * scanning `ps`, a pid ledger, zombie-tunnel reclamation and orphan cleanup.
 * Dialing gives every request its own socket, so none of that state exists.
 *
 * Identity: the stable key is the UDID (iOS) or adb serial (Android). usbmux's
 * numeric DeviceID is a per-session handle that changes on every replug, so it
 * is resolved fresh on each dial and never persisted.
 */
import { connect, type Socket } from "node:net";

export const REMOTE_INSPECTOR_PORT = 8765;

const USBMUX_SOCKET_DEFAULT = "/var/run/usbmuxd";
const ADB_HOST_DEFAULT = "127.0.0.1";
const ADB_PORT_DEFAULT = 5037;

const DISCOVERY_TIMEOUT_MS = 3000;
const DIAL_TIMEOUT_MS = 5000;

export type DevicePlatform = "ios" | "android";

export interface DeviceInfo {
	/** UDID (iOS) or adb serial (Android). Stable across replug. */
	id: string;
	platform: DevicePlatform;
	/** `USB` / `Network` for iOS; adb state (`device`, `unauthorized`, …). */
	connection: string;
	/** Human-facing model name when the daemon reports one. */
	model?: string;
	/** True when the device is actually usable (paired / authorized). */
	ready: boolean;
}

export class DeviceUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DeviceUnavailable";
	}
}

// ---- test seam -------------------------------------------------------

export interface BrokerHooks {
	listIos?: () => Promise<DeviceInfo[]> | DeviceInfo[];
	listAndroid?: () => Promise<DeviceInfo[]> | DeviceInfo[];
	dial?: (device: DeviceInfo, port: number) => Promise<Socket>;
}

let hooks: BrokerHooks | null = null;

/** Test seam. Pass `null` to restore real daemon I/O. */
export function setBrokerTestHooks(next: BrokerHooks | null): void {
	hooks = next;
}

function usbmuxAddress(): string {
	return (process.env.USBMUXD_SOCKET_ADDRESS || "").trim() || USBMUX_SOCKET_DEFAULT;
}

function adbEndpoint(): { host: string; port: number } {
	const host = (process.env.ANDROID_ADB_SERVER_HOST || "").trim() || ADB_HOST_DEFAULT;
	const raw = Number.parseInt((process.env.ANDROID_ADB_SERVER_PORT || "").trim(), 10);
	return { host, port: Number.isInteger(raw) && raw > 0 ? raw : ADB_PORT_DEFAULT };
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Reject once, destroy the socket, and stay idempotent under racing events. */
function makeSettler(sock: Socket) {
	let settled = false;
	return {
		get done() {
			return settled;
		},
		take(): boolean {
			if (settled) return false;
			settled = true;
			return true;
		},
		fail(reject: (e: Error) => void, error: Error): void {
			if (!this.take()) return;
			sock.destroy();
			reject(error);
		},
	};
}

// ======================= iOS: usbmux =================================

const USBMUX_HEADER_BYTES = 16;
const USBMUX_VERSION_PLIST = 1;
const USBMUX_REQUEST_PLIST = 8;

let usbmuxTag = 1;

function usbmuxRequest(fields: Record<string, string | number>): Buffer {
	const body = Object.entries(fields)
		.map(([key, value]) =>
			typeof value === "number"
				? `\t<key>${key}</key>\n\t<integer>${value}</integer>`
				: `\t<key>${key}</key>\n\t<string>${value}</string>`,
		)
		.join("\n");
	const payload = Buffer.from(
		`<?xml version="1.0" encoding="UTF-8"?>\n` +
			`<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
			`<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`,
		"utf8",
	);
	const header = Buffer.alloc(USBMUX_HEADER_BYTES);
	header.writeUInt32LE(USBMUX_HEADER_BYTES + payload.length, 0);
	header.writeUInt32LE(USBMUX_VERSION_PLIST, 4);
	header.writeUInt32LE(USBMUX_REQUEST_PLIST, 8);
	header.writeUInt32LE(usbmuxTag++, 12);
	return Buffer.concat([header, payload]);
}

const USBMUX_CLIENT = { ClientVersionString: "para", ProgName: "para" };

/**
 * usbmux expects PortNumber in network byte order, so 8765 goes out as 15650.
 * Skipping this yields a valid-looking `Number 3` ("port not open") reply that
 * sends you hunting the wrong problem entirely.
 */
function networkOrderPort(port: number): number {
	return ((port & 0xff) << 8) | ((port >> 8) & 0xff);
}

const USBMUX_RESULT_TEXT: Record<number, string> = {
	2: "device not connected",
	3: "port not open on device — is the instrumented app running?",
	5: "malformed usbmux request",
};

/** Split a usbmux byte stream into frames; returns bytes past the last frame. */
function usbmuxFramer(onPayload: (xml: string) => void): (chunk: Uint8Array | string) => Uint8Array {
	let buf = Buffer.alloc(0);
	return (chunk) => {
		buf = Buffer.concat([buf, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk)]);
		for (;;) {
			if (buf.length < USBMUX_HEADER_BYTES) break;
			const total = buf.readUInt32LE(0);
			if (total < USBMUX_HEADER_BYTES || buf.length < total) break;
			onPayload(buf.subarray(USBMUX_HEADER_BYTES, total).toString("utf8"));
			buf = buf.subarray(total);
		}
		return buf;
	};
}

// Narrow plist scraping: we need four scalar fields, not a general parser.
const plistString = (xml: string, key: string): string | null =>
	xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1] ?? null;

const plistInt = (xml: string, key: string): number | null => {
	const m = xml.match(new RegExp(`<key>${key}</key>\\s*<integer>(-?\\d+)</integer>`));
	return m ? Number.parseInt(m[1]!, 10) : null;
};

/**
 * Each device entry nests its fields in a `Properties` dict. Scrape those
 * blocks: DeviceID also appears at the entry's top level, so splitting on it
 * would tear ConnectionType and SerialNumber apart from their owner.
 */
function parseUsbmuxDevices(xml: string): { deviceId: number; udid: string; connection: string }[] {
	const out: { deviceId: number; udid: string; connection: string }[] = [];
	for (const match of xml.matchAll(/<key>Properties<\/key>\s*<dict>([\s\S]*?)<\/dict>/g)) {
		const props = match[1]!;
		const deviceId = plistInt(props, "DeviceID") ?? -1;
		const udid = plistString(props, "SerialNumber") ?? "";
		if (deviceId > 0 && udid) {
			out.push({ deviceId, udid, connection: plistString(props, "ConnectionType") ?? "" });
		}
	}
	return out;
}

function usbmuxListRaw(): Promise<{ deviceId: number; udid: string; connection: string }[]> {
	return new Promise((resolve, reject) => {
		let sock: Socket;
		try {
			sock = connect(usbmuxAddress());
		} catch (e) {
			reject(new DeviceUnavailable(`cannot reach usbmuxd: ${describe(e)}`));
			return;
		}
		const gate = makeSettler(sock);
		const timer = setTimeout(
			() => gate.fail(reject, new DeviceUnavailable("usbmuxd ListDevices timed out")),
			DISCOVERY_TIMEOUT_MS,
		);
		const feed = usbmuxFramer((xml) => {
			if (!gate.take()) return;
			clearTimeout(timer);
			const devices = parseUsbmuxDevices(xml);
			sock.end();
			resolve(devices);
		});
		sock.on("data", (chunk) => feed(chunk));
		sock.on("error", (e) => {
			clearTimeout(timer);
			if (gate.take()) reject(new DeviceUnavailable(`usbmuxd unavailable: ${describe(e)}`));
		});
		sock.on("close", () => {
			clearTimeout(timer);
			// A clean close before any frame means usbmuxd is up but said nothing.
			if (gate.take()) resolve([]);
		});
		sock.on("connect", () => sock.write(usbmuxRequest({ MessageType: "ListDevices", ...USBMUX_CLIENT })));
	});
}

async function listIosDevices(): Promise<DeviceInfo[]> {
	if (hooks?.listIos) return hooks.listIos();
	try {
		const raw = await usbmuxListRaw();
		return raw.map((d) => ({
			id: d.udid,
			platform: "ios" as const,
			connection: d.connection || "USB",
			ready: true,
		}));
	} catch {
		// No usbmuxd (non-mac, daemon down) simply means no iOS devices.
		return [];
	}
}

/** Resolve a UDID to its current usbmux DeviceID handle. */
async function resolveUsbmuxDeviceId(udid: string): Promise<number> {
	const raw = await usbmuxListRaw();
	const wanted = udid.trim();
	const found = wanted ? raw.find((d) => d.udid === wanted) : raw[0];
	if (!found) {
		throw new DeviceUnavailable(
			wanted ? `iOS device ${wanted} is not connected` : "no iOS device connected",
		);
	}
	return found.deviceId;
}

/**
 * Open a socket to `port` on an iOS device. On success the same connection stops
 * being a usbmux control channel and becomes a raw pipe to the device port.
 */
async function dialIos(udid: string, port: number): Promise<Socket> {
	const deviceId = await resolveUsbmuxDeviceId(udid);
	return new Promise((resolve, reject) => {
		const sock = connect(usbmuxAddress());
		const gate = makeSettler(sock);
		let leftover: Uint8Array = Buffer.alloc(0);
		const timer = setTimeout(
			() => gate.fail(reject, new DeviceUnavailable(`usbmux Connect to port ${port} timed out`)),
			DIAL_TIMEOUT_MS,
		);
		const feed = usbmuxFramer((xml) => {
			if (gate.done) return;
			if (plistString(xml, "MessageType") !== "Result") return;
			if (!gate.take()) return;
			clearTimeout(timer);
			const code = plistInt(xml, "Number") ?? -1;
			if (code !== 0) {
				sock.destroy();
				reject(new DeviceUnavailable(`usbmux Connect failed: ${USBMUX_RESULT_TEXT[code] ?? `code ${code}`}`));
				return;
			}
			sock.removeAllListeners("data");
			// Bytes past the Result frame already belong to the device.
			if (leftover.length) sock.unshift(Buffer.from(leftover));
			resolve(sock);
		});
		sock.on("data", (chunk) => {
			leftover = feed(chunk);
		});
		sock.on("error", (e) => {
			clearTimeout(timer);
			if (gate.take()) reject(new DeviceUnavailable(`usbmux Connect failed: ${describe(e)}`));
		});
		sock.on("connect", () =>
			sock.write(
				usbmuxRequest({
					MessageType: "Connect",
					...USBMUX_CLIENT,
					DeviceID: deviceId,
					PortNumber: networkOrderPort(port),
				}),
			),
		);
	});
}

// ======================= Android: adb ================================

/** adb frames every request with a 4-hex-digit length prefix. */
const adbFrame = (payload: string): string => payload.length.toString(16).padStart(4, "0") + payload;

/** Send a request and await its OKAY/FAIL verdict, leaving the socket open. */
function adbRequest(sock: Socket, payload: string, timeoutMs = DIAL_TIMEOUT_MS): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		let buf = Buffer.alloc(0);
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			sock.off("data", onData);
			fn();
		};
		const timer = setTimeout(() => {
			finish(() => reject(new DeviceUnavailable(`adb ${payload} timed out`)));
		}, timeoutMs);

		const onData = (chunk: Uint8Array) => {
			if (settled) return;
			buf = Buffer.concat([buf, Buffer.from(chunk)]);
			if (buf.length < 4) return;
			const verdict = buf.subarray(0, 4).toString("ascii");
			if (verdict === "OKAY") {
				const rest = buf.subarray(4);
				finish(() => resolve(rest));
				return;
			}
			if (verdict === "FAIL") {
				// FAIL is followed by a 4-hex length and a reason string.
				if (buf.length < 8) return;
				const len = Number.parseInt(buf.subarray(4, 8).toString("ascii"), 16);
				if (!Number.isFinite(len) || buf.length < 8 + len) return;
				const reason = buf.subarray(8, 8 + len).toString("utf8");
				finish(() => reject(new DeviceUnavailable(`adb: ${reason}`)));
				return;
			}
			const seen = JSON.stringify(verdict);
			finish(() => reject(new DeviceUnavailable(`adb: unexpected reply ${seen}`)));
		};

		sock.on("data", onData);
		sock.once("error", (e) => {
			finish(() => reject(new DeviceUnavailable(`adb server unreachable: ${describe(e)}`)));
		});
		sock.write(adbFrame(payload));
	});
}

/** Read one length-prefixed payload, seeded with bytes already buffered. */
function adbPayload(sock: Socket, seed: Uint8Array, timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<string> {
	return new Promise((resolve, reject) => {
		let buf = Buffer.from(seed);
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		const timer = setTimeout(() => finish(() => reject(new DeviceUnavailable("adb payload timed out"))), timeoutMs);
		const tryParse = (): boolean => {
			if (buf.length < 4) return false;
			const len = Number.parseInt(buf.subarray(0, 4).toString("ascii"), 16);
			if (!Number.isFinite(len) || buf.length < 4 + len) return false;
			const text = buf.subarray(4, 4 + len).toString("utf8");
			finish(() => resolve(text));
			return true;
		};
		if (tryParse()) return;
		sock.on("data", (chunk) => {
			buf = Buffer.concat([buf, Buffer.from(chunk)]);
			tryParse();
		});
		sock.on("error", (e) => finish(() => reject(new DeviceUnavailable(describe(e)))));
		// An empty device list closes without a payload.
		sock.on("close", () => finish(() => resolve("")));
	});
}

/**
 * Parse the long device format shared by `host:devices-l` and
 * `host:track-devices-l`: `serial<ws>state<ws>key:value…` per line.
 */
export function parseAdbDeviceLines(text: string): DeviceInfo[] {
	const out: DeviceInfo[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const parts = trimmed.split(/\s+/);
		const serial = parts[0] ?? "";
		const state = parts[1] ?? "";
		if (!serial || !state) continue;
		const model = parts.find((p) => p.startsWith("model:"))?.slice("model:".length);
		out.push({
			id: serial,
			platform: "android",
			connection: state,
			model: model || undefined,
			// `unauthorized` / `offline` devices are listed but cannot be driven.
			ready: state === "device",
		});
	}
	return out;
}

function openAdb(): Socket {
	const { host, port } = adbEndpoint();
	return connect(port, host);
}

async function listAndroidDevices(): Promise<DeviceInfo[]> {
	if (hooks?.listAndroid) return hooks.listAndroid();
	let sock: Socket;
	try {
		sock = openAdb();
	} catch {
		return [];
	}
	try {
		const rest = await adbRequest(sock, "host:devices-l", DISCOVERY_TIMEOUT_MS);
		return parseAdbDeviceLines(await adbPayload(sock, rest));
	} catch {
		// No adb server running means no Android devices, not a hard failure.
		return [];
	} finally {
		sock.destroy();
	}
}

/**
 * Open a socket to `port` on an Android device: bind the connection to a
 * transport, then request the port. This is what `adb forward` does internally,
 * minus the local listener — so there is no forward entry to leak or reclaim.
 */
async function dialAndroid(serial: string, port: number): Promise<Socket> {
	const sock = openAdb();
	try {
		const target = serial.trim();
		await adbRequest(sock, target ? `host:transport:${target}` : "host:transport-any");
		const rest = await adbRequest(sock, `tcp:${port}`);
		if (rest.length) sock.unshift(Buffer.from(rest));
		return sock;
	} catch (e) {
		sock.destroy();
		throw e;
	}
}

// ======================= unified surface =============================

/** Every connected device across both platforms, iOS first. */
export async function listDevices(): Promise<DeviceInfo[]> {
	const [ios, android] = await Promise.all([listIosDevices(), listAndroidDevices()]);
	return [...ios, ...android];
}

/** Devices that can actually be driven (paired / authorized). */
export async function listReadyDevices(): Promise<DeviceInfo[]> {
	return (await listDevices()).filter((d) => d.ready);
}

/**
 * Open a socket to `port` on `device`. Each call is independent: no local port
 * is bound, so concurrent dials to the same or different devices cannot
 * collide, and a dropped socket needs no teardown beyond closing it.
 */
export async function dialDevice(device: DeviceInfo, port = REMOTE_INSPECTOR_PORT): Promise<Socket> {
	if (hooks?.dial) return hooks.dial(device, port);
	return device.platform === "ios" ? dialIos(device.id, port) : dialAndroid(device.id, port);
}

/** Dial by id, resolving the platform from what is currently connected. */
export async function dialDeviceId(
	deviceId: string,
	port = REMOTE_INSPECTOR_PORT,
	platform?: DevicePlatform,
): Promise<Socket> {
	const wanted = deviceId.trim();
	if (wanted && platform) return dialDevice({ id: wanted, platform, connection: "", ready: true }, port);

	const devices = await listDevices();
	const ready = devices.filter((d) => d.ready);
	if (!wanted) {
		if (ready.length === 1) return dialDevice(ready[0]!, port);
		if (ready.length === 0) throw new DeviceUnavailable(describeNoDevices(devices));
		throw new DeviceUnavailable(
			`连接了多台设备，请用 --device 指定其一：\n${ready.map((d) => `  - ${d.id}`).join("\n")}`,
		);
	}
	const match = devices.find((d) => d.id === wanted);
	if (!match) {
		const listed = ready.map((d) => `  - ${d.id}`).join("\n") || "  （无）";
		throw new DeviceUnavailable(`未找到设备 ${wanted}。当前可选设备：\n${listed}`);
	}
	if (!match.ready) {
		throw new DeviceUnavailable(
			`设备 ${wanted} 状态为 ${match.connection}，无法连接（Android 需授权 USB 调试；iOS 需解锁并信任此电脑）。`,
		);
	}
	return dialDevice(match, port);
}

/** Explain an empty ready-set, distinguishing "none" from "none usable". */
export function describeNoDevices(devices: readonly DeviceInfo[]): string {
	const blocked = devices.filter((d) => !d.ready);
	if (!blocked.length) return "未发现已连接设备（USB iOS 或 adb Android）。请连接设备后重试。";
	const listed = blocked.map((d) => `  - ${d.id} (${d.connection})`).join("\n");
	return `发现设备但均不可用，请解锁设备并确认信任/授权：\n${listed}`;
}
