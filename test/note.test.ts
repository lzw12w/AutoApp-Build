import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "../src/prompts.ts";
import { recordKnowledgeTool, writeNoteEntry } from "../src/tools/note.ts";

const ctx = {} as never;

function parse(result: { content: { type: string; text?: string }[] }): Record<string, unknown> {
	const first = result.content[0]!;
	if (first.type !== "text" || first.text === undefined) return {};
	return JSON.parse(first.text) as Record<string, unknown>;
}

function tmpNote(): string {
	return join(mkdtempSync(join(tmpdir(), "para-note-")), "NOTE.md");
}

describe("NOTE.md writer", () => {
	test("writes a new file under the section with a why sub-bullet", () => {
		const path = tmpNote();
		const out = writeNoteEntry(path, {
			section: "UI 约定",
			entry: "发送按钮 aid 是 icon_send_2",
			rationale: "第一次找 send 文本失败",
		});
		expect(out.status).toBe("written");
		const text = readFileSync(path, "utf8");
		expect(text).toContain("## UI 约定");
		expect(text).toContain("- 发送按钮 aid 是 icon_send_2");
		expect(text).toContain("_why_:");
	});

	test("dedups an identical entry in the same section", () => {
		const path = tmpNote();
		writeFileSync(path, "## UI 约定\n- 发送按钮 aid 是 icon_send_2\n", "utf8");
		const out = writeNoteEntry(path, {
			section: "UI 约定",
			entry: "发送按钮 aid 是 icon_send_2",
			rationale: "重复",
		});
		expect(out.status).toBe("duplicate");
		expect(readFileSync(path, "utf8").split("发送按钮 aid 是 icon_send_2").length - 1).toBe(1);
	});

	test("canonical sections sort before user-coined ones", () => {
		const path = tmpNote();
		writeFileSync(path, "## 临时调试\n- 仅本次\n", "utf8");
		writeNoteEntry(path, { section: "业务概念", entry: "bot 是 AI 聊天角色", rationale: "r" });
		const text = readFileSync(path, "utf8");
		expect(text.indexOf("## 业务概念")).toBeLessThan(text.indexOf("## 临时调试"));
	});

	test("refuses without user_confirm", async () => {
		const path = tmpNote();
		const result = await recordKnowledgeTool(path).execute(
			"n1",
			{ section: "UI 约定", entry: "x", rationale: "x", user_confirm: false },
			undefined,
			undefined,
			ctx,
		);
		const payload = parse(result) as { ok: boolean; error: { code: string } };
		expect(payload.ok).toBe(false);
		expect(payload.error.code).toBe("E_CONFIRM_REQUIRED");
		expect(() => readFileSync(path, "utf8")).toThrow();
	});

	test("session snapshot ignores a later disk write", () => {
		const path = tmpNote();
		writeFileSync(path, "## UI 约定\n- 会话启动时的内容\n", "utf8");
		const snapshot = readFileSync(path, "utf8").trim();
		writeNoteEntry(path, { section: "UI 约定", entry: "本轮写入的新经验", rationale: "r" });
		const prompt = buildSystemPrompt({ noteBody: snapshot, notePath: path });
		expect(prompt).toContain("会话启动时的内容");
		expect(prompt).not.toContain("本轮写入的新经验");
	});
});
