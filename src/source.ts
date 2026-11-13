// Note acquisition. NoteSource is the seam; LocalStateSource reads the Samsung Notes
// Windows app's LocalState folder. That folder is never written: the database is
// copied (with its -wal/-shm) into our snapshot directory and only the copy is opened.
import * as fs from "node:fs";
import * as path from "node:path";
import { columns, open, tableExists } from "./sqlite";
import type { Logger } from "./log";
import { zipStored, type ZipEntry } from "./zip";

export const SCREEN_OFF_CATEGORY = "screenOffMemo:///";
export const SCREEN_OFF_SUFFIX = "_screenoff";
export const ROOT_CATEGORY = "uncategorized:///";
const DB = "Storage.sqlite";

export interface SourceNote {
  id: string;
  createdMs: number;
  modifiedMs: number;
  /** In Samsung's trash (note or its folder). */
  trashed: boolean;
  locked: boolean;
  isScreenOff: boolean;
  /** Real, user-given title; "" when Samsung shows a default/derived one. */
  title: string;
  /** Samsung folder path below the root, e.g. ["Screen off memo"]; [] = no folder. */
  folder: string[];
  /** Samsung's plain-text copy of typed text (used when the package can't be parsed). */
  plainText: string;
  /** Old .sdoc format; always a duplicate of a converted current-format note. */
  legacySdoc: boolean;
}

export type SettleStatus = "missing" | "incomplete" | "settling" | "ready";

export interface MediaFile { name: string; data: Uint8Array }

export interface NoteSource {
  readonly label: string;
  /** Problem that stops syncing entirely (e.g. folder missing), or null. */
  unavailable(): string | null;
  /** Cheap change detector (a few stat calls). */
  fingerprint(): string;
  /** Snapshot + query. Throws SnapshotError if no consistent snapshot could be read. */
  listNotes(): Promise<SourceNote[]>;
  settle(note: SourceNote, settleMs: number, nowMs?: number): SettleStatus;
  /** The note as an .sdocx package. */
  packageNote(note: SourceNote): Uint8Array;
  /** Images/PDFs/audio stored with the note (not Samsung's own stroke previews). */
  media(note: SourceNote): MediaFile[];
  thumbnail(note: SourceNote): Uint8Array | null;
}

export class SnapshotError extends Error {}

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

interface Row {
  UUID: string; CreatedAt: number | null; LastModifiedAt: number | null;
  DeletedStatus: number | null; IsFolderDeleted: number | null; IsLocked: number | null;
  LockAccountGuid: string | null; ContentSecureVersion: number | null;
  CategoryUUID: string | null; FilePath: string | null; ThumbnailPath: string | null;
  StrippedContent: string | null; Title: string | null; IsDefaultTitle: number | null;
  DocumentType: number | null;
}
const WANTED: (keyof Row)[] = ["UUID", "CreatedAt", "LastModifiedAt", "DeletedStatus", "IsFolderDeleted",
  "IsLocked", "LockAccountGuid", "ContentSecureVersion", "CategoryUUID", "FilePath", "ThumbnailPath",
  "StrippedContent", "Title", "IsDefaultTitle", "DocumentType"];

export class LocalStateSource implements NoteSource {
  readonly label = "Samsung Notes LocalState";
  private folders = new Map<string, string>();     // note id -> wdoc folder
  private thumbs = new Map<string, string>();

  constructor(readonly localState: string, private snapDir: string, private log: Logger,
              private opts: { attempts?: number; baseDelayMs?: number; sleep?: Sleep; copyFile?: (src: string, dst: string) => void } = {}) {}

  unavailable(): string | null {
    if (!fs.existsSync(path.join(this.localState, DB)))
      return `Samsung Notes data not found at ${this.localState} (is the Samsung Notes app installed and signed in?)`;
    return null;
  }

  fingerprint(): string {
    const parts: string[] = [];
    for (const p of [DB, `${DB}-wal`, "wdoc"]) {
      try {
        const st = fs.statSync(path.join(this.localState, p));
        parts.push(`${p}:${st.mtimeMs}:${st.size}`);
      } catch {
        parts.push(`${p}:-`);
      }
    }
    return parts.join("|");
  }

  private statAll(): string {
    return [DB, `${DB}-wal`, `${DB}-shm`].map((s) => {
      try { const st = fs.statSync(path.join(this.localState, s)); return `${st.mtimeMs}:${st.size}`; } catch { return "-"; }
    }).join("|");
  }

  /** Copy DB + -wal + -shm; the copy must be consistent (no source change mid-copy) and pass quick_check. */
  private copyOnce(): string {
    fs.mkdirSync(this.snapDir, { recursive: true });
    const before = this.statAll();
    for (const s of ["", "-wal", "-shm"]) {
      const src = path.join(this.localState, DB + s), dst = path.join(this.snapDir, DB + s);
      if (fs.existsSync(src)) (this.opts.copyFile ?? fs.copyFileSync)(src, dst);
      else if (fs.existsSync(dst)) fs.rmSync(dst);
    }
    if (this.statAll() !== before) throw new SnapshotError("database changed while copying");
    const snap = path.join(this.snapDir, DB);
    const db = open(snap);            // read-write on the copy, so SQLite applies the copied -wal
    try {
      const qc = db.prepare("PRAGMA quick_check").get() as Record<string, unknown>;
      const v = Object.values(qc)[0];
      if (v !== "ok") throw new SnapshotError(`snapshot failed quick_check: ${String(v)}`);
      db.prepare("SELECT count(*) FROM NoteDB").get();
    } finally {
      db.close();
    }
    return snap;
  }

  async snapshot(): Promise<string> {
    const attempts = this.opts.attempts ?? 5, base = this.opts.baseDelayMs ?? 500, sleep = this.opts.sleep ?? realSleep;
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return this.copyOnce();
      } catch (e) {
        if (!fs.existsSync(path.join(this.localState, DB))) throw new SnapshotError(`${DB} disappeared`);
        last = e;
        const delay = base * 2 ** i * (0.75 + Math.random() / 2);
        this.log.warn(`snapshot attempt ${i + 1}/${attempts} failed (${(e as Error).message}); retrying in ${(delay / 1000).toFixed(1)}s`);
        await sleep(delay);
      }
    }
    throw new SnapshotError(`could not read a consistent copy of the Samsung Notes database after ${attempts} attempts: ${(last as Error)?.message}`);
  }

  async listNotes(): Promise<SourceNote[]> {
    const snap = await this.snapshot();
    const db = open(snap, { readOnly: true });
    try {
      const have = columns(db, "NoteDB");
      const sel = WANTED.map((c) => (have.has(c) ? `"${c}"` : `NULL AS "${c}"`)).join(", ");
      const rows = db.prepare(`SELECT ${sel} FROM NoteDB`).all() as unknown as Row[];
      const tree = new Map<string, { parent: string; name: string; deleted: boolean }>();
      if (tableExists(db, "CategoryTreeDB")) {
        const tc = columns(db, "CategoryTreeDB");
        const del = tc.has("IsDeleted") ? "IsDeleted" : "0";
        for (const r of db.prepare(`SELECT UUID, ParentUUID, DisplayName, ${del} AS del FROM CategoryTreeDB`).all() as
            { UUID: string; ParentUUID: string | null; DisplayName: string | null; del: number | null }[]) {
          tree.set(r.UUID, { parent: r.ParentUUID ?? "", name: cleanName(r.DisplayName ?? ""), deleted: !!r.del });
        }
      }
      this.folders.clear();
      this.thumbs.clear();
      return rows.map((r) => this.toNote(r, tree));
    } finally {
      db.close();
    }
  }

  private toNote(r: Row, tree: Map<string, { parent: string; name: string; deleted: boolean }>): SourceNote {
    const cat = r.CategoryUUID ?? ROOT_CATEGORY;
    const segs: string[] = [];
    let folderTrashed = false;
    for (let u = cat, guard = 0; u && u !== ROOT_CATEGORY && guard < 32; guard++) {
      const n = tree.get(u);
      if (!n) break;
      folderTrashed ||= n.deleted;
      segs.unshift(n.name || u);
      u = n.parent;
    }
    const wdoc = path.join(this.localState, "wdoc", r.UUID);
    // FilePath is absolute on the machine that wrote it; re-root its last part under our LocalState.
    const alt = r.FilePath ? path.join(this.localState, "wdoc", path.win32.basename(r.FilePath)) : null;
    this.folders.set(r.UUID, !fs.existsSync(wdoc) && alt && fs.existsSync(alt) ? alt : wdoc);
    if (r.ThumbnailPath) this.thumbs.set(r.UUID, path.join(this.localState, "Thumbnail", path.win32.basename(r.ThumbnailPath)));
    const created = Number(r.CreatedAt ?? r.LastModifiedAt ?? 0), modified = Number(r.LastModifiedAt ?? r.CreatedAt ?? 0);
    const title = (r.Title ?? "").trim();
    return {
      id: r.UUID,
      createdMs: created,
      modifiedMs: modified,
      trashed: !!r.DeletedStatus || !!r.IsFolderDeleted || folderTrashed,
      // Only IsLocked marks a locked note. LockAccountGuid is NOT a lock flag: Samsung fills it
      // with the account's key id on almost every synced note (995/999 in a real library, all
      // with IsLocked=0), and leaves it empty on notes converted locally from the old format.
      locked: !!r.IsLocked,
      isScreenOff: cat === SCREEN_OFF_CATEGORY || r.UUID.endsWith(SCREEN_OFF_SUFFIX),
      title: title && !r.IsDefaultTitle ? title : "",
      folder: segs,
      plainText: (r.StrippedContent ?? "").trim(),
      legacySdoc: (r.DocumentType ?? 0) !== 0,
    };
  }

  folderOf(note: SourceNote): string {
    return this.folders.get(note.id) ?? path.join(this.localState, "wdoc", note.id);
  }

  settle(note: SourceNote, settleMs: number, nowMs = Date.now()): SettleStatus {
    const dir = this.folderOf(note);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return "missing";
    if (!fs.existsSync(path.join(dir, "end_tag.bin"))) return "incomplete";
    let newest = fs.statSync(dir).mtimeMs;
    try {
      for (const p of walk(dir, true)) newest = Math.max(newest, fs.statSync(p).mtimeMs);
    } catch {
      return "settling";            // a file vanished mid-walk: still being written
    }
    return nowMs - newest >= settleMs ? "ready" : "settling";
  }

  packageNote(note: SourceNote): Uint8Array {
    const dir = this.folderOf(note);
    const entries: ZipEntry[] = walk(dir, false).map((p) => ({
      name: path.relative(dir, p).split(path.sep).join("/"),
      data: new Uint8Array(fs.readFileSync(p)),
    }));
    return zipStored(entries);
  }

  media(note: SourceNote): MediaFile[] {
    const dir = path.join(this.folderOf(note), "media");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && isUserMedia(e.name))
      .map((e) => ({ name: e.name, data: new Uint8Array(fs.readFileSync(path.join(dir, e.name))) }));
  }

  thumbnail(note: SourceNote): Uint8Array | null {
    const p = this.thumbs.get(note.id);
    return p && fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null;
  }
}

/** Samsung keeps its own stroke-preview tiles (.spi/.spd/.spp) and an index (.dat) in media/. */
export function isUserMedia(name: string): boolean {
  return /\.(jpe?g|png|gif|webp|bmp|heic|pdf|m4a|mp3|wav|amr|3gp|aac|ogg|mp4)$/i.test(name);
}

function walk(dir: string, includeDirs: boolean): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (includeDirs) out.push(p);
      out.push(...walk(p, includeDirs));
    } else out.push(p);
  }
  return out;
}

/** Samsung appends zero-width characters to some built-in folder names. */
export function cleanName(s: string): string {
  return s.replace(/[​-‍﻿]/g, "").trim();
}
