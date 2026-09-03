/**
 * Smoke test: load the extension's default export exactly as pi would
 * (call it with an ExtensionAPI), and assert it registers tools, replaces
 * the system prompt, and restricts the active tool set to Para's.
 */
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { CODE_BUILTIN_TOOLS } from "../src/mode.ts";

type CommandHandler = (args: string, ctx: { ui: { notify: (msg: string, level?: string) => void; setStatus?: (key: string, text: string | undefined) => void } }) => Promise<void>;

function loadExtension(flag?: string) {
	const tools = new Map<string, unknown>();
	const events = new Map<string, unknown>();
	const commands = new Map<string, CommandHandler>();
	let active: string[] | undefined;
	process.env.PARA_AUTO_TUNNEL = "0";
	delete process.env.PARA_MODE;
	delete process.env.INSPECTOR_MODE;

	const pi = {
		on: (event: string, handler: unknown) => {
			events.set(event, handler);
		},
		registerTool: (tool: { name: string }) => {
			tools.set(tool.name, tool);
		},
		setActiveTools: (names: string[]) => {
			active = names;
		},
		registerProvider: () => {},
		registerFlag: () => {},
		registerCommand: (name: string, options: { handler: CommandHandler }) => {
			commands.set(name, options.handler);
		},
		getFlag: () => flag,
	} as unknown as ExtensionAPI;

	extension(pi);
	return { tools, events, commands, getActive: () => active };
}

const ui = { notify: () => {}, setStatus: () => {} };

describe("extension entry", () => {
	test("registers iOS + knowledge tools and Para system prompt", async () => {
		const { tools, events, commands, getActive } = loadExtension();

		expect(tools.has("ping")).toBe(true);
		expect(tools.has("screen_digest")).toBe(true);
		expect(tools.has("tap")).toBe(false);
		expect(tools.has("tap_with_diff")).toBe(true);
		expect(tools.has("wait_for")).toBe(true);
		expect(tools.has("view_hierarchy")).toBe(true);
		expect(tools.has("navigate_to_page")).toBe(true);
		expect(tools.has("recall_page_context")).toBe(true);
		expect(tools.has("todo_write")).toBe(true);
		expect(tools.has("record_knowledge")).toBe(true);
		expect(tools.has("annotate_page")).toBe(true);
		expect(tools.has("switch_mode")).toBe(true);
		expect(commands.has("gui")).toBe(true);
		expect(commands.has("code")).toBe(true);
		expect(commands.has("mode")).toBe(true);
		expect(events.has("session_start")).toBe(true);
		expect(events.has("before_agent_start")).toBe(true);
		expect(events.has("context")).toBe(true);
		expect(events.has("session_before_compact")).toBe(true);
		expect(events.has("tool_call")).toBe(true);
		expect(events.has("tool_result")).toBe(true);

		const start = events.get("session_start") as (
			event: unknown,
			ctx: { ui: { notify: (msg: string, level?: string) => void } },
		) => Promise<void>;
		await start({}, { ui });
		const active = getActive();
		expect(active?.filter((n) => n !== "read")).toEqual([...tools.keys()]);
		expect(active?.includes("read")).toBe(true);
		expect(active?.includes("bash")).toBe(false);
		expect(active?.includes("write")).toBe(false);
		expect(active?.includes("switch_mode")).toBe(true);

		const before = events.get("before_agent_start") as (
			event?: { systemPrompt?: string; systemPromptOptions?: { skills: Array<{ name: string; description: string; filePath: string; disableModelInvocation: boolean }> } },
		) => Promise<{ systemPrompt: string }>;
		const { systemPrompt } = await before();
		expect(systemPrompt).toContain("You are Para.");
		expect(systemPrompt).toContain("screen_digest");
		expect(systemPrompt).toContain("tap_with_diff");
		expect(systemPrompt).toContain("wait_for");
		expect(systemPrompt).toContain("todo_write");
		expect(systemPrompt).toContain("record_knowledge");
		expect(systemPrompt).toContain("switch_mode");
		expect(systemPrompt).not.toContain("vision_query");

		const withSkills = await before({
			systemPromptOptions: {
				skills: [
					{
						name: "demo",
						description: "A demo skill.",
						filePath: "/tmp/demo/SKILL.md",
						disableModelInvocation: false,
					},
				],
			},
		});
		expect(withSkills.systemPrompt).toContain("<available_skills>");
		expect(withSkills.systemPrompt).toContain("demo");

		const ping = tools.get("ping") as {
			execute: (
				id: string,
				params: Record<string, never>,
				signal: undefined,
				onUpdate: undefined,
				ctx: unknown,
			) => Promise<{ content: { type: string }[] }>;
		};
		const result = await ping.execute("call-1", {}, undefined, undefined, {});
		expect(result.content[0]!.type).toBe("text");
	});

	test("/code enables coding builtins and drops device tools; /gui restores", async () => {
		const { tools, events, commands, getActive } = loadExtension();
		const start = events.get("session_start") as (event: unknown, ctx: { ui: typeof ui }) => Promise<void>;
		await start({}, { ui });

		await commands.get("code")!("", { ui });
		const code = getActive() ?? [];
		expect(code.includes("write")).toBe(true);
		expect(code.includes("bash")).toBe(true);
		expect(code.includes("edit")).toBe(true);
		expect(code.includes("switch_mode")).toBe(true);
		expect(code.includes("todo_write")).toBe(true);
		expect(code.includes("tap_with_diff")).toBe(false);
		expect(code.includes("screen_digest")).toBe(false);
		for (const name of CODE_BUILTIN_TOOLS) expect(code.includes(name)).toBe(true);

		const before = events.get("before_agent_start") as (
			event?: { systemPrompt?: string },
		) => Promise<{ systemPrompt: string }>;
		const coded = await before({ systemPrompt: "You are a coding agent." });
		expect(coded.systemPrompt).toContain("You are a coding agent.");
		expect(coded.systemPrompt).toContain("<para_mode>");

		const compact = events.get("session_before_compact") as () => Promise<unknown>;
		expect(await compact()).toBeUndefined();

		const toolCall = events.get("tool_call") as (event: { toolName: string }) => Promise<{ block?: boolean; reason?: string } | void>;
		const blockedTap = await toolCall({ toolName: "tap_with_diff" });
		expect(blockedTap?.block).toBe(true);
		expect(blockedTap?.reason).toMatch(/CODE mode/);
		expect(await toolCall({ toolName: "bash" })).toBeUndefined();

		await commands.get("gui")!("", { ui });
		const gui = getActive() ?? [];
		expect(gui.includes("tap_with_diff")).toBe(true);
		expect(gui.includes("bash")).toBe(false);
		expect(gui.filter((n) => n !== "read")).toEqual([...tools.keys()]);
	});

	test("switch_mode tool and --para-mode code start in CODE", async () => {
		const { tools, events, getActive } = loadExtension("code");
		const start = events.get("session_start") as (event: unknown, ctx: { ui: typeof ui }) => Promise<void>;
		await start({}, { ui });
		expect(getActive()?.includes("write")).toBe(true);
		expect(getActive()?.includes("tap_with_diff")).toBe(false);

		const switcher = tools.get("switch_mode") as {
			execute: (
				id: string,
				params: { mode: "gui" | "code"; reason?: string },
				signal: undefined,
				onUpdate: undefined,
				ctx: unknown,
			) => Promise<{ content: { type: string; text?: string }[] }>;
		};
		const result = await switcher.execute("s1", { mode: "gui", reason: "verify on device" }, undefined, undefined, {});
		const payload = JSON.parse(result.content[0]!.text!) as { ok: boolean; data: { mode: string; from: string } };
		expect(payload.ok).toBe(true);
		expect(payload.data.mode).toBe("gui");
		expect(payload.data.from).toBe("code");
		expect(getActive()?.includes("tap_with_diff")).toBe(true);
		expect(getActive()?.includes("bash")).toBe(false);
	});

	test("tool_call blocks the other mode's tools; context keeps one mode line", async () => {
		const { events } = loadExtension();
		const start = events.get("session_start") as (event: unknown, ctx: { ui: typeof ui }) => Promise<void>;
		await start({}, { ui });

		const toolCall = events.get("tool_call") as (event: { toolName: string; input?: Record<string, unknown> }) => Promise<{ block?: boolean; reason?: string } | void>;
		const blocked = await toolCall({ toolName: "bash" });
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toMatch(/GUI mode/);
		expect(await toolCall({ toolName: "screen_digest" })).toBeUndefined();

		const context = events.get("context") as (event: {
			messages: Array<{ role: string; content: unknown; timestamp?: number }>;
		}) => Promise<{ messages: Array<{ role: string; content: unknown }> }>;
		const first = await context({
			messages: [{ role: "user", content: [{ type: "text", text: "open settings" }], timestamp: 1 }],
		});
		const last = first.messages[first.messages.length - 1]!;
		expect(JSON.stringify(last)).toContain("<para-mode>gui</para-mode>");

		const second = await context({ messages: first.messages });
		const modeLines = second.messages.filter((m) => JSON.stringify(m).includes("<para-mode>"));
		expect(modeLines).toHaveLength(1);
	});
});
