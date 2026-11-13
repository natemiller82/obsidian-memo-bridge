// Http over Obsidian's requestUrl (not subject to CORS; works with every provider).
import { requestUrl } from "obsidian";
import { Unreachable, type Http } from "./http";

export const obsidianHttp: Http = async (req) => {
  let timer: number | undefined;
  try {
    const call = requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false,
      contentType: req.headers["content-type"] });
    const timeout = new Promise<never>((_, rej) => {
      timer = window.setTimeout(() => rej(new Unreachable(`no answer within ${Math.round((req.timeoutMs ?? 180_000) / 1000)} s`)), req.timeoutMs ?? 180_000);
    });
    const r = await Promise.race([call, timeout]);
    let text = "";
    try { text = r.text; } catch { text = ""; }
    return { status: r.status, headers: r.headers ?? {}, text };
  } catch (e) {
    if (e instanceof Unreachable) throw e;
    throw new Unreachable(String((e as Error)?.message ?? e));
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
};
