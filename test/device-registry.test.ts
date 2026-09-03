import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type ParaConfig } from "../src/config.ts";
import {
	DeviceResolutionError,
	LOCAL_PORT_BASE,
	REMOTE_INSPECTOR_PORT,
	applyRoute,
	resolveDeviceRoute,
	resolveIntoConfig,
	setRegistryTestHooks,
	type DeviceRoute,
	type RegistryHooks,
} from "../src/ios-runtime/device-registry.ts";

const savedLockRoot = process.env.INSPECTOR_LOCK_ROOT;
let lockRoot: string | undefined;

function blankCfg(): ParaConfig {
	return loadConfig({ tomlPath: "/this/does/not/exist.toml", env: {} });
}

function useRegistry(hooks: RegistryHooks = {}): void {
	lockRoot = mkdtempSync(join(tmpdir(), "para-device-ports-"));
	process.env.INSPECTOR_LOCK_ROOT = lockRoot;
	setRegistryTestHooks({
		listIos: () => [],
		listAndroid: () => [],
		portIsFree: () => true,
		portOwnedByUs: () => false,
		portAnswersInspector: () => false,
		reclaimPort: () => true,
		heldPorts: () => ({}),
		...hooks,
	});
}

afterEach(() => {
	setRegistryTestHooks(null);
	if (savedLockRoot === undefined) delete process.env.INSPECTOR_LOCK_ROOT;
	else process.env.INSPECTOR_LOCK_ROOT = savedLockRoot;
	if (lockRoot) {
		rmSync(lockRoot, { recursive: true, force: true });
		lockRoot = undefined;
	}
});

describe("resolveDeviceRoute", () => {
	test("single device with no selector is used", async () => {
		useRegistry({ listIos: () => ["UDID-ONLY"] });
		const route = await resolveDeviceRoute(null);
		expect(route).toEqual({
			deviceId: "UDID-ONLY",
			platform: "ios",
			identifier: "UDID-ONLY",
			localPort: LOCAL_PORT_BASE,
			remotePort: REMOTE_INSPECTOR_PORT,
		});
	});

	test("multiple devices without selector errors", async () => {
		useRegistry({ listIos: () => ["UDID-A"], listAndroid: () => ["SER-B"] });
		await expect(resolveDeviceRoute(null)).rejects.toThrow(DeviceResolutionError);
		await expect(resolveDeviceRoute(null)).rejects.toThrow(/UDID-A/);
		await expect(resolveDeviceRoute(null)).rejects.toThrow(/SER-B/);
	});

	test("unknown selector errors with choices", async () => {
		useRegistry({ listIos: () => ["UDID-A"] });
		await expect(resolveDeviceRoute("NOPE")).rejects.toThrow(/UDID-A/);
	});

	test("two devices get distinct ports", async () => {
		useRegistry({ listIos: () => ["UDID-A"], listAndroid: () => ["SER-B"] });
		const a = await resolveDeviceRoute("UDID-A");
		const b = await resolveDeviceRoute("SER-B");
		expect(a?.platform).toBe("ios");
		expect(b?.platform).toBe("android");
		expect(a?.localPort).not.toBe(b?.localPort);
	});

	test("same device reuses port", async () => {
		useRegistry({ listIos: () => ["UDID-A"] });
		const first = await resolveDeviceRoute("UDID-A");
		const second = await resolveDeviceRoute("UDID-A");
		expect(first?.localPort).toBe(second?.localPort);
	});

	test("occupied existing port is reassigned", async () => {
		const occupied = new Set<number>();
		useRegistry({
			listIos: () => ["UDID-A"],
			portIsFree: (port) => !occupied.has(port),
		});
		const first = await resolveDeviceRoute("UDID-A");
		expect(first?.localPort).toBe(LOCAL_PORT_BASE);
		occupied.add(first!.localPort);
		const second = await resolveDeviceRoute("UDID-A");
		expect(second?.localPort).not.toBe(first?.localPort);
		expect(second?.localPort).toBe(first!.localPort + 1);
	});

	test("disconnected device port is recycled", async () => {
		useRegistry({ listIos: () => ["UDID-A"] });
		const first = await resolveDeviceRoute("UDID-A");
		expect(first?.localPort).toBe(LOCAL_PORT_BASE);

		setRegistryTestHooks({
			listIos: () => [],
			listAndroid: () => ["SER-B"],
			portIsFree: () => true,
			portOwnedByUs: () => false,
			portAnswersInspector: () => false,
			reclaimPort: () => true,
			heldPorts: () => ({}),
		});
		const second = await resolveDeviceRoute("SER-B");
		expect(second?.localPort).toBe(first?.localPort);
		expect(second?.platform).toBe("android");
	});

	test("missingOk returns null when nothing plugged in", async () => {
		useRegistry();
		expect(await resolveDeviceRoute(null, { missingOk: true })).toBeNull();
		await expect(resolveDeviceRoute(null)).rejects.toThrow(DeviceResolutionError);
	});
});

describe("resolveIntoConfig", () => {
	test("binds the sole plugged-in device", async () => {
		useRegistry({ listIos: () => ["UDID-ONLY"] });
		const cfg = blankCfg();
		expect(await resolveIntoConfig(cfg, { missingOk: true })).toBeNull();
		expect(cfg.inspectorDevice).toBe("UDID-ONLY");
		expect(cfg.inspectorPort).toBe(LOCAL_PORT_BASE);
		expect(cfg.inspectorRemotePort).toBe(REMOTE_INSPECTOR_PORT);
		expect(cfg.inspectorPlatform).toBe("ios");
	});

	test("leaves historical port when nothing is plugged in", async () => {
		useRegistry();
		const cfg = blankCfg();
		cfg.inspectorPort = 18765;
		expect(await resolveIntoConfig(cfg, { missingOk: true })).toBeNull();
		expect(cfg.inspectorPort).toBe(18765);
		expect(cfg.inspectorDevice).toBe("");
	});
});

describe("applyRoute", () => {
	test("copies route onto config", () => {
		const cfg = blankCfg();
		const route: DeviceRoute = {
			deviceId: "SER-B",
			platform: "android",
			identifier: "SER-B",
			localPort: 8767,
			remotePort: 8765,
		};
		applyRoute(cfg, route);
		expect(cfg.inspectorDevice).toBe("SER-B");
		expect(cfg.inspectorPort).toBe(8767);
		expect(cfg.inspectorPlatform).toBe("android");
		expect(cfg.inspectorRemotePort).toBe(8765);
	});
});
