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

/** A rectangle in page units. */
export interface Rect { x0: number; y0: number; x1: number; y1: number }

export interface DocRender {
  pages: PageRender[];
  /**
   * Where Samsung places each image embedded in the note's body text (page units), read from the
   * note's own data. sdocx draws these images offset by its text-flow transforms; style.ts uses
   * the stored rectangle to put them back (see local notes on the upstream issue).
   */
  inlineImages: Rect[];
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

// The parts of sdocx's inspection() result this module reads (the binding returns it untyped).
interface InsRgb { r: number; g: number; b: number }
interface InsStroke {
  rendering?: { pen_name?: string; advanced_settings?: string; style?: { color_argb?: number } };
  color: InsRgb;
  pen_width?: number;
  bbox: { x_min: number; y_min: number; x_max: number; y_max: number };
}
interface InsSpan { kind: string; start_utf16: number; end_utf16: number; payload?: number[] }
interface InsObject { content?: { Stroke?: InsStroke; Element?: { TextBox?: { text?: unknown; spans?: InsSpan[] } } } }
interface InsObjectSpan { object_type?: string; object_data?: number[]; content?: { Image?: { rotation_degrees?: unknown; crop_rect?: unknown } } }
interface Inspection {
  layout?: { pages?: { page?: { objects?: InsObject[] } }[] };
  document?: {
    metadata?: {
      media_assets?: { archive_id?: number; name?: string }[];
      note_text?: { object_spans?: InsObjectSpan[] };
      note_title?: { object_spans?: InsObjectSpan[] };
    };
    pages?: { background?: { image_id?: unknown } }[];
  };
}

export function renderDocument(mod: typeof Sdocx, bytes: Uint8Array): DocRender {
  let s: Sdocx.DocumentSession;
  try {
    s = new mod.DocumentSession(bytes);
  } catch (e) {
    throw new FormatError(String((e as Error)?.message ?? e).replace(/^Error:\s*/, ""));
  }
  try {
    const ins = s.inspection() as Inspection;
    const pages: PageRender[] = [];
    const layout = ins.layout?.pages ?? [];
    for (let i = 0; i < s.page_count; i++) {
      const objects = layout[i]?.page?.objects ?? [];
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
          const spans: TextSpan[] = (tb.spans ?? []).map((x) => ({
            kind: String(x.kind), start: x.start_utf16, end: x.end_utf16, payload: Array.from(x.payload ?? []),
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
    const assets = ins.document?.metadata?.media_assets ?? [];
    const backgroundMedia = new Set<string>();
    for (const p of ins.document?.pages ?? []) {
      const id = p?.background?.image_id;
      if (typeof id !== "number") continue;
      const a = assets.find((x) => x.archive_id === id);
      if (a?.name) backgroundMedia.add(String(a.name).split("/").pop()!);
    }
    const meta = ins.document?.metadata;
    const inlineImages = [...(meta?.note_title?.object_spans ?? []), ...(meta?.note_text?.object_spans ?? [])]
      .map(inlineImageRect).filter((r): r is Rect => r !== null);
    return { pages, backgroundMedia: [...backgroundMedia], inlineImages };
  } finally {
    s.free();
  }
}

/**
 * The page rectangle of an image embedded in the body text, from the span's raw object bytes:
 * four little-endian doubles (x0, y0, x1, y1) at byte 68, stored again at byte 277 (sdocx doesn't
 * decode them yet). Accepted only when both copies agree and the image is neither rotated nor
 * cropped (those aren't handled); otherwise null, and the image is drawn as sdocx draws it.
 */
export function inlineImageRect(span: InsObjectSpan): Rect | null {
  const img = span.content?.Image;
  if (span.object_type !== "Image" || !img || img.rotation_degrees != null || img.crop_rect != null) return null;
  const data = span.object_data;
  if (!Array.isArray(data) || data.length < 309) return null;
  const view = new DataView(Uint8Array.from(data).buffer);
  const at = (o: number) => [0, 8, 16, 24].map((k) => view.getFloat64(o + k, true));
  const [a, b] = [at(68), at(277)];
  if (!a.every((v, i) => Number.isFinite(v) && Math.abs(v - b[i]) < 1e-6)) return null;
  const [x0, y0, x1, y1] = a;
  return x1 > x0 && y1 > y0 && x0 > -1e5 && y0 > -1e5 && x1 < 1e6 && y1 < 1e7 ? { x0, y0, x1, y1 } : null;
}
