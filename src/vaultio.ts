// Everything the sync engine does to the vault goes through VaultIO. The Obsidian
// implementation uses the Vault API; tests use a folder on disk. There is no delete.
import * as fs from "node:fs";
import * as path from "node:path";

export interface VaultIO {
  exists(p: string): Promise<boolean>;
  read(p: string): Promise<string | null>;
  /** Create, or overwrite a file the engine has verified it owns. */
  write(p: string, text: string): Promise<void>;
  writeBinary(p: string, data: Uint8Array): Promise<void>;
  ensureFolder(p: string): Promise<void>;
  listMarkdown(): Promise<string[]>;
  /** Vault-relative stems (lower-case) of files in a folder. */
  stemsIn(folder: string): Promise<Set<string>>;
  /** Change a note's frontmatter the host's way (Obsidian: FileManager.processFrontMatter). */
  processFrontMatter(p: string, fn: (fm: Record<string, unknown>) => void): Promise<void>;
}

export const join = (...parts: string[]) => parts.filter(Boolean).join("/").replace(/\/+/g, "/");
export const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** A plain folder on disk (tests, and anything outside Obsidian). */
export class FsVault implements VaultIO {
  constructor(readonly root: string) {}
  private abs(p: string) { return path.join(this.root, ...p.split("/")); }
  async exists(p: string) { return fs.existsSync(this.abs(p)); }
  async read(p: string) { try { return fs.readFileSync(this.abs(p), "utf8"); } catch { return null; } }
  async write(p: string, text: string) { await this.writeBinary(p, new TextEncoder().encode(text)); }
  async writeBinary(p: string, data: Uint8Array) {
    const a = this.abs(p);
    fs.mkdirSync(path.dirname(a), { recursive: true });
    const tmp = `${a}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, a);
  }
  async ensureFolder(p: string) { fs.mkdirSync(this.abs(p), { recursive: true }); }
  async listMarkdown() {
    const out: string[] = [];
    const rec = (dir: string, rel: string) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) rec(path.join(dir, e.name), r);
        else if (e.name.endsWith(".md")) out.push(r);
      }
    };
    rec(this.root, "");
    return out;
  }
  async stemsIn(folder: string) {
    const a = this.abs(folder);
    if (!fs.existsSync(a)) return new Set<string>();
    return new Set(fs.readdirSync(a).map((n) => n.replace(/\.[^.]+$/, "").toLowerCase()));
  }
  /** Tests: flat "key: value" frontmatter only; changed keys are rewritten as JSON strings, like Obsidian quotes them. */
  async processFrontMatter(p: string, fn: (fm: Record<string, unknown>) => void) {
    const text = (await this.read(p)) ?? "";
    const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
    const lines = m ? m[1].split(/\r?\n/) : [];
    const fm: Record<string, unknown> = {};
    for (const l of lines) {
      const kv = /^([^\s:][^:]*):\s?(.*)$/.exec(l);
      if (kv) { try { fm[kv[1]] = JSON.parse(kv[2]); } catch { fm[kv[1]] = kv[2]; } }
    }
    const before = JSON.stringify(fm);
    const old = JSON.parse(before) as Record<string, unknown>;
    fn(fm);
    if (JSON.stringify(fm) === before) return;
    let out = lines.filter((l) => { const k = /^([^\s:][^:]*):/.exec(l)?.[1]; return !k || (k in fm && JSON.stringify(fm[k]) === JSON.stringify(old[k])); });
    for (const [k, v] of Object.entries(fm)) if (!(k in old) || JSON.stringify(v) !== JSON.stringify(old[k])) out.push(`${k}: ${JSON.stringify(v)}`);
    out = out.filter((l) => l !== "");
    await this.write(p, `---\n${out.join("\n")}\n---\n` + (m ? text.slice(m[0].length) : text));
  }
}

const ID_RE = /^samsung_note_id:\s*['"]?([^'"\s]+)/m;

/** samsung_note_id -> vault paths of notes that carry it in frontmatter. */
export class NoteIndex {
  private byId = new Map<string, Set<string>>();

  static parse(text: string): string | null {
    if (!text.startsWith("---")) return null;
    const end = text.indexOf("\n---", 3);
    if (end < 0) return null;
    return ID_RE.exec(text.slice(0, end))?.[1] ?? null;
  }

  async build(v: VaultIO): Promise<number> {
    this.byId.clear();
    for (const p of await v.listMarkdown()) {
      const text = await v.read(p);
      const id = text ? NoteIndex.parse(text) : null;
      if (id) this.add(id, p);
    }
    return this.byId.size;
  }

  add(id: string, p: string) {
    const s = this.byId.get(id) ?? new Set<string>();
    s.add(p);
    this.byId.set(id, s);
  }

  remove(p: string) {
    for (const s of this.byId.values()) s.delete(p);
  }

  paths(id: string): string[] { return [...(this.byId.get(id) ?? [])]; }
  get size() { return this.byId.size; }
}
