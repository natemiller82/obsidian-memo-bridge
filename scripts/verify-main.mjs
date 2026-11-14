// Verify that a built main.js embeds exactly the pinned sdocx WebAssembly module.
// Usage: node scripts/verify-main.mjs [path/to/main.js]
// Works on a main.js downloaded from a release: it finds the one large embedded base64 blob
// (the Brotli-compressed module), decompresses it and compares its SHA-256 with renderer-pin.json.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pins = JSON.parse(readFileSync(join(root, "renderer-pin.json"), "utf8"));
const file = process.argv[2] ?? join(root, "main.js");
const js = readFileSync(file, "latin1");
const sha = (b) => createHash("sha256").update(b).digest("hex");

// Brotli has no magic number, so: every base64 string literal of 100 kB or more. There must be exactly one.
const blobs = [...js.matchAll(/"([A-Za-z0-9+/]{100000,}={0,2})"/g)];
if (blobs.length !== 1) { console.error(`expected exactly 1 large embedded blob, found ${blobs.length}`); process.exit(1); }
let wasm;
try { wasm = brotliDecompressSync(Buffer.from(blobs[0][1], "base64")); }
catch { console.error("the embedded blob is not a Brotli stream"); process.exit(1); }
const ok = wasm.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d])) && sha(wasm) === pins.wasmSha256;
console.log(`main.js        ${sha(readFileSync(file))}  (${file})`);
console.log(`embedded wasm  ${sha(wasm)}  (${wasm.length} bytes)`);
console.log(`pinned         ${pins.wasmSha256}  (${pins.package} ${pins.version}/${pins.wasm})`);
if (!ok) { console.error("MISMATCH: main.js does not embed the pinned sdocx module"); process.exit(1); }
console.log("OK: main.js embeds exactly the pinned sdocx module, and nothing else of that kind.");
