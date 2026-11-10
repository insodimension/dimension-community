// Google Drive connector — list/search/read files over the Drive API v3,
// authenticated via the plugin's `oauth` connect flow (see fraym.plugin.json).
// The connect flow writes {access,refresh,expires,clientId,clientSecret?} to
// CONFIG_TARGET; this extension's ONLY job is to keep that access token fresh
// and expose it as agent tools. No Google SDK — plain fetch against the
// documented REST endpoints, matching the rest of this repo's connectors.
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";

// MUST match `connect.configTarget` in fraym.plugin.json — the connect flow
// (packages/engine/src/plugin-oauth.ts) writes the credential there; this is
// the ONLY other place that path is spelled out (JSON manifest can't share a
// TS constant with this file).
const CONFIG_TARGET = join(homedir(), ".config", "dimension-google-drive", "token.json");
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
// Refresh this many ms before actual expiry so a slow request never races a
// token that goes stale mid-flight.
const REFRESH_SKEW_MS = 60_000;
const MAX_FILE_TEXT_BYTES = 200_000;

const storedCredential = type({
	"provider?": "string",
	access: "string",
	refresh: "string",
	expires: "number",
	clientId: "string",
	"clientSecret?": "string",
	"scopes?": "string[]",
});
type StoredCredential = typeof storedCredential.infer;

// Scopes that permit mutation. Credentials written before scope persistence
// existed carry no `scopes` — treated as readonly (exactly the old surface).
const WRITE_SCOPES = ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/drive.file"];

/** Whether the granted scope set permits Drive mutations. */
export function hasWriteScope(scopes: readonly string[] | undefined): boolean {
	return scopes?.some(scope => WRITE_SCOPES.includes(scope)) ?? false;
}

async function readCredential(): Promise<StoredCredential> {
	let raw: string;
	try {
		raw = await readFile(CONFIG_TARGET, "utf-8");
	} catch {
		throw new Error(
			"Google Drive isn't connected yet. Open the plugin's Connect dialog (Plugins → Google Drive) and sign in.",
		);
	}
	const parsed = storedCredential(JSON.parse(raw));
	if (parsed instanceof type.errors) {
		throw new Error(`Google Drive's stored credential at ${CONFIG_TARGET} is malformed. Reconnect the plugin.`);
	}
	return parsed;
}

/** Refresh the access token via the standard `refresh_token` grant if it's
 *  expired (or about to be), persisting the renewed credential. Google may not
 *  re-issue a refresh token on every call — the old one is kept when absent. */
async function refreshAccessToken(cred: StoredCredential): Promise<StoredCredential> {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: cred.refresh,
		client_id: cred.clientId,
	});
	if (cred.clientSecret) body.set("client_secret", cred.clientSecret);
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: body.toString(),
	});
	const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	if (!res.ok || !payload || typeof payload.access_token !== "string") {
		const detail =
			payload && typeof payload.error_description === "string" ? payload.error_description : res.statusText;
		throw new Error(`Google Drive token refresh failed: ${detail}. Reconnect the plugin.`);
	}
	const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
	const refreshed: StoredCredential = {
		...cred,
		access: payload.access_token,
		refresh: typeof payload.refresh_token === "string" ? payload.refresh_token : cred.refresh,
		expires: Date.now() + expiresIn * 1000,
	};
	await writeFile(CONFIG_TARGET, JSON.stringify(refreshed, null, 2));
	return refreshed;
}

/** A valid bearer token, refreshing first if the stored one is expired/near-expiry. */
async function freshAccessToken(): Promise<string> {
	const cred = await readCredential();
	if (Date.now() < cred.expires - REFRESH_SKEW_MS) return cred.access;
	return (await refreshAccessToken(cred)).access;
}

async function driveFetch(path: string, accessToken: string, init?: RequestInit): Promise<Response> {
	const url = path.startsWith("https://") ? path : `${DRIVE_API}${path}`;
	const res = await fetch(url, {
		...init,
		headers: { Authorization: `Bearer ${accessToken}`, ...(init?.headers ?? {}) },
	});
	if (res.status === 401) {
		throw new Error("Google Drive rejected the access token (401). Reconnect the plugin.");
	}
	return res;
}

async function driveJson<T>(path: string, accessToken: string, op: string, init?: RequestInit): Promise<T> {
	const res = await driveFetch(path, accessToken, init);
	const payload = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
	if (!res.ok || !payload) {
		throw new Error(`Drive ${op} failed: ${payload?.error?.message ?? res.statusText}`);
	}
	return payload;
}

interface DriveFile {
	readonly id: string;
	readonly name: string;
	readonly mimeType: string;
	readonly modifiedTime?: string;
	readonly size?: string;
}

// Google Workspace's native formats have no raw bytes — `files.get?alt=media`
// 403s on them. Each must be EXPORTED to a real format instead; this is the
// export mimeType per source type (text-first, since the agent reads it as text).
const EXPORT_MIME_TYPE: Readonly<Record<string, string>> = {
	"application/vnd.google-apps.document": "text/plain",
	"application/vnd.google-apps.spreadsheet": "text/csv",
	"application/vnd.google-apps.presentation": "text/plain",
	"application/vnd.google-apps.drawing": "image/svg+xml",
};

const listFilesSchema = type({
	"query?": type("string").describe(
		"Drive query syntax (https://developers.google.com/drive/api/guides/search-files), e.g. \"name contains 'report' and mimeType = 'application/pdf'\". Omit to list recent files.",
	),
	"pageSize?": type("number").describe("Max results, default 20, capped at 100."),
});

const readFileSchema = type({
	fileId: type("string").describe("The Drive file id (from google_drive_list_files)."),
});

function createListFilesTool(): ToolDefinition<typeof listFilesSchema> {
	return {
		name: "google_drive_list_files",
		label: "Google Drive: List Files",
		description:
			"List or search files in the connected Google account's Drive using Drive query syntax. Returns id/name/type/modified for each match — pass an id to google_drive_read_file.",
		parameters: listFilesSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof listFilesSchema.infer) {
			const accessToken = await freshAccessToken();
			const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 100);
			const search = new URLSearchParams({
				pageSize: String(pageSize),
				fields: "files(id,name,mimeType,modifiedTime,size)",
				orderBy: "modifiedTime desc",
			});
			if (params.query) search.set("q", params.query);
			const payload = await driveJson<{ files?: DriveFile[] }>(
				`/files?${search.toString()}`,
				accessToken,
				"files.list",
			);
			const files = payload.files ?? [];
			const text =
				files.length === 0
					? "No files matched."
					: files
							.map(
								file =>
									`${file.id}  ${file.name}  (${file.mimeType})${file.modifiedTime ? ` — ${file.modifiedTime}` : ""}`,
							)
							.join("\n");
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createReadFileTool(): ToolDefinition<typeof readFileSchema> {
	return {
		name: "google_drive_read_file",
		label: "Google Drive: Read File",
		description:
			"Read a Drive file's content as text — plain files download raw; Google Docs/Sheets/Slides export to text/CSV first (no raw bytes for native Workspace formats). Truncated past ~200KB.",
		parameters: readFileSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof readFileSchema.infer) {
			const accessToken = await freshAccessToken();
			const meta = await driveJson<DriveFile>(
				`/files/${encodeURIComponent(params.fileId)}?fields=id,name,mimeType,size`,
				accessToken,
				"files.get",
			);
			const exportMimeType = EXPORT_MIME_TYPE[meta.mimeType];
			const contentPath = exportMimeType
				? `/files/${encodeURIComponent(params.fileId)}/export?mimeType=${encodeURIComponent(exportMimeType)}`
				: `/files/${encodeURIComponent(params.fileId)}?alt=media`;
			const contentRes = await driveFetch(contentPath, accessToken);
			if (!contentRes.ok) {
				const payload = (await contentRes.json().catch(() => null)) as { error?: { message?: string } } | null;
				throw new Error(`Drive file content fetch failed: ${payload?.error?.message ?? contentRes.statusText}`);
			}
			const buffer = await contentRes.arrayBuffer();
			const truncated = buffer.byteLength > MAX_FILE_TEXT_BYTES;
			const text = new TextDecoder().decode(buffer.slice(0, MAX_FILE_TEXT_BYTES));
			const header = `${meta.name} (${meta.mimeType}${exportMimeType ? ` → exported as ${exportMimeType}` : ""})`;
			const body = truncated ? `${text}\n\n[...truncated at ${MAX_FILE_TEXT_BYTES} bytes]` : text;
			return { content: [{ type: "text" as const, text: `${header}\n\n${body}` }] };
		},
	};
}

const uploadFileSchema = type({
	path: type("string").describe("Local file path to upload."),
	"name?": type("string").describe("Drive filename (defaults to the local basename)."),
	"folderId?": type("string").describe("Destination folder id (defaults to My Drive root)."),
	"convertTo?": type("string").describe(
		"Optional Google Workspace target mimeType, e.g. application/vnd.google-apps.document to create a Doc from the uploaded content.",
	),
});

const createFolderSchema = type({
	name: type("string").describe("Folder name."),
	"parentId?": type("string").describe("Parent folder id (defaults to My Drive root)."),
});

const moveFileSchema = type({
	fileId: type("string").describe("The Drive file id to move/rename."),
	"newName?": type("string").describe("New filename (omit to keep)."),
	"targetFolderId?": type("string").describe("Destination folder id (omit to keep location)."),
});

const shareFileSchema = type({
	fileId: type("string").describe("The Drive file id to share."),
	"emailAddress?": type("string").describe(
		"Grant access to this Google account. Omit to create an anyone-with-the-link grant.",
	),
	"role?": type("'reader' | 'writer'").describe("Access level, default reader."),
});

function createUploadFileTool(): ToolDefinition<typeof uploadFileSchema> {
	return {
		name: "google_drive_upload_file",
		label: "Google Drive: Upload File",
		description:
			"Upload a local file to the connected Drive (optionally converting to a Google Doc/Sheet via convertTo). Creates a NEW file.",
		parameters: uploadFileSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof uploadFileSchema.infer) {
			const accessToken = await freshAccessToken();
			const bytes = await readFile(params.path);
			const name = params.name ?? params.path.replace(/^.*[\\/]/, "");
			const metadata: Record<string, unknown> = { name };
			if (params.folderId) metadata.parents = [params.folderId];
			if (params.convertTo) metadata.mimeType = params.convertTo;
			const boundary = `dimension-${Date.now().toString(36)}`;
			const body = new Blob([
				`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
				`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
				bytes,
				`\r\n--${boundary}--`,
			]);
			const file = await driveJson<DriveFile>(
				"https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType",
				accessToken,
				"files.create (upload)",
				{ method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body },
			);
			return {
				content: [{ type: "text" as const, text: `Uploaded ${file.name} (${file.mimeType}) — id ${file.id}` }],
			};
		},
	};
}

function createCreateFolderTool(): ToolDefinition<typeof createFolderSchema> {
	return {
		name: "google_drive_create_folder",
		label: "Google Drive: Create Folder",
		description: "Create a folder in the connected Drive.",
		parameters: createFolderSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof createFolderSchema.infer) {
			const accessToken = await freshAccessToken();
			const metadata: Record<string, unknown> = {
				name: params.name,
				mimeType: "application/vnd.google-apps.folder",
			};
			if (params.parentId) metadata.parents = [params.parentId];
			const folder = await driveJson<DriveFile>("/files?fields=id,name", accessToken, "files.create (folder)", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(metadata),
			});
			return { content: [{ type: "text" as const, text: `Created folder ${folder.name} — id ${folder.id}` }] };
		},
	};
}

function createMoveFileTool(): ToolDefinition<typeof moveFileSchema> {
	return {
		name: "google_drive_move_file",
		label: "Google Drive: Move/Rename File",
		description:
			"Rename a Drive file and/or move it to another folder. MUTATES the user's Drive.",
		parameters: moveFileSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof moveFileSchema.infer) {
			if (!params.newName && !params.targetFolderId) {
				throw new Error("Nothing to do: pass newName and/or targetFolderId.");
			}
			const accessToken = await freshAccessToken();
			const id = encodeURIComponent(params.fileId);
			const search = new URLSearchParams({ fields: "id,name,parents" });
			if (params.targetFolderId) {
				const current = await driveJson<DriveFile & { parents?: string[] }>(
					`/files/${id}?fields=parents`,
					accessToken,
					"files.get (parents)",
				);
				search.set("addParents", params.targetFolderId);
				if (current.parents?.length) search.set("removeParents", current.parents.join(","));
			}
			const file = await driveJson<DriveFile>(`/files/${id}?${search.toString()}`, accessToken, "files.update", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(params.newName ? { name: params.newName } : {}),
			});
			return { content: [{ type: "text" as const, text: `Updated ${file.name} — id ${file.id}` }] };
		},
	};
}

function createShareFileTool(): ToolDefinition<typeof shareFileSchema> {
	return {
		name: "google_drive_share_file",
		label: "Google Drive: Share File",
		description:
			"Grant access to a Drive file (a specific account, or anyone-with-the-link) and return its link. CHANGES who can see the file.",
		parameters: shareFileSchema,
		approval: "write",
		formatApprovalDetails(args: unknown) {
			const arg = (key: string): unknown =>
				typeof args === "object" && args !== null ? Reflect.get(args, key) : undefined;
			const fileId = arg("fileId");
			const email = arg("emailAddress");
			const role = arg("role");
			return [
				`File: ${typeof fileId === "string" ? fileId : "(missing)"}`,
				`Share with: ${typeof email === "string" && email.length > 0 ? email : "ANYONE with the link"}`,
				`Role: ${typeof role === "string" ? role : "reader"}`,
			];
		},
		async execute(_toolCallId: string, params: typeof shareFileSchema.infer) {
			const accessToken = await freshAccessToken();
			const id = encodeURIComponent(params.fileId);
			const role = params.role ?? "reader";
			const permission = params.emailAddress
				? { type: "user", role, emailAddress: params.emailAddress }
				: { type: "anyone", role };
			await driveJson<{ id: string }>(`/files/${id}/permissions?fields=id`, accessToken, "permissions.create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(permission),
			});
			const file = await driveJson<DriveFile & { webViewLink?: string }>(
				`/files/${id}?fields=id,name,webViewLink`,
				accessToken,
				"files.get (link)",
			);
			const grant = params.emailAddress ? `${params.emailAddress} (${role})` : `anyone with the link (${role})`;
			return {
				content: [
					{
						type: "text" as const,
						text: `Shared ${file.name} with ${grant}${file.webViewLink ? ` — ${file.webViewLink}` : ""}`,
					},
				],
			};
		},
	};
}

/**
 * Google Drive plugin. A standard OMP plugin — `skills/`/`rules/` load via
 * OMP's native plugin discovery. Registers the two read tools always; the
 * write surface registers ONLY when the stored credential's granted scopes
 * permit mutation (the connect flow persists `scopes` — see
 * fraym.plugin.json's `connect.oauth.scopeOptions`). A scope upgrade takes
 * effect for new sessions, which re-run this factory.
 */
export default async function googleDriveExtension(pi: ExtensionAPI): Promise<void> {
	pi.registerTool(createListFilesTool());
	pi.registerTool(createReadFileTool());
	let scopes: readonly string[] | undefined;
	try {
		scopes = (await readCredential()).scopes;
	} catch {
		// Not connected / malformed credential — readonly surface only; the
		// tools themselves surface the actionable connect error on use.
	}
	if (hasWriteScope(scopes)) {
		pi.registerTool(createUploadFileTool());
		pi.registerTool(createCreateFolderTool());
		pi.registerTool(createMoveFileTool());
		pi.registerTool(createShareFileTool());
	}
}
