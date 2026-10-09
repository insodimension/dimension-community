// The tab strip: every tab this browser owns, in opening order. The active
// tab rises out of the strip into the toolbar surface; the others sit on the
// frame and separate with hairlines that vanish next to hover and selection.
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { TabInfo } from "../../src/contracts";
import { Icon } from "@fraym/ui/icons";
import { tabLabel } from "../../src/address";

export interface TabStripProps {
	readonly tabs: readonly TabInfo[];
	readonly activeTabId: string;
	/** An agent drives: tab switching is refused by the runtime, so it is here too. */
	readonly locked: boolean;
	readonly onActivate: (tabId: string) => void;
	readonly onClose: (tabId: string) => void;
	readonly onNew: () => void;
}

export function TabStrip({ tabs, activeTabId, locked, onActivate, onClose, onNew }: TabStripProps) {
	const listRef = useRef<HTMLDivElement | null>(null);

	// Keep the active tab in view when it changes (a site opened a tab, Ctrl+Tab).
	useEffect(() => {
		const list = listRef.current;
		const active = list?.querySelector<HTMLElement>('[aria-selected="true"]');
		active?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [activeTabId, tabs.length]);

	// Which edge is clipped, so the strip can fade it.
	const [overflow, setOverflow] = useState<"none" | "start" | "end" | "both">("none");
	const measure = () => {
		const list = listRef.current;
		if (!list) return;
		const hidden = list.scrollWidth - list.clientWidth;
		const next = hidden <= 1 ? "none" : list.scrollLeft <= 1 ? "end" : list.scrollLeft >= hidden - 1 ? "start" : "both";
		setOverflow(current => (current === next ? current : next));
	};
	useEffect(() => {
		measure();
		const list = listRef.current;
		if (!list) return;
		const observer = new ResizeObserver(measure);
		observer.observe(list);
		return () => observer.disconnect();
	}, [tabs.length]);

	// Roving focus inside the tablist, as WAI-ARIA tabs expect.
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const index = tabs.findIndex(tab => tab.id === activeTabId);
		if (index < 0) return;
		let next = -1;
		if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
		else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
		else if (event.key === "Home") next = 0;
		else if (event.key === "End") next = tabs.length - 1;
		else if (event.key === "Delete") {
			event.preventDefault();
			onClose(activeTabId);
			return;
		}
		if (next < 0 || locked) return;
		event.preventDefault();
		onActivate(tabs[next].id);
		listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
	};

	return (
		<div className="bx-strip">
			<div
				ref={listRef}
				className="bx-tabs"
				role="tablist"
				aria-label="Tabs"
				data-overflow={overflow}
				onKeyDown={onKeyDown}
				onScroll={measure}
				onWheel={event => {
					// A vertical wheel over the strip scrolls it sideways, as in Chrome.
					const list = event.currentTarget;
					if (list.scrollWidth > list.clientWidth && event.deltaY !== 0 && event.deltaX === 0) list.scrollLeft += event.deltaY;
				}}
			>
				{tabs.map(tab => {
					const active = tab.id === activeTabId;
					const label = tabLabel(tab.title, tab.url);
					return (
						<div
							key={tab.id}
							className="bx-tab"
							role="tab"
							aria-selected={active}
							aria-disabled={locked && !active ? true : undefined}
							tabIndex={active ? 0 : -1}
							title={tab.url.length > 0 ? `${label}\n${tab.url}` : label}
							data-loading={tab.loading || undefined}
							onMouseDown={event => {
								if (event.button === 1) event.preventDefault();
							}}
							onClick={() => {
								if (!active && !locked) onActivate(tab.id);
							}}
							onAuxClick={event => {
								if (event.button === 1 && !locked) onClose(tab.id);
							}}
						>
							<span className="bx-tab-icon" aria-hidden="true">
								{tab.loading ? (
									<span className="bx-tab-spinner" />
								) : tab.favicon !== null ? (
									<img src={tab.favicon} alt="" width={16} height={16} draggable={false} />
								) : (
									<Icon name="globe" size={14} strokeWidth={1.75} />
								)}
							</span>
							<span className="bx-tab-title">{label}</span>
							<button
								type="button"
								className="bx-tab-close"
								aria-label={`Close ${label}`}
								tabIndex={-1}
								disabled={locked}
								onClick={event => {
									event.stopPropagation();
									onClose(tab.id);
								}}
							>
								<Icon name="x" size={12} strokeWidth={2.25} />
							</button>
						</div>
					);
				})}
			</div>
			<button type="button" className="bx-newtab" aria-label="New tab (Ctrl+T)" title="New tab  Ctrl+T" disabled={locked} onClick={onNew}>
				<Icon name="plus" size={15} strokeWidth={2} />
			</button>
			<div className="bx-strip-drag" aria-hidden="true" />
		</div>
	);
}
