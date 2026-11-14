// One poll cycle: detect changes, settle, render, write, record. Port of the Python
// Bridge, extended to all notes, folders, date ranges, text and multi-page notes.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "./log";
import { localIso } from "./log";
import type { DataPaths } from "./paths";
import { FormatError, RendererUnavailable, RenderTimeout, type Renderer } from "./render/renderer";
import type { DocRender } from "./render/core";
import { styleSvg } from "./render/style";
import { PEN_TABLE_VERSION } from "./render/pens";
import { SnapshotError, type NoteSource, type SourceNote } from "./source";
import { State, nowIso, type NoteState, type Revision } from "./state";
import { plainToMarkdown, textToMarkdown } from "./text";
import { dirOf, join, type NoteIndex, type VaultIO } from "./vaultio";
import {
  baseName, composeMarkdown, displayPath, embed, frontmatterValue, revisionName, sanitizeName, sha256, stripRevision, type NoteMarkdown,
} from "./writer";

export const MISSING_GRACE_MS = 24 * 3600 * 1000;

export interface SyncConfig {
  rootFolder: string;
  screenOffOnly: boolean;
  dateField: "created" | "modified";
  sinceMs: number | null;
  untilMs: number | null;
  /** Samsung folder paths ("A/B"); empty include = all folders. */
  includeFolders: string[];
  excludeFolders: string[];
  settleMs: number;
  inkScale: number;
  padding: number;
  radius: number;
  renderTimeoutMs: number;
}

export type Decision =
  | "new" | "update" | "unchanged" | "out-of-range" | "filtered" | "trashed" | "locked"
  | "legacy-duplicate" | "in-vault" | "failed-before" | "missing" | "pending";

export interface CycleReport {
  snapshot: boolean;
  written: string[];
  pending: string[];
  failed: string[];
  skipped: Partial<Record<Decision, number>>;
  errors: { kind: string; message: string }[];
}

const emptyReport = (): CycleReport => ({ snapshot: false, written: [], pending: [], failed: [], skipped: {}, errors: [] });

export type Rasterize = (svg: string) => Promise<Uint8Array | null>;

export interface EngineDeps {
  source: NoteSource;
  vault: VaultIO;
  state: State;
  renderer: Renderer;
  index: NoteIndex;
  data: DataPaths;
  log: Logger;
  rasterize?: Rasterize;
  /** Called after each revision is written (the recognition queue picks it up from here). */
  onRevision?: (rev: Revision) => void;
}

export const samsungFolder = (n: SourceNote) => n.folder.join("/");

export function inRange(n: SourceNote, field: "created" | "modified", since: number | null, until: number | null): boolean {
  const t = field === "created" ? n.createdMs : n.modifiedMs;
  return (since === null || t >= since) && (until === null || t <= until);
}

export function folderAllowed(n: SourceNote, include: string[], exclude: string[]): boolean {
  const f = samsungFolder(n).toLowerCase();
  const under = (p: string) => { const q = p.trim().replace(/^\/+|\/+$/g, "").toLowerCase(); return q !== "" && (f === q || f.startsWith(q + "/")); };
  const inc = include.filter((p) => p.trim());
  if (inc.length && !inc.some(under)) return false;
  return !exclude.some(under);
}

interface Built {
  render: "sdocx" | "thumbnail" | "text";
  /** sdocx couldn't render the note; this is the thumbnail/text fallback. */
  fallback?: boolean;
  content: NoteMarkdown["content"];
  pages: number;
  /** Vault attachments (file name -> bytes) and the Markdown body that embeds them. */
  attachments: { file: string; data: Uint8Array }[];
  body: (attFolder: string) => string[];
  /** Outside-vault model input. */
  rawSvgs: string[];
  modelImages: { ext: string; data: Uint8Array | null; svg?: string }[];
  renderNote: string | null;
}

export class SyncEngine {
  private lastFp: string | null = null;
  private pendingIds = new Set<string>();
  private failedAt = new Map<string, number>();     // note id -> modified ms that failed
  private logged = new Set<string>();               // one-time log lines

  constructor(private deps: EngineDeps, public cfg: SyncConfig) {}

  get hasPending() { return this.pendingIds.size > 0; }

  /** Forget the fingerprint so the next poll re-reads the database. */
  invalidate() { this.lastFp = null; }

  private once(key: string, fn: () => void) {
    if (!this.logged.has(key)) { this.logged.add(key); fn(); }
  }

  // ---- decisions -------------------------------------------------------------------

  /** What should happen to this note? (No side effects except one-time log lines.) */
  decide(n: SourceNote, range?: { since: number | null; until: number | null }): Decision {
    const { state, index, log } = this.deps;
    if (n.legacySdoc) return "legacy-duplicate";
    const ns = state.get(n.id);
    if (n.trashed) {
      if (ns && state.markDeleted(n.id)) log.info(`note ${n.id} is in Samsung's trash; vault file ${ns.md_path} left as is`);
      return "trashed";
    }
    if (n.locked) {
      this.once(`locked:${n.id}`, () => log.info(`skipping locked note ${n.id} (${samsungFolder(n) || "no folder"}); locked notes are never opened`));
      return "locked";
    }
    if (ns) return ns.samsung_modified_ms === n.modifiedMs ? "unchanged" : this.failedAt.get(n.id) === n.modifiedMs ? "failed-before" : "update";
    if (this.cfg.screenOffOnly && !n.isScreenOff) return "filtered";
    if (!folderAllowed(n, this.cfg.includeFolders, this.cfg.excludeFolders)) return "filtered";
    const r = range ?? { since: this.cfg.sinceMs, until: this.cfg.untilMs };
    if (!inRange(n, this.cfg.dateField, r.since, r.until)) return "out-of-range";
    if (index.paths(n.id).length) return "in-vault";
    if (this.failedAt.get(n.id) === n.modifiedMs) return "failed-before";
    return "new";
  }

  // ---- poll ------------------------------------------------------------------------

  async poll(force = false): Promise<CycleReport> {
    const rep = emptyReport();
    const { source, log } = this.deps;
    const problem = source.unavailable();
    if (problem) { rep.errors.push({ kind: "source", message: problem }); return rep; }
    const fp = source.fingerprint();
    if (!force && fp === this.lastFp && !this.pendingIds.size) return rep;   // idle: a few stat calls
    let notes: SourceNote[];
    try {
      notes = await source.listNotes();
    } catch (e) {
      const msg = (e as Error).message;
      log.error(`${msg}; will retry next poll`);
      rep.errors.push({ kind: e instanceof SnapshotError ? "snapshot" : "source", message: msg });
      return rep;
    }
    rep.snapshot = true;
    this.pendingIds.clear();
    let transient = false;
    for (const n of notes) {
      try {
        await this.process(n, rep);
      } catch (e) {
        if (e instanceof RendererUnavailable) {
          log.error(`renderer unavailable for ${n.id}: ${e.message} (will retry)`);
          if (!rep.errors.some((x) => x.kind === "renderer")) rep.errors.push({ kind: "renderer", message: e.message });
          transient = true;
          break;
        }
        log.error(`failed processing ${n.id}`, e);
        this.failedAt.set(n.id, n.modifiedMs);
        rep.failed.push(n.id);
      }
    }
    rep.pending = [...this.pendingIds];
    this.lastFp = transient ? null : fp;
    if (rep.written.length || rep.pending.length || rep.failed.length)
      log.info(`cycle: wrote ${rep.written.length}, pending ${rep.pending.length}, failed ${rep.failed.length}`);
    return rep;
  }

  private async process(n: SourceNote, rep: CycleReport): Promise<void> {
    const d = this.decide(n);
    if (d === "in-vault") {
      const p = this.deps.index.paths(n.id)[0];
      this.deps.state.adopt(n.id, n.createdMs, n.modifiedMs, p);
      this.deps.log.info(`note ${n.id} already in the vault at ${p}; recorded, not rewritten`);
      rep.skipped[d] = (rep.skipped[d] ?? 0) + 1;
      return;
    }
    if (d !== "new" && d !== "update") { rep.skipped[d] = (rep.skipped[d] ?? 0) + 1; return; }
    const st = this.deps.source.settle(n, this.cfg.settleMs);
    if (st === "missing" && Date.now() - n.modifiedMs > MISSING_GRACE_MS) {
      this.once(`missing:${n.id}`, () => this.deps.log.warn(`note ${n.id} has no note folder; ignoring`));
      rep.skipped.missing = (rep.skipped.missing ?? 0) + 1;
      return;
    }
    if (st !== "ready") { this.pendingIds.add(n.id); this.deps.log.debug(`note ${n.id} not ready: ${st}`); return; }
    rep.written.push(await this.write(n));
    this.failedAt.delete(n.id);
  }

  // ---- render ----------------------------------------------------------------------

  /** Render a note into vault/model-input outputs. Throws RendererUnavailable (transient). */
  async build(n: SourceNote, pkg: Uint8Array): Promise<Built> {
    const { renderer, source, log } = this.deps;
    let doc: DocRender | null = null;
    let why: string | null = null;
    try {
      doc = await renderer.render(pkg, this.cfg.renderTimeoutMs);
    } catch (e) {
      if (e instanceof FormatError || e instanceof RenderTimeout) why = e.message;
      else throw e instanceof RendererUnavailable ? e : new RendererUnavailable((e as Error).message);
    }
    // Page templates (e.g. Action memo paper) aren't attachments; only sdocx can tell them apart.
    const skip = new Set(doc?.backgroundMedia ?? []);
    const media = source.media(n).filter((m) => !skip.has(m.name));
    const mediaFiles = media.map((m) => ({ file: sanitizeName(m.name), data: m.data }));

    if (doc) {
      const pages: { svg: string | null; text: ReturnType<typeof textToMarkdown> }[] = [];
      const rawSvgs: string[] = [];
      for (const p of doc.pages) {
        const text = textToMarkdown(p.text);
        const styled = styleSvg(p.svg, p.strokes, { inkScale: this.cfg.inkScale, padding: this.cfg.padding, radius: this.cfg.radius, stripText: !!text });
        if (!styled && !text) continue;                       // blank page
        pages.push({ svg: styled?.svg ?? null, text });
        rawSvgs.push(p.svg);
      }
      const ink = pages.filter((p) => p.svg).length, txt = pages.filter((p) => p.text).length;
      const multi = ink > 1;
      const svgName = (i: number) => (multi ? `p${i + 1}.svg` : "svg");
      const attachments: { file: string; data: Uint8Array }[] = [];
      const enc = new TextEncoder();
      let k = 0;
      const pageFiles = pages.map((p) => (p.svg ? svgName(k++) : null));
      pages.forEach((p, i) => { if (p.svg) attachments.push({ file: pageFiles[i]!, data: enc.encode(p.svg) }); });
      return {
        render: ink ? "sdocx" : "text",
        content: ink && txt ? "mixed" : ink ? "handwriting" : txt ? "text" : "empty",
        pages: doc.pages.length,
        attachments: [...attachments, ...mediaFiles],
        body: (att) => {
          const blocks: string[] = [];
          pages.forEach((p, i) => {
            const img = pageFiles[i] ? embed(att.replace("{}", pageFiles[i])) : null;
            const t = p.text?.markdown ?? null;
            // Samsung puts text below handwriting by preceding it with blank lines.
            if (t && p.text!.leadingBlankLines === 0) { blocks.push(t); if (img) blocks.push(img); }
            else { if (img) blocks.push(img); if (t) blocks.push(t); }
          });
          for (const m of mediaFiles) blocks.push(embed(att.replace("{}", m.file)));
          return blocks;
        },
        rawSvgs,
        modelImages: rawSvgs.map((svg) => ({ ext: "png", data: null, svg })),
        renderNote: null,
      };
    }

    // Fallback: Samsung's thumbnail (first page only) + typed text + attached media.
    log.info(`sdocx could not render ${n.id} (${why}); using thumbnail fallback`);
    const thumb = source.thumbnail(n);
    const text = n.plainText ? plainToMarkdown(n.plainText) : "";
    if (!thumb && !text && !mediaFiles.length) throw new Error(`render failed and nothing to fall back to: ${why}`);
    return {
      // Without a thumbnail, only the typed text survives: say so (render: text), not "thumbnail".
      render: thumb ? "thumbnail" : "text",
      fallback: true,
      content: thumb && text ? "mixed" : thumb ? "handwriting" : "text",
      pages: 1,
      attachments: [...(thumb ? [{ file: "jpg", data: thumb }] : []), ...mediaFiles],
      body: (att) => [
        ...(thumb ? [embed(att.replace("{}", "jpg"))] : []),
        ...(text ? [text] : []),
        ...mediaFiles.map((m) => embed(att.replace("{}", m.file))),
      ],
      rawSvgs: [],
      modelImages: thumb ? [{ ext: "jpg", data: thumb }] : [],
      renderNote: `sdocx could not render this note (${why}); ` +
        (thumb ? "showing Samsung's thumbnail of the first page. " : "Samsung has no thumbnail for it, so only its typed text is shown. ") +
        "The full note is in the .sdocx backup and can be re-rendered later.",
    };
  }

  // ---- write -----------------------------------------------------------------------

  private noteFolder(n: SourceNote): string {
    const segs = n.folder.length ? n.folder.map((s) => sanitizeName(s) || "_") : ["Uncategorized"];
    return join(this.cfg.rootFolder, ...segs);
  }

  /**
   * Write the note's current version into the vault. `trigger` "re-render" redraws an
   * already-imported note with the current renderer settings: in place if the user hasn't
   * edited it, otherwise as a new revision file (as for a Samsung update).
   */
  private async write(n: SourceNote, trigger: "sync" | "re-render" = "sync"): Promise<string> {
    const { state, vault, data, log, index } = this.deps;
    const ns: NoteState | null = state.get(n.id);
    const pkg = this.deps.source.packageNote(n);
    const built = await this.build(n, pkg);

    const created = new Date(n.createdMs), modified = new Date(n.modifiedMs);
    const date = localIso(created).slice(0, 10);
    let folder: string, name: string, revision: number, reason: string, previous: string | null = null;
    const fileFor = (stem: string, suffix: string) => `${stem}.${suffix}`;

    if (!ns) {
      folder = this.noteFolder(n);
      const att = join(folder, "attachments");
      const taken = new Set([...state.namesIn(folder), ...(await vault.stemsIn(folder))]);
      for (;;) {
        name = baseName(date, n.id, n.title, taken);
        const clash = (await vault.exists(join(folder, `${name}.md`))) ||
          (await Promise.all(built.attachments.map((a) => vault.exists(join(att, fileFor(name, a.file)))))).some(Boolean);
        if (!clash) break;
        taken.add(name.toLowerCase());
      }
      revision = 1; reason = "new";
    } else {
      folder = dirOf(ns.md_path);
      const base = stripRevision(ns.name);
      revision = ns.revision + 1;
      const current = await vault.read(ns.md_path);
      const what = trigger === "re-render" && n.modifiedMs === ns.samsung_modified_ms ? "re-render" : "samsung-update";
      if (current !== null && sha256(current) === ns.md_sha256) {
        name = ns.name; reason = what;
      } else {
        while (await vault.exists(join(folder, `${revisionName(base, revision)}.md`))) revision++;
        name = revisionName(base, revision);
        reason = `${what}-user-edited`;
        previous = ns.name;
        log.info(`${ns.md_path} was ${current === null ? "moved or deleted" : "edited"} in the vault; writing new revision ${name}.md`);
      }
    }

    // Outside the vault: the package and model input, named by note id + revision.
    const revTag = `${n.id}.r${revision}`;
    fs.mkdirSync(data.sdocxDir, { recursive: true });
    fs.mkdirSync(data.modelInputDir, { recursive: true });
    const sdocxPath = path.join(data.sdocxDir, `${revTag}.sdocx`);
    atomicWrite(sdocxPath, pkg);
    const rawPaths: string[] = [], imgPaths: string[] = [];
    for (const [i, svg] of built.rawSvgs.entries()) {
      const p = path.join(data.modelInputDir, `${revTag}.p${i + 1}.raw.svg`);
      atomicWrite(p, new TextEncoder().encode(svg));
      rawPaths.push(p);
    }
    for (const [i, m] of built.modelImages.entries()) {
      const bytes = m.data ?? (m.svg && this.deps.rasterize ? await this.deps.rasterize(m.svg).catch(() => null) : null);
      if (!bytes) continue;
      const p = path.join(data.modelInputDir, `${revTag}.p${i + 1}.${m.ext}`);
      atomicWrite(p, bytes);
      imgPaths.push(p);
    }

    // Vault: attachments, then the note.
    const att = join(folder, "attachments");
    await vault.ensureFolder(att);
    const attPaths: string[] = [];
    for (const a of built.attachments) {
      const p = join(att, fileFor(name!, a.file));
      await vault.writeBinary(p, a.data);
      attPaths.push(p);
    }
    const md = composeMarkdown({
      created: localIso(created), modified: localIso(modified), noteId: n.id, folder: samsungFolder(n),
      source: n.isScreenOff ? "screen-off-memo" : "samsung-note", content: built.content, revision,
      render: built.render, pages: built.pages, inkScale: built.render === "sdocx" ? this.cfg.inkScale : null,
      penTable: built.render === "sdocx" ? PEN_TABLE_VERSION : null, sdocxBackup: displayPath(sdocxPath), previous,
      renderNote: built.renderNote, body: built.body(join(att, `${name!}.{}`)),
    });
    const mdPath = join(folder, `${name!}.md`);
    await vault.write(mdPath, md);
    index.add(n.id, mdPath);

    const rev: Revision = {
      note_id: n.id, revision, name: name!, md_path: mdPath, attachment_path: attPaths[0] ?? "",
      sdocx_path: sdocxPath, png_path: imgPaths.length ? JSON.stringify(imgPaths) : null,
      raw_svg_path: rawPaths.length ? JSON.stringify(rawPaths) : null, render: built.render,
      samsung_modified_ms: n.modifiedMs, reason, written_at: nowIso(),
    };
    state.recordRevision({
      note_id: n.id, created_ms: n.createdMs, samsung_modified_ms: n.modifiedMs, revision, name: name!,
      md_path: mdPath, md_sha256: sha256(md), render: built.render, deleted: 0,
    }, rev);
    log.info(`wrote ${mdPath} (revision ${revision}, ${reason}, render=${built.render}, ${built.content})`);
    this.deps.onRevision?.(rev);
    return mdPath;
  }

  // ---- re-render -------------------------------------------------------------------

  /**
   * Imported notes whose current vault file was drawn with an older pen table
   * (frontmatter `pen_table` below PEN_TABLE_VERSION). Thumbnail and text-only notes have
   * no pen table and are never candidates.
   */
  async rerenderCandidates(): Promise<{ id: string; mdPath: string; penTable: number }[]> {
    const out: { id: string; mdPath: string; penTable: number }[] = [];
    for (const ns of this.deps.state.allNotes()) {
      const md = await this.deps.vault.read(ns.md_path);
      const v = md === null ? null : frontmatterValue(md, "pen_table");
      if (v === null || !/^\d+$/.test(v)) continue;
      if (Number(v) < PEN_TABLE_VERSION) out.push({ id: ns.note_id, mdPath: ns.md_path, penTable: Number(v) });
    }
    return out;
  }

  /** Re-render imported notes by id. Returns written paths and per-note failures. */
  async rerender(ids: string[], onProgress?: (done: number, total: number) => void):
      Promise<{ written: string[]; failed: { id: string; reason: string }[] }> {
    const { source, state, log } = this.deps;
    const written: string[] = [], failed: { id: string; reason: string }[] = [];
    const byId = new Map((await source.listNotes()).map((n) => [n.id, n]));
    for (const [i, id] of ids.entries()) {
      await yieldToUi();
      onProgress?.(i, ids.length);
      const n = byId.get(id);
      const why = !state.get(id) ? "not imported by Memo Bridge" : !n ? "no longer in Samsung Notes"
        : n.locked ? "locked in Samsung Notes" : n.trashed ? "in Samsung's trash" : null;
      if (why) { failed.push({ id, reason: why }); continue; }
      try {
        written.push(await this.write(n!, "re-render"));
      } catch (e) {
        if (e instanceof RendererUnavailable) throw e;
        log.error(`re-render of ${id} failed`, e);
        failed.push({ id, reason: (e as Error).message });
      }
    }
    onProgress?.(ids.length, ids.length);
    log.info(`re-render: wrote ${written.length}, failed ${failed.length}`);
    return { written, failed };
  }

  // ---- backfill --------------------------------------------------------------------

  /** Notes a backfill over `range` would import, oldest folder first, then oldest note. */
  async backfillCandidates(range: { since: number | null; until: number | null }): Promise<{ notes: SourceNote[]; all: SourceNote[] }> {
    const all = await this.deps.source.listNotes();
    const picked = all.filter((n) => this.decide(n, range) === "new");
    const oldest = new Map<string, number>();
    for (const n of picked) oldest.set(samsungFolder(n), Math.min(oldest.get(samsungFolder(n)) ?? Infinity, n.createdMs));
    picked.sort((a, b) => (oldest.get(samsungFolder(a))! - oldest.get(samsungFolder(b))!) ||
      samsungFolder(a).localeCompare(samsungFolder(b)) || a.createdMs - b.createdMs);
    return { notes: picked, all };
  }

  /** Dry run: classify everything in range without writing to the vault. */
  async dryRun(range: { since: number | null; until: number | null },
               onProgress?: (done: number, total: number) => void): Promise<DryRunReport> {
    const { notes, all } = await this.backfillCandidates(range);
    const rep: DryRunReport = {
      range, dateField: this.cfg.dateField, totalNotes: all.length, inRange: 0, skipped: {}, toImport: 0,
      byRender: {}, byContent: {}, byFolder: {}, bytes: 0, thumbnailFallbacks: [], textOnlyFallbacks: [], notRenderable: [],
    };
    for (const n of all) {
      const d = this.decide(n, range);
      if (d !== "out-of-range" && d !== "legacy-duplicate" && d !== "filtered") rep.inRange++;
      if (d !== "new") rep.skipped[d] = (rep.skipped[d] ?? 0) + 1;
    }
    for (const [i, n] of notes.entries()) {
      await yieldToUi();                       // keep Obsidian responsive between notes
      if (onProgress && i % 10 === 0) onProgress(i, notes.length);
      const pkg = this.deps.source.packageNote(n);
      let built: Built | null = null;
      try { built = await this.build(n, pkg); } catch (e) {
        if (e instanceof RendererUnavailable) throw e;
        rep.notRenderable.push({ id: n.id, folder: samsungFolder(n), reason: (e as Error).message });
        continue;
      }
      rep.toImport++;
      rep.bytes += built.attachments.reduce((s, a) => s + a.data.length, 0);
      rep.byRender[built.render] = (rep.byRender[built.render] ?? 0) + 1;
      rep.byContent[built.content] = (rep.byContent[built.content] ?? 0) + 1;
      const f = samsungFolder(n) || "(no folder)";
      rep.byFolder[f] = (rep.byFolder[f] ?? 0) + 1;
      if (built.render === "thumbnail")
        rep.thumbnailFallbacks.push({ id: n.id, folder: f, created: localIso(new Date(n.createdMs)).slice(0, 10), reason: built.renderNote ?? "" });
      else if (built.fallback)
        rep.textOnlyFallbacks.push({ id: n.id, folder: f, created: localIso(new Date(n.createdMs)).slice(0, 10), reason: built.renderNote ?? "" });
    }
    return rep;
  }

  /** Import up to `limit` notes of a backfill; returns what was written. */
  async backfillBatch(range: { since: number | null; until: number | null }, limit: number): Promise<{ written: string[]; remaining: number; failed: string[] }> {
    const { notes } = await this.backfillCandidates(range);
    const written: string[] = [], failed: string[] = [];
    let done = 0;
    for (const n of notes) {
      if (done >= limit) break;
      await yieldToUi();
      if (this.deps.source.settle(n, this.cfg.settleMs) !== "ready") continue;
      done++;
      try { written.push(await this.write(n)); } catch (e) {
        if (e instanceof RendererUnavailable) throw e;
        this.deps.log.error(`backfill: failed ${n.id}`, e);
        this.failedAt.set(n.id, n.modifiedMs);
        failed.push(n.id);
      }
    }
    return { written, failed, remaining: Math.max(0, notes.length - done) };
  }
}

export interface DryRunReport {
  range: { since: number | null; until: number | null };
  dateField: "created" | "modified";
  totalNotes: number;
  inRange: number;
  toImport: number;
  skipped: Partial<Record<Decision, number>>;
  byRender: Record<string, number>;
  byContent: Record<string, number>;
  byFolder: Record<string, number>;
  bytes: number;
  thumbnailFallbacks: { id: string; folder: string; created: string; reason: string }[];
  /** sdocx can't render it and Samsung has no thumbnail: only typed text is imported. */
  textOnlyFallbacks: { id: string; folder: string; created: string; reason: string }[];
  notRenderable: { id: string; folder: string; reason: string }[];
}

/** Let the UI thread run between notes (styling a page can take up to a second). */
const yieldToUi = () => new Promise<void>((r) => window.setTimeout(r, 0));

function atomicWrite(p: string, data: Uint8Array) {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
}
