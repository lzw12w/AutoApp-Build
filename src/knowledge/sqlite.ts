/**
 * SQLite handle that works in both runtimes Para actually hits:
 *
 * - `bun test` / Bun CLI → `bun:sqlite`
 * - `pi -e` (Node, jiti) → `node:sqlite` DatabaseSync
 *
 * Static `import "bun:sqlite"` would crash pi's Node loader before the
 * extension factory runs, which is how Phase 3 originally died.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface SqliteStmt {
	run(...params: unknown[]): unknown;
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
}

export interface SqliteDb {
	exec(sql: string): void;
	prepare(sql: string): SqliteStmt;
	transaction<T>(fn: () => T): () => T;
	close(): void;
}

export function isBunRuntime(): boolean {
	return typeof process.versions.bun === "string";
}

type BunDatabase = {
	exec(sql: string): void;
	query(sql: string): SqliteStmt;
	transaction<T>(fn: () => T): () => T;
	close(): void;
};

type NodeDatabase = {
	exec(sql: string): void;
	prepare(sql: string): SqliteStmt;
	close(): void;
};

export function openSqlite(path: string): SqliteDb {
	if (isBunRuntime()) {
		const mod = require("bun:sqlite") as { Database: new (path: string, opts?: { create?: boolean }) => BunDatabase };
		const db = new mod.Database(path, { create: true });
		return {
			exec: (sql) => {
				db.exec(sql);
			},
			prepare: (sql) => db.query(sql),
			transaction: (fn) => db.transaction(fn),
			close: () => {
				db.close();
			},
		};
	}

	const mod = require("node:sqlite") as { DatabaseSync: new (path: string) => NodeDatabase };
	const db = new mod.DatabaseSync(path);
	return {
		exec: (sql) => {
			db.exec(sql);
		},
		prepare: (sql) => db.prepare(sql),
		transaction: <T>(fn: () => T) => () => {
			db.exec("BEGIN");
			try {
				const out = fn();
				db.exec("COMMIT");
				return out;
			} catch (e) {
				try {
					db.exec("ROLLBACK");
				} catch {
					// ignore rollback failure
				}
				throw e;
			}
		},
		close: () => {
			db.close();
		},
	};
}
