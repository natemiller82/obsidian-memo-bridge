// Rebuild the evaluation set's recognition images with the current code, from the same notes
// (read through the plugin's read-only snapshot, never LocalState itself), into
// local/eval/variants/<name>/<item>/p<k>.png, so a variant can be run and scored next to the
// original images. Prints numbers only (sizes, pen counts, widths, crop boxes), never content.
//   npm run eval -- images --variant <name> [--debug [--skeleton]] [--only <item prefix>] [--localstate <dir>]
// Then: npm run eval -- run ... --images <name>
import * as fs from "node:fs";
import * as path from "node:path";
import { MemoryLogger } from "../src/log";
import { defaultLocalState } from "../src/paths";
import { recognitionSvg } from "../src/recognize/image";
import { recognitionPages } from "../src/recognize/inputs";
import { LocalStateSource } from "../src/source";
import { arg, EVAL_DIR, flag, readSet, renderer } from "./common";
import { nodeRaster } from "./raster-node";

async function main() {
  const variant = arg("variant");
  if (!variant || !/^[a-z0-9-]+$/.test(variant)) throw new Error("--variant <name> (lowercase letters, digits, -) is required");
  const set = readSet();
  const out = path.join(EVAL_DIR, "variants", variant);
  const tmp = path.join(EVAL_DIR, ".tmp-images");
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const source = new LocalStateSource(arg("localstate") ?? defaultLocalState(), path.join(tmp, "snap"), new MemoryLogger());
    const notes = new Map((await source.listNotes()).map((n) => [n.id, n]));
    const r = renderer();
    for (const item of set) {
      const dir = path.join(out, item.key);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      if (!item.noteId) {                                    // synthetic control: same image
        for (const p of item.pages) fs.copyFileSync(path.join(EVAL_DIR, item.key, p.file), path.join(dir, p.file));
        continue;
      }
      const n = notes.get(item.noteId);
      if (!n) { console.log(`${item.key}: note no longer in the library; skipped`); continue; }
      const sdocx = path.join(tmp, "note.sdocx"), jpg = path.join(tmp, "thumb.jpg");
      fs.writeFileSync(sdocx, source.packageNote(n));
      const thumb = source.thumbnail(n);
      if (thumb) fs.writeFileSync(jpg, thumb); else fs.rmSync(jpg, { force: true });
      if (flag("debug") && item.render !== "thumbnail" && (!arg("only") || item.key.startsWith(arg("only")!))) {
        const doc = await r.render(new Uint8Array(fs.readFileSync(sdocx)));
        for (const [i, p] of doc.pages.entries()) {
          const vb = /viewBox="([^"]+)"/.exec(p.svg)?.[1];
          const pens = new Map<string, { n: number; w: number[]; bb: number[]; a: number[] }>();
          for (const s of p.strokes) {
            const k = `${s.pen} ${s.settings}`;
            const e = pens.get(k) ?? { n: 0, w: [], bb: [Infinity, Infinity, -Infinity, -Infinity], a: [] };
            e.n++; e.w.push(s.width); e.a.push(s.alpha);
            e.bb = [Math.min(e.bb[0], s.bbox[0]), Math.min(e.bb[1], s.bbox[1]), Math.max(e.bb[2], s.bbox[2]), Math.max(e.bb[3], s.bbox[3])];
            pens.set(k, e);
          }
          const tags = new Map<string, number>();
          for (const m of p.svg.matchAll(/<([a-z]+)\b/g)) tags.set(m[1], (tags.get(m[1]) ?? 0) + 1);
          const r1 = (x: number) => Math.round(x);
          console.log(`  p${i + 1} viewBox ${vb} elements ${JSON.stringify(Object.fromEntries(tags))}`);
          for (const [k, e] of pens) console.log(`    ${k}: ${e.n} strokes, width ${Math.min(...e.w).toFixed(2)}–${Math.max(...e.w).toFixed(2)}, alpha ${Math.min(...e.a).toFixed(2)}–${Math.max(...e.a).toFixed(2)}, bbox ${e.bb.map(r1).join(",")}`);
          if (flag("skeleton")) {
            const x = recognitionSvg(p.svg, p.strokes, 2.6);
            if (x) console.log(`    recognition image: ${/viewBox="[^"]*"/.exec(x.svg)?.[0]} paths=${(x.svg.match(/<path\b/g) ?? []).length} rects=${(x.svg.match(/<rect\b/g) ?? []).length}`);
            const pd = /<path\b[^>]*\sd="([^"]*)"/.exec(p.svg)?.[1] ?? "";
            console.log(`    first path numbers: ${(pd.match(/-?\d+(\.\d+)?/g) ?? []).map((v) => Math.round(Number(v))).join(" ")}`);
            const sk = p.svg.replace(/<line\b[^>]*\/>\s*/g, "").replace(/\sd="([^"]*)"/g, (_, d: string) => ` d="${d.length}ch"`).replace(/>\s+</g, "><");
            console.log(`    skeleton: ${sk.slice(0, 1500)}`);
          }
          // shapes other than stroke segments: attributes and geometry only
          for (const m of p.svg.matchAll(/<(rect|path|image|polygon)\b([^>]*)>/g)) {
            if (m[1] === "path" && pens.size && tags.get("path")! > 40) break;
            const attrs = [...m[2].matchAll(/([a-z-]+)="([^"]*)"/g)].map(([, k, v]) => k === "d" ? `d:${v.length}ch cmds=${[...new Set(v.match(/[a-zA-Z]/g) ?? [])].join("")} nums=${(v.match(/-?\d+(\.\d+)?/g) ?? []).slice(0, 4).join("/")}` : k === "href" || k === "xlink:href" ? `${k}:${v.length}ch` : `${k}=${v.slice(0, 40)}`);
            console.log(`    <${m[1]}> ${attrs.join(" ")}`);
          }
        }
      }
      if (flag("debug") && thumb && item.render === "thumbnail" && (!arg("only") || item.key.startsWith(arg("only")!))) {
        const img = await nodeRaster.jpegToRgba(thumb);
        const hist = (px: ArrayLike<number>, w: number, h: number) => {
          const bins = new Array(10).fill(0);
          let dx0 = w, dy0 = h, dx1 = -1, dy1 = -1;
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4, l = (0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]) / 255;
            bins[Math.min(9, Math.floor(l * 10))]++;
            if (l < 0.3) { dx0 = Math.min(dx0, x); dy0 = Math.min(dy0, y); dx1 = Math.max(dx1, x); dy1 = Math.max(dy1, y); }
          }
          return `lum deciles % ${bins.map((b) => (100 * b / (w * h)).toFixed(1)).join(" ")} | dark(<0.3) box ${dx0},${dy0}-${dx1},${dy1}`;
        };
        console.log(`  thumbnail ${img.w}x${img.h} raw: ${hist(img.px, img.w, img.h)}`);
        // dark rows/columns: where the dark area sits (fraction of each tenth of the image that is dark)
        const band = (axis: "x" | "y") => {
          const n = axis === "x" ? img.w : img.h, out = new Array(10).fill(0), tot = new Array(10).fill(0);
          for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
            const o = (y * img.w + x) * 4, l = (0.2126 * img.px[o] + 0.7152 * img.px[o + 1] + 0.0722 * img.px[o + 2]) / 255;
            const i = Math.min(9, Math.floor(((axis === "x" ? x : y) / n) * 10));
            tot[i]++; if (l < 0.3) out[i]++;
          }
          return out.map((v, i) => (100 * v / tot[i]).toFixed(0)).join(" ");
        };
        console.log(`    dark % by tenth, left→right: ${band("x")}; top→bottom: ${band("y")}`);
      }
      const pages = await recognitionPages({ render: item.render === "thumbnail" ? "thumbnail" : "sdocx", sdocx_path: sdocx, png_path: JSON.stringify(thumb ? [jpg] : []) },
        r, nodeRaster, 2.6);
      const before = item.pages.map((p) => `${p.w}x${p.h}`).join(" ");
      for (const p of pages) fs.writeFileSync(path.join(dir, `p${p.page}.png`), p.png);
      console.log(`${item.key}: ${pages.map((p) => `p${p.page} ${p.w}x${p.h}`).join(", ")} (was ${before})`);
      if (new Set(pages.map((p) => p.page)).size !== item.pages.length) console.log(`  page count differs from the set (${item.pages.length})`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
