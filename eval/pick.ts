// Choose the evaluation set and write each page's recognition image to local/eval/<key>/p<k>.png.
// Reads Samsung's LocalState only through the plugin's read-only snapshot. Prints metadata
// (dates, pens, page counts), never note content. Usage: npm run eval -- pick [--localstate <dir>]
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { MemoryLogger } from "../src/log";
import { defaultLocalState } from "../src/paths";
import { encodePng } from "../src/recognize/image";
import { recognitionPages } from "../src/recognize/inputs";
import { LocalStateSource, type SourceNote } from "../src/source";
import { arg, EVAL_DIR, renderer, SET_FILE, type EvalItem } from "./common";
import { nodeRaster } from "./raster-node";

const require = createRequire(import.meta.url);
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Survey {
  n: SourceNote;
  parsed: boolean;
  pageCount: number;
  inkedPages: number;
  strokes: number;
  pens: Set<string>;          // "FountainPen 13;"
  sizes: Set<number>;
  typedChars: number;
  hasThumb: boolean;
}

const local = (ms: number) => { const d = new Date(ms); const p = (x: number) => String(x).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

async function main() {
  const localState = arg("localstate") ?? defaultLocalState();
  const tmp = path.join(EVAL_DIR, ".tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const log = new MemoryLogger();
  const source = new LocalStateSource(localState, path.join(tmp, "snap"), log);   // copies the DB; never writes LocalState
  const notes = (await source.listNotes()).filter((n) => !n.legacySdoc && !n.trashed && !n.locked);

  const m = await import("@twango/sdocx");
  await m.default({ module_or_path: fs.readFileSync(require.resolve("@twango/sdocx/sdocx_bg.wasm")) });
  const survey: Survey[] = [];
  for (const n of notes) {
    const s: Survey = { n, parsed: false, pageCount: 0, inkedPages: 0, strokes: 0, pens: new Set(), sizes: new Set(), typedChars: 0, hasThumb: false };
    let pkg: Uint8Array;
    try { pkg = source.packageNote(n); } catch { continue; }
    try {
      const ses = new m.DocumentSession(pkg);
      try {
        const ins = ses.inspection() as J;
        s.parsed = true;
        s.pageCount = ses.page_count;
        for (const p of (ins.layout?.pages ?? []) as J[]) {
          let ink = 0;
          for (const o of (p.page?.objects ?? []) as J[]) {
            const st = o.content?.Stroke;
            if (st) {
              ink++;
              s.pens.add(`${String(st.rendering?.pen_name ?? "").split(".").pop()} ${st.rendering?.advanced_settings ?? ""}`);
              s.sizes.add(Math.round(Number(st.pen_width ?? 0) * 100) / 100);
            }
            const tb = o.content?.Element?.TextBox;
            if (tb && typeof tb.text === "string") s.typedChars += tb.text.trim().length;
          }
          if (ink) s.inkedPages++;
          s.strokes += ink;
        }
      } finally { ses.free(); }
    } catch {
      s.hasThumb = !!source.thumbnail(n);
    }
    survey.push(s);
  }
  const has = (s: Survey, pen: string) => [...s.pens].some((p) => p.startsWith(pen));
  const by = (f: (s: Survey) => boolean, order: (a: Survey, b: Survey) => number = (a, b) => b.n.createdMs - a.n.createdMs) =>
    survey.filter(f).sort(order);
  const newest = (a: Survey, b: Survey) => b.n.createdMs - a.n.createdMs, oldest = (a: Survey, b: Survey) => a.n.createdMs - b.n.createdMs;
  const most = (a: Survey, b: Survey) => b.strokes - a.strokes;
  const range = (s: Survey) => Math.max(...s.sizes) - Math.min(...s.sizes);
  const spread = (a: Survey, b: Survey) => range(b) - range(a);
  const modern = (s: Survey) => s.parsed && s.inkedPages > 0;
  const legacy = (s: Survey) => !s.parsed && s.hasThumb;

  // [key, why, candidates]: the first candidate not already taken is used.
  const rules: [string, string, Survey[]][] = [
    ["01-screenoff-fountain18", "screen-off memo, current fountain pen (18;), five sizes", by((s) => modern(s) && s.n.isScreenOff && has(s, "FountainPen 18;") && s.sizes.size >= 4, newest)],
    ["02-screenoff-fountain13-sizes", "screen-off memo, line-drawn fountain pen 13;, small and large sizes", by((s) => modern(s) && s.n.isScreenOff && has(s, "FountainPen 13;") && s.sizes.size >= 2, spread)],
    ["03-screenoff-fountain15", "screen-off memo, fountain pen 15;0;100;", by((s) => modern(s) && s.n.isScreenOff && has(s, "FountainPen 15;"), most)],
    ["04-note-fountain15", "in-app note, fountain pen 15;0;100;", by((s) => modern(s) && !s.n.isScreenOff && has(s, "FountainPen 15;") && s.inkedPages === 1, most)],
    ["05-note-fountain14", "in-app note, outline-drawn fountain pen 14;", by((s) => modern(s) && !s.n.isScreenOff && has(s, "FountainPen 14;"), most)],
    ["06-highlighter-fountain12", "fountain pen 12; with highlighter", by((s) => modern(s) && has(s, "FountainPen 12;") && has(s, "Marker4"), newest)],
    ["07-inkpen1-dense", "InkPen 1;, dense page", by((s) => modern(s) && has(s, "InkPen 1;") && s.inkedPages === 1, most)],
    ["08-screenoff-inkpen4", "screen-off memo, InkPen 4; (2020)", by((s) => modern(s) && s.n.isScreenOff && has(s, "InkPen 4;"), most)],
    ["09-fountain11", "fountain pen 11; (2022)", by((s) => modern(s) && has(s, "FountainPen 11;"), most)],
    ["10-pentest-pens", "pen test: pen, fountain pen, calligraphy pen", by((s) => modern(s) && has(s, "InkPen2") && has(s, "ObliquePen"), newest)],
    ["11-pentest-pencil-brush-markers", "pen test: pencil, brush, highlighter, marker", by((s) => modern(s) && has(s, "Marker3") && has(s, "BrushPen"), newest)],
    ["12-pencil-scribbles", "mostly pencil (scribbles; may have no words)", by((s) => modern(s) && has(s, "Pencil2") && !has(s, "Marker3"), newest)],
    ["13-typed-and-ink", "typed text plus handwriting (typed text is not in the image)", by((s) => modern(s) && s.typedChars > 0, newest)],
    ["14-multipage", "current-format note with several handwritten pages", by((s) => modern(s) && s.inkedPages >= 2 && s.inkedPages <= 4, most)],
    ["15-thumb-screenoff", "old screen-off memo, Samsung thumbnail (dark page)", by((s) => legacy(s) && s.n.isScreenOff, oldest)],
    ["16-thumb-note-typed", "old in-app note with typed text, thumbnail", by((s) => legacy(s) && !s.n.isScreenOff && s.n.plainText.trim().length > 0, newest)],
    ["17-thumb-note", "old in-app note, thumbnail", by((s) => legacy(s) && !s.n.isScreenOff && !s.n.plainText.trim(), newest)],
    ["18-thumb-oldest", "oldest note in the library, thumbnail", by((s) => legacy(s), oldest)],
  ];

  const taken = new Set<string>();
  const items: EvalItem[] = [];
  const r = renderer();
  for (const [key, why, cands] of rules) {
    const s = cands.find((c) => !taken.has(c.n.id));
    if (!s) { console.log(`${key}: no note matches (${why}); skipped`); continue; }
    taken.add(s.n.id);
    const dir = path.join(EVAL_DIR, key);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const sdocx = path.join(tmp, `${key}.sdocx`), jpg = path.join(tmp, `${key}.jpg`);
    fs.writeFileSync(sdocx, source.packageNote(s.n));
    const thumb = source.thumbnail(s.n);
    if (thumb) fs.writeFileSync(jpg, thumb);
    const pages = await recognitionPages({ render: s.parsed ? "sdocx" : "thumbnail", sdocx_path: sdocx, png_path: JSON.stringify(thumb ? [jpg] : []) }, r, nodeRaster, 2.6);
    const item: EvalItem = {
      key, why, noteId: s.n.id, created: local(s.n.createdMs), folder: s.n.folder.join("/"), screenOff: s.n.isScreenOff,
      render: s.parsed ? "sdocx" : "thumbnail", pens: [...s.pens].sort(), expectEmpty: false, pages: [],
    };
    for (const p of pages) {
      const file = `p${p.page}.png`;
      fs.writeFileSync(path.join(dir, file), p.png);
      item.pages.push({ file, w: p.w, h: p.h, source: p.source });
    }
    items.push(item);
    console.log(`${key}: ${item.created} ${item.render} ${item.pages.length} page(s) ${item.pens.join(", ")}`);
  }

  // Synthetic controls (not the user's notes): must come back with an empty transcription.
  const blank = `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="1500" viewBox="0 0 1100 1500"><rect width="1100" height="1500" fill="#ffffff"/></svg>`;
  const shapes = `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="1500" viewBox="0 0 1100 1500"><rect width="1100" height="1500" fill="#ffffff"/>
    <g fill="none" stroke="#202020" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="300" cy="350" r="160"/><rect x="600" y="220" width="320" height="260" rx="20"/>
    <path d="M 220 800 Q 420 650 560 820 T 900 800"/><path d="M 300 1100 L 800 1100 M 760 1060 L 800 1100 L 760 1140"/>
    <polyline points="200,1300 300,1220 400,1320 500,1210 600,1330 700,1230 800,1320"/></g></svg>`;
  for (const [key, why, svg] of [["19-control-blank", "control: blank white page", blank], ["20-control-shapes", "control: drawing only (shapes, arrow, zigzag), no words", shapes]] as const) {
    const dir = path.join(EVAL_DIR, key);
    fs.mkdirSync(dir, { recursive: true });
    const rgba = await nodeRaster.svgToRgba(svg, 1100, 1500);
    fs.writeFileSync(path.join(dir, "p1.png"), encodePng(rgba));
    fs.writeFileSync(path.join(dir, "p1.truth.txt"), "");
    items.push({ key, why, noteId: null, created: null, folder: null, screenOff: false, render: "synthetic", pens: [], expectEmpty: true,
      pages: [{ file: "p1.png", w: rgba.w, h: rgba.h, source: "synthetic" }] });
    console.log(`${key}: synthetic control`);
  }

  fs.writeFileSync(SET_FILE, JSON.stringify(items, null, 1));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${items.length} items, ${items.reduce((n, i) => n + i.pages.length, 0)} pages -> ${EVAL_DIR}`);
  console.log(`survey: ${survey.length} notes, ${survey.filter((s) => s.parsed).length} readable by sdocx, ${survey.filter((s) => !s.parsed && s.hasThumb).length} thumbnail-only`);
}

main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
