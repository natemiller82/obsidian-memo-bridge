// Shared bits of the recognition eval harness. Everything it writes goes to <repo>/local/eval,
// which is gitignored: it holds the user's own notes and must never be committed.
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { InlineRenderer } from "../src/render/renderer";
import { stripFences } from "./metrics";

const require = createRequire(import.meta.url);

// Run from the plugin folder: in the public repo that is the repo root; in the development
// repo it is <repo>/plugin. Either way the eval data lives in <repo>/local/eval (gitignored).
export const REPO = path.basename(process.cwd()) === "plugin" ? path.resolve(process.cwd(), "..") : process.cwd();
export const EVAL_DIR = path.join(REPO, "local", "eval");
export const SET_FILE = path.join(EVAL_DIR, "set.json");
export const RUNS_DIR = path.join(EVAL_DIR, "runs");

/** The context hint for --hint runs: local/eval/hint.txt (gitignored; it describes your own notes). */
export function evalHint(): string {
  const f = path.join(EVAL_DIR, "hint.txt");
  if (!fs.existsSync(f)) throw new Error(`--hint needs the hint text in ${f}`);
  return fs.readFileSync(f, "utf8").trim();
}

export function renderer() {
  const wasm = fs.readFileSync(require.resolve("@twango/sdocx/sdocx_bg.wasm"));
  return new InlineRenderer(() => new Uint8Array(wasm));
}

export interface EvalPage { file: string; w: number; h: number; source: "strokes" | "thumbnail" | "synthetic" }

export interface EvalItem {
  key: string;            // folder name under local/eval, e.g. "07-inkpen-1"
  why: string;            // which case it covers
  noteId: string | null;  // null for synthetic controls
  created: string | null;
  folder: string | null;
  screenOff: boolean;
  render: "sdocx" | "thumbnail" | "synthetic";
  pens: string[];
  expectEmpty: boolean;   // control: a page with no handwritten text
  pages: EvalPage[];
}

export function readSet(): EvalItem[] {
  if (!fs.existsSync(SET_FILE)) throw new Error(`no evaluation set yet: run "npm run eval -- pick" first (${SET_FILE})`);
  return JSON.parse(fs.readFileSync(SET_FILE, "utf8")) as EvalItem[];
}

export function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
export const flag = (name: string) => process.argv.includes(`--${name}`);

/** Ground truth for one page, if the user has corrected it: <item>/p<k>.truth.txt, or truth.json from the review page. */
export function truthFor(item: EvalItem, page: number): string | null {
  const f = path.join(EVAL_DIR, item.key, `p${page}.truth.txt`);
  // Fence markers are never handwriting; drafts taken from an OCR model's answer can carry them.
  const clean = (t: string) => stripFences(t.replace(/\r\n/g, "\n")).trim();
  if (fs.existsSync(f)) return clean(fs.readFileSync(f, "utf8"));
  const j = path.join(EVAL_DIR, "truth.json");
  if (fs.existsSync(j)) {
    const all = JSON.parse(fs.readFileSync(j, "utf8")) as Record<string, string>;
    const v = all[`${item.key}/p${page}`];
    if (typeof v === "string") return clean(v);
  }
  return null;
}
