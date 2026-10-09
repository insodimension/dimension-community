// The shared annotation kit's tsconfig maps `react` to `@types/react/*.d.ts` so the kit typechecks without a React
// runtime of its own. Bun honours `paths` while it runs the kit's source, so a test that loads the kit's React layer
// (the Browser View does, through the annotation seat) is handed a `.d.ts` to execute. The kit's own tests pin those
// paths to the real runtime before anything loads; a pack run does not inherit that, so it does the same here, once,
// for every test file (see bunfig.toml). The values are the modules `react` resolves to everywhere else, so no second
// copy of React exists.
import { mock } from "bun:test";
import { fileURLToPath } from "node:url";

const fromRoot = (path: string): string => fileURLToPath(new URL(`../../../../node_modules/${path}`, import.meta.url));

// Runtime-selected paths: the repository root's install, from this pack's place in it.
const [react, jsxRuntime, jsxDevRuntime] = await Promise.all([
	import(fromRoot("react/cjs/react.development.js")),
	import(fromRoot("react/jsx-runtime.js")),
	import(fromRoot("react/jsx-dev-runtime.js")),
]);

mock.module(fromRoot("@types/react/index.d.ts"), () => react);
mock.module(fromRoot("@types/react/jsx-runtime.d.ts"), () => jsxRuntime);
mock.module(fromRoot("@types/react/jsx-dev-runtime.d.ts"), () => jsxDevRuntime);
