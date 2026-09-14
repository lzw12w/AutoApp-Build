import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, SYSTEM_PROMPT } from "../src/prompts.ts";
import { listParaTools } from "../src/exec.ts";
import { CODE_MODE_ENABLED } from "../src/mode.ts";
import { h32, h64 } from "../src/knowledge/hash.ts";
import { openSqlite } from "../src/knowledge/sqlite.ts";

describe("prompts", () => {
	test("base prompt names tools that exist", () => {
		const names = new Set(listParaTools());
		expect(SYSTEM_PROMPT).toContain("You are Para.");
		for (const tool of ["screen_digest", "view_hierarchy", "vc_hierarchy", "tap_with_diff", "wait_for", "todo_write", "navigate_to_page", "record_knowledge", "annotate_page"]) {
			expect(SYSTEM_PROMPT).toContain(tool);
			expect(names.has(tool)).toBe(true);
		}
		expect(names.has("tap")).toBe(false);
		expect(SYSTEM_PROMPT).not.toContain("vision_query");
		expect(SYSTEM_PROMPT).not.toContain("skills_list");
	});

	// The prompt must never name a tool the extension does not register: the model
	// would spend a turn calling it and get an unknown-tool error back.
	test("switch_mode is named only when CODE mode is enabled", () => {
		const names = new Set(listParaTools());
		expect(SYSTEM_PROMPT.includes("switch_mode")).toBe(CODE_MODE_ENABLED);
		expect(names.has("switch_mode")).toBe(CODE_MODE_ENABLED);
	});

	test("the GUI-only build tells the model it cannot change code", () => {
		if (CODE_MODE_ENABLED) return;
		expect(SYSTEM_PROMPT).toContain("You cannot change code.");
		expect(SYSTEM_PROMPT).not.toContain("/code");
		// Section numbering stays contiguous when 12 is swapped out.
		expect(SYSTEM_PROMPT).toContain("13. **Reporting style.**");
	});

	test("appends project_knowledge when note body is set", () => {
		const prompt = buildSystemPrompt({ noteBody: "Feed cards are inverted.", notePath: "/tmp/NOTE.md" });
		expect(prompt).toContain("<project_knowledge>");
		expect(prompt).toContain("Feed cards are inverted.");
		expect(prompt).toContain("/tmp/NOTE.md");
		expect(prompt.startsWith(SYSTEM_PROMPT)).toBe(true);
	});

	test("appends pi skills XML so the model can read SKILL.md", () => {
		const prompt = buildSystemPrompt({
			skills: [
				{
					name: "feed-qa",
					description: "How to inspect the feed.",
					filePath: "/tmp/skills/feed-qa/SKILL.md",
					baseDir: "/tmp/skills/feed-qa",
					sourceInfo: { type: "folder" },
					disableModelInvocation: false,
				} as never,
			],
		});
		expect(prompt).toContain("<available_skills>");
		expect(prompt).toContain("feed-qa");
		expect(prompt).toContain("/tmp/skills/feed-qa/SKILL.md");
		expect(prompt).toContain("read tool");
	});
});

describe("hash", () => {
	test("h64/h32 are deterministic and hex-width", () => {
		expect(h64("abc")).toBe(h64("abc"));
		expect(h64("abc")).not.toBe(h64("abd"));
		expect(h64("abc").length).toBe(16);
		expect(h32("abc").length).toBe(8);
		expect(/^[0-9a-f]+$/.test(h64("abc"))).toBe(true);
	});
});

describe("sqlite adapter", () => {
	test("openSqlite :memory: round-trip", () => {
		const db = openSqlite(":memory:");
		db.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);");
		expect((db.prepare("SELECT x FROM t").get() as { x: number }).x).toBe(1);
		const tx = db.transaction(() => {
			db.prepare("INSERT INTO t VALUES (?)").run(2);
		});
		tx();
		expect((db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n).toBe(2);
		db.close();
	});
});
