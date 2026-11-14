// Recognition input images: dark ink on white, cropped, sized; thumbnails cleaned up.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { encodePng, MAX_EDGE, prepareThumbnail, recognitionInk, recognitionSvg } from "../src/recognize/image";
import { styleSvg } from "../src/render/style";
import { recognitionPages } from "../src/recognize/inputs";
import { zipStored } from "../src/zip";
import { nodeRaster } from "./raster-node";
import { FIX, ID, sharedRenderer } from "./helpers";
import { decodePng } from "./png";

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

const lum = (px: ArrayLike<number>, i: number) => (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;

describe("recognition image", () => {
  it("ink colours: light ink darkened with its hue kept; dark ink and highlighter unchanged", () => {
    expect(recognitionInk("#fbe156", 1)).not.toBe("#fbe156");                 // screen-off yellow
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(recognitionInk("#fbe156", 1).slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(b);                                             // still yellowish (olive)
    expect(lum([r, g, b], 0)).toBeLessThan(0.35);
    expect(recognitionInk("#252525", 1)).toBe("#252525");
    expect(recognitionInk("#ffcb30", 0.45)).toBe("#ffcb30");                  // highlighter
  });

  it("from strokes: white page, dark ink, highlighter still light, long edge <= MAX_EDGE", async () => {
    const page = (await sharedRenderer.render(pkg(ID.pens2))).pages[0];
    const r = recognitionSvg(page.svg, page.strokes, 2.6)!;
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(MAX_EDGE);
    expect(r.svg).toContain('fill="#ffffff"');
    const img = decodePng(encodePng(await nodeRaster.svgToRgba(r.svg, r.width, r.height)));
    expect([img.w, img.h]).toEqual([r.width, r.height]);
    expect(lum(img.px, 0)).toBeGreaterThan(0.98);                             // corner is white
    let dark = 0, yellowish = 0;
    for (let i = 0; i < img.px.length; i += 4) {
      const L = lum(img.px, i);
      if (L < 0.35) dark++;
      if (img.px[i] > 230 && img.px[i + 1] > 200 && img.px[i + 2] < 190) yellowish++;     // light highlighter
    }
    expect(dark).toBeGreaterThan(2000);
    expect(yellowish).toBeGreaterThan(2000);
  });

  it("blank pages give no input; a thumbnail-only note gives one cleaned-up page", async () => {
    // pens2 has a blank page 2
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mb-rec-"));
    const sdocx = path.join(tmp, "n.sdocx");
    fs.writeFileSync(sdocx, pkg(ID.pens2));
    const pages = await recognitionPages({ render: "sdocx", sdocx_path: sdocx, png_path: null }, sharedRenderer, nodeRaster, 2.6);
    expect(pages.map((p) => p.page)).toEqual([1]);
    expect(pages[0].source).toBe("strokes");
    // notes imported by the Python bridge are recorded as "sdocx-cli": same backup, same images
    const cli = await recognitionPages({ render: "sdocx-cli", sdocx_path: sdocx, png_path: null }, sharedRenderer, nodeRaster, 2.6);
    expect(cli.map((p) => [p.page, p.source])).toEqual([[1, "strokes"]]);
    expect(Buffer.from(cli[0].png).equals(Buffer.from(pages[0].png))).toBe(true);

    const jpg = path.join(tmp, "t.jpg");
    fs.copyFileSync(path.join(FIX, "thumbnails", `${ID.pencil}.jpg`), jpg);
    const t = await recognitionPages({ render: "thumbnail", sdocx_path: sdocx, png_path: JSON.stringify([jpg]) }, sharedRenderer, nodeRaster, 2.6);
    expect(t).toHaveLength(1);
    expect(t[0].source).toBe("thumbnail");
    const img = decodePng(t[0].png);
    expect(lum(img.px, 0)).toBeGreaterThan(0.9);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("thumbnail clean-up inverts dark pages and stretches contrast", () => {
    const w = 10, h = 10, px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { const ink = i % 10 === 0; px.set(ink ? [200, 180, 60, 255] : [10, 10, 10, 255], i * 4); }
    const out = prepareThumbnail({ w, h, px });
    expect(out.w).toBe(30);                                                   // enlarged 3x (whole image is the crop)
    expect(out.px[16 * 4]).toBe(255);                                         // background -> white
    expect(out.px[0]).toBeLessThan(40);                                       // ink -> dark
  });
});

describe("recognition image: frames, long canvases, thumbnails", () => {
  const stroke = (pen: string, color: string, alpha: number, bbox: [number, number, number, number], width = 4) => ({ pen, settings: "1;", color, alpha, width, bbox });
  const line = (x1: number, y1: number, x2: number, y2: number, color = "#ffffff", w = 4) =>
    `<line stroke="${color}" stroke-linecap="round" stroke-width="${w}" x1="${x1}" x2="${x2}" y1="${y1}" y2="${y2}"/>`;

  it("drops a large filled frame that belongs to no stroke (old screen-off memos) and crops to the ink; the vault render keeps it, cropped", () => {
    const raw = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="2036" viewBox="0 0 720 2036"><rect fill="#fcfcfc" height="2036" width="720" x="0" y="0"/>` +
      `<g fill="#000000" stroke="#000000" stroke-opacity="0" stroke-width="2"><path d="M24 20 L680 20 L680 854 L24 854 z"/>${line(100, 100, 500, 100)}${line(100, 300, 500, 300)}</g></svg>`;
    const strokes = [stroke("InkPen", "#ffffff", 1, [100, 100, 500, 100]), stroke("InkPen", "#ffffff", 1, [100, 300, 500, 300])];
    const vault = styleSvg(raw, strokes, { inkScale: 2.6, padding: 48, radius: 24, stripText: false })!.svg;
    expect(vault).toContain("<path");
    expect(/viewBox="([^"]+)"/.exec(vault)![1].split(" ").map(Number)[3]).toBeLessThan(1000);   // a closing "z" no longer stops the crop
    const r = recognitionSvg(raw, strokes, 2.6)!;
    expect(r.svg).not.toContain("<path");
    const vb = /viewBox="([^"]+)"/.exec(r.svg)![1].split(" ").map(Number);
    expect(vb[3]).toBeLessThan(300);                                                     // cropped to the two lines, not the page
  });

  it("shrinks a very tall empty gap (sparse note on a long canvas) but keeps normal spacing", () => {
    const parts: string[] = [], strokes = [];
    for (let i = 0; i < 4; i++) { parts.push(line(50, 100 + i * 300, 950, 100 + i * 300, "#252525")); strokes.push(stroke("InkPen", "#252525", 1, [50, 100 + i * 300, 950, 100 + i * 300])); }
    parts.push(line(50, 60000, 950, 60000, "#252525")); strokes.push(stroke("InkPen", "#252525", 1, [50, 60000, 950, 60000]));
    const raw = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="80000" viewBox="0 0 1000 80000">${parts.join("")}</svg>`;
    const r = recognitionSvg(raw, strokes, 2.6)!;
    const vb = /viewBox="([^"]+)"/.exec(r.svg)![1].split(" ").map(Number);
    expect(vb[3]).toBeLessThan(900 + 500 + 200);                                         // 900 of lines + the gap shrunk to 500, + padding
    expect(vb[3]).toBeGreaterThan(900 + 500);
    expect(r.width).toBeGreaterThan(800);                                                // not a sliver
    expect(r.svg).toContain("50,400 950,400");                                          // the 300-unit line spacing is untouched
  });

  it("thumbnail: the light margin around a dark card isn't a black frame; small writing is cropped and enlarged", () => {
    const w = 200, h = 280, px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const card = x >= 10 && x < 190 && y >= 5 && y < 240;
      const ink = card && y >= 50 && y < 53 && x >= 40 && x < 100;
      px.set(ink ? [150, 150, 150, 255] : card ? [5, 5, 5, 255] : [250, 250, 250, 255], (y * w + x) * 4);
    }
    const out = prepareThumbnail({ w, h, px });
    let black = 0;
    for (let i = 0; i < out.w * out.h; i++) if (out.px[i * 4] < 60) black++;
    expect(black / (out.w * out.h)).toBeLessThan(0.2);                                   // no frame
    expect(black).toBeGreaterThan(0);                                                     // the ink survives, dark
    expect(out.w).toBeGreaterThan(60);                                                    // cropped, then enlarged
    expect(out.w).toBeLessThan(w * 3 + 1);
  });
});
