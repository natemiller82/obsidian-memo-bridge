// Copy the built plugin into a vault for development.
// Vault: MEMO_BRIDGE_VAULT env var, else the only vault registered in Obsidian's obsidian.json.
import { copyFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let vault = process.env.MEMO_BRIDGE_VAULT;
if (!vault) {
  const cfg = join(process.env.APPDATA ?? "", "obsidian", "obsidian.json");
  const vaults = existsSync(cfg) ? Object.values(JSON.parse(readFileSync(cfg, "utf8")).vaults ?? {}) : [];
  if (vaults.length !== 1) {
    console.error(`Set MEMO_BRIDGE_VAULT: found ${vaults.length} registered vaults in ${cfg}`);
    process.exit(1);
  }
  vault = vaults[0].path;
}
const dest = join(vault, ".obsidian", "plugins", "memo-bridge");
mkdirSync(dest, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) copyFileSync(join(root, f), join(dest, f));
console.log(`installed to ${dest}`);
