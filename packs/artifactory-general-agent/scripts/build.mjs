import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as buildServer } from "esbuild";
import { build as buildPage } from "vite";
import { validateArtifactoryDecl } from "@dimension/sdk/artifactory";
import { validateRailActionDecl } from "@dimension/sdk/rail-action";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Agent Plugins 1.0.0 layout: the pack id is the portable `name`; the
// Dimension declaration lives under the `ai.insodimension.dimension` extension.
const manifest = JSON.parse(await readFile(resolve(root, "plugin.json"), "utf8"));
const dimension = manifest.extensions?.["ai.insodimension.dimension"] ?? {};
const declared = dimension.artifactories;
if (!Array.isArray(declared) || declared.length === 0) throw new Error("plugin.json declares no artifactories");
for (const declaration of declared) {
  const issues = validateArtifactoryDecl({ ...declaration, plugin: manifest.name, type: "artifactory" });
  if (issues.length) throw new Error(issues.map(issue => issue.message).join("\n"));
}
// The door: each rail entry must be one the engine accepts, and a page entry
// must name a `workspace-surface` component THIS pack ships (the engine drops
// an entry that does not).
const surfaces = (dimension.components ?? []).filter(component => component.slot === "workspace-surface").map(component => component.id);
for (const rail of dimension.railActions ?? []) {
  const issues = validateRailActionDecl(rail);
  if (issues.length) throw new Error(issues.map(issue => `railActions[${rail.id}]: ${issue.message}`).join("\n"));
  if (rail.component !== undefined && !surfaces.includes(rail.component)) {
    throw new Error(`railActions[${rail.id}] names component "${rail.component}", which is not one of this pack's workspace-surface components (${surfaces.join(", ") || "none"})`);
  }
}
// The runtime `dependencies` stay external (installed beside the pack); the
// SDK's `parseGeneralAgent` — a workspace package not published to npm, with
// the fork's manifest parser behind it — is BUNDLED, so the installed server
// classifies agents with exactly the code the engine does.
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
await mkdir(resolve(root, "app"), { recursive: true });
await buildServer({
  entryPoints: [resolve(root, "src/stdio.ts")],
  outfile: resolve(root, "app/server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: Object.keys(pkg.dependencies),
  sourcemap: false,
});
// The page: the rung-3 component bundle (`vite.config.ts`).
await buildPage({ configFile: resolve(root, "vite.config.ts"), root });
