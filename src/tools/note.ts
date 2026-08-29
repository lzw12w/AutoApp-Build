/**
 * NOTE.md project-knowledge writer. Ported from
 * ios_inspector_agent/actions/record_knowledge.py.
 *
 * Distinct from the knowledge-graph page notes (`annotate_page`): this file
 * is the session-level experience store injected as <project_knowledge>.
 * Callers snapshot the body at session start so a mid-session write does
 * not rewrite the live system prompt.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { InspectorError } from "../errors.ts";
import { errResult, okResult } from "./result.ts";

const PREFERRED_SECTIONS = ["业务概念", "UI 约定", "命名习惯", "已知陷阱"] as const;

type Details = { ok: boolean } & Record<string, unknown>;

function readNote(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

export function parseNoteSections(text: string): {
	preamble: string[];
	sections: Map<string, string[]>;
	order: string[];
} {
	const preamble: string[] = [];
	const sections = new Map<string, string[]>();
	const order: string[] = [];
	let current: string | null = null;
	for (const line of text.split("\n")) {
		if (line.startsWith("## ")) {
			current = line.slice(3).trim();
			if (!sections.has(current)) {
				sections.set(current, []);
				order.push(current);
			}
			continue;
		}
		if (current === null) preamble.push(line);
		else sections.get(current)!.push(line);
	}
	return { preamble, sections, order };
}

function trimBlankEdges(lines: string[]): string[] {
	const out = [...lines];
	while (out.length > 0 && out[0]!.trim() === "") out.shift();
	while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
	return out;
}

export function renderNote(preamble: string[], sections: Map<string, string[]>, order: string[]): string {
	const out: string[] = [];
	let pre = [...preamble];
	while (pre.length > 0 && pre[pre.length - 1]!.trim() === "") pre.pop();
	if (pre.length > 0) {
		out.push(...pre, "");
	}
	for (const sec of order) {
		const body = trimBlankEdges(sections.get(sec) ?? []);
		out.push(`## ${sec}`, ...body, "");
	}
	return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

export function orderedSectionNames(existingOrder: string[], newSection: string): string[] {
	const order = existingOrder.includes(newSection) ? [...existingOrder] : [...existingOrder, newSection];
	const seen = new Set(order);
	const preferred = PREFERRED_SECTIONS.filter((s) => seen.has(s));
	const rest = order.filter((s) => !(PREFERRED_SECTIONS as readonly string[]).includes(s));
	return [...preferred, ...rest];
}

export function normalizeEntry(entry: string): string {
	let s = entry.trim();
	for (const prefix of ["- ", "* ", "• "]) {
		if (s.startsWith(prefix)) {
			s = s.slice(prefix.length).trim();
			break;
		}
	}
	return s;
}

export function writeNoteEntry(
	path: string,
	args: { section: string; entry: string; rationale: string },
): { status: "written" | "duplicate"; section: string; entry: string; path: string; bytes?: number; message?: string } {
	const section = args.section.trim();
	const entry = args.entry.trim();
	const rationale = args.rationale.trim();
	if (!section) throw new InspectorError("section is empty", "E_BAD_INPUT");
	if (!entry) throw new InspectorError("entry is empty", "E_BAD_INPUT");

	mkdirSync(dirname(path), { recursive: true });
	const { preamble, sections, order } = parseNoteSections(readNote(path));
	const body = sections.get(section) ?? [];
	if (!sections.has(section)) sections.set(section, body);

	const normalizedNew = normalizeEntry(entry);
	for (const line of body) {
		if (normalizeEntry(line) === normalizedNew && normalizedNew) {
			return {
				status: "duplicate",
				section,
				entry,
				path,
				message: "an identical entry already exists in this section; skipped.",
			};
		}
	}

	body.push(`- ${entry}`);
	if (rationale) {
		const ts = new Date().toISOString().slice(0, 10);
		body.push(`  - _why_: ${rationale} (${ts})`);
	}

	const nextOrder = orderedSectionNames(order, section);
	const newText = renderNote(preamble, sections, nextOrder);
	writeFileSync(path, newText, "utf8");
	return { status: "written", section, entry, path, bytes: Buffer.byteLength(newText, "utf8") };
}

export function recordKnowledgeTool(notePath: string) {
	return defineTool({
		name: "record_knowledge",
		label: "Record knowledge",
		description:
			"Append a one-line, reusable project convention to NOTE.md. " +
			"Use ONLY for durable knowledge learned from a user correction or a " +
			"trial-then-success loop (e.g. 'send button's aid is icon_send_2'). " +
			"Do NOT use for one-shot conversation, transient UI state, or facts " +
			"already present in <project_knowledge>. The write is gated by user " +
			"confirmation; pass user_confirm=true with a brief rationale. " +
			"Mid-session writes do not appear in <project_knowledge> until the next session. " +
			"To name the current page in the knowledge graph, use annotate_page instead.",
		parameters: Type.Object({
			section: Type.String({
				description: "Section heading (e.g. '业务概念', 'UI 约定', '命名习惯', '已知陷阱'). New sections are appended after the canonical ones.",
			}),
			entry: Type.String({
				description: "A single-sentence convention. Stored as a markdown bullet under the section.",
			}),
			rationale: Type.String({
				description: "Why this is worth recording (the trial that failed, the user correction). Stored inline as a sub-bullet.",
			}),
			user_confirm: Type.Boolean({
				description: "MUST be true. Defense-in-depth so a misbehaving client cannot persist knowledge silently.",
			}),
		}),
		execute: async (_id, params) => {
			try {
				if (!params.user_confirm) {
					throw new InspectorError("user_confirm must be true to persist knowledge.", "E_CONFIRM_REQUIRED");
				}
				return okResult<Details>(writeNoteEntry(notePath, params));
			} catch (e) {
				return errResult<Details>(e);
			}
		},
	});
}
