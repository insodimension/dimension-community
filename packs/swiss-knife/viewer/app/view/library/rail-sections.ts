import type { PresentedKind } from "@dimension/sdk/presentation";
import { type FacetSection, tagFacetOptions } from "@fraym/ui/features/media-library";
import type { LibraryFacets } from "../../../../src/library/types";
import { folderName, KIND_LOOK, KIND_ORDER } from "./kinds";
import type { LibraryFilter, LibraryScope } from "./query";

export interface RailActions {
	readonly onScope: (scope: LibraryScope) => void;
	readonly onKinds: (kinds: readonly PresentedKind[]) => void;
	readonly onTag: (tag: string) => void;
	readonly onClearTags: () => void;
	readonly onWorkspace: (workspace: string | undefined) => void;
}

export const TAGS_PREVIEW = 12;

const SCOPES: readonly { readonly id: Exclude<LibraryScope, "all">; readonly label: string; readonly icon: "star" | "link" | "trash" }[] = [
	{ id: "starred", label: "Starred", icon: "star" },
	{ id: "shared", label: "Shared", icon: "link" },
	{ id: "discarded", label: "Recently discarded", icon: "trash" },
];

export function artifactSections(filter: LibraryFilter, facets: LibraryFacets | null, workspaces: LibraryFacets["workspaces"], actions: RailActions): readonly FacetSection[] {
	const kindCounts = facets?.kinds ?? {};
	let total = 0;
	for (const kind of KIND_ORDER) total += kindCounts[kind] ?? 0;
	const tagOptions = tagFacetOptions(facets?.tags ?? [], filter.tags, "hash");
	const active = filter.workspace;
	const unlisted = active !== undefined && !workspaces.some(workspace => workspace.path === active) ? [{ id: active, label: folderName(active), title: active, selected: true, pinned: true }] : [];
	return [
		{
			id: "scope",
			select: "single",
			all: { label: "All artifacts", icon: "layers", count: filter.scope === "discarded" ? undefined : total },
			options: SCOPES.map(scope => ({ id: scope.id, label: scope.label, icon: scope.icon, count: facets?.[scope.id], selected: filter.scope === scope.id })),
			onChange: (_, changed) => actions.onScope(changed === undefined ? "all" : (changed as LibraryScope)),
		},
		{
			id: "kinds",
			title: "Kinds",
			select: "multi",
			options: KIND_ORDER.filter(kind => (kindCounts[kind] ?? 0) > 0 || filter.kinds.includes(kind)).map(kind => ({
				id: kind,
				label: KIND_LOOK[kind].plural,
				icon: KIND_LOOK[kind].icon,
				count: kindCounts[kind] ?? 0,
				selected: filter.kinds.includes(kind),
			})),
			onChange: selected => actions.onKinds(selected as readonly PresentedKind[]),
		},
		{
			id: "tags",
			title: "Tags",
			select: "multi",
			options: tagOptions,
			previewLimit: TAGS_PREVIEW,
			onChange: (_, changed) => (changed === undefined ? actions.onClearTags() : actions.onTag(changed)),
		},
		{
			id: "workspaces",
			title: "Workspaces",
			select: "single",
			all: { label: "All workspaces", icon: "folder" },
			options: [
				...unlisted,
				...workspaces.map(workspace => ({ id: workspace.path, label: folderName(workspace.path), title: workspace.path, count: workspace.count, selected: active === workspace.path })),
			],
			onChange: (_, changed) => actions.onWorkspace(changed),
		},
	];
}
