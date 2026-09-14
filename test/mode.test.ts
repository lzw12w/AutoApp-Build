import { describe, expect, test } from "bun:test";
import {
	activeToolsForMode,
	buildCodeSystemPrompt,
	CODE_BUILTIN_TOOLS,
	CODE_MODE_ENABLED,
	codeModeDisabledReason,
	effectiveMode,
	isModeContextMessage,
	modeBlockReason,
	modeContextLine,
	parseMode,
	parseModeOrDefault,
	switchModeTool,
} from "../src/mode.ts";

const PARA = ["tap_with_diff", "screen_digest", "view_hierarchy", "find_view", "todo_write", "switch_mode", "record_knowledge"];
const PARA_SET = new Set(PARA);

describe("parseMode", () => {
	test("accepts aliases", () => {
		expect(parseMode("GUI")).toBe("gui");
		expect(parseMode("device")).toBe("gui");
		expect(parseMode("ios")).toBe("gui");
		expect(parseMode("code")).toBe("code");
		expect(parseMode("coding")).toBe("code");
		expect(parseMode("dev")).toBe("code");
		expect(parseMode("nope")).toBeNull();
		expect(parseMode(1)).toBeNull();
	});

	test("falls back", () => {
		expect(parseModeOrDefault(undefined, "gui")).toBe("gui");
		expect(parseModeOrDefault("code", "gui")).toBe("code");
		expect(parseModeOrDefault("??", "code")).toBe("code");
	});
});

describe("activeToolsForMode", () => {
	test("GUI keeps every Para tool plus read, never bash/write", () => {
		const tools = activeToolsForMode("gui", PARA);
		expect(tools).toEqual([...PARA, "read"]);
		expect(tools.includes("bash")).toBe(false);
		expect(tools.includes("write")).toBe(false);
	});

	test("CODE is switch_mode + todo_write + coding builtins, never tap_with_diff", () => {
		const tools = activeToolsForMode("code", PARA);
		expect(tools.includes("tap_with_diff")).toBe(false);
		expect(tools.includes("screen_digest")).toBe(false);
		expect(tools.includes("switch_mode")).toBe(true);
		expect(tools.includes("todo_write")).toBe(true);
		for (const name of CODE_BUILTIN_TOOLS) expect(tools.includes(name)).toBe(true);
	});
});

describe("modeBlockReason", () => {
	test("GUI blocks coding-only tools", () => {
		expect(modeBlockReason("gui", "bash", PARA_SET)).not.toBeNull();
		expect(modeBlockReason("gui", "write", PARA_SET)).not.toBeNull();
		expect(modeBlockReason("gui", "tap_with_diff", PARA_SET)).toBeNull();
		expect(modeBlockReason("gui", "read", PARA_SET)).toBeNull();
		expect(modeBlockReason("gui", "switch_mode", PARA_SET)).toBeNull();
	});

	test("the GUI refusal never names an unregistered tool", () => {
		const reason = modeBlockReason("gui", "bash", PARA_SET) ?? "";
		if (CODE_MODE_ENABLED) {
			expect(reason).toMatch(/GUI mode/);
			expect(reason).toContain("switch_mode");
		} else {
			expect(reason).toMatch(/GUI-only/);
			expect(reason).not.toContain("switch_mode");
			expect(reason).not.toContain("/code");
		}
	});

	test("CODE blocks device tools, keeps switch_mode and todo_write", () => {
		expect(modeBlockReason("code", "tap_with_diff", PARA_SET)).toMatch(/CODE mode/);
		expect(modeBlockReason("code", "record_knowledge", PARA_SET)).toMatch(/CODE mode/);
		expect(modeBlockReason("code", "switch_mode", PARA_SET)).toBeNull();
		expect(modeBlockReason("code", "todo_write", PARA_SET)).toBeNull();
		expect(modeBlockReason("code", "bash", PARA_SET)).toBeNull();
		expect(modeBlockReason("code", "find_view", PARA_SET)).toMatch(/CODE mode/);
	});
});

describe("mode context", () => {
	test("line tags the active mode", () => {
		expect(modeContextLine("gui")).toContain("<para-mode>gui</para-mode>");
		expect(modeContextLine("code")).toContain("<para-mode>code</para-mode>");
	});

	test("the GUI line only advertises switch_mode when it exists", () => {
		expect(modeContextLine("gui").includes("switch_mode")).toBe(CODE_MODE_ENABLED);
	});

	test("detects previous injected lines", () => {
		expect(isModeContextMessage({ role: "user", content: [{ type: "text", text: modeContextLine("gui") }] })).toBe(true);
		expect(isModeContextMessage({ role: "user", content: "please tap buy" })).toBe(false);
		expect(isModeContextMessage({ role: "assistant", content: [{ type: "text", text: modeContextLine("gui") }] })).toBe(
			false,
		);
	});
});

describe("buildCodeSystemPrompt", () => {
	test("appends suffix once", () => {
		const once = buildCodeSystemPrompt("You are a coding agent.");
		expect(once).toContain("You are a coding agent.");
		expect(once).toContain("<para_mode>");
		expect(once).toContain("switch_mode");
		expect(buildCodeSystemPrompt(once)).toBe(once);
	});
});

describe("switch_mode tool", () => {
	test("applies the requested mode without a confirm gate", async () => {
		if (!CODE_MODE_ENABLED) return;
		const state: { mode: "gui" | "code" } = { mode: "gui" };
		const tool = switchModeTool({
			get: () => state.mode,
			apply: (next, reason) => {
				const from = state.mode;
				state.mode = next;
				return { status: "switched", mode: next, from, reason, tools: activeToolsForMode(next, PARA) };
			},
		});
		const result = await tool.execute("c1", { mode: "code", reason: "need to edit a test" }, undefined, undefined, {} as never);
		const payload = JSON.parse((result.content[0] as { text: string }).text) as {
			ok: boolean;
			data: { status: string; mode: string; from: string; reason: string; tools: string[] };
		};
		expect(payload.ok).toBe(true);
		expect(payload.data.status).toBe("switched");
		expect(payload.data.mode).toBe("code");
		expect(payload.data.from).toBe("gui");
		expect(payload.data.reason).toBe("need to edit a test");
		expect(payload.data.tools.includes("write")).toBe(true);
		expect(payload.data.tools.includes("tap_with_diff")).toBe(false);
		expect(state.mode).toBe("code");
	});

	// Defence in depth: index.ts does not register the tool, but if any other
	// caller reaches it the mode must not change behind the tool set's back.
	test("refuses code without switching when the kill switch is off", async () => {
		if (CODE_MODE_ENABLED) return;
		const state: { mode: "gui" | "code" } = { mode: "gui" };
		let applied = 0;
		const tool = switchModeTool({
			get: () => state.mode,
			apply: (next, reason) => {
				applied += 1;
				const from = state.mode;
				state.mode = next;
				return { status: "switched", mode: next, from, reason, tools: activeToolsForMode(next, PARA) };
			},
		});
		const result = await tool.execute("c1", { mode: "code" }, undefined, undefined, {} as never);
		const payload = JSON.parse((result.content[0] as { text: string }).text) as {
			ok: boolean;
			error?: { message?: string };
		};
		expect(payload.ok).toBe(false);
		expect(payload.error?.message ?? "").toMatch(/disabled/i);
		expect(applied).toBe(0);
		expect(state.mode).toBe("gui");
	});
});

describe("kill switch", () => {
	test("effectiveMode clamps code to gui while disabled", () => {
		expect(effectiveMode("gui")).toBe("gui");
		expect(effectiveMode("code")).toBe(CODE_MODE_ENABLED ? "code" : "gui");
	});

	test("codeModeDisabledReason is set only while disabled", () => {
		const reason = codeModeDisabledReason();
		if (CODE_MODE_ENABLED) {
			expect(reason).toBeNull();
		} else {
			expect(reason).toMatch(/GUI-only/);
		}
	});

	// parseMode stays a pure parser: clamping is effectiveMode's job alone, so
	// re-enabling the mode does not require re-auditing every caller.
	test("parseMode still recognizes code as a spelling", () => {
		expect(parseMode("code")).toBe("code");
		expect(parseModeOrDefault("code", "gui")).toBe("code");
	});
});
