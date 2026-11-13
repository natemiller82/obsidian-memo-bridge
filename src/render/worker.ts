// Render worker: runs @twango/sdocx off Obsidian's UI thread so a slow or stuck note
// can be timed out (the worker is terminated) without freezing the app.
import init, * as sdocx from "@twango/sdocx";
import { FormatError, renderDocument } from "./core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const self: { onmessage: ((ev: MessageEvent) => void) | null; postMessage(msg: unknown): void };
let ready: Promise<unknown> | null = null;

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  if (m.type === "init") {
    ready = init({ module_or_path: m.wasm });
    try {
      await ready;
      self.postMessage({ type: "ready" });
    } catch (e) {
      self.postMessage({ type: "init-error", error: String((e as Error)?.message ?? e) });
    }
    return;
  }
  if (m.type === "render") {
    try {
      await ready;
      const result = renderDocument(sdocx, m.bytes);
      self.postMessage({ type: "result", id: m.id, ok: true, result });
    } catch (e) {
      self.postMessage({
        type: "result", id: m.id, ok: false, format: e instanceof FormatError,
        error: String((e as Error)?.message ?? e),
      });
    }
  }
};
