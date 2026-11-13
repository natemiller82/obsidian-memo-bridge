// Download a pinned gitleaks release into tools/bin (gitignored) and verify its SHA-256.
// Usage: node scripts/get-gitleaks.mjs
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "8.30.1";
const ASSETS = {
  win32: { file: `gitleaks_${VERSION}_windows_x64.zip`, sha256: "d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e", exe: "gitleaks.exe" },
  linux: { file: `gitleaks_${VERSION}_linux_x64.tar.gz`, sha256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb", exe: "gitleaks" },
};
const a = ASSETS[process.platform];
if (!a) throw new Error(`no pinned gitleaks build for ${process.platform}; install gitleaks ${VERSION} yourself`);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const res = await fetch(`https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${a.file}`);
if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
const got = createHash("sha256").update(buf).digest("hex");
if (got !== a.sha256) throw new Error(`checksum mismatch for ${a.file}: ${got}`);
const tmp = mkdtempSync(join(tmpdir(), "gitleaks-"));
const archive = join(tmp, a.file);
writeFileSync(archive, buf);
const bin = join(root, "tools", "bin");
mkdirSync(bin, { recursive: true });
execFileSync("tar", ["-xf", archive, "-C", bin, a.exe]);
rmSync(tmp, { recursive: true, force: true });
console.log(`gitleaks ${VERSION} -> ${join(bin, a.exe)} (sha256 verified)`);
