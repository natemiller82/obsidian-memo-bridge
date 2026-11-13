// Plugin side of recognition: builds the provider from settings + Obsidian's secret storage,
// runs the queue on its own timer (never inside a sync cycle), and works out what the bulk
// commands would do (counts, pages, cost estimate) before anything is queued.
import type { App } from "obsidian";
import type { Settings } from "../config";
import type { Logger } from "../log";
import type { Renderer } from "../render/renderer";
import type { Revision, State } from "../state";
import type { VaultIO } from "../vaultio";
import { frontmatterValue } from "../writer";
import { obsidianHttp } from "./http-obsidian";
import { isPrivate } from "./output";
import { PRICES_AS_OF } from "./pricing";
import { makeProvider, PROVIDER_LABELS, type Provider, type ProviderKind } from "./providers";
import { estimate, folderIn, modelLabel, RecognitionRunner, RecognitionStore, type RecognitionSettings } from "./queue";
import { domRaster } from "./raster-dom";

const IDLE_MS = 30_000;
const BUSY_MS = 1_000;

const lines = (s: string) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

/** Providers whose API needs a key (the OpenAI-compatible one may or may not). */
export const KEYED: ProviderKind[] = ["anthropic", "openai", "gemini", "openai-compatible"];

export interface Plan {
  ids: string[];
  pages: number;
  /** Hosted only: notes outside the allowed folders, or marked private, that won't be sent. */
  notAllowed: number;
  excluded: number;
  cost: number | null;
  hosted: boolean;
  days: number | null;
}

export class RecognitionController {
  readonly store: RecognitionStore;
  readonly runner: RecognitionRunner;
  private timer: number | null = null;
  private running = false;
  private cached: { key: string; p: Provider } | null = null;
  private cachedText: { key: string; p: Provider } | null = null;
  private stopped = false;

  constructor(private app: App, private settings: () => Settings, private state: State, private vault: VaultIO,
              renderer: Renderer, private log: Logger, exclusive: <T>(fn: () => Promise<T>) => Promise<T>,
              private onChange: () => void) {
    this.store = new RecognitionStore(state);
    this.runner = new RecognitionRunner({
      state, store: this.store, vault, renderer, raster: domRaster, log,
      settings: () => this.recSettings(), provider: () => this.provider(), textProvider: () => this.textProvider(), withVaultLock: exclusive,
    });
  }

  get enabled() { return this.settings().recProvider !== "none"; }
  get kind(): ProviderKind | null { const p = this.settings().recProvider; return p === "none" ? null : p; }
  model(kind = this.kind): string { return kind ? (this.settings().recModels[kind] ?? "").trim() : ""; }
  /** Optional transcription-only model on the same provider ("" = the main model transcribes too). */
  textModel(kind = this.kind): string { return kind ? (this.settings().recTextModels[kind] ?? "").trim() : ""; }
  /** "model" or "textModel+model", as recorded on each transcription. */
  label(kind = this.kind): string { return modelLabel({ model: this.model(kind), textModel: this.textModel(kind) }); }

  recSettings(): RecognitionSettings {
    const s = this.settings(), kind = this.kind;
    return {
      provider: kind, model: this.model(), textModel: this.textModel(), contextHint: s.recContextHint, altInEmbed: s.recAltInEmbed,
      hostedFolders: lines(s.recHostedFolders), excludeFolders: lines(s.recExcludeFolders),
      acknowledged: !!kind && s.recAcknowledged.includes(kind), hostedDailyPages: Math.max(0, s.recHostedDailyPages),
      inkScale: s.inkScale,
    };
  }

  /** The API key from Obsidian's secret storage (never stored by the plugin itself). */
  private apiKey(kind: ProviderKind): string | null {
    const id = this.settings().recSecretIds[kind];
    if (!id) return null;
    try { return this.app.secretStorage.getSecret(id); } catch { return null; }
  }

  providerFor(kind: ProviderKind, model = this.model(kind)): Provider {
    const s = this.settings();
    return makeProvider({ kind, model, baseUrl: s.recUrls[kind] || undefined, apiKey: KEYED.includes(kind) ? this.apiKey(kind) : null }, obsidianHttp);
  }

  provider(): Provider | null {
    const kind = this.kind;
    if (!kind) return null;
    const s = this.settings();
    const key = JSON.stringify([kind, this.model(), s.recUrls[kind] ?? "", s.recSecretIds[kind] ?? "", !!this.apiKey(kind)]);
    if (this.cached?.key !== key) this.cached = { key, p: this.providerFor(kind) };
    return this.cached.p;
  }

  textProvider(): Provider | null {
    const kind = this.kind, model = this.textModel();
    if (!kind || !model) return null;
    const s = this.settings();
    const key = JSON.stringify([kind, model, s.recUrls[kind] ?? "", s.recSecretIds[kind] ?? "", !!this.apiKey(kind)]);
    if (this.cachedText?.key !== key) this.cachedText = { key, p: this.providerFor(kind, model) };
    return this.cachedText.p;
  }

  start() { this.stopped = false; this.schedule(5_000); }
  stop() { this.stopped = true; if (this.timer !== null) window.clearTimeout(this.timer); this.timer = null; }

  /** Settings changed or the user ran a command: clear pauses/stops and look again now. */
  kick() { this.cached = null; this.cachedText = null; this.runner.resume(); this.schedule(0); }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.tick(), ms);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    let worked = false;
    try {
      worked = await this.runner.step();
    } catch (e) {
      this.log.error("recognition step failed", e);
    } finally {
      this.running = false;
      this.onChange();
      const st = this.runner.status;
      this.schedule(worked ? BUSY_MS : st.kind === "paused" ? Math.max(BUSY_MS, Math.min(st.until - Date.now(), IDLE_MS)) : IDLE_MS);
    }
  }

  /** From sync: a new revision was written. */
  onRevision(rev: Revision) {
    if (!this.enabled || !this.settings().recAutoRun) return;
    if (this.store.enqueue(rev.note_id)) this.schedule(BUSY_MS);
  }

  /** Queue one note; returns why not, or null. A refusal is also written to the plugin log. */
  enqueueNote(noteId: string, force: boolean): string | null {
    const why = this.refusal(noteId, force);
    if (why) { this.log.info(`transcribe: ${noteId} not queued: ${why}`); return why; }
    this.kick();
    return null;
  }

  private refusal(noteId: string, force: boolean): string | null {
    if (!this.enabled) return "choose a recognition provider in the settings first";
    const ns = this.state.get(noteId);
    if (!ns) return "this note wasn't imported by Memo Bridge";
    if (ns.render === "text") return "this note has no handwriting";
    if (ns.render === "adopted") return "this note was found in the vault without Memo Bridge's records (no stroke backup); it can be transcribed after Samsung Notes next updates it";
    const j = this.store.get(noteId, ns.revision);
    if (!force && j?.status === "done") return "already transcribed (use Re-run to transcribe it again)";
    if (j?.status === "queued") return "already queued; it runs in the background";
    if (!this.store.enqueue(noteId, force)) return "it couldn't be queued";
    return null;
  }

  /** What a bulk command would queue. "untranscribed": not done yet; "other-model": done with a different provider/model. */
  async plan(which: "untranscribed" | "other-model"): Promise<Plan> {
    const kind = this.kind!, model = this.label(), s = this.recSettings();
    const hosted = this.provider()?.hosted ?? true;
    const plan: Plan = { ids: [], pages: 0, notAllowed: 0, excluded: 0, cost: null, hosted, days: null };
    for (const row of this.store.overview()) {
      const pick = which === "untranscribed" ? row.status !== "done" && row.status !== "queued"
        : row.status === "done" && (row.provider !== kind || row.model !== model);
      if (!pick) continue;
      const ns = this.state.get(row.note_id);
      const md = ns ? await this.vault.read(ns.md_path) : null;
      const folder = md ? frontmatterValue(md, "folder") ?? "" : "";
      if (folderIn(folder, s.excludeFolders)) { plan.excluded++; continue; }
      if (hosted && (!folderIn(folder, s.hostedFolders) || (md !== null && isPrivate(md)))) { plan.notAllowed++; continue; }
      plan.ids.push(row.note_id);
      plan.pages += row.render === "thumbnail" ? 1 : Math.max(1, Number(md ? frontmatterValue(md, "pages") ?? 1 : 1));
    }
    if (hosted) {
      const textCost = s.textModel ? estimate(kind, s.textModel, plan.pages) : 0;
      const descCost = estimate(kind, s.model, plan.pages);
      plan.cost = descCost === null || textCost === null ? null : descCost + textCost;
      plan.days = s.hostedDailyPages > 0 ? Math.ceil(plan.pages / s.hostedDailyPages) : null;
    }
    return plan;
  }

  describePlan(p: Plan): string {
    const kind = this.kind!, text = this.textModel();
    const who = `${PROVIDER_LABELS[kind]} · ${text ? `${text} (transcription) and ${this.model() || "(no model chosen)"} (description)` : this.model() || "(no model chosen)"}`;
    const parts = [`${p.ids.length} note${p.ids.length === 1 ? "" : "s"} (about ${p.pages} page${p.pages === 1 ? "" : "s"}) with ${who}.`];
    if (p.hosted) {
      parts.push(p.cost === null ? "No cost estimate for this model." :
        `Estimated cost: about $${p.cost < 0.1 ? p.cost.toFixed(3) : p.cost.toFixed(2)} at list prices as of ${PRICES_AS_OF} (billed to your API key).`);
      parts.push(`Page images are sent to ${PROVIDER_LABELS[kind]}.`);
      if (p.notAllowed) parts.push(`${p.notAllowed} more note${p.notAllowed === 1 ? " is" : "s are"} outside the folders allowed for hosted recognition or marked memo_bridge_private and won't be sent.`);
      if (p.days !== null && p.days > 1) parts.push(`With the daily limit of ${this.settings().recHostedDailyPages} pages this takes about ${p.days} days.`);
      if (p.days === null) parts.push("The daily page limit for hosted recognition is 0, so nothing will be sent until you raise it.");
    } else {
      parts.push("Runs on this computer; nothing leaves it.");
    }
    if (p.excluded) parts.push(`${p.excluded} note${p.excluded === 1 ? " is" : "s are"} in folders excluded from recognition.`);
    parts.push("Recognition runs one note at a time in the background and never holds up syncing.");
    return parts.join("\n\n");
  }

  queueAll(ids: string[], force: boolean): number {
    let n = 0;
    for (const id of ids) if (this.store.enqueue(id, force)) n++;
    this.kick();
    return n;
  }

  /** One line for the status bar tooltip, or null when off. */
  statusLine(): string | null {
    if (!this.enabled) return null;
    const c = this.store.counts(), st = this.runner.status;
    const q = c.queued ?? 0;
    const head = st.kind === "working" ? "transcribing" : st.kind === "paused" ? `recognition paused: ${st.reason}`
      : st.kind === "stopped" ? `recognition stopped: ${st.reason}` : q ? "recognition waiting" : "recognition idle";
    return `${head} · ${c.done ?? 0} done, ${q} queued${c.error ? `, ${c.error} failed` : ""}${c.blocked ? `, ${c.blocked} not sent` : ""}`;
  }
}
