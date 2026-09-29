// Builds the two artifacts the pack ships, both committed (a pack installs with
// no build step): `app/server.mjs` (the MCP server, fully bundled so an installed
// copy needs no node_modules) and `app/dist/` (the View, chunked by the kit's
// `defineAppViteConfig`).
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateArtifactoryDecl } from "@dimension/sdk/artifactory";
import { build as buildServer } from "esbuild";
import { build as buildView } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Agent Plugins 1.0.0 layout: the pack id is the portable `name`; the Dimension
// declaration lives under the `ai.insodimension.dimension` extension.
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
	sourcemap: false,
	// A bundled CommonJS dependency may `require` a Node built-in; ESM has no `require`.
	banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
await buildView({ configFile: resolve(root, "app/vite.config.ts") });
