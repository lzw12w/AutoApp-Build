/**
 * GUI-oriented replacement for pi's default coding-agent compaction summary.
 *
 * pi still decides *when* to compact (context > window − reserve). We intercept
 * `session_before_compact` and ask the current model for a checkpoint that
 * preserves pages, VCs, actions, and addresses — not file lists.
 *
 * On LLM failure we fall back to an extractive summary so compaction still
 * proceeds instead of silently using the coding prompt.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const GUI_COMPACTION_MARKER = "GUI CONTEXT COMPACTED";

export const GUI_SUMMARIZATION_PROMPT = `The messages above are a GUI-agent session driving a live iOS app. Create a structured checkpoint that another LLM will use to continue operating the app. Do NOT continue the conversation. Do NOT call tools. ONLY output the summary.

Use this EXACT format:

## Goal
[What the user asked the agent to accomplish on the device.]

## Constraints
- [Do-nots, skipped tabs, accounts, environments. "(none)" if none.]

## Current screen
- VC class / title if known
- What was last seen (digest headline, not a full tree)

## Pages visited
- [VC class or page id, in visit order. Note repeats.]

## Navigation taken
- [action_type + key params (index, address, text) → resulting page/VC]

## Working memory
- Recent tap/find_view addresses still likely valid
- Tab indices, text entered, URLs opened
- Knowledge-graph facts recalled (page names, known edges)

## Blocked
- [Network errors, missing controls, failed taps. "(none)" if none.]

## Next steps
1. [Concrete next GUI actions]

## Critical handles
- [Hex addresses, accessibility ids, tab indexes the next turn will need]
- [Or "(none)"]

Preserve exact VC class names, hex addresses, tab indexes, and error strings. Do not invent pages the agent did not visit.`;

export const GUI_UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW GUI-agent turns to fold into the existing checkpoint in <previous-summary>. RULES:
- PRESERVE existing goals, pages, and handles
- ADD newly visited VCs and new navigation edges
- UPDATE "Current screen" to the latest VC
- MOVE finished work from Next steps into a short Progress note
- DROP addresses that were on screens the agent has since left, unless they were recorded as knowledge-graph facts

${GUI_SUMMARIZATION_PROMPT}`;

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return `${s.slice(0, n)}…`;
}

function compactArgs(args: unknown): string {
	if (!isRecord(args)) return "";
	const parts: string[] = [];
	for (const [k, v] of Object.entries(args)) {
		if (v === undefined || v === null || v === "") continue;
		const shown = typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
		parts.push(`${k}=${truncate(shown, 80)}`);
	}
	return parts.join(", ");
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => isRecord(b) && b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}

/** Flatten session messages into a compact transcript for the summarizer. */
export function serializeGuiConversation(messages: AgentMessage[], resultLimit = 1500): string {
	const lines: string[] = [];
	for (const m of messages) {
		if (m.role === "user") {
			const t = textOf(m.content).trim();
			if (t) lines.push(`[User]: ${t}`);
			continue;
		}
		if (m.role === "assistant") {
			for (const block of m.content) {
				if (block.type === "text" && block.text.trim()) lines.push(`[Assistant]: ${truncate(block.text.trim(), 800)}`);
				if (block.type === "toolCall") {
					lines.push(`[Tool call]: ${block.name}(${compactArgs(block.arguments)})`);
				}
			}
			continue;
		}
		if (m.role === "toolResult") {
			const body = truncate(textOf(m.content).replace(/\s+/g, " ").trim(), resultLimit);
			const err = m.isError ? " ERROR" : "";
			lines.push(`[Tool result ${m.toolName}${err}]: ${body}`);
		}
	}
	return lines.join("\n");
}

/** Cheap extractive fallback when the summarizer LLM fails. */
export function extractiveGuiSummary(messages: AgentMessage[], previousSummary?: string): string {
	const calls: string[] = [];
	const vcs = new Set<string>();
	const goals: string[] = [];
	for (const m of messages) {
		if (m.role === "user") {
			const t = textOf(m.content).trim();
			if (t) goals.push(truncate(t, 240));
		}
		if (m.role === "assistant") {
			for (const block of m.content) {
				if (block.type === "toolCall") calls.push(`${block.name}(${compactArgs(block.arguments)})`);
			}
		}
		if (m.role === "toolResult") {
			const text = textOf(m.content);
			const vc = text.match(/VC:\s*(\S+)/);
			if (vc?.[1]) vcs.add(vc[1]);
			try {
				const parsed: unknown = JSON.parse(text);
				const data = isRecord(parsed) && isRecord(parsed.data) ? parsed.data : parsed;
				const vis = isRecord(data) && isRecord(data.visible_vc) ? data.visible_vc : null;
				if (vis && typeof vis.class === "string") vcs.add(vis.class);
				if (isRecord(data) && typeof data.class === "string" && /ViewController|Controller$/.test(data.class)) {
					vcs.add(data.class);
				}
			} catch {
				// plain digest
			}
		}
	}
	const parts = [
		GUI_COMPACTION_MARKER,
		"## Goal",
		goals[0] || "(see prior summary)",
		"## Pages visited",
		[...vcs].map((v) => `- ${v}`).join("\n") || "- (none extracted)",
		"## Navigation taken",
		calls.slice(-24).map((c) => `- ${c}`).join("\n") || "- (none)",
		"## Next steps",
		"1. Re-read the current screen with screen_digest before acting.",
	];
	if (previousSummary) {
		parts.push("## Previous checkpoint", truncate(previousSummary, 4000));
	}
	return parts.join("\n");
}

function assistantText(response: AssistantMessage): string {
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

export interface GuiCompactInput {
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	previousSummary?: string;
	customInstructions?: string;
	signal?: AbortSignal;
}

/**
 * Ask the live model for a GUI checkpoint. Returns null on abort/failure so
 * the caller can fall back (extractive, or pi's default).
 */
export async function generateGuiCompactionSummary(
	ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
	input: GuiCompactInput,
): Promise<{ summary: string; usage: AssistantMessage["usage"] } | null> {
	const model = ctx.model;
	if (!model) return null;
	const all = [...input.messagesToSummarize, ...input.turnPrefixMessages];
	const conversation = serializeGuiConversation(all);
	let prompt = `<conversation>\n${conversation}\n</conversation>\n\n`;
	if (input.previousSummary) {
		prompt += `<previous-summary>\n${input.previousSummary}\n</previous-summary>\n\n`;
		prompt += GUI_UPDATE_SUMMARIZATION_PROMPT;
	} else {
		prompt += GUI_SUMMARIZATION_PROMPT;
	}
	if (input.customInstructions) {
		prompt += `\n\nAdditional focus: ${input.customInstructions}`;
	}

	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: prompt }],
						timestamp: Date.now(),
					},
				],
			},
			{
				maxTokens: 4096,
				signal: input.signal,
				cacheRetention: "none",
			},
		);
		if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "length") {
			return null;
		}
		if (response.content.some((b) => b.type === "toolCall")) return null;
		const text = assistantText(response);
		if (!text) return null;
		const summary = text.includes(GUI_COMPACTION_MARKER) ? text : `${GUI_COMPACTION_MARKER}\n\n${text}`;
		return { summary, usage: response.usage };
	} catch {
		return null;
	}
}
