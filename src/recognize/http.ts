// HTTP for recognition providers, injectable: Obsidian's requestUrl in the plugin, fetch in
// development tools, recorded responses in tests. Secrets never leave this layer in readable form:
// anything that describes a request (logs, errors, recordings) goes through redact()/scrub().

export interface HttpRequest { url: string; method: "GET" | "POST"; headers: Record<string, string>; body?: string; timeoutMs?: number }
export interface HttpResponse { status: number; headers: Record<string, string>; text: string }
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

/** Network-level failure (no HTTP response): connection refused, DNS, timeout. */
export class Unreachable extends Error {}

const SECRET_HEADERS = new Set(["authorization", "x-api-key", "x-goog-api-key", "api-key"]);

/** Copy of headers with every credential replaced by "[redacted]". */
export function redact(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = SECRET_HEADERS.has(k.toLowerCase()) ? "[redacted]" : v;
  return out;
}

/** Remove a secret from any text (error messages, response excerpts) before it is shown or stored. */
export function scrub(text: string, ...secrets: (string | null | undefined)[]): string {
  let t = text;
  for (const s of secrets) if (s && s.length >= 8) t = t.split(s).join("[redacted]");
  return t.replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/g, "$1[redacted]");
}

export function header(h: Record<string, string>, name: string): string | undefined {
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : h[k];
}
