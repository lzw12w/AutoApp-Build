/**
 * Resolve a `--device` selector to a concrete device.
 *
 * Formerly this also allocated a distinct *local* port per device (8765, 8766, …)
 * and persisted the mapping under ~/.para/locks, because every device's
 * inspector listens on the same remote port and a forwarded localhost port is a
 * shared resource. Para now dials devices directly (ios-runtime/device-broker.ts),
 * so there is no local port to hand out and no registry, lock file, ownership
 * check or reclamation left to do — routing is just "which device did the user
 * mean", and the answer is a UDID / adb serial.
 */
import type { ParaConfig } from "../config.ts";
import {
	type DeviceInfo,
	type DevicePlatform,
	REMOTE_INSPECTOR_PORT,
	describeNoDevices,
	listDevices,
} from "./device-broker.ts";

export { REMOTE_INSPECTOR_PORT };

export class DeviceResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DeviceResolutionError";
	}
}

export interface DeviceRoute {
	deviceId: string;
	platform: DevicePlatform;
	identifier: string;
	/** On-device inspector port. Kept for config/env compatibility. */
	remotePort: number;
}

export function applyRoute(cfg: ParaConfig, route: DeviceRoute): void {
	cfg.inspectorDevice = route.deviceId;
	cfg.inspectorRemotePort = route.remotePort;
	cfg.inspectorPlatform = route.platform;
}

export interface RegistryHooks {
	listDevices?: () => Promise<DeviceInfo[]> | DeviceInfo[];
}

let testHooks: RegistryHooks | null = null;

export function setRegistryTestHooks(hooks: RegistryHooks | null): void {
	testHooks = hooks;
}

async function discover(): Promise<DeviceInfo[]> {
	return testHooks?.listDevices ? testHooks.listDevices() : listDevices();
}

/**
 * Pick the device the user meant. With no selector and exactly one usable
 * device, that device wins; otherwise the ambiguity is reported rather than
 * guessed, since driving the wrong phone is worse than an error.
 */
export async function resolveDeviceRoute(
	selector: string | null | undefined,
	options: { missingOk?: boolean } = {},
): Promise<DeviceRoute | null> {
	const devices = await discover();
	const ready = devices.filter((d) => d.ready);
	const wanted = (selector ?? "").trim();

	let chosen: DeviceInfo;
	if (!wanted) {
		if (ready.length === 1) {
			chosen = ready[0]!;
		} else if (ready.length === 0) {
			if (options.missingOk) return null;
			throw new DeviceResolutionError(describeNoDevices(devices));
		} else {
			const listed = ready.map((d) => `  - ${d.id}`).join("\n");
			throw new DeviceResolutionError(`连接了多台设备，请用 --device 指定其一：\n${listed}`);
		}
	} else {
		const match = devices.find((d) => d.id === wanted);
		if (!match) {
			const listed = ready.map((d) => `  - ${d.id}`).join("\n") || "  （无）";
			throw new DeviceResolutionError(`未找到设备 ${wanted}。当前可选设备：\n${listed}`);
		}
		if (!match.ready) {
			throw new DeviceResolutionError(
				`设备 ${wanted} 状态为 ${match.connection}，无法连接（Android 需授权 USB 调试；iOS 需解锁并信任此电脑）。`,
			);
		}
		chosen = match;
	}

	return {
		deviceId: chosen.id,
		platform: chosen.platform,
		identifier: chosen.id,
		remotePort: REMOTE_INSPECTOR_PORT,
	};
}

/** Bind cfg.inspectorDevice (or the sole connected device) onto cfg. Error string or null. */
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
