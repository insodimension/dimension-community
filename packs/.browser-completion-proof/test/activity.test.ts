import { expect, test } from "bun:test";
import type { CodeHostPort, RunStarted } from "../src/code/contracts";
import { runCodeTool, type CodeToolDeps } from "../src/code/tool";

const done: RunStarted = { state: "done", result: { displays: [{ type: "text", text: "finished" }], screenshots: [] } };

test("a held code call publishes only its latest browser picture status before completion and drops late callbacks", async () => {
	const firstPreview = Promise.withResolvers<Record<string, unknown>>();
	const notified = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const latePreview = Promise.withResolvers<Record<string, unknown>>();
	let callback: ((browserId: string) => void) | undefined;
	const host: CodeHostPort = {
		run: async (_session, options) => {
			callback = options.onBrowserActivity;
			callback?.("older");
			callback?.("newer");
			await finish.promise;
			return done;
		},
		resume: async () => done,
		dispose: async () => {},
	};
	const deps: CodeToolDeps = {
		host, sessionOf: () => "chat", artifactsDir: () => "unused", meta: {},
		preview: async (_session, browserId) => {
			if (browserId === "older") return firstPreview.promise;
			if (browserId === "after-final") return latePreview.promise;
			return { source: { kind: "browser", browserId }, profile: "throwaway" };
		},
	};
	const notifications: Array<{ progressToken: string | number; preview: unknown }> = [];
	const extra = {
		signal: new AbortController().signal,
		_meta: { progressToken: "request-7" },
		sendNotification: async (notice: { params: { progressToken: string | number; _meta: Record<string, unknown> } }) => {
			notifications.push({ progressToken: notice.params.progressToken, preview: notice.params._meta["ai.insodimension/preview"] });
			notified.resolve();
		},
	};
	const pending = runCodeTool(deps, { code: "await browser.tab()" }, extra);
	await notified.promise;
	firstPreview.resolve({ source: { kind: "browser", browserId: "older" }, images: [{ data: "secret-image" }] });
	finish.resolve();
	const final = await pending;
	expect(notifications).toEqual([{ progressToken: "request-7", preview: { source: { kind: "browser", browserId: "newer" }, profile: "throwaway" } }]);
	expect(final._meta).toEqual({ "ai.insodimension/preview": { source: { kind: "browser", browserId: "newer" }, profile: "throwaway" } });
	callback?.("after-final");
	latePreview.resolve({ source: { kind: "browser", browserId: "after-final" } });
	await Promise.resolve();
	await Promise.resolve();
	expect(notifications).toHaveLength(1);
});

test("resume reports its active browser before the held result and cancelled requests publish no later picture status", async () => {
	const activity = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const controller = new AbortController();
	let callback: ((browserId: string) => void) | undefined;
	const host: CodeHostPort = {
		run: async () => done,
		resume: async (_session, _runId, _waitMs, _signal, onBrowserActivity) => {
			callback = onBrowserActivity;
			callback?.("active");
			await finish.promise;
			return done;
		},
		dispose: async () => {},
	};
	const seen: unknown[] = [];
	const deps: CodeToolDeps = {
		host, sessionOf: () => "chat", artifactsDir: () => "unused", meta: {},
		preview: async (_session, browserId) => ({ source: { kind: "browser", browserId } }),
	};
	const pending = runCodeTool(deps, { resume: "r1" }, {
		signal: controller.signal, _meta: { progressToken: 17 },
		sendNotification: async notice => { seen.push(notice.params._meta["ai.insodimension/preview"]); activity.resolve(); },
	});
	await activity.promise;
	expect(seen).toEqual([{ source: { kind: "browser", browserId: "active" } }]);
	controller.abort();
	callback?.("cancelled-late");
	finish.resolve();
	await pending;
	expect(seen).toHaveLength(1);
});
