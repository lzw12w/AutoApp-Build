import { afterEach, describe, expect, test } from "bun:test";
import {
	autoTunnelEnabled,
	ensureLocalInspectorTunnel,
	parseAdbDevices,
	parseAdbForwardList,
	parseAdbForwardPort,
	proxyProcessArgs,
	resolveTunnelPlatform,
	setTunnelTestHooks,
} from "../src/ios-runtime/tunnel.ts";

const savedAutoTunnel = process.env.PARA_AUTO_TUNNEL;

afterEach(() => {
	if (savedAutoTunnel === undefined) delete process.env.PARA_AUTO_TUNNEL;
	else process.env.PARA_AUTO_TUNNEL = savedAutoTunnel;
	setTunnelTestHooks(null);
});

describe("proxyProcessArgs", () => {
	test("builds L R args", () => {
		expect(proxyProcessArgs(8765, 8765)).toEqual(["8765", "8765"]);
	});
	test("appends -u UDID when identifier given", () => {
		expect(proxyProcessArgs(8765, 8765, "abc123")).toEqual(["8765", "8765", "-u", "abc123"]);
	});
});

describe("adb parsers", () => {
	test("parseAdbForwardPort only accepts tcp:N", () => {
		expect(parseAdbForwardPort("tcp:8765")).toBe(8765);
		expect(parseAdbForwardPort("tcp:18765")).toBe(18765);
		expect(parseAdbForwardPort("localabstract:inspector")).toBeNull();
		expect(parseAdbForwardPort("jdwp:123")).toBeNull();
		expect(parseAdbForwardPort("tcp:0")).toBeNull();
	});

	test("parseAdbForwardList reads serial and ports", () => {
		const rows = parseAdbForwardList("SERIAL tcp:18765 tcp:8765\nEMU tcp:9000 localabstract:x\n");
		expect(rows).toEqual([{ serial: "SERIAL", localPort: 18765, remotePort: 8765 }]);
	});

	test("parseAdbDevices keeps only state=device", () => {
		expect(
			parseAdbDevices(`List of devices attached
SERIAL\tdevice
OFF\toffline
UNAUTH\tunauthorized
EMU\tdevice
`),
		).toEqual(["SERIAL", "EMU"]);
	});
});

describe("resolveTunnelPlatform", () => {
	test("explicit platform wins", () => {
		expect(resolveTunnelPlatform({ platform: "android", identifier: "UDID" })).toBe("android");
		expect(resolveTunnelPlatform({ platform: "ios", adbSerials: ["S"] })).toBe("ios");
	});

	test("identifier that is an adb serial is android", () => {
		expect(resolveTunnelPlatform({ identifier: "S1", adbSerials: ["S1"] })).toBe("android");
		expect(resolveTunnelPlatform({ identifier: "UDID", adbSerials: ["S1"] })).toBe("ios");
	});

	test("only android plugged in, no identifier → android", () => {
		expect(resolveTunnelPlatform({ adbSerials: ["S1"], usbIdentifiers: [] })).toBe("android");
	});

	test("both plugged in, no identifier stays ios so 8765 is not stolen", () => {
		expect(resolveTunnelPlatform({ adbSerials: ["S1"], usbIdentifiers: ["UDID"] })).toBe("ios");
	});
});

describe("autoTunnelEnabled", () => {
	test("defaults on", () => {
		delete process.env.PARA_AUTO_TUNNEL;
		expect(autoTunnelEnabled()).toBe(true);
	});
	test("respects off values", () => {
		for (const v of ["0", "false", "no", "off", "OFF"]) {
			process.env.PARA_AUTO_TUNNEL = v;
			expect(autoTunnelEnabled()).toBe(false);
		}
	});
	test("on for other values", () => {
		process.env.PARA_AUTO_TUNNEL = "1";
		expect(autoTunnelEnabled()).toBe(true);
	});
});

describe("ensureLocalInspectorTunnel", () => {
	test("non-local host short-circuits to 'none'", async () => {
		const status = await ensureLocalInspectorTunnel({ host: "example.com", port: 8765 });
		expect(status.action).toBe("none");
		expect(status.ok).toBe(true);
	});

	test("closed port + auto-tunnel off returns 'skipped'", async () => {
		const status = await ensureLocalInspectorTunnel({ port: 59321, start: false });
		expect(status.action).toBe("skipped");
		expect(status.ok).toBe(false);
	});

	test("android uses adb forward local → device 8765", async () => {
		const calls: string[][] = [];
		setTunnelTestHooks({
			portIsOpen: () => false,
			tunnelHealthy: () => true,
			usbIdentifiers: [],
			adbExec: (args) => {
				calls.push(args);
				if (args[0] === "devices") return { status: 0, stdout: "List of devices attached\nSERIAL\tdevice\n", stderr: "" };
				if (args[0] === "forward" && args[1] === "--list") return { status: 0, stdout: "", stderr: "" };
				return { status: 0, stdout: "", stderr: "" };
			},
		});
		const status = await ensureLocalInspectorTunnel({
			host: "127.0.0.1",
			port: 18765,
			identifier: "SERIAL",
			platform: "android",
			start: true,
		});
		expect(status.ok).toBe(true);
		expect(status.action).toBe("started");
		expect(status.detail).toContain("adb forward 127.0.0.1:18765 -> SERIAL:8765");
		const forward = calls.filter((c) => c.includes("forward") && c.includes("tcp:18765") && c.includes("tcp:8765"));
		expect(forward.at(-1)).toEqual(["-s", "SERIAL", "forward", "tcp:18765", "tcp:8765"]);
	});

	test("android infers serial when exactly one device is attached", async () => {
		const calls: string[][] = [];
		setTunnelTestHooks({
			portIsOpen: () => false,
			tunnelHealthy: () => true,
			usbIdentifiers: [],
			adbExec: (args) => {
				calls.push(args);
				if (args[0] === "devices") return { status: 0, stdout: "List of devices attached\nONLY\tdevice\n", stderr: "" };
				return { status: 0, stdout: "", stderr: "" };
			},
		});
		const status = await ensureLocalInspectorTunnel({ host: "127.0.0.1", port: 8765, platform: "android", start: true });
		expect(status.ok).toBe(true);
		expect(calls.some((c) => c[0] === "-s" && c[1] === "ONLY" && c.includes("forward"))).toBe(true);
	});

	test("android missing adb fails cleanly", async () => {
		setTunnelTestHooks({
			adbPath: null,
			portIsOpen: () => false,
			usbIdentifiers: [],
			adbExec: () => ({ status: 127, stdout: "", stderr: "adb not found" }),
		});
		const status = await ensureLocalInspectorTunnel({
			host: "127.0.0.1",
			port: 18765,
			identifier: "SERIAL",
			platform: "android",
			start: true,
		});
		expect(status.ok).toBe(false);
		expect(status.action).toBe("failed");
		expect(status.detail).toMatch(/adb not found/i);
	});

	test("android forward that never answers /api/ping is failed, not started", async () => {
		setTunnelTestHooks({
			portIsOpen: () => false,
			tunnelHealthy: () => false,
			usbIdentifiers: [],
			adbExec: () => ({ status: 0, stdout: "", stderr: "" }),
		});
		const status = await ensureLocalInspectorTunnel({
			host: "127.0.0.1",
			port: 18765,
			identifier: "SERIAL",
			platform: "android",
			start: true,
		});
		expect(status.ok).toBe(false);
		expect(status.action).toBe("failed");
		expect(status.detail).toMatch(/unresponsive/);
	});

	test("our adb forward that goes unhealthy is rebuilt, not occupied", async () => {
		let health = 0;
		const calls: string[][] = [];
		setTunnelTestHooks({
			portIsOpen: () => true,
			tunnelHealthy: () => ++health > 1,
			usbIdentifiers: [],
			adbExec: (args) => {
				calls.push(args);
				if (args[0] === "forward" && args[1] === "--list") {
					return { status: 0, stdout: "SERIAL tcp:18765 tcp:8765\n", stderr: "" };
				}
				if (args[0] === "devices") return { status: 0, stdout: "List of devices attached\nSERIAL\tdevice\n", stderr: "" };
				return { status: 0, stdout: "", stderr: "" };
			},
		});
		const status = await ensureLocalInspectorTunnel({
			host: "127.0.0.1",
			port: 18765,
			identifier: "SERIAL",
			platform: "android",
			start: true,
		});
		expect(status.ok).toBe(true);
		expect(status.action).toBe("started");
		expect(status.detail).toMatch(/zombie|rebuilt/i);
		expect(calls.some((c) => c.includes("--remove"))).toBe(true);
	});
});
