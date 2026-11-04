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
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
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
  // Declared runtime packages install beside the pack; the SDK authoring surface is bundled.
  external: Object.keys(pkg.dependencies),
  sourcemap: false,
  loader: { ".txt": "text", ".md": "text" },
};
await buildServer({ ...nodeBundle, entryPoints: [resolve(root, "src/stdio.ts")], outfile: resolve(root, "app/server.mjs") });
await buildServer({ ...nodeBundle, entryPoints: [resolve(root, "src/code/worker/entry.ts")], outfile: resolve(root, "app/code-worker.mjs") });
await buildServer({ ...nodeBundle, entryPoints: [resolve(root, "src/file-hash-worker.ts")], outfile: resolve(root, "app/file-hash-worker.mjs") });
// The MCP entry: a launcher that checks the runtime before it loads anything (and, under Bun, relaunches under a real Node: src/launch-node.ts). It imports no server code, only the server bundle by URL at run time.
await buildServer({ ...nodeBundle, entryPoints: [resolve(root, "src/launch.ts")], outfile: resolve(root, "app/launch.mjs") });
await buildAgentPuppeteer({ outfile: resolve(root, "app/puppeteer-agent.mjs") });
await buildView({
  configFile: false,
  root: resolve(root, "app/view"),
  base: "./",
  plugins: [react()],
  build: { outDir: resolve(root, "app/dist"), emptyOutDir: true, sourcemap: false, target: "es2022" },
});
