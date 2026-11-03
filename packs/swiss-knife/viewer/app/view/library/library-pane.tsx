import { Button } from "@fraym/ui/elements/button";
import { IconButton } from "@fraym/ui/elements/icon-button";
import { Kbd } from "@fraym/ui/elements/kbd";
import { Select } from "@fraym/ui/elements/select";
import { FacetRail, LibraryGrid, type LibraryLayout, type RowRange, toggleTag, wantsNextPage } from "@fraym/ui/features/media-library";
import { Icon } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import type { App } from "@modelcontextprotocol/ext-apps";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { DiscardOutcome, LibraryFacets, LibraryItem, LibrarySort, ShareSummary } from "../../../../src/library/types";
import { FOCUS } from "../focus-ring";
import type { Theme } from "../renderers/types";
import type { LibraryTab } from "../tabs";
import { AddFileDialog } from "./add-file-dialog";
import { ArtifactSurface, useMinuteClock } from "./artifact-surface";
import { DiscardDialog, TRASH_NAME } from "./discard-dialog";
import { GridCell, ListRow } from "./library-item";
import { LibraryToast } from "./library-toast";
import { type ArtifactPatchInput, createLibraryTools, errorText, thumbUrl } from "./library-tools";
import { drawPoster, posterCandidate } from "./poster-draw";
import { PosterQueue } from "./poster-queue";
import {
	checkBatches,
	DEFAULT_FILTER,
	filterKey,
	INITIAL_LIST,
	type LibraryFilter,
	type LibraryScope,
	queryArgs,
	reduceList,
	SEARCH_DEBOUNCE_MS,
	shownItem,
} from "./query";
import { artifactSections } from "./rail-sections";
import { useLibraryRefresh } from "./use-library-refresh";

export interface LibraryPaneProps {
	readonly app: App;
	readonly request: LibraryTab;
	readonly active: boolean;
	readonly theme: Theme;
}

type Dialog = { readonly kind: "discard"; readonly item: LibraryItem } | { readonly kind: "add" } | null;

const SORT_LABEL: Record<LibrarySort, string> = {
	relevance: "Best match",
	recent: "Recently presented",
	opened: "Recently opened",
	name: "Name",
	size: "Size",
};

const SCOPE_EMPTY: Record<LibraryScope, { readonly title: string; readonly body: string }> = {
	all: { title: "Your library is empty", body: "Artifacts appear here when an agent presents a file. Add one: paste a file’s path." },
	starred: { title: "Nothing starred yet", body: "Select an artifact and press S to keep it here." },
	shared: { title: "Nothing shared yet", body: "Open an artifact and choose Share to send someone an encrypted link." },
	discarded: { title: "Nothing discarded", body: "Discarded artifacts wait here for 30 days so you can restore them." },
};

const COMPACT_WIDTH = 760;
const CHECK_FRESH_MS = 60_000;
const CHECK_BATCH = 200;
const CHECK_THROTTLE_MS = 300;
const PAGE_LOOKAHEAD_ROWS = 12;
const GRID_KEYS = ["s", "Delete", "Escape"] as const;

function filterFrom(request: LibraryTab): LibraryFilter {
	return { ...DEFAULT_FILTER, q: request.query ?? "", workspace: request.workspace };
}

function discardedSentence(result: DiscardOutcome): string {
	const parts = ["Discarded"];
	if (result.revoked > 0) parts.push(result.revoked === 1 ? "its link no longer works" : `its ${result.revoked} links no longer work`);
	const unrevoked = result.unrevoked.length;
	if (unrevoked > 0) parts.push(unrevoked === 1 ? "one link could not be stopped and may still open until it expires" : `${unrevoked} links could not be stopped and may still open until they expire`);
	if (result.trashed) parts.push(`the file is in the ${TRASH_NAME}`);
	else if (result.trashError !== undefined) parts.push(`the file was not moved to the ${TRASH_NAME}: ${result.trashError}`);
	return `${parts.join("; ")}.`;
}

export function LibraryPane({ app, request, active, theme }: LibraryPaneProps) {
	const tools = useMemo(() => createLibraryTools(app), [app]);
	const now = useMinuteClock();
	const root = useRef<HTMLDivElement>(null);
	const search = useRef<HTMLInputElement>(null);
	const [width, setWidth] = useState(0);
	const [filter, setFilter] = useState<LibraryFilter>(() => filterFrom(request));
	const [draft, setDraft] = useState(request.query ?? "");
	const [generation, setGeneration] = useState(0);
	const [facetsGeneration, setFacetsGeneration] = useState(0);
	const [list, dispatch] = useReducer(reduceList, INITIAL_LIST);
	const [layout, setLayout] = useState<LibraryLayout>("grid");
	const [facets, setFacets] = useState<LibraryFacets | null>(null);
	const [workspaces, setWorkspaces] = useState<LibraryFacets["workspaces"]>([]);
	const [thumbBase, setThumbBase] = useState<string | null>(null);
	const [bumps, setBumps] = useState<Readonly<Record<string, number>>>({});
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [page, setPage] = useState<LibraryItem | null>(null);
	const [dialog, setDialog] = useState<Dialog>(null);
	const [railOpen, setRailOpen] = useState(false);
	const [toast, setToast] = useState<string | null>(null);

	const listRef = useRef(list);
	listRef.current = list;
	const filterRef = useRef(filter);
	filterRef.current = filter;
	const seenRef = useRef<RowRange>({ first: 0, end: 0 });
	const inflightCursor = useRef<string | null>(null);
	const moreController = useRef<AbortController | null>(null);
	const checkTimer = useRef(0);
	const checkedAt = useRef<Record<string, number>>({});

	useLayoutEffect(() => {
		const element = root.current;
		if (element === null) return;
		const measure = (): void => setWidth(element.clientWidth);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const compact = width > 0 && width < COMPACT_WIDTH;

	const seenRequest = useRef(request.requests);
	useEffect(() => {
		if (request.requests === seenRequest.current) return;
		seenRequest.current = request.requests;
		setFilter(current => ({ ...current, q: request.query ?? "", workspace: request.workspace }));
		setDraft(request.query ?? "");
		setGeneration(count => count + 1);
	}, [request]);

	useEffect(() => {
		if (draft === filter.q) return;
		const timer = window.setTimeout(() => setFilter(current => ({ ...current, q: draft })), SEARCH_DEBOUNCE_MS);
		return () => window.clearTimeout(timer);
	}, [draft, filter.q]);

	useEffect(() => {
		const key = filterKey(filter, generation);
		dispatch({ type: "request", key });
		const controller = new AbortController();
		tools.query(queryArgs(filter), controller.signal).then(
			page => dispatch({ type: "page", key, page, append: false }),
			cause => {
				if (!controller.signal.aborted) dispatch({ type: "failed", key, error: errorText(cause) });
			},
		);
		return () => {
			controller.abort();
			moreController.current?.abort();
			inflightCursor.current = null;
		};
	}, [tools, filter, generation]);

	const facetState = filter.scope === "discarded" ? "discarded" : "live";
	useEffect(() => {
		const controller = new AbortController();
		const scoped = tools.facets({ ...(filter.workspace === undefined ? {} : { workspace: filter.workspace }), state: facetState }, controller.signal);
		const everywhere = filter.workspace === undefined && facetState === "live" ? scoped : tools.facets({ state: "live" }, controller.signal);
		Promise.all([scoped, everywhere]).then(
			([here, all]) => {
				setFacets(here);
				setWorkspaces(all.workspaces);
			},
			() => undefined,
		);
		return () => controller.abort();
	}, [tools, filter.workspace, facetState, facetsGeneration]);

	const refreshFacets = useCallback((): void => setFacetsGeneration(count => count + 1), []);
	useLibraryRefresh(tools, filter, list, dispatch, refreshFacets, active);

	useEffect(() => {
		let live = true;
		tools.thumbsBase().then(
			base => {
				if (live) setThumbBase(base);
			},
			() => undefined,
		);
		return () => {
			live = false;
		};
	}, [tools]);

	const posters = useMemo(
		() =>
			new PosterQueue<LibraryItem>(async (item, signal) => {
				const encoded = await drawPoster(app, item, signal);
				signal.throwIfAborted();
				await tools.setThumb(item.id, encoded.data, encoded.mime);
				setBumps(current => ({ ...current, [item.id]: (current[item.id] ?? 0) + 1 }));
				dispatch({ type: "thumb", id: item.id });
			}),
		[app, tools],
	);
	useEffect(() => () => posters.dispose(), [posters]);
	useEffect(() => () => window.clearTimeout(checkTimer.current), []);

	const loadMore = useCallback((): void => {
		const current = listRef.current;
		const key = current.key;
		const cursor = current.next;
		if (key === null || cursor === undefined || current.phase !== "ready" || current.refreshing || inflightCursor.current === cursor) return;
		inflightCursor.current = cursor;
		dispatch({ type: "more", key });
		const controller = new AbortController();
		moreController.current = controller;
		tools.query(queryArgs(filterRef.current, cursor), controller.signal).then(
			page => {
				inflightCursor.current = null;
				dispatch({ type: "page", key, page, append: true });
			},
			cause => {
				inflightCursor.current = null;
				if (!controller.signal.aborted) dispatch({ type: "failed", key, error: errorText(cause) });
			},
		);
	}, [tools]);

	const scheduleCheck = useCallback((): void => {
		if (checkTimer.current !== 0) return;
		checkTimer.current = window.setTimeout(() => {
			checkTimer.current = 0;
			const { items } = listRef.current;
			const seen = seenRef.current;
			const ids: string[] = [];
			for (let index = seen.first; index < seen.end; index++) {
				const item = items[index];
				if (item !== undefined && item.state !== "discarded") ids.push(item.id);
			}
			const at = Date.now();
			for (const batch of checkBatches(ids, checkedAt.current, at, CHECK_FRESH_MS, CHECK_BATCH)) {
				for (const id of batch) checkedAt.current[id] = at;
				tools.check(batch).then(
					rows => dispatch({ type: "checked", rows }),
					() => {
						for (const id of batch) delete checkedAt.current[id];
					},
				);
			}
		}, CHECK_THROTTLE_MS);
	}, [tools]);

	const onRange = useCallback(
		(mounted: RowRange, seen: RowRange, geometry: { readonly columns: number }): void => {
			seenRef.current = seen;
			const current = listRef.current;
			if (wantsNextPage(mounted.end, current.items.length, current.next !== undefined, geometry.columns * PAGE_LOOKAHEAD_ROWS)) loadMore();
			scheduleCheck();
			const wanted: LibraryItem[] = [];
			for (let index = seen.first; index < seen.end; index++) {
				const item = current.items[index];
				if (item !== undefined && posterCandidate(shownItem(item, current.checked))) wanted.push(item);
			}
			posters.want(wanted);
		},
		[loadMore, scheduleCheck, posters],
	);

	const selectedIndex = useMemo(() => (selectedId === null ? -1 : list.items.findIndex(item => item.id === selectedId)), [list.items, selectedId]);
	const pageRow = page === null ? undefined : (list.items.find(item => item.id === page.id) ?? page);
	const pageShown = pageRow === undefined ? null : shownItem(pageRow, list.checked);

	const thumbFor = useCallback(
		(item: LibraryItem): string | null => (item.hasThumb && thumbBase !== null ? thumbUrl(thumbBase, item, bumps[item.id] ?? 0) : null),
		[thumbBase, bumps],
	);

	const openPage = useCallback((item: LibraryItem): void => {
		setSelectedId(item.id);
		setPage(item);
	}, []);

	const patched = useCallback((updated: LibraryItem, change: ArtifactPatchInput): void => {
		dispatch({ type: "item", item: updated });
		setPage(current => (current?.id === updated.id ? updated : current));
		if (change.starred !== undefined || change.tags !== undefined) setFacetsGeneration(count => count + 1);
	}, []);

	const patch = useCallback(
		(item: LibraryItem, change: ArtifactPatchInput): void => {
			tools.update(item.id, change).then(
				updated => patched(updated, change),
				cause => setToast(errorText(cause)),
			);
		},
		[tools, patched],
	);

	const restored = useCallback((item: LibraryItem): void => {
		dispatch({ type: "remove", id: item.id });
		setPage(current => (current?.id === item.id ? item : current));
		setFacetsGeneration(count => count + 1);
		setToast("Restored to the library.");
	}, []);

	const discarded = (item: LibraryItem, result: DiscardOutcome): void => {
		const at = list.items.findIndex(each => each.id === item.id);
		if (selectedId === item.id) setSelectedId(list.items[at + 1]?.id ?? list.items[at - 1]?.id ?? null);
		if (page?.id === item.id) setPage(null);
		dispatch({ type: "remove", id: item.id });
		setFacetsGeneration(count => count + 1);
		setToast(discardedSentence(result));
	};

	const patchItemShares = useCallback((id: string, change: (shares: readonly ShareSummary[]) => readonly ShareSummary[]): void => {
		const current = listRef.current.items.find(item => item.id === id);
		if (current !== undefined) dispatch({ type: "item", item: { ...current, shares: change(current.shares) } });
		setPage(shown => (shown?.id === id ? { ...shown, shares: change(shown.shares) } : shown));
	}, []);

	const setScope = (scope: LibraryScope): void => {
		setFilter(current => ({ ...current, scope }));
		setRailOpen(false);
	};

	const onGridKey = (key: string, index: number): void => {
		const item = index >= 0 ? list.items[index] : undefined;
		if (key === "Escape") {
			setSelectedId(null);
			return;
		}
		if (item === undefined || item.state === "discarded") return;
		if (key === "s") patch(item, { starred: !item.starred });
		else setDialog({ kind: "discard", item });
	};

	const onRootKey = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (page !== null || dialog !== null || event.defaultPrevented) return;
		const target = event.target as HTMLElement;
		const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
		if (event.key === "/" && !typing) {
			event.preventDefault();
			search.current?.focus();
			search.current?.select();
			return;
		}
		if (event.key === "Escape" && !typing && selectedId !== null) {
			event.preventDefault();
			setSelectedId(null);
		}
	};

	const focusGrid = (): void => {
		root.current?.querySelector<HTMLElement>('[data-slot="library-grid"]')?.focus();
		if (selectedId === null && list.items[0] !== undefined) setSelectedId(list.items[0].id);
	};

	const onTag = useCallback((tag: string): void => setFilter(current => ({ ...current, tags: toggleTag(current.tags, tag) })), []);

	const renderItem = (item: LibraryItem, _index: number, isSelected: boolean) => {
		const shown = shownItem(item, list.checked);
		const Cell = layout === "grid" ? GridCell : ListRow;
		return <Cell item={shown} selected={isSelected} thumb={thumbFor(shown)} now={now} activeTags={filter.tags} onTag={onTag} />;
	};

	const searching = filter.q.trim() !== "";
	const filtered = searching || filter.kinds.length > 0 || filter.tags.length > 0 || filter.workspace !== undefined;
	const rail = (
		<FacetRail
			sections={artifactSections(filter, facets, workspaces, {
				onScope: setScope,
				onKinds: kinds => setFilter(current => ({ ...current, kinds })),
				onTag,
				onClearTags: () => setFilter(current => ({ ...current, tags: [] })),
				onWorkspace: workspace => {
					setFilter(current => ({ ...current, workspace }));
					setRailOpen(false);
				},
			})}
		/>
	);
	const empty = SCOPE_EMPTY[filter.scope];
	const loadingFirst = list.phase === "loading" && list.items.length === 0;

	return (
		<div ref={root} data-slot="library-pane" className="relative flex h-full min-h-0 bg-fr-bg text-fr-text" onKeyDown={onRootKey}>
			<div className="flex min-h-0 min-w-0 flex-1" inert={page !== null}>
			{compact ? null : <div className="w-52 shrink-0 border-r border-fr-border-soft bg-fr-rail">{rail}</div>}
			{compact && railOpen ? (
				<>
					<button type="button" aria-label="Close filters" className="absolute inset-0 z-20 bg-black/30" onClick={() => setRailOpen(false)} />
					<div className="absolute inset-y-0 left-0 z-30 w-60 border-r border-fr-border-soft bg-fr-rail shadow-xl">{rail}</div>
				</>
			) : null}
			<div className="relative flex min-w-0 flex-1 flex-col">
				<div data-slot="library-toolbar" className="flex h-11 shrink-0 items-center gap-2 px-3 shadow-[inset_0_-1px_0_var(--fr-border-soft)]">
					{compact ? (
						<IconButton className={cn("size-7", FOCUS)} toggled={railOpen || filtered || filter.scope !== "all"} aria-label="Filters" title="Filters" onClick={() => setRailOpen(open => !open)}>
							<Icon name="funnel" size={14} />
						</IconButton>
					) : null}
					<label className="flex h-7 min-w-0 max-w-md flex-1 items-center gap-2 rounded-md border border-fr-border bg-fr-surface px-2 focus-within:border-fr-accent-line">
						<Icon name="search" size={13} className="shrink-0 text-fr-text-3" />
						<input
							ref={search}
							type="search"
							aria-label="Search the library"
							placeholder={filter.scope === "discarded" ? "Search discarded" : "Search artifacts"}
							value={draft}
							onChange={event => setDraft(event.target.value)}
							onKeyDown={event => {
								if (event.key === "ArrowDown") {
									event.preventDefault();
									focusGrid();
								}
								if (event.key === "Escape") {
									event.preventDefault();
									if (draft !== "") setDraft("");
									else focusGrid();
								}
								if (event.key === "Enter") {
									event.preventDefault();
									setFilter(current => ({ ...current, q: draft }));
									focusGrid();
								}
							}}
							spellCheck={false}
							className="min-w-0 flex-1 bg-transparent text-fr-sm text-fr-text outline-none placeholder:text-fr-text-3 [&::-webkit-search-cancel-button]:hidden"
						/>
						{draft === "" ? <Kbd className="shrink-0 text-fr-text-3">/</Kbd> : null}
					</label>
					<span className="hidden shrink-0 text-fr-xs tabular-nums text-fr-text-3 sm:inline" aria-live="polite">
						{list.phase === "ready" || list.items.length > 0 ? `${list.total.toLocaleString()} ${list.total === 1 ? "artifact" : "artifacts"}` : ""}
					</span>
					<span className="flex-1" />
					<Select
						size="sm"
						aria-label="Sort"
						className="w-auto shrink-0"
						value={searching || filter.sort !== "relevance" ? filter.sort : "recent"}
						onChange={event => setFilter(current => ({ ...current, sort: event.target.value as LibrarySort }))}
					>
						{(Object.keys(SORT_LABEL) as LibrarySort[]).filter(sort => searching || sort !== "relevance").map(sort => (
							<option key={sort} value={sort}>
								{SORT_LABEL[sort]}
							</option>
						))}
					</Select>
					<div role="group" aria-label="Layout" className="flex shrink-0 items-center">
						<IconButton className={cn("size-7", FOCUS)} toggled={layout === "grid"} aria-pressed={layout === "grid"} aria-label="Grid" title="Grid" onClick={() => setLayout("grid")}>
							<Icon name="grid" size={14} />
						</IconButton>
						<IconButton className={cn("size-7", FOCUS)} toggled={layout === "list"} aria-pressed={layout === "list"} aria-label="List" title="List" onClick={() => setLayout("list")}>
							<Icon name="list" size={14} />
						</IconButton>
					</div>
					<IconButton className={cn("size-7", FOCUS)} aria-label="Add a file" title="Add a file" onClick={() => setDialog({ kind: "add" })}>
						<Icon name="filePlus" size={14} />
					</IconButton>
				</div>
				{list.phase === "loading" && list.items.length > 0 ? <div aria-hidden className="absolute inset-x-0 top-11 z-10 h-0.5 animate-pulse bg-fr-accent/60" /> : null}
				<div className="relative min-h-0 flex-1">
					{list.phase === "failed" && list.items.length === 0 ? (
						<Centered title="The library could not be read" body={list.error ?? ""}>
							<Button type="button" size="sm" variant="outline" onClick={() => setGeneration(count => count + 1)}>
								Try again
							</Button>
						</Centered>
					) : loadingFirst ? (
						<Centered title="" body="Opening the library…" />
					) : list.phase === "ready" && list.items.length === 0 ? (
						filtered ? (
							<Centered title="Nothing matches" body={filter.q.trim() === "" ? "No artifact has these filters." : `No artifact matches “${filter.q.trim()}”.`}>
								<Button
									type="button"
									size="sm"
									variant="outline"
									onClick={() => {
										setDraft("");
										setFilter(current => ({ ...current, q: "", kinds: [], tags: [], workspace: undefined }));
									}}
								>
									Clear filters
								</Button>
							</Centered>
						) : (
							<Centered title={empty.title} body={empty.body}>
								{filter.scope === "all" ? (
									<Button type="button" size="sm" onClick={() => setDialog({ kind: "add" })}>
										<Icon name="filePlus" size={12} />
										Add file
									</Button>
								) : null}
							</Centered>
						)
					) : (
						<LibraryGrid
							items={list.items}
							layout={layout}
							selectedIndex={selectedIndex}
							label={filter.scope === "discarded" ? "Recently discarded" : "Artifacts"}
							renderItem={renderItem}
							onSelect={index => {
								const item = list.items[index];
								setSelectedId(item?.id ?? null);
							}}
							onOpen={index => {
								const item = list.items[index];
								if (item !== undefined) openPage(item);
							}}
							keys={GRID_KEYS}
							onKey={onGridKey}
							onRange={onRange}
							footer={
								list.loadingMore ? (
									<div className="py-3 text-center text-fr-xs text-fr-text-3">Loading more…</div>
								) : list.phase === "failed" ? (
									<div className="flex items-center justify-center gap-2 py-3 text-fr-xs text-fr-del">
										{list.error}
										<Button type="button" size="sm" variant="ghost" onClick={() => setGeneration(count => count + 1)}>
											Reload
										</Button>
									</div>
								) : null
							}
						/>
					)}
					{toast === null ? null : <LibraryToast text={toast} onDismiss={() => setToast(null)} />}
				</div>
			</div>
			</div>
			{pageShown === null ? null : (
				<ArtifactSurface
					key={pageShown.id}
					app={app}
					tools={tools}
					item={pageShown}
					thumb={thumbFor(pageShown)}
					active={active}
					now={now}
					theme={theme}
					onBack={() => {
						setPage(null);
						window.requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[data-slot="library-grid"]')?.focus());
					}}
					onPatched={patched}
					onRestored={restored}
					onDiscarded={discarded}
					onShares={(change, counted) => {
						patchItemShares(pageShown.id, change);
						if (counted) setFacetsGeneration(count => count + 1);
					}}
					onError={setToast}
				/>
			)}
			{dialog?.kind === "discard" ? (
				<DiscardDialog
					tools={tools}
					item={dialog.item}
					onClose={() => setDialog(null)}
					onDiscarded={result => {
						setDialog(null);
						discarded(dialog.item, result);
					}}
				/>
			) : null}
			{dialog?.kind === "add" ? (
				<AddFileDialog
					tools={tools}
					onClose={() => setDialog(null)}
					onAdded={item => {
						setDialog(null);
						setDraft("");
						setFilter(current => ({ ...current, q: "", kinds: [], tags: [], scope: "all", workspace: undefined, sort: DEFAULT_FILTER.sort }));
						setGeneration(count => count + 1);
						setFacetsGeneration(count => count + 1);
						openPage(item);
					}}
				/>
			) : null}
		</div>
	);
}

function Centered({ title, body, children }: { readonly title: string; readonly body: string; readonly children?: ReactNode }) {
	return (
		<div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6 text-center">
			{title === "" ? null : <p className="text-fr-md font-semibold text-fr-text">{title}</p>}
			<p className="max-w-[46ch] text-fr-sm text-fr-text-3">{body}</p>
			{children === undefined ? null : <div className="mt-2">{children}</div>}
		</div>
	);
}
