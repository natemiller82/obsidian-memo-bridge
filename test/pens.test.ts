// Regression test for the pen table, against Samsung's own full-view rendering.
//
// Reference: Samsung Notes for Windows "Save as file > Image" exports of the fixture notes
// (test/fixtures/exports, metadata stripped). They match the phone; Samsung's thumbnails
// do not, so they are not used here.
//
// Method, per stroke point (every 2nd point of every stroke): take the coverage profile
// across the stroke (perpendicular to its direction, bilinear, 0.25 px steps) in both
// Samsung's export and our corrected SVG rasterised at the same scale. Width = area under
// the profile / its peak (sub-pixel "full-width equivalent"); opacity = the peak.
// F = Samsung width / our width. Per pen group, F is the median over strokes of each
// stroke's median F: a self-overlapping stroke (a scribble, a looped underline) merges into
// one wide run in the profile, which would otherwise skew a group. Opacities must agree.
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it } from "vitest";
import { styleSvg } from "../src/render/style";
import { zipStored } from "../src/zip";
import { FIX, ID, sharedRenderer } from "./helpers";
import { decodePng, type Rgba } from "./png";

const require = createRequire(import.meta.url);
// The parts of sdocx's inspection() result this test reads (the binding returns it untyped).
interface InsStroke {
  rendering: { pen_name: string; advanced_settings?: string; style: { color_argb: number; pen_size: number } };
  points: { x: number; y: number }[];
  pressures: number[];
}
interface Inspection {
  document: { pages: { objects: { content?: { Stroke?: InsStroke } }[] }[] };
  layout: { pages: { width: number; page?: { width?: number } }[] };
}

interface Stroke { pen: string; settings: string; size: number; rgb: number[]; pts: [number, number][]; pr: number[] }

function pkg(id: string) {
  const dir = path.join(FIX, "notes", id);
  const files: { name: string; data: Uint8Array }[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else files.push({ name: path.relative(dir, p).split(path.sep).join("/"), data: fs.readFileSync(p) });
    }
  };
  walk(dir);
  return zipStored(files);
}

async function strokesOf(bytes: Uint8Array): Promise<{ strokes: Stroke[]; pageW: number }> {
  const m = await import("@twango/sdocx");
  await m.default({ module_or_path: fs.readFileSync(require.resolve("@twango/sdocx/sdocx_bg.wasm")) });
  const s = new m.DocumentSession(bytes);
  try {
    const ins = s.inspection() as Inspection;
    const strokes: Stroke[] = [];
    for (const o of ins.document.pages[0].objects) {
      const c = o.content?.Stroke;
      if (!c) continue;
      const R = c.rendering, argb = Number(R.style.color_argb) >>> 0;
      strokes.push({ pen: String(R.pen_name).split(".").pop()!, settings: String(R.advanced_settings ?? ""), size: Number(R.style.pen_size),
        rgb: [(argb >>> 16) & 255, (argb >>> 8) & 255, argb & 255], pts: c.points.map((p) => [p.x, p.y]), pr: c.pressures });
    }
    return { strokes, pageW: ins.layout.pages[0].page?.width ?? ins.layout.pages[0].width };
  } finally { s.free(); }
}

function background(img: Rgba): number[] {
  const out = [0, 0, 0];
  for (const [x, y] of [[2, 2], [img.w - 3, 2], [2, img.h - 3], [img.w - 3, img.h - 3]])
    for (let k = 0; k < 3; k++) out[k] += img.px[(y * img.w + x) * 4 + k] / 4;
  return out;
}

/** Ink coverage at a sub-pixel position: 0 = background, 1 = full ink colour. */
function coverage(img: Rgba, bg: number[], ink: number[], x: number, y: number): number {
  x = Math.min(Math.max(x, 0), img.w - 1.001); y = Math.min(Math.max(y, 0), img.h - 1.001);
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  let num = 0, den = 0;
  for (let k = 0; k < 3; k++) {
    const p = (dx: number, dy: number) => img.px[((y0 + dy) * img.w + x0 + dx) * 4 + k];
    const v = p(0, 0) * (1 - fx) * (1 - fy) + p(1, 0) * fx * (1 - fy) + p(0, 1) * (1 - fx) * fy + p(1, 1) * fx * fy;
    const d = ink[k] - bg[k];
    num += (v - bg[k]) * d; den += d * d;
  }
  return num / den;
}

interface Reg { scale: number; ox: number; oy: number }

/** Scale/offset that puts the most stroke points on ink (exports can be off by a pixel or two). */
function register(img: Rgba, strokes: Stroke[], scale0: number): Reg {
  const bg = background(img);
  const P: { x: number; y: number; ink: number[] }[] = [];
  for (const s of strokes) for (let i = 0; i < s.pts.length; i += 3) P.push({ x: s.pts[i][0], y: s.pts[i][1], ink: s.rgb });
  const score = (r: Reg) => { let n = 0; for (const p of P) if (coverage(img, bg, p.ink, p.x * r.scale + r.ox, p.y * r.scale + r.oy) > 0.3) n++; return n; };
  let best = { r: { scale: scale0, ox: 0, oy: 0 }, v: -1 };
  best.v = score(best.r);
  for (const [sr, or] of [[0.03, 24], [0.006, 4], [0.0012, 1]]) {
    const c = best.r;
    for (let a = -6; a <= 6; a++) for (let b = -6; b <= 6; b++) for (let d = -6; d <= 6; d++) {
      const r = { scale: c.scale * (1 + (sr * a) / 6), ox: c.ox + (or * b) / 6, oy: c.oy + (or * d) / 6 };
      const v = score(r);
      if (v > best.v) best = { r, v };
    }
  }
  return best.r;
}

/** Width (page units) and peak coverage across the stroke at one point, or null. */
function profile(img: Rgba, bg: number[], ink: number[], x: number, y: number, nx: number, ny: number, half: number, scale: number) {
  const n = Math.floor(half / 0.25), cov: number[] = [];
  for (let i = -n; i <= n; i++) cov.push(coverage(img, bg, ink, x + nx * i * 0.25, y + ny * i * 0.25));
  const c0 = n;
  let ip = -1, pk = 0;
  for (let i = Math.max(0, c0 - 8); i <= Math.min(cov.length - 1, c0 + 8); i++) if (cov[i] > pk) { pk = cov[i]; ip = i; }
  if (pk < 0.12) return null;
  const thr = 0.15 * pk;
  let lo = ip, hi = ip;
  while (lo > 0 && cov[lo - 1] > thr) lo--;
  while (hi < cov.length - 1 && cov[hi + 1] > thr) hi++;
  if (lo === 0 || hi === cov.length - 1) return null;          // ran into other ink
  let area = 0;
  for (let i = lo; i <= hi; i++) area += Math.max(0, cov[i]) * 0.25;
  return { w: area / pk / scale, peak: pk };
}

function measure(img: Rgba, strokes: Stroke[], r: Reg) {
  const bg = background(img);
  const out = new Map<string, { w: number; peak: number; p: number }>();
  strokes.forEach((s, si) => {
    const n = s.pts.length;
    for (let i = 3; i < n - 3; i += 2) {
      const a = s.pts[Math.max(0, i - 3)], b = s.pts[Math.min(n - 1, i + 3)];
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      if (L < 1e-3) continue;
      const m = profile(img, bg, s.rgb, s.pts[i][0] * r.scale + r.ox, s.pts[i][1] * r.scale + r.oy, -dy / L, dx / L,
        Math.max(3 * s.size * r.scale, 8), r.scale);
      if (m) out.set(`${si}:${i}`, { ...m, p: s.pr[i] });
    }
  });
  return out;
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };

/** Allowed range for median F (Samsung / ours) per pen; opacity must agree within OPACITY_TOL. */
const EXPECT: Record<string, { F: [number, number]; known?: string }> = {
  "FountainPen 18;0;100;": { F: [0.93, 1.15] },
  "InkPen2 9;": { F: [0.9, 1.1] },
  "Marker3 5;": { F: [0.9, 1.1] },
  "Marker4 8;": { F: [0.9, 1.1] },
  "ObliquePen 4;": { F: [0.75, 1.3], known: "nib shape: Samsung's width depends on stroke direction" },
  "Pencil2 14;": { F: [0.85, 1.15], known: "no grain texture" },
  "BrushPen 10;": { F: [0.8, 1.25], known: "Samsung's brush follows pressure, sdocx's doesn't: light strokes too thick, firm ones too thin" },
};
const OPACITY_TOL = 0.1;
const MIN_POINTS = 40;

const report: string[] = [];

describe("pen widths and opacity match Samsung's full-view exports", () => {
  for (const id of [ID.pens, ID.pens2]) {
    it(id.slice(-8), async () => {
      const bytes = pkg(id);
      const { strokes, pageW } = await strokesOf(bytes);
      const doc = await sharedRenderer.render(bytes);
      const page = doc.pages[0];
      const styled = styleSvg(page.svg, page.strokes, { inkScale: 2.6, padding: 48, radius: 0, stripText: true })!;
      const theirs = decodePng(fs.readFileSync(path.join(FIX, "exports", `${id}.png`)));
      const K = theirs.w / pageW;
      const vb = /viewBox="([^"]+)"/.exec(styled.svg)![1].split(" ").map(Number);
      const r = new Resvg(styled.svg, { fitTo: { mode: "width", value: Math.round(vb[2] * K) }, background: "#fcfcfc" }).render();
      const ours: Rgba = { w: r.width, h: r.height, px: r.pixels };
      const rk = r.width / vb[2];
      const A = measure(theirs, strokes, register(theirs, strokes, K));
      const B = measure(ours, strokes, { scale: rk, ox: -vb[0] * rk, oy: -vb[1] * rk });

      const groups = new Map<string, string[]>();
      strokes.forEach((s, si) => {
        const g = `${s.pen} ${s.settings} ${s.size.toFixed(2)}`;
        for (const k of A.keys()) if (k.startsWith(`${si}:`) && B.has(k)) groups.set(g, [...(groups.get(g) ?? []), k]);
      });
      const failures: string[] = [];
      for (const [g, keys] of groups) {
        const per = new Map<string, number[]>();
        for (const k of keys) { const si = k.split(":")[0]; per.set(si, [...(per.get(si) ?? []), A.get(k)!.w / B.get(k)!.w]); }
        const strokeF = [...per.values()].filter((v) => v.length >= 10).map(median);
        const F = median(strokeF), pointF = median(keys.map((k) => A.get(k)!.w / B.get(k)!.w));
        const opS = median(keys.map((k) => A.get(k)!.peak)), opO = median(keys.map((k) => B.get(k)!.peak));
        const [pen, settings] = g.split(" ");
        const exp = EXPECT[`${pen} ${settings}`];
        const wS = median(keys.map((k) => A.get(k)!.w)), wO = median(keys.map((k) => B.get(k)!.w));
        report.push(`${id.slice(-8)}  ${g.padEnd(28)} points ${String(keys.length).padStart(5)}  width samsung ${wS.toFixed(2)} ours ${wO.toFixed(2)}  F ${F.toFixed(2)} (pointwise ${pointF.toFixed(2)})  ` +
          `opacity samsung ${opS.toFixed(2)} ours ${opO.toFixed(2)}${exp?.known ? `  (known limit: ${exp.known})` : ""}`);
        report.push(`          per stroke (points: F): ${[...per.values()].map((v) => `${v.length}: ${median(v).toFixed(2)}`).join(", ")}`);
        if (keys.length < MIN_POINTS) continue;
        if (!exp) { failures.push(`${g}: no expectation`); continue; }
        if (!(F >= exp.F[0] && F <= exp.F[1])) failures.push(`${g}: F ${F.toFixed(2)} outside ${exp.F}`);
        if (Math.abs(opS - opO) > OPACITY_TOL) failures.push(`${g}: opacity ${opS.toFixed(2)} vs ${opO.toFixed(2)}`);
      }
      expect(failures).toEqual([]);
      expect(groups.size).toBeGreaterThan(2);
    }, 120_000);
  }

  it("report", () => {
    fs.mkdirSync(path.join(FIX, "..", "out"), { recursive: true });
    fs.writeFileSync(path.join(FIX, "..", "out", "pen-widths.txt"), report.join("\n") + "\n");
  });
});
