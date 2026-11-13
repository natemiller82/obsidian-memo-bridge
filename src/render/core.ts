// Shared by the render worker and the in-process renderer: parse an .sdocx with
// @twango/sdocx and return per-page SVG plus what the post-processor and the Markdown
// writer need (stroke pens, page text).
import type * as Sdocx from "@twango/sdocx";

export interface StrokeInfo {
  pen: string;          // e.g. "InkPen2" (last part of Samsung's pen class name)
  settings: string;     // Samsung "advanced settings" string, e.g. "13;" or "18;0;100;"
  color: string;        // "#rrggbb"
  alpha: number;        // 0..1
  width: number;        // pen width in page units
  bbox: [number, number, number, number];
}

export interface TextSpan { kind: string; start: number; end: number; payload: number[] }

export interface PageText { text: string; spans: TextSpan[] }

export interface PageRender {
  index: number;
  svg: string;
  strokes: StrokeInfo[];
  text: PageText | null;
}

export interface DocRender {
  pages: PageRender[];
  /**
   * Media files (base names, e.g. "0@image0.jpg") that pages use as their paper/template
   * background, such as the yellow Action memo paper. They are not user attachments.
   * PDF "paper" (an annotated PDF) is the note's content and is not listed here.
   */
  backgroundMedia: string[];
}

/** The package was read and rejected: a format sdocx can't handle. */
export class FormatError extends Error {}

const hex = (c: { r: number; g: number; b: number }) =>
  "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("");

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function renderDocument(mod: typeof Sdocx, bytes: Uint8Array): DocRender {
  let s: Sdocx.DocumentSession;
  try {
    s = new mod.DocumentSession(bytes);
  } catch (e) {
    throw new FormatError(String((e as Error)?.message ?? e).replace(/^Error:\s*/, ""));
  }
  try {
    const ins = s.inspection() as Any;
    const pages: PageRender[] = [];
    const layout: Any[] = ins.layout?.pages ?? [];
    for (let i = 0; i < s.page_count; i++) {
      const objects: Any[] = layout[i]?.page?.objects ?? [];
      const strokes: StrokeInfo[] = [];
      let text: PageText | null = null;
      for (const o of objects) {
        const st = o.content?.Stroke;
        if (st) {
          const argb = Number(st.rendering?.style?.color_argb ?? 0xff000000) >>> 0;
          strokes.push({
            pen: String(st.rendering?.pen_name ?? "").split(".").pop() ?? "",
            settings: String(st.rendering?.advanced_settings ?? ""),
            color: hex(st.color),
            alpha: (argb >>> 24) / 255,
            width: Number(st.pen_width ?? 0),
            bbox: [st.bbox.x_min, st.bbox.y_min, st.bbox.x_max, st.bbox.y_max],
          });
          continue;
        }
        const tb = o.content?.Element?.TextBox;
        if (tb && typeof tb.text === "string" && tb.text.trim()) {
          const spans: TextSpan[] = (tb.spans ?? []).map((x: Any) => ({
            kind: String(x.kind), start: x.start_utf16, end: x.end_utf16, payload: Array.from(x.payload ?? []) as number[],
          }));
          text = text ? { text: text.text + "\n" + tb.text, spans: text.spans } : { text: tb.text, spans };
        }
      }
      let svg: string;
      try {
        svg = s.render_svg(i, "auto");
      } catch (e) {
        throw new FormatError(`page ${i + 1}: ${String((e as Error)?.message ?? e).replace(/^Error:\s*/, "")}`);
      }
      pages.push({ index: i, svg, strokes, text });
    }
    const assets: Any[] = ins.document?.metadata?.media_assets ?? [];
    const backgroundMedia = new Set<string>();
    for (const p of (ins.document?.pages ?? []) as Any[]) {
      const id = p?.background?.image_id;
      if (typeof id !== "number") continue;
      const a = assets.find((x) => x.archive_id === id);
      if (a?.name) backgroundMedia.add(String(a.name).split("/").pop()!);
    }
    return { pages, backgroundMedia: [...backgroundMedia] };
  } finally {
    s.free();
  }
}
