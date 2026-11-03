import { formatDuration } from "@dimension/sdk/artifact-share";
import { hasTag, LibraryCell, type LibraryChip, LibraryRow, MediaPreview } from "@fraym/ui/features/media-library";
import { Icon } from "@fraym/ui/icons";
import { memo, useMemo } from "react";
import type { LibraryItem } from "../../../../src/library/types";
import { formatBytes } from "../format";
import { KIND_LOOK, relativeAge } from "./kinds";
import { liveShares, unreadCount } from "./query";

export interface ItemViewProps {
	readonly item: LibraryItem;
	readonly selected: boolean;
	readonly thumb: string | null;
	readonly now: number;
	readonly activeTags: readonly string[];
	readonly onTag: (tag: string) => void;
}

export function ThumbOrIcon({ item, thumb, iconSize, fit = "cover" }: { readonly item: LibraryItem; readonly thumb: string | null; readonly iconSize: number; readonly fit?: "cover" | "contain" }) {
	return <MediaPreview thumb={thumb} fit={fit} fallback={<Icon name={KIND_LOOK[item.kind].icon} size={iconSize} strokeWidth={1.5} />} />;
}

function Badges({ item }: { readonly item: LibraryItem }) {
	const unread = unreadCount(item);
	const shared = liveShares(item) > 0;
	return (
		<>
			{item.state === "missing" ? (
				<span title="The file is no longer where it was" className="flex items-center text-fr-warn">
					<Icon name="warnTri" size={12} />
				</span>
			) : null}
			{item.starred ? (
				<span title="Starred" className="flex items-center text-fr-accent">
					<Icon name="star" size={12} filled />
				</span>
			) : null}
			{shared ? (
				<span title="Shared" className="flex items-center text-fr-text-3">
					<Icon name="link" size={12} />
				</span>
			) : null}
			{unread > 0 ? (
				<span title={`${unread} new comment${unread === 1 ? "" : "s"}`} className="rounded-full bg-fr-accent px-1.5 text-fr-2xs font-semibold leading-4 text-fr-accent-ink tabular-nums">
					{unread}
				</span>
			) : null}
		</>
	);
}

function metaLine(item: LibraryItem, now: number): string {
	const parts = [KIND_LOOK[item.kind].label, formatBytes(item.size)];
	if (item.durationMs !== undefined) parts.push(formatDuration(item.durationMs));
	parts.push(relativeAge(item.state === "discarded" && item.discardedAt !== undefined ? item.discardedAt : item.presentedAt, now));
	return parts.join(" · ");
}

function useTagChips(tags: readonly string[], activeTags: readonly string[], onTag: (tag: string) => void): readonly LibraryChip[] {
	return useMemo(() => tags.map(tag => ({ id: tag, label: tag, active: hasTag(activeTags, tag), onToggle: () => onTag(tag) })), [tags, activeTags, onTag]);
}

export const GridCell = memo(function GridCell({ item, selected, thumb, now, activeTags, onTag }: ItemViewProps) {
	const chips = useTagChips(item.tags, activeTags, onTag);
	const timed = item.kind === "video" && item.durationMs !== undefined;
	return (
		<LibraryCell
			selected={selected}
			state={item.state}
			dimmed={item.state === "missing"}
			media={<ThumbOrIcon item={item} thumb={thumb} iconSize={30} />}
			mediaBadge={timed ? formatDuration(item.durationMs) : undefined}
			chips={chips}
			title={item.title ?? item.name}
			titleHint={item.note === undefined ? item.path : `${item.note}\n${item.path}`}
			badges={<Badges item={item} />}
			meta={metaLine(item, now)}
		/>
	);
});

export const ListRow = memo(function ListRow({ item, selected, thumb, now, activeTags, onTag }: ItemViewProps) {
	const chips = useTagChips(item.tags, activeTags, onTag);
	return (
		<LibraryRow
			selected={selected}
			state={item.state}
			dimmed={item.state === "missing"}
			media={<ThumbOrIcon item={item} thumb={thumb} iconSize={15} />}
			chips={chips}
			title={item.title ?? item.name}
			titleHint={item.note}
			subtitle={item.path}
			subtitleHint={item.path}
			badges={<Badges item={item} />}
			meta={metaLine(item, now)}
		/>
	);
});
