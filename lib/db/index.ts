import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

/**
 * node:sqlite wrapper. Chosen over better-sqlite3 because Node 26 ships
 * SQLite 3.54.0 built in — no native compile, no ABI risk against a very new
 * Node runtime.
 *
 * Caveat that bites everyone once: bound values must be null | number | bigint
 * | string | Uint8Array. A JS boolean throws. Use 0/1 (see `bool` helpers).
 */

let singleton: DatabaseSync | null = null;

export function nowMs(): number {
  return Date.now();
}

export function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") {
    mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/**
 * Adds a column to an existing table. SQLite has no "ADD COLUMN IF NOT EXISTS",
 * and CREATE TABLE IF NOT EXISTS silently does nothing on an existing table, so
 * upgrades need this explicit step.
 */
function ensureColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
    name: string;
  }>;
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

/**
 * Applies the schema. Written to be safe to run on every boot: all statements
 * are CREATE ... IF NOT EXISTS and the version bump only happens on change.
 */
export function migrate(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);

  // v1 -> v2: the review gate.
  ensureColumn(db, "profile", "confirmed_at", "confirmed_at INTEGER");
  ensureColumn(db, "profile", "confidence_json", "confidence_json TEXT NOT NULL DEFAULT '{}'");

  const current = (db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)
    ?.user_version;
  if (current !== SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}

export function getDb(): DatabaseSync {
  if (singleton) return singleton;
  const db = openDatabase(env.dbPath);
  migrate(db);
  singleton = db;
  return db;
}

/** Runs `fn` inside a transaction; rolls back on any throw. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* rollback can fail if the tx already aborted */
    }
    throw error;
  }
}

/** SQLite has no boolean type; everything crossing the boundary is 0/1. */
export const bool = {
  to: (value: boolean): number => (value ? 1 : 0),
  from: (value: number | bigint | null | undefined): boolean => Number(value ?? 0) === 1,
};

/** Safe JSON column parse. Returns `fallback` on null or malformed data. */
export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export type { DatabaseSync };
