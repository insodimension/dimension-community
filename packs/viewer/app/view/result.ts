// A `view_file` tool result, read as the action it stands for. The result is the
// only thing the host hands this View, so it is parsed at the boundary: a result
// that is not ours (or a server older than this View) opens nothing and says so.
import { TAB_META_KEY, tabMetaSchema, viewedFileSchema } from "../../src/contract";
import type { ViewerAction } from "./tabs";

interface ResultLike {
	readonly isError?: boolean;
	readonly content?: readonly { readonly type: string; readonly text?: string }[];
	readonly structuredContent?: unknown;
	readonly _meta?: Readonly<Record<string, unknown>>;
}

export function actionFromResult(result: ResultLike): ViewerAction {
	if (result.isError) {
		const text = (result.content ?? []).map(block => (block.type === "text" ? (block.text ?? "") : "")).join("\n").trim();
		return { type: "refused", message: text || "The file could not be opened." };
	}
	const file = viewedFileSchema.safeParse(result.structuredContent);
	if (!file.success) return { type: "refused", message: "The viewer server answered with something this View does not understand." };
	// The key the server named for the host's tab when it sent one (today it is the path); the path otherwise.
	const tab = tabMetaSchema.safeParse(result._meta?.[TAB_META_KEY]);
	return { type: "open", key: tab.success ? tab.data.key : file.data.path, file: file.data };
}
