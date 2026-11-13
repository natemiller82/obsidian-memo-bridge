// Sync state, outside the vault. Same schema and file as the Python reference
// implementation, so notes it already synced are known here without an import step.
import * as fs from "node:fs";
import * as path from "node:path";
import { open, type Database } from "./sqlite";
import { localIso } from "./log";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
    note_id             TEXT PRIMARY KEY,
    created_ms          INTEGER NOT NULL,
    samsung_modified_ms INTEGER NOT NULL,
    revision            INTEGER NOT NULL,
    name                TEXT NOT NULL,
    md_path             TEXT NOT NULL,
    md_sha256           TEXT NOT NULL,
    render              TEXT NOT NULL,
    deleted             INTEGER NOT NULL DEFAULT 0,
    synced_at           TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS revisions (
    note_id             TEXT NOT NULL,
    revision            INTEGER NOT NULL,
    name                TEXT NOT NULL,
    md_path             TEXT NOT NULL,
    attachment_path     TEXT NOT NULL,
    sdocx_path          TEXT NOT NULL,
    png_path            TEXT,
    raw_svg_path        TEXT,
    render              TEXT NOT NULL,
    samsung_modified_ms INTEGER NOT NULL,
    reason              TEXT NOT NULL,
    written_at          TEXT NOT NULL,
    PRIMARY KEY (note_id, revision)
);
CREATE TABLE IF NOT EXISTS enrich (
    note_id          TEXT NOT NULL,
    revision         INTEGER NOT NULL,
    enricher         TEXT NOT NULL,
    enricher_version TEXT NOT NULL,
    input_sha256     TEXT NOT NULL,
    status           TEXT NOT NULL,
    outputs          TEXT,
    attempts         INTEGER NOT NULL DEFAULT 0,
    ran_at           TEXT NOT NULL,
    error            TEXT,
    PRIMARY KEY (note_id, revision, enricher)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

/** md_sha256 for a note adopted from the vault: never matches, so our updates never overwrite it. */
export const ADOPTED_HASH = "adopted-from-vault";

export interface NoteState {
  note_id: string; created_ms: number; samsung_modified_ms: number; revision: number; name: string;
  md_path: string; md_sha256: string; render: string; deleted: number; synced_at: string;
}

export interface Revision {
  note_id: string; revision: number; name: string; md_path: string; attachment_path: string;
  sdocx_path: string; png_path: string | null; raw_svg_path: string | null; render: string;
  samsung_modified_ms: number; reason: string; written_at: string;
}

export interface EnrichRow {
  note_id: string; revision: number; enricher: string; enricher_version: string; input_sha256: string;
  status: string; outputs: string | null; attempts: number; ran_at: string; error: string | null;
}

export const nowIso = () => localIso(new Date());

export class State {
  readonly db: Database;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = open(file);
    this.db.exec("PRAGMA busy_timeout = 10000");
    this.db.exec(SCHEMA);
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('schema_version', '1')").run();
  }

  close() { this.db.close(); }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); this.db.exec("COMMIT"); return r; } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  get(noteId: string): NoteState | null {
    return (this.db.prepare("SELECT * FROM notes WHERE note_id=?").get(noteId) as NoteState | undefined) ?? null;
  }

  count(): number {
    return Number((this.db.prepare("SELECT count(*) AS n FROM notes WHERE deleted=0").get() as { n: number }).n);
  }

  /** Stems we've used in a vault folder (lower-case), so new names don't collide with old ones. */
  namesIn(folder: string): Set<string> {
    const rows = this.db.prepare("SELECT name, md_path FROM revisions").all() as { name: string; md_path: string }[];
    const dir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
    return new Set(rows.filter((r) => dir(r.md_path) === folder).map((r) => r.name.toLowerCase()));
  }

  recordRevision(ns: Omit<NoteState, "synced_at">, rev: Revision): void {
    this.tx(() => {
      this.db.prepare("INSERT OR REPLACE INTO notes VALUES (?,?,?,?,?,?,?,?,?,?)").run(
        ns.note_id, ns.created_ms, ns.samsung_modified_ms, ns.revision, ns.name, ns.md_path, ns.md_sha256,
        ns.render, ns.deleted, nowIso());
      this.db.prepare("INSERT OR REPLACE INTO revisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
        rev.note_id, rev.revision, rev.name, rev.md_path, rev.attachment_path, rev.sdocx_path, rev.png_path,
        rev.raw_svg_path, rev.render, rev.samsung_modified_ms, rev.reason, rev.written_at);
    });
  }

  /** Record a note found in the vault (written before, state lost) without writing anything. */
  adopt(noteId: string, createdMs: number, modifiedMs: number, mdPath: string): void {
    const name = mdPath.slice(mdPath.lastIndexOf("/") + 1).replace(/\.md$/, "");
    this.db.prepare("INSERT OR IGNORE INTO notes VALUES (?,?,?,?,?,?,?,?,0,?)").run(
      noteId, createdMs, modifiedMs, 1, name, mdPath, ADOPTED_HASH, "adopted", nowIso());
  }

  updateMdHash(noteId: string, hash: string) {
    this.db.prepare("UPDATE notes SET md_sha256=? WHERE note_id=?").run(hash, noteId);
  }

  /** True the first time a note is seen deleted. */
  markDeleted(noteId: string): boolean {
    return Number(this.db.prepare("UPDATE notes SET deleted=1 WHERE note_id=? AND deleted=0").run(noteId).changes) > 0;
  }

  /** Notes not deleted in Samsung. */
  allNotes(): NoteState[] {
    return this.db.prepare("SELECT * FROM notes WHERE deleted=0 ORDER BY created_ms").all() as unknown as NoteState[];
  }

  latestRevision(noteId: string): Revision | null {
    return (this.db.prepare("SELECT * FROM revisions WHERE note_id=? ORDER BY revision DESC LIMIT 1").get(noteId) as
      Revision | undefined) ?? null;
  }

  allLatestRevisions(): Revision[] {
    return this.db.prepare("SELECT r.* FROM revisions r JOIN notes n ON n.note_id=r.note_id AND n.revision=r.revision " +
      "ORDER BY r.written_at").all() as unknown as Revision[];
  }

  enrichRow(noteId: string, revision: number, enricher: string): EnrichRow | null {
    return (this.db.prepare("SELECT * FROM enrich WHERE note_id=? AND revision=? AND enricher=?").get(noteId, revision, enricher) as
      EnrichRow | undefined) ?? null;
  }

  recordEnrich(noteId: string, revision: number, enricher: string, version: string, inputSha: string, status: string,
               outputs: string[], error: string | null) {
    const prev = this.enrichRow(noteId, revision, enricher);
    const same = !!prev && prev.enricher_version === version && prev.input_sha256 === inputSha;
    this.db.prepare("INSERT OR REPLACE INTO enrich VALUES (?,?,?,?,?,?,?,?,?,?)").run(
      noteId, revision, enricher, version, inputSha, status, JSON.stringify(outputs), (same ? prev!.attempts : 0) + 1, nowIso(), error);
  }

  getMeta(key: string): string | null {
    return ((this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined)?.value) ?? null;
  }

  setMeta(key: string, value: string) {
    this.db.prepare("INSERT OR REPLACE INTO meta VALUES (?,?)").run(key, value);
  }
}
