// Verify that a built main.js embeds exactly the pinned sdocx WebAssembly module.
// Usage: node scripts/verify-main.mjs [path/to/main.js]
// Works on a main.js downloaded from a release: it extracts the embedded (gzipped, base64)
// module, decompresses it and compares its SHA-256 with renderer-pin.json.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pins = JSON.parse(readFileSync(join(root, "renderer-pin.json"), "utf8"));
const file = process.argv[2] ?? join(root, "main.js");
const js = readFileSync(file, "latin1");
const sha = (b) => createHash("sha256").update(b).digest("hex");

const blobs = [...js.matchAll(/"(H4sI[A-Za-z0-9+/=]{1000,})"/g)];   // gzip streams start with H4sI in base64
if (blobs.length !== 1) { console.error(`expected exactly 1 embedded gzip blob, found ${blobs.length}`); process.exit(1); }
const wasm = gunzipSync(Buffer.from(blobs[0][1], "base64"));
const ok = wasm.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d])) && sha(wasm) === pins.wasmSha256;
console.log(`main.js        ${sha(readFileSync(file))}  (${file})`);
console.log(`embedded wasm  ${sha(wasm)}  (${wasm.length} bytes)`);
console.log(`pinned         ${pins.wasmSha256}  (${pins.package} ${pins.version}/${pins.wasm})`);
if (!ok) { console.error("MISMATCH: main.js does not embed the pinned sdocx module"); process.exit(1); }
console.log("OK: main.js embeds exactly the pinned sdocx module, and nothing else of that kind.");
