// pdf.js ships its worker as an ES module, and a MODULE worker cannot start from
// a `blob:` URL inside the View's opaque-origin frame (measured in Chromium: the
// worker errors with no message; a classic worker from the same blob runs). The
// worker must be a blob because a worker fetched from the View's own URL is
// cross-origin to an opaque origin. So the bundled module source is turned into a
// classic script: its one `export` statement is dropped (the worker starts itself
// through `globalThis`, not through the export), and `import.meta.url`, which a
// classic script may not even mention, becomes the worker's own location — the
// only uses are the wasm image decoders' `new URL(".", url)` inside a try block.
//
// Anything else a pdf.js release adds that a classic script cannot contain makes
// this throw when the worker is built, and `test/pdf-worker.test.ts` parses the
// installed worker as a classic script so the upgrade fails in CI, not in a pane.

/** The classic-script form of pdf.js's module worker source. */
export function toClassicWorkerSource(moduleSource: string): string {
	const withoutExport = moduleSource.replace(/export\s*\{\s*WorkerMessageHandler\s*\};?\s*$/, "");
	if (/^\s*export\b/m.test(withoutExport) || /^\s*import\s/m.test(withoutExport)) {
		throw new Error("pdf.js worker has module syntax this viewer does not know how to strip; update pdf-worker.ts");
	}
	return withoutExport.replaceAll("import.meta.url", "self.location.href");
}
