import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	extractiveGuiSummary,
	GUI_COMPACTION_MARKER,
	serializeGuiConversation,
} from "../src/compact/summary.ts";

function msgs(): AgentMessage[] {
	return [
		{ role: "user", content: "切到探索 Tab，不要点创作", timestamp: 1 },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "先看当前页。" },
				{ type: "toolCall", id: "1", name: "screen_digest", arguments: {} },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "x",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "1",
			toolName: "screen_digest",
			content: [{ type: "text", text: "VC: MainFeedContainerViewController   nodes=84\n@1 UIButton" }],
			isError: false,
			timestamp: 3,
		},
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "2", name: "switch_tab", arguments: { index: 1 } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "x",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 4,
		},
		{
			role: "toolResult",
			toolCallId: "2",
			toolName: "switch_tab",
			content: [{ type: "text", text: JSON.stringify({ ok: true, data: { selectedIndex: 1 } }) }],
			isError: false,
			timestamp: 5,
		},
	];
}

describe("serializeGuiConversation", () => {
	test("keeps goals, tool names, and digest VC labels", () => {
		const text = serializeGuiConversation(msgs());
		expect(text).toContain("[User]: 切到探索 Tab，不要点创作");
		expect(text).toContain("screen_digest");
		expect(text).toContain("switch_tab(index=1)");
		expect(text).toContain("MainFeedContainerViewController");
	});
});

describe("extractiveGuiSummary", () => {
	test("extracts the user goal and VC from screen_digest", () => {
		const summary = extractiveGuiSummary(msgs());
		expect(summary).toContain(GUI_COMPACTION_MARKER);
		expect(summary).toContain("切到探索 Tab");
		expect(summary).toContain("MainFeedContainerViewController");
		expect(summary).toContain("switch_tab(index=1)");
	});
});
