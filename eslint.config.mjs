// Obsidian's own lint rules (eslint-plugin-obsidianmd, recommended config), as the community
// directory's automated review uses them. Run from the project root: npm run lint
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  // Build output and Node-only tooling (tests, the eval harness, build/verify scripts) are not plugin code.
  globalIgnores(["node_modules", "main.js", "esbuild.config.mjs", "scripts", "test", "eval", ".vitest"]),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs", "vitest.config.ts"],
        },
      },
    },
  },
]);
