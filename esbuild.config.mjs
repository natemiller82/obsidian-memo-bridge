// Builds main.js: the plugin, an embedded render-worker bundle (as a string) and the
// sdocx WebAssembly module (gzipped, inlined once). Obsidian releases ship only
// main.js / manifest.json / styles.css, so everything must live in main.js.
import esbuild from "esbuild";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { builtinModules } from "node:module";

const require = createRequire(import.meta.url);
const prod = process.argv[2] === "production";
const wasmPath = require.resolve("@twango/sdocx/sdocx_bg.wasm");

// Reproducible build: refuse to bundle anything but the pinned renderer (see BUILD.md).
import { createHash } from "node:crypto";
import pins from "./renderer-pin.json" with { type: "json" };
const sdocxVersion = JSON.parse(readFileSync(require.resolve("@twango/sdocx/package.json"), "utf8")).version;
if (sdocxVersion !== pins.version) throw new Error(`@twango/sdocx ${sdocxVersion} installed, ${pins.version} pinned`);
const wasmSha = createHash("sha256").update(readFileSync(wasmPath)).digest("hex");
if (wasmSha !== pins.wasmSha256) throw new Error(`sdocx_bg.wasm sha256 ${wasmSha} != pinned ${pins.wasmSha256}`);

// 1. The worker bundle (runs @twango/sdocx off the UI thread).
const worker = await esbuild.build({
  entryPoints: ["src/render/worker.ts"],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: prod,
  // sdocx.js only uses import.meta.url to locate the .wasm when no bytes are given;
  // we always pass bytes.
  define: { "import.meta.url": '"about:blank"' },
  logLevel: "warning",
});
const workerSource = worker.outputFiles[0].text;

const virtual = {
  name: "memo-bridge-virtual",
  setup(build) {
    build.onResolve({ filter: /^virtual:memo-bridge\// }, (a) => ({ path: a.path, namespace: "mb" }));
    build.onLoad({ filter: /.*/, namespace: "mb" }, (a) => {
      if (a.path === "virtual:memo-bridge/worker-source")
        return { contents: `export default ${JSON.stringify(workerSource)};`, loader: "js" };
      if (a.path === "virtual:memo-bridge/sdocx-wasm-gz")
        return { contents: gzipSync(readFileSync(wasmPath), { level: 9 }), loader: "binary" };
      return null;
    });
  },
};

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  format: "cjs",
  platform: "node",
  target: "es2022",
  minify: prod,
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules, ...builtinModules.map((m) => `node:${m}`), "node:sqlite"],
  plugins: [virtual],
  banner: { js: "/* Memo Bridge - GPL-3.0-or-later. Bundles @twango/sdocx (GPL-3.0) and @xmldom/xmldom (MIT). */" },
  logLevel: "warning",
});
console.log(`main.js ${(statSync("main.js").size / 1e6).toFixed(1)} MB (worker ${(workerSource.length / 1e3).toFixed(0)} kB)`);
