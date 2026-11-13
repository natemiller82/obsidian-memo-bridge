import type * as Sdocx from "@twango/sdocx";
import { FormatError, renderDocument, type DocRender } from "./core";
import type { Logger } from "../log";

export { FormatError };

/** Rendering infrastructure failed (not the note's fault): write nothing, retry later. */
export class RendererUnavailable extends Error {}

/** The note took too long to render; treated as a failure of that note version. */
export class RenderTimeout extends Error {}

export interface Renderer {
  /** Load the WASM module now (instead of on the first render). */
  warmUp(): Promise<void>;
  render(bytes: Uint8Array, timeoutMs: number): Promise<DocRender>;
  dispose(): void;
}

/** Runs sdocx in the calling thread (tests; fallback if workers are unavailable). */
export class InlineRenderer implements Renderer {
  private mod: Promise<typeof Sdocx> | null = null;
  constructor(private wasm: () => Uint8Array | Promise<Uint8Array>) {}

  private load(): Promise<typeof Sdocx> {
    this.mod ??= (async () => {
      const m = await import("@twango/sdocx");
      await m.default({ module_or_path: await this.wasm() });
      return m;
    })().catch((e) => {
      this.mod = null;
      throw new RendererUnavailable(`could not load the sdocx renderer: ${(e as Error).message}`);
    });
    return this.mod;
  }

  async warmUp(): Promise<void> { await this.load(); }

  async render(bytes: Uint8Array): Promise<DocRender> {
    const m = await this.load();
    return renderDocument(m, bytes);
  }

  dispose(): void { this.mod = null; }
}

interface Pending { resolve: (r: DocRender) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

/** Runs sdocx in a Web Worker; a render that exceeds the timeout terminates the worker. */
export class WorkerRenderer implements Renderer {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private url: string | null = null;

  constructor(private source: string, private wasm: () => Uint8Array, private log: Logger) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.url ??= URL.createObjectURL(new Blob([this.source], { type: "text/javascript" }));
    const w = new Worker(this.url);
    this.worker = w;
    this.ready = new Promise<void>((resolve, reject) => {
      const onInit = (ev: MessageEvent) => {
        if (ev.data?.type === "ready") { w.removeEventListener("message", onInit); resolve(); }
        else if (ev.data?.type === "init-error") { w.removeEventListener("message", onInit); reject(new RendererUnavailable(ev.data.error)); }
      };
      w.addEventListener("message", onInit);
      w.addEventListener("error", (e) => {
        reject(new RendererUnavailable(`render worker failed: ${e.message}`));
        this.restart(new RendererUnavailable(`render worker crashed: ${e.message}`));
      });
    });
    w.addEventListener("message", (ev: MessageEvent) => {
      const m = ev.data;
      if (m?.type !== "result") return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result as DocRender);
      else p.reject(m.format ? new FormatError(m.error) : new Error(m.error));
    });
    const wasm = this.wasm();
    w.postMessage({ type: "init", wasm }, [wasm.buffer]);
    this.ready.catch(() => { this.ready = null; });
    return this.ready;
  }

  private restart(reason: Error) {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(reason); }
    this.pending.clear();
  }

  warmUp(): Promise<void> { return this.start(); }

  async render(bytes: Uint8Array, timeoutMs: number): Promise<DocRender> {
    await this.start();
    const id = ++this.seq;
    return new Promise<DocRender>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.log.warn(`render timed out after ${timeoutMs / 1000}s; restarting the render worker`);
        this.pending.delete(id);
        reject(new RenderTimeout(`render took longer than ${timeoutMs / 1000}s`));
        this.restart(new RendererUnavailable("render worker restarted"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const copy = bytes.slice();
      this.worker!.postMessage({ type: "render", id, bytes: copy }, [copy.buffer]);
    });
  }

  dispose(): void {
    this.restart(new RendererUnavailable("renderer disposed"));
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
}
