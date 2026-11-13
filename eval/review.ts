// Build local/eval/review.html: each page image next to an editable draft transcription (from
// the chosen run), other runs' drafts for reference, and a Save button that writes the corrected
// text to local/eval/<item>/p<k>.truth.txt (File System Access API; Edge/Chrome) or downloads a
// truth.json to put in local/eval. Self-contained: images inline, no network.
//   npm run eval -- review [--run <run id>] [--images <variant>|--images original]
// Images: local/eval/variants/final (what the plugin sends now) when it exists, else the set's own.
import * as fs from "node:fs";
import * as path from "node:path";
import { arg, EVAL_DIR, readSet, RUNS_DIR, truthFor } from "./common";
import type { PageRun } from "./run";

function runIds(): string[] {
  return fs.existsSync(RUNS_DIR) ? fs.readdirSync(RUNS_DIR).filter((d) => fs.existsSync(path.join(RUNS_DIR, d, "run.json"))).sort() : [];
}

function readPage(run: string, key: string): PageRun | null {
  const f = path.join(RUNS_DIR, run, `${key}.json`);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as PageRun) : null;
}

/** Runs ranked as draft sources: most pages answered with text first. */
function rankRuns(ids: string[], keys: string[]): string[] {
  const score = (id: string) => keys.filter((k) => { const r = readPage(id, k); return r?.ok && r.result!.has_text; }).length;
  return [...ids].sort((a, b) => score(b) - score(a));
}

function main() {
  const set = readSet();
  const ids = runIds();
  const keys = set.flatMap((i) => i.pages.map((_, k) => `${i.key}/p${k + 1}`));
  const ranked = arg("run") ? [arg("run")!, ...ids.filter((i) => i !== arg("run"))] : rankRuns(ids, keys);
  const draftRun = ranked[0] ?? null;
  const want = arg("images") ?? "final";
  const variant = want !== "original" && fs.existsSync(path.join(EVAL_DIR, "variants", want)) ? want : null;
  const imageFile = (key: string, file: string) => {
    const v = variant ? path.join(EVAL_DIR, "variants", variant, key, file) : null;
    return v && fs.existsSync(v) ? v : path.join(EVAL_DIR, key, file);
  };
  const data = set.map((item) => ({
    key: item.key, why: item.why, created: item.created, render: item.render, control: item.expectEmpty,
    pages: item.pages.map((p, k) => {
      const key = `${item.key}/p${k + 1}`;
      const runs: Record<string, string> = {};
      for (const id of ids) { const r = readPage(id, key); runs[id] = r?.ok ? r.result!.transcription : `(${r ? `failed: ${r.failure}` : "not run"})`; }
      // first run (in rank order) that answered this page; text preferred over "no text"
      const answered = ranked.map((id) => ({ id, r: readPage(id, key) })).filter((x) => x.r?.ok);
      const pick = answered.find((x) => x.r!.result!.has_text) ?? answered[0];
      const dr = pick?.r ?? null;
      return {
        key, img: `data:image/png;base64,${fs.readFileSync(imageFile(item.key, p.file)).toString("base64")}`,
        changed: !!variant && !fs.readFileSync(imageFile(item.key, p.file)).equals(fs.readFileSync(path.join(EVAL_DIR, item.key, p.file))),
        source: p.source, truth: truthFor(item, k + 1), draft: dr?.ok ? dr.result!.transcription : "", draftFrom: pick?.id ?? "", runs,
      };
    }),
  }));
  const json = JSON.stringify({ draftRun: ranked.join(" › "), items: data }).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Transcription review</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1f;--mute:#6b6b70;--line:#dddcd7;--ok:#1f7a4d;--warn:#a15c00;--acc:#2f5bd3}
@media (prefers-color-scheme:dark){:root{--bg:#18181a;--card:#222225;--ink:#ececee;--mute:#a0a0a8;--line:#38383d;--ok:#5cc28f;--warn:#e0a24a;--acc:#7b9cff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,sans-serif}
header{position:sticky;top:0;z-index:2;background:var(--card);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
header h1{font-size:16px;margin:0 8px 0 0}#progress{color:var(--mute)}button{font:inherit;padding:6px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);cursor:pointer}
button.primary{background:var(--acc);border-color:var(--acc);color:#fff}main{max-width:1500px;margin:0 auto;padding:16px}
.intro{color:var(--mute);max-width:900px}.page{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:16px 0;padding:14px;display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:16px}
@media (max-width:900px){.page{grid-template-columns:1fr}}.page.done{border-color:var(--ok)}.meta{grid-column:1/-1;display:flex;gap:10px;flex-wrap:wrap;align-items:baseline}
.meta b{font-size:15px}.tag{font-size:12px;color:var(--mute);border:1px solid var(--line);border-radius:999px;padding:1px 8px}.img{background:#fff;border:1px solid var(--line);border-radius:8px;overflow:auto;max-height:80vh}
.img img{display:block;width:100%;height:auto}textarea{width:100%;min-height:260px;font:14px/1.5 ui-monospace,Consolas,monospace;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);resize:vertical}
.row{display:flex;gap:8px;align-items:center;margin:8px 0;flex-wrap:wrap}.state{font-size:13px;color:var(--mute)}.done .state{color:var(--ok)}details{margin-top:8px}details pre{white-space:pre-wrap;font:13px/1.45 ui-monospace,Consolas,monospace;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px;margin:6px 0}
summary{cursor:pointer;color:var(--mute)}#msg{color:var(--warn)}
</style></head><body>
<header><h1>Transcription review</h1><span id="progress"></span>
<button class="primary" id="save">Save to local/eval…</button><button id="download">Download truth.json</button><span id="msg"></span></header>
<main>
<p class="intro">Correct each draft so it says exactly what is written: same spelling, abbreviations and line breaks, nothing added.
Write [?] only where you can't read a word yourself. A page with no handwritten words should be empty. Click <b>Mark correct</b> on each page you've checked;
only checked pages are saved and scored. Your edits are kept in this browser until you save. <b>Save to local/eval…</b> asks for the
<code>local/eval</code> folder once and writes <code>&lt;item&gt;/p&lt;n&gt;.truth.txt</code>. If your browser can't do that, use <b>Download truth.json</b> and move the file into <code>local/eval</code>.
Each page's draft comes from the first run that read text on it (shown on the page); runs ranked: <b id="draftrun"></b>.</p>
<div id="list"></div></main>
<script type="application/json" id="data">${json}</script>
<script>
const D = JSON.parse(document.getElementById("data").textContent);
document.getElementById("draftrun").textContent = D.draftRun || "(no run yet)";
const LS = "memo-bridge-eval-review";
let st = {}; try { st = JSON.parse(localStorage.getItem(LS) || "{}"); } catch {}
const persist = () => { try { localStorage.setItem(LS, JSON.stringify(st)); } catch {} };
const pages = D.items.flatMap((it) => it.pages.map((p) => ({ it, p })));
for (const { it, p } of pages) if (!st[p.key]) st[p.key] = { text: p.truth ?? (it.control ? "" : p.draft), checked: p.truth !== null };
const list = document.getElementById("list");
const progress = () => { const n = pages.filter(({ p }) => st[p.key].checked).length; document.getElementById("progress").textContent = n + " of " + pages.length + " pages checked"; };
for (const { it, p } of pages) {
  const el = document.createElement("section"); el.className = "page";
  const meta = document.createElement("div"); meta.className = "meta";
  const b = document.createElement("b"); b.textContent = p.key; meta.append(b);
  for (const t of [it.why, it.created || "synthetic", p.source === "thumbnail" ? "from Samsung's thumbnail" : p.source, p.draftFrom ? "draft: " + p.draftFrom : "no draft", ...(p.changed ? ["image changed since you corrected it: check again"] : [])]) { const s = document.createElement("span"); s.className = "tag"; s.textContent = t; meta.append(s); }
  const imgBox = document.createElement("div"); imgBox.className = "img"; const img = document.createElement("img"); img.src = p.img; img.alt = "page " + p.key; imgBox.append(img);
  const right = document.createElement("div");
  const ta = document.createElement("textarea"); ta.value = st[p.key].text; ta.spellcheck = false;
  const row = document.createElement("div"); row.className = "row";
  const btn = document.createElement("button"); const state = document.createElement("span"); state.className = "state";
  const reset = document.createElement("button"); reset.textContent = "Reset to draft";
  const paint = () => { el.classList.toggle("done", st[p.key].checked); btn.textContent = st[p.key].checked ? "Checked ✓ (click to undo)" : "Mark correct"; state.textContent = st[p.key].checked ? "will be saved" : "not checked"; progress(); };
  ta.addEventListener("input", () => { st[p.key].text = ta.value; persist(); });
  btn.addEventListener("click", () => { st[p.key].checked = !st[p.key].checked; st[p.key].text = ta.value; persist(); paint(); });
  reset.addEventListener("click", () => { ta.value = it.control ? "" : p.draft; st[p.key].text = ta.value; persist(); });
  row.append(btn, reset, state);
  const det = document.createElement("details"); const sum = document.createElement("summary"); sum.textContent = "Other runs' drafts"; det.append(sum);
  for (const [run, text] of Object.entries(p.runs)) {
    const h = document.createElement("div"); h.className = "row"; const n = document.createElement("span"); n.className = "tag"; n.textContent = run;
    const use = document.createElement("button"); use.textContent = "Use this"; use.addEventListener("click", () => { ta.value = text.startsWith("(") ? "" : text; st[p.key].text = ta.value; persist(); });
    const pre = document.createElement("pre"); pre.textContent = text || "(empty: no text)"; h.append(n, use); det.append(h, pre);
  }
  right.append(ta, row, det); el.append(meta, imgBox, right); list.append(el); paint();
}
const checked = () => Object.fromEntries(pages.filter(({ p }) => st[p.key].checked).map(({ p }) => [p.key, st[p.key].text.replace(/\\r\\n/g, "\\n").trim()]));
const msg = (t) => { document.getElementById("msg").textContent = t; };
document.getElementById("download").addEventListener("click", () => {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(checked(), null, 1)], { type: "application/json" }));
  a.download = "truth.json"; a.click(); msg("Downloaded truth.json: move it into local/eval.");
});
document.getElementById("save").addEventListener("click", async () => {
  if (!window.showDirectoryPicker) { msg("This browser can't write files; use Download truth.json instead (or open this page in Edge)."); return; }
  try {
    const dir = await window.showDirectoryPicker({ id: "memo-bridge-eval", mode: "readwrite" });
    try { await dir.getFileHandle("set.json"); } catch { msg("That isn't the local/eval folder (no set.json in it). Nothing was written."); return; }
    let n = 0;
    for (const [key, text] of Object.entries(checked())) {
      const [item, page] = key.split("/");
      const d = await dir.getDirectoryHandle(item);
      const f = await d.getFileHandle(page + ".truth.txt", { create: true });
      const w = await f.createWritable(); await w.write(text + (text ? "\\n" : "")); await w.close(); n++;
    }
    msg("Saved " + n + " page(s) to local/eval.");
  } catch (e) { if (e && e.name !== "AbortError") msg("Couldn't save: " + e.message); }
});
progress();
</script></body></html>`;
  fs.writeFileSync(path.join(EVAL_DIR, "review.html"), html);
  console.log(`review page: ${path.join(EVAL_DIR, "review.html")} (${pages(data)} pages, images: ${variant ?? "original"}, ` +
    `${data.reduce((n, i) => n + i.pages.filter((p) => p.changed).length, 0)} changed since correction, drafts from ${draftRun ?? "no run"})`);
}

const pages = (d: { pages: unknown[] }[]) => d.reduce((n, i) => n + i.pages.length, 0);
main();
