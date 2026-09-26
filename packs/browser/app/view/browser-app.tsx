// The browser. Tab strip, toolbar, the page, and what floats over it: agent
// activity, annotation, notices. Every capability comes from one opaque
// `browserId` that arrives in this View's own `browser_open` tool result —
// there is no listing, and the id is held in React state only (never storage,
// never a URL).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { BrowserAction, BrowserEngine, BrowserFrame, BrowserState, TabOp } from "../../src/contracts";
import { Icon } from "@fraym/ui/icons";
import { addressParts, tabLabel } from "./address";
import { AgentPill, ResultToast } from "./agent-activity";
import { AnnotateBar } from "./annotate-bar";
import { BrowserClient, failureText } from "./browser-client";
import { type DrawTool, EMPTY_SKETCH, PageView, type Sketch } from "./page-view";
import { BlankTab, RELAY_PROFILE, StartPage } from "./start-page";
import { TabStrip } from "./tab-strip";
import { PublishBar } from "./publish-bar";
import { type OmniboxHandle, Toolbar } from "./toolbar";
import { useBrowserPoll } from "./use-browser-poll";
import { usePageInput } from "./use-page-input";

interface Notice {
	readonly id: number;
	readonly tone: "ok" | "error" | "info";
	readonly text: string;
}

/** Actions that start a page load; the View shows them loading immediately. */
const NAVIGATION: Record<string, true> = { navigate: true, reload: true, back: true, forward: true };

export interface BrowserAppProps {
	readonly app: App;
	/** The state carried by the tool result that mounted (or re-targeted) this
	 *  View — the only place a browserId may come from. */
	readonly toolState: { state: BrowserState; seq: number } | null;
}

export function BrowserApp({ app, toolState }: BrowserAppProps) {
	const client = useMemo(() => new BrowserClient(app), [app]);

	const [browserId, setBrowserId] = useState<string | null>(null);
	const [opened, setOpened] = useState<BrowserState | null>(null);
	const [profiles, setProfiles] = useState<readonly string[] | null>(null);
	const [profilesError, setProfilesError] = useState<string | null>(null);
	const [profile, setProfile] = useState("default");
	const [engine, setEngine] = useState<BrowserEngine>("chromium");
	const [opening, setOpening] = useState(false);
	const [openError, setOpenError] = useState<string | null>(null);

	const [annotating, setAnnotating] = useState(false);
	const [tool, setTool] = useState<DrawTool>("region");
	const [sketch, setSketch] = useState<Sketch>(EMPTY_SKETCH);
	const [still, setStill] = useState<BrowserFrame | null>(null);

	const [cancelling, setCancelling] = useState(false);
	/** Navigations this View started that the runtime has not yet reported. */
	const [navPending, setNavPending] = useState(0);
	const [notice, setNotice] = useState<Notice | null>(null);
	const [dismissedTask, setDismissedTask] = useState<string | null>(null);
	const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);

	const omniRef = useRef<OmniboxHandle | null>(null);
	const boundRef = useRef<string | null>(null);
	boundRef.current = browserId;
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	/** Tasks this View watched run: only those get a result toast when they end. */
	const watchedTaskRef = useRef<string | null>(null);
	/** Publishes this View showed awaiting confirmation: only those get an outcome line. */
	const watchedPublishRef = useRef<string | null>(null);
	const [dismissedPublish, setDismissedPublish] = useState<string | null>(null);

	const poll = useBrowserPoll(client, browserId, annotating);
	const state = poll.state ?? opened;
	const task = state?.task ?? null;
	const taskRunning = task?.status === "running";
	// An agent drives, or the browser is gone: no input, no tab ops.
	const locked = taskRunning || poll.connection === "gone";
	const loading = (state?.loading ?? false) || navPending > 0;
	const viewport = state?.viewport ?? { width: 1280, height: 800 };

	const say = useCallback((tone: Notice["tone"], text: string) => setNotice({ id: Date.now(), tone, text }), []);
	useEffect(() => {
		if (notice === null) return;
		const timer = window.setTimeout(() => setNotice(current => (current?.id === notice.id ? null : current)), notice.tone === "error" ? 8000 : 4500);
		return () => window.clearTimeout(timer);
	}, [notice]);

	useEffect(() => {
		const on = () => setOffline(false);
		const off = () => setOffline(true);
		window.addEventListener("online", on);
		window.addEventListener("offline", off);
		return () => {
			window.removeEventListener("online", on);
			window.removeEventListener("offline", off);
		};
	}, []);

	// A tool result is the ONLY source of a browserId, and it is folded in DURING
	// RENDER so a View mounted by `browser_open` paints the live browser on its
	// first frame. Only a CHANGE of browserId resets the annotation: a model turn
	// must not wipe a half-drawn crop out from under the human.
	const [seenSeq, setSeenSeq] = useState(0);
	if (toolState !== null && toolState.seq !== seenSeq) {
		setSeenSeq(toolState.seq);
		setOpened(toolState.state);
		setOpenError(null);
		if (toolState.state.browserId !== browserId) {
			setBrowserId(toolState.state.browserId);
			setProfile(toolState.state.profile);
			setEngine(toolState.state.engine);
			setAnnotating(false);
			setSketch(EMPTY_SKETCH);
			setStill(null);
		}
	}

	useEffect(() => {
		let current = true;
		void client.bindBrowser(browserId).catch(cause => {
			if (current) say("error", `The agent could not be told about this browser: ${failureText(cause)}`);
		});
		return () => {
			current = false;
		};
	}, [client, browserId, say]);

	// The profile list is app-only: it names profiles, never live browsers.
	useEffect(() => {
		let alive = true;
		client.profiles().then(
			list => {
				if (!alive) return;
				const managed = list.filter(name => name !== RELAY_PROFILE);
				setProfiles(managed);
				setProfilesError(null);
				setProfile(current => (current === "default" ? (managed[0] ?? "default") : current));
			},
			cause => {
				if (!alive) return;
				setProfiles([]);
				setProfilesError(failureText(cause));
			},
		);
		return () => {
			alive = false;
		};
	}, [client]);

	// Remember which task this View saw running, so its end gets a toast.
	useEffect(() => {
		if (task?.status === "running") watchedTaskRef.current = task.id;
	}, [task?.id, task?.status]);
	const publish = state?.publish ?? null;
	useEffect(() => {
		if (publish?.status === "awaiting-confirmation") watchedPublishRef.current = publish.publishId;
	}, [publish?.publishId, publish?.status]);

	const live = (bound: string) => mountedRef.current && boundRef.current === bound;

	// A navigation this View started shows as loading at once: the runtime only
	// reports `loading` on the next poll, which lands after the action returns.
	const input = usePageInput(client, browserId, {
		onState: (next, action) => {
			if (NAVIGATION[action.kind]) setNavPending(count => Math.max(0, count - 1));
			poll.push(next);
			poll.refresh();
		},
		onError: (message, action) => {
			if (NAVIGATION[action.kind]) setNavPending(count => Math.max(0, count - 1));
			// Back/forward at the end of history is a no-op, not a failure worth a toast.
			if ((action.kind === "back" || action.kind === "forward") && /history/i.test(message)) return;
			say("error", message);
			poll.refresh();
		},
	});

	const open = async (url: string) => {
		const target = engine === "chrome-relay" ? RELAY_PROFILE : profile.trim();
		if (target.length === 0) return;
		setOpening(true);
		setOpenError(null);
		try {
			const next = await client.open({ profile: target, engine, url: url.length > 0 ? url : undefined });
			if (!mountedRef.current) return;
			setBrowserId(next.browserId);
			setOpened(next);
			if (next.engine !== "chrome-relay") setProfiles(current => [...new Set([...(current ?? []), next.profile])].sort());
			setAnnotating(false);
			setSketch(EMPTY_SKETCH);
			setStill(null);
		} catch (cause) {
			if (mountedRef.current) setOpenError(failureText(cause));
		} finally {
			if (mountedRef.current) setOpening(false);
		}
	};

	// The page area's size becomes the browser's viewport, so the page fills
	// it edge to edge and every click maps 1:1. Debounced: a drag-resize sends
	// one call, not sixty; the last frame stays on screen, fitted, meanwhile.
	const resizeTimerRef = useRef<number | undefined>(undefined);
	const sentSizeRef = useRef<{ width: number; height: number } | null>(null);
	const onStageResize = useCallback(
		(width: number, height: number) => {
			window.clearTimeout(resizeTimerRef.current);
			resizeTimerRef.current = window.setTimeout(() => {
				const bound = boundRef.current;
				if (bound === null || width < 320 || height < 240) return;
				const sent = sentSizeRef.current;
				if (sent !== null && sent.width === width && sent.height === height) return;
				sentSizeRef.current = { width, height };
				client.viewport(bound, width, height).then(
					next => {
						if (!live(bound)) return;
						poll.push(next);
						poll.refresh();
					},
					cause => {
						if (live(bound)) say("error", `Couldn't resize the page: ${failureText(cause)}`);
						sentSizeRef.current = null;
					},
				);
			}, 150);
		},
		[client],
	);
	useEffect(() => {
		sentSizeRef.current = null;
	}, [browserId]);

	const tabOp = async (op: TabOp, options: { tabId?: string; url?: string } = {}) => {
		const bound = browserId;
		if (bound === null || locked) return;
		try {
			const next = await client.tab(bound, op, options);
			if (!live(bound)) return;
			poll.push(next);
			poll.refresh();
		} catch (cause) {
			if (live(bound)) say("error", failureText(cause));
		}
	};

	const act = (action: BrowserAction) => {
		if (browserId === null || locked) return;
		if (NAVIGATION[action.kind]) setNavPending(count => count + 1);
		input.send(action);
	};

	const navigate = (url: string) => {
		if (url.length === 0) return;
		act({ kind: "navigate", url });
	};

	const cancelTask = async () => {
		const bound = browserId;
		if (bound === null) return;
		setCancelling(true);
		try {
			await client.cancelTask(bound);
			if (live(bound)) poll.refresh();
		} catch (cause) {
			if (live(bound)) say("error", failureText(cause));
		} finally {
			if (mountedRef.current) setCancelling(false);
		}
	};

	const closeBrowser = async () => {
		const bound = browserId;
		if (bound === null) return;
		try {
			await client.close(bound);
		} catch (cause) {
			if (live(bound)) say("error", failureText(cause));
			return;
		}
		if (!live(bound)) return;
		leave();
	};

	/** Back to the start page, whatever happened to the browser. */
	const leave = () => {
		setBrowserId(null);
		setNavPending(0);
		setOpened(null);
		setAnnotating(false);
		setSketch(EMPTY_SKETCH);
		setStill(null);
		input.reset();
	};

	const enterAnnotation = async () => {
		const bound = browserId;
		if (bound === null || annotating) return;
		setAnnotating(true);
		setSketch(EMPTY_SKETCH);
		setStill(null);
		try {
			const frame = await client.frame(bound, "png");
			if (live(bound)) setStill(frame);
		} catch (cause) {
			if (!live(bound)) return;
			say("error", `Couldn't capture the page for annotation: ${failureText(cause)}`);
			setAnnotating(false);
		}
	};

	const refreshPoll = poll.refresh;
	const exitAnnotation = useCallback(() => {
		setAnnotating(false);
		setSketch(EMPTY_SKETCH);
		setStill(null);
		// The loop is on its slow, frozen cadence: pull the first live frame now.
		window.setTimeout(refreshPoll, 0);
	}, [refreshPoll]);

	const forgetAnnotation = async () => {
		const bound = browserId;
		if (bound === null) return;
		try {
			if (await client.bindBrowser(bound)) say("ok", "Annotation removed — the agent keeps the browser, not the picture.");
		} catch (cause) {
			if (live(bound)) say("error", failureText(cause));
		}
	};

	const copyAddress = async () => {
		const url = state?.url ?? "";
		if (url.length === 0) return;
		try {
			await navigator.clipboard.writeText(url);
			say("ok", "Address copied.");
		} catch {
			say("error", "The clipboard is not available here.");
		}
	};

	// Browser shortcuts, wherever focus is inside the View.
	useEffect(() => {
		if (browserId === null) return;
		const onKey = (event: KeyboardEvent) => {
			const mod = event.ctrlKey || event.metaKey;
			const inField = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
			const tabs = state?.tabs ?? [];
			const index = tabs.findIndex(tab => tab.id === state?.activeTabId);
			const handled = () => {
				event.preventDefault();
				event.stopPropagation();
			};
			if (mod && !event.shiftKey && event.key.toLowerCase() === "l") {
				handled();
				omniRef.current?.focus();
			} else if (mod && !event.shiftKey && event.key.toLowerCase() === "t") {
				handled();
				void tabOp("new");
				omniRef.current?.focus();
			} else if (mod && !event.shiftKey && event.key.toLowerCase() === "w") {
				handled();
				if (state) void tabOp("close", { tabId: state.activeTabId });
			} else if ((mod && event.key.toLowerCase() === "r") || event.key === "F5") {
				handled();
				act({ kind: "reload" });
			} else if (event.altKey && event.key === "ArrowLeft") {
				handled();
				if (state?.canGoBack) act({ kind: "back" });
			} else if (event.altKey && event.key === "ArrowRight") {
				handled();
				if (state?.canGoForward) act({ kind: "forward" });
			} else if (mod && event.key === "Tab" && tabs.length > 1 && index >= 0) {
				handled();
				const next = (index + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length;
				void tabOp("activate", { tabId: tabs[next].id });
			} else if (mod && !event.shiftKey && /^[1-9]$/.test(event.key) && tabs.length > 0) {
				handled();
				const target = event.key === "9" ? tabs[tabs.length - 1] : tabs[Number(event.key) - 1];
				if (target) void tabOp("activate", { tabId: target.id });
			} else if (mod && event.shiftKey && event.key.toLowerCase() === "a") {
				handled();
				if (annotating) exitAnnotation();
				else void enterAnnotation();
			} else if (event.key === "Escape" && !inField && document.querySelector(".bx-menu") === null) {
				if (annotating) {
					handled();
					exitAnnotation();
				} else if (loading) {
					handled();
					act({ kind: "stop" });
				}
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	});

	if (browserId === null || state === null) {
		return (
			<StartPage
				profiles={profiles}
				profilesError={profilesError}
				profile={profile}
				engine={engine}
				opening={opening}
				error={openError}
				onProfile={setProfile}
				onEngine={setEngine}
				onOpen={url => void open(url)}
			/>
		);
	}

	const parts = addressParts(state.url);
	const blank = parts.blank && !state.loading && !annotating;
	const frame = annotating ? (still ?? poll.frame) : poll.frame;
	const mode = annotating ? "annotate" : locked ? "locked" : "live";
	const label = `${tabLabel(state.title, state.url)}${state.url.length > 0 ? ` — ${state.url}` : ""}`;
	const ended = task !== null && task.status !== "running" && watchedTaskRef.current === task.id && dismissedTask !== task.id;
	const showPublish =
		publish !== null &&
		dismissedPublish !== publish.publishId &&
		(publish.status === "awaiting-confirmation" || watchedPublishRef.current === publish.publishId);

	const floats = (
		<>
			{annotating && (
				<div className="bx-float bx-float-top">
					<AnnotateBar
						app={app}
						client={client}
						browserId={browserId}
						frameId={still?.frameId ?? null}
						tool={tool}
						onTool={setTool}
						sketch={sketch}
						onClear={() => setSketch(EMPTY_SKETCH)}
						onExit={exitAnnotation}
						onNotice={say}
						onSent={exitAnnotation}
					/>
				</div>
			)}

			{((taskRunning && task !== null) || showPublish) && (
				<div className="bx-float bx-float-bottom">
					<div className="bx-float-column">
						{showPublish && publish !== null && (
							<PublishBar
								key={publish.publishId}
								client={client}
								browserId={browserId}
								publish={publish}
								onSettled={poll.refresh}
								onDismiss={() => setDismissedPublish(publish.publishId)}
							/>
						)}
						{taskRunning && task !== null && <AgentPill task={task} cancelling={cancelling} onCancel={() => void cancelTask()} />}
					</div>
				</div>
			)}
		</>
	);

	return (
		<div className="bx-browser" data-locked={locked || undefined} data-annotating={annotating || undefined} data-connection={poll.connection}>
			<TabStrip
				tabs={navPending > 0 ? state.tabs.map(tab => (tab.id === state.activeTabId ? { ...tab, loading: true } : tab)) : state.tabs}
				activeTabId={state.activeTabId}
				locked={locked}
				onActivate={tabId => void tabOp("activate", { tabId })}
				onClose={tabId => void tabOp("close", { tabId })}
				onNew={() => {
					void tabOp("new");
					omniRef.current?.focus();
				}}
			/>
			<Toolbar
				ref={omniRef}
				url={state.url}
				loading={loading}
				canGoBack={state.canGoBack}
				canGoForward={state.canGoForward}
				locked={locked}
				annotating={annotating}
				profile={state.profile}
				engine={state.engine}
				offline={offline}
				onBack={() => act({ kind: "back" })}
				onForward={() => act({ kind: "forward" })}
				onReload={() => act({ kind: "reload" })}
				onStop={() => act({ kind: "stop" })}
				onNavigate={navigate}
				onAnnotate={() => (annotating ? exitAnnotation() : void enterAnnotation())}
				onCopyAddress={() => void copyAddress()}
				onForgetAnnotation={() => void forgetAnnotation()}
				onCloseBrowser={() => void closeBrowser()}
			/>
			<div className="bx-content">
				{blank ? (
					<BlankTab disabled={locked} onNavigate={navigate}>
						{floats}
					</BlankTab>
				) : (
					<PageView
						frame={frame}
						viewport={viewport}
						mode={mode}
						tool={tool}
						sketch={sketch}
						onSketch={setSketch}
						onAction={act}
						onResize={onStageResize}
						label={label}
					>
						{taskRunning && <span className="bx-drive" aria-hidden="true" />}
						{floats}
					</PageView>
				)}


			{((ended && task !== null) || notice !== null) && (
				<div className="bx-float bx-float-corner">
					<div className="bx-stack">
						{ended && task !== null && <ResultToast task={task} onDismiss={() => setDismissedTask(task.id)} />}
						{notice !== null && (
							<div className="bx-toast" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"} key={notice.id}>
								<span className="bx-toast-icon" aria-hidden="true">
									<Icon name={notice.tone === "error" ? "warnTri" : "check"} size={14} strokeWidth={2.25} />
								</span>
								<span className="bx-toast-text">{notice.text}</span>
								<button type="button" className="bx-toast-close" aria-label="Dismiss" onClick={() => setNotice(null)}>
									<Icon name="x" size={13} strokeWidth={2.25} />
								</button>
							</div>
						)}
					</div>
				</div>
			)}
				{poll.connection === "reconnecting" && (
					<div className="bx-banner" role="status">
						<span className="bx-tab-spinner" aria-hidden="true" />
						Reconnecting to the browser…
						{poll.error !== null && <span className="bx-banner-detail">{poll.error}</span>}
					</div>
				)}

				{poll.connection === "gone" && (
					<div className="bx-gone" role="alert">
						<div className="bx-gone-card">
							<span className="bx-start-mark" aria-hidden="true">
								<Icon name="logout" size={20} strokeWidth={1.75} />
							</span>
							<h2>This browser was closed</h2>
							<p>It was shut down elsewhere — by the agent, or by the session ending.</p>
							<button type="button" className="bx-start-open" onClick={leave}>
								Open another
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
