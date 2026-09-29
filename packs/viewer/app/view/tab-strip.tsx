// Document tabs inside the View. Shown only while more than one document is open:
// with one, the host's own tab already names it.
import { Icon } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import type { DocTab } from "./tabs";

export interface TabStripProps {
	readonly tabs: readonly DocTab[];
	readonly activeKey: string | null;
	readonly onActivate: (key: string) => void;
	readonly onClose: (key: string) => void;
}

export function TabStrip({ tabs, activeKey, onActivate, onClose }: TabStripProps) {
	return (
		<div role="tablist" aria-label="Open documents" data-slot="viewer-tabs" className="flex h-9 shrink-0 items-stretch gap-px overflow-x-auto border-b border-fr-border-soft bg-fr-rail px-1.5">
			{tabs.map(tab => {
				const active = tab.key === activeKey;
				return (
					<div
						key={tab.key}
						role="presentation"
						className={cn(
							"group flex min-w-0 max-w-56 items-center gap-1 rounded-t-md border-x border-t border-transparent pl-2 pr-1 text-fr-sm",
							active ? "border-fr-border-soft bg-fr-bg text-fr-text" : "text-fr-text-3 hover:text-fr-text-2",
						)}
					>
						<button
							type="button"
							role="tab"
							aria-selected={active}
							title={tab.path}
							onClick={() => onActivate(tab.key)}
							className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fr-accent-line"
						>
							<Icon name={tab.kind === "image" ? "image" : "file"} size={13} />
							<span className="truncate">{tab.filename}</span>
						</button>
						<button
							type="button"
							aria-label={`Close ${tab.filename}`}
							title="Close"
							onClick={() => onClose(tab.key)}
							className="flex size-5 shrink-0 items-center justify-center rounded-sm text-fr-text-3 opacity-0 hover:bg-fr-surface-3 hover:text-fr-text focus-visible:opacity-100 group-hover:opacity-100 data-[active=true]:opacity-100"
							data-active={active}
						>
							<Icon name="x" size={12} />
						</button>
					</div>
				);
			})}
		</div>
	);
}
