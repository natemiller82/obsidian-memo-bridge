// Assets that esbuild inlines into main.js (see esbuild.config.mjs).
import workerSource from "virtual:memo-bridge/worker-source";
import wasmGz from "virtual:memo-bridge/sdocx-wasm-gz";
import { gunzipSync } from "node:zlib";

export { workerSource };

/** The sdocx WebAssembly module, decompressed on demand (it is ~10 MB unpacked). */
export function sdocxWasm(): Uint8Array {
  return new Uint8Array(gunzipSync(wasmGz));
}
