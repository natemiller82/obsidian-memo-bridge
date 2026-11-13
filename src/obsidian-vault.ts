import { normalizePath, TFile, TFolder, type FileManager, type Vault } from "obsidian";
import type { VaultIO } from "./vaultio";

/** VaultIO over Obsidian's Vault API (so Obsidian and sync plugins see every change). */
export class ObsidianVault implements VaultIO {
  constructor(private vault: Vault, private files: FileManager) {}

  async exists(p: string) { return this.vault.getAbstractFileByPath(normalizePath(p)) !== null; }

  async read(p: string) {
    const f = this.vault.getAbstractFileByPath(normalizePath(p));
    return f instanceof TFile ? this.vault.read(f) : null;
  }

  async write(p: string, text: string) {
    const np = normalizePath(p);
    const f = this.vault.getAbstractFileByPath(np);
    // Only files the engine has verified it owns get here; process() replaces them atomically.
    if (f instanceof TFile) await this.vault.process(f, () => text);
    else { await this.ensureFolder(np.slice(0, np.lastIndexOf("/"))); await this.vault.create(np, text); }
  }

  async writeBinary(p: string, data: Uint8Array) {
    const np = normalizePath(p);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const f = this.vault.getAbstractFileByPath(np);
    if (f instanceof TFile) await this.vault.modifyBinary(f, buf);
    else { await this.ensureFolder(np.slice(0, np.lastIndexOf("/"))); await this.vault.createBinary(np, buf); }
  }

  async ensureFolder(p: string) {
    if (!p) return;
    let cur = "";
    for (const seg of normalizePath(p).split("/")) {
      cur = cur ? `${cur}/${seg}` : seg;
      if (!this.vault.getAbstractFileByPath(cur)) {
        try { await this.vault.createFolder(cur); } catch { /* created concurrently */ }
      }
    }
  }

  async processFrontMatter(p: string, fn: (fm: Record<string, unknown>) => void) {
    const f = this.vault.getAbstractFileByPath(normalizePath(p));
    if (!(f instanceof TFile)) throw new Error(`no such note: ${p}`);
    await this.files.processFrontMatter(f, fn);
  }

  async listMarkdown() { return this.vault.getMarkdownFiles().map((f) => f.path); }

  async stemsIn(folder: string) {
    const f = this.vault.getAbstractFileByPath(normalizePath(folder));
    const out = new Set<string>();
    if (f instanceof TFolder) for (const c of f.children) out.add((c instanceof TFile ? c.basename : c.name).toLowerCase());
    return out;
  }
}
