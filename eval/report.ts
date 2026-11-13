// Compare runs: error rates against the user's corrected transcriptions (where present) and,
// without ground truth, agreement between runs, [?] counts, invented text on the controls,
// schema failures and speed. Writes local/eval/report.md; prints the same tables (numbers only).
//   npm run eval -- report
import * as fs from "node:fs";
import * as path from "node:path";
import { costOf, estimatePage } from "../src/recognize/pricing";
import { withTranscription } from "../src/recognize/prompt";
import type { ProviderKind } from "../src/recognize/providers";
import { EVAL_DIR, readSet, RUNS_DIR, truthFor, type EvalItem } from "./common";
import { agree, cer, cleanOcr, lev, norm } from "./metrics";
import type { PageRun } from "./run";

interface RunMeta { kind: ProviderKind; model: string; mode: string; hint: boolean; images?: string | null }
interface Run { id: string; meta: RunMeta; pages: Map<string, PageRun> }

function loadRuns(): Run[] {
  if (!fs.existsSync(RUNS_DIR)) return [];
  const out: Run[] = [];
  for (const id of fs.readdirSync(RUNS_DIR).sort()) {
    const dir = path.join(RUNS_DIR, id);
    if (!fs.existsSync(path.join(dir, "run.json"))) continue;
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")) as RunMeta;
    const pages = new Map<string, PageRun>();
    for (const key of fs.readdirSync(dir)) {
      const kd = path.join(dir, key);
      if (!fs.statSync(kd).isDirectory()) continue;
      for (const f of fs.readdirSync(kd)) if (/^p\d+\.json$/.test(f)) pages.set(`${key}/${f.slice(0, -5)}`, JSON.parse(fs.readFileSync(path.join(kd, f), "utf8")));
    }
    // answers recorded before cleanOcr existed: clean them the same way now (idempotent)
    if (meta.mode === "ocr") for (const x of pages.values()) if (x.ok && x.result) {
      x.result.transcription = cleanOcr(x.result.transcription);
      x.result.has_text = !!x.result.transcription;
    }
    out.push({ id, meta, pages });
  }
  // Two-model setups, as the plugin would combine them: each OCR-mode run's text with each
  // JSON run's description, on the same images and hint (the plugin's withTranscription rule).
  const ocr = out.filter((r) => r.meta.mode === "ocr"), json = out.filter((r) => r.meta.mode !== "ocr");
  for (const t of ocr) for (const d of json) {
    if ((t.meta.images ?? null) !== (d.meta.images ?? null) || t.meta.kind !== d.meta.kind) continue;
    const pages = new Map<string, PageRun>();
    for (const [key, dp] of d.pages) {
      const tp = t.pages.get(key);
      if (!tp) continue;
      if (!dp.ok || !tp.ok) { pages.set(key, !dp.ok ? dp : tp); continue; }
      const u = (k: "inputTokens" | "outputTokens") => dp.usage?.[k] != null && tp.usage?.[k] != null ? dp.usage![k]! + tp.usage![k]! : null;
      pages.set(key, { ok: true, ms: dp.ms + tp.ms, usage: { inputTokens: u("inputTokens"), outputTokens: u("outputTokens") },
        result: withTranscription(dp.result!, tp.result!.transcription) });
    }
    out.push({ id: `${t.id} + ${d.id}`, meta: { ...d.meta, model: `${t.meta.model}+${d.meta.model}`, mode: "combined" }, pages });
  }
  return out;
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const med = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);

function table(head: string[], rows: (string | number)[][]): string {
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

function main() {
  const set = readSet();
  const runs = loadRuns();
  const pageKeys: { item: EvalItem; page: number; key: string }[] = set.flatMap((item) => item.pages.map((_, i) => ({ item, page: i + 1, key: `${item.key}/p${i + 1}` })));
  const controls = pageKeys.filter((p) => p.item.expectEmpty);
  const real = pageKeys.filter((p) => !p.item.expectEmpty);
  const truthPages = real.filter((p) => truthFor(p.item, p.page) !== null);
  const md: string[] = [`# Recognition evaluation`, "", `${set.length} items, ${pageKeys.length} pages (${controls.length} synthetic controls). ` +
    `Ground truth: ${truthPages.length} of ${real.length} real pages corrected.`, ""];

  // ---- per run, no ground truth needed ----
  const rows = runs.map((r) => {
    const got = pageKeys.map((p) => r.pages.get(p.key)).filter((x): x is PageRun => !!x);
    const ok = got.filter((x) => x.ok);
    const schema = got.filter((x) => x.failure === "schema").length, prov = got.filter((x) => x.failure === "provider").length;
    const timeouts = got.filter((x) => x.failure === "timeout").length;
    const invented = controls.filter((p) => { const x = r.pages.get(p.key); return x?.ok && (x.result!.has_text || x.result!.transcription.trim()); }).length;
    const marks = ok.reduce((n, x) => n + x.result!.unreadable, 0);
    const empties = real.filter((p) => { const x = r.pages.get(p.key); return x?.ok && !x.result!.has_text; }).length;
    const langs = new Map<string, number>();
    for (const x of ok) for (const l of x.result!.languages.length ? x.result!.languages : [x.result!.language]) if (l) langs.set(l, (langs.get(l) ?? 0) + 1);
    const sec = ok.map((x) => x.ms / 1000);
    const w = med(set.flatMap((i) => i.pages.map((p) => p.w))), h = med(set.flatMap((i) => i.pages.map((p) => p.h)));
    const cost = estimatePage(r.meta.kind, r.meta.model, w, h);
    // actual: the provider's reported tokens at list prices, per answered page
    const paid = ok.map((x) => costOf(r.meta.kind, r.meta.model, x.usage?.inputTokens ?? null, x.usage?.outputTokens ?? null));
    const actual = r.meta.kind === "ollama" ? "local" : paid.length && paid.every((c) => c !== null) ? `$${(paid.reduce((a, c) => a + c!, 0) / paid.length).toFixed(4)}` : "?";
    return [r.id, `${got.length}/${pageKeys.length}`, schema, timeouts, prov, `${invented}/${controls.length}`, empties, marks,
      [...langs].map(([l, n]) => `${l}×${n}`).join(" ") || "–", med(sec).toFixed(1), mean(sec).toFixed(1),
      cost === null ? (r.meta.kind === "ollama" ? "local" : "?") : `$${cost.toFixed(4)}`, actual];
  });
  md.push("## Runs (no ground truth needed)", "", table(["run", "pages answered", "schema failures", "timeouts (runaway output)", "provider errors",
    "text invented on blank controls", "real pages said to have no text", "[?] marks", "languages", "s/page median", "s/page mean", "cost/page (estimate)", "cost/page (actual tokens)"], rows), "");

  // ---- agreement between runs ----
  const both = (a: Run, b: Run) => real.map((p) => [a.pages.get(p.key), b.pages.get(p.key)] as const).filter(([x, y]) => x?.ok && y?.ok);
  const agreeRows: (string | number)[][] = [];
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
    const pairs = both(runs[i], runs[j]);
    if (!pairs.length) continue;
    const sims = pairs.map(([x, y]) => agree(x!.result!.transcription, y!.result!.transcription));
    const hasText = pairs.filter(([x, y]) => x!.result!.has_text === y!.result!.has_text).length;
    agreeRows.push([runs[i].id, runs[j].id, pairs.length, pct(mean(sims)), pct(med(sims)), `${hasText}/${pairs.length}`]);
  }
  md.push("## Agreement between runs (real pages; 100% = same text after ignoring case, punctuation and [?])", "",
    table(["run A", "run B", "pages", "mean similarity", "median similarity", "same has_text"], agreeRows), "");

  // ---- against ground truth ----
  if (truthPages.length) {
    const t = (p: { item: EvalItem; page: number }) => truthFor(p.item, p.page)!;
    const chars = (s: string, loose: boolean) => [...norm(s, loose)];
    const words = (s: string, loose: boolean) => norm(s, loose).split(" ").filter(Boolean);
    /** Edits over all scored pages ÷ reference length over those pages; a failed page (with `failAsWrong`) costs its whole reference. */
    const pooled = (r: Run, unit: "c" | "w", loose: boolean, failAsWrong: boolean) => {
      let e = 0, n = 0;
      for (const p of truthPages) {
        const x = r.pages.get(p.key);
        const ref = unit === "c" ? chars(t(p), loose) : words(t(p), loose);
        if (!x?.ok) { if (failAsWrong) { e += ref.length; n += ref.length; } continue; }
        const hyp = unit === "c" ? chars(x.result!.transcription, loose) : words(x.result!.transcription, loose);
        e += lev(hyp, ref); n += ref.length;
      }
      return n ? e / n : NaN;
    };
    const emptyTruth = truthPages.filter((p) => t(p) === "");
    const gt = runs.map((r) => {
      const ev = truthPages.map((p) => ({ p, x: r.pages.get(p.key) })).filter((e) => e.x?.ok);
      const emptyOk = emptyTruth.filter((p) => { const x = r.pages.get(p.key); return x?.ok && !x.result!.transcription.trim(); }).length;
      return [r.id, `${ev.length}/${truthPages.length}`,
        pct(pooled(r, "c", true, false)), pct(pooled(r, "w", true, false)),
        pct(pooled(r, "c", false, false)), pct(pooled(r, "w", false, false)),
        pct(pooled(r, "c", true, true)), pct(pooled(r, "w", true, true)),
        pct(mean(ev.filter((e) => t(e.p) !== "").map((e) => cer(e.x!.result!.transcription, t(e.p), true)))),
        `${emptyOk}/${emptyTruth.length}`];
    });
    md.push("## Against your corrected transcriptions", "",
      "Pooled: all edits ÷ all reference characters (or words) over the pages the run answered, so long pages weigh more than short ones. " +
      "Loose ignores case and punctuation; strict counts them. [?] is removed before comparing, so an unreadable mark costs the word it replaced. " +
      "\"Failures as wrong\" also counts each page the run didn't answer as entirely wrong. \"Per-page mean\" averages each page's CER (pages with text only). " +
      "\"Empty pages right\": real pages you marked as having no text, where the run also returned no text.", "",
      table(["run", "pages scored", "CER loose", "WER loose", "CER strict", "WER strict", "CER loose, failures as wrong", "WER loose, failures as wrong", "per-page mean CER loose", "empty pages right"], gt), "");
    const byItem: (string | number)[][] = [];
    for (const p of truthPages) byItem.push([p.key, p.item.why, ...runs.map((r) => { const x = r.pages.get(p.key); return x?.ok ? pct(cer(x.result!.transcription, truthFor(p.item, p.page)!, true)) : "–"; })]);
    md.push("### CER (loose) per page", "", table(["page", "case", ...runs.map((r) => r.id)], byItem), "");
  } else {
    md.push("## Against your corrected transcriptions", "", "Not yet: correct the drafts in review.html first.", "");
  }

  fs.writeFileSync(path.join(EVAL_DIR, "report.md"), md.join("\n"));
  console.log(md.join("\n"));
}

main();
