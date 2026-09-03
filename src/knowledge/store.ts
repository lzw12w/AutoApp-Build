/**
 * KnowledgeStore — per-app SQLite persistence for the page/transition graph.
 * Ported from ios_inspector_agent/knowledge/store.py. SQLite is opened via
 * `openSqlite` so the same code runs under Bun tests and Node (pi).
 *
 * One instance == one open database file (one file per iOS bundle id).
 * Timestamps are unix milliseconds; hashes are 16-char hex strings.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PageFingerprint } from "./fingerprint.ts";
import { h32, h64 } from "./hash.ts";
import { openSqlite, type SqliteDb } from "./sqlite.ts";

export const SCHEMA_VERSION = 1;

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
    page_id          TEXT PRIMARY KEY,
    canonical_name   TEXT,
    vc_class_hint    TEXT,
    first_seen       INTEGER NOT NULL,
    last_seen        INTEGER NOT NULL,
    visit_count      INTEGER NOT NULL DEFAULT 0,
    notes            TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS fingerprints (
    fp_id            INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id          TEXT NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
    skeleton_hash    TEXT NOT NULL,
    semantic_hash    TEXT NOT NULL,
    visual_hash      TEXT,
    vc_class         TEXT,
    title            TEXT,
    key_texts_json   TEXT NOT NULL DEFAULT '[]',
    depth            INTEGER NOT NULL DEFAULT 0,
    leaf_count       INTEGER NOT NULL DEFAULT 0,
    captured_at      INTEGER NOT NULL,
    UNIQUE(page_id, skeleton_hash, semantic_hash)
);

CREATE INDEX IF NOT EXISTS idx_fp_skeleton ON fingerprints(skeleton_hash);
CREATE INDEX IF NOT EXISTS idx_fp_semantic ON fingerprints(semantic_hash);

CREATE TABLE IF NOT EXISTS transitions (
    tr_id              INTEGER PRIMARY KEY AUTOINCREMENT,
    from_page          TEXT NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
    to_page            TEXT NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
    action_type        TEXT NOT NULL,
    action_params_hash TEXT NOT NULL,
    action_params_json TEXT NOT NULL DEFAULT '{}',
    success_count      INTEGER NOT NULL DEFAULT 0,
    failure_count      INTEGER NOT NULL DEFAULT 0,
    total_latency_ms   REAL    NOT NULL DEFAULT 0.0,
    first_used         INTEGER NOT NULL,
    last_used          INTEGER NOT NULL,
    UNIQUE(from_page, to_page, action_type, action_params_hash)
);

CREATE INDEX IF NOT EXISTS idx_tr_from ON transitions(from_page);
CREATE INDEX IF NOT EXISTS idx_tr_to   ON transitions(to_page);
`;

export interface PageRecord {
	pageId: string;
	canonicalName: string | null;
	vcClassHint: string | null;
	firstSeen: number;
	lastSeen: number;
	visitCount: number;
	notes: string;
	fingerprints: PageFingerprint[];
}

export interface TransitionRecord {
	trId: number;
	fromPage: string;
	toPage: string;
	actionType: string;
	actionParams: Record<string, unknown>;
	successCount: number;
	failureCount: number;
	totalLatencyMs: number;
	firstUsed: number;
	lastUsed: number;
}

export function attemptCount(tr: TransitionRecord): number {
	return tr.successCount + tr.failureCount;
}
export function successRate(tr: TransitionRecord): number {
	const n = attemptCount(tr);
	return n ? tr.successCount / n : 0;
}
export function avgLatencyMs(tr: TransitionRecord): number {
	const n = attemptCount(tr);
	return n ? tr.totalLatencyMs / n : 0;
}

function nowMs(): number {
	return Date.now();
}

const SAFE_BUNDLE = /[^A-Za-z0-9._-]+/g;

function safeBundleId(bundleId: string): string {
	const s = bundleId.trim().replace(SAFE_BUNDLE, "_");
	return s || "unknown_app";
}

/** Stable stringify with sorted keys, matching Python's json.dumps(sort_keys). */
function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, v) => {
		if (v && typeof v === "object" && !Array.isArray(v)) {
			const sorted: Record<string, unknown> = {};
			for (const k of Object.keys(v as Record<string, unknown>).sort()) {
				sorted[k] = (v as Record<string, unknown>)[k];
			}
			return sorted;
		}
		return v;
	});
}

/**
 * Order-independent hash of action params (per-edge dedup key). If the caller
 * supplied `__identity__`, hash ONLY that subset — content-blind edge identity
 * so two taps differing only by which cell was clicked collapse into one edge.
 */
function paramsCanonicalHash(params: Record<string, unknown>): string {
	const payload =
		params && typeof params === "object" && "__identity__" in params
			? canonicalJson(params.__identity__ ?? {})
			: canonicalJson(params ?? {});
	return h64(payload);
}

/** Deterministic page id from skeleton+semantic (visual excluded). */
function newPageId(fp: PageFingerprint): string {
	return `p_${h32(`${fp.skeletonHash}:${fp.semanticHash}`)}`;
}

interface FpRow {
	skeleton_hash: string;
	semantic_hash: string;
	visual_hash: string | null;
	vc_class: string | null;
	title: string | null;
	key_texts_json: string;
	depth: number;
	leaf_count: number;
}

function rowToFp(row: FpRow): PageFingerprint {
	let keyTexts: string[] = [];
	try {
		const parsed = JSON.parse(row.key_texts_json);
		if (Array.isArray(parsed)) keyTexts = parsed.map(String);
	} catch {
		keyTexts = [];
	}
	return {
		skeletonHash: row.skeleton_hash,
		semanticHash: row.semantic_hash,
		visualHash: row.visual_hash,
		vcClass: row.vc_class ?? "",
		title: row.title,
		keyTexts,
		depth: row.depth,
		leafCount: row.leaf_count,
	};
}

interface TrRow {
	tr_id: number;
	from_page: string;
	to_page: string;
	action_type: string;
	action_params_json: string;
	success_count: number;
	failure_count: number;
	total_latency_ms: number;
	first_used: number;
	last_used: number;
}

function rowToTransition(row: TrRow): TransitionRecord {
	let params: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(row.action_params_json);
		if (parsed && typeof parsed === "object") params = parsed;
	} catch {
		params = {};
	}
	return {
		trId: row.tr_id,
		fromPage: row.from_page,
		toPage: row.to_page,
		actionType: row.action_type,
		actionParams: params,
		successCount: row.success_count,
		failureCount: row.failure_count,
		totalLatencyMs: row.total_latency_ms,
		firstUsed: row.first_used,
		lastUsed: row.last_used,
	};
}

export class KnowledgeStore {
	private db: SqliteDb;

	constructor(dbPath: string) {
		this.db = openSqlite(dbPath);
		this.initSchema();
	}

	static forApp(bundleId: string, root?: string): KnowledgeStore {
		const base = root ?? join(homedir(), ".para", "knowledge");
		mkdirSync(base, { recursive: true });
		return new KnowledgeStore(join(base, `${safeBundleId(bundleId)}.db`));
	}

	close(): void {
		this.db.close();
	}

	private initSchema(): void {
		this.db.exec(SCHEMA);
		const now = nowMs();
		this.db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)").run("schema_version", String(SCHEMA_VERSION));
		this.db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)").run("created_at", String(now));
		this.migrate();
	}

	private migrate(): void {
		const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null;
		const version = row ? Number.parseInt(row.value, 10) : SCHEMA_VERSION;
		if (version > SCHEMA_VERSION) {
			throw new Error(`DB schema v${version} is newer than this code (v${SCHEMA_VERSION}). Upgrade the agent.`);
		}
	}

	getMeta(key: string): string | null {
		const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
		return row ? row.value : null;
	}

	setMeta(key: string, value: string): void {
		this.db
			.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
			.run(key, value);
	}

	/** Insert a new page or attach this fingerprint to an existing one. Returns the page_id. */
	upsertPage(fp: PageFingerprint, options: { name?: string | null; existingPageId?: string | null } = {}): string {
		const pageId = options.existingPageId || newPageId(fp);
		const now = nowMs();
		const tx = this.db.transaction(() => {
			this.db
				.prepare(
					`INSERT INTO pages(page_id, canonical_name, vc_class_hint, first_seen, last_seen, visit_count, notes)
					 VALUES (?, ?, ?, ?, ?, 1, '')
					 ON CONFLICT(page_id) DO UPDATE SET
					   last_seen = excluded.last_seen,
					   visit_count = pages.visit_count + 1,
					   canonical_name = COALESCE(excluded.canonical_name, pages.canonical_name),
					   vc_class_hint = COALESCE(pages.vc_class_hint, excluded.vc_class_hint)`,
				)
				.run(pageId, options.name ?? null, fp.vcClass || null, now, now);
			this.db
				.prepare(
					`INSERT OR IGNORE INTO fingerprints(
					   page_id, skeleton_hash, semantic_hash, visual_hash,
					   vc_class, title, key_texts_json, depth, leaf_count, captured_at
					 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					pageId,
					fp.skeletonHash,
					fp.semanticHash,
					fp.visualHash,
					fp.vcClass,
					fp.title,
					JSON.stringify(fp.keyTexts),
					fp.depth,
					fp.leafCount,
					now,
				);
		});
		tx();
		return pageId;
	}

	getPage(pageId: string, withFingerprints = true): PageRecord | null {
		const row = this.db.prepare("SELECT * FROM pages WHERE page_id = ?").get(pageId) as
			| { page_id: string; canonical_name: string | null; vc_class_hint: string | null; first_seen: number; last_seen: number; visit_count: number; notes: string }
			| null;
		if (!row) return null;
		let fingerprints: PageFingerprint[] = [];
		if (withFingerprints) {
			const fpRows = this.db.prepare("SELECT * FROM fingerprints WHERE page_id = ? ORDER BY captured_at").all(pageId) as FpRow[];
			fingerprints = fpRows.map(rowToFp);
		}
		return {
			pageId: row.page_id,
			canonicalName: row.canonical_name,
			vcClassHint: row.vc_class_hint,
			firstSeen: row.first_seen,
			lastSeen: row.last_seen,
			visitCount: row.visit_count,
			notes: row.notes,
			fingerprints,
		};
	}

	listPages(limit = 100): PageRecord[] {
		const rows = this.db.prepare("SELECT page_id FROM pages ORDER BY last_seen DESC LIMIT ?").all(limit) as { page_id: string }[];
		return rows.map((r) => this.getPage(r.page_id)).filter((p): p is PageRecord => p !== null);
	}

	findPagesByVcClass(vcClass: string): PageRecord[] {
		if (!vcClass) return [];
		const rows = this.db
			.prepare("SELECT DISTINCT page_id FROM fingerprints WHERE vc_class = ? ORDER BY captured_at")
			.all(vcClass) as { page_id: string }[];
		return rows.map((r) => this.getPage(r.page_id)).filter((p): p is PageRecord => p !== null);
	}

	findPagesBySkeleton(skeletonHash: string): PageRecord[] {
		const rows = this.db.prepare("SELECT DISTINCT page_id FROM fingerprints WHERE skeleton_hash = ?").all(skeletonHash) as {
			page_id: string;
		}[];
		return rows.map((r) => this.getPage(r.page_id)).filter((p): p is PageRecord => p !== null);
	}

	renamePage(pageId: string, name: string): void {
		this.db.prepare("UPDATE pages SET canonical_name = ? WHERE page_id = ?").run(name, pageId);
	}

	appendNote(pageId: string, note: string): void {
		const row = this.db.prepare("SELECT notes FROM pages WHERE page_id = ?").get(pageId) as { notes: string } | null;
		if (!row) return;
		const combined = row.notes ? `${row.notes}\n${note}` : note;
		this.db.prepare("UPDATE pages SET notes = ? WHERE page_id = ?").run(combined, pageId);
	}

	deletePage(pageId: string): void {
		this.db.prepare("DELETE FROM pages WHERE page_id = ?").run(pageId);
	}

	/** Record one observed transition. Returns the tr_id of the row. */
	recordTransition(
		fromPage: string,
		toPage: string,
		options: {
			actionType: string;
			actionParams?: Record<string, unknown>;
			success?: boolean;
			latencyMs?: number;
		},
	): number {
		const params = options.actionParams ?? {};
		const paramsHash = paramsCanonicalHash(params);
		const publicParams: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(params)) {
			if (k !== "__identity__") publicParams[k] = v;
		}
		const paramsJson = canonicalJson(publicParams);
		const now = nowMs();
		const success = options.success ?? true;
		const succInc = success ? 1 : 0;
		const failInc = success ? 0 : 1;
		const latencyMs = options.latencyMs ?? 0;

		const tx = this.db.transaction(() => {
			this.db
				.prepare(
					`INSERT INTO transitions(
					   from_page, to_page, action_type, action_params_hash, action_params_json,
					   success_count, failure_count, total_latency_ms, first_used, last_used
					 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(from_page, to_page, action_type, action_params_hash)
					 DO UPDATE SET
					   success_count = transitions.success_count + ?,
					   failure_count = transitions.failure_count + ?,
					   total_latency_ms = transitions.total_latency_ms + ?,
					   action_params_json = excluded.action_params_json,
					   last_used = excluded.last_used`,
				)
				.run(
					fromPage,
					toPage,
					options.actionType,
					paramsHash,
					paramsJson,
					succInc,
					failInc,
					latencyMs,
					now,
					now,
					succInc,
					failInc,
					latencyMs,
				);
		});
		tx();
		const row = this.db
			.prepare("SELECT tr_id FROM transitions WHERE from_page = ? AND to_page = ? AND action_type = ? AND action_params_hash = ?")
			.get(fromPage, toPage, options.actionType, paramsHash) as { tr_id: number };
		return row.tr_id;
	}

	edgesFrom(pageId: string): TransitionRecord[] {
		const rows = this.db.prepare("SELECT * FROM transitions WHERE from_page = ? ORDER BY last_used DESC").all(pageId) as TrRow[];
		return rows.map(rowToTransition);
	}

	edgesTo(pageId: string): TransitionRecord[] {
		const rows = this.db.prepare("SELECT * FROM transitions WHERE to_page = ? ORDER BY last_used DESC").all(pageId) as TrRow[];
		return rows.map(rowToTransition);
	}

	allEdges(): TransitionRecord[] {
		const rows = this.db.prepare("SELECT * FROM transitions").all() as TrRow[];
		return rows.map(rowToTransition);
	}

	stats(): { pages: number; fingerprints: number; transitions: number } {
		const count = (table: string): number => {
			const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
			return row.n;
		};
		return { pages: count("pages"), fingerprints: count("fingerprints"), transitions: count("transitions") };
	}
}
