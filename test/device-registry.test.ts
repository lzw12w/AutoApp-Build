import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig, type ParaConfig } from "../src/config.ts";
import type { DeviceInfo } from "../src/ios-runtime/device-broker.ts";
import {
	DeviceResolutionError,
	REMOTE_INSPECTOR_PORT,
	applyRoute,
	resolveDeviceRoute,
	resolveIntoConfig,
	setRegistryTestHooks,
	type DeviceRoute,
} from "../src/ios-runtime/device-registry.ts";

function blankCfg(): ParaConfig {
	return loadConfig({ tomlPath: "/this/does/not/exist.toml", env: {} });
}

/** Shorthand for a usable device. */
function ios(id: string, ready = true): DeviceInfo {
	return { id, platform: "ios", connection: ready ? "USB" : "unpaired", ready };
}
function android(id: string, connection = "device"): DeviceInfo {
	return { id, platform: "android", connection, ready: connection === "device" };
}

function useDevices(...devices: DeviceInfo[]): void {
	setRegistryTestHooks({ listDevices: () => devices });
}

afterEach(() => {
	setRegistryTestHooks(null);
});

describe("resolveDeviceRoute", () => {
	test("single device needs no selector", async () => {
		useDevices(ios("UDID-A"));
		const route = await resolveDeviceRoute(null);
		expect(route).toEqual({
			deviceId: "UDID-A",
			platform: "ios",
			identifier: "UDID-A",
			remotePort: REMOTE_INSPECTOR_PORT,
		} satisfies DeviceRoute);
	});

	test("several devices demand an explicit selector", async () => {
		useDevices(ios("UDID-A"), android("SER-B"));
		await expect(resolveDeviceRoute(null)).rejects.toThrow(DeviceResolutionError);
		await expect(resolveDeviceRoute(null)).rejects.toThrow(/UDID-A/);
		await expect(resolveDeviceRoute(null)).rejects.toThrow(/SER-B/);
	});

	test("unknown selector lists what is available", async () => {
		useDevices(ios("UDID-A"));
		await expect(resolveDeviceRoute("NOPE")).rejects.toThrow(/UDID-A/);
	});

	test("platform comes from the device, not the selector spelling", async () => {
		useDevices(ios("UDID-A"), android("SER-B"));
		expect((await resolveDeviceRoute("UDID-A"))?.platform).toBe("ios");
		expect((await resolveDeviceRoute("SER-B"))?.platform).toBe("android");
	});

	test("resolution is stable across calls (no allocated state)", async () => {
		useDevices(ios("UDID-A"));
		const first = await resolveDeviceRoute("UDID-A");
		const second = await resolveDeviceRoute("UDID-A");
		expect(second).toEqual(first!);
	});

	test("every device targets the same on-device port", async () => {
		// The old design had to hand out distinct LOCAL ports; dialing does not,
		// so two devices legitimately share one remote port.
		useDevices(ios("UDID-A"), android("SER-B"));
		const a = await resolveDeviceRoute("UDID-A");
		const b = await resolveDeviceRoute("SER-B");
		expect(a?.remotePort).toBe(REMOTE_INSPECTOR_PORT);
		expect(b?.remotePort).toBe(REMOTE_INSPECTOR_PORT);
	});

	test("missingOk yields null with nothing connected", async () => {
		useDevices();
		expect(await resolveDeviceRoute(null, { missingOk: true })).toBeNull();
		await expect(resolveDeviceRoute(null)).rejects.toThrow(DeviceResolutionError);
	});

	test("an unauthorized Android device is reported, not silently used", async () => {
		useDevices(android("SER-B", "unauthorized"));
		// Not ready → not auto-selected even though it is the only device.
		await expect(resolveDeviceRoute(null)).rejects.toThrow(/unauthorized/);
		// Named explicitly → the reason is spelled out.
		await expect(resolveDeviceRoute("SER-B")).rejects.toThrow(/unauthorized/);
	});

	test("an unpaired iOS device is not auto-selected", async () => {
		useDevices(ios("UDID-A", false));
		await expect(resolveDeviceRoute(null)).rejects.toThrow(DeviceResolutionError);
	});

	test("one ready device wins over a blocked sibling", async () => {
		useDevices(ios("UDID-A"), android("SER-B", "offline"));
		expect((await resolveDeviceRoute(null))?.deviceId).toBe("UDID-A");
	});
});

describe("resolveIntoConfig", () => {
	test("returns null and leaves cfg alone when nothing is connected", async () => {
		useDevices();
		const cfg = blankCfg();
		expect(await resolveIntoConfig(cfg, { missingOk: true })).toBeNull();
		expect(cfg.inspectorDevice).toBe("");
	});

	test("binds the resolved device onto cfg", async () => {
		useDevices(android("SER-B"));
		const cfg = blankCfg();
		expect(await resolveIntoConfig(cfg)).toBeNull();
		expect(cfg.inspectorDevice).toBe("SER-B");
		expect(cfg.inspectorPlatform).toBe("android");
		expect(cfg.inspectorRemotePort).toBe(REMOTE_INSPECTOR_PORT);
	});

	test("returns the error message instead of throwing", async () => {
		useDevices(ios("UDID-A"), android("SER-B"));
		const cfg = blankCfg();
		const error = await resolveIntoConfig(cfg);
		expect(error).toMatch(/UDID-A/);
		expect(cfg.inspectorDevice).toBe("");
	});
});

describe("applyRoute", () => {
	test("copies route fields onto cfg", () => {
		const cfg = blankCfg();
		const route: DeviceRoute = {
			deviceId: "UDID-A",
			platform: "ios",
			identifier: "UDID-A",
			remotePort: REMOTE_INSPECTOR_PORT,
		};
		applyRoute(cfg, route);
		expect(cfg.inspectorDevice).toBe("UDID-A");
		expect(cfg.inspectorPlatform).toBe("ios");
		expect(cfg.inspectorRemotePort).toBe(REMOTE_INSPECTOR_PORT);
	});
});
