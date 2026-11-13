import * as fs from "node:fs";
import { Notice, Plugin, TAbstractFile, TFile } from "obsidian";
import { FileLogger } from "./log";
import { DataPaths, defaultDataDir, defaultLocalState } from "./paths";
import { loadSqlite, open as openDb } from "./sqlite";
import { LocalStateSource } from "./source";
import { State } from "./state";
import { NoteIndex } from "./vaultio";
import { ObsidianVault } from "./obsidian-vault";
import { InlineRenderer, WorkerRenderer, type Renderer } from "./render/renderer";
import { sdocxWasm, workerSource } from "./render/embedded";
import { SyncEngine, type CycleReport } from "./sync";
import { DEFAULTS, initialSince, MemoBridgeSettingTab, toSyncConfig, type Settings } from "./settings";
import { pythonBridgeRunning, samsungSyncRunning } from "./guard";
import { BackfillModal, ConfirmModal, LogModal } from "./modals";
import { PEN_TABLE_VERSION } from "./render/pens";
import { RecognitionController } from "./recognize/controller";

const FAST_POLL_MS = 5_000;
const SAMSUNG_CHECK_MS = 10 * 60_000;
const NOTIFY_EVERY_MS = 60 * 60_000;

interface Status {
  lastSync: Date | null;
  pending: number;
  synced: number;
}

export default class MemoBridgePlugin extends Plugin {
  declare settings: Settings;
  data = new DataPaths(defaultDataDir());
  log!: FileLogger;
  engine: SyncEngine | null = null;
  rec: RecognitionController | null = null;
  private state: State | null = null;
  private renderer: Renderer | null = null;
  private index = new NoteIndex();
  private statusEl!: HTMLElement;
  private timer: number | null = null;
  private busy = false;
  private status: Status = { lastSync: null, pending: 0, synced: 0 };
  private problems = new Map<string, string>();        // kind -> message
  private notifiedAt = new Map<string, number>();

  async onload() {
    await this.loadSettings();
    this.log = new FileLogger(this.data.logFile, 1_000_000, 5, false, this.settings.debugLog ? "DEBUG" : "INFO");
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("memo-bridge-status");
    this.statusEl.onClickEvent(() => void this.syncNow());
    this.renderStatus();

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow() });
    this.addCommand({ id: "backfill", name: "Backfill since date…", callback: () => this.openBackfill() });
    this.addCommand({ id: "toggle-pause", name: "Pause / resume syncing", callback: () => void this.togglePause() });
    this.addCommand({ id: "open-log", name: "Open log", callback: () => this.showLog() });
    this.addCommand({
      id: "rerender-note", name: "Re-render this note",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== "md") return false;
        if (!checking) void this.rerenderActive(f);
        return true;
      },
    });
    this.addCommand({
      id: "transcribe-note", name: "Transcribe this note",
      checkCallback: (checking) => this.withActiveNote(checking, (id) => this.queueOne(id, false)),
    });
    this.addCommand({ id: "transcribe-all", name: "Transcribe all untranscribed notes…", callback: () => void this.queueMany("untranscribed") });
    this.addCommand({
      id: "retranscribe-note", name: "Re-run transcription of this note with the current model",
      checkCallback: (checking) => this.withActiveNote(checking, (id) => this.queueOne(id, true)),
    });
    this.addCommand({ id: "retranscribe-other-model", name: "Re-run transcription of notes done with a different model…", callback: () => void this.queueMany("other-model") });
    this.addCommand({ id: "rerender-old-pen-table", name: "Re-render notes drawn with an older pen table…", callback: () => void this.rerenderOld() });
    this.addSettingTab(new MemoBridgeSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => void this.start());
  }

  onunload() {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.rec?.stop();
    this.renderer?.dispose();
    this.state?.close();
    this.log?.info("plugin unloaded");
  }

  async loadSettings() {
    const saved = (await this.loadData()) as Partial<Settings> | null;
    this.settings = { ...DEFAULTS, ...(saved ?? {}) };
    if (!saved || saved.since === undefined) {
      // First run: no backfill by default. Start where the Python bridge started, or now.
      this.settings.since = initialSince(this.data.pythonConfig);
      await this.saveData(this.settings);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    if (this.log) this.log.minLevel = this.settings.debugLog ? "DEBUG" : "INFO";
    if (this.engine) { this.engine.cfg = toSyncConfig(this.settings); this.engine.invalidate(); }
    this.rec?.kick();
    this.renderStatus();
  }

  // ---- startup -------------------------------------------------------------------------

  private async start() {
    this.log.info(`plugin loaded (version ${this.manifest.version}); data in ${this.data.root}`);
    if (!loadSqlite()) {
      this.log.error(`node:sqlite not available (Electron ${process.versions.electron}, Node ${process.versions.node})`);
      this.setProblem("sqlite", "This Obsidian build has no built-in SQLite (node:sqlite); Memo Bridge can't read Samsung Notes.");
      return;
    }
    try {
      const mem = openDb(":memory:");
      const v = (mem.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
      mem.close();
      this.log.info(`SQLite OK: node:sqlite loaded, SQLite ${v} (Electron ${process.versions.electron}, Node ${process.versions.node})`);
    } catch (e) {
      this.log.error("node:sqlite loaded but could not open a database", e);
      this.setProblem("sqlite", `Built-in SQLite failed: ${(e as Error).message}`);
      return;
    }
    try {
      this.state = new State(this.data.stateDb);
    } catch (e) {
      this.log.error("could not open state database", e);
      this.setProblem("state", `Could not open ${this.data.stateDb}: ${(e as Error).message}`);
      return;
    }
    this.renderer = this.makeRenderer();
    try {
      const t0 = Date.now();
      await this.renderer.warmUp();
      this.log.info(`renderer OK: sdocx WASM loaded ${this.renderer instanceof WorkerRenderer ? "in a Web Worker" : "on the main thread"} in ${Date.now() - t0} ms`);
    } catch (e) {
      if (this.renderer instanceof WorkerRenderer) {
        this.log.warn(`render worker failed to start (${(e as Error).message}); falling back to the main thread`);
        this.renderer.dispose();
        this.renderer = new InlineRenderer(sdocxWasm);
        try {
          const t1 = Date.now();
          await this.renderer.warmUp();
          this.log.info(`renderer OK: sdocx WASM loaded on the main thread in ${Date.now() - t1} ms (no worker; renders can't be timed out)`);
        } catch (e2) {
          this.log.error("renderer failed to load", e2);
          this.setProblem("renderer", `Renderer failed to load: ${(e2 as Error).message}`);
        }
      } else {
        this.log.error("renderer failed to load", e);
        this.setProblem("renderer", `Renderer failed to load: ${(e as Error).message}`);
      }
    }
    const vault = new ObsidianVault(this.app.vault, this.app.fileManager);
    const n = await this.index.build(vault);
    this.log.info(`vault index: ${n} notes carry a samsung_note_id`);
    this.registerEvent(this.app.vault.on("modify", (f) => void this.reindex(f)));
    this.registerEvent(this.app.vault.on("create", (f) => void this.reindex(f)));
    this.registerEvent(this.app.vault.on("rename", (f, old) => { this.index.remove(old); void this.reindex(f); }));
    this.registerEvent(this.app.vault.on("delete", (f) => this.index.remove(f.path)));

    const source = new LocalStateSource(this.settings.localState || defaultLocalState(), this.data.snapDir, this.log);
    this.engine = new SyncEngine({
      source, vault, state: this.state, renderer: this.renderer, index: this.index, data: this.data, log: this.log,
      rasterize: rasterizeSvg,
      onRevision: (rev) => this.rec?.onRevision(rev),
    }, toSyncConfig(this.settings));
    if (this.renderer) {
      this.rec = new RecognitionController(this.app, () => this.settings, this.state, vault, this.renderer, this.log,
        (fn) => this.exclusive(fn), () => this.recChanged());
      this.rec.start();
    }
    this.status.synced = this.state.count();

    if (this.settings.checkSamsungSync) {
      void this.checkSamsungSync();
      this.registerInterval(window.setInterval(() => { if (this.settings.checkSamsungSync) void this.checkSamsungSync(); }, SAMSUNG_CHECK_MS));
    }
    this.schedule(0, true);   // catch up on everything that arrived while Obsidian was closed
  }

  private makeRenderer(): Renderer {
    try {
      if (typeof Worker === "undefined") throw new Error("no Worker");
      return new WorkerRenderer(workerSource, sdocxWasm, this.log);
    } catch (e) {
      this.log.warn(`render worker unavailable (${(e as Error).message}); rendering on the main thread`);
      return new InlineRenderer(sdocxWasm);
    }
  }

  private async reindex(f: TAbstractFile) {
    if (!(f instanceof TFile) || f.extension !== "md") return;
    this.index.remove(f.path);
    const id = NoteIndex.parse(await this.app.vault.cachedRead(f));
    if (id) this.index.add(id, f.path);
  }

  // ---- loop ------------------------------------------------------------------------------

  private schedule(ms: number, force = false) {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.tick(force), ms);
  }

  async syncNow() {
    if (!this.engine) { new Notice("Memo Bridge isn't running: " + ([...this.problems.values()][0] ?? "starting up")); return; }
    if (this.settings.paused) new Notice("Memo Bridge is paused; syncing once anyway.");
    await this.tick(true, true);
  }

  private async tick(force = false, manual = false) {
    if (!this.engine) return;
    const next = () => this.schedule(this.engine?.hasPending ? FAST_POLL_MS : this.settings.pollSeconds * 1000);
    if (this.busy || (this.settings.paused && !manual)) { next(); return; }
    if (pythonBridgeRunning(this.data.pythonLocks)) {
      this.setProblem("python", "The Python memo-bridge is running; the plugin won't sync alongside it. Stop/uninstall it first.");
      next();
      return;
    }
    this.clearProblem("python");
    this.busy = true;
    try {
      const rep = await this.engine.poll(force);
      this.afterCycle(rep, manual);
    } catch (e) {
      this.log.error("sync cycle failed", e);
      this.setProblem("cycle", `Sync failed: ${(e as Error).message}`);
    } finally {
      this.busy = false;
      next();
    }
  }

  private afterCycle(rep: CycleReport, manual: boolean) {
    const kinds = new Set(rep.errors.map((e) => e.kind));
    for (const k of ["source", "snapshot", "renderer", "cycle"]) if (!kinds.has(k)) this.clearProblem(k);
    for (const e of rep.errors) {
      const msg = e.kind === "source" ? `Samsung Notes data missing: ${e.message}`
        : e.kind === "snapshot" ? `Couldn't read Samsung Notes' database (will retry): ${e.message}`
        : e.kind === "renderer" ? `Renderer problem (will retry): ${e.message}` : e.message;
      this.setProblem(e.kind, msg);
    }
    if (!rep.errors.length) this.status.lastSync = new Date();
    this.status.pending = rep.pending.length;
    if (this.state) this.status.synced = this.state.count();
    if (rep.written.length) new Notice(`Memo Bridge: imported ${rep.written.length} note${rep.written.length > 1 ? "s" : ""}`);
    else if (manual && !rep.errors.length) new Notice(rep.pending.length ? `Memo Bridge: ${rep.pending.length} note(s) still arriving` : "Memo Bridge: up to date");
    if (rep.failed.length) this.setProblem("failed", `${rep.failed.length} note(s) failed to import; see the log`);
    else this.clearProblem("failed");
    this.renderStatus();
  }

  private async checkSamsungSync() {
    const running = await samsungSyncRunning();
    if (running === false)
      this.setProblem("samsung", "Samsung Notes' sync process (SamsungNotesSysTray) isn't running, so new notes won't reach this PC. Open Samsung Notes once to start it.");
    else this.clearProblem("samsung");
  }

  async togglePause() {
    this.settings.paused = !this.settings.paused;
    await this.saveSettings();
    new Notice(this.settings.paused ? "Memo Bridge paused" : "Memo Bridge resumed");
    if (!this.settings.paused) this.schedule(0, true);
  }

  // ---- status + notices -------------------------------------------------------------------

  private setProblem(kind: string, msg: string) {
    const was = this.problems.get(kind);
    this.problems.set(kind, msg);
    if (was !== msg) this.log.warn(`problem [${kind}]: ${msg}`);
    const last = this.notifiedAt.get(kind) ?? 0;
    if (Date.now() - last > NOTIFY_EVERY_MS) {
      this.notifiedAt.set(kind, Date.now());
      new Notice(`Memo Bridge: ${msg}`, 10_000);
    }
    this.renderStatus();
  }

  private clearProblem(kind: string) {
    if (this.problems.delete(kind)) { this.notifiedAt.delete(kind); this.log.info(`problem [${kind}] resolved`); }
    this.renderStatus();
  }

  private renderStatus() {
    if (!this.statusEl) return;
    const p = [...this.problems.values()];
    const s = this.status;
    const time = s.lastSync ? s.lastSync.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "never";
    let text = `Memo Bridge: ${this.settings.paused ? "paused" : `synced ${time}`}`;
    if (s.pending) text += ` · ${s.pending} pending`;
    if (this.rec?.runner.status.kind === "working") text += " · transcribing";
    if (p.length) text += " · ⚠ error";
    this.statusEl.setText(text);
    this.statusEl.toggleClass("is-error", p.length > 0);
    this.statusEl.toggleClass("is-paused", this.settings.paused);
    const rec = this.rec?.statusLine();
    this.statusEl.setAttr("aria-label", [`${s.synced} notes synced`, ...(rec ? [rec] : []), ...p, "Click to sync now"].join("\n"));
    this.statusEl.setAttr("data-tooltip-position", "top");
  }

  showLog() { new LogModal(this.app, this.data.logFile).open(); }

  private openBackfill() {
    if (!this.engine) { new Notice("Memo Bridge isn't running: " + ([...this.problems.values()][0] ?? "starting up")); return; }
    new BackfillModal(this.app, this, this.engine, (fn) => this.exclusive(fn)).open();
  }

  // ---- recognition -----------------------------------------------------------------------

  private recChanged() {
    const st = this.rec?.runner.status;
    if (st?.kind === "stopped") this.setProblem("recognition", `Text recognition stopped: ${st.reason}`);
    else this.clearProblem("recognition");
    this.renderStatus();
  }

  private withActiveNote(checking: boolean, fn: (id: string) => void): boolean {
    const f = this.app.workspace.getActiveFile();
    if (!f || f.extension !== "md") return false;
    if (!checking) void this.runOnNote(f, fn);
    return true;
  }

  private async runOnNote(f: TFile, fn: (id: string) => void) {
    const id = NoteIndex.parse(await this.app.vault.cachedRead(f));
    if (id) { fn(id); return; }
    new Notice("This note wasn't imported from Samsung Notes (no samsung_note_id).");
    this.log?.info(`transcribe: ${f.path} not queued: no samsung_note_id (not a Memo Bridge note)`);
  }

  private queueOne(id: string, force: boolean) {
    if (!this.rec) {
      const why = [...this.problems.values()][0] ?? "starting up";
      new Notice("Memo Bridge isn't running: " + why);
      this.log?.info(`transcribe: ${id} not queued: Memo Bridge isn't running (${why})`);
      return;
    }
    const why = this.rec.enqueueNote(id, force);
    new Notice(why ? `Memo Bridge: ${why}.` : "Memo Bridge: queued for transcription. It runs in the background.");
  }

  private async queueMany(which: "untranscribed" | "other-model") {
    const rec = this.rec;
    if (!rec) { new Notice("Memo Bridge isn't running: " + ([...this.problems.values()][0] ?? "starting up")); return; }
    if (!rec.enabled) { new Notice("Memo Bridge: choose a recognition provider in the settings first."); return; }
    const plan = await rec.plan(which);
    if (!plan.ids.length) {
      new Notice(which === "untranscribed" ? "Memo Bridge: nothing left to transcribe." : "Memo Bridge: no notes were transcribed with a different model.");
      return;
    }
    new ConfirmModal(this.app, which === "untranscribed" ? "Transcribe notes" : "Re-run transcriptions", rec.describePlan(plan),
      `Queue ${plan.ids.length}`, () => {
        const n = rec.queueAll(plan.ids, which === "other-model");
        new Notice(`Memo Bridge: queued ${n} note${n === 1 ? "" : "s"} for transcription.`);
      }).open();
  }

  // ---- re-render -----------------------------------------------------------------------

  private async rerenderActive(f: TFile) {
    if (!this.engine) { new Notice("Memo Bridge isn't running: " + ([...this.problems.values()][0] ?? "starting up")); return; }
    const id = NoteIndex.parse(await this.app.vault.cachedRead(f));
    if (!id) { new Notice("This note wasn't imported from Samsung Notes (no samsung_note_id)."); return; }
    await this.runRerender([id]);
  }

  private async rerenderOld() {
    if (!this.engine) { new Notice("Memo Bridge isn't running: " + ([...this.problems.values()][0] ?? "starting up")); return; }
    const engine = this.engine;
    const c = await engine.rerenderCandidates();
    if (!c.length) { new Notice(`Memo Bridge: every note is already drawn with pen table ${PEN_TABLE_VERSION}.`); return; }
    new ConfirmModal(this.app, "Re-render notes",
      `${c.length} note${c.length > 1 ? "s were" : " was"} drawn with an older pen table (current: ${PEN_TABLE_VERSION}). ` +
      "They'll be redrawn from Samsung Notes with the current pen corrections.\n\n" +
      "Notes you haven't edited are updated in place. Notes you've edited are left alone and get a new revision file next to them.",
      `Re-render ${c.length}`, () => void this.runRerender(c.map((x) => x.id))).open();
  }

  private async runRerender(ids: string[]) {
    const notice = new Notice(`Memo Bridge: re-rendering ${ids.length} note${ids.length > 1 ? "s" : ""}…`, 0);
    try {
      const r = await this.exclusive(() => this.engine!.rerender(ids, (d, t) => notice.setMessage(`Memo Bridge: re-rendering… ${d} / ${t}`)));
      notice.hide();
      const fail = r.failed.length ? ` ${r.failed.length} failed: ${r.failed.slice(0, 3).map((x) => x.reason).join("; ")}${r.failed.length > 3 ? "…" : ""}` : "";
      new Notice(`Memo Bridge: re-rendered ${r.written.length} note${r.written.length === 1 ? "" : "s"}.${fail}`, 10_000);
    } catch (e) {
      notice.hide();
      new Notice(`Memo Bridge: re-render failed: ${(e as Error).message}`, 10_000);
    }
  }

  /** Run a backfill step with the regular loop held off. */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    while (this.busy) await new Promise((r) => setTimeout(r, 200));
    if (pythonBridgeRunning(this.data.pythonLocks)) throw new Error("the Python memo-bridge is running");
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; if (this.state) this.status.synced = this.state.count(); this.renderStatus(); }
  }

  /** Data directory, for the backfill report. */
  reportsDir() { fs.mkdirSync(this.data.reportsDir, { recursive: true }); return this.data.reportsDir; }
}

/** Raster copy of a raw page SVG for model input (outside the vault). */
async function rasterizeSvg(svg: string): Promise<Uint8Array | null> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("svg load failed")); img.src = url; });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth || 1080;
    c.height = img.naturalHeight || 1527;
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
