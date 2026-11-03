import { placeThreads } from "@dimension/mcp-app-kit/annotate/react";
import { formatDuration } from "@dimension/sdk/artifact-share";
import { MenuItem } from "@fraym/ui/components/menu";
import { Button } from "@fraym/ui/elements/button";
import { IconButton } from "@fraym/ui/elements/icon-button";
import { Input } from "@fraym/ui/elements/input";
import { Textarea } from "@fraym/ui/elements/textarea";
import { parseTags } from "@fraym/ui/features/media-library";
import { Icon, type IconName } from "@fraym/ui/icons";
import { cn } from "@fraym/ui/lib/cn";
import type { App } from "@modelcontextprotocol/ext-apps";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { LibraryItem, ShareSummary } from "../../../../src/library/types";
import { DocPane, Message } from "../doc-pane";
import { FOCUS } from "../focus-ring";
import { formatBytes } from "../format";
import type { SharedLayer } from "../pane-shared";
import type { Theme } from "../renderers/types";
import { actionFromResult } from "../result";
import type { DocTab, OpenFailureText } from "../tabs";
import { useCopied } from "../use-copied";
import { isPlaced, type PlacedThread } from "./artifact-threads";
import { folderName, fullDate, KIND_LOOK } from "./kinds";
import { ThumbOrIcon } from "./library-item";
import { type ArtifactPatchInput, errorText, type LibraryTools } from "./library-tools";
import { MenuSeparator, MoreMenu } from "./more-menu";
import { SessionRow } from "./session-row";
import { CommentsView, useArtifactComments, useSeenAfter } from "./share-comments";
import { AccessList } from "./share-list";

export type PageView = "view" | "comments" | "share" | "details";

export interface ArtifactPageProps {
	readonly app: App;
	readonly tools: LibraryTools;
	readonly item: LibraryItem;
	readonly thumb: string | null;
	readonly active: boolean;
	readonly now: number;
	readonly theme: Theme;
	/**
	 * Bar only: the host draws the document itself (a document tab the Viewer already has open) and is handed the
	 * comment layer to put on it, so the document never waits for the library and is never opened twice.
	 */
	readonly onLayer?: (shared: SharedLayer) => void;
	/** Back to the library grid; a document tab has no grid to go back to. */
	readonly onBack?: () => void;
	readonly onPatch: (patch: ArtifactPatchInput) => void;
	readonly onShare: () => void;
	readonly onManage: (shareId: string) => void;
	readonly onDiscard: () => void;
	readonly onRestore: () => void;
	readonly onShares: (shares: readonly ShareSummary[]) => void;
	readonly onShareChanged: (share: ShareSummary) => void;
}

type Doc = { readonly phase: "opening" } | { readonly phase: "open"; readonly tab: DocTab } | { readonly phase: "failed"; readonly failure: OpenFailureText };

function useArtifactDoc(tools: LibraryTools, item: LibraryItem, barOnly: boolean): { readonly doc: Doc; readonly retry: () => void } {
	const [doc, setDoc] = useState<Doc>({ phase: "opening" });
	const [attempt, setAttempt] = useState(0);
	const skip = item.state === "discarded" || barOnly;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is a retrigger token; a changed file reopens through `presentedAt`.
	useEffect(() => {
		if (skip) return;
		let live = true;
		setDoc(current => (current.phase === "open" ? current : { phase: "opening" }));
		tools.open(item.id).then(
			result => {
				if (!live) return;
				const action = actionFromResult(result);
				if (action.type === "open") {
					setDoc(current => {
						const revision = current.phase === "open" ? current.tab.revision + (current.tab.size !== action.file.size || current.tab.mtimeMs !== action.file.mtimeMs ? 1 : 0) : 0;
						return { phase: "open", tab: { ...action.file, key: action.key, revision, annotateRequests: 0 } };
					});
				} else if (action.type === "failed") {
					setDoc({ phase: "failed", failure: action.failure });
				} else if (action.type === "refused") {
					setDoc({ phase: "failed", failure: { message: action.message, copyPath: false } });
				}
			},
			cause => {
				if (live) setDoc({ phase: "failed", failure: { message: errorText(cause), copyPath: true } });
			},
		);
		return () => {
			live = false;
		};
	}, [tools, item.id, item.presentedAt, skip, attempt]);
	return { doc, retry: useCallback(() => setAttempt(count => count + 1), []) };
}

function useDraft(value: string, onCommit: (value: string) => void, onDone: () => void) {
	const [draft, setDraft] = useState(value);
	const cancelled = useRef(false);
	const commit = (): void => {
		if (!cancelled.current && draft.trim() !== value.trim()) onCommit(draft.trim());
		onDone();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>, multiline: boolean): void => {
		if (event.key === "Enter" && !(multiline && event.shiftKey)) {
			event.preventDefault();
			event.currentTarget.blur();
		}
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			cancelled.current = true;
			event.currentTarget.blur();
		}
	};
	return { draft, setDraft, commit, onKeyDown };
}

function RenameField({ value, placeholder, onCommit, onDone }: { readonly value: string; readonly placeholder: string; readonly onCommit: (value: string) => void; readonly onDone: () => void }) {
	const { draft, setDraft, commit, onKeyDown } = useDraft(value, onCommit, onDone);
	return (
		<Input
			autoFocus
			size="sm"
			aria-label="Name"
			value={draft}
			placeholder={placeholder}
			spellCheck={false}
			onFocus={event => event.currentTarget.select()}
			onChange={event => setDraft(event.target.value)}
			onBlur={commit}
			onKeyDown={event => onKeyDown(event, false)}
			className="min-w-0 max-w-md flex-1"
		/>
	);
}

function DescriptionField({ value, onCommit }: { readonly value: string; readonly onCommit: (value: string) => void }) {
	const [editing, setEditing] = useState(false);
	if (!editing) {
		return (
			<button
				type="button"
				onClick={() => setEditing(true)}
				className={cn("-mx-2 rounded-md px-2 py-1.5 text-left text-fr-sm hover:bg-fr-surface", value === "" ? "text-fr-text-3" : "whitespace-pre-wrap text-fr-text [overflow-wrap:anywhere]", FOCUS)}
			>
				{value === "" ? "Add a description" : value}
			</button>
		);
	}
	return <DescriptionEditor value={value} onCommit={onCommit} onDone={() => setEditing(false)} />;
}

function DescriptionEditor({ value, onCommit, onDone }: { readonly value: string; readonly onCommit: (value: string) => void; readonly onDone: () => void }) {
	const { draft, setDraft, commit, onKeyDown } = useDraft(value, onCommit, onDone);
	return (
		<Textarea
			autoFocus
			rows={3}
			aria-label="Description"
			value={draft}
			placeholder="Add a description"
			onChange={event => setDraft(event.target.value)}
			onBlur={commit}
			onKeyDown={event => onKeyDown(event, true)}
			className="resize-none text-fr-sm"
		/>
	);
}

function TagEditor({ tags, onCommit }: { readonly tags: readonly string[]; readonly onCommit: (tags: readonly string[]) => void }) {
	const [adding, setAdding] = useState(false);
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			{tags.map(tag => (
				<span key={tag} className="inline-flex h-6 items-center gap-0.5 rounded-sm bg-fr-surface-3 pl-2 pr-0.5 text-fr-xs text-fr-text-2">
					{tag}
					<button type="button" aria-label={`Remove tag ${tag}`} onClick={() => onCommit(tags.filter(each => each !== tag))} className={cn("rounded-sm p-0.5 text-fr-text-3 hover:bg-fr-surface-2 hover:text-fr-text", FOCUS)}>
						<Icon name="x" size={10} />
					</button>
				</span>
			))}
			{adding ? (
				<TagInput tags={tags} onCommit={onCommit} onDone={() => setAdding(false)} />
			) : (
				<button type="button" onClick={() => setAdding(true)} className={cn("inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-fr-xs text-fr-text-3 hover:bg-fr-surface hover:text-fr-text-2", FOCUS)}>
					<Icon name="plus" size={11} />
					Add tag
				</button>
			)}
		</div>
	);
}

function TagInput({ tags, onCommit, onDone }: { readonly tags: readonly string[]; readonly onCommit: (tags: readonly string[]) => void; readonly onDone: () => void }) {
	const { draft, setDraft, commit, onKeyDown } = useDraft("", text => onCommit(parseTags([...tags, text].join(","))), onDone);
	return <Input autoFocus size="sm" aria-label="New tag" value={draft} placeholder="Tag" spellCheck={false} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => onKeyDown(event, false)} className="h-6 w-28" />;
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
	return (
		<section className="flex flex-col gap-2.5 border-t border-fr-border-soft pt-4 first:border-t-0 first:pt-0">
			<h3 className="text-fr-xs font-semibold text-fr-text-2">{title}</h3>
			{children}
		</section>
	);
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
	return (
		<>
			<dt className="text-fr-text-3">{label}</dt>
			<dd className="min-w-0 truncate text-fr-text">{children}</dd>
		</>
	);
}

function containingFolder(path: string): string {
	return path.replace(/[\\/]+[^\\/]*$/, "");
}

function DetailsView({ app, item, onPatch, onDiscard, onRestore }: Pick<ArtifactPageProps, "app" | "item" | "onPatch" | "onDiscard" | "onRestore">) {
	const { copied, copy } = useCopied(item.path);
	const look = KIND_LOOK[item.kind];
	const discarded = item.state === "discarded";
	const folder = containingFolder(item.path);
	const kindLine = [look.label, item.durationMs === undefined ? null : formatDuration(item.durationMs), item.width !== undefined && item.height !== undefined ? `${item.width} × ${item.height}` : null].filter(part => part !== null).join(" · ");
	return (
		<div className="flex flex-col gap-4">
			<Section title="File">
				<dl className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-fr-xs">
					<Fact label="Type">{kindLine}</Fact>
					<Fact label="Size">{formatBytes(item.size)}</Fact>
					<dt className="text-fr-text-3">Location</dt>
					<dd className="flex min-w-0 items-center gap-1">
						<span title={item.path} className="inline-flex min-w-0 items-center gap-1 rounded-sm bg-fr-surface-2 px-1.5 py-0.5 text-fr-text-2">
							<Icon name="folder" size={12} className="shrink-0 text-fr-text-3" />
							<span className="truncate">{folderName(folder)}</span>
						</span>
						<IconButton className={cn("size-6 shrink-0", FOCUS)} aria-label={copied ? "Path copied" : "Copy path"} title={copied ? "Path copied" : item.path} onClick={copy}>
							<Icon name={copied ? "check" : "copy"} size={12} />
						</IconButton>
					</dd>
					{item.workspace === undefined ? null : (
						<Fact label="Workspace">
							<span title={item.workspace}>{folderName(item.workspace)}</span>
						</Fact>
					)}
					<Fact label="Added by">{item.source === "human" ? "You" : "An agent"}</Fact>
					{item.sessionId === undefined ? null : <SessionRow app={app} sessionId={item.sessionId} />}
					<Fact label="Added">{fullDate(item.createdAt)}</Fact>
					<Fact label="Last presented">{fullDate(item.presentedAt)}</Fact>
					{item.openedAt === undefined ? null : <Fact label="Last opened">{fullDate(item.openedAt)}</Fact>}
					{item.discardedAt === undefined ? null : <Fact label="Discarded">{fullDate(item.discardedAt)}</Fact>}
				</dl>
			</Section>
			<Section title="Description">
				<DescriptionField key={item.note ?? ""} value={item.note ?? ""} onCommit={note => onPatch({ note: note === "" ? null : note })} />
				<TagEditor tags={item.tags} onCommit={tags => onPatch({ tags })} />
			</Section>
			<div className="flex border-t border-fr-border-soft pt-4">
				{discarded ? (
					<Button type="button" size="sm" onClick={onRestore}>
						<Icon name="history" size={13} />
						Restore
					</Button>
				) : (
					<Button type="button" size="sm" variant="outline" className="text-fr-del hover:bg-fr-del-bg hover:text-fr-del" onClick={onDiscard}>
						<Icon name="trash" size={13} />
						Discard…
					</Button>
				)}
			</div>
		</div>
	);
}

function ShareView({ tools, item, now, onShare, onManage, onShareChanged }: Pick<ArtifactPageProps, "tools" | "item" | "now" | "onShare" | "onManage" | "onShareChanged">) {
	const canShare = item.state === "live";
	return (
		<div className="flex flex-col gap-4">
			<AccessList tools={tools} shares={item.shares} now={now} mtimeMs={item.mtimeMs} canShare={canShare} onShare={onShare} onManage={onManage} onChanged={onShareChanged} />
			{canShare ? (
				<div className="flex border-t border-fr-border-soft pt-3">
					<Button type="button" size="sm" onClick={onShare}>
						<Icon name="link" size={13} />
						Share…
					</Button>
				</div>
			) : null}
		</div>
	);
}

interface TabDef {
	readonly id: PageView;
	readonly label: string;
	readonly icon: IconName;
}

const TABS: readonly TabDef[] = [
	{ id: "view", label: "View", icon: "eye" },
	{ id: "comments", label: "Comments", icon: "chat" },
	{ id: "share", label: "Share", icon: "link" },
	{ id: "details", label: "Details", icon: "sliders" },
];

const SHEET_TITLE: Record<Exclude<PageView, "view">, string> = { comments: "Comments", share: "Who has access", details: "Details" };

export function ArtifactPage(props: ArtifactPageProps) {
	const { app, tools, item, thumb, active, now, theme, onBack, onPatch, onShares, onRestore } = props;
	const [view, setView] = useState<PageView>("view");
	const [renaming, setRenaming] = useState(false);
	const [openId, setOpenId] = useState<string | null>(null);
	const { copied, copy } = useCopied(item.path);
	const barOnly = props.onLayer !== undefined;
	const { doc, retry } = useArtifactDoc(tools, item, barOnly);
	const sheetId = useId();
	const sheet = useRef<HTMLDivElement>(null);
	const bar = useRef<HTMLElement>(null);
	const look = KIND_LOOK[item.kind];
	const discarded = item.state === "discarded";
	const missing = item.state === "missing";
	const name = item.title ?? item.name;
	const commentCount = item.shares.reduce((sum, share) => sum + share.comments, 0);
	const unread = item.shares.reduce((sum, share) => sum + share.unread, 0);

	const data = useArtifactComments({ tools, artifactId: item.id, shares: item.shares, now, onShares });
	const placed = useMemo(() => data.threads.filter(isPlaced), [data.threads]);
	const places = useMemo(() => placeThreads(placed), [placed]);
	const openThread: PlacedThread | undefined = openId === null ? undefined : placed.find(thread => thread.id === openId);
	useSeenAfter(active && openThread !== undefined, openThread?.comments.filter(comment => comment.readAt === undefined).map(comment => comment.id) ?? [], data.seen);

	const replyTo = data.reply;
	const onReply = useCallback(
		async (id: string, body: string): Promise<void> => {
			const thread = data.threads.find(each => each.id === id);
			if (thread === undefined) throw new Error("That comment is no longer here.");
			await replyTo(thread, body);
		},
		[data.threads, replyTo],
	);
	const shared = useMemo<SharedLayer>(() => ({ threads: placed, places, openId, onOpen: setOpenId, onReply }), [placed, places, openId, onReply]);

	const toggle = (next: PageView): void => setView(current => (current === next || next === "view" ? "view" : next));

	useEffect(() => {
		if (view === "view") return;
		const away = (event: PointerEvent): void => {
			const target = event.target as Node;
			if (sheet.current?.contains(target) || bar.current?.contains(target)) return;
			if (target instanceof Element && target.closest('[role="dialog"], [data-slot="comment-thread-popover"]') !== null) return;
			setView("view");
		};
		window.addEventListener("pointerdown", away, true);
		return () => window.removeEventListener("pointerdown", away, true);
	}, [view]);

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.defaultPrevented || view === "view" || event.key !== "Escape") return;
		event.preventDefault();
		setView("view");
	};

	const pick = (id: string): void => {
		setOpenId(id);
		setView("view");
	};

	const reportLayer = useRef(props.onLayer);
	reportLayer.current = props.onLayer;
	useEffect(() => reportLayer.current?.(shared), [shared]);

	const chrome = (
		<>
			<header
				ref={bar}
				data-slot="artifact-bar"
				className={cn("relative z-20 flex h-11 shrink-0 items-center gap-1.5 pr-2 shadow-[inset_0_-1px_0_var(--fr-border-soft)]", onBack === undefined ? "pl-3" : "pl-1.5")}
			>
				{onBack === undefined ? null : (
					<IconButton className={cn("size-7", FOCUS)} aria-label="Back to the library" title="Back to the library" onClick={onBack}>
						<Icon name="back" size={15} />
					</IconButton>
				)}
				<Icon name={look.icon} size={15} className="shrink-0 text-fr-text-3" />
				{renaming ? (
					<RenameField value={item.title ?? ""} placeholder={item.name} onCommit={title => onPatch({ title: title === "" ? null : title })} onDone={() => setRenaming(false)} />
				) : (
					<h2 className="min-w-0 flex-1 truncate text-fr-sm font-semibold">
						<button type="button" title={`${name} · click to rename`} onClick={() => setRenaming(true)} className={cn("max-w-full truncate rounded-sm px-1 text-left hover:bg-fr-surface", FOCUS)}>
							{name}
						</button>
					</h2>
				)}
				{discarded ? null : (
					<IconButton className={cn("size-7 shrink-0", FOCUS)} toggled={item.starred} aria-label={item.starred ? "Unstar" : "Star"} title={item.starred ? "Unstar" : "Star"} onClick={() => onPatch({ starred: !item.starred })}>
						<Icon name="star" size={14} filled={item.starred} />
					</IconButton>
				)}
				<div role="tablist" aria-label="Artifact" className="ml-auto flex shrink-0 items-center gap-0.5 rounded-lg bg-fr-surface-2 p-0.5">
					{TABS.map(tab => {
						const selected = view === tab.id;
						return (
							<button
								key={tab.id}
								type="button"
								role="tab"
								title={tab.label}
								aria-selected={selected}
								aria-controls={tab.id === "view" ? undefined : sheetId}
								onClick={() => toggle(tab.id)}
								className={cn(
									"inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-fr-xs font-medium transition-colors duration-[var(--fr-motion-fast)]",
									selected ? "bg-fr-surface text-fr-text shadow-sm" : "text-fr-text-2 hover:text-fr-text",
									FOCUS,
								)}
							>
								<Icon name={tab.icon} size={13} />
								<span className="sr-only sm:not-sr-only">{tab.label}</span>
								{tab.id === "comments" && commentCount > 0 ? <span className="tabular-nums text-fr-text-3">{commentCount}</span> : null}
								{tab.id === "comments" && unread > 0 ? (
									<span className="size-1.5 rounded-full bg-fr-accent" title={`${unread} new`}>
										<span className="sr-only">{`${unread} new`}</span>
									</span>
								) : null}
							</button>
						);
					})}
				</div>
				<MoreMenu label="More actions">
					<MenuItem icon={<Icon name={copied ? "check" : "copy"} size={14} />} onClick={copy}>
						{copied ? "Path copied" : "Copy path"}
					</MenuItem>
					<MenuItem icon={<Icon name="edit" size={14} />} onClick={() => setRenaming(true)}>
						Rename
					</MenuItem>
					<MenuSeparator />
					{discarded ? (
						<MenuItem icon={<Icon name="history" size={14} />} onClick={onRestore}>
							Restore
						</MenuItem>
					) : (
						<MenuItem icon={<Icon name="trash" size={14} />} onClick={props.onDiscard} className="text-fr-del hover:bg-fr-del-bg hover:text-fr-del">
							Discard…
						</MenuItem>
					)}
				</MoreMenu>
				{view === "view" ? null : (
					<div
						ref={sheet}
						id={sheetId}
						role="tabpanel"
						aria-label={SHEET_TITLE[view]}
						data-slot="artifact-sheet"
						data-fr-enter="pop"
						className="absolute right-2 top-full z-30 mt-1.5 flex max-h-[min(70vh,600px)] w-[min(420px,calc(100%-1rem))] flex-col overflow-hidden rounded-xl border border-fr-border bg-fr-surface shadow-[0_18px_60px_rgba(0,0,0,0.5)]"
					>
						<div className="flex h-10 shrink-0 items-center gap-2 border-b border-fr-border-soft pl-4 pr-1.5">
							<h3 className="min-w-0 flex-1 truncate text-fr-sm font-semibold">{SHEET_TITLE[view]}</h3>
							<IconButton className={cn("size-7", FOCUS)} aria-label="Close" title="Close (Esc)" onClick={() => setView("view")}>
								<Icon name="x" size={14} />
							</IconButton>
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
							{view === "comments" ? <CommentsView data={data} shares={item.shares} now={now} openId={openId} onPick={pick} /> : null}
							{view === "share" ? <ShareView tools={tools} item={item} now={now} onShare={props.onShare} onManage={props.onManage} onShareChanged={props.onShareChanged} /> : null}
							{view === "details" ? <DetailsView app={app} item={item} onPatch={onPatch} onDiscard={props.onDiscard} onRestore={onRestore} /> : null}
						</div>
					</div>
				)}
			</header>
			{missing ? (
				<p role="status" className="flex shrink-0 items-start gap-1.5 bg-fr-warn/10 px-3 py-1.5 text-fr-xs text-fr-warn">
					<Icon name="warnTri" size={13} className="mt-px shrink-0" />
					This file is no longer where it was; it may have been moved, renamed or deleted.
				</p>
			) : null}
		</>
	);

	if (barOnly) {
		return (
			<div data-slot="artifact-page" data-bar-only="" className="relative z-30 flex shrink-0 flex-col bg-fr-bg text-fr-text" onKeyDown={onKeyDown}>
				{chrome}
			</div>
		);
	}

	return (
		<div data-slot="artifact-page" className="absolute inset-0 z-30 flex min-h-0 flex-col bg-fr-bg text-fr-text" onKeyDown={onKeyDown}>
			{chrome}
			<div data-slot="artifact-body" className="relative min-h-0 flex-1">
				{discarded ? (
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
						<div className="aspect-video w-full max-w-sm overflow-hidden rounded-lg border border-fr-border-soft opacity-60">
							<ThumbOrIcon item={item} thumb={thumb} iconSize={40} fit="contain" />
						</div>
						<p className="max-w-[46ch] text-fr-sm text-fr-text-2">This artifact is discarded. Restore it to open it again.</p>
						<Button type="button" size="sm" onClick={onRestore}>
							<Icon name="history" size={13} />
							Restore
						</Button>
					</div>
				) : doc.phase === "open" ? (
					<div className="absolute inset-0">
						<DocPane app={app} tab={doc.tab} active={active} theme={theme} embedded shared={shared} />
					</div>
				) : doc.phase === "failed" ? (
					<Message title="This file could not be opened" body={doc.failure.message} action={doc.failure.copyPath ? { label: copied ? "Path copied" : "Copy path", onClick: copy } : { label: "Try again", onClick: retry }} />
				) : (
					<div className="absolute inset-0 flex items-center justify-center">
						<p className="text-fr-sm text-fr-text-3">Opening {name}…</p>
					</div>
				)}
			</div>
		</div>
	);
}
