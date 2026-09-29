// One open document: loads its bytes, mounts the renderer for its kind into a
// stage the renderer owns, and draws the toolbar and the loading/error states
// around it. Every open document keeps its own pane mounted (the inactive ones
// hidden), so switching tabs keeps zoom and scroll and streams nothing again.
//
// The stage wrapper is `position: relative`; the stage itself fills it. Anything
// layered over the rendered page (markup, comments) comes in through
// `./pane-extras` and is a sibling of the stage inside that wrapper
// (`data-slot="viewer-stage-frame"`), or the right-hand column after it.
import type { App } from "@modelcontextprotocol/ext-apps";
import { useEffect, useState } from "react";
import { loadDocumentBytes, readLimit } from "./document-bytes";
import { formatBytes } from "./format";
import { loadRenderer } from "./renderers";
import type { Mounted, Theme } from "./renderers/types";
import { type AnnotateMode, annotationModes, PaneExtras } from "./pane-extras";
import type { DocTab } from "./tabs";
import { KIND_LABEL, Toolbar } from "./toolbar";
import { stepZoom } from "./zoom";

type Phase =
	| { readonly name: "loading"; readonly loaded: number; readonly total: number }
	| { readonly name: "ready" }
	| { readonly name: "unavailable" }
	| { readonly name: "error"; readonly message: string };

export interface DocPaneProps {
	readonly app: App;
	readonly tab: DocTab;
	readonly active: boolean;
	readonly theme: Theme;
}

export function DocPane({ app, tab, active, theme }: DocPaneProps) {
	// State, not `useRef`: a layer on top needs to RE-RENDER when the stage or the
	// mounted renderer appears, and a ref change re-renders nothing.
	const [stage, setStage] = useState<HTMLDivElement | null>(null);
	const [frame, setFrame] = useState<HTMLDivElement | null>(null);
	const [mounted, setMounted] = useState<Mounted | null>(null);
	const [phase, setPhase] = useState<Phase>({ name: "loading", loaded: 0, total: tab.size });
	const [zoom, setZoom] = useState(1);
	const [page, setPage] = useState(1);
	const [retry, setRetry] = useState(0);
	const [mode, setMode] = useState<AnnotateMode | null>(null);
	const limit = readLimit(tab);
	const truncated = limit !== undefined && tab.size > limit;
	const modes = annotationModes(tab.kind);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `retry` is a retrigger token, and a changed file arrives as a new `revision`.
	useEffect(() => {
		if (stage === null) return;
		const controller = new AbortController();
		let handle: Mounted | undefined;
		setPhase({ name: "loading", loaded: 0, total: tab.size });
		setZoom(1);
		setPage(1);

		(async () => {
			try {
				const renderer = await loadRenderer(tab.kind);
				if (controller.signal.aborted) return;
				if (renderer === null) {
					setPhase({ name: "unavailable" });
					return;
				}
				const { bytes } = await loadDocumentBytes(app, tab, {
					signal: controller.signal,
					onProgress: (done, total) => setPhase({ name: "loading", loaded: done, total }),
				});
				if (controller.signal.aborted) return;
				handle = await renderer.mount(stage, bytes, {
					filename: tab.filename,
					theme,
					onPage: setPage,
					openLink: url => {
						void app.openLink({ url }).catch(() => undefined);
					},
				});
				if (controller.signal.aborted) {
					handle.destroy();
					return;
				}
				setMounted(handle);
				setPhase({ name: "ready" });
			} catch (error) {
				if (controller.signal.aborted) return;
				setPhase({ name: "error", message: error instanceof Error ? error.message : String(error) });
			}
		})();

		return () => {
			controller.abort();
			handle?.destroy();
			setMounted(null);
			stage.replaceChildren();
		};
	}, [app, stage, tab.key, tab.revision, tab.kind, tab.path, tab.filename, tab.size, tab.mtimeMs, theme, retry]);

	const pages = mounted?.goto !== undefined && mounted.pageCount !== undefined && mounted.pageCount > 1 ? mounted.pageCount : 0;
	const applyZoom = (next: number) => {
		setZoom(next);
		mounted?.zoom?.(next);
	};
	const goto = (next: number) => {
		setPage(next);
		mounted?.goto?.(next);
	};

	return (
		<div className={active ? "flex h-full min-h-0 flex-col" : "hidden"} data-slot="viewer-pane" data-key={tab.key} data-annotate={mode ?? undefined}>
			<Toolbar
				filename={tab.filename}
				path={tab.path}
				kind={tab.kind}
				size={tab.size}
				shownBytes={truncated ? limit : undefined}
				zoom={mounted?.zoom ? { factor: zoom, onStep: direction => applyZoom(stepZoom(zoom, direction)), onReset: () => applyZoom(1) } : undefined}
				pager={pages > 1 ? { page, count: pages, onGoto: goto } : undefined}
				modes={phase.name === "ready" && modes.length > 0 ? { available: modes, mode, onChange: setMode } : undefined}
			/>
			<div className="flex min-h-0 flex-1">
				<div className="relative min-h-0 min-w-0 flex-1" data-slot="viewer-stage-frame" ref={setFrame}>
					<div ref={setStage} className="absolute inset-0 overflow-hidden" data-slot="viewer-stage" />
					{phase.name === "loading" ? <Loading loaded={phase.loaded} total={phase.total} /> : null}
					{phase.name === "unavailable" ? (
						<Message title="Preview not available" body={`${KIND_LABEL[tab.kind]} files cannot be previewed in this build of the viewer.`} />
					) : null}
					{phase.name === "error" ? (
						<Message title="This file could not be shown" body={phase.message} action={{ label: "Try again", onClick: () => setRetry(count => count + 1) }} />
					) : null}
				</div>
				<PaneExtras app={app} tab={tab} active={active} ready={phase.name === "ready"} frame={frame} mode={mode} onMode={setMode} />
			</div>
		</div>
	);
}

function Loading({ loaded, total }: { readonly loaded: number; readonly total: number }) {
	const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
	return (
		<div role="status" aria-live="polite" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-fr-bg">
			<div className="h-1 w-40 overflow-hidden rounded-full bg-fr-surface-3">
				<div className="h-full rounded-full bg-fr-accent transition-[width]" style={{ width: `${percent}%` }} />
			</div>
			<p className="text-fr-xs text-fr-text-3">{total >= 512 * 1024 ? `Loading ${formatBytes(loaded)} of ${formatBytes(total)}` : "Loading"}</p>
		</div>
	);
}

function Message({ title, body, action }: { readonly title: string; readonly body: string; readonly action?: { readonly label: string; readonly onClick: () => void } }) {
	return (
		<div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-fr-bg px-6 text-center">
			<p className="text-fr-md font-semibold text-fr-text">{title}</p>
			<p className="max-w-[44ch] text-fr-sm text-fr-text-3 [overflow-wrap:anywhere]">{body}</p>
			{action ? (
				<button
					type="button"
					onClick={action.onClick}
					className="mt-2 rounded-md border border-fr-border px-3 py-1.5 text-fr-sm text-fr-text-2 hover:bg-fr-surface hover:text-fr-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fr-accent-line"
				>
					{action.label}
				</button>
			) : null}
		</div>
	);
}
