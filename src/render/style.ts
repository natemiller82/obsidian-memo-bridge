// Display post-process ("variant B"): per-pen corrections, crop to the ink, rounded
// card in the page colour, and size reduction (merge round-capped segments into
// polylines). Operates on sdocx's raw SVG; the raw SVG itself is kept elsewhere.
import { DOMParser, XMLSerializer, type Document as XDocument, type Element as XElement, type Node as XNode } from "@xmldom/xmldom";
import type { StrokeInfo } from "./core";
import { correctionFor, isIdentity, NO_CORRECTION, PEN_RULES, type Drawn, type PenRule } from "./pens";

const SVG_NS = "http://www.w3.org/2000/svg";
const S_ATTR = "data-mb-s";   // index of the stroke an element was drawn for
const O_ATTR = "data-mb-o";   // opacity to apply to the element's group

type El = XElement;
const ELEMENT_NODE = 1;
const isEl = (n: XNode | null): n is El => !!n && n.nodeType === ELEMENT_NODE;

export interface StyleOptions {
  inkScale: number;
  padding: number;
  radius: number;
  stripText: boolean;
  rules?: PenRule[];
  /** Replace ink colours (hex "#rrggbb", effective alpha 0..1), e.g. dark ink for recognition. */
  recolor?: (hex: string, alpha: number) => string;
  /** Card colour instead of the page colour. */
  background?: string;
  /**
   * Recognition images (not the vault render): drop large filled shapes that belong to no stroke
   * (page frames), read paths that end in "z" for the crop, and shrink empty vertical gaps taller
   * than `collapseGap` page units to that height.
   */
  recognition?: { collapseGap: number };
}

export interface StyledPage { svg: string; inkElements: number; corrected: number }

const INK = new Set(["line", "polyline", "polygon", "path", "circle", "ellipse", "rect", "image"]);
const NUM = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;

const elements = (n: XNode): El[] => {
  const out: El[] = [];
  for (let c = n.firstChild; c; c = c.nextSibling) if (isEl(c)) out.push(c);
  return out;
};
const name = (e: El): string => e.localName ?? String(e.tagName).replace(/^.*:/, "");
const f2 = (v: number) => v.toFixed(2);

function descendants(root: XNode): El[] {
  const out: El[] = [];
  const rec = (n: XNode) => { for (const c of elements(n)) { out.push(c); rec(c); } };
  rec(root);
  return out;
}

function inDefs(e: El): boolean {
  for (let p = e.parentNode; isEl(p); p = p.parentNode) {
    const t = name(p);
    if (t === "defs" || t === "clipPath" || t === "mask" || t === "pattern") return true;
  }
  return false;
}

/** Coordinates covered by an element; null = can't tell from the element alone. */
function points(e: El): [number, number][] | null {
  const a = (k: string) => parseFloat(e.getAttribute(k) ?? "0");
  switch (name(e)) {
    case "line": return [[a("x1"), a("y1")], [a("x2"), a("y2")]];
    case "polyline": case "polygon": {
      const n = (e.getAttribute("points") ?? "").match(NUM)?.map(Number) ?? [];
      const out: [number, number][] = [];
      for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]);
      return out;
    }
    case "circle": case "ellipse": {
      const rx = e.hasAttribute("r") ? a("r") : a("rx"), ry = e.hasAttribute("r") ? a("r") : a("ry");
      return [[a("cx") - rx, a("cy") - ry], [a("cx") + rx, a("cy") + ry]];
    }
    case "rect": case "image":
      return [[a("x"), a("y")], [a("x") + a("width"), a("y") + a("height")]];
    case "path": {
      const d = e.getAttribute("d") ?? "";
      // relative commands (a closing "z" has no coordinates, so it doesn't count)
      if (/[a-df-y]/.test(d.replace(/e[-+]?\d/gi, ""))) return null;
      const n = d.match(NUM)?.map(Number) ?? [];
      const out: [number, number][] = [];
      for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]);
      return out;
    }
  }
  return null;
}

function firstPoint(e: El): [number, number] | null {
  if (name(e) === "line") return [parseFloat(e.getAttribute("x1") ?? ""), parseFloat(e.getAttribute("y1") ?? "")];
  const src = name(e) === "path" ? e.getAttribute("d") : e.getAttribute("points") ?? e.getAttribute("cx");
  const n = (src ?? "").match(NUM)?.map(Number) ?? [];
  if (name(e) === "circle") return [parseFloat(e.getAttribute("cx") ?? ""), parseFloat(e.getAttribute("cy") ?? "")];
  return n.length >= 2 ? [n[0], n[1]] : null;
}

/**
 * Tag ink elements with the stroke they belong to. sdocx writes elements in stroke
 * order (verified on real notes), so walk both in step, matching on colour and bbox.
 * Stamp-style pens produce exactly one <path> per stroke.
 */
function assignStrokes(ink: El[], strokes: StrokeInfo[]): Map<number, Drawn> {
  const drawn = new Map<number, Drawn>();
  let k = 0;
  let pathTaken = false;
  const fits = (e: El, color: string, p: [number, number], s: StrokeInfo | undefined) => {
    if (!s || s.color !== color) return false;
    const m = s.width + 2;
    return p[0] >= s.bbox[0] - m && p[0] <= s.bbox[2] + m && p[1] >= s.bbox[1] - m && p[1] <= s.bbox[3] + m;
  };
  for (const e of ink) {
    const color = (e.getAttribute("stroke") || e.getAttribute("fill") || "").toLowerCase();
    const p = firstPoint(e);
    if (!p || !color || color === "none") continue;
    const isPath = name(e) === "path";
    let j = k;
    if (isPath && pathTaken) j = k + 1;          // next stamp path -> next stroke
    while (j < strokes.length && !fits(e, color, p, strokes[j])) j++;
    if (j >= strokes.length) continue;           // unmatched: drawn as-is
    if (j !== k) pathTaken = false;
    k = j;
    if (isPath) pathTaken = true;
    e.setAttribute(S_ATTR, String(k));
    if (!drawn.has(k))
      drawn.set(k, name(e) === "line" ? "lines" : isPath && parseStamps(e.getAttribute("d") ?? "") ? "stamps" : "outline");
  }
  return drawn;
}

// One circle "stamp" as sdocx draws stamp-style pens:
//   M x,y a r,r,0,1,0,2r,0 a r,r,0,1,0,-2r,0 z      (x,y = leftmost point)
const N = String.raw`(-?\d+(?:\.\d+)?)`, SEP = String.raw`[\s,]+`;
const STAMP = new RegExp(String.raw`\s*M\s*${N}${SEP}${N}\s*a\s*${N}${SEP}${N}${SEP}0${SEP}1${SEP}0${SEP}${N}${SEP}0` +
  String.raw`\s*a\s*${N}${SEP}${N}${SEP}0${SEP}1${SEP}0${SEP}-${N}${SEP}0\s*z`, "gi");

function parseStamps(d: string): [number, number, number][] | null {
  const out: [number, number, number][] = [];
  let pos = 0;
  STAMP.lastIndex = 0;
  for (let m = STAMP.exec(d); m; m = STAMP.exec(d)) {
    if (m.index !== pos) return null;
    const [x, y, rx, ry, dx, , , dx2] = m.slice(1).map(Number);
    if (!(Math.abs(rx - ry) < 1e-3 && Math.abs(dx - 2 * rx) < 1e-3 && Math.abs(dx2 - 2 * rx) < 1e-3)) return null;
    out.push([x + rx, y, rx]);
    pos = m.index + m[0].length;
  }
  return out.length && !d.slice(pos).trim() ? out : null;
}

/**
 * Replace all children of `parent` in O(n). xmldom's removeChild and insertBefore rebuild the
 * parent's child list on every call, so editing a dense page one node at a time was quadratic
 * (minutes for a page with 150k segments). Appending at the end is O(1).
 */
/** xmldom's own linked-list fields, which its public types mark read-only. */
interface Links {
  parentNode: XNode | null; previousSibling: XNode | null; nextSibling: XNode | null;
  firstChild: XNode | null; lastChild: XNode | null;
  childNodes: { length: number; [i: number]: XNode | undefined };
}
const links = (n: XNode) => n as unknown as Links;

function setChildren(parent: XNode, kids: XNode[]): void {
  for (let c = parent.firstChild; c; ) {
    const n = c.nextSibling;
    const l = links(c);
    l.parentNode = null; l.previousSibling = null; l.nextSibling = null;
    c = n;
  }
  const pl = links(parent);
  pl.firstChild = null;
  pl.lastChild = null;
  const cn = pl.childNodes;
  for (let i = 0; i < cn.length; i++) delete cn[i];
  cn.length = 0;
  for (const k of kids) parent.appendChild(k);
}

/** Circle-stamp paths -> round-capped segments between overlapping stamp centres. */
function stampsToLines(doc: XDocument, parent: XNode): void {
  const kids: XNode[] = [];
  let changed = false;
  for (let el = parent.firstChild; el; el = el.nextSibling) {
    kids.push(el);
    if (!isEl(el) || name(el) !== "path") continue;
    const attrs = Array.from(el.attributes as ArrayLike<{ name: string }>).map((a) => a.name);
    if (attrs.some((a) => !["d", "fill", S_ATTR].includes(a))) continue;
    const fill = el.getAttribute("fill");
    if (!fill || fill === "none") continue;
    const stamps = parseStamps(el.getAttribute("d") ?? "");
    if (!stamps) continue;
    const tag = el.getAttribute(S_ATTR);
    const seg = (a: [number, number], b: [number, number], w: number) => {
      const ln = doc.createElementNS(SVG_NS, "line");
      ln.setAttribute("stroke", fill);
      ln.setAttribute("stroke-linecap", "round");
      ln.setAttribute("stroke-width", w.toFixed(1));
      ln.setAttribute("x1", f2(a[0])); ln.setAttribute("y1", f2(a[1]));
      ln.setAttribute("x2", f2(b[0])); ln.setAttribute("y2", f2(b[1]));
      if (tag !== null && tag !== "") ln.setAttribute(S_ATTR, tag);
      kids.push(ln);
    };
    kids.pop();                                   // the path itself is replaced by its segments
    changed = true;
    let joinedPrev = false;
    stamps.forEach(([cx, cy, r], j) => {
      const nx = stamps[j + 1];
      const joins = !!nx && Math.hypot(nx[0] - cx, nx[1] - cy) <= r + nx[2];
      if (joins) seg([cx, cy], [nx[0], nx[1]], r + nx[2]);
      else if (!joinedPrev) seg([cx, cy], [cx, cy], 2 * r);
      joinedPrev = joins;
    });
  }
  if (changed) setChildren(parent, kids);
}

const fmt1 = (v: number) => { const s = v.toFixed(1); return s.endsWith(".0") ? s.slice(0, -2) : s; };
const LINE_KEYS = new Set(["x1", "y1", "x2", "y2", "stroke", "stroke-width", "stroke-linecap", S_ATTR, O_ATTR]);

/**
 * Merge runs of round-capped <line>s into <polyline>s in a shared <g> (same pixels for
 * opaque strokes). Translucent strokes get one group per stroke with group opacity,
 * so a stroke doesn't darken where its own segments overlap (as in Samsung).
 */
function compactLines(doc: XDocument, parent: XNode): void {
  const children = elements(parent);
  if (children.filter((c) => name(c) === "line").length < 2) return;
  const mergeable = (e: El) => name(e) === "line" && e.getAttribute("stroke-linecap") === "round" && !!e.getAttribute("stroke") &&
    Array.from(e.attributes as ArrayLike<{ name: string }>).every((a) => LINE_KEYS.has(a.name)) && !e.firstChild;
  const keyOf = (e: El) => {
    const o = e.getAttribute(O_ATTR) || "";
    return `${e.getAttribute("stroke") ?? ""}|${o}|${o ? e.getAttribute(S_ATTR) ?? "" : ""}`;
  };
  const out: El[] = [];
  let i = 0;
  while (i < children.length) {
    const el = children[i];
    if (!mergeable(el)) { out.push(el); i++; continue; }
    const key = keyOf(el);
    const g = doc.createElementNS(SVG_NS, "g");
    g.setAttribute("fill", "none");
    g.setAttribute("stroke", el.getAttribute("stroke") ?? "");
    g.setAttribute("stroke-linecap", "round");
    g.setAttribute("stroke-linejoin", "round");
    const op = el.getAttribute(O_ATTR);
    if (op) g.setAttribute("opacity", op);
    let pts: string[] = [];
    let width: string | null = null;
    let prev = "";
    const flush = () => {
      if (!pts.length) return;
      if (pts.length === 1 || (pts.length === 2 && pts[0] === pts[1])) {
        const [x, y] = pts[0].split(",");
        const ln = doc.createElementNS(SVG_NS, "line");
        ln.setAttribute("x1", x); ln.setAttribute("y1", y); ln.setAttribute("x2", x); ln.setAttribute("y2", y);
        ln.setAttribute("stroke-width", width ?? "1");
        g.appendChild(ln);
      } else {
        const pl = doc.createElementNS(SVG_NS, "polyline");
        pl.setAttribute("points", pts.join(" "));
        pl.setAttribute("stroke-width", width ?? "1");
        g.appendChild(pl);
      }
      pts = [];
    };
    while (i < children.length && mergeable(children[i]) && keyOf(children[i]) === key) {
      const c = children[i++];
      const k = ["x1", "y1", "x2", "y2", "stroke-width"].map((a) => c.getAttribute(a)).join(",");
      if (k === prev) continue;              // exact duplicate
      prev = k;
      const at = (a: string) => +(c.getAttribute(a) ?? "");
      const p1 = `${fmt1(at("x1"))},${fmt1(at("y1"))}`;
      const p2 = `${fmt1(at("x2"))},${fmt1(at("y2"))}`;
      const w = c.getAttribute("stroke-width") ?? "1";
      if (pts.length && w === width && pts[pts.length - 1] === p1) {
        if (p2 !== p1) pts.push(p2);
        continue;
      }
      flush();
      width = w;
      pts.push(p1, p2);
    }
    flush();
    out.push(g);
  }
  setChildren(parent, out);
}

/** Returns null when the page has no ink (blank page). */
export function styleSvg(raw: string, strokes: StrokeInfo[], opts: StyleOptions): StyledPage | null {
  const doc = new DOMParser().parseFromString(raw, "image/svg+xml");
  const root = doc.documentElement;
  if (!root) return null;
  const rules = opts.rules ?? PEN_RULES;

  if (opts.stripText)
    for (const t of descendants(root).filter((e) => name(e) === "text")) t.parentNode?.removeChild(t);

  let vb = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || !(vb[2] > 0)) vb = [0, 0, parseFloat(root.getAttribute("width") ?? "1080"), parseFloat(root.getAttribute("height") ?? "1527")];
  const [vx, vy, pw, ph] = vb;

  // The page background is the first full-page filled <rect> child of the root.
  let bg = "#fcfcfc";
  for (const el of elements(root)) {
    if (name(el) === "rect" && el.getAttribute("fill") &&
        parseFloat(el.getAttribute("width") ?? "0") >= pw && parseFloat(el.getAttribute("height") ?? "0") >= ph) {
      bg = el.getAttribute("fill") ?? bg;
      root.removeChild(el);
      break;
    }
  }

  const isInk = (e: El) => INK.has(name(e)) && !inDefs(e);
  const drawn = assignStrokes(descendants(root).filter(isInk), strokes);
  for (const p of [root, ...descendants(root)]) stampsToLines(doc, p);

  let ink = descendants(root).filter(isInk);
  if (opts.recognition) {
    // A large filled shape that belongs to no stroke (e.g. the frame of an old screen-off memo,
    // black by default) is page decoration; on a white recognition page it hides the writing.
    const decoration = (e: El) => {
      if (e.getAttribute(S_ATTR) || e.getAttribute("stroke-width")) return false;
      for (let p: XNode | null = e; isEl(p); p = p.parentNode) {
        const f = p.getAttribute("fill");
        if (f) { if (f === "none") return false; break; }
      }
      const pts = points(e);
      if (!pts || !pts.length) return false;
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (const [x, y] of pts) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
      return (c - a) * (d - b) >= 0.2 * pw * ph;
    };
    for (const e of ink.filter(decoration)) e.parentNode?.removeChild(e);
    ink = descendants(root).filter(isInk);
  }
  if (!ink.length) return null;

  const spans: { e: El; y0: number; y1: number }[] = [];
  const xs: number[] = [], ys: number[] = [];
  let maxW = 0, croppable = true, corrected = 0;
  for (const e of ink) {
    const si = e.getAttribute(S_ATTR);
    const s = si !== null && si !== "" ? strokes[Number(si)] : undefined;
    const c = s ? correctionFor({ ...s, drawn: drawn.get(Number(si)) ?? "outline" }, opts.inkScale, rules) : NO_CORRECTION;
    if (!isIdentity(c)) corrected++;
    const sw = e.getAttribute("stroke-width");
    if (sw) {
      const w = c.constant ?? parseFloat(sw) * c.scale;
      if (c.constant !== undefined || c.scale !== 1) e.setAttribute("stroke-width", f2(w));
      maxW = Math.max(maxW, w);
    }
    if (c.opacity < 1) {
      const o = c.opacity.toFixed(2);
      if (name(e) === "line") e.setAttribute(O_ATTR, o);
      else e.setAttribute("opacity", o);
    }
    if (opts.recolor)
      for (const a of ["stroke", "fill"]) {
        const v = e.getAttribute(a);
        if (v && v !== "none" && v.startsWith("#")) e.setAttribute(a, opts.recolor(v.toLowerCase(), (s?.alpha ?? 1) * c.opacity));
      }
    const pts = points(e) ?? (s ? [[s.bbox[0], s.bbox[1]], [s.bbox[2], s.bbox[3]]] as [number, number][] : null);
    if (!pts) { croppable = false; continue; }
    let ey0 = Infinity, ey1 = -Infinity;
    for (const [x, y] of pts) { xs.push(x); ys.push(y); if (y < ey0) ey0 = y; if (y > ey1) ey1 = y; }
    if (opts.recognition) spans.push({ e, y0: ey0, y1: ey1 });
    if (!sw && s) maxW = Math.max(maxW, c.constant ?? s.width * c.scale);
  }

  // Recognition: shrink tall empty gaps (a sparse note on a long canvas would otherwise be a sliver).
  const gapMax = opts.recognition?.collapseGap;
  if (gapMax && croppable && spans.length) {
    spans.sort((a, b) => a.y0 - b.y0);
    const join = Math.max(maxW, 0.01 * pw);           // pieces this close belong to one band
    const raw: { y0: number; y1: number; members: El[] }[] = [];
    for (const sp of spans) {
      const last = raw[raw.length - 1];
      if (last && sp.y0 <= last.y1 + join) { last.y1 = Math.max(last.y1, sp.y1); last.members.push(sp.e); }
      else raw.push({ y0: sp.y0, y1: sp.y1, members: [sp.e] });
    }
    let shift = 0;
    for (let i = 1; i < raw.length; i++) {
      shift += Math.max(0, raw[i].y0 - raw[i - 1].y1 - gapMax);
      if (shift > 0) for (const e of raw[i].members) shiftY(e, shift);
    }
    if (shift > 0) {
      ys.length = 0;
      ys.push(raw[0].y0, raw[raw.length - 1].y1 - shift);
    }
  }

  let x0 = vx, y0 = vy, x1 = vx + pw, y1 = vy + ph;
  if (croppable && xs.length) {
    const pad = opts.padding + maxW / 2;
    // Loop, not Math.min(...xs): a dense page has >100k points, beyond the argument limit.
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (let i = 0; i < xs.length; i++) {
      if (xs[i] < mnx) mnx = xs[i];
      if (xs[i] > mxx) mxx = xs[i];
      if (ys[i] < mny) mny = ys[i];
      if (ys[i] > mxy) mxy = ys[i];
    }
    x0 = Math.max(mnx - pad, vx); y0 = Math.max(mny - pad, vy);
    x1 = Math.min(mxx + pad, vx + pw); y1 = Math.min(mxy + pad, vy + ph);
  }
  const w = x1 - x0, h = y1 - y0;
  root.setAttribute("viewBox", `${f2(x0)} ${f2(y0)} ${f2(w)} ${f2(h)}`);
  root.setAttribute("width", w.toFixed(0));
  root.setAttribute("height", h.toFixed(0));
  for (const cp of descendants(root).filter((e) => name(e) === "clipPath"))
    for (const r of elements(cp).filter((e) => name(e) === "rect")) {
      r.setAttribute("x", f2(x0)); r.setAttribute("y", f2(y0)); r.setAttribute("width", f2(w)); r.setAttribute("height", f2(h));
    }
  const card = doc.createElementNS(SVG_NS, "rect");
  for (const [k, v] of [["x", f2(x0)], ["y", f2(y0)], ["width", f2(w)], ["height", f2(h)], ["rx", String(opts.radius)], ["fill", opts.background ?? bg]])
    card.setAttribute(k, v);
  root.insertBefore(card, root.firstChild);

  for (const p of [root, ...descendants(root)]) compactLines(doc, p);
  for (const e of descendants(root)) { e.removeAttribute(S_ATTR); e.removeAttribute(O_ATTR); }
  return { svg: new XMLSerializer().serializeToString(doc), inkElements: ink.length, corrected };
}

/** Move an ink element up by `dy` page units (coordinates where simple, a transform otherwise). */
function shiftY(e: El, dy: number): void {
  const mv = (k: string) => e.setAttribute(k, fmt1(parseFloat(e.getAttribute(k) ?? "0") - dy));
  switch (name(e)) {
    case "line": mv("y1"); mv("y2"); return;
    case "circle": case "ellipse": mv("cy"); return;
    case "rect": case "image": mv("y"); return;
    case "polyline": case "polygon": {
      const n = (e.getAttribute("points") ?? "").match(NUM)?.map(Number) ?? [];
      const out: string[] = [];
      for (let i = 0; i + 1 < n.length; i += 2) out.push(`${fmt1(n[i])},${fmt1(n[i + 1] - dy)}`);
      e.setAttribute("points", out.join(" "));
      return;
    }
    default: {
      const t = e.getAttribute("transform");
      e.setAttribute("transform", `translate(0 ${fmt1(-dy)})${t ? " " + t : ""}`);
    }
  }
}
