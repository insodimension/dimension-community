// Builds the two artifacts the pack ships, with esbuild alone:
//
//   app/server.mjs   the MCP server (packages stay external: they are the pack's
//                    declared dependencies, installed beside it)
//   app/view.html    the View, ONE self-contained document (script and style
//                    inlined): the host serves it as the App resource, so it does
//                    not depend on how sibling files would resolve inside a
//                    sandboxed frame
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateArtifactoryDecl } from "@dimension/sdk/artifactory";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(root, "plugin.json"), "utf8"));
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (manifest.name !== pkg.dimension?.name) throw new Error(`plugin.json name "${manifest.name}" must equal package.json dimension.name "${pkg.dimension?.name}"`);
const declared = manifest.extensions?.["ai.insodimension.dimension"]?.artifactories;
if (!Array.isArray(declared) || declared.length === 0) throw new Error("plugin.json declares no artifactories");
for (const declaration of declared) {
  const issues = validateArtifactoryDecl({ ...declaration, plugin: manifest.name, type: "artifactory" });
  if (issues.length) throw new Error(issues.map(issue => issue.message).join("\n"));
}

await mkdir(resolve(root, "app"), { recursive: true });
await build({
  entryPoints: [resolve(root, "src/stdio.ts")],
  outfile: resolve(root, "app/server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: false,
});

// `@fraym/ui/theme.css` starts with `@import "tailwindcss"`, which only its own Vite pipeline
// resolves. The View needs the kit's TOKENS (the --fr-* custom properties it declares), not
// Tailwind's utilities, so that one import resolves to an empty sheet here.
const withoutTailwind = {
  name: "without-tailwind",
  setup(b) {
    b.onResolve({ filter: /^tailwindcss(\/.*)?$/ }, args => ({ path: args.path, namespace: "empty-css" }));
    b.onLoad({ filter: /.*/, namespace: "empty-css" }, () => ({ contents: "", loader: "css" }));
  },
};
const view = await build({
  entryPoints: [resolve(root, "src/view/main.ts")],
  outdir: resolve(root, "app/.view-build"),
  write: false,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  charset: "utf8",
  plugins: [withoutTailwind],
  jsx: "automatic",
  // The View's chrome is the annotation kit's React. The kit's own tsconfig maps `react` to its type declarations for
  // the type checker; read as a bundler's paths that would resolve React to a .d.ts, so the JSX mode is given here.
  tsconfigRaw: { compilerOptions: { jsx: "react-jsx" } },
  loader: { ".woff2": "dataurl", ".woff": "dataurl", ".png": "dataurl", ".svg": "dataurl" },
  logLevel: "warning",
});
const js = view.outputFiles.find(file => file.path.endsWith(".js"))?.text;
const css = view.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
if (js === undefined) throw new Error("the View bundle produced no script");
const html = [
  "<!doctype html>",
  '<html lang="en">',
  "<head>",
  '<meta charset="utf-8" />',
  '<meta name="viewport" content="width=device-width, initial-scale=1" />',
  "<title>Simulator</title>",
  `<style>${css.replaceAll("</style", "<\\/style")}</style>`,
  "</head>",
  "<body>",
  '<div id="root"></div>',
  `<script type="module">${js.replaceAll("</script", "<\\/script")}</script>`,
  "</body>",
  "</html>",
  "",
].join("\n");
await writeFile(resolve(root, "app/view.html"), html);

console.log(`simulator: server ${(await readFile(resolve(root, "app/server.mjs"))).length} B, view ${html.length} B`);
