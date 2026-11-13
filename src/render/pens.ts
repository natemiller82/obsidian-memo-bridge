// Per-pen display corrections, as data. sdocx draws every pen it renders as plain lines
// with one generic formula (width = size * (0.12 + 0.28 * pressure), whatever the pen),
// and some pens natively (filled outlines or circle stamps). Samsung draws each pen its
// own way. These rules bring the vault render back in line with Samsung's full-view
// rendering, measured against Samsung Notes "Save as file > Image" exports
// (see test/pens.test.ts). Only the vault SVG is corrected; the .sdocx backup and the
// raw SVG keep the original strokes.
//
// Rules are chosen by pen type and by how sdocx drew the stroke, not by Samsung's
// "advanced settings" string: that string tracks the app version that wrote the stroke
// and is used only as a tiebreaker where a reference shows two versions differ.

/** How sdocx drew a stroke: generic lines, its own outline fill, or circle stamps. */
export type Drawn = "lines" | "outline" | "stamps";

export interface PenRule {
  /** Samsung pen class name (last part), e.g. "InkPen2". */
  pen: string;
  /** Only strokes sdocx drew this way. Omit to match any. */
  drawn?: Drawn;
  /** Tiebreaker: exact advanced-settings string. Omit to match any. */
  settings?: string;
  /** Multiply sdocx's stroke width ("ink_scale" = the user setting). */
  scale?: number | "ink_scale";
  /** Draw at a constant width = this * the stroke's pen size (Samsung ignores pressure). */
  constant?: number;
  /** Opacity applied on top of the stroke's own alpha (when useAlpha). */
  opacity?: number;
  /** Apply the stroke's own colour alpha (sdocx ignores it for this pen). */
  useAlpha?: boolean;
  note?: string;
}

export const PEN_TABLE_VERSION = 2;

/** First matching rule wins. Pens not listed are drawn as sdocx renders them. */
export const PEN_RULES: PenRule[] = [
  { pen: "FountainPen", drawn: "lines", settings: "13;", scale: "ink_scale",
    note: "provisional, from the phone: ~3x too thin. Other line-drawn fountain pens (11;, 12;, 15;0;100;) and the outline-drawn 14; are held until measured against full-view exports" },
  { pen: "InkPen2", drawn: "lines", constant: 1.03, note: "'Pen': Samsung draws a constant width ~1.03 x size (export F 5.6)" },
  { pen: "Marker3", drawn: "lines", constant: 0.98, useAlpha: true, note: "'Marker': constant width ~0.98 x size, stroke alpha honoured (0.45 measured)" },
  { pen: "Pencil2", drawn: "lines", constant: 0.73, opacity: 0.29, useAlpha: true, note: "'Pencil': ~0.73 x size, opacity 0.29; grain texture not reproduced" },
  { pen: "ObliquePen", drawn: "lines", scale: 3.6, note: "'Calligraphy pen': export F 3.5; nib shape (direction-dependent width) not reproduced" },
  // Correct as rendered (measured): FountainPen 18;0;100; (stamps, F 1.04-1.11 over sizes 3.4-26.7),
  // Marker4 highlighter (F 0.98, alpha 0.45). BrushPen: right on average (F 1.02) but Samsung's
  // brush follows pressure and sdocx's doesn't; left uncorrected (known limit).
];

export interface Correction {
  /** Width multiplier for sdocx's width (used when `constant` is undefined). */
  scale: number;
  /** Absolute stroke width in page units, replacing sdocx's width. */
  constant?: number;
  opacity: number;
}

export const NO_CORRECTION: Correction = { scale: 1, opacity: 1 };

export interface PenStroke { pen: string; settings: string; alpha: number; width: number; drawn: Drawn }

export function correctionFor(s: PenStroke, inkScale: number, rules: PenRule[] = PEN_RULES): Correction {
  const r = rules.find((x) => x.pen === s.pen && (x.drawn === undefined || x.drawn === s.drawn) &&
    (x.settings === undefined || x.settings === s.settings));
  if (!r) return NO_CORRECTION;
  const scale = r.scale === "ink_scale" ? inkScale : r.scale ?? 1;
  const opacity = Math.max(0, Math.min(1, (r.opacity ?? 1) * (r.useAlpha ? s.alpha : 1)));
  return r.constant !== undefined && s.width > 0 ? { scale: 1, constant: r.constant * s.width, opacity } : { scale, opacity };
}

export const isIdentity = (c: Correction) => c.constant === undefined && c.scale === 1 && c.opacity === 1;
