import type { BlobRef } from "@dimension/sdk/presentation";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { registerArtifactsTool } from "./artifacts";
import { errorMessage } from "./library/errors";
import { stampPresented } from "./library/present-stamp";
import { sharedLibrary } from "./library/shared";
import type { Library } from "./library/types";
import { type KeepSnapshot, type PresentDetails, presentPaths } from "./present";

function blobSnapshots(ctx: ExtensionContext): KeepSnapshot {
	return async (bytes, extension) => {
		const blob = await ctx.sessionManager.putBlob(bytes, { extension });
		return { path: blob.displayPath, ref: blob.ref as BlobRef };
	};
}

export interface SwissKnifeDeps {
	readonly library: () => Promise<Library>;
}

export default function swissKnife(pi: ExtensionAPI, deps: SwissKnifeDeps = { library: sharedLibrary }): void {
	const z = pi.zod;

	pi.registerTool({
		name: "present",
		label: "Present",
		approval: "read",
		description:
			"Show the user one or more files (images, PDFs, documents, decks, sheets) as cards they can open and annotate.",
		parameters: z.object({
			path: z
				.union([z.string(), z.array(z.string())])
				.describe("Absolute file path, or an array of up to 12 paths."),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<PresentDetails>> {
			const { text, details } = await presentPaths(params.path, { cwd: ctx.cwd, signal, snapshot: blobSnapshots(ctx) });
			try {
				await stampPresented(await deps.library(), details, { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() });
			} catch (error) {
				console.error(`library: presented files were not indexed: ${errorMessage(error)}`);
			}
			return { content: [{ type: "text", text }], details };
		},
	});

	registerArtifactsTool(pi, deps.library);
}
