/**
 * What went wrong in a page, as a bounded list of short lines: console errors and warnings,
 * uncaught exceptions, HTTP responses of 400 or more, and requests that failed. Only what the
 * page itself printed or requested is kept (never a request or response body, header or
 * cookie), every url loses its query string (tokens live there), and every line is cut short.
 */
import type { ConsoleMessage, HTTPRequest, HTTPResponse, Page } from "puppeteer-core";
import { type LogEntry, MAX_LOG_TEXT_CHARS } from "../contracts.js";

/**
 * Chrome echoes every failed load as a console error of this text; the `http`/`network` entries say the same,
 * with the method and url, so the echo is left out.
 */
const LOAD_FAILURE_ECHO = "Failed to load resource";
/** A request cancelled by the browser (a navigation leaving the page, an aborted fetch) is not a fault of the page. */
const ABORTED = "net::ERR_ABORTED";
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>)\]]+/g;
/** A page error's message carries its stack; the top of it locates the fault. */
const STACK_LINES = 3;

/** `url` without its query string or fragment. */
export function withoutQuery(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.search = "";
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return url.split(/[?#]/, 1)[0] ?? "";
	}
}

/** Free text made safe to keep: urls in it lose their query strings, and it is cut at the bound. */
export function logText(text: string): string {
	const cleaned = text.replace(URL_IN_TEXT, withoutQuery);
	return cleaned.length > MAX_LOG_TEXT_CHARS ? `${cleaned.slice(0, MAX_LOG_TEXT_CHARS - 1)}…` : cleaned;
}

/** The browser's own fetch of /favicon.ico: an app that ships no icon is not a broken one, and every dev server 404s it. */
function isFavicon(request: HTTPRequest): boolean {
	try {
		return request.resourceType() === "other" && new URL(request.url()).pathname === "/favicon.ico";
	} catch {
		return false;
	}
}

/** Report each thing that goes wrong on `page` to `record`, for as long as the page lives. */
export function watchPageLog(page: Page, record: (type: LogEntry["type"], text: string) => void): void {
	page.on("console", (message: ConsoleMessage) => {
		const level = message.type();
		if ((level !== "error" && level !== "warn") || message.text().startsWith(LOAD_FAILURE_ECHO)) return;
		const { url, lineNumber } = message.location();
		const where = url ? ` @ ${withoutQuery(url)}:${lineNumber ?? 0}` : "";
		record(level === "error" ? "console.error" : "console.warning", logText(`${message.text()}${where}`));
	});
	page.on("pageerror", (error: unknown) => {
		const text = error instanceof Error ? error.message : String(error);
		record("exception", logText(text.split("\n").slice(0, STACK_LINES).join(" | ")));
	});
	page.on("response", (response: HTTPResponse) => {
		if (response.status() < 400 || isFavicon(response.request())) return;
		record("http", logText(`${response.status()} ${response.request().method()} ${withoutQuery(response.url())}`));
	});
	page.on("requestfailed", (request: HTTPRequest) => {
		const failure = request.failure()?.errorText;
		if (failure === undefined || failure === ABORTED || isFavicon(request)) return;
		record("network", logText(`${request.method()} ${withoutQuery(request.url())} failed: ${failure}`));
	});
}
