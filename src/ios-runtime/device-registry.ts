/**
 * Resolve a --device selector to a stable local inspector port.
 *
 * Every device's inspector listens on the same remote port (8765). Several
 * devices get distinct local ports (8765, 8766, …) persisted in
 * ~/.para/locks/device_ports.json so a later `para exec` lands on
 * the same tunnel. Ported from ios_inspector_agent/ios_runtime/device_registry.py.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ParaConfig } from "../config.ts";
import {
	heldInspectorPorts,
	inspectorReachable,
	listAdbSerials,
	listUsbIdentifiers,
	localPortHeldByUs,
	reclaimLocalPort,
} from "./tunnel.ts";

export const REMOTE_INSPECTOR_PORT = 8765;
export const LOCAL_PORT_BASE = 8765;
const LOCAL_PORT_SCAN_LIMIT = 200;

export class DeviceResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DeviceResolutionError";
	}
}

export interface DeviceRoute {
	deviceId: string;
	platform: "ios" | "android";
	identifier: string;
	localPort: number;
	remotePort: number;
}

export function applyRoute(cfg: ParaConfig, route: DeviceRoute): void {
	cfg.inspectorDevice = route.deviceId;
	cfg.inspectorPort = route.localPort;
	cfg.inspectorRemotePort = route.remotePort;
	cfg.inspectorPlatform = route.platform;
}

export interface RegistryHooks {
	listIos?: () => string[];
	listAndroid?: () => string[];
	portIsFree?: (port: number) => boolean | Promise<boolean>;
	portOwnedByUs?: (port: number, identifier: string, platform: string) => boolean;
	portAnswersInspector?: (port: number) => boolean | Promise<boolean>;
	reclaimPort?: (port: number, identifier: string, platform?: string) => boolean | Promise<boolean>;
	heldPorts?: () => Record<number, string>;
}

let testHooks: RegistryHooks | null = null;

export function setRegistryTestHooks(hooks: RegistryHooks | null): void {
	testHooks = hooks;
}

function registryPath(): string {
	const override = (process.env.INSPECTOR_LOCK_ROOT || process.env.PARA_LOCK_ROOT || "").trim();
	if (override) return join(override, "device_ports.json");
	return join(homedir(), ".para", "locks", "device_ports.json");
}

function listIos(): string[] {
	return testHooks?.listIos ? testHooks.listIos() : listUsbIdentifiers();
}

function listAndroid(): string[] {
	return testHooks?.listAndroid ? testHooks.listAndroid() : listAdbSerials();
}

interface Connected {
	ios: string[];
	android: string[];
}

function discover(): Connected {
	return { ios: listIos(), android: listAndroid() };
}

function platformOf(devices: Connected, deviceId: string): "ios" | "android" | null {
	if (devices.ios.includes(deviceId)) return "ios";
	if (devices.android.includes(deviceId)) return "android";
	return null;
}

function allIds(devices: Connected): string[] {
	return [...devices.ios, ...devices.android];
}

async function portIsFree(port: number): Promise<boolean> {
	if (testHooks?.portIsFree) return testHooks.portIsFree(port);
	return new Promise((resolve) => {
		const server = createServer();
		server.once("error", () => resolve(false));
		server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
			server.close(() => resolve(true));
		});
	});
}

function portOwnedByUs(port: number, identifier: string, platform: string): boolean {
	if (testHooks?.portOwnedByUs) return testHooks.portOwnedByUs(port, identifier, platform);
	return localPortHeldByUs(port, identifier, platform);
}

async function portAnswersInspector(port: number): Promise<boolean> {
	if (testHooks?.portAnswersInspector) return testHooks.portAnswersInspector(port);
	return inspectorReachable(port);
}

async function reclaimPort(port: number, identifier: string, platform = ""): Promise<boolean> {
	if (testHooks?.reclaimPort) return testHooks.reclaimPort(port, identifier, platform);
	return reclaimLocalPort(port, identifier, platform);
}

function heldPorts(): Record<number, string> {
	return testHooks?.heldPorts ? testHooks.heldPorts() : heldInspectorPorts();
}

function loadRegistry(path: string): Record<string, number> {
	if (!existsSync(path)) return {};
	try {
		const data: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!data || typeof data !== "object" || Array.isArray(data)) return {};
		const result: Record<string, number> = {};
		for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
			if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535) {
				result[key] = value;
			}
		}
		return result;
	} catch {
		return {};
	}
}

function writeRegistry(path: string, mapping: Record<string, number>): void {
	const ordered = Object.fromEntries(Object.keys(mapping).sort().map((k) => [k, mapping[k]!]));
	writeFileSync(path, JSON.stringify(ordered), { encoding: "utf8", mode: 0o600 });
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function acquireLock(lockPath: string): Promise<number> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		try {
			const fd = openSync(lockPath, "wx", 0o600);
			writeSync(fd, String(process.pid));
			return fd;
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw e;
			try {
				const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
				if (Number.isFinite(pid) && !pidAlive(pid)) unlinkSync(lockPath);
			} catch {
				try {
					unlinkSync(lockPath);
				} catch {
					// still locked
				}
			}
			await new Promise<void>((r) => setTimeout(r, 50));
		}
	}
	throw new DeviceResolutionError("device port registry is busy (lock timeout)");
}

async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
	mkdirSync(dirname(path), { recursive: true });
	const fd = await acquireLock(`${path}.lock`);
	try {
		return await fn();
	} finally {
		closeSync(fd);
		try {
			unlinkSync(`${path}.lock`);
		} catch {
			// best-effort
		}
	}
}

async function syncMapping(mapping: Record<string, number>, liveIds: Set<string>): Promise<boolean> {
	let changed = false;
	const held = heldPorts();

	for (const [deviceId, port] of Object.entries(mapping)) {
		if (liveIds.has(deviceId)) continue;
		if (await portIsFree(port)) {
			delete mapping[deviceId];
			changed = true;
			continue;
		}
		if (await portAnswersInspector(port)) continue;
		if ((await reclaimPort(port, deviceId)) || (await portIsFree(port))) {
			delete mapping[deviceId];
			changed = true;
		}
	}

	const mapped = new Set(Object.values(mapping));
	for (const [portText, ident] of Object.entries(held)) {
		const port = Number(portText);
		if (mapped.has(port)) continue;
		await reclaimPort(port, ident);
	}
	return changed;
}

async function portIsReusable(port: number, identifier: string, platform: string): Promise<boolean> {
	if (await portIsFree(port)) return true;
	return portOwnedByUs(port, identifier, platform);
}

async function assignLocalPort(deviceId: string, platform: string, liveIds: Set<string>): Promise<number> {
	const path = registryPath();
	return withLock(path, async () => {
		const mapping = loadRegistry(path);
		let dirty = await syncMapping(mapping, liveIds);
		const skip = new Set<number>();

		const existing = mapping[deviceId];
		if (existing !== undefined) {
			if (await portIsReusable(existing, deviceId, platform)) {
				if (dirty) writeRegistry(path, mapping);
				return existing;
			}
			delete mapping[deviceId];
			dirty = true;
			if (!(await portIsFree(existing))) skip.add(existing);
		}

		const taken = new Set([...Object.values(mapping), ...skip]);
		for (let offset = 0; offset < LOCAL_PORT_SCAN_LIMIT; offset++) {
			const candidate = LOCAL_PORT_BASE + offset;
			if (taken.has(candidate)) continue;
			if (!(await portIsFree(candidate))) continue;
			mapping[deviceId] = candidate;
			writeRegistry(path, mapping);
			return candidate;
		}
		throw new DeviceResolutionError(
			`无法为设备 ${deviceId} 分配本地端口（${LOCAL_PORT_BASE}~${LOCAL_PORT_BASE + LOCAL_PORT_SCAN_LIMIT - 1} 均不可用）。`,
		);
	});
}

export async function resolveDeviceRoute(
	selector: string | null | undefined,
	options: { missingOk?: boolean } = {},
): Promise<DeviceRoute | null> {
	const devices = discover();
	const wanted = (selector ?? "").trim();
	let deviceId: string;

	if (!wanted) {
		const ids = allIds(devices);
		if (ids.length === 1) {
			deviceId = ids[0]!;
		} else if (ids.length === 0) {
			if (options.missingOk) return null;
			throw new DeviceResolutionError("未发现已连接设备（USB iOS 或 adb Android）。请连接设备后重试。");
		} else {
			const listed = ids.map((item) => `  - ${item}`).join("\n");
			throw new DeviceResolutionError(`连接了多台设备，请用 --device 指定其一：\n${listed}`);
		}
	} else {
		deviceId = wanted;
	}

	const platform = platformOf(devices, deviceId);
	if (!platform) {
		const listed = allIds(devices).map((item) => `  - ${item}`).join("\n") || "  （无）";
		throw new DeviceResolutionError(`未找到设备 ${deviceId}。当前可选设备：\n${listed}`);
	}

	const localPort = await assignLocalPort(deviceId, platform, new Set(allIds(devices)));
	return {
		deviceId,
		platform,
		identifier: deviceId,
		localPort,
		remotePort: REMOTE_INSPECTOR_PORT,
	};
}

/** Bind cfg.inspectorDevice (or the sole plugged-in device) onto cfg. Error string or null. */
export async function resolveIntoConfig(
	cfg: ParaConfig,
	options: { missingOk?: boolean } = {},
): Promise<string | null> {
	const selector = cfg.inspectorDevice;
	try {
		const route = await resolveDeviceRoute(selector, {
			missingOk: Boolean(options.missingOk && !selector.trim()),
		});
		if (route) applyRoute(cfg, route);
		return null;
	} catch (e) {
		if (e instanceof DeviceResolutionError) return e.message;
		throw e;
	}
}
