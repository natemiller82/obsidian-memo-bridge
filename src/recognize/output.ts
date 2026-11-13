// What recognition writes into the vault, as pure string functions:
//  * a machine-generated section between the enrich markers (transcription, drawing, description);
//  * frontmatter: transcribed_by, transcribed_at, transcription_version, transcription_language, alt_text;
//  * optionally (opt-in, unedited notes only) the alt text inside the page image embeds.
// The SVG files are never touched.
import { upsertSection } from "../writer";
import type { PageResult } from "./prompt";

export const ENRICHER = "transcribe";
export const ENRICHER_VERSION = "1";

export interface PageOutput { page: number; result: PageResult; source: "strokes" | "thumbnail" }

export interface RunInfo { provider: string; model: string; promptId: string; promptHash: string; at: string }

const PRIVATE_KEYS = ["memo_bridge_private"];

/** Transcription text made safe inside a callout: can't open headings/quotes or break our markers. */
function safeLine(l: string): string {
  return l.replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;").replace(/^(\s*)([#>])/, "$1\\$2").replace(/^---+$/, "\\---");
}

export function languages(pages: PageOutput[]): string[] {
  const out: string[] = [];
  for (const p of pages) for (const l of [p.result.language, ...p.result.languages]) if (l && !out.includes(l)) out.push(l);
  return out;
}

export function altText(pages: PageOutput[]): string {
  const parts = pages.map((p) => p.result.alt_text.replace(/\s+/g, " ").trim()).filter(Boolean);
  return pages.length > 1 ? parts.map((t, i) => `Page ${pages[i].page}: ${t}`).join(" ") : parts[0] ?? "";
}

export function versionTag(run: RunInfo): string {
  return `${ENRICHER_VERSION}+${run.promptId}+${run.promptHash.slice(0, 8)}`;
}

/** The callout that goes between the enrich markers. */
export function sectionMarkdown(pages: PageOutput[], run: RunInfo): string {
  const langs = languages(pages);
  const title = `Transcription (machine-generated · ${run.provider}/${run.model} · ${run.at.slice(0, 10)}${langs.length ? ` · ${langs.join(", ")}` : ""})`;
  const body: string[] = [];
  const multi = pages.length > 1;
  for (const p of pages) {
    if (multi) body.push(`**Page ${p.page}**`);
    if (p.source === "thumbnail") body.push("_From Samsung's thumbnail of the first page; later pages and fine detail aren't included._");
    body.push(p.result.has_text ? p.result.transcription.split("\n").map(safeLine).join("\n") : "_No handwritten text._");
    if (p.result.drawing) body.push(`**Drawing:** ${safeLine(p.result.drawing)}`);
    if (multi) body.push(`**Description:** ${safeLine(p.result.alt_text)}`);
    body.push("");
  }
  if (!multi) body.push(`**Description:** ${safeLine(altText(pages))}`);
  while (body.length && body[body.length - 1] === "") body.pop();
  const quoted = body.flatMap((b) => b.split("\n")).map((l) => (l ? `> ${l}` : ">"));
  return [`> [!memo-bridge]- ${title}`, ...quoted].join("\n");
}

/** YAML double-quoted scalar (JSON strings are valid YAML). */
const yamlStr = (s: string) => JSON.stringify(s);

/** Set (or remove, with null) top-level frontmatter keys; adds a frontmatter block if there is none. */
export function setFrontmatter(md: string, entries: Record<string, string | null>): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(md);
  let lines = m ? m[1].split(/\r?\n/) : [];
  for (const [k, v] of Object.entries(entries)) {
    const i = lines.findIndex((l) => l.startsWith(`${k}:`));
    // drop continuation lines of a previous multi-line value
    if (i >= 0) { let j = i + 1; while (j < lines.length && /^\s+\S/.test(lines[j])) j++; lines.splice(i, j - i); }
    if (v !== null) {
      const line = `${k}: ${v}`;
      if (i >= 0) lines.splice(i, 0, line); else lines.push(line);
    }
  }
  lines = lines.filter((l, i, a) => !(l === "" && i === a.length - 1));
  const block = `---\n${lines.join("\n")}\n---\n`;
  return m ? block + md.slice(m[0].length) : block + md;
}

/** The frontmatter properties a transcription sets, as plain values. */
export function recognitionFields(pages: PageOutput[], run: RunInfo): Record<string, string> {
  return {
    transcribed_by: `${run.provider}/${run.model}`,
    transcribed_at: run.at,
    transcription_version: versionTag(run),
    transcription_language: languages(pages).join(", "),
    alt_text: altText(pages),
  };
}

/** The same, YAML-encoded for a note written as text (sidecars). */
export function recognitionFrontmatter(pages: PageOutput[], run: RunInfo): Record<string, string> {
  const f = recognitionFields(pages, run);
  return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, k === "transcribed_at" ? v : yamlStr(v)]));
}

/** Alt text safe inside ![[file|alt]]: no pipes, brackets or newlines; short. */
export function embedAlt(s: string): string {
  const t = s.replace(/[|[\]\r\n#^]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > 250 ? t.slice(0, 247).trimEnd() + "…" : t;
}

/**
 * Put alt text into the page-image embeds (opt-in). `files` are the vault paths of the page
 * images in page order; an existing alt/size after "|" is replaced.
 */
export function setEmbedAlt(md: string, files: string[], alts: string[]): string {
  let out = md;
  files.forEach((f, i) => {
    const alt = embedAlt(alts[i] ?? alts[0] ?? "");
    if (!alt) return;
    const esc = f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`!\\[\\[${esc}(\\|[^\\]]*)?\\]\\]`, "g"), `![[${f}|${alt}]]`);
  });
  return out;
}

/** The note's own text with our recognition results applied. */
/** The note's body with the transcription section (and alt text in the embeds, if on); frontmatter is set separately. */
export function applyBody(md: string, pages: PageOutput[], run: RunInfo, opts: { altInEmbed: boolean; imageFiles: string[] }): string {
  let out = upsertSection(md, ENRICHER, sectionMarkdown(pages, run), `version=${versionTag(run)} provider=${run.provider} model=${run.model}`);
  if (opts.altInEmbed) out = setEmbedAlt(out, opts.imageFiles, pages.map((p) => p.result.alt_text));
  return out;
}

export function applyToNote(md: string, pages: PageOutput[], run: RunInfo, opts: { altInEmbed: boolean; imageFiles: string[] }): string {
  let out = setFrontmatter(md, recognitionFrontmatter(pages, run));
  out = upsertSection(out, ENRICHER, sectionMarkdown(pages, run), `version=${versionTag(run)} provider=${run.provider} model=${run.model}`);
  if (opts.altInEmbed) out = setEmbedAlt(out, opts.imageFiles, pages.map((p) => p.result.alt_text));
  return out;
}

/** Sidecar for a note the user has edited: same frontmatter and section, linked to the note. */
export function sidecarMarkdown(noteName: string, noteId: string, pages: PageOutput[], run: RunInfo): string {
  const fm = setFrontmatter("", {
    // not samsung_note_id: the vault index must not mistake the sidecar for the note itself
    transcription_of_note_id: yamlStr(noteId),
    transcription_of: yamlStr(`[[${noteName}]]`),
    ...recognitionFrontmatter(pages, run),
  });
  return upsertSection(fm, ENRICHER, sectionMarkdown(pages, run), `version=${versionTag(run)} provider=${run.provider} model=${run.model}`);
}

/** True when the note's frontmatter says it must never go to a hosted provider. */
export function isPrivate(md: string): boolean {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return false;
  return PRIVATE_KEYS.some((k) => new RegExp(`^${k}:\\s*(true|yes|on)\\s*$`, "im").test(m[1]));
}
