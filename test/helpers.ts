// Test environment built from the synthetic fixtures in test/fixtures (sanitised test
// notes with fake ids) plus a synthetic Storage.sqlite. No real notes are involved.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { MemoryLogger } from "../src/log";
import { DataPaths } from "../src/paths";
import { InlineRenderer } from "../src/render/renderer";
import { LocalStateSource } from "../src/source";
import { State } from "../src/state";
import { SyncEngine, type SyncConfig } from "../src/sync";
import { FsVault, NoteIndex } from "../src/vaultio";

const require = createRequire(import.meta.url);
export const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const WASM = fs.readFileSync(require.resolve("@twango/sdocx/sdocx_bg.wasm"));
export const sharedRenderer = new InlineRenderer(() => new Uint8Array(WASM));

// Fixture notes (fake ids). Content: the throwaway pen-test notes.
export const ID = {
  mixed: "f1f1f1f1-0000-4000-0000-00000000f001",      // fountain pen + typed "Test in txt"
  scribble2p: "f1f1f1f1-0000-4000-0000-00000000f002", // brush + calligraphy pen, 2 pages
  pencil: "f1f1f1f1-0000-4000-0000-00000000f003",     // pencil scribbles (in the Screen off memo folder)
  pens: "f1f1f1f1-0000-4000-0000-00000000f004",       // "Pen", "fountain pen", "Calligraphy pen"
  pens2: "f1f1f1f1-0000-4000-0000-00000000f005",      // pencil, brush, highlighter, marker (+ blank page 2)
  suffix: "f1f1f1f1-0000-4000-0000-0000000000a1_screenoff", // copy of `pencil`, screen-off by id suffix
  legacy: "f1f1f1f1-0000-4000-0000-0000000000b2",     // copy of `pencil` with a broken media manifest
  sdoc: "f1f1f1f1-0000-4000-0000-0000000000c3",       // old-format duplicate row
  trashed: "f1f1f1f1-0000-4000-0000-0000000000d4",
  locked: "f1f1f1f1-0000-4000-0000-0000000000e5",
};

export const FOLDER = { todo: "f1f1f1f1-0000-4000-0000-00000000f001", work: "f1f1f1f1-0000-4000-0000-00000000f002", meetings: "f1f1f1f1-0000-4000-0000-00000000f003" };

const T0 = 1794290000000;   // fixture-era timestamp (ms)

export interface Row {
  UUID: string; CategoryUUID: string; DocumentType: number; Title: string; IsDefaultTitle: number;
  DeletedStatus: number; IsLocked: number; CreatedAt: number; LastModifiedAt: number; StrippedContent: string;
  LockAccountGuid?: string;
  folderFrom?: string; breakManifest?: boolean;
}

/**
 * Mirrors real libraries: Samsung stores the account's key id in LockAccountGuid on nearly every
 * current-format note (995 of 999 in the survey) while IsLocked stays 0; notes converted locally
 * from the old format and old-format rows have it empty. Fake value, real shape (64 hex chars).
 */
export const FAKE_ACCOUNT_KEY = "ab".repeat(32);

export function defaultRows(): Row[] {
  const r = (UUID: string, extra: Partial<Row> = {}): Row => ({
    UUID, CategoryUUID: "uncategorized:///", DocumentType: 0, Title: "", IsDefaultTitle: 1, DeletedStatus: 0, IsLocked: 0,
    CreatedAt: T0, LastModifiedAt: T0, StrippedContent: "", LockAccountGuid: FAKE_ACCOUNT_KEY, ...extra,
  });
  return [
    r(ID.mixed, { CreatedAt: T0 + 1000, LastModifiedAt: T0 + 1000, StrippedContent: "\n\nTest in txt\n" }),
    r(ID.scribble2p, { CategoryUUID: FOLDER.todo, CreatedAt: T0 + 2000, LastModifiedAt: T0 + 2000 }),
    r(ID.pencil, { CategoryUUID: "screenOffMemo:///", CreatedAt: T0 + 3000, LastModifiedAt: T0 + 3000 }),
    r(ID.pens, { CategoryUUID: FOLDER.meetings, Title: "Pen test", IsDefaultTitle: 0, CreatedAt: T0 + 4000, LastModifiedAt: T0 + 4000 }),
    r(ID.pens2, { CreatedAt: T0 + 5000, LastModifiedAt: T0 + 5000 }),
    r(ID.suffix, { folderFrom: ID.pencil, CreatedAt: T0 + 6000, LastModifiedAt: T0 + 6000 }),
    r(ID.legacy, { LockAccountGuid: "", folderFrom: ID.pencil, breakManifest: true, CreatedAt: T0 - 9e8, LastModifiedAt: T0 - 9e8, StrippedContent: "old typed text" }),
    r(ID.sdoc, { LockAccountGuid: "", DocumentType: 1, CreatedAt: T0 + 1000, LastModifiedAt: T0 + 1000 }),
    r(ID.trashed, { folderFrom: ID.pens, DeletedStatus: 2, CreatedAt: T0 + 7000, LastModifiedAt: T0 + 7000 }),
    r(ID.locked, { folderFrom: ID.pens, IsLocked: 1, CreatedAt: T0 + 8000, LastModifiedAt: T0 + 8000 }),
  ];
}

export function ageTree(dir: string, seconds = 3600) {
  const t = new Date(Date.now() - seconds * 1000);
  const rec = (p: string) => {
    if (fs.statSync(p).isDirectory()) for (const c of fs.readdirSync(p)) rec(path.join(p, c));
    fs.utimesSync(p, t, t);
  };
  rec(dir);
}

export class Env {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memo-bridge-test-"));
  localState = path.join(this.root, "LocalState");
  vaultDir = path.join(this.root, "vault");
  data = new DataPaths(path.join(this.root, "data"));
  log = new MemoryLogger();
  vault = new FsVault(this.vaultDir);
  index = new NoteIndex();
  state: State;
  source: LocalStateSource;
  engine: SyncEngine;
  rows: Row[];

  constructor(opts: { rows?: Row[]; cfg?: Partial<SyncConfig>; wal?: boolean; copyFile?: (s: string, d: string) => void } = {}) {
    fs.mkdirSync(this.vaultDir, { recursive: true });
    this.rows = opts.rows ?? defaultRows();
    this.writeLocalState(opts.wal ?? false);
    this.state = new State(this.data.stateDb);
    this.source = new LocalStateSource(this.localState, this.data.snapDir, this.log,
      { baseDelayMs: 1, sleep: async () => {}, copyFile: opts.copyFile });
    this.engine = new SyncEngine({
      source: this.source, vault: this.vault, state: this.state, renderer: sharedRenderer, index: this.index,
      data: this.data, log: this.log,
    }, { ...baseConfig(), ...(opts.cfg ?? {}) });
  }

  private writeLocalState(wal: boolean) {
    const wdoc = path.join(this.localState, "wdoc"), thumbs = path.join(this.localState, "Thumbnail");
    fs.mkdirSync(wdoc, { recursive: true });
    fs.mkdirSync(thumbs, { recursive: true });
    for (const r of this.rows) {
      if (r.DocumentType !== 0) continue;
      const src = r.folderFrom ?? r.UUID;
      const dst = path.join(wdoc, r.UUID);
      fs.cpSync(path.join(FIX, "notes", src), dst, { recursive: true });
      if (r.breakManifest) fs.writeFileSync(path.join(dst, "media", "mediaInfo.dat"), Buffer.from([1, 0, 0]));
      fs.copyFileSync(path.join(FIX, "thumbnails", `${src}.jpg`), path.join(thumbs, `${r.UUID}.jpg`));
      ageTree(dst);
    }
    this.db = new DatabaseSync(path.join(this.localState, "Storage.sqlite"));
    if (wal) this.db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    this.db.exec(`CREATE TABLE NoteDB (Id INTEGER PRIMARY KEY, UUID TEXT, CategoryUUID TEXT, DocumentType INTEGER, Title TEXT,
      IsDefaultTitle INTEGER, DeletedStatus INTEGER, IsFolderDeleted INTEGER DEFAULT 0, IsLocked INTEGER, LockAccountGuid TEXT DEFAULT '',
      ContentSecureVersion INTEGER DEFAULT 0, CreatedAt INTEGER, LastModifiedAt INTEGER, FilePath TEXT, ThumbnailPath TEXT, StrippedContent TEXT);
      CREATE TABLE CategoryTreeDB (UUID TEXT PRIMARY KEY, ParentUUID TEXT, DisplayName TEXT, IsDeleted INTEGER DEFAULT 0);`);
    const tree = this.db.prepare("INSERT INTO CategoryTreeDB (UUID, ParentUUID, DisplayName) VALUES (?,?,?)");
    tree.run("uncategorized:///", "", "Folders");
    tree.run("screenOffMemo:///", "uncategorized:///", "Screen off memo\u200b");
    tree.run(FOLDER.todo, "uncategorized:///", "To Do");
    tree.run(FOLDER.work, "uncategorized:///", "Work");
    tree.run(FOLDER.meetings, FOLDER.work, "Meetings");
    for (const r of this.rows) this.insert(r);
    if (!wal) this.db.close();
  }

  db!: DatabaseSync;

  insert(r: Row) {
    this.db.prepare(`INSERT INTO NoteDB (UUID, CategoryUUID, DocumentType, Title, IsDefaultTitle, DeletedStatus, IsLocked, LockAccountGuid,
      CreatedAt, LastModifiedAt, FilePath, ThumbnailPath, StrippedContent) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      r.UUID, r.CategoryUUID, r.DocumentType, r.Title, r.IsDefaultTitle, r.DeletedStatus, r.IsLocked, r.LockAccountGuid ?? "",
      r.CreatedAt, r.LastModifiedAt,
      `C:\\Users\\someone\\AppData\\Local\\Packages\\x\\LocalState\\wdoc\\${r.UUID}`,
      `C:\\Users\\someone\\AppData\\Local\\Packages\\x\\LocalState\\Thumbnail\\${r.UUID}.jpg`, r.StrippedContent);
  }

  /** Add a NoteDB row to the (closed) Samsung database. */
  insertRow(r: Row) {
    this.db = new DatabaseSync(path.join(this.localState, "Storage.sqlite"));
    this.insert(r);
    this.db.close();
    fs.copyFileSync(path.join(FIX, "thumbnails", `${r.folderFrom ?? r.UUID}.jpg`), path.join(this.localState, "Thumbnail", `${r.UUID}.jpg`));
    this.engine.invalidate();
  }

  /** Simulate Samsung changing a note: bump LastModifiedAt and touch its folder (then let it settle). */
  samsungEdit(id: string, settle = true) {
    const db = this.db?.isOpen ? this.db : new DatabaseSync(path.join(this.localState, "Storage.sqlite"));
    const row = db.prepare("SELECT LastModifiedAt FROM NoteDB WHERE UUID=?").get(id) as { LastModifiedAt: number };
    db.prepare("UPDATE NoteDB SET LastModifiedAt=? WHERE UUID=?").run(row.LastModifiedAt + 60_000, id);
    if (db !== this.db) db.close();
    const dir = path.join(this.localState, "wdoc", id);
    fs.writeFileSync(path.join(dir, "end_tag.bin"), fs.readFileSync(path.join(dir, "end_tag.bin")));
    if (settle) ageTree(dir);
    this.engine.invalidate();
  }

  noteFolder(id: string) { return path.join(this.localState, "wdoc", id); }

  async mdFiles() { return (await this.vault.listMarkdown()).sort(); }

  read(p: string) { return fs.readFileSync(path.join(this.vaultDir, ...p.split("/")), "utf8"); }

  dispose() {
    try { this.state.close(); } catch { /* closed */ }
    try { if (this.db?.isOpen) this.db.close(); } catch { /* closed */ }
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

export function baseConfig(): SyncConfig {
  return {
    rootFolder: "Samsung Notes", screenOffOnly: false, dateField: "created", sinceMs: null, untilMs: null,
    includeFolders: [], excludeFolders: [], settleMs: 20_000, inkScale: 2.6, padding: 48, radius: 28,
    renderTimeoutMs: 60_000,
  };
}

export function frontmatter(md: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  const out: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim().replace(/^'(.*)'$/, "$1").replace(/''/g, "'");
  }
  return out;
}

export { T0 };
