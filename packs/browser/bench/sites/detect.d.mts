export interface DetectRow {
	id: string;
	group: string;
	/** A bot-detection check would flag this signal. */
	tell: boolean;
	value: string;
	note: string;
}
export interface DetectFrame {
	webdriver: boolean | undefined;
	headless: boolean;
	/** A DevTools client has Runtime enabled in the frame. */
	runtime: boolean;
	gpu: [string, string] | null;
}
export interface DetectServer {
	url: string;
	/** A page with one link, #go, that opens the detection page in a new tab. */
	openerUrl: string;
	/** Every call to a hooked page API that came from outside the page's own scripts. */
	hooked(): string[];
	/** What the cross-origin (out-of-process) iframe of the page reported; null until it did. */
	frame(): DetectFrame | null;
	/** The rows the last visit posted; null until it did. */
	rows(): DetectRow[] | null;
	/** The row that needs the driver to have acted first; null until the page posted it. */
	late(): DetectRow | null;
	/** How many times the page has posted the late row since `reset`. */
	lates(): number;
	reset(): void;
	stop(): Promise<void>;
}
export const DETECT_HTML: string;
export const FRAME_HTML: string;
export const OPENER_HTML: string;
export function createDetectServer(options?: { port?: number }): Promise<DetectServer>;
