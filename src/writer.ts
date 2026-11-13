// File names and Markdown for notes. Never deletes anything.
import { createHash } from "node:crypto";

export const ENRICH_BEGIN = (name: string) => `<!-- memo-bridge:enrich:${name} begin`;
export const ENRICH_END = (name: string) => `<!-- memo-bridge:enrich:${name} end -->`;

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Hex characters of the note id; notes from one device share the leading ones. */
export function idHex(noteId: string): string {
  return noteId.split("_")[0].toLowerCase().replace(/[^0-9a-f]/g, "");
}

/** Safe file/folder name: no path separators, Obsidian link syntax, or Windows-reserved names. */
export function sanitizeName(s: string, max = 100): string {
  let out = s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ").trim().replace(/^[.\s]+|[.\s]+$/g, "");
  if (out.length > max) out = out.slice(0, max).replace(/[.\s]+$/, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(out)) out = `_${out}`;
  return out;
}

/**
 * The note's file stem: its title when it has a real one, otherwise "<date>-<short id>".
 * `taken` holds stems already used in the same folder (case-insensitive on Windows).
 */
export function baseName(createdDate: string, noteId: string, title: string, taken: Set<string>): string {
  const hex = idHex(noteId);
  const free = (n: string) => !taken.has(n.toLowerCase());
  const t = sanitizeName(title);
  if (t) {
    if (free(t)) return t;
    for (const n of [8, 12, hex.length]) { const c = `${t} (${hex.slice(-n)})`; if (free(c)) return c; }
  }
  for (const n of [8, 12, 16, hex.length]) { const c = `${createdDate}-${hex.slice(-n)}`; if (free(c)) return c; }
  return `${createdDate}-${hex}`;
}

export function revisionName(base: string, revision: number): string {
  return revision === 1 ? base : `${base}.r${revision}`;
}

export const stripRevision = (name: string) => name.replace(/\.r\d+$/, "");

const yamlStr = (v: string) => `'${v.replace(/'/g, "''")}'`;

export interface NoteMarkdown {
  created: string;
  modified: string;
  noteId: string;
  folder: string;
  source: "screen-off-memo" | "samsung-note";
  content: "handwriting" | "text" | "mixed" | "empty";
  revision: number;
  render: "sdocx" | "thumbnail" | "text";
  pages: number;
  inkScale: number | null;
  penTable: number | null;
  sdocxBackup: string;
  previous?: string | null;
  renderNote?: string | null;
  /** Body blocks in order: embeds and Markdown text. */
  body: string[];
}

export function composeMarkdown(m: NoteMarkdown): string {
  const fm = [
    "---",
    `created: ${m.created}`,
    `modified: ${m.modified}`,
    `samsung_note_id: ${m.noteId}`,
    `folder: ${yamlStr(m.folder)}`,
    `source: ${m.source}`,
    `content: ${m.content}`,
    `revision: ${m.revision}`,
    `render: ${m.render}`,
  ];
  if (m.pages > 1) fm.push(`pages: ${m.pages}`);
  if (m.render === "sdocx" && m.inkScale !== null) fm.push(`ink_scale: ${m.inkScale}`);
  if (m.render === "sdocx" && m.penTable !== null) fm.push(`pen_table: ${m.penTable}`);
  fm.push(`sdocx_backup: ${yamlStr(m.sdocxBackup)}`);
  if (m.previous) fm.push(`previous_revision: ${yamlStr(`[[${m.previous}]]`)}`);
  if (m.renderNote) fm.push(`render_note: ${yamlStr(m.renderNote)}`);
  fm.push("---", "");
  return fm.join("\n") + m.body.filter((b) => b.trim()).join("\n\n") + "\n";
}

export function embed(fileName: string): string {
  return `![[${fileName}]]`;
}

/** Insert or replace one enricher's marked block; nothing else in the note changes. */
export function upsertSection(md: string, name: string, section: string, meta: string): string {
  const begin = ENRICH_BEGIN(name), end = ENRICH_END(name);
  const block = `${begin} ${meta} -->\n${section.trimEnd()}\n${end}\n`;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${esc(begin)}[\\s\\S]*?${esc(end)}\\n?`);
  return re.test(md) ? md.replace(re, () => block) : md.replace(/\n*$/, "") + "\n\n" + block;
}

/** A scalar value from a note's YAML frontmatter (top-level `key: value` lines only), or null. */
export function frontmatterValue(md: string, key: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return null;
  const line = new RegExp(`^${key}:[ \t]*(.*)$`, "m").exec(m[1]);
  return line ? line[1].trim().replace(/^["']|["']$/g, "") : null;
}

/** Path shown in frontmatter for files outside the vault, without the user's profile path. */
export function displayPath(abs: string): string {
  const lad = process.env.LOCALAPPDATA;
  return lad && abs.toLowerCase().startsWith(lad.toLowerCase()) ? "%LOCALAPPDATA%" + abs.slice(lad.length) : abs;
}
