import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as buildServer } from "esbuild";
import { build as buildView } from "vite";
import react from "@vitejs/plugin-react";
import { validateArtifactoryDecl } from "@dimension/sdk/artifactory";
import { buildAgentPuppeteer } from "./agent-puppeteer.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Agent Plugins 1.0.0 layout: the pack id is the portable `name`; the
// Dimension declaration lives under the `ai.insodimension.dimension` extension.
const manifest = JSON.parse(await readFile(resolve(root, "plugin.json"), "utf8"));
const declared = manifest.extensions?.["ai.insodimension.dimension"]?.artifactories;
if (!Array.isArray(declared) || declared.length === 0) throw new Error("plugin.json declares no artifactories");
for (const declaration of declared) {
  const issues = validateArtifactoryDecl({ ...declaration, plugin: manifest.name, type: "artifactory" });
  if (issues.length) throw new Error(issues.map(issue => issue.message).join("\n"));
}
await mkdir(resolve(root, "app"), { recursive: true });
await buildServer({
  entryPoints: [resolve(root, "src/stdio.ts")],
  outfile: resolve(root, "app/server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: false,
});
// The puppeteer-core a throwaway agent browser is driven with: the same library with patches/puppeteer-core-25.11.0-agent.patch
// applied while it is bundled (no Runtime.enable, DOM work in the utility world, no script names). app/server.mjs imports it by
// path at run time (src/engines/agent-puppeteer.ts); the View and saved profiles keep the stock puppeteer-core it imports by name.
await buildAgentPuppeteer({ outfile: resolve(root, "app/puppeteer-agent.mjs") });
await buildView({
  configFile: false,
  root: resolve(root, "app/view"),
  base: "./",
  plugins: [react()],
  build: { outDir: resolve(root, "app/dist"), emptyOutDir: true, sourcemap: false, target: "es2022" },
});
// The dock component (the Browser panel) — the rung-3 bundle the host loads at
// runtime, built exactly as the pr-viewer pack builds its own: ONE entry whose
// DEFAULT export is the component, and an externals list that is the pack's
// IMPORT contract (doc 68 §9.1 Q1) — the specifiers the host's loader
// resolves, nothing else. Unminified because `dist/` is committed and must
// stay reviewable; `jsx` pinned to the automatic runtime because
// `react/jsx-runtime` is one of the granted externals.
await buildView({
  configFile: false,
  root,
  esbuild: { jsx: "automatic" },
  build: {
    outDir: resolve(root, "dist"),
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    target: "es2022",
    lib: { entry: resolve(root, "src/dock/index.ts"), formats: ["es"], fileName: () => "index.mjs" },
    rollupOptions: { external: ["react", "react-dom", "react/jsx-runtime", "@fraym/ui"] },
  },
});
