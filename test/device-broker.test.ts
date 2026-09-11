import { afterEach, describe, expect, test } from "bun:test";
import type { Socket } from "node:net";
import {
	type DeviceInfo,
	DeviceUnavailable,
	REMOTE_INSPECTOR_PORT,
	dialDevice,
	dialDeviceId,
	describeNoDevices,
	listDevices,
	listReadyDevices,
	parseAdbDeviceLines,
	setBrokerTestHooks,
} from "../src/ios-runtime/device-broker.ts";

afterEach(() => {
	setBrokerTestHooks(null);
});

function ios(id: string, ready = true): DeviceInfo {
	return { id, platform: "ios", connection: "USB", ready };
}

describe("parseAdbDeviceLines", () => {
	test("reads serial, state and model from the long format", () => {
		const devices = parseAdbDeviceLines(
			"3034369459001MH        device usb:34603008X product:PD2186 model:V2186A device:PD2186 transport_id:11\n",
		);
		expect(devices).toHaveLength(1);
		expect(devices[0]).toEqual({
			id: "3034369459001MH",
			platform: "android",
			connection: "device",
			model: "V2186A",
			ready: true,
		});
	});

	test("only state=device is ready", () => {
		const devices = parseAdbDeviceLines(
			["A device model:X", "B unauthorized", "C offline", "D device"].join("\n"),
		);
		expect(devices.map((d) => [d.id, d.ready])).toEqual([
			["A", true],
			["B", false],
			["C", false],
			["D", true],
		]);
	});

	test("blank lines and the header are ignored", () => {
		// `host:devices-l` payloads have no header, but be defensive anyway.
		expect(parseAdbDeviceLines("\n\n")).toEqual([]);
		const devices = parseAdbDeviceLines("A device\n\nB device\n");
		expect(devices.map((d) => d.id)).toEqual(["A", "B"]);
	});

	test("a device with no model reports undefined rather than empty string", () => {
		expect(parseAdbDeviceLines("A device")[0]!.model).toBeUndefined();
	});
});

describe("listDevices", () => {
	test("merges both platforms, iOS first", async () => {
		setBrokerTestHooks({
			listIos: () => [ios("UDID-A")],
			listAndroid: () => [{ id: "SER-B", platform: "android", connection: "device", ready: true }],
		});
		expect((await listDevices()).map((d) => d.platform)).toEqual(["ios", "android"]);
	});

	test("listReadyDevices filters out unusable devices", async () => {
		setBrokerTestHooks({
			listIos: () => [ios("UDID-A"), ios("UDID-B", false)],
			listAndroid: () => [{ id: "SER-C", platform: "android", connection: "unauthorized", ready: false }],
		});
		expect((await listReadyDevices()).map((d) => d.id)).toEqual(["UDID-A"]);
	});
});

describe("dialDeviceId", () => {
	const stub = { destroy: () => {} } as unknown as Socket;

	test("no selector dials the sole ready device", async () => {
		let dialed: DeviceInfo | null = null;
		setBrokerTestHooks({
			listIos: () => [ios("UDID-A")],
			listAndroid: () => [],
			dial: async (device) => {
				dialed = device;
				return stub;
			},
		});
		await dialDeviceId("", REMOTE_INSPECTOR_PORT);
		expect(dialed!.id).toBe("UDID-A");
	});

	test("several ready devices demand a selector", async () => {
		setBrokerTestHooks({
			listIos: () => [ios("UDID-A")],
			listAndroid: () => [{ id: "SER-B", platform: "android", connection: "device", ready: true }],
			dial: async () => stub,
		});
		await expect(dialDeviceId("")).rejects.toBeInstanceOf(DeviceUnavailable);
		await expect(dialDeviceId("")).rejects.toThrow(/UDID-A/);
	});

	test("an unknown selector is rejected", async () => {
		setBrokerTestHooks({ listIos: () => [ios("UDID-A")], listAndroid: () => [], dial: async () => stub });
		await expect(dialDeviceId("NOPE")).rejects.toThrow(/未找到设备 NOPE/);
	});

	test("a known but unusable device explains why", async () => {
		setBrokerTestHooks({
			listIos: () => [],
			listAndroid: () => [{ id: "SER-B", platform: "android", connection: "unauthorized", ready: false }],
			dial: async () => stub,
		});
		await expect(dialDeviceId("SER-B")).rejects.toThrow(/unauthorized/);
	});

	test("an explicit platform skips discovery entirely", async () => {
		let listed = false;
		let dialed: DeviceInfo | null = null;
		setBrokerTestHooks({
			listIos: () => {
				listed = true;
				return [];
			},
			listAndroid: () => {
				listed = true;
				return [];
			},
			dial: async (device) => {
				dialed = device;
				return stub;
			},
		});
		// A caller that already knows the platform should not pay for a scan.
		await dialDeviceId("SER-B", 8765, "android");
		expect(listed).toBe(false);
		expect(dialed!.platform).toBe("android");
	});

	test("nothing connected reports the empty case", async () => {
		setBrokerTestHooks({ listIos: () => [], listAndroid: () => [], dial: async () => stub });
		await expect(dialDeviceId("")).rejects.toThrow(/未发现已连接设备/);
	});

	test("the requested port is forwarded to the dialer", async () => {
		let seenPort = 0;
		setBrokerTestHooks({
			listIos: () => [ios("UDID-A")],
			listAndroid: () => [],
			dial: async (_d, port) => {
				seenPort = port;
				return stub;
			},
		});
		await dialDeviceId("UDID-A", 9999);
		expect(seenPort).toBe(9999);
	});
});

describe("dialDevice", () => {
	test("routes by platform", async () => {
		const seen: string[] = [];
		setBrokerTestHooks({
			dial: async (device) => {
				seen.push(device.platform);
				return { destroy: () => {} } as unknown as Socket;
			},
		});
		await dialDevice(ios("UDID-A"));
		await dialDevice({ id: "SER-B", platform: "android", connection: "device", ready: true });
		expect(seen).toEqual(["ios", "android"]);
	});
});

describe("describeNoDevices", () => {
	test("distinguishes 'none' from 'none usable'", () => {
		expect(describeNoDevices([])).toMatch(/未发现已连接设备/);
		const blocked = describeNoDevices([
			{ id: "SER-B", platform: "android", connection: "unauthorized", ready: false },
		]);
		expect(blocked).toMatch(/发现设备但均不可用/);
		expect(blocked).toContain("SER-B");
		expect(blocked).toContain("unauthorized");
	});
});
