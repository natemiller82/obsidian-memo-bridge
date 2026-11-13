// The recognition prompt and output schema: identical for every provider, so results can be
// compared like for like. The prompt has an id (bumped by hand when the wording changes) and a
// hash over the exact text sent (including the user's context hint), recorded with each result.
import { sha256 } from "../writer";

export const PROMPT_ID = "p1";

export interface PageResult {
  has_text: boolean;
  transcription: string;
  drawing: string;
  alt_text: string;
  language: string;
  languages: string[];
  unreadable: number;
}

/** JSON Schema for PageResult; every provider's structured-output mode accepts this subset. */
export const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["has_text", "transcription", "drawing", "alt_text", "language", "languages", "unreadable"],
  properties: {
    has_text: { type: "boolean", description: "true if the page contains any handwritten words" },
    transcription: { type: "string", description: "the handwritten words exactly as written; [?] for each unreadable word; empty if has_text is false" },
    drawing: { type: "string", description: "one sentence describing any sketch, diagram, arrow, table or doodle; empty if none" },
    alt_text: { type: "string", description: "one or two sentences describing the whole page for a screen reader" },
    language: { type: "string", description: "main language of the handwriting, ISO 639-1 code; empty if no text" },
    languages: { type: "array", items: { type: "string" }, description: "every language present, ISO 639-1 codes" },
    unreadable: { type: "integer", description: "number of [?] markers in transcription" },
  },
} as const;

const SYSTEM = `You transcribe one page of a handwritten note for the writer's personal notes archive.
The image shows handwriting, and possibly drawings, as dark ink on a white background.
Answer with JSON that matches the schema. Rules:

transcription
- Copy the handwritten words exactly as written, line by line, with a newline between lines.
- Keep the writer's spelling, abbreviations, capitalisation and punctuation. Do not correct, expand, translate or complete anything.
- Write [?] in place of each word you cannot read with confidence. Never guess silently.
- Words inside a drawing (labels, arrows with text) belong in the transcription; the drawing itself does not.
- If the page has no handwritten words at all, set has_text to false and transcription to "" (empty). Never invent text.

drawing
- One sentence describing any sketch, diagram, arrow, table, symbol or doodle, or "" if there is none. Do not repeat the transcription.

alt_text
- One or two sentences for a screen reader describing the whole page: what kind of note it is, its subject or main words, and any drawing.

language, languages
- The main language of the handwriting as an ISO 639-1 code (for example "en"), and every language present. Use "" and [] if there is no text.

unreadable
- The number of [?] markers in the transcription.`;

export interface Prompt { id: string; hash: string; system: string; user: string }

export function buildPrompt(contextHint = ""): Prompt {
  const hint = contextHint.trim();
  const user = "Transcribe and describe this page." +
    (hint ? `\n\nContext from the writer (use it to read unfamiliar terms; do not add anything that isn't written): ${hint}` : "");
  const hash = sha256(JSON.stringify([SYSTEM, user, RESULT_SCHEMA])).slice(0, 12);
  return { id: PROMPT_ID, hash, system: SYSTEM, user };
}

export class InvalidOutput extends Error {}

/** Parse and check a provider's answer. Throws InvalidOutput when it doesn't follow the rules. */
export function parseResult(text: string): PageResult {
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1];
  let o: Record<string, unknown>;
  try { o = JSON.parse(t) as Record<string, unknown>; } catch { throw new InvalidOutput(`not JSON: ${t.slice(0, 80)}`); }
  if (!o || typeof o !== "object") throw new InvalidOutput("not a JSON object");
  const str = (k: string) => { if (typeof o[k] !== "string") throw new InvalidOutput(`${k} is not a string`); return (o[k] as string); };
  if (typeof o.has_text !== "boolean") throw new InvalidOutput("has_text is not a boolean");
  const r: PageResult = {
    has_text: o.has_text,
    transcription: str("transcription").replace(/\r\n/g, "\n").trim(),
    drawing: str("drawing").trim(),
    alt_text: str("alt_text").trim(),
    language: str("language").trim().toLowerCase(),
    languages: Array.isArray(o.languages) ? o.languages.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()).filter(Boolean) : [],
    unreadable: 0,
  };
  // Never guess silently: an empty page must have an empty transcription, and vice versa.
  if (!r.has_text && r.transcription) throw new InvalidOutput("has_text is false but the transcription isn't empty");
  if (r.has_text && !r.transcription) throw new InvalidOutput("has_text is true but the transcription is empty");
  if (!r.alt_text) throw new InvalidOutput("alt_text is empty");
  if (!r.has_text) { r.language = ""; r.languages = []; }
  r.unreadable = (r.transcription.match(/\[\?\]/g) ?? []).length;     // count it ourselves
  return r;
}

/**
 * Markdown code-fence markers OCR models put round their answer (```, ```markdown), wherever they
 * are. Only known language tags: a word right after a closing fence is writing ("```Hello").
 */
export const stripFences = (s: string) => s.replace(/```(?:markdown|md|text|plaintext|txt)?/gi, "");

/** An OCR-only model's plain-text answer: fences stripped; no letters or digits means no text. */
export function cleanOcr(s: string): string {
  const t = stripFences(s.replace(/\r\n/g, "\n")).replace(/[ \t]+$/gm, "").trim();
  return /[\p{L}\p{N}]/u.test(t) ? t : "";
}

/**
 * Two-model recognition: the description model's answer with the transcription model's text.
 * The transcription model decides what the text is; when it finds none but the description model
 * did, that text is kept, so a page is never emptied by the second opinion.
 */
export function withTranscription(desc: PageResult, text: string): PageResult {
  const transcription = text.trim() || desc.transcription;
  const has_text = transcription.length > 0;
  return {
    ...desc, has_text, transcription,
    language: has_text ? desc.language : "", languages: has_text ? desc.languages : [],
    unreadable: (transcription.match(/\[\?\]/g) ?? []).length,
  };
}
