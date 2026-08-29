/**
 * Exclusive session modes: GUI (drive the device) vs CODE (edit the repo).
 *
 * Mixing tap and write in one tool set is the accident. Switching is cheap;
 * keeping both loaded is not. Humans use /gui /code /mode; the model uses
 * switch_mode. Tool whitelist + prompt + a request-local mode line all move
 * together. setActiveTools takes effect on the next LLM call in the turn.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { errResult, okResult } from "./tools/result.ts";

export type ParaMode = "gui" | "code";

/** pi coding-agent builtins exposed in CODE mode. No powershell (we are on Unix). */
export const CODE_BUILTIN_TOOLS: readonly string[] = [
	"read",
	"write",
	"edit",
	"grep",
	"find",
	"ls",
	"bash",
];

const CODE_ONLY = new Set(["write", "edit", "bash", "grep", "find", "ls", "powershell"]);

/** Para tools that stay available in CODE mode (mode switch + task list). */
export const CODE_PARA_TOOLS: readonly string[] = ["switch_mode", "todo_write"];

export function parseMode(raw: unknown): ParaMode | null {
	if (typeof raw !== "string") return null;
	const v = raw.trim().toLowerCase();
	if (v === "gui" || v === "device" || v === "ios") return "gui";
	if (v === "code" || v === "coding" || v === "dev") return "code";
	return null;
}

export function parseModeOrDefault(raw: unknown, fallback: ParaMode = "gui"): ParaMode {
	return parseMode(raw) ?? fallback;
}

function unique(names: string[]): string[] {
	return [...new Set(names)];
}

/** Active tool names for a mode. `paraTools` is every tool this extension registered. */
export function activeToolsForMode(mode: ParaMode, paraTools: readonly string[]): string[] {
	if (mode === "gui") return unique([...paraTools, "read"]);
	return unique([...CODE_PARA_TOOLS, ...CODE_BUILTIN_TOOLS]);
}

export function isCodeOnlyTool(name: string): boolean {
	return CODE_ONLY.has(name);
}

export function isGuiOnlyTool(name: string, paraTools: ReadonlySet<string>): boolean {
	if (CODE_PARA_TOOLS.includes(name)) return false;
	return paraTools.has(name);
}

export function modeBlockReason(mode: ParaMode, toolName: string, paraTools: ReadonlySet<string>): string | null {
	if (mode === "gui" && isCodeOnlyTool(toolName)) {
		return `GUI mode: "${toolName}" is a coding tool. Call switch_mode(mode="code") or /code first.`;
	}
	if (mode === "code" && isGuiOnlyTool(toolName, paraTools)) {
		return `CODE mode: "${toolName}" is a device tool. Call switch_mode(mode="gui") or /gui first.`;
	}
	return null;
}

/** Cheap per-request line so a mid-turn switch is visible on the next LLM call. */
export function modeContextLine(mode: ParaMode): string {
	if (mode === "gui") {
		return (
			'<para-mode>gui</para-mode> Device tools are active. Coding write/edit/bash are off. ' +
			'Call switch_mode(mode="code") only when you must change source files.'
		);
	}
	return (
		'<para-mode>code</para-mode> Coding tools (read/write/edit/grep/find/ls/bash) are active. ' +
		'Device tap/inspect tools are off. Call switch_mode(mode="gui") to operate the iOS app.'
	);
}

/** True when this user message is a previous request-local mode line (strip + rewrite). */
export function isModeContextMessage(message: { role?: string; content?: unknown }): boolean {
	if (message.role !== "user") return false;
	const content = message.content;
	if (typeof content === "string") return content.includes("<para-mode>");
	if (!Array.isArray(content)) return false;
	return content.some(
		(block) =>
			typeof block === "object" &&
			block !== null &&
			"text" in block &&
			typeof (block as { text: unknown }).text === "string" &&
			(block as { text: string }).text.includes("<para-mode>"),
	);
}

export const CODE_MODE_SUFFIX = `

<para_mode>
You are Para, currently in CODE mode — a coding agent for this workspace.

Device GUI tools (tap, screen_digest, view_hierarchy, …) are disabled.
You have pi's coding tools: read, write, edit, grep, find, ls, bash, plus todo_write and switch_mode.

When the next work is operating the live iOS app, call switch_mode(mode="gui") and stop editing.
Do not bounce modes every turn. Switch when the TASK type changes, not for a single file peek.
</para_mode>
`;

export function buildCodeSystemPrompt(base: string): string {
	if (base.includes("<para_mode>")) return base;
	return `${base}${CODE_MODE_SUFFIX}`;
}

export interface ModeApplyResult {
	status: "switched" | "unchanged";
	mode: ParaMode;
	from: ParaMode;
	reason: string;
	tools: string[];
}

export interface ModeSwitcher {
	get(): ParaMode;
	apply(next: ParaMode, reason: string): ModeApplyResult;
}

type Details = { ok: boolean } & Record<string, unknown>;

export function switchModeTool(switcher: ModeSwitcher) {
	return defineTool({
		name: "switch_mode",
		label: "Switch mode",
		description:
			"Switch Para between GUI mode (drive the iOS app) and CODE mode (edit this workspace). " +
			"Call this yourself when the task type changes — do not wait for the user. " +
			"GUI: tap/inspect/wait. CODE: read/write/edit/grep/find/ls/bash. " +
			"The switch takes effect on your next tool batch. Do not bounce every turn.",
		parameters: Type.Object({
			mode: Type.Union([Type.Literal("gui"), Type.Literal("code")]),
			reason: Type.Optional(Type.String({ description: "Why the task now needs this mode." })),
		}),
		execute: async (_id, params) => {
			try {
				const reason = (params.reason ?? "").trim() || "agent switch_mode";
				return okResult<Details>(switcher.apply(params.mode, reason));
			} catch (e) {
				return errResult<Details>(e);
			}
		},
	});
}
