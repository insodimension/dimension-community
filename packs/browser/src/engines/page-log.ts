/**
 * What went wrong in a page, as a bounded list of short lines: console errors and warnings,
 * uncaught exceptions, HTTP responses of 400 or more, and requests that failed. Only what the
 * page itself printed or requested is kept (never a request or response body, header or
 * cookie), every url loses its query string (tokens live there), and every line is cut short.
 */
import type { CDPSession, ConsoleMessage, HTTPRequest, HTTPResponse, Page, Protocol } from "puppeteer-core";
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

/** The marker a page's own exception reporter (`LOOPBACK_EXCEPTIONS`) puts in front of what it logs, so the reader can tell it from the app's own messages. */
const EXCEPTION_MARK = "\u0001dimension-exception\u0001";

/**
 * A script for every document of an agent browser's page: on a page served from this machine (loopback), report an
 * uncaught error or unhandled rejection through the console, where the Console domain (which, unlike Runtime, a page
 * cannot detect) carries it to `watchPageLog`. Nothing is installed on any other origin.
 */
export const LOOPBACK_EXCEPTIONS = `(() => {
	const host = location.hostname;
	if (host !== "localhost" && host !== "[::1]" && !/^127\\./.test(host) && !host.endsWith(".localhost")) return;
	const say = (text) => console.debug(${JSON.stringify(EXCEPTION_MARK)} + String(text).slice(0, 2000));
	addEventListener("error", (event) => say((event.error && event.error.stack) || event.message));
	addEventListener("unhandledrejection", (event) => say("Unhandled rejection: " + ((event.reason && (event.reason.stack || event.reason.message)) || event.reason)));
})();`;

function toLogLine(text: string): string {
	return logText(text.split("\n").slice(0, STACK_LINES).join(" | "));
}

/**
 * What the page's own code printed with `console.*`, without `Runtime` (an agent browser keeps it off): from the Console
 * domain, and what the page threw, from `LOOPBACK_EXCEPTIONS`. Chrome's own messages are not here (`Console` carries only
 * the page's calls, source "console-api"): those come from the Log domain, see `watchPageLog`.
 */
function watchConsoleDomain(cdp: CDPSession, record: (type: LogEntry["type"], text: string) => void): void {
	cdp.on("Console.messageAdded", ({ message }: Protocol.Console.MessageAddedEvent) => {
		if (message.source !== "console-api") return;
		if (message.text.startsWith(EXCEPTION_MARK)) {
			record("exception", toLogLine(message.text.slice(EXCEPTION_MARK.length)));
			return;
		}
		if ((message.level !== "error" && message.level !== "warning") || message.text.startsWith(LOAD_FAILURE_ECHO)) return;
		const where = message.url ? ` @ ${withoutQuery(message.url)}:${message.line ?? 0}` : "";
		record(message.level === "error" ? "console.error" : "console.warning", logText(`${message.text}${where}`));
	});
	// Replays what the page printed before this was on.
	void cdp.send("Console.enable").catch(() => undefined);
}

/**
 * Report each thing that goes wrong on `page` to `record`, for as long as the page lives.
 *
 * Chrome's own console errors and warnings (a Content-Security-Policy refusal, mixed content, a load or a fetch blocked by
 * CORS, a deprecation) reach puppeteer's `console` event from the Log domain, which puppeteer turns on for every page and a
 * page cannot tell is on, so that handler is kept in every browser. `consoleSession` is the page's session when it has no
 * Runtime events (an agent browser): what the page itself prints then comes from the Console domain, and its uncaught
 * exceptions from `LOOPBACK_EXCEPTIONS` on a page served from this machine. On any other site an uncaught exception is the
 * one thing such a browser does not hear.
 */
export function watchPageLog(page: Page, record: (type: LogEntry["type"], text: string) => void, consoleSession?: CDPSession): void {
	page.on("console", (message: ConsoleMessage) => {
		const level = message.type();
		if ((level !== "error" && level !== "warn") || message.text().startsWith(LOAD_FAILURE_ECHO)) return;
		const { url, lineNumber } = message.location();
		const where = url ? ` @ ${withoutQuery(url)}:${lineNumber ?? 0}` : "";
		record(level === "error" ? "console.error" : "console.warning", logText(`${message.text()}${where}`));
	});
	if (consoleSession) watchConsoleDomain(consoleSession, record);
	else {
		page.on("pageerror", (error: unknown) => {
			record("exception", toLogLine(error instanceof Error ? error.message : String(error)));
		});
	}
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
