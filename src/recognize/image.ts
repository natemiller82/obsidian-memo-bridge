// Input images for recognition: dark ink on white, cropped to the ink, sized for vision models.
// Built from the note's raw strokes (the .sdocx backup), not from the styled vault SVG, so the
// card colour and screen-off palette never reach the model. Pure functions; rasterising is
// injected (canvas in Obsidian, resvg/jpeg-js in the eval harness).
import { deflateSync } from "node:zlib";
import type { StrokeInfo } from "../render/core";
import { styleSvg } from "../render/style";

/** Longest edge of the image sent to a provider (no provider downscales below this). */
export const MAX_EDGE = 1600;
/** Never upscale a small crop more than this. */
const MAX_UPSCALE = 2;
/** Ink brighter than this (relative luminance) is darkened; translucent ink (highlighter) is kept. */
const INK_LUM = 0.22;

/** Dark version of an ink colour, keeping its hue (so "blue diagram" survives); highlighter ink stays as is. */
export function recognitionInk(hex: string, alpha: number): string {
  if (alpha < 0.6) return hex;
  const n = parseInt(hex.slice(1, 7), 16), rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  if (lum <= INK_LUM) return hex;
  const k = INK_LUM / lum;                       // scale all channels: same hue, darker
  return "#" + rgb.map((v) => Math.round(v * k).toString(16).padStart(2, "0")).join("");
}

export interface RecognitionSvg { svg: string; width: number; height: number }

/** Empty vertical gaps taller than this fraction of the page width are shrunk to it (normal line and paragraph spacing is far less). */
const GAP_OF_WIDTH = 0.5;

/**
 * Recognition SVG for one page, or null for a page without ink. Unlike the vault render it drops
 * large filled shapes that belong to no stroke (old screen-off memos' frame: black on a white page,
 * and it also stopped the crop) and shrinks very tall empty gaps, so a sparse note on a long canvas
 * isn't squeezed into a sliver. Measured on the eval set: both help, and other pages are unchanged.
 */
export function recognitionSvg(raw: string, strokes: StrokeInfo[], inkScale: number, maxEdge = MAX_EDGE): RecognitionSvg | null {
  const vb0 = /viewBox="([^"]+)"/.exec(raw)?.[1].split(/[\s,]+/).map(Number);
  const pageW = vb0 && vb0.length === 4 && vb0[2] > 0 ? vb0[2] : 1080;
  const st = styleSvg(raw, strokes, {
    inkScale, padding: 24, radius: 0, stripText: true, recolor: recognitionInk, background: "#ffffff",
    recognition: { collapseGap: GAP_OF_WIDTH * pageW },
  });
  if (!st) return null;
  const vb = /viewBox="([^"]+)"/.exec(st.svg)![1].split(" ").map(Number);
  const scale = Math.min(maxEdge / Math.max(vb[2], vb[3]), MAX_UPSCALE);
  const width = Math.max(1, Math.round(vb[2] * scale)), height = Math.max(1, Math.round(vb[3] * scale));
  const svg = st.svg.replace(/(<svg\b[^>]*?)\swidth="[^"]*"/, `$1 width="${width}"`).replace(/(<svg\b[^>]*?)\sheight="[^"]*"/, `$1 height="${height}"`);
  return { svg, width, height };
}

export interface Rgba { w: number; h: number; px: Uint8Array | Uint8ClampedArray }

/**
 * Samsung's thumbnail (old notes sdocx can't read) prepared for recognition: greyscale,
 * inverted when the page is dark (screen-off memos), contrast-stretched to dark-on-white,
 * cropped to the ink and enlarged.
 */
export function prepareThumbnail(img: Rgba): Rgba {
  const n = img.w * img.h, lum = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    lum[i] = (0.2126 * img.px[o] + 0.7152 * img.px[o + 1] + 0.0722 * img.px[o + 2]) / 255;
    sum += lum[i];
  }
  if (sum / n < 0.5) for (let i = 0; i < n; i++) lum[i] = 1 - lum[i];
  // A screen-off memo's thumbnail is a dark card inside a light margin; after inverting, that
  // margin is a dark frame round the page. Make it paper so it neither shows nor skews the stretch.
  // Only a dark region that touches all four edges and covers 5% of the image counts as the frame
  // (ink running off one edge stays ink).
  const page = new Uint8Array(n).fill(1);
  const seen = new Uint8Array(n);
  const edges = [...Array.from({ length: img.w }, (_, x) => [x, (img.h - 1) * img.w + x]), ...Array.from({ length: img.h }, (_, y) => [y * img.w, y * img.w + img.w - 1])].flat();
  for (const start of edges) {
    if (seen[start] || lum[start] >= 0.5) continue;
    const comp: number[] = [], stack = [start];
    seen[start] = 1;
    let sides = 0;
    while (stack.length) {
      const i = stack.pop()!, x = i % img.w, y = (i - x) / img.w;
      comp.push(i);
      if (y === 0) sides |= 1; if (y === img.h - 1) sides |= 2; if (x === 0) sides |= 4; if (x === img.w - 1) sides |= 8;
      for (const j of [x > 0 ? i - 1 : -1, x < img.w - 1 ? i + 1 : -1, i >= img.w ? i - img.w : -1, i < n - img.w ? i + img.w : -1])
        if (j >= 0 && !seen[j] && lum[j] < 0.5) { seen[j] = 1; stack.push(j); }
    }
    if (sides === 15 && comp.length >= 0.05 * n) for (const i of comp) { page[i] = 0; lum[i] = 1; }
  }
  // Paper is most of the page (median); ink can be well under 1% of it (darkest 0.05%).
  const inPage = lum.filter((_, i) => page[i] === 1);
  const sorted = Float32Array.from(inPage.length ? inPage : lum).sort();
  const m = sorted.length;
  const hi = sorted[Math.floor(m * 0.5)], lo = Math.min(sorted[Math.floor(m * 0.0005)], hi - 0.15);
  const span = hi - lo;
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) g[i] = Math.min(1, Math.max(0, (lum[i] - lo) / span));

  // Crop to the ink and enlarge small writing (bilinear, at most 3x, longest edge at most MAX_EDGE).
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (g[y * img.w + x] < 0.5) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return grey(g, img.w, img.h);
  const pad = Math.max(12, Math.round(0.02 * Math.max(img.w, img.h)));
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(img.w - 1, x1 + pad); y1 = Math.min(img.h - 1, y1 + pad);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const f = Math.max(1, Math.min(3, MAX_EDGE / Math.max(cw, ch)));
  const ow = Math.round(cw * f), oh = Math.round(ch * f), out = new Float32Array(ow * oh);
  for (let y = 0; y < oh; y++) {
    const sy = Math.min(ch - 1, Math.max(0, (y + 0.5) / f - 0.5)), iy = Math.floor(sy), fy = sy - iy, iy2 = Math.min(ch - 1, iy + 1);
    for (let x = 0; x < ow; x++) {
      const sx = Math.min(cw - 1, Math.max(0, (x + 0.5) / f - 0.5)), ix = Math.floor(sx), fx = sx - ix, ix2 = Math.min(cw - 1, ix + 1);
      const at = (yy: number, xx: number) => g[(y0 + yy) * img.w + x0 + xx];
      out[y * ow + x] = (at(iy, ix) * (1 - fx) + at(iy, ix2) * fx) * (1 - fy) + (at(iy2, ix) * (1 - fx) + at(iy2, ix2) * fx) * fy;
    }
  }
  return grey(out, ow, oh);
}

function grey(g: Float32Array, w: number, h: number): Rgba {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = Math.round(g[i] * 255);
    px[i * 4 + 3] = 255;
  }
  return { w, h, px };
}

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(parts: Uint8Array[]): number {
  let c = ~0;
  for (const b of parts) for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

/** Minimal PNG encoder (8-bit RGB, filter 0); alpha is composited onto white. */
export function encodePng(img: Rgba): Uint8Array {
  const { w, h, px } = img;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, o = y * (w * 3 + 1) + 1 + x * 3, a = px[i + 3] / 255;
      for (let k = 0; k < 3; k++) raw[o + k] = Math.round(px[i + k] * a + 255 * (1 - a));
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const t = Buffer.from(type, "latin1"), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32([t, data]));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", new Uint8Array(0))]);
  return new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
}

/** Pixel size of a PNG (from its header). */
export function pngSize(png: Uint8Array): { w: number; h: number } {
  const b = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
