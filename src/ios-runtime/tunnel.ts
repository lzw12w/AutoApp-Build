/**
 * Keep the localhost inspector port reachable by owning one USB port-forward.
 *
 * Ported from ios_inspector_agent/ios_runtime/inspector_tunnel.py.
 * iOS: spawn `iproxy` (libimobiledevice). Android: `adb forward` — the adb
 * daemon owns the listener, we do not keep a child process.
 *
 * Health is HTTP `/api/ping`, not TCP. A zombie tunnel accepts then resets;
 * when we own that listener we tear it down and rebuild. A foreign process
 * is never touched — reported as `occupied`.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const INSPECTOR_REMOTE_DEFAULT = 8765;

export type TunnelPlatform = "ios" | "android";

export interface TunnelStatus {
	ok: boolean;
	action: "started" | "reused" | "occupied" | "skipped" | "failed" | "none";
	detail: string;
	pid?: number;
}

export interface AdbForward {
	serial: string;
	localPort: number;
	remotePort: number;
}

export type AdbExec = (args: string[]) => { status: number | null; stdout: string; stderr: string };

export interface EnsureTunnelOptions {
	host?: string;
	/** Local port callers connect to. */
	port: number;
	/** On-device inspector port. Android defaults to 8765; iOS defaults to `port`. */
	remotePort?: number;
	/** UDID (iOS) or adb serial (Android). Empty: single-device heuristic. */
	identifier?: string;
	/** `ios` / `android`. Empty/`auto`: infer from identifier and plugged-in devices. */
	platform?: string;
	/** Whether to spawn a tunnel when none exists. Defaults to PARA_AUTO_TUNNEL. */
	start?: boolean;
	/** Require /api/ping to answer, not just TCP open. Defaults true. */
	requireHealthy?: boolean;
}

interface TunnelTestHooks {
	adbPath?: string | null;
	adbExec?: AdbExec;
	portIsOpen?: (host: string, port: number) => boolean | Promise<boolean>;
	tunnelHealthy?: (port: number) => boolean | Promise<boolean>;
	usbIdentifiers?: string[];
}

let testHooks: TunnelTestHooks | null = null;

/** Test seam. Pass `null` to restore production I/O. */
export function setTunnelTestHooks(hooks: TunnelTestHooks | null): void {
	testHooks = hooks;
}

export function autoTunnelEnabled(): boolean {
	const raw = (process.env.PARA_AUTO_TUNNEL ?? "1").trim().toLowerCase();
	return !["0", "false", "no", "off"].includes(raw);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function describe(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Resolve the iproxy binary path, or "iproxy" as a bare fallback. */
export function resolveIproxy(): string | null {
	const which = spawnSync("which", ["iproxy"], { encoding: "utf8", timeout: 3000 });
	if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
	return null;
}

export function resolveAdb(): string | null {
	if (testHooks && "adbPath" in testHooks) return testHooks.adbPath ?? null;
	if (testHooks?.adbExec) return "/usr/bin/adb";
	const exe = process.platform === "win32" ? "adb.exe" : "adb";
	const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(homedir(), "Library/Android/sdk")];
	const candidates: string[] = [];
	for (const root of roots) {
		if (root) candidates.push(join(root, "platform-tools", exe));
	}
	const which = spawnSync("which", [exe], { encoding: "utf8", timeout: 3000 });
	if (which.status === 0 && which.stdout.trim()) candidates.push(which.stdout.trim());
	candidates.push(`/opt/homebrew/bin/${exe}`, `/usr/local/bin/${exe}`);
	for (const path of candidates) {
		if (path && existsSync(path)) return path;
	}
	return null;
}

function runAdb(args: string[], timeoutMs = 5000): { status: number | null; stdout: string; stderr: string } {
	if (testHooks?.adbExec) return testHooks.adbExec(args);
	const adb = resolveAdb();
	if (!adb) return { status: 127, stdout: "", stderr: "adb not found" };
	try {
		const result = spawnSync(adb, args, { encoding: "utf8", timeout: timeoutMs });
		return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	} catch (e) {
		return { status: 1, stdout: "", stderr: describe(e) };
	}
}

/** TCP-level check: is anything listening on the port? */
export function portIsOpen(host: string, port: number, timeoutMs = 150): Promise<boolean> {
	if (testHooks?.portIsOpen) return Promise.resolve(testHooks.portIsOpen(host, port));
	return new Promise((resolve) => {
		const socket = connect({ host, port });
		let settled = false;
		const done = (result: boolean) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(result);
		};
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}

/**
 * HTTP-level health: only true if the inspector actually answers /api/ping.
 * A zombie tunnel keeps the port open but resets real traffic. Loopback only.
 */
export async function tunnelHealthy(port: number, timeoutMs = 600): Promise<boolean> {
	if (testHooks?.tunnelHealthy) return Promise.resolve(testHooks.tunnelHealthy(port));
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const resp = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: controller.signal });
		if (resp.status < 200 || resp.status >= 300) return false;
		await resp.text();
		return true;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/** `/api/ping` reachability alias, matching the Python public name. */
export function inspectorReachable(port: number, timeoutMs = 600): Promise<boolean> {
	return tunnelHealthy(port, timeoutMs);
}

async function awaitHealthy(port: number): Promise<boolean> {
	// One shot under test hooks so mocked-unhealthy does not sleep 1.5s.
	const deadline = Date.now() + (testHooks?.tunnelHealthy ? 0 : 1500);
	for (;;) {
		if (await tunnelHealthy(port)) return true;
		if (Date.now() >= deadline) return false;
		await sleep(100);
	}
}

/** Build the iproxy argv: `iproxy L R [-u UDID]`. */
export function proxyProcessArgs(localPort: number, remotePort: number, identifier = ""): string[] {
	const args = [String(localPort), String(remotePort)];
	if (identifier) args.push("-u", identifier);
	return args;
}

export function parseAdbForwardPort(spec: string): number | null {
	const text = spec.trim();
	if (!text.startsWith("tcp:")) return null;
	const port = Number.parseInt(text.slice(4), 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
	return port;
}

/** `adb forward --list` → `{serial, localPort, remotePort}`. Ignores non-tcp specs. */
export function parseAdbForwardList(stdout: string): AdbForward[] {
	const forwards: AdbForward[] = [];
	for (const raw of stdout.split(/\r?\n/)) {
		const parts = raw.trim().split(/\s+/);
		if (parts.length < 3) continue;
		const localPort = parseAdbForwardPort(parts[1]!);
		const remotePort = parseAdbForwardPort(parts[2]!);
		if (localPort === null || remotePort === null) continue;
		forwards.push({ serial: parts[0]!, localPort, remotePort });
	}
	return forwards;
}

/** Serials in `adb devices` that are actually `device` (not unauthorized/offline). */
export function parseAdbDevices(stdout: string): string[] {
	const serials: string[] = [];
	for (const raw of stdout.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("List of devices")) continue;
		const parts = line.split(/\s+/);
		if (parts.length < 2) continue;
		const [serial, state] = parts;
		if (state === "device" && serial && !serials.includes(serial)) serials.push(serial);
	}
	return serials;
}

function adbForwards(): AdbForward[] {
	const result = runAdb(["forward", "--list"]);
	if (result.status !== 0) return [];
	return parseAdbForwardList(result.stdout);
}

function adbSerialForLocalPort(localPort: number): string | null {
	for (const row of adbForwards()) {
		if (row.localPort === localPort) return row.serial;
	}
	return null;
}

export function listAdbSerials(): string[] {
	const result = runAdb(["devices"], 2000);
	if (result.status !== 0) return [];
	return parseAdbDevices(result.stdout);
}

export function listUsbIdentifiers(): string[] {
	if (testHooks?.usbIdentifiers) return testHooks.usbIdentifiers;
	try {
		const result = spawnSync("idevice_id", ["-l"], { encoding: "utf8", timeout: 3000 });
		if (result.status !== 0 || typeof result.stdout !== "string") return [];
		return result.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * Pick ios vs android. Explicit platform wins. An identifier that is a live
 * adb serial is Android. No identifier + only Android plugged in → android.
 * Both plugged in with no identifier stays ios so we do not steal 8765.
 */
export function resolveTunnelPlatform(options: {
	platform?: string;
	identifier?: string;
	adbSerials?: readonly string[];
	usbIdentifiers?: readonly string[];
}): TunnelPlatform {
	const explicit = (options.platform ?? "").trim().toLowerCase();
	if (explicit === "android" || explicit === "ios") return explicit;
	const ident = (options.identifier ?? "").trim();
	const adbSerials = options.adbSerials ?? [];
	if (ident && adbSerials.includes(ident)) return "android";
	if (ident) return "ios";
	const usb = options.usbIdentifiers ?? [];
	if (adbSerials.length >= 1 && usb.length === 0) return "android";
	return "ios";
}

// ---- ownership detection (ps / adb) -----------------------------------

/** `(pid, command)` rows from `ps`. Best effort; empty on failure. */
function iterProxyProcesses(): [number, string][] {
	let result: ReturnType<typeof spawnSync>;
	try {
		result = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 3000 });
	} catch {
		return [];
	}
	if (result.status !== 0 || typeof result.stdout !== "string") return [];
	const rows: [number, string][] = [];
	for (const line of result.stdout.split("\n")) {
		const trimmed = line.trim();
		const sp = trimmed.indexOf(" ");
		if (sp <= 0) continue;
		const pidText = trimmed.slice(0, sp);
		const command = trimmed.slice(sp + 1);
		const pid = Number.parseInt(pidText, 10);
		if (Number.isNaN(pid) || !command) continue;
		rows.push([pid, command]);
	}
	return rows;
}

/** Extract iproxy `[local, remote, ...]` args from a ps command line. */
function proxyArgs(command: string): string[] | null {
	const parts = command.split(/\s+/).filter(Boolean);
	if (parts.length === 0) return null;
	const base = parts[0]!.split("/").pop();
	if (base === "iproxy") {
		const args = parts.slice(1);
		return args.length ? args : null;
	}
	return null;
}

function proxyIdentifier(args: string[]): string {
	for (const flag of ["-u", "--udid"]) {
		const idx = args.indexOf(flag);
		if (idx >= 0 && idx + 1 < args.length) return args[idx + 1]!;
	}
	return "";
}

/** Whether a ps command line is one of *our* iproxy proxies for this port. */
function proxyCommandMatches(command: string, localPort: number, identifier = ""): boolean {
	const args = proxyArgs(command);
	if (!args || args[0] !== String(localPort)) return false;
	const ident = identifier.trim();
	if (!ident) return true;
	return proxyIdentifier(args) === ident;
}

function matchingProxyPids(localPort: number, identifier = ""): number[] {
	return iterProxyProcesses()
		.filter(([, command]) => proxyCommandMatches(command, localPort, identifier))
		.map(([pid]) => pid);
}

function pidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** SIGTERM then SIGKILL each pid. Only ever called with our own proxies. */
async function killProxies(pids: number[]): Promise<void> {
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			continue;
		}
		const deadline = Date.now() + 500;
		while (Date.now() < deadline) {
			if (!pidExists(pid)) break;
			await sleep(50);
		}
		if (pidExists(pid)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
	}
}

function removeAdbForward(localPort: number, serial = ""): void {
	const local = `tcp:${localPort}`;
	const args = serial ? ["-s", serial, "forward", "--remove", local] : ["forward", "--remove", local];
	runAdb(args, 3000);
}

/**
 * True if Para owns the listener on `port` for this device.
 * iOS: our iproxy. Android: an adb forward whose serial matches `identifier`
 * (or any adb forward on that port when identifier is empty). `platform`
 * restricts which transport is consulted.
 */
export function localPortHeldByUs(port: number, identifier = "", platform = ""): boolean {
	const ident = identifier.trim();
	const kind = platform.trim().toLowerCase();
	if (kind !== "android" && matchingProxyPids(port, ident).length > 0) return true;
	if (kind !== "ios") {
		const serial = adbSerialForLocalPort(port);
		if (serial && (!ident || serial === ident)) return true;
	}
	return false;
}

/** Tear down our listener on `port` if we own it. Foreign processes are never killed. */
export async function reclaimLocalPort(port: number, identifier = "", platform = ""): Promise<boolean> {
	const ident = identifier.trim();
	const kind = platform.trim().toLowerCase();
	if (kind !== "android") {
		await killProxies(matchingProxyPids(port, ident));
	}
	if (kind !== "ios") {
		const serial = adbSerialForLocalPort(port);
		if (serial && (!ident || serial === ident)) removeAdbForward(port, serial);
	}
	const deadline = Date.now() + (testHooks ? 0 : 1000);
	while (Date.now() < deadline) {
		if (!(await portIsOpen("127.0.0.1", port))) return true;
		await sleep(50);
	}
	return !(await portIsOpen("127.0.0.1", port));
}

/** Best-effort description of who holds `port` (via lsof). */
function foreignPortHolder(port: number): string {
	const which = spawnSync("which", ["lsof"], { encoding: "utf8", timeout: 3000 });
	if (which.status !== 0 || !which.stdout.trim()) return "";
	const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
		encoding: "utf8",
		timeout: 3000,
	});
	if (typeof result.stdout !== "string") return "";
	const lines = result.stdout.split("\n").filter((l) => l.trim());
	if (lines.length < 2) return "";
	const fields = lines[1]!.split(/\s+/);
	if (fields.length >= 2) return `${fields[0]} (pid ${fields[1]})`;
	return lines[1]!.trim();
}

function singleUsbIdentifier(): string {
	const ids = listUsbIdentifiers();
	return ids.length === 1 ? ids[0]! : "";
}

// ---- spawn + ensure ---------------------------------------------------

async function startIosTunnel(
	localPort: number,
	remotePort: number,
	identifier: string,
	requireHealthy: boolean,
): Promise<TunnelStatus> {
	const iproxy = resolveIproxy();
	if (!iproxy) {
		return {
			ok: false,
			action: "failed",
			detail: "iproxy not found. Install libimobiledevice (brew install libimobiledevice).",
		};
	}
	const deviceIdentifier = identifier || singleUsbIdentifier();
	const args = proxyProcessArgs(localPort, remotePort, deviceIdentifier);

	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(iproxy, args, { stdio: "ignore", detached: true });
	} catch (e) {
		return { ok: false, action: "failed", detail: `could not start USB tunnel: ${describe(e)}` };
	}
	child.unref();

	let exited = false;
	child.once("exit", () => {
		exited = true;
	});

	const deadline = Date.now() + (requireHealthy ? 1500 : 800);
	while (Date.now() < deadline) {
		if (exited) {
			return { ok: false, action: "failed", detail: `USB tunnel exited immediately (pid=${child.pid})`, pid: child.pid };
		}
		if (requireHealthy) {
			if (await tunnelHealthy(localPort)) {
				return { ok: true, action: "started", detail: `started USB tunnel on 127.0.0.1:${localPort}`, pid: child.pid };
			}
		} else if (await portIsOpen("127.0.0.1", localPort)) {
			return { ok: true, action: "started", detail: `started USB tunnel on 127.0.0.1:${localPort}`, pid: child.pid };
		}
		await sleep(50);
	}
	if (!requireHealthy && !exited) {
		return { ok: true, action: "started", detail: `started USB tunnel on 127.0.0.1:${localPort}`, pid: child.pid };
	}
	return {
		ok: false,
		action: "failed",
		detail: `USB tunnel started (pid=${child.pid}) but 127.0.0.1:${localPort} inspector is unresponsive (USB backend may be dead)`,
		pid: child.pid,
	};
}

async function startAdbForward(
	localPort: number,
	remotePort: number,
	serial: string,
	requireHealthy: boolean,
): Promise<TunnelStatus> {
	if (!resolveAdb()) {
		return { ok: false, action: "failed", detail: "adb not found. Install Android platform-tools." };
	}
	if (!serial) {
		return { ok: false, action: "failed", detail: "Android tunnel needs an adb serial (--device / PARA_DEVICE_UDID)." };
	}
	const local = `tcp:${localPort}`;
	runAdb(["-s", serial, "forward", "--remove", local], 3000);
	const result = runAdb(["-s", serial, "forward", local, `tcp:${remotePort}`], 5000);
	if (result.status !== 0) {
		const detail = (result.stderr || result.stdout || "").trim() || "unknown error";
		return { ok: false, action: "failed", detail: `adb forward failed: ${detail}` };
	}
	const detail = `adb forward 127.0.0.1:${localPort} -> ${serial}:${remotePort}`;
	if (!requireHealthy) return { ok: true, action: "started", detail };
	if (await awaitHealthy(localPort)) return { ok: true, action: "started", detail };
	return {
		ok: false,
		action: "failed",
		detail: `adb forward is up but 127.0.0.1:${localPort} inspector is unresponsive`,
	};
}

function pickAndroidSerial(requested: string): { serial: string; error?: TunnelStatus } {
	if (requested) return { serial: requested };
	const serials = listAdbSerials();
	if (serials.length === 1) return { serial: serials[0]! };
	if (serials.length === 0) {
		return {
			serial: "",
			error: { ok: false, action: "failed", detail: "no Android device in `adb devices` (unauthorized/offline ignored)" },
		};
	}
	return {
		serial: "",
		error: {
			ok: false,
			action: "failed",
			detail: `several Android devices (${serials.join(", ")}); pass --device <serial>`,
		},
	};
}

/**
 * Make sure a local inspector port has a *usable* listener. See the module
 * docstring for the zombie-tunnel self-heal rationale.
 */
export async function ensureLocalInspectorTunnel(options: EnsureTunnelOptions): Promise<TunnelStatus> {
	const host = (options.host ?? "localhost").trim() || "localhost";
	const port = options.port;
	const ident = (options.identifier ?? "").trim();
	const requireHealthy = options.requireHealthy ?? true;

	if (!LOCAL_HOSTS.has(host)) {
		return { ok: true, action: "none", detail: "non-local inspector; no USB tunnel" };
	}

	const start = options.start ?? autoTunnelEnabled();

	const resolved = () => {
		const kind = resolveTunnelPlatform({
			platform: options.platform,
			identifier: ident,
			adbSerials: listAdbSerials(),
			usbIdentifiers: listUsbIdentifiers(),
		});
		const remote = options.remotePort ?? (kind === "android" ? INSPECTOR_REMOTE_DEFAULT : port);
		return { kind, remote };
	};

	const startFresh = async (): Promise<TunnelStatus> => {
		const { kind, remote } = resolved();
		if (kind === "android") {
			const picked = pickAndroidSerial(ident);
			if (picked.error) return picked.error;
			return startAdbForward(port, remote, picked.serial, requireHealthy);
		}
		return startIosTunnel(port, remote, ident, requireHealthy);
	};

	const occupied = (): TunnelStatus => {
		const holder = foreignPortHolder(port);
		const holderNote = holder ? `: ${holder}` : "";
		return {
			ok: false,
			action: "occupied",
			detail: `127.0.0.1:${port} is held by a foreign process${holderNote}; not a Para proxy, left untouched. Kill it or use a different port.`,
		};
	};

	if (await portIsOpen("127.0.0.1", port)) {
		const healthy = await tunnelHealthy(port);
		if (healthy && !ident) {
			return { ok: true, action: "reused", detail: `127.0.0.1:${port} already reachable and usable` };
		}
		const { kind } = resolved();
		const ours = localPortHeldByUs(port, ident, kind);
		if (ours && (healthy || !requireHealthy)) {
			return { ok: true, action: "reused", detail: `127.0.0.1:${port} already reachable and usable` };
		}
		if (!ours) return occupied();
		if (!start) {
			return { ok: false, action: "skipped", detail: `127.0.0.1:${port} tunnel is a zombie; auto-tunnel off, not rebuilt` };
		}
		await reclaimLocalPort(port, ident, kind);
		const status = await startFresh();
		if (status.ok) {
			return { ok: true, action: "started", detail: `detected zombie tunnel, cleared old proxy and rebuilt: ${status.detail}`, pid: status.pid };
		}
		return status;
	}

	if (!start) {
		return { ok: false, action: "skipped", detail: `127.0.0.1:${port} is closed and auto-tunnel is off` };
	}
	return startFresh();
}
