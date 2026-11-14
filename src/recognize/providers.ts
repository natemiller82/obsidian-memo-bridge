// Recognition providers: one interface, five adapters over raw HTTPS + JSON (no SDKs).
// API shapes checked against each provider's docs on 2026-11-11:
//   Ollama      POST {url}/api/chat, `format` = JSON schema; /api/tags + /api/show (capabilities)
//   Anthropic   POST /v1/messages, output_config.format json_schema; GET /v1/models (capabilities.image_input)
//   OpenAI      POST /v1/responses, text.format json_schema (strict); GET /v1/models (no vision flag)
//   Gemini      POST /v1beta/models/{m}:generateContent, responseJsonSchema; GET /v1beta/models
//   Compatible  POST {base}/chat/completions, response_format json_schema; GET {base}/models
import { header, scrub, Unreachable, type Http, type HttpResponse } from "./http";
import { cleanOcr, InvalidOutput, parseResult, RESULT_SCHEMA, type PageResult, type Prompt } from "./prompt";

export type ProviderKind = "ollama" | "anthropic" | "openai" | "gemini" | "openai-compatible";

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  ollama: "Ollama (local)",
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  gemini: "Google Gemini",
  "openai-compatible": "OpenAI-compatible endpoint",
};

export const DEFAULT_URLS: Partial<Record<ProviderKind, string>> = {
  ollama: "http://localhost:11434",
  "openai-compatible": "http://localhost:1234/v1",
};

export const ANTHROPIC_VERSION = "2026-10-21";

export interface ProviderConfig {
  kind: ProviderKind;
  model: string;
  baseUrl?: string;
  apiKey?: string | null;
  timeoutMs?: number;
}

export interface ModelInfo { id: string; vision: boolean | null; note?: string }

export interface Usage { inputTokens: number | null; outputTokens: number | null }

export interface PageAnswer { result: PageResult; usage: Usage; raw: string; ms: number }

export interface TextAnswer { text: string; usage: Usage; ms: number }

/** OCR-only models (e.g. glm-ocr) answer a plain "Text Recognition:" task, not the JSON prompt. */
export const isOcrOnly = (model: string) => /ocr/i.test(model);

/**
 * Why a request failed, and what the queue should do about it:
 *  retry   - transient (rate limit, overload): try again after retryAfterMs / backoff
 *  pause   - provider unreachable: pause the queue quietly
 *  stop    - needs the user (bad key, quota or spend cap, unknown model): stop and say so
 *  fail    - this page/request is bad (invalid output, refusal, 400): count an attempt
 */
export type FailureAction = "retry" | "pause" | "stop" | "fail";

export class ProviderError extends Error {
  constructor(message: string, readonly action: FailureAction, readonly status: number | null = null,
              readonly retryAfterMs: number | null = null) { super(message); }
}

const QUOTA_CODES = /insufficient_quota|credit_balance|enforced_spend_limit|spend_limit|billing|quota_exceeded|budget/i;

function retryAfter(res: HttpResponse): number | null {
  const v = header(res.headers, "retry-after");
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : null;
}

/** Map an HTTP error response to a ProviderError (never includes request headers). */
export function classify(res: HttpResponse, secret?: string | null): ProviderError {
  const body = scrub(res.text.slice(0, 400), secret).replace(/\s+/g, " ");
  const msg = `HTTP ${res.status}: ${body}`;
  const s = res.status;
  if (s === 401 || s === 403) return new ProviderError(`${msg} (check the API key)`, "stop", s);
  if (s === 404) return new ProviderError(`${msg} (unknown model or URL)`, "stop", s);
  if (QUOTA_CODES.test(res.text) && !(s === 402 && retryAfter(res) !== null)) return new ProviderError(`${msg} (quota or spending limit)`, "stop", s);
  if (s === 429 || s === 402) return new ProviderError(msg, "retry", s, retryAfter(res));
  if (s === 408 || s === 409 || s === 425 || s >= 500) return new ProviderError(msg, "retry", s, retryAfter(res));
  return new ProviderError(msg, "fail", s);
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
const trimSlash = (u: string) => u.replace(/\/+$/, "");
const json = (o: unknown) => JSON.stringify(o);

export interface Provider {
  readonly kind: ProviderKind;
  /** True when page images leave this machine. */
  readonly hosted: boolean;
  listModels(): Promise<ModelInfo[]>;
  /** One page image (PNG). Throws ProviderError. */
  recognize(png: Uint8Array, prompt: Prompt): Promise<PageAnswer>;
  /** OCR-only models (Ollama): the page's text only, fences stripped. Throws ProviderError. */
  transcribe?(png: Uint8Array): Promise<TextAnswer>;
}

export function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return h === "localhost" || h === "::1" || /^127\./.test(h);
  } catch { return false; }
}

export function makeProvider(cfg: ProviderConfig, http: Http): Provider {
  switch (cfg.kind) {
    case "ollama": return new OllamaProvider(cfg, http);
    case "anthropic": return new AnthropicProvider(cfg, http);
    case "openai": return new OpenAIProvider(cfg, http);
    case "gemini": return new GeminiProvider(cfg, http);
    case "openai-compatible": return new CompatibleProvider(cfg, http);
  }
}

abstract class Base implements Provider {
  abstract readonly kind: ProviderKind;
  abstract readonly hosted: boolean;
  constructor(protected cfg: ProviderConfig, protected http: Http) {}
  abstract listModels(): Promise<ModelInfo[]>;
  abstract recognize(png: Uint8Array, prompt: Prompt): Promise<PageAnswer>;

  protected requireKey(): string {
    if (!this.cfg.apiKey) throw new ProviderError(`no API key set for ${PROVIDER_LABELS[this.cfg.kind]}`, "stop");
    return this.cfg.apiKey;
  }

  protected requireModel(): string {
    if (!this.cfg.model.trim()) throw new ProviderError("no model chosen", "stop");
    return this.cfg.model.trim();
  }

  protected async send(url: string, method: "GET" | "POST", headers: Record<string, string>, body?: unknown): Promise<unknown> {
    let res: HttpResponse;
    try {
      res = await this.http({ url, method, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body === undefined ? undefined : json(body), timeoutMs: this.cfg.timeoutMs ?? 180_000 });
    } catch (e) {
      if (e instanceof Unreachable) throw new ProviderError(`can't reach ${new URL(url).host}: ${scrub(e.message, this.cfg.apiKey)}`, "pause");
      throw e;
    }
    if (res.status < 200 || res.status >= 300) throw classify(res, this.cfg.apiKey);
    let parsed: unknown;
    try { parsed = JSON.parse(res.text); } catch { throw new ProviderError(`response is not JSON: ${scrub(res.text.slice(0, 120), this.cfg.apiKey)}`, "fail", res.status); }
    // OpenRouter (and some proxies) report errors inside a 200 response.
    const err = (parsed as { error?: { code?: number | string; message?: string } })?.error;
    if (err && typeof err === "object") {
      const code = typeof err.code === "number" ? err.code : 500;
      throw classify({ status: code, headers: res.headers, text: json(err) }, this.cfg.apiKey);
    }
    return parsed;
  }

  protected answer(text: string, usage: Usage, t0: number): PageAnswer {
    try { return { result: parseResult(text), usage, raw: text, ms: Date.now() - t0 }; } catch (e) {
      if (e instanceof InvalidOutput) throw new ProviderError(`invalid answer: ${e.message}`, "fail");
      throw e;
    }
  }
}

// Response shapes, as far as this module reads them. Everything is optional: a provider's answer
// is untrusted input, and anything typed unknown is checked before use.
interface OllamaShow { capabilities?: unknown }
interface OllamaTags { models?: { name: string; details?: { parameter_size?: string } }[] }
interface OllamaChat { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number }
interface AnthropicModels {
  data?: { id: string; display_name?: string; capabilities?: { image_input?: { supported?: boolean } } }[];
  has_more?: boolean; last_id?: string;
}
interface AnthropicMessage {
  stop_reason?: string; content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}
interface IdList { data?: { id: string }[] }
interface OpenAIResponse {
  status?: string; incomplete_details?: { reason?: string };
  output?: { type: string; content?: { type: string; text?: string }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}
interface GeminiModels { models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[]; nextPageToken?: string }
interface GeminiGenerate {
  promptFeedback?: { blockReason?: string };
  candidates?: { finishReason?: string; content?: { parts?: { text?: unknown; thought?: boolean }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}
interface CompatibleModels { data?: { id: string; architecture?: { input_modalities?: unknown }; capabilities?: { vision?: unknown } }[] }
interface CompatibleChat {
  choices?: { message?: { refusal?: unknown; content?: unknown } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** The text of a content part, if it has one. */
const partText = (c: unknown): string =>
  c !== null && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "";

class OllamaProvider extends Base {
  readonly kind = "ollama" as const;
  private caps = new Map<string, string[]>();
  get hosted() { return !isLoopback(this.url); }
  private get url() { return trimSlash(this.cfg.baseUrl || DEFAULT_URLS.ollama!); }

  private async capabilities(model: string): Promise<string[]> {
    if (!this.caps.has(model)) {
      const r = (await this.send(`${this.url}/api/show`, "POST", {}, { model })) as OllamaShow;
      const caps: unknown[] = Array.isArray(r.capabilities) ? r.capabilities : [];
      this.caps.set(model, caps.filter((c): c is string => typeof c === "string"));
    }
    return this.caps.get(model)!;
  }

  async listModels(): Promise<ModelInfo[]> {
    const r = (await this.send(`${this.url}/api/tags`, "GET", {})) as OllamaTags;
    const out: ModelInfo[] = [];
    for (const m of r.models ?? []) {
      const caps = await this.capabilities(m.name).catch(() => [] as string[]);
      // Thinking models (e.g. plain qwen3-vl tags) keep thinking even with think:false and can run
      // out of tokens before answering; the -instruct variants answer directly.
      out.push({ id: m.name, vision: caps.includes("vision"),
        note: caps.includes("thinking") ? "thinks before answering: slow, may not finish; prefer an -instruct variant" : m.details?.parameter_size });
    }
    return out;
  }

  async recognize(png: Uint8Array, prompt: Prompt): Promise<PageAnswer> {
    const model = this.requireModel(), t0 = Date.now();
    const caps = await this.capabilities(model);
    if (caps.length && !caps.includes("vision")) throw new ProviderError(`${model} can't read images (no "vision" capability)`, "stop");
    const r = (await this.send(`${this.url}/api/chat`, "POST", {}, {
      model, stream: false, format: RESULT_SCHEMA, options: { temperature: 0, num_predict: 4096 },   // bounded like max_tokens elsewhere
      ...(caps.includes("thinking") ? { think: false } : {}),
      messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user, images: [b64(png)] }],
    })) as OllamaChat;
    return this.answer(String(r.message?.content ?? ""), { inputTokens: r.prompt_eval_count ?? null, outputTokens: r.eval_count ?? null }, t0);
  }

  async transcribe(png: Uint8Array): Promise<TextAnswer> {
    const model = this.requireModel(), t0 = Date.now();
    const r = (await this.send(`${this.url}/api/chat`, "POST", {}, {
      model, stream: false, options: { temperature: 0, num_predict: 4096 },
      messages: [{ role: "user", content: "Text Recognition:", images: [b64(png)] }],   // the OCR models' own task prompt
    })) as OllamaChat;
    return { text: cleanOcr(String(r.message?.content ?? "")), usage: { inputTokens: r.prompt_eval_count ?? null, outputTokens: r.eval_count ?? null }, ms: Date.now() - t0 };
  }
}

class AnthropicProvider extends Base {
  readonly kind = "anthropic" as const;
  readonly hosted = true;
  private get url() { return trimSlash(this.cfg.baseUrl || "https://api.anthropic.com"); }
  private headers() { return { "x-api-key": this.requireKey(), "anthropic-version": ANTHROPIC_VERSION }; }

  async listModels(): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const r = (await this.send(`${this.url}/v1/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ""}`, "GET", this.headers())) as AnthropicModels;
      for (const m of r.data ?? []) out.push({ id: m.id, vision: m.capabilities?.image_input?.supported ?? null, note: m.display_name });
      if (!r.has_more || !r.last_id) break;
      after = r.last_id;
    }
    return out;
  }

  async recognize(png: Uint8Array, prompt: Prompt): Promise<PageAnswer> {
    const model = this.requireModel(), t0 = Date.now();
    const r = (await this.send(`${this.url}/v1/messages`, "POST", this.headers(), {
      model, max_tokens: 4096, system: prompt.system,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: b64(png) } },
        { type: "text", text: prompt.user },
      ] }],
      output_config: { format: { type: "json_schema", schema: RESULT_SCHEMA } },
    })) as AnthropicMessage;
    if (r.stop_reason === "refusal") throw new ProviderError("the model refused this page", "fail");
    if (r.stop_reason === "max_tokens") throw new ProviderError("answer cut off (max_tokens)", "fail");
    const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    return this.answer(text, { inputTokens: r.usage?.input_tokens ?? null, outputTokens: r.usage?.output_tokens ?? null }, t0);
  }
}

class OpenAIProvider extends Base {
  readonly kind = "openai" as const;
  readonly hosted = true;
  private get url() { return trimSlash(this.cfg.baseUrl || "https://api.openai.com/v1"); }
  private headers() { return { authorization: `Bearer ${this.requireKey()}` }; }

  async listModels(): Promise<ModelInfo[]> {
    const r = (await this.send(`${this.url}/models`, "GET", this.headers())) as IdList;
    // The list has no capability field; OpenAI says all its latest models accept images.
    return (r.data ?? []).map((m) => ({ id: m.id, vision: null }));
  }

  async recognize(png: Uint8Array, prompt: Prompt): Promise<PageAnswer> {
    const model = this.requireModel(), t0 = Date.now();
    const r = (await this.send(`${this.url}/responses`, "POST", this.headers(), {
      model, instructions: prompt.system, max_output_tokens: 4096,
      input: [{ role: "user", content: [
        { type: "input_text", text: prompt.user },
        { type: "input_image", image_url: `data:image/png;base64,${b64(png)}`, detail: "high" },
      ] }],
      text: { format: { type: "json_schema", name: "page_transcription", strict: true, schema: RESULT_SCHEMA } },
    })) as OpenAIResponse;
    if (r.status === "incomplete") throw new ProviderError(`answer incomplete: ${r.incomplete_details?.reason ?? "unknown"}`, "fail");
    let text = "";
    for (const o of r.output ?? []) {
      if (o.type !== "message") continue;
      for (const c of o.content ?? []) {
        if (c.type === "refusal") throw new ProviderError("the model refused this page", "fail");
        if (c.type === "output_text") text += c.text ?? "";
      }
    }
    return this.answer(text, { inputTokens: r.usage?.input_tokens ?? null, outputTokens: r.usage?.output_tokens ?? null }, t0);
  }
}

class GeminiProvider extends Base {
  readonly kind = "gemini" as const;
  readonly hosted = true;
  private get url() { return trimSlash(this.cfg.baseUrl || "https://generativelanguage.googleapis.com/v1beta"); }
  private headers() { return { "x-goog-api-key": this.requireKey() }; }

  async listModels(): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    let token = "";
    for (let page = 0; page < 10; page++) {
      const r = (await this.send(`${this.url}/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`, "GET", this.headers())) as GeminiModels;
      for (const m of r.models ?? [])
        if ((m.supportedGenerationMethods ?? []).includes("generateContent"))
          out.push({ id: m.name.replace(/^models\//, ""), vision: null, note: m.displayName });
      if (!r.nextPageToken) break;
      token = r.nextPageToken;
    }
    return out;
  }

  async recognize(png: Uint8Array, prompt: Prompt): Promise<PageAnswer> {
    const model = this.requireModel().replace(/^models\//, ""), t0 = Date.now();
    const r = (await this.send(`${this.url}/models/${encodeURIComponent(model)}:generateContent`, "POST", this.headers(), {
      systemInstruction: { parts: [{ text: prompt.system }] },
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: b64(png) } }, { text: prompt.user }] }],
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: RESULT_SCHEMA, temperature: 0 },
    })) as GeminiGenerate;
    if (r.promptFeedback?.blockReason) throw new ProviderError(`blocked: ${r.promptFeedback.blockReason}`, "fail");
    const c = r.candidates?.[0];
    if (!c) throw new ProviderError("no answer", "fail");
    if (c.finishReason && !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(c.finishReason))
      throw new ProviderError(`answer stopped: ${c.finishReason}`, "fail");
    const text = (c.content?.parts ?? []).filter((p) => !p.thought).map(partText).join("");
    const u = r.usageMetadata ?? {};
    return this.answer(text, { inputTokens: u.promptTokenCount ?? null, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) || null }, t0);
  }
}

class CompatibleProvider extends Base {
  readonly kind = "openai-compatible" as const;
  private noSchema = false;          // server rejected response_format: fall back to prompt-only JSON
  get hosted() { return !isLoopback(this.url); }
  private get url() { return trimSlash(this.cfg.baseUrl || DEFAULT_URLS["openai-compatible"]!); }
  private headers(): Record<string, string> { return this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}; }

  async listModels(): Promise<ModelInfo[]> {
    const r = (await this.send(`${this.url}/models`, "GET", this.headers())) as CompatibleModels;
    return (r.data ?? []).map((m) => {
      const mods = m.architecture?.input_modalities;                    // OpenRouter
      const v = m.capabilities?.vision;
      const vision = Array.isArray(mods) ? (mods as unknown[]).includes("image") : typeof v === "boolean" ? v : null;
      return { id: m.id, vision };
    });
  }

  async recognize(png: Uint8Array, prompt: Prompt): Promise<PageAnswer> {
    const model = this.requireModel(), t0 = Date.now();
    const body = (schema: boolean) => ({
      model, temperature: 0,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: [{ type: "text", text: prompt.user }, { type: "image_url", image_url: { url: `data:image/png;base64,${b64(png)}` } }] },
      ],
      ...(schema ? { response_format: { type: "json_schema", json_schema: { name: "page_transcription", strict: true, schema: RESULT_SCHEMA } } } : {}),
    });
    let r: CompatibleChat;
    try {
      r = (await this.send(`${this.url}/chat/completions`, "POST", this.headers(), body(!this.noSchema))) as CompatibleChat;
    } catch (e) {
      if (!(e instanceof ProviderError) || e.status !== 400 || this.noSchema || !/response_format|json_schema|structured/i.test(e.message)) throw e;
      this.noSchema = true;
      r = (await this.send(`${this.url}/chat/completions`, "POST", this.headers(), body(false))) as CompatibleChat;
    }
    const msg = r.choices?.[0]?.message;
    if (msg?.refusal) throw new ProviderError("the model refused this page", "fail");
    const content = msg?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? (content as unknown[]).map(partText).join("") : "";
    return this.answer(text, { inputTokens: r.usage?.prompt_tokens ?? null, outputTokens: r.usage?.completion_tokens ?? null }, t0);
  }
}
