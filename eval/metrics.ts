// Scoring maths for the eval harness (unit-tested in test/units.test.ts).

/** Levenshtein distance over arrays (chars or words). */
export function lev<T>(a: T[], b: T[]): number {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j), cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Normalised for comparison: [?] removed, whitespace collapsed; `loose` also drops case and punctuation. */
export function norm(s: string, loose = false): string {
  let t = s.replace(/\[\?\]/g, " ").replace(/\s+/g, " ").trim();
  if (loose) t = t.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").replace(/\s+/g, " ").trim();
  return t;
}

export const cer = (hyp: string, ref: string, loose = false) => { const r = [...norm(ref, loose)], h = [...norm(hyp, loose)]; return r.length ? lev(h, r) / r.length : h.length ? 1 : 0; };
export const wer = (hyp: string, ref: string, loose = false) => { const r = norm(ref, loose).split(" ").filter(Boolean), h = norm(hyp, loose).split(" ").filter(Boolean); return r.length ? lev(h, r) / r.length : h.length ? 1 : 0; };
/** Similarity of two transcriptions, 0..1 (1 = identical after normalising). */
export const agree = (a: string, b: string) => { const x = [...norm(a, true)], y = [...norm(b, true)]; const m = Math.max(x.length, y.length); return m ? 1 - lev(x, y) / m : 1; };

// The plugin's own OCR clean-up, so the harness scores what the plugin would write.
export { cleanOcr, stripFences } from "../src/recognize/prompt";
