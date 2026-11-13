import * as fs from "node:fs";
import type { SyncConfig } from "./sync";
import type { ProviderKind } from "./recognize/providers";

export interface Settings {
  /** Samsung Notes LocalState folder; "" = auto-detect. */
  localState: string;
  rootFolder: string;
  screenOffOnly: boolean;
  dateField: "created" | "modified";
  /** "YYYY-MM-DD" or ISO date-time; "" = no lower bound. */
  since: string;
  /** "YYYY-MM-DD" (inclusive) or ISO date-time; "" = no upper bound. */
  until: string;
  includeFolders: string;
  excludeFolders: string;
  inkScale: number;
  pollSeconds: number;
  checkSamsungSync: boolean;
  backfillBatchSize: number;
  paused: boolean;
  debugLog: boolean;
  // ---- recognition (text recognition and alt text); off unless a provider is chosen ----
  recProvider: RecProvider;
  /** Model per provider, so switching providers keeps each choice. */
  recModels: Partial<Record<ProviderKind, string>>;
  /** Optional transcription-only model per provider (e.g. glm-ocr); empty = the main model transcribes. */
  recTextModels: Partial<Record<ProviderKind, string>>;
  recUrls: Partial<Record<ProviderKind, string>>;
  /** Names of secrets in Obsidian's secret storage (the keys themselves are never in data.json). */
  recSecretIds: Partial<Record<ProviderKind, string>>;
  /** Hosted providers whose one-time notice the user accepted. */
  recAcknowledged: ProviderKind[];
  recAutoRun: boolean;
  /** Samsung folders whose notes may be sent to a hosted provider, one per line (empty = none). */
  recHostedFolders: string;
  /** Samsung folders never recognised, by any provider. */
  recExcludeFolders: string;
  recContextHint: string;
  recAltInEmbed: boolean;
  recHostedDailyPages: number;
}

export type RecProvider = "none" | ProviderKind;

export const DEFAULTS: Settings = {
  localState: "",
  rootFolder: "Samsung Notes",
  screenOffOnly: false,
  dateField: "created",
  since: "",
  until: "",
  includeFolders: "",
  excludeFolders: "",
  inkScale: 2.6,
  pollSeconds: 30,
  checkSamsungSync: true,
  backfillBatchSize: 25,
  paused: false,
  debugLog: false,
  recProvider: "none",
  recModels: {},
  recTextModels: {},
  recUrls: {},
  recSecretIds: {},
  recAcknowledged: [],
  recAutoRun: false,
  recHostedFolders: "",
  recExcludeFolders: "",
  recContextHint: "",
  recAltInEmbed: false,
  recHostedDailyPages: 25,
};

/** Lower bound: a date means the start of that day (local time). */
export function parseSince(s: string): number | null {
  const v = s.trim();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { const [y, m, d] = v.split("-").map(Number); return new Date(y, m - 1, d).getTime(); }
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`not a date: ${v}`);
  return t;
}

/** Upper bound: a date means the end of that day (local time), inclusive. */
export function parseUntil(s: string): number | null {
  const v = s.trim();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { const [y, m, d] = v.split("-").map(Number); return new Date(y, m - 1, d + 1).getTime() - 1; }
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`not a date: ${v}`);
  return t;
}

const lines = (s: string) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

export function toSyncConfig(s: Settings): SyncConfig {
  return {
    rootFolder: s.rootFolder.trim().replace(/^\/+|\/+$/g, "") || DEFAULTS.rootFolder,
    screenOffOnly: s.screenOffOnly,
    dateField: s.dateField,
    sinceMs: safe(() => parseSince(s.since)),
    untilMs: safe(() => parseUntil(s.until)),
    includeFolders: lines(s.includeFolders),
    excludeFolders: lines(s.excludeFolders),
    settleMs: 20_000,
    inkScale: s.inkScale > 0 ? s.inkScale : DEFAULTS.inkScale,
    padding: 48,
    radius: 28,
    renderTimeoutMs: 60_000,
  };
}

function safe(f: () => number | null): number | null {
  try { return f(); } catch { return null; }
}

/** First run: take the start date from the Python bridge's config if present, else now. */
export function initialSince(pythonConfig: string): string {
  try {
    const raw = JSON.parse(fs.readFileSync(pythonConfig, "utf8"));
    if (typeof raw.since === "string" && !Number.isNaN(Date.parse(raw.since))) return raw.since;
  } catch { /* none */ }
  return new Date().toISOString();
}

