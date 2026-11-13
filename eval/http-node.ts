// fetch-based Http for the eval harness (Node 22+). Not part of the plugin, which uses Obsidian's requestUrl.
import { Unreachable, type Http } from "../src/recognize/http";

export const fetchHttp: Http = async (req) => {
  let res: Response;
  try {
    res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(req.timeoutMs ?? 180_000) });
  } catch (e) {
    throw new Unreachable(String((e as Error)?.message ?? e));
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return { status: res.status, headers, text: await res.text() };
};
