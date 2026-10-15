// The viewer's MCP server: its tools and the View bundle. Each tool passes its
// call's `_meta` to the fence, which reads the host-lent one-file grant there
// (doc 86 §5): a human's click may open ONE file the roots do not cover.
//
// The View itself (`app/dist`) is served as resources under `ui://viewer/`, the
// way the browser pack does it: the host mounts `index.html` and resolves every
// chunk it names through `resources/read`.
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { readChunk, readRange } from "./chunk";
import { ANNOTATE_META_KEY, MAX_CHUNK_BYTES, TAB_META_KEY, VIEWER_VIEW_URI, type ViewedFile } from "./contract";
import { createFence, type Fence } from "./fence";
import {
	HOST_CONTEXT_ENDED_METHOD,
	HOST_CONTEXT_REFERENCE_META_KEY,
	type MediaSession,
	SESSION_META_KEY,
	mediaTokenSchema,
} from "./contract";
import { detectKind, KIND_HEAD_BYTES } from "./kind";
import { type MediaServer, startMediaServer } from "./media-server";

const MIME: Readonly<Record<string, string>> = {
	".js": "text/javascript",
	".mjs": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".wasm": "application/wasm",
};
const TEXT_MIME: Readonly<Record<string, true>> = { "text/javascript": true, "text/css": true, "application/json": true, "image/svg+xml": true };

const APP_ONLY = { ui: { visibility: ["app"] as ("app" | "model")[] } };

export interface ViewerServerOptions {
	/** Where the built View lives; defaults to `dist/` beside the server. */
	readonly viewDir?: string;
	readonly fence?: Fence;
	readonly env?: NodeJS.ProcessEnv;
	readonly home?: string;
}

const failure = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

function describeError(error: unknown): string {
	if (error instanceof RangeError) return error.message;
	if (!(error instanceof Error)) return String(error);
	const code = "code" in error && typeof error.code === "string" ? ` (${error.code})` : "";
	return `${error.message}${code}`;
}

const sessionMetaSchema = z.object({ sessionId: z.string().min(1) });

const hostReferenceSchema = z.object({ sessionId: z.string().min(1), token: z.string().regex(/^[a-f0-9]{64}$/) });

interface CallStamp {
	readonly session: MediaSession;
	readonly reference: z.infer<typeof hostReferenceSchema> | undefined;
}

function callStamp(meta: unknown): CallStamp {
	const record = typeof meta === "object" && meta !== null && Object.hasOwn(meta as object, SESSION_META_KEY) ? (meta as Record<string, unknown>) : undefined;
	const session = record === undefined ? undefined : sessionMetaSchema.safeParse(record[SESSION_META_KEY]).data?.sessionId;
	const reference = session === undefined ? undefined : hostReferenceSchema.safeParse(record?.[HOST_CONTEXT_REFERENCE_META_KEY]).data;
	return { session, reference };
}

export async function createViewerServer(options: ViewerServerOptions = {}): Promise<McpServer> {
	// An outside-the-roots refusal says one sentence to the caller; its cause goes to stderr, which the host keeps (stdout is the protocol).
	const fence =
		options.fence ?? createFence({ home: options.home ?? homedir(), env: options.env ?? process.env, log: detail => console.error(`viewer fence: ${detail}`) });
	const viewDir = options.viewDir ?? fileURLToPath(new URL("./dist/", import.meta.url));
	// A missing built View is a startup error, not an installed pack that opens blank.
	const html = await readFile(join(viewDir, "index.html"), "utf8");
	const server = new McpServer({ name: "dimension-community-viewer", version: "0.1.0" });

	const media = await startMediaServer(fence);
	server.server.onclose = () => { void media.close().catch(error => console.error(error)); };
	const sessionStamps = new Map<string, string>();
	const rememberStamp = (call: CallStamp): void => {
		if (call.session !== undefined && call.reference !== undefined && call.reference.sessionId === call.session)
			sessionStamps.set(call.session, call.reference.token);
	};
	server.server.setNotificationHandler(
		z.object({ method: z.literal(HOST_CONTEXT_ENDED_METHOD), params: hostReferenceSchema }),
		({ params }) => {
			if (sessionStamps.get(params.sessionId) === params.token) media.releaseSession(params.sessionId);
		},
	);
	try {
		await registerViewer(server, { fence, html, viewDir, media, rememberStamp });
	} catch (error) {
		await media.close();
		throw error;
	}
	return server;
}

interface ViewerParts {
	readonly fence: Fence;
	readonly html: string;
	readonly viewDir: string;
	readonly media: MediaServer;
	readonly rememberStamp: (call: CallStamp) => void;
}

async function registerViewer(server: McpServer, { fence, html, viewDir, media, rememberStamp }: ViewerParts): Promise<void> {
	const metadata = { ui: { prefersBorder: false, permissions: { clipboardWrite: {} }, csp: { resourceDomains: [media.origin] } } };
	registerAppResource(server, "Viewer", VIEWER_VIEW_URI, { _meta: metadata }, async () => ({
		contents: [{ uri: VIEWER_VIEW_URI, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: metadata }],
	}));
	for (const entry of await readdir(viewDir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || entry.name === "index.html") continue;
		const mimeType = MIME[extname(entry.name)];
		if (mimeType === undefined) throw new Error(`Unsupported viewer View asset: ${entry.name}`);
		const path = join(entry.parentPath, entry.name);
		const relative = path.slice(viewDir.replace(/[\\/]$/, "").length + 1).replaceAll("\\", "/");
		const uri = `ui://viewer/${relative}`;
		server.registerResource(relative, uri, { mimeType }, async () => {
			const bytes = await readFile(path);
			return {
				contents: [TEXT_MIME[mimeType] ? { uri, mimeType, text: bytes.toString("utf8") } : { uri, mimeType, blob: bytes.toString("base64") }],
			};
		});
	}

	registerAppTool(
		server,
		"view_file",
		{
			title: "View file",
			description:
				"Open a file from the user's computer in the viewer beside the conversation, as a tab. Renders images, PDF, HTML, Markdown, Word (.docx), PowerPoint (.pptx), Excel (.xlsx) and plain text, and plays audio and video; other files show a file card. " +
				"Pass the ABSOLUTE path of a file you created or were pointed at; opening the same file again refreshes its tab. annotate: true opens it ready for the user to mark up (a moment on a recording, an element on a page). " +
				"Only folders the user allowed are readable (their personal vault and the folders in VIEWER_ROOTS); anything else, and secrets such as .env files and keys, is refused with the reason.",
			inputSchema: {
				path: z.string().min(1).max(4096).describe("Absolute path of the file to open"),
				filename: z.string().min(1).max(255).optional().describe("Name to show in the tab; defaults to the file's own name"),
				annotate: z.boolean().optional().describe("Open in annotate mode, so the user can mark the file up"),
			},
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
			_meta: { ui: { resourceUri: VIEWER_VIEW_URI } },
		},
		async ({ path, filename, annotate }, extra) => {
			rememberStamp(callStamp(extra._meta));
			const verdict = await fence.check(path, extra._meta);
			if (!verdict.ok) return failure(verdict.reason);
			try {
				const head = await readRange(verdict.real, 0, KIND_HEAD_BYTES);
				const shown = filename ?? basename(verdict.real);
				const file: ViewedFile = {
					path: verdict.real,
					filename: shown,
					kind: detectKind(shown, head.bytes, head.size),
					size: head.size,
					mtimeMs: head.mtimeMs,
				};
				return {
					content: [{ type: "text", text: `Opened ${file.filename} (${file.kind}, ${file.size} bytes) in the viewer.` }],
					structuredContent: { ...file },
					_meta: { [TAB_META_KEY]: { key: file.path }, ...(annotate === true ? { [ANNOTATE_META_KEY]: true } : {}) },
				};
			} catch (error) {
				return failure(`"${path}" cannot be opened: ${describeError(error)}`);
			}
		},
	);

	registerAppTool(
		server,
		"read_file_chunk",
		{
			title: "Read file chunk",
			description: `Read a byte range of a file the viewer may open, base64-encoded (at most ${MAX_CHUNK_BYTES} bytes per call). The View streams a document through this; it is not for the model.`,
			inputSchema: {
				path: z.string().min(1).max(4096),
				offset: z.number().int().min(0),
				length: z.number().int().min(0).max(MAX_CHUNK_BYTES),
			},
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
			_meta: APP_ONLY,
		},
		async ({ path, offset, length }, extra) => {
			const verdict = await fence.check(path, extra._meta);
			if (!verdict.ok) return failure(verdict.reason);
			try {
				const chunk = await readChunk(verdict.real, offset, length);
				return {
					content: [{ type: "text", text: `Read ${chunk.length} of ${chunk.size} bytes at offset ${chunk.offset}.` }],
					structuredContent: { ...chunk },
				};
			} catch (error) {
				return failure(`"${path}" cannot be read: ${describeError(error)}`);
			}
		},
	);

	registerAppTool(server, "open_media", {
		inputSchema: { path: z.string().min(1).max(4096), size: z.number().int().nonnegative(), mtimeMs: z.number(), token: mediaTokenSchema },
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		_meta: APP_ONLY,
	}, async ({ path, size, mtimeMs, token }, extra) => {
		const stamped = callStamp(extra._meta);
		rememberStamp(stamped);
		try {
			const source = await media.acquire(path, size, mtimeMs, extra._meta, token, stamped.session);
			return { content: [{ type: "text", text: "Recording ready for range playback." }], structuredContent: { ...source } };
		} catch (error) {
			return failure(describeError(error));
		}
	});
	registerAppTool(server, "close_media", {
		inputSchema: { token: mediaTokenSchema },
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		_meta: APP_ONLY,
	}, async ({ token }, extra) => {
		rememberStamp(callStamp(extra._meta));
		media.release(token);
		return { content: [{ type: "text", text: "Recording released." }], structuredContent: {} };
	});
	registerAppTool(server, "close_other_recordings", {
		title: "Close other recordings",
		description: "Release every recording this session holds in the viewer except one. The View calls it from the slot-refusal card; it is not for the model.",
		inputSchema: { keep: mediaTokenSchema.optional().describe("The recording whose lease stays; absent closes every one this session holds") },
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		_meta: APP_ONLY,
	}, async ({ keep }, extra) => {
		const stamped = callStamp(extra._meta);
		rememberStamp(stamped);
		if (stamped.session === undefined) return failure("No session rode this call, so there is nothing to count the recordings of.");
		media.releaseSession(stamped.session, keep);
		return { content: [{ type: "text", text: "The session's other recordings are released." }], structuredContent: {} };
	});
}
