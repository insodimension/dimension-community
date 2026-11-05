import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import type { BatchStep, UploadRequest } from "../src/contracts";
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

const NETWORK_SHARE_PATH = process.platform === "win32" ? "\\\\server\\share\\first.txt" : "//server/share/first.txt";

afterEach(teardown, BROWSER_TEST_TIMEOUT_MS);

function startUploadPage(): { url: string; origin: string; stop: () => Promise<void> } {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(UPLOAD_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }),
	});
	const origin = `http://127.0.0.1:${server.port}`;
	return { url: `${origin}/`, origin, stop: () => server.stop(true) };
}

async function refusal(run: () => Promise<unknown>): Promise<string> {
	try {
		await run();
	} catch (error) {
		if (error instanceof BrowserRuntimeError) return `${error.code}: ${error.message}`;
		throw error;
	}
	throw new Error("expected a refusal, but it ran");
}

function pageTitle(runtime: BrowserRuntime, browserId: string, expected: string): Promise<string> {
	return waitUntil(`the page title "${expected}"`, async () => (await runtime.state(browserId)).title, (title) => title === expected);
}

describeWithChrome("browser_upload", () => {
	test(
		"sets a file input directly and answers the picker another element opens, on a saved profile, only while the page is on the origins the person was shown",
		async () => {
			const page = startUploadPage();
			try {
				const { runtime } = await createRuntime();
				const files = await realpath(await createRoot());
				const first = join(files, "first.txt");
				const second = join(files, "second.txt");
				await writeFile(first, "one");
				await writeFile(second, "two");
				const { browserId } = await runtime.open({ profile: "upload", viewport: { width: 800, height: 600 } }, { caller: "app" });
				await perform(runtime, browserId, { kind: "navigate", url: page.url });
				const upload = (selector: string, paths: string[], origins: Partial<UploadRequest> = {}) => runtime.upload(browserId, { selector, paths, origin: page.origin, ...origins });

				expect((await upload("#single", [first])).status).toBe("completed");
				await pageTitle(runtime, browserId, "single:first.txt:one");
				expect((await upload("#many", [first, second])).status).toBe("completed");
				await pageTitle(runtime, browserId, "single:first.txt:one|many:first.txt:one|many:second.txt:two");
				expect((await upload("#opener", [second], { frameOrigin: page.origin })).status).toBe("completed");
				const sent = "single:first.txt:one|many:first.txt:one|many:second.txt:two|hidden:second.txt:two";
				await pageTitle(runtime, browserId, sent);

				const elsewhere = await upload("#single", [first], { origin: "https://example.com" });
				expect(elsewhere.status).toBe("failed");
				expect(elsewhere.error).toContain(`upload_mismatch: the tab is on ${page.origin}, not https://example.com`);
				const otherFrame = await upload("#opener", [first], { frameOrigin: "https://example.com" });
				expect(otherFrame.status).toBe("failed");
				expect(otherFrame.error).toContain(`upload_mismatch: the element is in ${page.origin}, not https://example.com`);
				expect((await runtime.state(browserId)).title).toBe(sent);

				const tooMany = await upload("#single", [first, second]);
				expect(tooMany.status).toBe("failed");
				expect(tooMany.error).toContain("takes one file, not 2");
				const wrongInput = await upload("#text", [first]);
				expect(wrongInput.status).toBe("failed");
				expect(wrongInput.error).toContain("takes no files");
			} finally {
				await page.stop();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"refuses before anything reaches the page: the View, bad paths, a path that is not the file's own, the browser's own data, a malformed origin; browser_act has no upload step",
		async () => {
			const page = startUploadPage();
			try {
				const { runtime, rootDir } = await createRuntime();
				const files = await realpath(await createRoot());
				const first = join(files, "first.txt");
				await writeFile(first, "one");
				const { browserId } = await runtime.open({ profile: "upload-refusals", viewport: { width: 800, height: 600 } }, { caller: "app" });
				await perform(runtime, browserId, { kind: "navigate", url: page.url });
				const refused = (paths: string[], origins: Partial<UploadRequest> = {}, caller?: "app") =>
					refusal(() => runtime.upload(browserId, { selector: "#single", paths, origin: page.origin, ...origins }, caller));

				expect(await refused([first], {}, "app")).toContain("upload is the agent's");
				expect(await refused(["first.txt"])).toContain("paths[0] must be an absolute path");
				expect(await refused([join(files, "missing.txt")])).toContain("does not exist");
				expect(await refused([NETWORK_SHARE_PATH])).toContain("network or device path");
				expect(await refused([files])).toContain("is not a file");
				expect(await refused([first, first, first, first])).toContain("paths must name 1-3 files");
				expect(await refused([])).toContain("paths must name 1-3 files");
				const secret = join(rootDir, "profiles", "secret.txt");
				await mkdir(join(rootDir, "profiles"), { recursive: true });
				await writeFile(secret, "never");
				expect(await refused([secret])).toContain("the browser's own data");
				expect(await refused([first], { origin: `${page.origin}/` })).toContain("origin must be an origin exactly as the tab's url gives it");
				expect(await refused([first], { frameOrigin: "about:blank" })).toContain("frameOrigin must be an origin");

				const link = join(files, "link.txt");
				const linked = await symlink(first, link).then(() => true, () => false);
				if (linked) expect(await refused([link])).toContain(`is ${first} on disk; pass that path`);

				const uploadStep = { kind: "upload", selector: "#single", paths: [first] } as unknown as BatchStep;
				expect(await refusal(() => runtime.actMany(browserId, [uploadStep]))).toContain('unsupported action kind "upload"');
				expect((await runtime.state(browserId)).title).toBe("none");
			} finally {
				await page.stop();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
