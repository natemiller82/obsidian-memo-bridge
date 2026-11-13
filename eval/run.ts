// Run one provider/model/prompt variant over the evaluation set; answers go to
// local/eval/runs/<run>/<item>/p<k>.json. Prints status and timing only, never note text.
//
//   npm run eval -- run --provider ollama --model qwen3-vl:8b-instruct [--hint] [--mode json|ocr] [--missing] [--url http://localhost:11434]
//     [--only <item prefix>] [--missing: only pages without an answer yet] [--timeout <s per page, 240>]
//     [--images <variant>: the images from "npm run eval -- images --variant <name>"]
// One run at a time (runs/.lock); the model is unloaded when the batch ends or is stopped.
//
// --mode ocr: Ollama only, for OCR-only models (glm-ocr): the model's own "Text Recognition:"
//   task; the answer is plain text, used as the transcription (no description).
// Hosted providers read their key from MB_ANTHROPIC_KEY / MB_OPENAI_KEY / MB_GEMINI_KEY and need
// --allow-hosted; without that flag the harness refuses to send anything off this machine.
import * as fs from "node:fs";
import * as path from "node:path";
import { scrub } from "../src/recognize/http";
import { fetchHttp } from "./http-node";
import { buildPrompt, parseResult, type PageResult } from "../src/recognize/prompt";
import { isLoopback, makeProvider, ProviderError, type ProviderKind } from "../src/recognize/providers";
import { arg, EVAL_DIR, evalHint, flag, readSet, RUNS_DIR } from "./common";

export interface PageRun {
  ok: boolean;
  result?: PageResult;
  error?: string;
  /** "schema": answer didn't follow the output rules; "provider": HTTP/network error. */
  failure?: "schema" | "provider" | "timeout";
  ms: number;
  usage?: { inputTokens: number | null; outputTokens: number | null };
}

const KEY_VARS: Partial<Record<ProviderKind, string>> = { anthropic: "MB_ANTHROPIC_KEY", openai: "MB_OPENAI_KEY", gemini: "MB_GEMINI_KEY" };

export function runId(model: string, mode: string, hint: boolean, images?: string) {
  return `${model.replace(/[^a-zA-Z0-9.-]+/g, "_")}-${mode}-${hint ? "hint" : "nohint"}${images ? `-img_${images}` : ""}`;
}



async function main() {
  const kind = (arg("provider") ?? "ollama") as ProviderKind;
  const model = arg("model");
  const mode = arg("mode", "json")!;
  const hint = flag("hint");
  const url = arg("url");
  if (!model) throw new Error("--model is required");

  // Nothing leaves this machine unless explicitly allowed.
  const hostedKind = kind === "anthropic" || kind === "openai" || kind === "gemini";
  const local = kind === "ollama" || kind === "openai-compatible" ? isLoopback(url ?? (kind === "ollama" ? "http://localhost:11434" : "http://localhost:1234/v1")) : false;
  if ((hostedKind || !local) && !flag("allow-hosted"))
    throw new Error(`${kind} would send page images off this machine; refusing without --allow-hosted`);
  let apiKey: string | null = null;
  if (hostedKind) {
    const v = KEY_VARS[kind]!;
    apiKey = process.env[v] ?? null;
    if (!apiKey) throw new Error(`${v} is not set; skipping ${kind}`);
  }

  const set = readSet();
  const images = arg("images");
  if (images && !/^[a-z0-9-]+$/.test(images)) throw new Error("--images <variant name>");
  const id = runId(model, mode, hint, images);
  const out = path.join(RUNS_DIR, id);
  fs.mkdirSync(out, { recursive: true });
  const pageTimeoutMs = Number(arg("timeout", "240")) * 1000;
  const provider = makeProvider({ kind, model, baseUrl: url, apiKey, timeoutMs: pageTimeoutMs }, fetchHttp);
  const ollamaUrl = (url ?? "http://localhost:11434").replace(/\/+$/, "");
  /** Ollama keeps generating after the client gives up; unloading the model really stops it. */
  const unload = async () => {
    if (kind !== "ollama") return;
    await fetchHttp({ url: `${ollamaUrl}/api/generate`, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, keep_alive: 0 }), timeoutMs: 120_000 }).catch(() => undefined);
  };
  // One batch at a time: two runs on one GPU slow each other down and skew the timings.
  const lock = path.join(RUNS_DIR, ".lock");
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, "utf8"));
    if (pid && pid !== process.pid && alive(pid)) throw new Error(`another eval run is active (pid ${pid}); stop it first`);
  }
  fs.writeFileSync(lock, String(process.pid));
  let stopping = false;
  const stop = async (why: string, code: number) => {
    if (stopping) return;
    stopping = true;
    console.error(`stopping: ${why}`);
    await unload();
    try { if (Number(fs.readFileSync(lock, "utf8")) === process.pid) fs.rmSync(lock); } catch { /* gone */ }
    process.exit(code);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const) process.on(sig, () => void stop(sig, 130));
  // If whatever launched this batch (npm, a shell) is killed, don't carry on as an orphan.
  const parent = process.ppid;
  const watchdog = setInterval(() => { if (!alive(parent)) void stop(`parent process ${parent} is gone`, 1); }, 3000);
  watchdog.unref();

  // A hard kill (TerminateProcess) skips the handlers above, and Ollama keeps generating for the
  // dead client. Unloading this model first stops any such leftover before the timings start.
  await unload();

  const prompt = buildPrompt(hint ? evalHint() : "");
  fs.writeFileSync(path.join(out, "run.json"), JSON.stringify({ kind, model, mode, hint, images: images ?? null, promptId: prompt.id, promptHash: prompt.hash, at: new Date().toISOString() }, null, 1));
  console.log(`run ${id} (prompt ${prompt.id}/${prompt.hash.slice(0, 8)})`);

  const only = arg("only");
  outer: for (const item of set) for (const [i, p] of item.pages.entries()) {
    if (only && !item.key.startsWith(only)) continue;
    const outFile = path.join(out, item.key, `p${i + 1}.json`);
    if (flag("missing") && fs.existsSync(outFile) && JSON.parse(fs.readFileSync(outFile, "utf8")).ok) continue;
    const file = images ? path.join(EVAL_DIR, "variants", images, item.key, p.file) : path.join(EVAL_DIR, item.key, p.file);
    if (!fs.existsSync(file)) { console.log(`${item.key} p${i + 1}: no image in variant ${images}; skipped`); continue; }
    const png = new Uint8Array(fs.readFileSync(file));
    let r: PageRun;
    const t0 = Date.now();
    try {
      if (mode === "ocr") {
        // the plugin's own OCR call (Ollama "Text Recognition:", fences stripped)
        if (!provider.transcribe) throw new Error(`--mode ocr needs Ollama`);
        const t = await provider.transcribe(png);
        r = { ok: true, ms: t.ms, usage: t.usage, result: { has_text: !!t.text, transcription: t.text, drawing: "", alt_text: "", language: "", languages: [], unreadable: (t.text.match(/\[\?\]/g) ?? []).length } };
      }
      else {
        const a = await provider.recognize(png, prompt);
        r = { ok: true, result: a.result, ms: a.ms, usage: a.usage };
      }
    } catch (e) {
      const msg = scrub(String((e as Error).message ?? e), apiKey);
      const schema = e instanceof ProviderError && /invalid answer/.test(e.message);
      const timedOut = Date.now() - t0 >= pageTimeoutMs - 1000;
      r = { ok: false, failure: schema ? "schema" : timedOut ? "timeout" : "provider", error: msg, ms: Date.now() - t0 };
      if (timedOut) await unload();
      // quota, spending limit or bad key: every further page would fail the same way
      if (e instanceof ProviderError && e.action === "stop") {
        fs.mkdirSync(path.join(out, item.key), { recursive: true });
        fs.writeFileSync(path.join(out, item.key, `p${i + 1}.json`), JSON.stringify(r, null, 1));
        console.log(`${item.key} p${i + 1}: FAILED (${r.failure}); stopping the batch: ${e.message.slice(0, 160)}`);
        break outer;
      }
    }
    fs.mkdirSync(path.join(out, item.key), { recursive: true });
    fs.writeFileSync(path.join(out, item.key, `p${i + 1}.json`), JSON.stringify(r, null, 1));
    console.log(`${item.key} p${i + 1}: ${r.ok ? "ok" : `FAILED (${r.failure})`} ${(r.ms / 1000).toFixed(1)} s` +
      ` (${r.usage?.outputTokens ?? "?"} tokens out)`);
  }
  // leave the GPU free for the next run
  await unload();
  try { fs.rmSync(lock); } catch { /* gone */ }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

// keep parseResult reachable for re-scoring raw answers later
void parseResult;
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
