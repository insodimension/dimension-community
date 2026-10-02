// The General Agents page builds to `dist/index.mjs`: the rung-3 bundle the host
// loads at runtime (the `general-chat` and `traction-ui` recipe). The externals
// list is the pack's IMPORT contract (doc 68 §9.1 Q1): exactly the specifiers
// the host's loader resolves, nothing else. Unminified on purpose: `dist/` is
// committed, so it has to stay reviewable. `jsx` is pinned to the automatic
// runtime because `react/jsx-runtime` is one of the granted externals.
//
// `@fraym/config` (the face roster) and Mochi's accent palette are plain data,
// bundled. The palette is reached by file, not through `@fraym/vibr`'s root,
// whose avatar modules import their stylesheet as a side effect.
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export const PAGE_ALIASES = {
	"@fraym/vibr/avatars/mochi-skins": fileURLToPath(new URL("../../../fraym/packages/vibr/src/avatars/mochi-skins.ts", import.meta.url)),
};

export default defineConfig({
	plugins: [tailwindcss()],
	esbuild: { jsx: "automatic" },
	resolve: { alias: PAGE_ALIASES },
	build: {
		outDir: "dist",
		target: "es2022",
		minify: false,
		sourcemap: false,
		emptyOutDir: true,
		lib: {
			entry: "page/index.tsx",
			formats: ["es"],
			fileName: () => "index.mjs",
		},
		rollupOptions: {
			external: ["react", "react-dom", "react/jsx-runtime", "@fraym/ui"],
		},
	},
});
