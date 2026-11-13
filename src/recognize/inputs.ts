// Recognition input pages for one imported note revision.
import * as fs from "node:fs";
import { pathList } from "../enrich";
import type { Renderer } from "../render/renderer";
import type { Revision } from "../state";
import { encodePng, prepareThumbnail, recognitionSvg, type Rgba } from "./image";

const RENDER_TIMEOUT_MS = 60_000;

/** Rasterising, injected: canvas in Obsidian, resvg + jpeg-js in the eval harness. */
export interface Raster {
  svgToRgba(svg: string, w: number, h: number): Promise<Rgba>;
  jpegToRgba(bytes: Uint8Array): Promise<Rgba>;
}

export interface InputPage {
  page: number;                         // 1-based page number in the note
  png: Uint8Array;
  w: number;
  h: number;
  source: "strokes" | "thumbnail";
}

/**
 * Pages to recognise: one per inked page, drawn from the .sdocx backup; for notes sdocx can't
 * read, Samsung's thumbnail of the first page. Notes without ink (typed text only) have none.
 */
export async function recognitionPages(rev: Pick<Revision, "render" | "sdocx_path" | "png_path">, renderer: Renderer,
                                       raster: Raster, inkScale: number): Promise<InputPage[]> {
  // "sdocx-cli": notes imported by the Python bridge; same .sdocx backup, so the same input
  if (rev.render === "sdocx" || rev.render === "sdocx-cli") {
    const doc = await renderer.render(new Uint8Array(fs.readFileSync(rev.sdocx_path)), RENDER_TIMEOUT_MS);
    const out: InputPage[] = [];
    for (const [i, p] of doc.pages.entries()) {
      const r = recognitionSvg(p.svg, p.strokes, inkScale);
      if (!r) continue;
      const rgba = await raster.svgToRgba(r.svg, r.width, r.height);
      out.push({ page: i + 1, png: encodePng(rgba), w: rgba.w, h: rgba.h, source: "strokes" });
    }
    return out;
  }
  if (rev.render === "thumbnail") {
    const jpg = pathList(rev.png_path).find((p) => /\.jpe?g$/i.test(p) && fs.existsSync(p));
    if (!jpg) return [];
    const rgba = prepareThumbnail(await raster.jpegToRgba(new Uint8Array(fs.readFileSync(jpg))));
    return [{ page: 1, png: encodePng(rgba), w: rgba.w, h: rgba.h, source: "thumbnail" }];
  }
  return [];
}
