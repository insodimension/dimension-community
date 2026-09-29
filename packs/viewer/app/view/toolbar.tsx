// The chrome above a document: what it is, its size, page and zoom controls, and
// copy-path. Controls appear only when the mounted renderer offers them.
import { IconButton } from "@fraym/ui/elements/icon-button";
import { Icon } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import { useEffect, useRef, useState } from "react";
import type { ViewerKind } from "../../src/contract";
import { copyText } from "./copy";
import type { AnnotateMode } from "./pane-extras";
import { formatBytes } from "./format";
import { MAX_ZOOM, MIN_ZOOM } from "./zoom";

export const KIND_LABEL: Record<ViewerKind, string> = {
	image: "Image",
	pdf: "PDF",
	html: "HTML",
	markdown: "Markdown",
	docx: "Word",
	pptx: "PowerPoint",
	xlsx: "Excel",
	text: "Text",
	binary: "File",
};

export interface ToolbarProps {
	readonly filename: string;
	readonly path: string;
	readonly kind: ViewerKind;
	readonly size: number;
	/** Set when only the head of a large text file was read. */
	readonly shownBytes?: number;
	readonly zoom?: { readonly factor: number; readonly onStep: (direction: "in" | "out") => void; readonly onReset: () => void };
	/** The markup toggle: shown only when a layer on top of the viewer offers modes for this kind. */
	readonly modes?: { readonly available: readonly AnnotateMode[]; readonly mode: AnnotateMode | null; readonly onChange: (mode: AnnotateMode | null) => void };
	readonly pager?: { readonly page: number; readonly count: number; readonly onGoto: (page: number) => void };
}

const MODE_LABEL: Record<AnnotateMode, string> = { marks: "Markup", comments: "Comment" };

export function Toolbar({ filename, path, kind, size, shownBytes, zoom, pager, modes }: ToolbarProps) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(timer.current), []);
	const copy = () => {
		void copyText(path).then(ok => {
			if (!ok) return;
			setCopied(true);
			window.clearTimeout(timer.current);
			timer.current = window.setTimeout(() => setCopied(false), 1800);
		});
	};
	return (
		<div data-slot="viewer-toolbar" className="flex h-10 shrink-0 items-center gap-3 border-b border-fr-border-soft px-3">
			<span className="shrink-0 rounded-sm bg-fr-surface-3 px-1.5 py-0.5 text-fr-2xs font-medium text-fr-text-2">{KIND_LABEL[kind]}</span>
			<span className="min-w-0 flex-1 truncate text-fr-sm text-fr-text" title={path}>
				{filename}
			</span>
			<span className="shrink-0 text-fr-xs text-fr-text-3">
				{formatBytes(size)}
				{shownBytes === undefined ? "" : ` · showing the first ${formatBytes(shownBytes)}`}
			</span>
			{modes ? (
				<div className="flex shrink-0 items-center gap-0.5 rounded-md bg-fr-surface p-0.5" role="group" aria-label="Markup">
					{modes.available.map(option => (
						<button
							key={option}
							type="button"
							aria-pressed={modes.mode === option}
							onClick={() => modes.onChange(modes.mode === option ? null : option)}
							className={cn(
								"rounded-sm px-2 py-0.5 text-fr-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fr-accent-line",
								modes.mode === option ? "bg-fr-accent-dim text-fr-accent-text" : "text-fr-text-2 hover:text-fr-text",
							)}
						>
							{MODE_LABEL[option]}
						</button>
					))}
				</div>
			) : null}
			{pager ? (
				<div className="flex shrink-0 items-center gap-1" role="group" aria-label="Pages">
					<IconButton className="size-7" aria-label="Previous page" title="Previous page" disabled={pager.page <= 1} onClick={() => pager.onGoto(pager.page - 1)}>
						<Icon name="arrowU" size={14} />
					</IconButton>
					<span className="min-w-12 text-center text-fr-xs tabular-nums text-fr-text-2">
						{pager.page} / {pager.count}
					</span>
					<IconButton className="size-7" aria-label="Next page" title="Next page" disabled={pager.page >= pager.count} onClick={() => pager.onGoto(pager.page + 1)}>
						<Icon name="arrowD" size={14} />
					</IconButton>
				</div>
			) : null}
			{zoom ? (
				<div className="flex shrink-0 items-center gap-1" role="group" aria-label="Zoom">
					<IconButton className="size-7" aria-label="Zoom out" title="Zoom out" disabled={zoom.factor <= MIN_ZOOM} onClick={() => zoom.onStep("out")}>
						<Icon name="minus" size={14} />
					</IconButton>
					<button
						type="button"
						className="min-w-11 rounded-md px-1 py-1 text-center text-fr-xs tabular-nums text-fr-text-2 hover:bg-fr-surface hover:text-fr-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fr-accent-line"
						title="Reset zoom"
						aria-label={`Zoom ${Math.round(zoom.factor * 100)} percent. Reset zoom`}
						onClick={zoom.onReset}
					>
						{Math.round(zoom.factor * 100)}%
					</button>
					<IconButton className="size-7" aria-label="Zoom in" title="Zoom in" disabled={zoom.factor >= MAX_ZOOM} onClick={() => zoom.onStep("in")}>
						<Icon name="plus" size={14} />
					</IconButton>
				</div>
			) : null}
			<IconButton className="size-7" aria-label={copied ? "Path copied" : "Copy path"} title={copied ? "Path copied" : "Copy path"} onClick={copy}>
				<Icon name={copied ? "check" : "copy"} size={14} />
			</IconButton>
		</div>
	);
}
