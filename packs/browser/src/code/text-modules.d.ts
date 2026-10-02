// `.md` and `.txt` files under src/code are imported as their text: Bun reads them as text (bunfig.toml `[loader]`), esbuild bundles them
// with the `text` loader (scripts/build.mjs). Typed here so tsc sees what the bundlers deliver.
declare module "*.md" {
  const text: string;
  export default text;
}
declare module "*.txt" {
  const text: string;
  export default text;
}
