# Reproducible build

`main.js` contains three things: the plugin code, a small render worker, and the
[sdocx](https://github.com/twangodev/sdocx) WebAssembly renderer. Obsidian plugins can only ship
`main.js`, `manifest.json` and `styles.css`, so the renderer is embedded as one Brotli-compressed,
base64-encoded blob. Everything below lets anyone check that this blob is exactly the published
renderer and nothing else.

## What is pinned

| What | Where | Value |
|---|---|---|
| Renderer package | `package.json` (exact version), `package-lock.json` (npm `integrity` hash of the tarball) | `@twango/sdocx` 1.1.0 |
| Renderer WebAssembly | `renderer-pin.json` | `sdocx_bg.wasm`, SHA-256 `39a8219a025957f97fe2729fb7f641750f67040f57119c69fa286b8fe34d65f4` |
| Build tools | `package-lock.json` | esbuild, TypeScript and the rest at exact versions |
| Node.js | `.nvmrc` (exact), `engines` | 22.23.4: the embedded renderer is Brotli-compressed with Node's built-in zlib, so build with this exact version to get the same bytes |

`npm run build` **refuses to build** if the installed `@twango/sdocx` isn't the pinned version, or
if its `sdocx_bg.wasm` doesn't have the pinned SHA-256.

## Build

```powershell
npm ci                 # installs exactly what package-lock.json lists (and checks integrity hashes)
npm run build          # -> main.js
npm run verify         # checks the WebAssembly embedded in main.js against renderer-pin.json
```

With the same Node major version and `npm ci`, the build is byte-for-byte deterministic: building
twice gives the same `main.js`, and so does building on another machine with the same toolchain.
For a release, the `main.js` SHA-256 is listed in the release notes.

## Verify a released main.js

You don't need to build anything to check a `main.js` you downloaded:

```powershell
node scripts/verify-main.mjs path\to\downloaded\main.js
```

The script finds the single large embedded blob (there must be exactly one), decompresses it (Brotli),
checks that it's a WebAssembly module, and compares its SHA-256 with `renderer-pin.json`. You can
also compare that hash with the file published on npm:

```powershell
npm pack @twango/sdocx@1.1.0
tar -xf twango-sdocx-1.1.0.tgz package/sdocx_bg.wasm
certutil -hashfile package\sdocx_bg.wasm SHA256      # or: sha256sum package/sdocx_bg.wasm
```

If `main.js` was built by a different Node/zlib version, the compressed bytes and therefore the
`main.js` hash can differ. The decompressed WebAssembly and its SHA-256 must still match.

## Updating the renderer

1. `npm install --save-exact @twango/sdocx@<new>`
2. Check the new module's output against the test fixtures (`npm test`, including the pen
   regression test) and read the upstream changelog.
3. Put the new version and `sdocx_bg.wasm` SHA-256 in `renderer-pin.json`.
4. `npm run build && npm run verify`.
