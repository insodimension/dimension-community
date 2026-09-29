import { defineConfig } from "vite";

// The rung-3 bundle: a pack ships a BUILT ESM bundle the host loads at
// runtime, so nothing in the app references this pack by name. The externals
// list is the pack's IMPORT contract (doc 68 §9.1 Q1) — exactly the
// specifiers the host's loader resolves, nothing else; trust comes from the
// engine-stamped hash + the install decision, not from this list. Unminified
// on purpose: `dist/` is committed, so it has to stay reviewable. `jsx` is
// pinned explicitly — the committed output must keep the automatic runtime
// (`react/jsx-runtime` is one of the four granted externals).
export default defineConfig({
	esbuild: { jsx: "automatic" },
	build: {
		target: "es2022",
		minify: false,
		sourcemap: false,
		emptyOutDir: true,
		lib: {
			entry: "src/index.tsx",
			formats: ["es"],
			fileName: () => "index.mjs",
		},
		rollupOptions: {
			external: ["react", "react-dom", "react/jsx-runtime", "@fraym/ui"],
		},
	},
});
