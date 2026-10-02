import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as buildServer } from "esbuild";
import { build as buildView } from "vite";
import react from "@vitejs/plugin-react";
import { validateArtifactoryDecl } from "@dimension/sdk/artifactory";

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
// Two Node entries, one set of options: the MCP server, and the code worker (a `worker_threads` thread per session that runs the
// model's `browser_run` cells, doc 77 §7.4.4). The server resolves the worker as `./code-worker.mjs` beside itself. The cell's
// facade, the model-facing text and the ARIA snapshot bundle are text modules.
const nodeBundle = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: false,
  loader: { ".txt": "text", ".md": "text" },
};
await buildServer({ ...nodeBundle, entryPoints: [resolve(root, "src/stdio.ts")], outfile: resolve(root, "app/server.mjs") });
await buildServer({ ...nodeBundle, entryPoints: [resolve(root, "src/code/worker/entry.ts")], outfile: resolve(root, "app/code-worker.mjs") });
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
