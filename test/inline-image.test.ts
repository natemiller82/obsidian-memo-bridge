// Images embedded in the body text: sdocx draws them offset by its text-flow translates; the
// stored rectangle puts them back so ink drawn on a picture lines up as it does in Samsung Notes.
// Synthetic fixture: the same SVG structure sdocx produces, with a picture that has known lines.
import { describe, expect, it } from "vitest";
import { inlineImageRect, type Rect } from "../src/render/core";
import { styleSvg } from "../src/render/style";
import { encodePng } from "../src/recognize/image";
import { nodeRaster } from "./raster-node";

/** A 200 x 112 picture (the 1249 x 700 test picture's aspect): white, one black vertical line at x 100..101 and one horizontal at y 56..57. */
function picture(): string {
  const w = 200, h = 112, px = new Uint8Array(w * h * 4).fill(255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x === 100 || x === 101 || y === 56 || y === 57) px.set([0, 0, 0, 255], (y * w + x) * 4);
  return Buffer.from(encodePng({ w, h, px })).toString("base64");
}

/** The SVG sdocx writes for one inline image (rect at its own x/y/size) plus red ink along where the picture's lines are. */
function page(rect: Rect): { svg: string; strokes: { pen: string; settings: string; color: string; alpha: number; width: number; bbox: [number, number, number, number] }[] } {
  const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
  const lx = rect.x0 + (101 / 200) * w, ly = rect.y0 + (57 / 112) * h;      // centre of the picture's lines on the page
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1527" viewBox="0.0 0.0 1080.0 1527.0">` +
    `<rect fill="#fcfcfc" height="1527" width="1080" x="0" y="0"/><defs><clipPath id="c"><rect height="1527" width="1080" x="0" y="0"/></clipPath></defs>` +
    `<g clip-path="url(#c)" data-sdocx-flow="true"><g transform="translate(0 0.00000)"><g transform="translate(-32 0.00000)">` +
    `<g data-sdocx-object="image" transform="translate(0 -20.0000)"><image height="${h}" href="data:image/png;base64,${picture()}" preserveAspectRatio="none" width="${w}" x="${rect.x0}" y="${rect.y0}"/></g>` +
    `</g></g></g>` +
    `<line stroke="#ff3636" stroke-linecap="round" stroke-width="3" x1="${lx}" y1="${rect.y0 + 5}" x2="${lx}" y2="${rect.y1 - 5}"/>` +
    `<line stroke="#ff3636" stroke-linecap="round" stroke-width="3" x1="${rect.x0 + 5}" y1="${ly}" x2="${rect.x1 - 5}" y2="${ly}"/></svg>`;
  const strokes = [
    { pen: "InkPen", settings: "1;", color: "#ff3636", alpha: 1, width: 3, bbox: [lx, rect.y0 + 5, lx, rect.y1 - 5] as [number, number, number, number] },
    { pen: "InkPen", settings: "1;", color: "#ff3636", alpha: 1, width: 3, bbox: [rect.x0 + 5, ly, rect.x1 - 5, ly] as [number, number, number, number] },
  ];
  return { svg, strokes };
}

/** Rendered: the x of the picture's black vertical line and of the red vertical stroke, and the same for y (page units). */
async function measure(svg: string) {
  const vb = /viewBox="([^"]+)"/.exec(svg)![1].split(" ").map(Number);
  const k = 2, W = Math.round(vb[2] * k), H = Math.round(vb[3] * k);
  const img = await nodeRaster.svgToRgba(svg, W, H);
  const colB = new Array(img.w).fill(0), colR = new Array(img.w).fill(0), rowB = new Array(img.h).fill(0), rowR = new Array(img.h).fill(0);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const i = (y * img.w + x) * 4, r = img.px[i], g = img.px[i + 1], b = img.px[i + 2];
    if (r < 80 && g < 80 && b < 80) { colB[x]++; rowB[y]++; }
    if (r > 200 && g < 120 && b < 120) { colR[x]++; rowR[y]++; }
  }
  // centre of the line: weighted mean of the columns (rows) above half the strongest one
  const peak = (a: number[]) => { const m = Math.max(...a); let sw = 0, sv = 0; a.forEach((v, i) => { if (v >= m / 2) { sw += v * i; sv += v; } }); return sw / sv; };
  const u = (p: number, o: number) => o + (p + 0.5) / (img.w / vb[2]);
  return { blackX: u(peak(colB), vb[0]), redX: u(peak(colR), vb[0]), blackY: u(peak(rowB), vb[1]), redY: u(peak(rowR), vb[1]) };
}

const opts = { inkScale: 2.6, padding: 48, radius: 24, stripText: true };

describe("images embedded in the body text", () => {
  for (const [label, rect] of [
    ["at its original size", { x0: 48, y0: 30.001, x1: 678, y1: 383.0825 }],
    ["resized by dragging", { x0: 48, y0: 30.001, x1: 1023.755, y1: 576.8611 }],
  ] as const) {
    it(`ink drawn on a picture ${label} lands on the picture's lines`, async () => {
      const { svg, strokes } = page(rect);
      const fixed = await measure(styleSvg(svg, strokes, { ...opts, inlineImages: [rect] })!.svg);
      expect(Math.abs(fixed.blackX - fixed.redX)).toBeLessThan(1.5);
      expect(Math.abs(fixed.blackY - fixed.redY)).toBeLessThan(1.5);
      // without the stored rectangle the picture keeps sdocx's flow offset of (-32, -20)
      const asDrawn = await measure(styleSvg(svg, strokes, opts)!.svg);
      expect(fixed.blackX - asDrawn.blackX).toBeCloseTo(32, 0);
      expect(fixed.blackY - asDrawn.blackY).toBeCloseTo(20, 0);
    });
  }

  it("an image whose rectangle doesn't match a stored one is left as sdocx drew it", () => {
    const rect = { x0: 48, y0: 30, x1: 678, y1: 383 };
    const { svg, strokes } = page(rect);
    const out = styleSvg(svg, strokes, { ...opts, inlineImages: [{ x0: 10, y0: 10, x1: 100, y1: 100 }] })!.svg;
    expect(out).toContain('transform="translate(0 -20.0000)"');
  });

  it("reads the stored rectangle from the embedded object's bytes; rejects rotated, cropped or inconsistent ones", () => {
    const bytes = new Uint8Array(476), view = new DataView(bytes.buffer);
    const put = (o: number, v: number[]) => v.forEach((x, i) => view.setFloat64(o + 8 * i, x, true));
    put(68, [48, 30.001, 1023.755, 576.8611]); put(277, [48, 30.001, 1023.755, 576.8611]);
    const span = { object_type: "Image", object_data: Array.from(bytes), content: { Image: {} } };
    expect(inlineImageRect(span)).toEqual({ x0: 48, y0: 30.001, x1: 1023.755, y1: 576.8611 });
    expect(inlineImageRect({ ...span, content: { Image: { rotation_degrees: 90 } } })).toBeNull();
    expect(inlineImageRect({ ...span, content: { Image: { crop_rect: { x: 0 } } } })).toBeNull();
    expect(inlineImageRect({ ...span, object_type: "Voice" })).toBeNull();
    put(277, [48, 30.001, 1000, 576.8611]);
    expect(inlineImageRect({ ...span, object_data: Array.from(bytes) })).toBeNull();   // the two copies disagree
  });
});
