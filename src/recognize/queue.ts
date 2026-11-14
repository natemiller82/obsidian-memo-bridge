// The recognition queue: persistent (state.sqlite), one note at a time, outside the sync cycle.
// Sync only enqueues. The runner sends pages to the chosen provider, writes results into the
// vault through a short lock shared with sync, and on trouble waits instead of retrying hard:
//   rate limit / overload -> wait (Retry-After or backoff), not counted as an attempt
//   provider unreachable  -> pause quietly 1, 5, 15, 15... min
//   bad key / quota / unknown model -> stop until settings change or a command runs
//   bad answer / refusal  -> count an attempt; after MAX_ATTEMPTS the note is parked as "error"
// A failed note is never marked done. Hosted providers pass the privacy gates first and are
// limited to a number of pages per day.
import type { Logger } from "../log";
import type { Renderer } from "../render/renderer";
import { nowIso, type Revision, type State } from "../state";
import { dirOf, join, type VaultIO } from "../vaultio";
import { sha256 } from "../writer";
import { recognitionPages, type InputPage, type Raster } from "./inputs";
import { applyBody, ENRICHER, isPrivate, recognitionFields, sidecarMarkdown, versionTag, type PageOutput, type RunInfo } from "./output";
import { estimatePage, costOf } from "./pricing";
import { buildPrompt, withTranscription } from "./prompt";
import { isOcrOnly, ProviderError, type Provider, type ProviderKind } from "./providers";
import { frontmatterValue } from "../writer";

export const MAX_ATTEMPTS = 3;
const PAUSE_STEPS_MS = [60_000, 5 * 60_000, 15 * 60_000];
const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS recognition (
    note_id         TEXT NOT NULL,
    revision        INTEGER NOT NULL,
    status          TEXT NOT NULL,          -- queued | done | error | blocked
    provider        TEXT,
    model           TEXT,
    prompt_hash     TEXT,
    pages           INTEGER,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_ms INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    queued_at       TEXT NOT NULL,
    done_at         TEXT,
    input_tokens    INTEGER,
    output_tokens   INTEGER,
    cost_usd        REAL,
    output_path     TEXT,
    PRIMARY KEY (note_id, revision)
);`;

export interface Job {
  note_id: string; revision: number; status: string; provider: string | null; model: string | null; prompt_hash: string | null;
  pages: number | null; attempts: number; next_attempt_ms: number; last_error: string | null; queued_at: string; done_at: string | null;
  input_tokens: number | null; output_tokens: number | null; cost_usd: number | null; output_path: string | null;
}

export class RecognitionStore {
  constructor(private state: State) { state.db.exec(SCHEMA); }

  /** Queue the note's current revision. `force` re-queues even if done (re-run). */
  enqueue(noteId: string, force = false): boolean {
    const ns = this.state.get(noteId);
    if (!ns || ns.render === "text" || ns.render === "adopted") return false;
    const cur = this.get(noteId, ns.revision);
    if (cur && cur.status === "queued") return false;
    if (cur && cur.status === "done" && !force) return false;
    this.state.db.prepare(`INSERT INTO recognition (note_id, revision, status, attempts, next_attempt_ms, queued_at)
      VALUES (?, ?, 'queued', 0, 0, ?) ON CONFLICT(note_id, revision) DO UPDATE SET status='queued', attempts=0,
      next_attempt_ms=0, last_error=NULL, queued_at=excluded.queued_at`).run(noteId, ns.revision, nowIso());
    return true;
  }

  get(noteId: string, revision: number): Job | null {
    return (this.state.db.prepare("SELECT * FROM recognition WHERE note_id=? AND revision=?").get(noteId, revision) as Job | undefined) ?? null;
  }

  /** Latest-revision status for every imported note that can be recognised. */
  overview(): { note_id: string; revision: number; render: string; status: string | null; provider: string | null; model: string | null }[] {
    return this.state.db.prepare(`SELECT n.note_id, n.revision, n.render, r.status, r.provider, r.model FROM notes n
      LEFT JOIN recognition r ON r.note_id=n.note_id AND r.revision=n.revision
      WHERE n.deleted=0 AND n.render IN ('sdocx','thumbnail')`).all() as never;
  }

  /** Next due job for a note's latest revision. */
  next(now: number): Job | null {
    return (this.state.db.prepare(`SELECT r.* FROM recognition r JOIN notes n ON n.note_id=r.note_id AND n.revision=r.revision
      WHERE r.status='queued' AND r.next_attempt_ms<=? ORDER BY r.queued_at LIMIT 1`).get(now) as Job | undefined) ?? null;
  }

  counts(): Record<string, number> {
    const rows = this.state.db.prepare(`SELECT r.status AS s, count(*) AS n FROM recognition r JOIN notes n
      ON n.note_id=r.note_id AND n.revision=r.revision GROUP BY r.status`).all() as { s: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.s, Number(r.n)]));
  }

  update(j: Pick<Job, "note_id" | "revision">, f: Partial<Job>) {
    const keys = Object.keys(f);
    if (!keys.length) return;
    this.state.db.prepare(`UPDATE recognition SET ${keys.map((k) => `${k}=?`).join(", ")} WHERE note_id=? AND revision=?`)
      .run(...keys.map((k) => (f as Record<string, unknown>)[k] as never), j.note_id, j.revision);
  }

  /** Pages sent to hosted providers on a local day ("YYYY-MM-DD"). */
  hostedPages(day: string): number { return Number(this.state.getMeta(`hosted_pages:${day}`) ?? 0); }
  addHostedPages(day: string, n: number) { this.state.setMeta(`hosted_pages:${day}`, String(this.hostedPages(day) + n)); }
}

export interface RecognitionSettings {
  provider: ProviderKind | null;
  /** The model that describes the page and writes the alt text (and the transcription, unless `textModel` is set). */
  model: string;
  /** Optional second model, same provider, that only transcribes (e.g. glm-ocr); "" = one model does everything. */
  textModel: string;
  contextHint: string;
  altInEmbed: boolean;
  /** Samsung folders whose notes may go to a hosted provider (empty = none). */
  hostedFolders: string[];
  /** Samsung folders never recognised, by any provider. */
  excludeFolders: string[];
  /** The user accepted the one-time notice for this hosted provider. */
  acknowledged: boolean;
  hostedDailyPages: number;
  inkScale: number;
}

export interface RunnerDeps {
  state: State;
  store: RecognitionStore;
  vault: VaultIO;
  renderer: Renderer;
  raster: Raster;
  log: Logger;
  settings: () => RecognitionSettings;
  provider: () => Provider | null;
  /** The transcription model's provider when `textModel` is set. */
  textProvider?: () => Provider | null;
  /** Run a vault write with sync held off (short). */
  withVaultLock: <T>(fn: () => Promise<T>) => Promise<T>;
  now?: () => number;
}

export type RunnerState =
  | { kind: "off" }
  | { kind: "idle" }
  | { kind: "working"; noteId: string }
  | { kind: "paused"; until: number; reason: string }
  | { kind: "stopped"; reason: string };

/** The model(s) as recorded in frontmatter and the queue: "model", or "textModel+model". */
export const modelLabel = (s: Pick<RecognitionSettings, "model" | "textModel">) => (s.textModel ? `${s.textModel}+${s.model}` : s.model);

const localDay = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const nextMidnight = (t: number) => { const d = new Date(t); d.setHours(24, 0, 0, 0); return d.getTime(); };

/** Does a Samsung folder ("" = no folder) match a folder list entry (case-insensitive, subfolders included)? */
export function folderIn(folder: string, list: string[]): boolean {
  const f = (folder || "Uncategorized").toLowerCase();
  return list.some((e) => { const x = e.trim().replace(/^\/+|\/+$/g, "").toLowerCase(); return !!x && (f === x || f.startsWith(x + "/")); });
}

export class RecognitionRunner {
  status: RunnerState = { kind: "idle" };
  private pauseStep = 0;
  constructor(private d: RunnerDeps) {}

  private now() { return (this.d.now ?? Date.now)(); }

  /** Clear a stop/pause (settings changed, or the user ran a command). */
  resume() { if (this.status.kind === "paused" || this.status.kind === "stopped") this.status = { kind: "idle" }; this.pauseStep = 0; }

  /** Process at most one job. Returns true if it did some work (so the caller can go again soon). */
  async step(): Promise<boolean> {
    const s = this.d.settings();
    const provider = s.provider ? this.d.provider() : null;
    if (!provider) { this.status = { kind: "off" }; return false; }
    if (this.status.kind === "stopped") return false;
    if (this.status.kind === "paused") { if (this.now() < this.status.until) return false; this.status = { kind: "idle" }; }
    if (this.status.kind === "off") this.status = { kind: "idle" };
    const job = this.d.store.next(this.now());
    if (!job) return false;
    this.status = { kind: "working", noteId: job.note_id };
    try {
      await this.run(job, provider, s);
      this.pauseStep = 0;
    } finally {
      if (this.status.kind === "working") this.status = { kind: "idle" };
    }
    return true;
  }

  private block(job: Job, reason: string) {
    this.d.store.update(job, { status: "blocked", last_error: reason });
    this.d.log.info(`recognition: ${job.note_id} r${job.revision} not sent: ${reason}`);
  }

  private async run(job: Job, provider: Provider, s: RecognitionSettings) {
    const { state, store, vault, log } = this.d;
    const ns = state.get(job.note_id);
    const rev = state.latestRevision(job.note_id);
    if (!ns || !rev || rev.revision !== job.revision) { store.update(job, { status: "blocked", last_error: "superseded by a newer revision" }); return; }
    const md = await vault.read(ns.md_path);
    const folder = md ? frontmatterValue(md, "folder") ?? "" : "";

    // ---- gates (checked right before anything is sent) ----
    if (folderIn(folder, s.excludeFolders)) return this.block(job, `folder "${folder || "Uncategorized"}" is excluded from recognition`);
    if (provider.hosted) {
      if (!s.acknowledged) return this.block(job, "the hosted-provider notice hasn't been accepted");
      if (!folderIn(folder, s.hostedFolders)) return this.block(job, `folder "${folder || "Uncategorized"}" isn't in the list of folders allowed for hosted recognition`);
      if (md && isPrivate(md)) return this.block(job, "the note is marked memo_bridge_private: true");
    }

    let pages: InputPage[];
    try {
      pages = await recognitionPages(rev, this.d.renderer, this.d.raster, s.inkScale);
    } catch (e) {
      return this.fail(job, `couldn't prepare the page images: ${(e as Error).message}`);
    }
    if (!pages.length) { store.update(job, { status: "blocked", last_error: "no handwriting to recognise", pages: 0 }); return; }

    const textProvider = s.textModel ? this.d.textProvider?.() ?? null : null;
    if (s.textModel && !textProvider) return this.fail(job, `the transcription model ${s.textModel} isn't available`);
    const sends = textProvider ? 2 : 1;                         // each page goes to each model
    if (provider.hosted) {
      const day = localDay(this.now());
      const used = store.hostedPages(day);
      if (used + pages.length * sends > s.hostedDailyPages) {
        this.status = { kind: "paused", until: nextMidnight(this.now()), reason: `daily limit of ${s.hostedDailyPages} pages for hosted recognition reached (${used} sent today)` };
        log.info(`recognition paused: ${this.status.reason}`);
        return;
      }
    }

    const prompt = buildPrompt(s.contextHint);
    const outs: PageOutput[] = [];
    let inTok = 0, outTok = 0, cost = 0, costKnown = true;
    const count = (model: string, u: { inputTokens: number | null; outputTokens: number | null }) => {
      inTok += u.inputTokens ?? 0; outTok += u.outputTokens ?? 0;
      const c = costOf(provider.kind, model, u.inputTokens, u.outputTokens);
      if (c === null) costKnown = false; else cost += c;
    };
    for (const p of pages) {
      if (provider.hosted) store.addHostedPages(localDay(this.now()), sends);
      try {
        const a = await provider.recognize(p.png, prompt);
        count(s.model, a.usage);
        let result = a.result;
        if (textProvider) {
          // OCR-only models get their own plain task (fences stripped); others the same JSON prompt
          if (textProvider.transcribe && isOcrOnly(s.textModel)) {
            const t = await textProvider.transcribe(p.png);
            count(s.textModel, t.usage);
            result = withTranscription(a.result, t.text);
          } else {
            const t = await textProvider.recognize(p.png, prompt);
            count(s.textModel, t.usage);
            result = withTranscription(a.result, t.result.transcription);
          }
        }
        outs.push({ page: p.page, result, source: p.source });
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
        return this.onError(job, e);
      }
    }

    const label = modelLabel(s);
    const run: RunInfo = { provider: provider.kind, model: label, promptId: prompt.id, promptHash: prompt.hash, at: nowIso() };
    const written = await this.d.withVaultLock(() => this.write(rev, outs, run, s));
    store.update(job, {
      status: "done", provider: provider.kind, model: label, prompt_hash: prompt.hash, pages: pages.length, done_at: run.at,
      last_error: null, input_tokens: inTok || null, output_tokens: outTok || null, cost_usd: provider.hosted && costKnown ? cost : null, output_path: written,
    });
    state.recordEnrich(job.note_id, job.revision, ENRICHER, versionTag(run), prompt.hash, "ok", [written], null);
    log.info(`recognition: ${ns.md_path} (${pages.length} page${pages.length > 1 ? "s" : ""}, ${provider.kind}/${label}) -> ${written}`);
  }

  /** Into the note if it's ours and unedited; otherwise a sidecar next to it. Returns the path written. */
  private async write(rev: Revision, pages: PageOutput[], run: RunInfo, s: RecognitionSettings): Promise<string> {
    const { state, vault } = this.d;
    const ns = state.get(rev.note_id);
    const current = ns ? await vault.read(ns.md_path) : null;
    const ours = !!ns && ns.revision === rev.revision && current !== null && sha256(current) === ns.md_sha256;
    if (ours) {
      // Body (section, embed alt) as text; frontmatter through the host's own frontmatter API.
      // Then record the hash of the note as it now is on disk, so it stays "ours" for later updates.
      await vault.write(ns.md_path, applyBody(current, pages, run, { altInEmbed: s.altInEmbed, imageFiles: pageEmbeds(current, rev.name) }));
      const fields = recognitionFields(pages, run);
      await vault.processFrontMatter(ns.md_path, (fm) => { Object.assign(fm, fields); });
      const now = await vault.read(ns.md_path);
      if (now !== null) state.updateMdHash(rev.note_id, sha256(now));
      return ns.md_path;
    }
    const p = join(dirOf(rev.md_path), `${rev.name}.enrich-${ENRICHER}.md`);
    await vault.write(p, sidecarMarkdown(rev.name, rev.note_id, pages, run));
    return p;
  }

  private fail(job: Job, msg: string) {
    const attempts = job.attempts + 1;
    const parked = attempts >= MAX_ATTEMPTS;
    this.d.store.update(job, {
      attempts, last_error: msg, status: parked ? "error" : "queued",
      next_attempt_ms: this.now() + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)],
    });
    this.d.log.warn(`recognition failed for ${job.note_id} r${job.revision} (attempt ${attempts}/${MAX_ATTEMPTS}${parked ? ", parked" : ""}): ${msg}`);
  }

  private onError(job: Job, e: ProviderError) {
    switch (e.action) {
      case "fail": return this.fail(job, e.message);
      case "retry": {
        const wait = e.retryAfterMs ?? BACKOFF_MS[Math.min(this.pauseStep, BACKOFF_MS.length - 1)];
        this.pauseStep++;
        this.status = { kind: "paused", until: this.now() + wait, reason: `provider busy or rate-limited (${e.status ?? "?"}); waiting ${Math.round(wait / 1000)} s` };
        this.d.log.info(`recognition: ${this.status.reason}`);
        return;
      }
      case "pause": {
        const wait = PAUSE_STEPS_MS[Math.min(this.pauseStep, PAUSE_STEPS_MS.length - 1)];
        this.pauseStep++;
        this.status = { kind: "paused", until: this.now() + wait, reason: `${e.message}; trying again in ${Math.round(wait / 60_000)} min` };
        this.d.log.info(`recognition paused: ${this.status.reason}`);
        return;
      }
      case "stop":
        this.status = { kind: "stopped", reason: e.message };
        this.d.store.update(job, { last_error: e.message });
        this.d.log.warn(`recognition stopped: ${e.message}`);
        return;
    }
  }
}

/** Vault paths of the page images embedded in a note, in order (svg pages, or the thumbnail jpg). */
export function pageEmbeds(md: string, name: string): string[] {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`!\\[\\[([^\\]|]*/${esc}\\.(?:svg|p\\d+\\.svg|jpg))(?:\\|[^\\]]*)?\\]\\]`, "g");
  return [...md.matchAll(re)].map((m) => m[1]);
}

/** Estimated cost of recognising `pages` pages with a hosted provider, or null if unknown. */
export function estimate(kind: ProviderKind, model: string, pages: number): number | null {
  const per = estimatePage(kind, model);
  return per === null ? null : per * pages;
}
