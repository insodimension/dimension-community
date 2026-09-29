// The View's root: an optional tab strip, a notice line, and one pane per open
// document. The root is `position: relative` and owns the whole frame, so a layer
// that must cover the viewer (the annotation overlay the annotation slice adds)
// mounts as a sibling of the panes inside `data-slot="viewer-root"`.
import type { App } from "@modelcontextprotocol/ext-apps";
import { Icon } from "@fraym/ui/icons";
import { DocPane } from "./doc-pane";
import type { Theme } from "./renderers/types";
import { TabStrip } from "./tab-strip";
import { type ViewerStore, useViewerState } from "./tabs";

export function ViewerApp({ app, store }: { readonly app: App; readonly store: ViewerStore }) {
	const state = useViewerState(store);
	const theme: Theme = app.getHostContext()?.theme === "light" ? "light" : "dark";
	return (
		<div data-slot="viewer-root" className="relative flex h-full min-h-0 flex-col bg-fr-bg text-fr-text">
			{state.tabs.length > 1 ? (
				<TabStrip
					tabs={state.tabs}
					activeKey={state.activeKey}
					onActivate={key => store.dispatch({ type: "activate", key })}
					onClose={key => store.dispatch({ type: "close", key })}
				/>
			) : null}
			{state.notice !== null ? (
				<div role="alert" className="flex shrink-0 items-start gap-2 border-b border-fr-del-line bg-fr-del-bg px-3 py-2 text-fr-sm text-fr-del">
					<span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{state.notice}</span>
					<button type="button" aria-label="Dismiss" onClick={() => store.dispatch({ type: "dismiss" })} className="shrink-0 rounded-sm p-0.5 hover:bg-fr-surface-3">
						<Icon name="x" size={13} />
					</button>
				</div>
			) : null}
			<div className="relative min-h-0 flex-1">
				{state.tabs.length === 0 ? (
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center">
						<p className="text-fr-md font-semibold text-fr-text">Nothing open</p>
						<p className="max-w-[40ch] text-fr-sm text-fr-text-3">Ask the assistant to open a file and it appears here.</p>
					</div>
				) : null}
				{state.tabs.map(tab => (
					<div key={tab.key} className={tab.key === state.activeKey ? "absolute inset-0" : "hidden"}>
						<DocPane app={app} tab={tab} active={tab.key === state.activeKey} theme={theme} />
					</div>
				))}
			</div>
		</div>
	);
}
