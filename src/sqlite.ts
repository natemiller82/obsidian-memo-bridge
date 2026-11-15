// SQLite via Node's built-in node:sqlite (Electron 43 / Node 24 in Obsidian 1.14).
// It is real SQLite, so a copied database + its -wal is read correctly (the WAL is
// applied on open), which a pure-WASM in-memory reader could not do.
import type * as NodeSqlite from "node:sqlite";

export type Database = NodeSqlite.DatabaseSync;

let mod: typeof NodeSqlite | null | undefined;

/** Load node:sqlite, or return null if this Obsidian/Electron build lacks it. */
export function loadSqlite(): typeof NodeSqlite | null {
  if (mod !== undefined) return mod;
  try {
    // Synchronous, no require(): returns undefined when this runtime has no node:sqlite. Runtimes
    // too old for getBuiltinModule (before Node 22.3) predate node:sqlite (22.5) as well.
    const get = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    mod = (get?.call(process, "node:sqlite") as typeof NodeSqlite | undefined) ?? null;
  } catch {
    mod = null;
  }
  return mod;
}

export class SqliteUnavailable extends Error {
  constructor() {
    super("this Obsidian build has no node:sqlite; Memo Bridge needs Obsidian desktop installed with installer 1.9.12 or newer");
  }
}

export function open(file: string, opts: { readOnly?: boolean } = {}): Database {
  const m = loadSqlite();
  if (!m) throw new SqliteUnavailable();
  return new m.DatabaseSync(file, { readOnly: opts.readOnly ?? false });
}

export function columns(db: Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

export function tableExists(db: Database, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}
