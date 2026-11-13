// Samsung typed text (+ formatting spans) -> Markdown.
// Spans arrive as raw payload bytes from sdocx. Decoded so far (seen in real notes):
// Bold, Underline (on/off flag), BackgroundColor (RGBA -> ==highlight==).
// Font size, text colour and alignment have no Markdown equivalent and are dropped.
import type { PageText, TextSpan } from "./render/core";

interface Flags { b: boolean; u: boolean; h: boolean }

const on = (p: number[]) => p.slice(0, 4).some((v) => v !== 0);

function spanFlags(s: TextSpan): Partial<Flags> | null {
  switch (s.kind) {
    case "Bold": return { b: on(s.payload) };
    case "Underline": return { u: on(s.payload) };
    case "BackgroundColor": {
      const [r, g, b, a] = s.payload;
      const white = r >= 250 && g >= 250 && b >= 250;
      return { h: (a ?? 0) > 0 && !white };
    }
    default: return null;
  }
}

/** Escape what Obsidian would otherwise interpret (emphasis, links, tags, math, comments, HTML). */
export function escapeMarkdown(line: string): string {
  let s = line.replace(/([\\`*_[\]<>|~$])/g, "\\$1").replace(/==/g, "\\=\\=").replace(/%%/g, "\\%\\%");
  s = s.replace(/^(\s*)([#+-]|\d+[.)])(?=\s|$)/, (_m, sp: string, mk: string) => `${sp}\\${mk}`);
  s = s.replace(/(^|\s)#(?=\S)/g, "$1\\#");   // would become a tag
  return s;
}

function wrap(text: string, f: Flags): string {
  if (!text.trim() || (!f.b && !f.u && !f.h)) return escapeMarkdown(text);
  const lead = text.match(/^\s*/)![0], trail = text.match(/\s*$/)![0];
  let core = escapeMarkdown(text.trim());
  if (f.u) core = `<u>${core}</u>`;
  if (f.b) core = `**${core}**`;
  if (f.h) core = `==${core}==`;
  return lead + core + trail;
}

export interface MarkdownText {
  markdown: string;
  /** Blank lines Samsung put before the text (it positions text below handwriting this way). */
  leadingBlankLines: number;
}

export function textToMarkdown(t: PageText | null): MarkdownText | null {
  if (!t || !t.text.trim()) return null;
  const raw = t.text.replace(/\r\n?/g, "\n");
  const flags: Flags[] = Array.from({ length: raw.length }, () => ({ b: false, u: false, h: false }));
  for (const s of t.spans) {
    const f = spanFlags(s);
    if (!f) continue;
    for (let i = Math.max(0, s.start); i < Math.min(raw.length, s.end); i++) Object.assign(flags[i], f);
  }
  const lines: string[] = [];
  let i = 0;
  for (const line of raw.split("\n")) {
    let out = "", run = "", cur: Flags | null = null;
    for (let j = 0; j < line.length; j++) {
      const f = flags[i + j];
      if (cur && (f.b !== cur.b || f.u !== cur.u || f.h !== cur.h)) { out += wrap(run, cur); run = ""; }
      cur = f;
      run += line[j];
    }
    if (cur) out += wrap(run, cur);
    lines.push(out.trimEnd());
    i += line.length + 1;
  }
  const leading = lines.findIndex((l) => l.trim() !== "");
  const body = lines.slice(leading);
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return { markdown: body.join("\n").replace(/\n{3,}/g, "\n\n"), leadingBlankLines: leading };
}

/** Plain text from Samsung's database (used when the note package can't be parsed). */
export function plainToMarkdown(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n").map((l) => escapeMarkdown(l).trimEnd()).join("\n")
    .replace(/^\n+|\n+$/g, "").replace(/\n{3,}/g, "\n\n");
}
