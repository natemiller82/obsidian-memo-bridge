// Recognition providers against recorded/synthetic responses: no network, no keys.
import { describe, expect, it } from "vitest";
import { redact, scrub, Unreachable, type Http, type HttpRequest, type HttpResponse } from "../src/recognize/http";
import { buildPrompt, parseResult, PROMPT_ID, withTranscription } from "../src/recognize/prompt";
import { classify, isLoopback, isOcrOnly, makeProvider, ProviderError, type ProviderConfig } from "../src/recognize/providers";
import { estimatePage } from "../src/recognize/pricing";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const KEY = "FAKE".repeat(6);                 // synthetic, not a real key
const GOOD = { has_text: true, transcription: "buy milk\ncall [?] tomorrow", drawing: "", alt_text: "A short to-do list.", language: "en", languages: ["en"], unreadable: 0 };

/** Fake Http: records requests (headers redacted, as anything recorded must be) and replays canned responses. */
function fake(...responses: (Partial<HttpResponse> | Error)[]) {
  const seen: HttpRequest[] = [];
  const http: Http = async (req) => {
    seen.push({ ...req });
    const r = responses.shift();
    if (!r) throw new Error("no more responses");
    if (r instanceof Error) throw r;
    return { status: 200, headers: {}, text: "", ...r };
  };
  return { http, seen };
}
const ok = (o: unknown): Partial<HttpResponse> => ({ status: 200, text: JSON.stringify(o) });
const prompt = buildPrompt();

describe("prompt and output", () => {
  it("prompt id and hash; the context hint changes the hash", () => {
    const a = buildPrompt(), b = buildPrompt("Lecture notes in organic chemistry; expect chemical names.");
    expect(a.id).toBe(PROMPT_ID);
    expect(a.hash).not.toBe(b.hash);
    expect(b.user).toContain("organic chemistry");
    expect(buildPrompt("  ").hash).toBe(a.hash);
  });
  it("parses, counts [?] itself, and never accepts invented or missing text", () => {
    const r = parseResult("```json\n" + JSON.stringify(GOOD) + "\n```");
    expect(r.unreadable).toBe(1);
    expect(r.transcription).toBe("buy milk\ncall [?] tomorrow");
    expect(() => parseResult(JSON.stringify({ ...GOOD, has_text: false }))).toThrow(/transcription isn't empty/);
    expect(() => parseResult(JSON.stringify({ ...GOOD, transcription: "" }))).toThrow(/empty/);
    expect(() => parseResult("not json")).toThrow(/not JSON/);
    const blank = parseResult(JSON.stringify({ ...GOOD, has_text: false, transcription: "", language: "en", languages: ["en"] }));
    expect(blank).toMatchObject({ has_text: false, transcription: "", language: "", languages: [] });
  });
});

describe("secrets", () => {
  it("redacts credential headers and scrubs keys from text", () => {
    expect(redact({ Authorization: `Bearer ${KEY}`, "x-api-key": KEY, "X-Goog-Api-Key": KEY, accept: "x" }))
      .toEqual({ Authorization: "[redacted]", "x-api-key": "[redacted]", "X-Goog-Api-Key": "[redacted]", accept: "x" });
    expect(scrub(`bad key ${KEY} and Bearer abcdefghijklmnop`, KEY)).toBe("bad key [redacted] and Bearer [redacted]");
  });
  it("error messages never contain the key, even when the server echoes it", async () => {
    const { http } = fake({ status: 401, text: JSON.stringify({ error: { message: `Invalid key ${KEY}` } }) });
    const p = makeProvider({ kind: "openai", model: "gpt-6-luna", apiKey: KEY }, http);
    const e = await p.recognize(PNG, prompt).then(() => null as unknown as ProviderError, (x) => x as ProviderError);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).not.toContain(KEY);
    expect(e.action).toBe("stop");
  });
});

describe("error classification", () => {
  const c = (status: number, text = "", headers: Record<string, string> = {}) => classify({ status, text, headers });
  it("maps statuses to queue actions", () => {
    expect(c(429, "{}", { "retry-after": "7" })).toMatchObject({ action: "retry", retryAfterMs: 7000 });
    expect(c(429, JSON.stringify({ error: { code: "insufficient_quota" } })).action).toBe("stop");
    expect(c(429, JSON.stringify({ error: { details: { error_code: "enforced_spend_limit_reached" } } })).action).toBe("stop");
    expect(c(529, "overloaded").action).toBe("retry");
    expect(c(503).action).toBe("retry");
    expect(c(401).action).toBe("stop");
    expect(c(404).action).toBe("stop");
    expect(c(400, "bad image").action).toBe("fail");
    expect(c(402, "budget", { "retry-after": "3" }).action).toBe("retry");     // OpenRouter in-flight budget
  });
  it("unreachable -> pause", async () => {
    const { http } = fake(new Unreachable("ECONNREFUSED"));
    const e = await makeProvider({ kind: "ollama", model: "m" }, http).recognize(PNG, prompt).then(() => null as unknown as ProviderError, (x) => x as ProviderError);
    expect(e.action).toBe("pause");
  });
  it("an error inside a 200 response (OpenRouter) is still an error", async () => {
    const { http } = fake(ok({ error: { code: 429, message: "rate limited" } }));
    const e = await makeProvider({ kind: "openai-compatible", model: "m", baseUrl: "https://openrouter.ai/api/v1", apiKey: KEY }, http)
      .recognize(PNG, prompt).then(() => null as unknown as ProviderError, (x) => x as ProviderError);
    expect(e.action).toBe("retry");
  });
});

describe("adapters send the documented request shape", () => {
  const run = async (cfg: ProviderConfig, ...responses: Partial<HttpResponse>[]) => {
    const f = fake(...responses);
    const a = await makeProvider(cfg, f.http).recognize(PNG, prompt);
    return { a, seen: f.seen, body: JSON.parse(f.seen[f.seen.length - 1].body ?? "{}") };
  };

  it("Ollama: /api/show then /api/chat with images[] and format schema; think:false only if supported", async () => {
    const { a, seen, body } = await run({ kind: "ollama", model: "qwen3-vl:8b" },
      ok({ capabilities: ["completion", "vision", "thinking"] }),
      ok({ message: { content: JSON.stringify(GOOD) }, prompt_eval_count: 900, eval_count: 80 }));
    expect(seen.map((s) => s.url)).toEqual(["http://localhost:11434/api/show", "http://localhost:11434/api/chat"]);
    expect(body.messages[1].images).toEqual([Buffer.from(PNG).toString("base64")]);
    expect(body.format.required).toContain("transcription");
    expect(body.think).toBe(false);
    expect(a.usage).toEqual({ inputTokens: 900, outputTokens: 80 });
    expect(makeProvider({ kind: "ollama", model: "m" }, fake().http).hosted).toBe(false);
    expect(makeProvider({ kind: "ollama", model: "m", baseUrl: "http://gpu-box.lan:11434" }, fake().http).hosted).toBe(true);
  });

  it("Ollama OCR-only models: plain \"Text Recognition:\" task, no schema; fences stripped; no letters = no text", async () => {
    const f = fake(ok({ message: { content: "```markdown\nBuy milk\n```" }, prompt_eval_count: 300, eval_count: 6 }),
      ok({ message: { content: "```markdown\n\n```" } }));
    const p = makeProvider({ kind: "ollama", model: "glm-ocr" }, f.http);
    const a = await p.transcribe!(PNG);
    expect(a.text).toBe("Buy milk");
    expect(a.usage).toEqual({ inputTokens: 300, outputTokens: 6 });
    const body = JSON.parse(f.seen[0].body ?? "{}");
    expect(f.seen[0].url).toBe("http://localhost:11434/api/chat");
    expect(body.messages).toEqual([{ role: "user", content: "Text Recognition:", images: [Buffer.from(PNG).toString("base64")] }]);
    expect(body.format).toBeUndefined();
    expect((await p.transcribe!(PNG)).text).toBe("");
    expect(isOcrOnly("glm-ocr")).toBe(true);
    expect(isOcrOnly("qwen3-vl:8b-instruct")).toBe(false);
    expect(makeProvider({ kind: "anthropic", model: "m", apiKey: KEY }, fake().http).transcribe).toBeUndefined();
  });

  it("two-model merge: the transcription model's text wins; empty keeps the description model's", () => {
    const desc = { ...GOOD, transcription: "desc text [?]", unreadable: 1 };
    expect(withTranscription(desc, "ocr text")).toMatchObject({ has_text: true, transcription: "ocr text", unreadable: 0, alt_text: GOOD.alt_text });
    expect(withTranscription(desc, "")).toMatchObject({ transcription: "desc text [?]", unreadable: 1 });
    const none = { ...GOOD, has_text: false, transcription: "", language: "", languages: [] };
    expect(withTranscription(none, "")).toMatchObject({ has_text: false, transcription: "" });
    expect(withTranscription(none, "found it")).toMatchObject({ has_text: true, transcription: "found it" });
  });

  it("Ollama refuses a model without vision", async () => {
    const f = fake(ok({ capabilities: ["completion"] }));
    const e = await makeProvider({ kind: "ollama", model: "qwen3-coder" }, f.http).recognize(PNG, prompt).then(() => null as unknown as ProviderError, (x) => x as ProviderError);
    expect(e.action).toBe("stop");
  });

  it("Anthropic: /v1/messages, version header, image block, output_config json_schema", async () => {
    const { a, seen, body } = await run({ kind: "anthropic", model: "claude-haiku-5-5", apiKey: KEY },
      ok({ content: [{ type: "thinking", thinking: "…" }, { type: "text", text: JSON.stringify(GOOD) }], stop_reason: "end_turn", usage: { input_tokens: 2300, output_tokens: 90 } }));
    expect(seen[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen[0].headers["x-api-key"]).toBe(KEY);
    expect(seen[0].headers["anthropic-version"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.messages[0].content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } });
    expect(body.output_config.format.type).toBe("json_schema");
    expect(a.result.transcription).toContain("buy milk");
  });

  it("OpenAI: /v1/responses, input_image data URL, strict json_schema; refusal fails", async () => {
    const { body, seen } = await run({ kind: "openai", model: "gpt-6-luna", apiKey: KEY },
      ok({ status: "completed", output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: JSON.stringify(GOOD) }] }], usage: { input_tokens: 1, output_tokens: 1 } }));
    expect(seen[0].url).toBe("https://api.openai.com/v1/responses");
    expect(seen[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(body.input[0].content[1].image_url).toMatch(/^data:image\/png;base64,/);
    expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
    const f = fake(ok({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }));
    await expect(makeProvider({ kind: "openai", model: "gpt-6-luna", apiKey: KEY }, f.http).recognize(PNG, prompt)).rejects.toThrow(/refused/);
  });

  it("Gemini: generateContent with x-goog-api-key, inlineData, responseJsonSchema; thought parts skipped", async () => {
    const { seen, body, a } = await run({ kind: "gemini", model: "gemini-3.8-flash", apiKey: KEY },
      ok({ candidates: [{ finishReason: "STOP", content: { parts: [{ thought: true, text: "hmm" }, { text: JSON.stringify(GOOD) }] } }], usageMetadata: { promptTokenCount: 1700, candidatesTokenCount: 70 } }));
    expect(seen[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect(seen[0].url).not.toContain(KEY);                      // key in a header, never in the URL
    expect(seen[0].headers["x-goog-api-key"]).toBe(KEY);
    expect(body.contents[0].parts[0].inlineData.mimeType).toBe("image/png");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(a.result.alt_text).toBe(GOOD.alt_text);
  });

  it("OpenAI-compatible: chat/completions; retries once without response_format if the server rejects it", async () => {
    const f = fake({ status: 400, text: "response_format json_schema not supported" }, ok({ choices: [{ message: { content: JSON.stringify(GOOD) } }] }));
    const p = makeProvider({ kind: "openai-compatible", model: "local-vl", baseUrl: "http://127.0.0.1:1234/v1" }, f.http);
    await p.recognize(PNG, prompt);
    expect(JSON.parse(f.seen[0].body!).response_format).toBeDefined();
    expect(JSON.parse(f.seen[1].body!).response_format).toBeUndefined();
    expect(f.seen[0].headers.authorization).toBeUndefined();           // no key, no header
    expect(p.hosted).toBe(false);
  });

  it("model lists: vision flags where the API gives them", async () => {
    const o = fake(ok({ models: [{ name: "qwen3-vl:8b", details: { parameter_size: "8B" } }, { name: "qwen3-coder" }] }),
      ok({ capabilities: ["completion", "vision"] }), ok({ capabilities: ["completion"] }));
    expect(await makeProvider({ kind: "ollama", model: "" }, o.http).listModels()).toEqual([
      { id: "qwen3-vl:8b", vision: true, note: "8B" }, { id: "qwen3-coder", vision: false, note: undefined }]);
    const a = fake(ok({ data: [{ id: "claude-haiku-5-5", capabilities: { image_input: { supported: true } } }], has_more: false }));
    expect((await makeProvider({ kind: "anthropic", model: "", apiKey: KEY }, a.http).listModels())[0].vision).toBe(true);
    const g = fake(ok({ models: [{ name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] }, { name: "models/embed", supportedGenerationMethods: ["embedContent"] }] }));
    expect((await makeProvider({ kind: "gemini", model: "", apiKey: KEY }, g.http).listModels()).map((m) => m.id)).toEqual(["gemini-3.8-flash"]);
  });

  it("loopback detection and cost estimates", () => {
    expect(isLoopback("http://localhost:11434")).toBe(true);
    expect(isLoopback("http://127.0.0.1:1234/v1")).toBe(true);
    expect(isLoopback("http://[::1]:1234")).toBe(true);
    expect(isLoopback("https://openrouter.ai/api/v1")).toBe(false);
    expect(estimatePage("anthropic", "claude-haiku-5-5")).toBeGreaterThan(0);
    expect(estimatePage("anthropic", "claude-haiku-5-5")!).toBeLessThan(0.002);
    expect(estimatePage("openai", "some-future-model")).toBeNull();
  });
});

describe("Ollama model notes", () => {
  it("flags thinking models (they can run out of tokens before answering)", async () => {
    const o = fake(ok({ models: [{ name: "qwen3-vl:8b" }, { name: "qwen3-vl:30b-a3b-instruct" }] }),
      ok({ capabilities: ["completion", "vision", "thinking"] }), ok({ capabilities: ["completion", "vision"] }));
    const [a, b] = await makeProvider({ kind: "ollama", model: "" }, o.http).listModels();
    expect(a.note).toMatch(/instruct/);
    expect(b.note ?? "").not.toMatch(/thinks/);
  });
});
