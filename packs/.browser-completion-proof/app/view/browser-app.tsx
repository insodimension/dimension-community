// The browser. Tab strip, toolbar, the page, and what floats over it: agent
// activity, annotation, notices. Every capability comes from one opaque
// `browserId` that arrives in the tool result that mounted this View —
// there is no listing, and the id is held in React state only (never storage,
// never a URL).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { BrowserAction, BrowserFrame, BrowserState, ControlMode, NewProfileRequest, OpenBrowserListing, ProfileConsent, ProfileListing, TabOp } from "../../src/contracts";
import { Icon } from "@fraym/ui/icons";
import { addressParts, tabLabel } from "../../src/address";
import { AgentPill, ControlPill, ResultToast, useAgentActive } from "./agent-activity";
import { AnnotationSeat } from "./annotation-seat";
import { BrowserClient, failureText, openFailureText, type ToolMount } from "./browser-client";
import { PageView } from "./page-view";
import { DEFAULT_PROFILE, RELAY_PROFILE } from "../../src/profile-name";
import { BlankTab, StartPage } from "./start-page";
import type { ProfileSwitcherProps } from "./profile-menu";
import { TabStrip } from "./tab-strip";
import { PublishBar } from "./publish-bar";
import { type OmniboxHandle, Toolbar } from "./toolbar";
import { useBrowserStream } from "./use-browser-stream";
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
	/** The result of the tool call that mounted (or re-targeted) this View — the
	 *  only place a browserId may come from — or why that call opened none. */
	readonly toolState: ToolMount | null;
}

export function BrowserApp({ app, toolState }: BrowserAppProps) {
	const client = useMemo(() => new BrowserClient(app), [app]);

	const [browserId, setBrowserId] = useState<string | null>(null);
	const [opened, setOpened] = useState<BrowserState | null>(null);
	/** Every saved profile with who holds it; null until it loads. Read again when the browser changes and when the profile menu opens. */
	const [profiles, setProfiles] = useState<readonly ProfileListing[] | null>(null);
	/** The browsers this chat holds that are not saved profiles (a Private one, Your Chrome): read with the profiles. */
	const [browsers, setBrowsers] = useState<readonly OpenBrowserListing[]>([]);
	const [consents, setConsents] = useState<readonly ProfileConsent[]>([]);
	const [profilesError, setProfilesError] = useState<string | null>(null);
	/** The profile being opened from the menu right now (`""`: a Private browser). */
	const [switching, setSwitching] = useState<string | null>(null);
	const [controlBusy, setControlBusy] = useState(false);
	/** The profile menu is open: the floating cards keep out from under it. */
	const [menuOpen, setMenuOpen] = useState(false);
	const [profile, setProfile] = useState(DEFAULT_PROFILE);
	const [isPrivate, setPrivate] = useState(false);
	const [ownChrome, setOwnChrome] = useState(false);
	const [opening, setOpening] = useState(false);
	const [openError, setOpenError] = useState<string | null>(null);
	/** The last browser ended by itself: the start page says so once. */
	const [closed, setClosed] = useState(false);

	const [annotating, setAnnotating] = useState(false);
	/** The page frozen into one picture for the human to mark; null until it is captured. */
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

	const stream = useBrowserStream(client, browserId, annotating);
	const state = stream.state ?? opened;
	const task = state?.task ?? null;
	const taskRunning = task?.status === "running";
	// An agent drives: no input, no tab ops.
	const locked = taskRunning;
	// The person may take the wheel when nothing else holds the page: no task runs and no post awaits its confirm.
	const canTakeOver = !taskRunning && state?.publish?.status !== "awaiting-confirmation";
	const agentActive = useAgentActive(state?.agentActionAt ?? null);
	const loading = (state?.loading ?? false) || navPending > 0;
	// The size the newest picture was taken at, so a click maps exactly even in the moment a resize is in flight.
	const viewport = stream.picture?.viewport ?? state?.viewport ?? { width: 1280, height: 800 };

	// The person's hold on the wheel ends when they hand it back, switch profile (`leave`) and when this View goes: it unmounts, or the
	// chat's window closes (`pagehide`; a page kept in the back/forward cache comes back, so it keeps the wheel). A document merely
	// hidden is NOT a departure: the stream stops while it is, and the person is coming back to the half-filled form they left. Best
	// effort: a window that is already closing may not get the call through, and the runtime's long fallback clock then gives it back.
	const wheelRef = useRef<string | null>(null);
	wheelRef.current = state?.takenOver === true ? browserId : null;
	useEffect(() => {
		const handBack = () => {
			const held = wheelRef.current;
			if (held === null) return;
			wheelRef.current = null;
			client.control(held, "return").catch(() => undefined);
		};
		const onPageHide = (event: Event) => {
			if ((event as PageTransitionEvent).persisted !== true) handBack();
		};
		window.addEventListener("pagehide", onPageHide);
		return () => {
			window.removeEventListener("pagehide", onPageHide);
			handBack();
		};
	}, [client]);

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
	// RENDER so a View mounted by `browser_view` paints the live browser on its
	// first frame. Only a CHANGE of browserId resets the annotation: a model turn
	// must not wipe a half-drawn mark out from under the human.
	const [seenSeq, setSeenSeq] = useState(0);
	if (toolState !== null && toolState.seq !== seenSeq) {
		setSeenSeq(toolState.seq);
		if ("error" in toolState) {
			// Told on the start page only: a live browser is never covered by the
			// failure of a call that was meant to open another.
			if (browserId === null) setOpenError(toolState.error);
		} else {
			setOpened(toolState.state);
			setOpenError(null);
			if (toolState.state.browserId !== browserId) {
				setBrowserId(toolState.state.browserId);
				setClosed(false);
				setAnnotating(false);
				setStill(null);
			}
		}
	}

	// The browser on screen is never announced to the agent (it reads the one the human opened with browser_state).
	// Only a picture the human sent is context, and it is taken back once the View moves to another browser.
	useEffect(() => {
		let current = true;
		void client.follow(browserId).catch(cause => {
			if (current) say("error", `The annotation could not be taken back from the agent: ${failureText(cause)}`);
		});
		return () => {
			current = false;
		};
	}, [client, browserId, say]);

	// The profiles are read each time the start page shows (a profile made meanwhile is on offer) and when the profile menu opens: who
	// holds each one changes under it. A browser on screen needs no read to draw its chip: its state carries the profile's look. The newest read wins.
	const profilesSeq = useRef(0);
	const loadProfiles = useCallback(() => {
		const seq = (profilesSeq.current += 1);
		client.profiles().then(
			answer => {
				if (!mountedRef.current || profilesSeq.current !== seq) return;
				setProfiles(answer.profiles);
				setBrowsers(answer.browsers);
				setConsents(answer.consents);
				setProfilesError(null);
			},
			cause => {
				if (!mountedRef.current || profilesSeq.current !== seq) return;
				setProfiles(current => current ?? []);
				setProfilesError(failureText(cause));
			},
		);
	}, [client]);
	useEffect(() => {
		if (browserId === null) loadProfiles();
	}, [loadProfiles, browserId]);
	useEffect(() => {
		if (!menuOpen && browserId !== null) return;
		const timer = setInterval(loadProfiles, 2_000);
		return () => clearInterval(timer);
	}, [menuOpen, browserId, loadProfiles]);

	const onConsent = useCallback<ProfileSwitcherProps["onConsent"]>((name, decision, scope, expectedSubject) => {
		if (boundRef.current === null) setOpenError(null);
		void client.decideProfileConsent(name, decision, scope, expectedSubject).then(loadProfiles, cause => {
			if (!mountedRef.current) return;
			if (boundRef.current === null) setOpenError(failureText(cause));
			else say("error", failureText(cause));
			loadProfiles();
		});
	}, [client, loadProfiles, say]);

	// Remember which task this View saw running, so its end gets a toast.
	useEffect(() => {
		if (task?.status === "running") watchedTaskRef.current = task.id;
	}, [task?.id, task?.status]);
	const publish = state?.publish ?? null;
	useEffect(() => {
		if (publish?.status === "awaiting-confirmation") watchedPublishRef.current = publish.publishId;
	}, [publish?.publishId, publish?.status]);

	const live = (bound: string) => mountedRef.current && boundRef.current === bound;

	// The human's mouse, wheel and keys go straight to the page on the direct channel (stream.post), never through a tool call.
	const input = usePageInput({ post: stream.post, onError: message => say("error", message) });

	/** One state read now, for the moments an action just changed it (the stream would show it within a quarter second anyway). */
	const pullState = () => {
		const bound = browserId;
		if (bound === null) return;
		client.state(bound).then(
			next => {
				if (live(bound)) stream.push(next);
			},
			() => undefined,
		);
	};

	/** Show `next` in this View: a browser just opened, or the one the person switched to. */
	const adopt = (next: BrowserState) => {
		setBrowserId(next.browserId);
		setOpened(next);
		setClosed(false);
		setAnnotating(false);
		setStill(null);
		setNavPending(0);
		input.reset();
	};

	const open = async (url: string) => {
		setOpening(true);
		setOpenError(null);
		try {
			const next = await client.open({
				engine: ownChrome ? "chrome-relay" : "chromium",
				profile: ownChrome ? RELAY_PROFILE : isPrivate ? undefined : profile,
				url: url.length > 0 ? url : undefined,
			});
			if (mountedRef.current) adopt(next);
		} catch (cause) {
			if (mountedRef.current) setOpenError(openFailureText(cause));
		} finally {
			if (mountedRef.current) setOpening(false);
		}
	};

	// Switching profile opens that profile's browser here, as Chrome does, and leaves the one it was on: the runtime closes it unless an
	// agent opened it or something depends on it (a task, a post waiting for confirmation, the person's own take-over). What stays is
	// listed in the menu, to go back to or close. The new browser is opened first, so one that cannot be opened (a profile taken meanwhile,
	// Chrome failing to start) never costs the person the one they are in. Only with the pool full does the runtime close the old one before
	// the open, when that frees the slot (`browser_switch`). A profile somebody else holds is not offered; if one is taken meanwhile, the
	// runtime's refusal is said once.
	const switchTo = async (key: string, reach: (left: string | null) => Promise<BrowserState>) => {
		if (switching !== null) return;
		const left = browserId;
		setSwitching(key);
		try {
			const next = await reach(left);
			if (!mountedRef.current) return;
			adopt(next);
			if (left !== null && left !== next.browserId) {
				client.leave(left).then(
					() => undefined,
					cause => {
						if (mountedRef.current) say("error", failureText(cause));
					},
				);
			}
		} catch (cause) {
			if (mountedRef.current) say("error", openFailureText(cause));
		} finally {
			if (mountedRef.current) setSwitching(null);
		}
	};
	const switchProfile = (target: string | null) =>
		switchTo(target ?? "", left => {
			const options = { engine: "chromium" as const, ...(target === null ? {} : { profile: target }) };
			return left === null ? client.open(options) : client.switchProfile(left, options);
		});
	const switchBrowser = (target: string) => switchTo(`browser:${target}`, () => client.state(target));

	// A browser left open is closed from the menu; it stays open, and the list is read again either way.
	const closeOther = async (target: string) => {
		try {
			await client.close(target);
		} catch (cause) {
			if (mountedRef.current) say("error", failureText(cause));
		}
		if (mountedRef.current) loadProfiles();
	};
	// Add profile in the menu makes it and opens it, as Chrome does. A name the runtime refuses is the form's to show (this rejects).
	const addProfile = async (request: NewProfileRequest) => {
		const created = await client.addProfile(request);
		if (!mountedRef.current) return;
		loadProfiles();
		await switchProfile(created.name);
	};

	// Add profile on the start page makes it and picks it for the browser about to open.
	const addProfileAtStart = async (request: NewProfileRequest) => {
		const created = await client.addProfile(request);
		if (!mountedRef.current) return;
		setProfile(created.name);
		loadProfiles();
	};

	const control = async (mode: ControlMode) => {
		const bound = browserId;
		if (bound === null) return;
		setControlBusy(true);
		try {
			const next = await client.control(bound, mode);
			if (live(bound)) stream.push(next);
		} catch (cause) {
			if (live(bound)) say("error", failureText(cause));
		} finally {
			if (mountedRef.current) setControlBusy(false);
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
						if (live(bound)) stream.push(next);
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
			if (live(bound)) stream.push(next);
		} catch (cause) {
			if (live(bound)) say("error", failureText(cause));
		}
	};

	// An address-bar action (navigate, back, forward, reload, stop): rare, and it must settle, so it stays a tool call. A navigation this
	// View started shows as loading at once; the browser only reports `loading` once the page has started.
	const act = (action: BrowserAction) => {
		const bound = browserId;
		if (bound === null || locked) return;
		const navigation = NAVIGATION[action.kind] === true;
		if (navigation) setNavPending(count => count + 1);
		const settled = () => {
			if (navigation) setNavPending(count => Math.max(0, count - 1));
		};
		client.act(bound, action).then(
			next => {
				if (!live(bound)) return;
				settled();
				stream.push(next);
			},
			cause => {
				if (!live(bound)) return;
				settled();
				const message = failureText(cause);
				// Back/forward at the end of history is a no-op, not a failure worth a toast.
				if ((action.kind === "back" || action.kind === "forward") && /history/i.test(message)) return;
				say("error", message);
			},
		);
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
			if (live(bound)) pullState();
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
		setStill(null);
		input.reset();
	};

	// A browser that ends by itself — the agent finished, the session ended — is a
	// normal ending, not a failure: back to the start page with one calm line.
	useEffect(() => {
		if (stream.connection !== "gone") return;
		setClosed(true);
		leave();
	}, [stream.connection]);

	const enterAnnotation = async () => {
		const bound = browserId;
		if (bound === null || annotating) return;
		setAnnotating(true);
		setStill(null);
		try {
			const frame = await client.frame(bound);
			if (live(bound)) setStill(frame);
		} catch (cause) {
			if (!live(bound)) return;
			say("error", `Couldn't capture the page for annotation: ${failureText(cause)}`);
			setAnnotating(false);
		}
	};

	const exitAnnotation = useCallback(() => {
		setAnnotating(false);
		setStill(null);
	}, []);

	const forgetAnnotation = async () => {
		const bound = browserId;
		if (bound === null) return;
		try {
			if (await client.updateContext(bound, [])) {
				say("ok", "Annotation removed.");
				// The seat's button would go on reading "Added" for a request the host no longer holds, and marking cannot
				// be taken back into the same seat: the human starts a new one.
				if (live(bound) && annotating) exitAnnotation();
			}
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
			} else if (event.key === "Escape" && !inField && !annotating && loading && document.querySelector(".bx-menu, .bx-pmenu") === null) {
				// While marking, Escape belongs to the annotation kit: it cancels a stroke in flight, and only then is Done.
				handled();
				act({ kind: "stop" });
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
				consents={consents}
				onConsent={onConsent}
				profile={profile}
				isPrivate={isPrivate}
				ownChrome={ownChrome}
				opening={opening}
				error={openError}
				closed={closed}
				onProfile={setProfile}
				onPrivate={setPrivate}
				onOwnChrome={setOwnChrome}
				onAddProfile={addProfileAtStart}
				onOpen={url => void open(url)}
			/>
		);
	}

	const parts = addressParts(state.url);
	const blank = parts.blank && !state.loading && !annotating;
	// Marking holds the page still: while the picture is being captured the page takes no input either.
	const mode = annotating ? "frozen" : locked ? "locked" : "live";
	const label = `${tabLabel(state.title, state.url)}${state.url.length > 0 ? ` — ${state.url}` : ""}`;
	const ended = task !== null && task.status !== "running" && watchedTaskRef.current === task.id && dismissedTask !== task.id;
	const showPublish =
		publish !== null &&
		dismissedPublish !== publish.publishId &&
		(publish.status === "awaiting-confirmation" || watchedPublishRef.current === publish.publishId);

	// The pill and the menu's own control row never show together: Take over is in one place at a time.
	const showControl = !taskRunning && !menuOpen && (state.takenOver || (agentActive && canTakeOver));
	const floats = (
		<>
			{((taskRunning && task !== null) || showPublish || showControl) && (
				<div className="bx-float bx-float-bottom" data-under-menu={menuOpen || undefined}>
					<div className="bx-float-column">
						{showPublish && publish !== null && (
							<PublishBar
								key={publish.publishId}
								client={client}
								browserId={browserId}
								publish={publish}
								onSettled={pullState}
								onDismiss={() => setDismissedPublish(publish.publishId)}
							/>
						)}
						{taskRunning && task !== null && <AgentPill task={task} cancelling={cancelling} onCancel={() => void cancelTask()} />}
						{showControl && <ControlPill takenOver={state.takenOver} busy={controlBusy} onTakeOver={() => void control("take")} onHandBack={() => void control("return")} />}
					</div>
				</div>
			)}
		</>
	);

	return (
		<div className="bx-browser" data-locked={locked || undefined} data-annotating={annotating || undefined}>
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
				profiles={{
					profile: state.profile,
					look: state.look,
					engine: state.engine,
					profiles,
					profilesError,
					switching,
					takenOver: state.takenOver,
					agentActive,
					canTakeOver,
					onMenu: setMenuOpen,
					onOpen: loadProfiles,
					consents,
					onConsent,
					browsers: browsers.filter(item => item.browserId !== browserId),
					onSwitch: target => void switchProfile(target),
					onSwitchBrowser: target => void switchBrowser(target),
					onCloseOther: target => void closeOther(target),
					onAdd: addProfile,
					onTakeOver: () => void control("take"),
					onHandBack: () => void control("return"),
				}}
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
				) : annotating && still !== null ? (
					<AnnotationSeat key={still.frameId} app={app} client={client} browserId={browserId} frame={still} floats={floats} onDone={exitAnnotation} />
				) : (
					<PageView
						picture={stream.picture}
						canvas={stream.canvas}
						viewport={viewport}
						mode={mode}
						onInput={input.send}
						onResize={onStageResize}
						label={label}
						confirming={publish?.status === "awaiting-confirmation" && publish.tabId === state?.activeTabId}
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
				{stream.connection === "reconnecting" && (
					<div className="bx-banner" role="status">
						<span className="bx-tab-spinner" aria-hidden="true" />
						Reconnecting to the browser…
						{stream.error !== null && <span className="bx-banner-detail">{stream.error}</span>}
					</div>
				)}

				{stream.connection === "unapproved" && (
					<div className="bx-banner bx-banner-paused" role="status" title={stream.error ?? undefined}>
						<Icon name="pause" size={14} strokeWidth={2} aria-hidden="true" />
						Live view paused: permission wasn't granted.
						<button type="button" className="bx-banner-action" onClick={stream.refresh}>
							Ask again
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
