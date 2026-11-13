// Cost estimates for hosted providers. Prices change: these are list prices as published on
// PRICES_AS_OF, used only for estimates that say so. Unknown models get no estimate.
import type { ProviderKind } from "./providers";

export const PRICES_AS_OF = "2026-11-11";

interface Price { inPerM: number; outPerM: number }

/** USD per million tokens, by model id prefix (longest prefix wins). */
const PRICES: Record<"anthropic" | "openai" | "gemini", Record<string, Price>> = {
  anthropic: {
    "claude-haiku-5-5": { inPerM: 0.10, outPerM: 0.50 },
    "claude-sonnet-5-5": { inPerM: 2, outPerM: 10 },
    "claude-opus-5-5": { inPerM: 4, outPerM: 20 },
    "claude-fable-5-2": { inPerM: 8, outPerM: 40 },
    "claude-fable-5-1": { inPerM: 10, outPerM: 50 },
  },
  openai: {
    "gpt-6-luna": { inPerM: 0.10, outPerM: 0.50 },
    "gpt-6.1-terra": { inPerM: 1, outPerM: 5 },
    "gpt-6.1-sol": { inPerM: 2, outPerM: 10 },
    "gpt-6-astra": { inPerM: 10, outPerM: 50 },
  },
  gemini: {
    "gemini-3.1-flash-lite": { inPerM: 0.25, outPerM: 1.50 },
    "gemini-3.5-flash-lite": { inPerM: 0.30, outPerM: 2.50 },
    "gemini-3.8-flash": { inPerM: 0.75, outPerM: 3.75 },        // doubles on 2027-01-01
    "gemini-3.1-pro": { inPerM: 2, outPerM: 12 },
    "gemini-4-carbon": { inPerM: 2, outPerM: 10 },
    "gemini-4-argon": { inPerM: 2, outPerM: 10 },
  },
};

/** Models offered in the dropdown where the provider's list can't say which accept images. */
export const SUGGESTED_MODELS: Partial<Record<ProviderKind, string[]>> = {
  anthropic: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
  openai: ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol"],
  gemini: ["gemini-3.5-flash-lite", "gemini-3.8-flash"],
  // the -instruct tag: plain qwen3-vl tags are thinking models and timed out on 9 of 23 eval pages
  ollama: ["qwen3-vl:8b-instruct"],
};

/**
 * Suggested transcription-only models (the optional second model). On the eval set, glm-ocr for
 * the text with qwen3-vl:8b-instruct for the description roughly halved the word error rate.
 */
export const SUGGESTED_TEXT_MODELS: Partial<Record<ProviderKind, string[]>> = {
  ollama: ["glm-ocr"],
};

/** Image tokens for a w x h PNG, per the providers' published formulas. */
export function imageTokens(kind: ProviderKind, w: number, h: number): number {
  switch (kind) {
    case "anthropic": return Math.ceil(w / 28) * Math.ceil(h / 28);
    case "openai": return Math.ceil(Math.ceil(w / 32) * Math.ceil(h / 32) * 1.2);
    case "gemini": return 1120;                                  // fixed per image at the default media resolution
    default: return Math.ceil(w / 28) * Math.ceil(h / 28);
  }
}

const PROMPT_TOKENS = 600;     // system + user text + schema
const OUTPUT_TOKENS = 500;     // typical answer

function priceFor(kind: ProviderKind, model: string): Price | null {
  const table = (PRICES as Record<string, Record<string, Price>>)[kind];
  if (!table) return null;
  const key = Object.keys(table).filter((k) => model.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return key ? table[key] : null;
}

/** Estimated USD for one page of w x h px, or null when the model's price isn't known. */
export function estimatePage(kind: ProviderKind, model: string, w = 1100, h = 1500): number | null {
  const p = priceFor(kind, model);
  if (!p) return null;
  return ((imageTokens(kind, w, h) + PROMPT_TOKENS) * p.inPerM + OUTPUT_TOKENS * p.outPerM) / 1e6;
}

/** USD for measured usage, or null when the model's price isn't known. */
export function costOf(kind: ProviderKind, model: string, inputTokens: number | null, outputTokens: number | null): number | null {
  const p = priceFor(kind, model);
  if (!p || inputTokens === null) return null;
  return (inputTokens * p.inPerM + (outputTokens ?? 0) * p.outPerM) / 1e6;
}
