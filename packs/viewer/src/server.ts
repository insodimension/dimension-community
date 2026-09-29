// The viewer's MCP server: two tools and the View bundle.
//
//   view_file        model-visible. Resolves a path through the fence, names what
//                    it is, and mounts the View. Its RESULT carries the document
//                    key (`_meta["ai.insodimension/tab"]`) so a host that keeps a
//                    tab per document can tell one file from another.
//   read_file_chunk  app-only. The View streams a document's bytes through it.
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
import { MAX_CHUNK_BYTES, TAB_META_KEY, VIEWER_VIEW_URI, type ViewedFile } from "./contract";
import { createFence, type Fence } from "./fence";
import { detectKind, KIND_HEAD_BYTES } from "./kind";

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

export async function createViewerServer(options: ViewerServerOptions = {}): Promise<McpServer> {
	const fence = options.fence ?? createFence({ home: options.home ?? homedir(), env: options.env ?? process.env });
	const viewDir = options.viewDir ?? fileURLToPath(new URL("./dist/", import.meta.url));
	// A missing built View is a startup error, not an installed pack that opens blank.
	const html = await readFile(join(viewDir, "index.html"), "utf8");
	const server = new McpServer({ name: "dimension-community-viewer", version: "0.1.0" });

	// `clipboardWrite`: the View's "copy path" button. No other permission is asked for.
	const metadata = { ui: { prefersBorder: false, permissions: { clipboardWrite: {} } } };
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
				"Open a file from the user's computer in the viewer beside the conversation, as a tab. Renders images, PDF, HTML, Markdown, Word (.docx), PowerPoint (.pptx), Excel (.xlsx) and plain text; other files show a file card. " +
				"Pass the ABSOLUTE path of a file you created or were pointed at; opening the same file again refreshes its tab. " +
				"Only folders the user allowed are readable (their personal vault and the folders in VIEWER_ROOTS); anything else, and secrets such as .env files and keys, is refused with the reason.",
			inputSchema: {
				path: z.string().min(1).max(4096).describe("Absolute path of the file to open"),
				filename: z.string().min(1).max(255).optional().describe("Name to show in the tab; defaults to the file's own name"),
			},
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
			_meta: { ui: { resourceUri: VIEWER_VIEW_URI } },
		},
		async ({ path, filename }) => {
			const verdict = await fence.check(path);
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
					_meta: { [TAB_META_KEY]: { key: file.path } },
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
		async ({ path, offset, length }) => {
			const verdict = await fence.check(path);
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

	return server;
}
