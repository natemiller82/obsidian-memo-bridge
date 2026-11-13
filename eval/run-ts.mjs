// Run an eval script written in TypeScript: bundle it with esbuild (dependencies stay external,
// resolved from node_modules) and run it with Node. Usage: node eval/run-ts.mjs <cmd> [args]
//   cmd: pick | run | report | review
import { build } from "esbuild";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const cmds = { pick: "eval/pick.ts", images: "eval/images.ts", run: "eval/run.ts", report: "eval/report.ts", review: "eval/review.ts" };
const [cmd, ...args] = process.argv.slice(2);
if (!cmds[cmd]) { console.error(`usage: npm run eval -- <${Object.keys(cmds).join("|")}> [options]`); process.exit(2); }
const out = path.join("eval", ".out", `${cmd}.mjs`);
await build({ entryPoints: [cmds[cmd]], bundle: true, platform: "node", format: "esm", target: "node22", outfile: out, packages: "external", logLevel: "error",
  // src/sqlite.ts loads node:sqlite with require(), as it can inside Obsidian
  banner: { js: "import { createRequire as __cr } from \"node:module\"; globalThis.require ??= __cr(import.meta.url);" } });
// Run in this process, not a child: stopping the batch (Ctrl+C, or killing this process) then
// can't leave an orphan behind that keeps a model busy.
process.argv = [process.argv[0], path.resolve(out), ...args];
await import(pathToFileURL(path.resolve(out)).href);
