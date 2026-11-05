import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import type { BrowserAction } from "../src/contracts";
import type { BrowserRuntime } from "../src/runtime";
import { BrowserRuntimeError } from "../src/store";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, createRuntime, describeWithChrome, perform, teardown, waitUntil } from "./fixture";

const UPLOAD_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>none</title></head><body>
<input id="single" type="file">
<input id="many" type="file" multiple>
<input id="hidden" type="file" style="display:none">
<button id="opener" onclick="document.getElementById('hidden').click()">Upload file</button>
<input id="text" type="text">
<script>
  const shown = [];
  for (const input of document.querySelectorAll("input[type=file]")) {
    input.addEventListener("change", async () => {
      for (const file of input.files) shown.push(input.id + ":" + file.name + ":" + (await file.text()));
      document.title = shown.join("|");
    });
  }
</script></body></html>`;

afterEach(teardown, BROWSER_TEST_TIMEOUT_MS);

function startUploadPage(): { url: string; stop: () => Promise<void> } {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(UPLOAD_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }),
	});
	return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
}

async function refusal(runtime: BrowserRuntime, browserId: string, action: BrowserAction, caller?: "app"): Promise<string> {
	try {
		await runtime.act(browserId, action, caller);
	} catch (error) {
		if (error instanceof BrowserRuntimeError) return `${error.code}: ${error.message}`;
		throw error;
	}
	throw new Error("expected the upload to be refused, but it ran");
}

function pageTitle(runtime: BrowserRuntime, browserId: string, expected: string): Promise<string> {
	return waitUntil(`the page title "${expected}"`, async () => (await runtime.state(browserId)).title, (title) => title === expected);
}

describeWithChrome("browser_act upload", () => {
	test(
		"sets a file input directly, answers the picker another element opens, on a saved profile; refuses bad paths, the pack's own data and the View",
		async () => {
			const page = startUploadPage();
			try {
				const { runtime, rootDir } = await createRuntime();
				const files = await createRoot();
				const first = join(files, "first.txt");
				const second = join(files, "second.txt");
				await writeFile(first, "one");
				await writeFile(second, "two");
				const { browserId } = await runtime.open({ profile: "act-upload", viewport: { width: 800, height: 600 } }, { caller: "app" });
				await perform(runtime, browserId, { kind: "navigate", url: page.url });

				await perform(runtime, browserId, { kind: "upload", selector: "#single", paths: [first] });
				await pageTitle(runtime, browserId, "single:first.txt:one");

				await perform(runtime, browserId, { kind: "upload", selector: "#many", paths: [first, second] });
				await pageTitle(runtime, browserId, "single:first.txt:one|many:first.txt:one|many:second.txt:two");

				await perform(runtime, browserId, { kind: "upload", selector: "#opener", paths: [second] });
				await pageTitle(runtime, browserId, "single:first.txt:one|many:first.txt:one|many:second.txt:two|hidden:second.txt:two");

				const upload = (paths: string[]): BrowserAction => ({ kind: "upload", selector: "#single", paths });
				expect(await refusal(runtime, browserId, upload(["first.txt"]))).toContain("upload.paths[0] must be an absolute path");
				expect(await refusal(runtime, browserId, upload([join(files, "missing.txt")]))).toContain("does not exist");
				expect(await refusal(runtime, browserId, upload(["\\\\server\\share\\first.txt"]))).toContain("network or device path");
				expect(await refusal(runtime, browserId, upload([files]))).toContain("is not a file");
				const secret = join(rootDir, "profiles", "secret.txt");
				await mkdir(join(rootDir, "profiles"), { recursive: true });
				await writeFile(secret, "never");
				expect(await refusal(runtime, browserId, upload([secret]))).toContain("the browser's own data");
				expect(await refusal(runtime, browserId, upload([first]), "app")).toContain("upload is the agent's");
				expect(await refusal(runtime, browserId, upload([]))).toContain("upload.paths must name 1-16 files");

				const outcome = await runtime.act(browserId, upload([first, second]));
				expect(outcome.status).toBe("failed");
				expect(outcome.error).toContain("takes one file, not 2");
				const wrongInput = await runtime.act(browserId, { kind: "upload", selector: "#text", paths: [first] });
				expect(wrongInput.status).toBe("failed");
				expect(wrongInput.error).toContain("takes no files");
			} finally {
				await page.stop();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
