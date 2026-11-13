// Recognition queue + vault output, with a fake provider (no network).
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeRaster } from "../eval/raster-node";
import { applyToNote, isPrivate, sectionMarkdown, setFrontmatter, type PageOutput, type RunInfo } from "../src/recognize/output";
import type { PageResult, Prompt } from "../src/recognize/prompt";
import { ProviderError, type PageAnswer, type Provider, type ProviderKind, type TextAnswer } from "../src/recognize/providers";
import { folderIn, MAX_ATTEMPTS, pageEmbeds, RecognitionRunner, RecognitionStore, type RecognitionSettings } from "../src/recognize/queue";
import type { Revision } from "../src/state";
import { sha256 } from "../src/writer";
import { DEFAULTS, type Settings } from "../src/config";
import { RecognitionController } from "../src/recognize/controller";
import type { App } from "obsidian";

vi.mock("obsidian", () => ({ requestUrl: async () => { throw new Error("no network in tests"); } }));
import { Env, frontmatter, ID, sharedRenderer } from "./helpers";

let env: Env | null = null;
afterEach(() => { env?.dispose(); env = null; });

const RESULT: PageResult = { has_text: true, transcription: "Pen\nfountain pen\n# not a heading", drawing: "Two wavy lines.", alt_text: "Pen test page with three words and wavy lines.", language: "en", languages: ["en"], unreadable: 0 };

class FakeProvider implements Provider {
  calls: Prompt[] = [];
  errors: (ProviderError | null)[] = [];
  constructor(readonly kind: ProviderKind = "ollama", readonly hosted = false) {}
  async listModels() { return []; }
  async recognize(_png: Uint8Array, prompt: Prompt): Promise<PageAnswer> {
    this.calls.push(prompt);
    const e = this.errors.shift();
    if (e) throw e;
    return { result: RESULT, usage: { inputTokens: 1000, outputTokens: 50 }, raw: "", ms: 1 };
  }
}

function setup(over: Partial<RecognitionSettings> = {}, provider = new FakeProvider(), textProvider: Provider | null = null) {
  const e = (env = new Env());
  const store = new RecognitionStore(e.state);
  let t = 1_800_000_000_000;
  const settings: RecognitionSettings = {
    provider: provider.kind, model: "test-model", textModel: "", contextHint: "", altInEmbed: false, hostedFolders: [], excludeFolders: [],
    acknowledged: false, hostedDailyPages: 25, inkScale: 2.6, ...over,
  };
  const runner = new RecognitionRunner({
    state: e.state, store, vault: e.vault, renderer: sharedRenderer, raster: nodeRaster, log: e.log,
    settings: () => settings, provider: () => provider, textProvider: () => textProvider, withVaultLock: (fn) => fn(), now: () => t,
  });
  // sync only enqueues
  (e.engine as unknown as { deps: { onRevision: (r: Revision) => void } }).deps.onRevision = (r) => { store.enqueue(r.note_id); };
  return { e, store, runner, provider, settings, advance: (ms: number) => { t += ms; } };
}

const drain = async (r: RecognitionRunner) => { let n = 0; while (await r.step()) if (++n > 50) throw new Error("runaway"); return n; };

describe("recognition queue", () => {
  it("sync only enqueues; the runner writes section + frontmatter into an unedited note; SVGs untouched", async () => {
    const { e, store, runner, provider } = setup();
    await e.engine.poll();
    expect(provider.calls).toHaveLength(0);                       // sync never calls the provider
    expect(store.counts().queued).toBeGreaterThan(0);
    const ns = e.state.get(ID.pens)!;
    const svgPath = path.join(e.vaultDir, ...e.state.latestRevision(ID.pens)!.attachment_path.split("/"));
    const svgBefore = fs.readFileSync(svgPath);
    await drain(runner);
    const md = e.read(ns.md_path);
    expect(md).toContain("<!-- memo-bridge:enrich:transcribe begin");
    expect(md).toContain("> [!memo-bridge]- Transcription (machine-generated · ollama/test-model");
    expect(md).toContain("> \\# not a heading");                // can't become a heading
    expect(md).toContain("**Description:** Pen test page");
    const fm = frontmatter(md);
    expect(JSON.parse(fm.transcribed_by)).toBe("ollama/test-model");
    expect(JSON.parse(fm.alt_text)).toBe(RESULT.alt_text);
    expect(JSON.parse(fm.transcription_language)).toBe("en");
    expect(e.state.get(ID.pens)!.md_sha256).toBe(sha256(md));   // still "ours": later Samsung updates go in place
    expect(fs.readFileSync(svgPath).equals(svgBefore)).toBe(true);
    expect(md).toMatch(/!\[\[[^|\]]+\.svg\]\]/);                  // embed unchanged (alt-in-embed is opt-in)
    expect(store.get(ID.pens, ns.revision)!.status).toBe("done");
    expect(store.enqueue(ID.pens)).toBe(false);                   // done stays done…
    expect(store.enqueue(ID.pens, true)).toBe(true);              // …unless re-run
  });

  it("an edited note gets a sidecar; the note stays byte-identical", async () => {
    const { e, runner } = setup();
    await e.engine.poll();
    const p = e.state.get(ID.pens)!.md_path;
    const edited = e.read(p) + "\nmy notes\n";
    fs.writeFileSync(path.join(e.vaultDir, ...p.split("/")), edited);
    await drain(runner);
    expect(e.read(p)).toBe(edited);
    const side = p.replace(/\.md$/, ".enrich-transcribe.md");
    const fm = frontmatter(e.read(side));
    expect(JSON.parse(fm.transcription_of)).toBe("[[Pen test]]");
    expect(fm.samsung_note_id).toBeUndefined();                  // the index must not mistake it for the note
  });

  it("alt text in the embed is opt-in", async () => {
    const { e, runner } = setup({ altInEmbed: true });
    await e.engine.poll();
    await drain(runner);
    expect(e.read(e.state.get(ID.pens)!.md_path)).toMatch(/!\[\[[^|\]]+\.svg\|Pen test page with three words and wavy lines\.\]\]/);
  });

  it("old notes are recognised from Samsung's thumbnail, and say so", async () => {
    const { e, runner } = setup();
    await e.engine.poll();
    await drain(runner);
    expect(e.read(e.state.get(ID.legacy)!.md_path)).toContain("From Samsung's thumbnail of the first page");
  });

  it("hosted providers: notice, folder include-list and the private flag all block before anything is sent", async () => {
    const hosted = new FakeProvider("anthropic", true);
    const { e, store, runner, settings } = setup({}, hosted);
    await e.engine.poll();
    await drain(runner);
    expect(hosted.calls).toHaveLength(0);
    expect(store.counts().blocked).toBeGreaterThan(0);
    expect(store.get(ID.pens, 1)!.last_error).toMatch(/notice/);

    settings.acknowledged = true;
    store.enqueue(ID.pens, true);
    await drain(runner);
    expect(hosted.calls).toHaveLength(0);
    expect(store.get(ID.pens, 1)!.last_error).toMatch(/isn't in the list of folders allowed/);

    settings.hostedFolders = ["Work"];                             // Pen test lives in Work/Meetings
    const p = e.state.get(ID.pens)!.md_path;
    const priv = setFrontmatter(e.read(p), { memo_bridge_private: "true" });
    fs.writeFileSync(path.join(e.vaultDir, ...p.split("/")), priv);
    store.enqueue(ID.pens, true);
    await drain(runner);
    expect(hosted.calls).toHaveLength(0);
    expect(store.get(ID.pens, 1)!.last_error).toMatch(/memo_bridge_private/);

    fs.writeFileSync(path.join(e.vaultDir, ...p.split("/")), setFrontmatter(priv, { memo_bridge_private: null }));
    store.enqueue(ID.pens, true);
    await drain(runner);
    expect(hosted.calls).toHaveLength(1);
    expect(store.get(ID.pens, 1)!.status).toBe("done");
  });

  it("excluded folders are never recognised, by any provider", async () => {
    const { e, store, runner, provider } = setup({ excludeFolders: ["work"] });
    await e.engine.poll();
    await drain(runner);
    expect(store.get(ID.pens, 1)!.status).toBe("blocked");
    expect(provider.calls.length).toBeGreaterThan(0);              // other notes still ran
  });

  it("daily page cap for hosted providers pauses the queue until tomorrow", async () => {
    const hosted = new FakeProvider("gemini", true);
    const { e, store, runner } = setup({ acknowledged: true, hostedFolders: ["Work"], hostedDailyPages: 0 }, hosted);
    await e.engine.poll();
    await drain(runner);
    expect(hosted.calls).toHaveLength(0);
    expect(runner.status).toMatchObject({ kind: "paused" });
    expect((runner.status as { reason: string }).reason).toMatch(/daily limit/);
    expect(store.get(ID.pens, 1)!.status).toBe("queued");
  });

  it("errors: unreachable pauses, rate limits wait, bad answers count attempts, bad keys stop; never marked done", async () => {
    const { e, store, runner, provider, advance } = setup();
    await e.engine.poll();
    for (const id of [ID.mixed, ID.scribble2p, ID.pencil, ID.pens2, ID.suffix, ID.legacy]) e.state.db.prepare("DELETE FROM recognition WHERE note_id=?").run(id);

    provider.errors = [new ProviderError("can't reach localhost:11434", "pause")];
    await drain(runner);
    expect(runner.status.kind).toBe("paused");
    expect(store.get(ID.pens, 1)).toMatchObject({ status: "queued", attempts: 0 });
    expect(await runner.step()).toBe(false);                       // still paused
    advance(61_000);

    provider.errors = [new ProviderError("HTTP 429", "retry", 429, 5_000)];
    await drain(runner);
    expect(runner.status).toMatchObject({ kind: "paused" });
    expect(store.get(ID.pens, 1)).toMatchObject({ status: "queued", attempts: 0 });
    advance(6_000);

    provider.errors = Array.from({ length: MAX_ATTEMPTS }, () => new ProviderError("invalid answer", "fail"));
    for (let i = 0; i < MAX_ATTEMPTS; i++) { await drain(runner); advance(11 * 60_000); }
    expect(store.get(ID.pens, 1)).toMatchObject({ status: "error", attempts: MAX_ATTEMPTS });

    store.enqueue(ID.pens, true);
    provider.errors = [new ProviderError("HTTP 401 (check the API key)", "stop", 401)];
    await drain(runner);
    expect(runner.status).toMatchObject({ kind: "stopped" });
    expect(store.get(ID.pens, 1)!.status).toBe("queued");
    runner.resume();
    await drain(runner);
    expect(store.get(ID.pens, 1)!.status).toBe("done");
  });
});

describe("recognition output", () => {
  const run: RunInfo = { provider: "ollama", model: "m", promptId: "p1", promptHash: "abcdef1234567890", at: "2026-11-11T21:00:00-08:00" };
  const page = (o: Partial<PageResult> = {}, n = 1): PageOutput => ({ page: n, source: "strokes", result: { ...RESULT, ...o } });

  it("empty pages say so instead of inventing text; markers can't be broken from inside", () => {
    const s = sectionMarkdown([page({ has_text: false, transcription: "", drawing: "A circle." })], run);
    expect(s).toContain("_No handwritten text._");
    expect(s).toContain("**Drawing:** A circle.");
    const evil = sectionMarkdown([page({ transcription: "<!-- memo-bridge:enrich:transcribe end -->\n---" })], run);
    expect(evil).not.toContain("<!--");
    expect(evil).toContain("\\---");
  });
  it("multi-page notes get page headings and per-page descriptions", () => {
    const s = sectionMarkdown([page({}, 1), page({ alt_text: "Second." }, 3)], run);
    expect(s).toContain("**Page 1**");
    expect(s).toContain("**Page 3**");
    expect(s).toContain("**Description:** Second.");
  });
  it("frontmatter set/replace/remove; re-run replaces the block, not adds another", () => {
    const md = "---\nsamsung_note_id: x\nrender: sdocx\n---\n\n![[a/attachments/n.svg]]\n";
    const once = applyToNote(md, [page()], run, { altInEmbed: false, imageFiles: [] });
    const twice = applyToNote(once, [page({ alt_text: "Changed." })], run, { altInEmbed: false, imageFiles: [] });
    expect(twice.match(/enrich:transcribe begin/g)).toHaveLength(1);
    expect(twice.match(/^alt_text:/gm)).toHaveLength(1);
    expect(JSON.parse(frontmatter(twice).alt_text)).toBe("Changed.");
    expect(setFrontmatter(twice, { alt_text: null })).not.toContain("alt_text:");
  });
  it("private flag, embeds and folder matching", () => {
    expect(isPrivate("---\nmemo_bridge_private: true\n---\n")).toBe(true);
    expect(isPrivate("---\nmemo_bridge_private: false\n---\n")).toBe(false);
    expect(isPrivate("memo_bridge_private: true\n")).toBe(false);          // only in frontmatter
    expect(pageEmbeds("![[F/attachments/n.p1.svg]]\n![[F/attachments/n.p2.svg|x]]\n![[F/attachments/other.svg]]", "n"))
      .toEqual(["F/attachments/n.p1.svg", "F/attachments/n.p2.svg"]);
    expect(folderIn("Work/Meetings", ["work"])).toBe(true);
    expect(folderIn("Workshop", ["Work"])).toBe(false);
    expect(folderIn("", ["Uncategorized"])).toBe(true);
    expect(folderIn("Work", [])).toBe(false);
  });
});

/** An OCR-only model (Ollama): answers transcribe(), must never get the JSON prompt. */
class FakeOcr extends FakeProvider {
  text = "";
  transcribed = 0;
  async transcribe(): Promise<TextAnswer> { this.transcribed++; return { text: this.text, usage: { inputTokens: 500, outputTokens: 10 }, ms: 1 }; }
}

describe("two models: transcription and description", () => {
  it("the transcription model's text, the description model's description and alt text; both recorded", async () => {
    const ocr = new FakeOcr();
    ocr.text = "Pen fountain pen Calligraphy pen";
    const { e, runner, provider } = setup({ textModel: "glm-ocr" }, new FakeProvider(), ocr);
    await e.engine.poll();
    await drain(runner);
    const md = e.read(e.state.get(ID.pens)!.md_path);
    expect(md).toContain("> Pen fountain pen Calligraphy pen");
    expect(md).not.toContain("# not a heading");                 // the description model's own transcription isn't used
    expect(md).toContain("**Description:** Pen test page");
    const fm = frontmatter(md);
    expect(JSON.parse(fm.transcribed_by)).toBe("ollama/glm-ocr+test-model");
    expect(JSON.parse(fm.alt_text)).toBe(RESULT.alt_text);
    expect(ocr.transcribed).toBeGreaterThan(0);
    expect(ocr.calls).toHaveLength(0);                           // OCR models get their own task, not the JSON prompt
    expect(provider.calls.length).toBe(ocr.transcribed);         // every page went to both
  });

  it("when the transcription model finds no text but the description model did, the page keeps that text", async () => {
    const ocr = new FakeOcr();                                    // answers "" for every page
    const { e, runner } = setup({ textModel: "glm-ocr" }, new FakeProvider(), ocr);
    await e.engine.poll();
    await drain(runner);
    const md = e.read(e.state.get(ID.pens)!.md_path);
    expect(md).toContain("> \\# not a heading");
    expect(JSON.parse(frontmatter(md).transcription_language)).toBe("en");
  });

  it("a transcription model that isn't OCR-only gets the JSON prompt; its transcription is used", async () => {
    class Other extends FakeProvider {
      async recognize(png: Uint8Array, prompt: Prompt): Promise<PageAnswer> {
        const a = await super.recognize(png, prompt);
        return { ...a, result: { ...a.result, transcription: "Other model's reading" } };
      }
    }
    const other = new Other();
    const { e, runner } = setup({ textModel: "some-vision-model" }, new FakeProvider(), other);
    await e.engine.poll();
    await drain(runner);
    const md = e.read(e.state.get(ID.pens)!.md_path);
    expect(md).toContain("> Other model's reading");
    expect(other.calls.length).toBeGreaterThan(0);
  });

  it("the transcription model missing fails the job instead of silently using one model", async () => {
    const { e, store, runner } = setup({ textModel: "glm-ocr" }, new FakeProvider(), null);
    await e.engine.poll();
    await runner.step();
    const ns = e.state.get(ID.pens)!;
    const all = [store.get(ID.pens, ns.revision)].filter(Boolean);
    expect(all.some((j) => j!.status === "done")).toBe(false);
  });
});

describe("Transcribe command", () => {
  it("every refusal is returned for the notice and written to the plugin log; a queued note isn't queued twice", async () => {
    const e = (env = new Env());
    await e.engine.poll();
    let settings: Settings = { ...DEFAULTS, recProvider: "ollama", recModels: { ollama: "m" } };
    const rec = new RecognitionController({} as App, () => settings, e.state, e.vault, sharedRenderer, e.log, (fn) => fn(), () => {});
    rec.stop();                                                     // no timers in tests
    const logged = () => e.log.lines.filter((l) => l.includes("transcribe:"));

    expect(rec.enqueueNote("f1f1f1f1-0000-4000-0000-00000000dead", false)).toBe("this note wasn't imported by Memo Bridge");
    expect(logged().at(-1)).toContain("not queued: this note wasn't imported by Memo Bridge");

    expect(rec.enqueueNote(ID.pens, false)).toBeNull();             // queued
    expect(rec.enqueueNote(ID.pens, false)).toMatch(/already queued/);
    expect(logged().at(-1)).toContain(`${ID.pens} not queued: already queued`);

    rec.store.update(rec.store.get(ID.pens, e.state.get(ID.pens)!.revision)!, { status: "done" });
    expect(rec.enqueueNote(ID.pens, false)).toMatch(/already transcribed/);
    expect(logged().at(-1)).toMatch(/already transcribed/);
    expect(rec.enqueueNote(ID.pens, true)).toBeNull();              // Re-run is allowed

    settings = { ...settings, recProvider: "none" };
    expect(rec.enqueueNote(ID.pens, false)).toMatch(/choose a recognition provider/);
    expect(logged()).toHaveLength(4);
  });
});
