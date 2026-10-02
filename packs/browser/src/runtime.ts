/**
 * BrowserRuntime — the browsers this pack holds, shared by the agent and the View.
 *
 * Design rules:
 *  - Actions execute when asked. The agent session (its permission mode, its
 *    own `ask`) decides whether to act; this runtime never second-guesses it.
 *  - One safety property is kept: an action that errors AFTER it was
 *    dispatched is reported `unknown` — it may have taken effect — and is never
 *    retried here. Only a caller that knows the page can decide to retry.
 *  - `browserId` is an opaque capability minted per open, never listed and
 *    never re-handed-out, except to the chat that already holds it;
 *    `profileList()` says whose a profile is, never by id.
 *  - Persistent profiles are never deleted, foreign locks are never stolen, a
 *    profile lock is released only once the owned Chrome process is gone, and a
 *    relay (the human's own Chrome) is never closed.
 *  - A browser opened without a profile is throwaway: its own directory under
 *    `ephemeral/`, no lock, deleted once its Chrome process is gone (and swept by
 *    the next server if this one died first). It keeps no sign-in, so whatever
 *    needs a saved profile refuses it (`profile_required`). Nobody can be
 *    relied on to close it (the host never says a session ended), so one a
 *    chat opened is also closed after THROWAWAY_IDLE_MS with no call, and the
 *    least recently used one is closed when the pool is full and a slot is
 *    wanted — never a saved profile, a browser a task or a call is working
 *    on, one a View has joined, and the person's own Private browser only
 *    after every chat's. A close that hangs is answered by killing the
 *    browser's process tree; the slot is freed only on a confirmed exit.
 *  - Whole tasks run on upstream agent loops (jev, browser-use) against the
 *    same Chrome, through `task.ts`. We keep their progress, not their logic.
 *  - Sign-in is only ever OBSERVED, never derived: a probe that saw the
 *    signed-in marker (or, on a site's front or login page, its absence) after
 *    a page loaded in a saved profile, or a publish result that says
 *    signed-in, not-signed-in or posted, is persisted per profile (never for
 *    the relay) and announced to `onConnectionsChanged` listeners, which the
 *    server turns into its connection report (connection.ts). A page with no
 *    probe is only "visited", never signed in or out.
 */
import { randomBytes } from "node:crypto";
import { existsSync, type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import { type ConnectionObservations, isPublicSite, siteHost } from "./connection.js";
import { matchProfiles, type ResolvedProfileMeta, resolveProfileMeta } from "./profile-meta.js";
import { profileSlug, RELAY_PROFILE } from "./profile-name.js";
import { buildProfileList } from "./profile-list.js";
import { probeFor, readProbe, SETTLE_MS, type SiteProbe, type ProbeVerdict } from "./probes.js";
import type {
	BrowserApp,
	BrowserOpener,
	ProfileHolder,
	ProfileListing,
	ActionResult,
	ActManyResult,
	BatchStep,
	EvalStep,
	LogEntry,
	ModelShot,
	ShotRequest,
	PageScroll,
	TabOp,
	CredentialUse,
	HandledDialog,
	BrowserAction,
	BrowserAnnotationContext,
	BrowserEngine,
	BrowserFrame,
	BrowserOpenOptions,
	BrowserRegion,
	BrowserRuntimePort,
	BrowserState,
	MouseButton,
	PresetRef,
	PublishCheck,
	PublishMode,
	PublishRecipe,
	PublishExpectation,
	PublishRecord,
	ReadRequest,
	ReadResult,
	TabRequest,
	TaskRequest,
	TaskRun,
	TaskStep,
	ToolCaller,
	Viewport,
	InspectResult,
	WaitRequest,
	WaitResult,
	StepOutcome,
	StepStatus,
} from "./contracts.js";
import { BROWSER_ENGINES, MAX_ANNOTATION_REGIONS, MAX_BATCH_STEPS, MAX_EVAL_EXPRESSION_CHARS, MAX_EVAL_RESULT_CHARS, MAX_VIEWPORT, MAX_WAIT_MS, MIN_VIEWPORT, TASK_AGENTS } from "./contracts.js";
import { credentialOrigin, resolveCredential, savedPassword, savedPasswords } from "./credentials.js";
import { assertEngineAvailable, createEngineDriver } from "./engines/index.js";
import { withTimeout } from "./engines/launch.js";
import { launchReader } from "./engines/puppeteer.js";
import type { EngineDriver, EngineState, EvalOutcome, LiveFrame, PageReader, PasswordSource, PerformOutcome, WaitCondition } from "./engines/types.js";
import { AnnotationFiles } from "./annotation-file.js";
import { clampRegion, MAX_FRAME_BYTES } from "./image.js";
import { type AdmittedInput, admitInput } from "./input.js";
import { type Publication, cancel, confirm, isPending, prepare, publishRecord, requirePending, validateMode, validateRecipe, waitSettled } from "./publish.js";
import { blockedReason, DEFAULT_READ_CHARS, MAX_READ_CHARS, READ_TIMEOUT_MS, readPolicy, TIMEOUT_REASON } from "./read.js";
import { ActionNotDispatched, fail, ProfileStore, validateProfile } from "./store.js";
import { type RunningWorker, startWorker } from "./task.js";
import type { CodeLifetime, CodeSeam, EndListener, EndWhy } from "./code/host/runtime-port.js";

// ---------------------------------------------------------------------------
// Bounds. Every unbounded thing in a long-lived runtime is a leak or a weapon.
// ---------------------------------------------------------------------------
const MAX_BROWSERS = 4;
/** The browser applications a profile's logins may have been saved in, as a person names them. */
const APP_NAMES: Record<string, string> = { chrome: "Chrome", msedge: "Edge", chromium: "Chromium", custom: "a custom browser" };
/** A page that loads (or changes route) is looked at this long after the last such event, once. */
const PROBE_DEBOUNCE_MS = 400;
/** The look at close never holds a close up longer than this. */
const PROBE_CLOSE_MS = 2_500;
/** The same sign-in fact is not rewritten more often than this; a visit to a site with no probe, less often still. */
const CHECK_RENOTE_MS = 30_000;
const VISIT_RENOTE_MS = 10 * 60_000;
/** Remembered "last noted" facts; the table is emptied when it grows past this. */
const MAX_NOTED = 512;
/** browser_read's reader browser is closed this long after its last read. */
const READER_IDLE_MS = 60_000;
/**
 * A throwaway browser a chat opened and nobody has called for this long is closed. The host stamps every call with its session but
 * sends this server no word when a session ends, so a browser whose chat is gone looks exactly like one whose model is thinking:
 * silence is the only evidence there is. Long on purpose: a model that works elsewhere for a few minutes keeps its page, and
 * contention for slots is settled by least-recently-used eviction at the cap, not by this clock. A chat that comes back to a closed
 * browser is told what happened (`released`), not that its id is unknown.
 */
const THROWAWAY_IDLE_MS = 10 * 60_000;
/** The longest delay a timer holds: a larger one fires after 1 ms, which would turn the idle check into a busy loop. */
const MAX_TIMER_MS = 2_147_483_647;
/**
 * How long a throwaway's polite close gets before its process tree is killed: the driver's own 15 s bound on the browser exiting,
 * plus what runs before it (CDP detaches that a frozen browser never answers). Under the host's 30 s tool-call limit with the kill.
 */
const GRACEFUL_CLOSE_MS = 20_000;
/** A throwaway that could not be stopped is tried again after this long, or one idle period when that is shorter. */
const CLOSE_RETRY_MS = 30_000;
/** Ids of browsers the runtime closed on its own that are remembered, so their chats are told why; the oldest are forgotten first. */
const MAX_RELEASED = 64;
const MAX_FRAMES_RETAINED = 8;
/** A batch takes no new step after this long: a host times a tool call out (the desktop at 30 s). */
const ACT_BUDGET_MS = 20_000;
/** Dialogs a batch reports, as many as a state does. */
const MAX_BATCH_DIALOGS = 5;
const MAX_SNAPSHOT_CHARS = 20_000;
const MAX_ELEMENT_CHARS = 4_000;
const MAX_TEXT_INPUT = 4_096;
const MAX_SELECTOR_CHARS = 512;
/** How long, in all, a capture waits for a scrolling page to come to rest: this many captures this far apart. */
const SCROLL_SETTLE_ATTEMPTS = 6;
const SCROLL_SETTLE_MS = 100;
const MAX_TAB_ID_CHARS = 128;
const MOUSE_BUTTONS: readonly MouseButton[] = ["left", "right", "middle"];
const MAX_URL_LENGTH = 2_048;
const MAX_SCROLL_DELTA = 5_000;
const MAX_TASK_CHARS = 8_192;
const MAX_TASK_STEPS = 200;
const DEFAULT_WAIT_MS = 5_000;
const MAX_WAIT_MATCH_CHARS = 2_048;
const DEFAULT_TASK_STEPS = 60;
const TASK_STEPS_RETAINED = 100;
const DEFAULT_VIEWPORT: Viewport = { width: 1_280, height: 800 };
const NAMED_KEYS: Record<string, true> = {
	Enter: true,
	Tab: true,
	Escape: true,
	Backspace: true,
	Delete: true,
	ArrowUp: true,
	ArrowDown: true,
	ArrowLeft: true,
	ArrowRight: true,
	Home: true,
	End: true,
	PageUp: true,
	PageDown: true,
	Space: true,
};
/** View input that can press the site's own submit; scroll, hover and navigation cannot. */
const TOUCHING_KINDS: Partial<Record<BrowserAction["kind"], true>> = { click: true, press: true, type: true, insert: true };
/** The same, for the direct channel: a press, a release, a key or pasted text can press the site's own submit; a move and a wheel cannot. */
const touchesPage = (event: AdmittedInput): boolean => event.kind !== "wheel" && !(event.kind === "mouse" && event.type === "move");

export interface BrowserRuntimeOptions {
	/** Profile root; defaults to `$INSO_HOME/browser` else `~/.inso/browser`. */
	rootDir?: string;
	/** Chrome/Chromium binary. Omitted → the View picks installed Chrome, then Edge, then a Chromium (engines/launch.ts); the reader uses puppeteer's `chrome` channel. */
	executablePath?: string;
	/** chrome-relay CDP endpoint. Defaults to http://127.0.0.1:9224. */
	relayUrl?: string;
	/** Explicit browser visibility; omitted uses each engine's supported default. */
	headless?: boolean;
	/** How long a batch (`actMany`) may go on taking steps; defaults to ACT_BUDGET_MS. */
	actBudgetMs?: number;
	/** How long a throwaway browser a chat opened may go without a call (and with no View joined) before it is closed; defaults to THROWAWAY_IDLE_MS, at most 2147483647 (a timer's limit). */
	throwawayIdleMs?: number;
	/**
	 * TESTS ONLY: exact hostnames browser_read may reach although they are
	 * loopback/private (the local fixture on 127.0.0.1). Never set in
	 * production; it is not reachable from any tool input.
	 */
	allowPrivateReadHosts?: readonly string[];
	/**
	 * TESTS ONLY: replaces the shipped site probes, how long a missing marker is waited for, and which hosts a
	 * visit is recorded for (the local fixture is on loopback, which is never a site); `looked` hears the url of
	 * every page a look finished on, whether it found anything or not. Not reachable from any tool input.
	 */
	probes?: { table?: readonly SiteProbe[]; settleMs?: number; recordVisit?: (url: string) => boolean; looked?: (url: string) => void };
}

/** A wait step after `validateWait`. */
interface PlannedWait { kind: "wait"; condition: WaitCondition; timeoutMs: number }

/** What one step did, before it is filed in a result. */
interface StepDone { status: StepStatus; error?: string; credential?: CredentialUse; dialogs?: HandledDialog[]; value?: string; truncated?: boolean }

/** A dispatched action either completed or was reported `failed`/`unknown`, never a throw. */
type Dispatched = { status: "completed"; credential?: CredentialUse; dialogs?: HandledDialog[] } | { status: "failed" | "unknown"; error: string };

/** A tab step after `admitTab`: `url`, when given, is already canonical. */
interface PlannedTab { kind: "tab"; op: TabOp; tabId?: string; url?: string }

/** An eval step that was admitted: the browser is a throwaway one. */
interface PlannedEval { kind: "eval"; expression: string }

type PlannedStep = BrowserAction | PlannedWait | PlannedTab | PlannedEval;

/** A png frame the View was handed. The picture itself is the View's; this is what annotating it must still agree with. */
interface FrameRecord {
	id: string;
	url: string;
	title: string;
	revision: number;
	viewport: Viewport;
	/** Where the page was scrolled when the picture was taken. */
	scroll: PageScroll;
	capturedAt: string;
}

interface Entry {
	/** Opaque capability. Never listed, never re-handed-out. */
	browserId: string;
	/** null: a throwaway browser (no saved profile). */
	profile: string | null;
	engine: BrowserEngine;
	viewport: Viewport;
	driver: EngineDriver;
	documentId: string;
	release(): void;
	revision: number;
	frames: FrameRecord[];
	/** Per-browser serializer: page reads and actions run in order. */
	queue: Promise<unknown>;
	/** The human's input batches, in order, apart from `queue`: input never waits for page work. */
	inputQueue: Promise<unknown>;
	closed: boolean;
	/** The running or most recent task. */
	task: TaskRun | null;
	/** The live task worker, while one runs. */
	worker: { process: RunningWorker; finished: Promise<TaskRun> } | null;
	/** The current or most recent publish (publish.ts). */
	publish: Publication | null;
	/**
	 * Saved passwords this browser typed or handed a task worker. With every
	 * password the profile holds on disk, they are replaced in every page read
	 * handed back (snapshot, state, act results, annotation context), so a page
	 * that reveals or copies one — a show-password toggle flipping the field to
	 * text — never returns it. Kept in memory too: a deleted or unreadable
	 * credentials file must not un-redact a password already typed.
	 */
	secrets: Set<string>;
	/**
	 * The newest log entry (`LogEntry.n`) a model has read (browser_state) and the newest one it was told the count
	 * of (`newErrors`), so each is reported once; the View reads neither.
	 */
	logRead: number;
	/** Who opened it, as the host stamped the call: what `heldBy` and a second open of the same profile are judged by. */
	opener: BrowserOpener;
	/** Set at launch when the browser build under this profile changed; handed to the opener once, by `open`. */
	notice?: string;
	/** The passive sign-in look: debounced after a page loads, one at a time, once more as the browser closes. */
	probe: { timer: NodeJS.Timeout | undefined; running: Promise<void> | undefined; again: boolean };
	logNoticed: number;
	/** Where the detail documents of what the human marks in this browser are kept: shared for a saved profile, its own throwaway folder otherwise. */
	annotations: AnnotationFiles;
	/** `performance.now()` when a call last reached this browser, from anyone: what the idle timeout and the least-recently-used order read. */
	lastUsed: number;
	/** Views joined to its live stream right now (stream.ts, through `viewing`). While any is, nobody may give the browser up. */
	viewers: number;
	/** Page-work calls queued or running. A browser with one is working, whatever the clocks say. */
	pending: number;
	/** A throwaway's idle timer, or its close retry (never set for a saved profile or the relay, nor for one a person opened). */
	idle: NodeJS.Timeout | undefined;
	/** Set once the runtime began closing it for being idle or to make room; cleared again if that close failed. */
	retiring: Promise<void> | undefined;
	/** A throwaway's polite close has failed once: it is killed from then on, because puppeteer treats a second close as already done. */
	closeFailed: boolean;
	/** Set when a cell's `browser.open` made it (doc 77 §7.4.3): its own idle clock, and `persist` exempts it from idle close and from being closed to make room. */
	code?: CodeLifetime;
}

export class BrowserRuntime implements BrowserRuntimePort {
	private readonly store: ProfileStore;
	private readonly annotationFiles: AnnotationFiles;
	private readonly options: BrowserRuntimeOptions;
	private readonly byId = new Map<string, Entry>();
	private readonly byProfile = new Map<string, Entry>();
	/**
	 * The browser the human opened or is viewing in each session, by the session id the HOST stamped on the call
	 * (never one a caller passed). It lets that session's model find a browser it was never handed an id for;
	 * an entry goes when its browser does.
	 */
	private readonly viewBySession = new Map<string, string>();
	/** In-flight launches, so a second open cannot race a first one. */
	private readonly opening = new Map<string, Promise<Entry>>();
	/**
	 * browser_read's headless reader (no profile; a fresh incognito context per
	 * read). It takes one slot of MAX_BROWSERS while it lives, closes after
	 * READER_IDLE_MS without a read, and is evicted for a Browser View open when
	 * the pool is full. Its launch, its reads and its close run in order on
	 * `readerQueue`.
	 */
	private pageReader: PageReader | null = null;
	private readerLaunching = false;
	private readerQueue: Promise<unknown> = Promise.resolve();
	private readerIdle: NodeJS.Timeout | undefined;
	/**
	 * Drivers whose rollback close failed during launch. Their shutdown is
	 * unconfirmed, so their profile lock is deliberately retained; keeping the
	 * driver here is what makes that close retryable instead of orphaning a
	 * process the runtime can no longer name.
	 */
	private readonly stranded = new Set<{ driver: EngineDriver; release: () => void }>();
	/** Throwaway directories being deleted; `close` and `dispose` wait for them. */
	private readonly removals = new Set<Promise<void>>();
	private disposed = false;
	/** The opener of a saved profile whose browser is still launching, so the same chat opening it twice gets one browser. */
	private readonly openers = new Map<string, BrowserOpener>();
	/** The last passive observation per profile and site, so a page that reloads does not rewrite the same fact. */
	private readonly lastNoted = new Map<string, { key: string; at: number }>();
	private readonly connectionListeners = new Set<() => void>();
	/** Profiles with persisted observations, so a deleted one is noticed and reported gone. */
	private readonly observedProfiles = new Set<string>();
	/** How long a throwaway may go without a call before it is closed (see THROWAWAY_IDLE_MS). */
	private readonly idleMs: number;
	/** Why a browser the runtime closed on its own is gone, by id, so the chat that held it is told rather than sent "unknown". */
	private readonly released = new Map<string, string>();
	/** Watches the profile root for deletions while anyone listens for connection changes. */
	private profileWatcher: FSWatcher | undefined;
	/** The code host (src/code/host) hears when a browser ends, and when a View joins one. */
	private readonly endListeners = new Set<EndListener>();
	private readonly viewListeners = new Set<(browserId: string) => void>();
	private seam: CodeSeam | undefined;

	constructor(options: BrowserRuntimeOptions = {}) {
		this.options = options;
		this.idleMs = options.throwawayIdleMs ?? THROWAWAY_IDLE_MS;
		if (!Number.isFinite(this.idleMs) || this.idleMs <= 0 || this.idleMs > MAX_TIMER_MS) {
			throw new RangeError(`throwawayIdleMs must be a number of milliseconds above 0 and at most ${MAX_TIMER_MS}, got ${String(options.throwawayIdleMs)}`);
		}
		this.store = new ProfileStore(options.rootDir);
		this.annotationFiles = new AnnotationFiles(join(this.store.rootDir, "annotations"));
		// Only what a dead server abandoned: a live server's throwaway browsers are never touched.
		this.store.sweepEphemeral();
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	/**
	 * Open a browser and mint a fresh capability for it.
	 *
	 * With a `profile` it runs on that persistent profile. A profile that is
	 * already open — or in the middle of opening — is REFUSED. One engine server
	 * serves many sessions, so returning the live browserId of somebody else's
	 * browser would hand out their capability; and launching a second Chrome on
	 * the same user-data dir would fork the cookie jar. So the chat that already
	 * holds a profile (the host's session stamp on `opener`) gets its own browser
	 * back, and anyone else is refused (`profile_held`, naming whose it is, never
	 * an id): the holder closes it, or the caller picks another profile.
	 *
	 * `profile` is a slug or a label, in any case. An exact slug is always that
	 * profile; a label that two profiles share is refused (`profile_ambiguous`),
	 * never resolved to the closest. A name that matches none is a new profile
	 * when it is a valid slug (a person's first sign-in, an account profile), and
	 * refused (`profile_unknown`) when it is not one.
	 *
	 * Without a `profile` it is a throwaway browser: a directory of its own that
	 * is deleted when it closes, so it can never collide with another browser.
	 *
	 * With the pool full, the throwaway used least recently that is neither working nor watched is closed first (its Chrome gone before
	 * this launches); when there is none, the open is refused (`too_many_browsers`) naming the browsers this chat holds.
	 */
	async open(options: BrowserOpenOptions, opener: BrowserOpener = {}, code?: CodeLifetime): Promise<BrowserState> {
		if (this.disposed) fail("disposed", "runtime has been disposed");
		const engine = normalizeEngine(options.engine);
		const named = options.profile === undefined ? undefined : this.resolveProfile(options.profile, engine);
		const viewport = normalizeViewport(options.viewport);
		// The relay is the human's own Chrome: there is nothing to make throwaway,
		// so no profile means the one it has.
		const profile = named ?? (engine === "chrome-relay" ? RELAY_PROFILE : null);

		// The relay is ONE already-running Chrome with ONE cookie jar, chosen by
		// the human inside Chrome. Named relay profiles would imply an isolation
		// that does not exist, so the slug "relay" is reserved for it and is the
		// only slug it accepts. Other engines own their persistent profile data.
		if (engine === "chrome-relay" && profile !== RELAY_PROFILE) {
			fail(
				"bad_profile",
				`the chrome-relay engine attaches to the one Chrome already running, so it always uses the reserved profile "${RELAY_PROFILE}"; ` +
					`choose another engine for separate, isolated profiles`,
			);
		}
		if (engine !== "chrome-relay" && profile === RELAY_PROFILE) {
			fail("bad_profile", `profile "${RELAY_PROFILE}" is reserved for the chrome-relay engine`);
		}
		for (;;) {
			// browser_read's reader never keeps the human from a browser: when it holds the last slot it is closed (after any read in progress) first.
			if (this.byId.size + this.opening.size >= MAX_BROWSERS - 1 && this.readerHeld()) await this.closeReader();
			if (this.disposed) fail("disposed", "runtime has been disposed");
			// Everything between these checks and the launch below is synchronous: a second open cannot take the slot or the profile in between.
			const live = profile === null ? undefined : this.byProfile.get(profile);
			if (profile !== null && live !== undefined) {
				const holder = this.holderOf(live.opener, opener.session);
				if (holder === "this chat") return await this.state(live.browserId);
				fail("profile_held", heldMessage(profile, holder));
			}
			const launching = profile === null ? undefined : this.opening.get(profile);
			if (profile !== null && launching !== undefined) {
				// The same chat opening it twice at once (parallel tool calls) is one browser, not a refusal.
				const holder = this.holderOf(this.openers.get(profile) ?? {}, opener.session);
				if (holder === "this chat") return await this.state((await launching).browserId);
				fail("profile_held", heldMessage(profile, holder));
			}
			// Count launches in flight too: four concurrent opens must not slip past the bound just because none of them has finished launching yet.
			if (this.byId.size + this.opening.size + (this.readerHeld() ? 1 : 0) < MAX_BROWSERS) break;
			// Full: give up the least recently used throwaway nothing is happening on, or refuse naming what this chat holds. Then look again from the top.
			await this.makeRoom(opener.session);
		}

		assertEngineAvailable(engine);
		// A throwaway browser has no name to guard; its slot only counts against the bound. `:` is not a slug character.
		const slot = profile ?? `ephemeral:${randomBytes(8).toString("hex")}`;
		const started = this.launch(profile, engine, viewport, opener, code).finally(() => {
			this.opening.delete(slot);
			this.openers.delete(slot);
		});
		this.opening.set(slot, started);
		this.openers.set(slot, opener);
		const entry = await started;
		const state = this.redact(entry, await this.buildState(entry));
		const { notice } = entry;
		delete entry.notice;
		return notice === undefined ? state : { ...state, notice };
	}

	private async launch(profile: string | null, engine: BrowserEngine, viewport: Viewport, opener: BrowserOpener, code?: CodeLifetime): Promise<Entry> {
		// A saved profile is locked while its browser runs; a throwaway one gets a
		// directory of its own that goes with the browser.
		let directory: string;
		let free: () => void;
		let annotations = this.annotationFiles;
		if (profile === null) {
			const ephemeral = this.store.createEphemeral();
			directory = ephemeral.userDataDir;
			free = () => this.discard(ephemeral.dir);
			// What the human marked on a throwaway page is as private as the page: the folder goes when the browser does.
			annotations = new AnnotationFiles(join(ephemeral.dir, "annotations"));
		} else {
			const lock = this.store.acquireLock(profile);
			// Native backends never reuse an incompatible engine's cookie store.
			directory = engine === "chromium" ? this.store.userDataDir(profile) : join(this.store.profileDir(profile), engine);
			free = () => this.store.releaseLock(lock);
		}
		let released = false;
		let entry: Entry | undefined;
		let driver: EngineDriver | undefined;
		const release = (): void => {
			if (released) return;
			free();
			released = true;
			if (entry) this.detach(entry);
		};
		try {
			driver = await createEngineDriver(engine, {
				profileDirectory: directory, viewport, onClosed: release,
				// The passive sign-in look: a saved profile on our own Chrome, never the relay's and never a throwaway.
				...(profile !== null && engine === "chromium" ? { onPageLoaded: () => { if (entry !== undefined) this.schedulePageProbe(entry, this.options.probes?.settleMs ?? SETTLE_MS); } } : {}),
				...(this.options.headless === undefined ? {} : { headless: this.options.headless }),
				...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
				...(this.options.relayUrl && engine === "chrome-relay" ? { relayUrl: this.options.relayUrl } : {}),
			});
			const initial = await driver.state();
			if (released) fail("browser_closed", "The browser closed during initialization.");
			entry = {
				browserId: randomBytes(24).toString("base64url"),
				profile, engine, viewport: initial.viewport, documentId: initial.documentId,
				driver, release, revision: 1, frames: [], queue: Promise.resolve(), inputQueue: Promise.resolve(), closed: false,
				task: null, worker: null, publish: null, secrets: new Set(), logRead: 0, logNoticed: 0, annotations,
				opener, probe: { timer: undefined, running: undefined, again: false },
				lastUsed: performance.now(), viewers: 0, pending: 0, idle: undefined, retiring: undefined, closeFailed: false,
			};
			if (code !== undefined) entry.code = code;
			if (profile !== null && profile !== RELAY_PROFILE) entry.notice = this.touchProfile(profile, driver.app);
			this.byId.set(entry.browserId, entry);
			if (profile !== null) this.byProfile.set(profile, entry);
			// A person's own Private browser is theirs: no clock closes it (the leak is chats' browsers, and the View stops reading while its tab is hidden).
			if (profile === null && opener.caller !== "app") this.watchIdle(entry, this.idleOf(entry));
			return entry;
		} catch (error) {
			// A factory owns rollback until it returns; only its confirmed-close
			// callback may release a failed launch. Never infer exit from failure.
			if (driver) {
				const orphan = driver;
				try {
					await orphan.close();
					release();
				} catch {
					// Shutdown unconfirmed: keep the lock, and keep the driver
					// reachable so dispose() retries instead of losing a process
					// that may still hold the profile. The launch error is what
					// the caller needs; the close failure is ours to retry.
					this.stranded.add({ driver: orphan, release });
				}
			}
			// A failed throwaway launch leaves nothing behind by the time the caller hears of it.
			await Promise.allSettled(this.removals);
			throw error;
		}
	}

	/** Delete a throwaway browser's directory in the background; `close` and `dispose` wait for it. */
	private discard(dir: string): void {
		const removal: Promise<void> = this.store.removeEphemeral(dir).finally(() => this.removals.delete(removal));
		this.removals.add(removal);
	}

	/** Refused (`publish_pending`) while a publish awaits confirmation, unless `caller` is "app". */
	async close(browserId: string, caller?: ToolCaller): Promise<void> {
		// A failed close revokes reads/actions but remains retryable for cleanup.
		const entry = this.byId.get(browserId);
		if (!entry) {
			// Already closed by the runtime (idle, or to make room): what was asked for is true, so it is not an error.
			if (this.released.has(browserId)) return;
			fail("unknown_browser", "Unknown or already closed browserId.");
		}
		await this.serialize(entry, async () => {
			if (!entry.closed) refuseWhilePublishing(entry, caller);
			await this.teardown(entry);
		}, { evenIfClosed: true });
		// A throwaway browser's data is gone by the time its close resolves.
		await Promise.allSettled(this.removals);
	}

	/** Retain ownership and the lock until the driver confirms shutdown. A throwaway that cannot be stopped is tried again soon. */
	private async teardown(entry: Entry): Promise<void> {
		if (this.byId.get(entry.browserId) !== entry) return;
		settleOnClose(entry);
		const ending = !entry.closed;
		entry.closed = true;
		if (ending) this.notifyEnd(entry, entry.retiring === undefined ? "closed" : "retired");
		entry.frames.length = 0;
		try {
			// A task agent drives this Chrome; it stops before the browser does.
			await this.stopTask(entry);
			// One last look at the page the person leaves on: a sign-in done in place never loads a page. It must not hold a close up.
			await this.probeAtClose(entry);
			await this.stopBrowser(entry);
		} catch (error) {
			if (entry.profile === null) this.retryClose(entry);
			throw error;
		}
		this.markUsed(entry);
		entry.release();
	}

	/**
	 * Stop `entry`'s browser. A saved profile's gets the driver's own confirmed close and nothing harder: its lock holds until the
	 * process is provably gone, and a hard kill could cut a write to logins that matter. A throwaway keeps nothing, so a close that
	 * hangs or fails is answered by killing the process tree (a Chrome seen hanging on exit never leaves by itself), and its slot is
	 * freed only once the driver has seen the process exit. A close that failed once is not asked again: puppeteer takes a second one
	 * for done at once, and releasing on that would free the slot of a Chrome that may still be running.
	 */
	private async stopBrowser(entry: Entry): Promise<void> {
		if (entry.profile !== null) return await entry.driver.close();
		if (!entry.closeFailed) {
			try {
				return await withTimeout(entry.driver.close(), GRACEFUL_CLOSE_MS, "browser close");
			} catch (error) {
				entry.closeFailed = true;
				console.error("A throwaway browser did not close politely; its process tree is killed:", describe(error));
			}
		}
		await entry.driver.kill();
	}

	/** A throwaway holds a slot and may hold a Chrome, and its chat may never call it again: try to stop it again soon, and again if that fails. */
	private retryClose(entry: Entry): void {
		if (this.disposed) return;
		clearTimeout(entry.idle);
		entry.idle = setTimeout(() => {
			void this.serialize(entry, () => this.teardown(entry), { evenIfClosed: true })
				.then(() => Promise.allSettled(this.removals))
				.catch((error: unknown) => console.error("A throwaway browser still would not close:", describe(error)));
		}, Math.min(this.idleMs, CLOSE_RETRY_MS));
		entry.idle.unref();
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.connectionListeners.clear();
		this.profileWatcher?.close();
		this.profileWatcher = undefined;
		// Let in-flight launches finish first: a browser born after we started
		// disposing would otherwise outlive the runtime holding its lock.
		await Promise.allSettled(this.opening.values());
		const errors: string[] = [];
		// Queued behind any read in flight, so the reader is not closed under it.
		await this.closeReader().catch((err) => errors.push(describe(err)));
		for (const entry of [...this.byId.values()]) {
			await this.serialize(entry, () => this.teardown(entry), { evenIfClosed: true }).catch((err) =>
				errors.push(describe(err)),
			);
		}
		for (const orphan of [...this.stranded]) {
			try {
				await orphan.driver.close();
				orphan.release();
				this.stranded.delete(orphan);
			} catch (err) {
				errors.push(describe(err));
			}
		}
		await Promise.allSettled(this.removals);
		if (errors.length > 0) fail("dispose_incomplete", `some browsers did not shut down cleanly: ${errors.join("; ")}`);
	}

	/** Drop in-memory state and make the capability dead. Does NOT free the lock. */
	private detach(entry: Entry): void {
		settleOnClose(entry);
		entry.closed = true;
		entry.frames.length = 0;
		entry.worker?.process.cancel();
		clearTimeout(entry.probe.timer);
		clearTimeout(entry.idle);
		this.byId.delete(entry.browserId);
		if (entry.profile !== null && this.byProfile.get(entry.profile) === entry) this.byProfile.delete(entry.profile);
		for (const [session, browserId] of this.viewBySession) if (browserId === entry.browserId) this.viewBySession.delete(session);
	}

	bindView(session: string, browserId: string): void {
		const entry = this.byId.get(browserId);
		if (entry && !entry.closed) this.viewBySession.set(session, browserId);
	}

	viewOf(session: string): string | undefined {
		return this.viewBySession.get(session);
	}

	// -----------------------------------------------------------------------
	// Throwaway browsers nobody is using
	// -----------------------------------------------------------------------

	/**
	 * Close `entry` for a reason the chat that held it is told on its next call, and return once its Chrome is gone and its directory is
	 * deleted. One close per browser: a second caller gets the first one's outcome. A close that fails rejects, and `teardown` has by then
	 * scheduled another try.
	 */
	private retire(entry: Entry, reason: string): Promise<void> {
		entry.retiring ??= (async () => {
			this.remember(entry.browserId, reason);
			await this.serialize(entry, () => this.teardown(entry), { evenIfClosed: true });
			await Promise.allSettled(this.removals);
		})().catch((error: unknown) => {
			// No longer on its way out, so nobody waits for it; it keeps its slot until a retry stops it.
			entry.retiring = undefined;
			throw error;
		});
		return entry.retiring;
	}

	private remember(browserId: string, reason: string): void {
		this.released.set(browserId, reason);
		if (this.released.size <= MAX_RELEASED) return;
		for (const oldest of this.released.keys()) {
			this.released.delete(oldest);
			break;
		}
	}

	/** A call is queued or running, or a task agent is driving it: nothing may close this browser under that work. */
	private working(entry: Entry): boolean {
		return entry.pending > 0 || entry.worker !== null;
	}

	/** Look at `entry` again after `afterMs`. One timer per idle period, never one per call: a call only stamps `lastUsed`. */
	private watchIdle(entry: Entry, afterMs: number): void {
		entry.idle = setTimeout(() => this.checkIdle(entry), afterMs);
		entry.idle.unref();
	}

	private checkIdle(entry: Entry): void {
		if (entry.closed || entry.retiring !== undefined) return;
		const quietMs = performance.now() - entry.lastUsed;
		const idleMs = this.idleOf(entry);
		// A View joined to its stream is watching it however long the page takes to answer; a call in flight is work; a persisted code browser stays.
		if (this.working(entry) || entry.viewers > 0 || entry.code?.persist === true || quietMs < idleMs) {
			this.watchIdle(entry, this.working(entry) || entry.viewers > 0 || entry.code?.persist === true ? idleMs : idleMs - quietMs);
			return;
		}
		const reason = entry.code === undefined
			? `it was a throwaway browser, closed after ${idleMs / 1_000} s with no calls; open a new one with browser_open`
			: `it was a code browser, closed after ${idleMs / 1_000} s with no calls; open a new one with browser.open`;
		void this.retire(entry, reason).catch((error: unknown) => console.error("An idle throwaway browser was not closed:", describe(error)));
	}

	/**
	 * The throwaway to give up when the pool is full: the one used least recently that nothing is happening on and no View has joined,
	 * a chat's before the person's own Private one. A saved profile (and the relay) is never one: it holds a lock and logins. One
	 * already on its way out is not asked about: `makeRoom` waits for it instead.
	 */
	private pickVictim(): Entry | undefined {
		let victim: Entry | undefined;
		for (const entry of this.byId.values()) {
			if (entry.profile !== null || entry.closed || entry.viewers > 0 || entry.code?.persist === true || this.working(entry)) continue;
			const personal = entry.opener.caller === "app";
			const victimPersonal = victim?.opener.caller === "app";
			if (victim === undefined || (!personal && victimPersonal) || (personal === victimPersonal && entry.lastUsed < victim.lastUsed)) victim = entry;
		}
		return victim;
	}

	/**
	 * Free one slot of a full pool or refuse. A browser already on its way out frees a slot by itself, so that is waited for instead of
	 * closing a second one; otherwise the victim is closed, its Chrome confirmed gone, before this returns. The caller looks again.
	 */
	private async makeRoom(asker: string | undefined): Promise<void> {
		const leaving = [...this.byId.values()].flatMap((entry) => (entry.retiring === undefined ? [] : [entry.retiring]));
		if (leaving.length > 0) {
			await Promise.race(leaving).catch(() => undefined);
			return;
		}
		const victim = this.pickVictim();
		if (victim === undefined) fail("too_many_browsers", this.refusal(asker, "none can be closed to make room: each is running a task, has a call in progress, is open in a View, is still shutting down, or is a saved profile's"));
		const reason = `it was a throwaway browser, closed to make room for another chat's (at most ${MAX_BROWSERS} are open at once); open a new one with browser_open`;
		try {
			await this.retire(victim, reason);
		} catch (error) {
			// One open closes one browser at most: when that one will not go, this open is refused rather than moved on to the next chat's.
			console.error("A throwaway browser was not closed to make room:", describe(error));
			fail("too_many_browsers", this.refusal(asker, "the one chosen to make room is still shutting down and no other was closed"));
		}
	}

	/** Why nothing could be given up. It names what `asker` itself holds, never what anyone else does: an id is a capability. */
	private refusal(asker: string | undefined, because: string): string {
		const held = asker === undefined ? [] : [...this.byId.values()].filter((entry) => entry.opener.session === asker && !entry.closed).map((entry) => entry.browserId);
		const why = `at most ${MAX_BROWSERS} browsers may be open at once, and ${because}`;
		return held.length > 0 ? `${why}. You hold ${held.join(", ")}: browser_close the ones you are done with` : `${why}. None is yours; try again shortly`;
	}

	/**
	 * A View joined `browserId`'s live stream (stream.ts): while any View is joined nobody may give the browser up, and it is not idle.
	 * Returns what ends that. A count, not a clock: a View whose page answers slowly is still watching.
	 */
	viewing(browserId: string): () => void {
		const entry = this.require(browserId);
		entry.viewers += 1;
		for (const listener of [...this.viewListeners]) listener(browserId);
		let ended = false;
		return () => {
			if (ended) return;
			ended = true;
			entry.viewers -= 1;
			entry.lastUsed = performance.now();
		};
	}

	/** How long `entry` may go without a call: a cell's browser has its own clock (OMP's 1,800 s); every other throwaway has the pack's. */
	private idleOf(entry: Entry): number {
		return entry.code?.idleMs ?? this.idleMs;
	}

	// -----------------------------------------------------------------------
	// The code seam (src/code/host): a browser a cell opens is an entry like any other
	// -----------------------------------------------------------------------

	private notifyEnd(entry: Entry, why: EndWhy): void {
		const reason = this.released.get(entry.browserId);
		for (const listener of [...this.endListeners]) {
			try {
				listener(entry.browserId, why, reason);
			} catch (error) {
				console.error("A browser-end listener failed:", describe(error));
			}
		}
	}

	/** One call in flight on `entry`, for a cell: out of idle close and make-room, refused like a page call while a task or a pending publish owns the page. Returns what ends it. */
	private holdWork(entry: Entry): () => void {
		refuseWhileBusy(entry, undefined);
		entry.pending += 1;
		let held = true;
		return () => {
			if (!held) return;
			held = false;
			entry.pending -= 1;
			entry.lastUsed = performance.now();
		};
	}

	/** The closures the code host drives. The runtime stays the one owner of browsers, locks, sessions and the View's stream; the host owns workers and cells. */
	codeSeam(): CodeSeam {
		return (this.seam ??= {
			open: async (options, opener, code) => await this.open(options, opener, code),
			resize: async (browserId, viewport, scale) => await this.resize(browserId, viewport, scale),
			close: async (browserId) => await this.close(browserId),
			require: (browserId) => this.require(browserId),
			peek: (browserId) => {
				const entry = this.byId.get(browserId);
				return entry === undefined || entry.closed ? undefined : entry;
			},
			browsersOf: (session) => [...this.byId.values()].filter((entry) => !entry.closed && entry.opener.session === session),
			viewOf: (session) => this.viewOf(session),
			bindView: (session, browserId) => this.bindView(session, browserId),
			hold: (entry) => this.holdWork(entry as Entry),
			serialize: (entry, work) => this.serialize(entry as Entry, work),
			onEnd: (listener) => {
				this.endListeners.add(listener);
				return () => void this.endListeners.delete(listener);
			},
			onViewed: (listener) => {
				this.viewListeners.add(listener);
				return () => void this.viewListeners.delete(listener);
			},
		});
	}

	// -----------------------------------------------------------------------
	// Read paths
	// -----------------------------------------------------------------------

	async state(browserId: string): Promise<BrowserState> {
		return await this.serialize(this.require(browserId), async (entry) => this.redact(entry, await this.buildState(entry)));
	}

	/** The live picture, for the View's direct channel (stream.ts): the driver's own cast, never queued behind page work. */
	watchFrames(browserId: string, onFrame: (frame: LiveFrame) => void): () => void {
		return this.require(browserId).driver.watchFrames(onFrame);
	}

	/** `state`, but NOT queued behind page work: the live view keeps reading it while a navigation or action is in flight. */
	async liveState(browserId: string): Promise<BrowserState> {
		const entry = this.require(browserId);
		return this.redact(entry, await this.buildState(entry));
	}

	/**
	 * The human's own mouse, wheel and keys on the active tab (the View's direct channel). Like the live picture it is NOT queued behind
	 * page work, so a click never waits for a navigation, but batches apply one after another. The rules `act` has for the View hold:
	 * a task owns its page, a click or key on the page a publish waits on marks the publish touched, and while the bar's Post is being
	 * submitted the page takes no input at all (an `act` waited behind it in the page queue; this door has to refuse).
	 */
	async input(browserId: string, events: unknown): Promise<void> {
		const entry = this.require(browserId);
		const admitted = admitInput(events, entry.viewport);
		const run = async (): Promise<void> => {
			if (entry.closed) fail("unknown_browser", "unknown or already closed browserId");
			refuseWhileBusy(entry, "app");
			refuseWhileSubmitting(entry);
			const pinned = isPending(entry.publish) && admitted.some(touchesPage) ? entry.publish : null;
			// Another tab is not the page being confirmed; an unreadable state counts as the pinned one.
			const touching = pinned !== null && ((await entry.driver.state().catch(() => null))?.activeTabId ?? pinned.record.tabId) === pinned.record.tabId ? pinned : null;
			// The state read let the Post start: this check and the mark below must run with nothing awaited between them.
			refuseWhileSubmitting(entry);
			// Marked BEFORE the press is sent: a Post that starts while it is in flight must already see it and never click submit.
			const touchedBefore = touching?.touchedWhilePending ?? false;
			if (touching) touching.touchedWhilePending = true;
			try {
				await entry.driver.input(admitted);
			} catch (error) {
				if (error instanceof ActionNotDispatched) {
					// Provably nothing reached the page, so the publish was not touched by this batch.
					if (touching) touching.touchedWhilePending = touchedBefore;
				} else {
					entry.revision += 1;
				}
				throw error;
			}
		};
		const next = entry.inputQueue.then(run, run);
		entry.inputQueue = next.catch(() => undefined);
		return next;
	}

	/** A fresh PNG capture, retained so it can be annotated. */
	async frame(browserId: string): Promise<BrowserFrame> {
		return await this.serialize(this.require(browserId), async (entry) => {
			const before = await this.refreshState(entry);
			const revision = entry.revision;
			const url = before.url;
			const { shot, scroll } = await this.captureSettled(entry);
			const capturedAt = new Date().toISOString();
			const state = await this.buildState(entry);
			if (entry.revision !== revision || state.url !== url) {
				fail("stale_frame", "The page navigated during capture; request a new frame.");
			}
			const bytes = Buffer.from(shot.buffer, shot.byteOffset, shot.byteLength);
			if (bytes.length > MAX_FRAME_BYTES) {
				fail("frame_too_large", `screenshot is ${bytes.length} bytes, above the ${MAX_FRAME_BYTES} byte limit`);
			}
			const record: FrameRecord = {
				id: randomBytes(12).toString("hex"),
				url,
				title: state.title,
				revision,
				viewport: entry.viewport,
				scroll,
				capturedAt,
			};
			entry.frames.push(record);
			while (entry.frames.length > MAX_FRAMES_RETAINED) entry.frames.shift();
			return {
				state: this.redact(entry, state),
				frameId: record.id,
				mimeType: "image/png" as const,
				data: bytes.toString("base64"),
				capturedAt: record.capturedAt,
			};
		});
	}

	/**
	 * The picture of the page and where it is scrolled, as one thing. A wheel scroll animates for a moment, and a picture
	 * taken in the middle of it shows no position the page was ever at; the position is read on both sides of the capture
	 * and the capture is taken again, a few times, until they agree.
	 */
	private async captureSettled(entry: Entry): Promise<{ shot: Uint8Array; scroll: PageScroll }> {
		for (let attempt = 1; ; attempt += 1) {
			const from = await entry.driver.scroll();
			const shot = await entry.driver.screenshot();
			const scroll = await entry.driver.scroll();
			if (scroll.x === from.x && scroll.y === from.y) return { shot, scroll };
			if (attempt === SCROLL_SETTLE_ATTEMPTS) fail("stale_frame", "The page kept scrolling while the picture was taken; request a new frame.");
			const { promise: rested, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, SCROLL_SETTLE_MS);
			await rested;
		}
	}

	/** A read like `snapshot`; the picture is for a model, so nothing of it is kept (`entry.frames` holds annotatable frames only). */
	async shot(browserId: string, request: ShotRequest = {}): Promise<ModelShot> {
		const scale = request.scale;
		if (scale !== undefined && !(Number.isFinite(scale) && scale > 0 && scale <= 1)) fail("bad_shot", "scale must be above 0 and at most 1");
		if (request.fullPage && request.selector !== undefined) fail("bad_shot", "pass fullPage or selector, not both");
		const selector = request.selector === undefined ? undefined : requireReadSelector(request.selector);
		return await this.serialize(this.require(browserId), async (entry) => {
			const state = await this.refreshState(entry);
			const picture = await entry.driver.shotForModel({
				...(request.fullPage ? { fullPage: true } : {}),
				...(selector === undefined ? {} : { selector }),
				...(scale === undefined ? {} : { scale }),
			});
			return { ...picture, url: this.redact(entry, state.url) };
		});
	}

	async logs(browserId: string): Promise<LogEntry[]> {
		const entry = this.require(browserId);
		const fresh = entry.driver.logs().filter((log) => log.n > entry.logRead);
		entry.logRead = Math.max(entry.logRead, fresh.at(-1)?.n ?? 0);
		return this.redact(entry, fresh);
	}

	/** How many log entries are newer than anything a model was told or shown; they count as told from now on. */
	private noticeLogs(entry: Entry): number {
		const told = Math.max(entry.logRead, entry.logNoticed);
		const entries = entry.driver.logs();
		entry.logNoticed = Math.max(told, entries.at(-1)?.n ?? 0);
		return entries.filter((log) => log.n > told).length;
	}

	async snapshot(browserId: string): Promise<{ state: BrowserState; text: string }> {
		return await this.serialize(this.require(browserId), async (entry) => {
			// A page that swaps its document under the read gets one more try; a second swap is reported.
			for (let attempt = 1; ; attempt += 1) {
				await this.refreshState(entry);
				const revision = entry.revision;
				const text = await entry.driver.snapshot(MAX_SNAPSHOT_CHARS);
				const state = await this.buildState(entry);
				if (entry.revision === revision) return this.redact(entry, { state, text });
				if (attempt === 2) fail("stale_snapshot", "The document changed during inspection.");
			}
		});
	}

	/**
	 * The page under the regions the human marked on the retained frame `frameId`: its address and title as captured,
	 * where it is scrolled, and the elements under each region. The picture is the View's own frame; the shared
	 * annotation kit paints the marks onto it and cuts the detail crops, so nothing here carries pixels.
	 *
	 * Honesty note baked into the answer: the frame is what was captured at `capturedAt`, the elements are read from the
	 * page as it is NOW (`readAt`). On a dynamic page those can disagree even at the same revision; we never claim
	 * they are the same instant.
	 */
	async annotate(browserId: string, frameId: string, regions: readonly BrowserRegion[]): Promise<BrowserAnnotationContext> {
		const entry = this.require(browserId);
		if (!Array.isArray(regions) || regions.length === 0 || regions.length > MAX_ANNOTATION_REGIONS) {
			fail("bad_region", `annotate needs between 1 and ${MAX_ANNOTATION_REGIONS} regions`);
		}
		return await this.serialize(entry, async () => {
			await this.refreshState(entry);
			const record = entry.frames.find((f) => f.id === frameId);
			if (!record) {
				fail("unknown_frame", `frame ${frameId} is not retained (only the last ${MAX_FRAMES_RETAINED} frames are)`);
			}
			if (record.revision !== entry.revision) {
				fail(
					"stale_frame",
					`frame ${frameId} was captured at revision ${record.revision}; the page is now at revision ${entry.revision}. Capture a new frame.`,
				);
			}
			const clamped = regions.map((region) => clampRegion(region, record.viewport));
			const read = await entry.driver.elements(clamped, MAX_ELEMENT_CHARS);
			await this.refreshState(entry);
			if (record.revision !== entry.revision) fail("stale_frame", "The document changed while reading annotation context.");
			// A scroll is not a new document, so it never moved the revision. Elements are read where the page is NOW; the
			// picture shows where it was.
			if (read.scroll.x !== record.scroll.x || read.scroll.y !== record.scroll.y) {
				fail(
					"stale_frame",
					`The page is scrolled to ${read.scroll.x},${read.scroll.y} now and was at ${record.scroll.x},${record.scroll.y} when the picture was taken. Capture a new frame.`,
				);
			}
			return this.redact(entry, {
				url: record.url,
				title: record.title,
				capturedAt: record.capturedAt,
				readAt: new Date().toISOString(),
				viewport: record.viewport,
				scroll: record.scroll,
				regions: clamped.map((region, index) => ({
					region,
					elements: read.regions[index]?.elements ?? [],
					truncated: read.regions[index]?.truncated ?? false,
				})),
			});
		});
	}

	/** Keeps the kit's detail document for the browser the human marked in: a throwaway browser's goes with it. */
	saveAnnotationDetail(browserId: string, json: string): string {
		return this.require(browserId).annotations.save(json);
	}

	async profileList(asker?: string): Promise<ProfileListing[]> {
		return buildProfileList(
			this.store,
			(slug) => {
				const opener = this.byProfile.get(slug)?.opener ?? this.openers.get(slug);
				if (opener !== undefined) return this.holderOf(opener, asker);
				// Open in another server (or another runtime on this root): not ours to name, and not free.
				return this.store.heldElsewhere(slug) ? "another chat" : null;
			},
			Date.now(),
		);
	}

	async profileMeta(): Promise<Record<string, ResolvedProfileMeta>> {
		const meta: Record<string, ResolvedProfileMeta> = {};
		for (const slug of this.store.list()) if (slug !== RELAY_PROFILE) meta[slug] = resolveProfileMeta(slug, this.store.meta(slug));
		return meta;
	}

	async connections(): Promise<ConnectionObservations> {
		return this.store.allConnections();
	}

	onConnectionsChanged(listener: () => void): () => void {
		this.connectionListeners.add(listener);
		if (this.profileWatcher === undefined && !this.disposed) {
			for (const profile of Object.keys(this.store.allConnections())) this.observedProfiles.add(profile);
			try {
				// A deleted profile directory takes its observations with it; say so.
				this.profileWatcher = watch(this.store.profilesRoot, { persistent: false }, () => {
					const gone = [...this.observedProfiles].filter((profile) => !existsSync(this.store.profileDir(profile)));
					if (gone.length === 0) return;
					for (const profile of gone) this.observedProfiles.delete(profile);
					this.connectionsChanged();
				});
				this.profileWatcher.on("error", () => {
					this.profileWatcher?.close();
					this.profileWatcher = undefined;
				});
			} catch (error) {
				console.error("Browser profile watch failed; a deleted profile is reported at the next observation:", describe(error));
			}
		}
		return () => {
			this.connectionListeners.delete(listener);
			if (this.connectionListeners.size > 0) return;
			this.profileWatcher?.close();
			this.profileWatcher = undefined;
		};
	}

	/**
	 * Persist what a probe or a publish just saw about `origin`'s sign-in on this
	 * profile (`signedIn: null`: only visited) and tell the listeners. Never
	 * throws: a report is never worth failing what observed it.
	 */
	private observeConnection(profile: string, origin: string, signedIn: boolean | null, account: string | undefined): void {
		const host = siteHost(origin);
		if (profile === RELAY_PROFILE || host === null) return;
		try {
			this.store.recordConnection(profile, host, { signedIn, observedAt: Date.now(), ...(signedIn === true && account !== undefined ? { account } : {}) });
		} catch (error) {
			console.error("Browser sign-in observation was not saved:", describe(error));
			return;
		}
		this.observedProfiles.add(profile);
		this.connectionsChanged();
	}

	private connectionsChanged(): void {
		for (const listener of this.connectionListeners) {
			try {
				listener();
			} catch (error) {
				console.error("Browser connection listener failed:", describe(error));
			}
		}
	}

	// -----------------------------------------------------------------------
	// Whose a profile is, and which one a name means
	// -----------------------------------------------------------------------

	/** `opener`'s browser, from the side of `asker` (a host session id): the same chat, the human in a View, or another chat. */
	private holderOf(opener: BrowserOpener, asker: string | undefined): Exclude<ProfileHolder, null> {
		if (asker !== undefined && opener.session === asker) return "this chat";
		return opener.caller === "app" ? "human" : "another chat";
	}

	/** The profile `raw` means: a saved one by its slug or label, else a new one by its slug. */
	private resolveProfile(raw: unknown, engine: BrowserEngine): string {
		// The relay has one profile, reserved: nothing to look up.
		if (engine === "chrome-relay" || typeof raw !== "string") return validateProfile(raw);
		const known = this.store.list().filter((slug) => slug !== RELAY_PROFILE).map((slug) => ({ slug, label: resolveProfileMeta(slug, this.store.meta(slug)).label }));
		const matches = matchProfiles(raw, known);
		if (matches.length === 1) return matches[0].slug;
		if (matches.length > 1) fail("profile_ambiguous", `more than one saved profile answers to ${JSON.stringify(raw)}: ${nameProfiles(matches)}. Ask the human which one; do not guess.`);
		// No match: a new profile when it is a valid slug (the first sign-in on an account), else nothing to open.
		const slug = profileSlug(raw);
		if (slug !== null) return slug;
		fail("profile_unknown", `no saved profile is named ${JSON.stringify(raw)}. Saved profiles: ${known.length === 0 ? "none" : nameProfiles(known)}. Ask the human which one, or leave profile out for a throwaway browser.`);
	}

	/**
	 * Record that a saved profile is being opened (its last use, and the browser
	 * application that runs it). Returns what a person should be told when that
	 * application is not the one that made the logins: a different browser build
	 * cannot read the first one's encrypted cookies, so they may be signed out.
	 * Never throws: metadata is never worth failing an open.
	 */
	private touchProfile(profile: string, app: BrowserApp | null): string | undefined {
		try {
			const before = this.store.meta(profile).app;
			this.store.saveMeta(profile, { lastUsed: Date.now(), ...(app === null ? {} : { app }) });
			if (app === null || before === undefined || before === app) return undefined;
			const notice = `This profile was last opened in ${APP_NAMES[before] ?? before}; this browser is ${APP_NAMES[app] ?? app}. A different browser often cannot read the logins the first one saved, so you may be signed out.`;
			console.error(`[browser] profile "${profile}": ${notice}`);
			return notice;
		} catch (error) {
			console.error("Browser profile metadata was not saved:", describe(error));
			return undefined;
		}
	}

	private markUsed(entry: Entry): void {
		if (entry.profile === null || entry.profile === RELAY_PROFILE) return;
		try {
			this.store.saveMeta(entry.profile, { lastUsed: Date.now() });
		} catch (error) {
			console.error("Browser profile metadata was not saved:", describe(error));
		}
	}

	// -----------------------------------------------------------------------
	// The passive sign-in look
	// -----------------------------------------------------------------------

	/** A page just loaded (or changed route) in the active tab: look at it shortly, once however many events come. */
	private schedulePageProbe(entry: Entry, settleMs: number): void {
		if (this.disposed || entry.closed) return;
		clearTimeout(entry.probe.timer);
		const timer = setTimeout(() => void this.probeLoaded(entry, settleMs), PROBE_DEBOUNCE_MS);
		timer.unref();
		entry.probe.timer = timer;
	}

	/** One look at a time per browser; a load that arrives during one earns one more look after it. */
	private async probeLoaded(entry: Entry, settleMs: number): Promise<void> {
		const { probe } = entry;
		if (probe.running !== undefined) {
			probe.again = true;
			return;
		}
		probe.running = (async () => {
			try {
				do {
					probe.again = false;
					await this.probeOnce(entry, settleMs, false);
				} while (probe.again && !entry.closed && !this.disposed);
			} finally {
				probe.running = undefined;
			}
		})();
		await probe.running;
	}

	/**
	 * The last look, as the browser closes: no waiting for a page to draw (it has been open), and never longer
	 * than PROBE_CLOSE_MS in all, so closing is never held up by a page that will not answer.
	 */
	private async probeAtClose(entry: Entry): Promise<void> {
		if (entry.profile === null || entry.profile === RELAY_PROFILE) return;
		clearTimeout(entry.probe.timer);
		let timer: NodeJS.Timeout | undefined;
		const giveUp = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, PROBE_CLOSE_MS);
		});
		try {
			await Promise.race([(async () => { await entry.probe.running; await this.probeOnce(entry, 0, true); })(), giveUp]);
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Look at the active tab once and note what it shows, if anything: a known site gives a verdict (signed in with
	 * its account, or signed out where that decides), any other public site is only "visited". Nothing here throws:
	 * a page that changed under a read, or a browser going away, is simply not observed this time.
	 */
	private async probeOnce(entry: Entry, settleMs: number, closing: boolean): Promise<void> {
		const profile = entry.profile;
		if (profile === null || profile === RELAY_PROFILE) return;
		let looked: string | undefined;
		try {
			const before = await entry.driver.state();
			if ((entry.closed && !closing) || before.loading) return;
			looked = before.url;
			const host = siteHost(before.url);
			if (host === null) return;
			const probe = probeFor(host, this.options.probes?.table);
			if (probe === undefined) {
				this.noteVisit(profile, before.url, host);
				return;
			}
			const verdict = await readProbe(entry.driver, probe, before.url, settleMs);
			if (verdict === undefined) return;
			// The verdict belongs to the page it was read on: if the person moved on while it was read, it is dropped.
			const after = await entry.driver.state();
			if (after.url !== before.url || after.activeTabId !== before.activeTabId) return;
			this.noteVerdict(entry, profile, before.url, host, verdict);
		} catch {
			// Not observed this time; the next page that loads is looked at again.
		} finally {
			if (looked !== undefined) this.options.probes?.looked?.(looked);
		}
	}

	private noteVerdict(entry: Entry, profile: string, url: string, host: string, verdict: ProbeVerdict): void {
		// A page can show anything, a saved password included: the account is scrubbed like every other page read before it is kept.
		const account = verdict.signedIn ? this.redact(entry, verdict.account) : undefined;
		if (this.alreadyNoted(profile, host, `${verdict.signedIn}|${account ?? ""}`, CHECK_RENOTE_MS)) return;
		this.observeConnection(profile, url, verdict.signedIn, account);
	}

	/** A site only visited is never allowed to replace a check that was made, and a loopback or private host is not a site. */
	private noteVisit(profile: string, url: string, host: string): void {
		if (!(this.options.probes?.recordVisit ?? isPublicSite)(url)) return;
		if (this.alreadyNoted(profile, host, "visited", VISIT_RENOTE_MS)) return;
		const current = this.store.connections(profile)[host];
		if (current !== undefined && current.signedIn !== null) return;
		this.observeConnection(profile, url, null, undefined);
	}

	/** True when the same fact about this site was noted less than `windowMs` ago; otherwise remembers it as noted now. */
	private alreadyNoted(profile: string, host: string, key: string, windowMs: number): boolean {
		const id = `${profile}\n${host}`;
		const now = Date.now();
		const last = this.lastNoted.get(id);
		if (last !== undefined && last.key === key && now - last.at < windowMs) return true;
		// One entry per site ever visited would grow without bound in a long session.
		if (this.lastNoted.size >= MAX_NOTED) this.lastNoted.clear();
		this.lastNoted.set(id, { key, at: now });
		return false;
	}

	// -----------------------------------------------------------------------
	// Tabs
	// -----------------------------------------------------------------------

	/** Fit the page to the View's size and pixel ratio (bounded like open's viewport; ratio 1-2). */
	async resize(browserId: string, viewport: Viewport, scale = 1): Promise<BrowserState> {
		const entry = this.require(browserId);
		const size = normalizeViewport(viewport);
		const ratio = Number.isFinite(scale) ? Math.min(2, Math.max(1, Math.round(scale * 4) / 4)) : 1;
		return await this.serialize(entry, async () => {
			await entry.driver.resize(size, ratio);
			return this.redact(entry, await this.buildState(entry));
		});
	}

	/**
	 * Open, show or close a tab. Every read and action works on the active tab.
	 * Refused while a task runs: switching away from the agent's tab hides it,
	 * and a hidden tab renders no frames, so the agent would stall.
	 */
	async tab(browserId: string, request: TabRequest, caller?: ToolCaller): Promise<BrowserState> {
		const entry = this.require(browserId);
		const planned = admitTab(request);
		return await this.serialize(entry, async () => {
			refuseWhileBusy(entry, caller);
			await this.applyTab(entry, planned);
			return this.redact(entry, await this.buildState(entry));
		});
	}

	/** One admitted tab operation, under the caller's lock. */
	private async applyTab(entry: Entry, tab: PlannedTab): Promise<void> {
		switch (tab.op) {
			case "new":
				try {
					await entry.driver.openTab(tab.url);
				} catch (error) {
					fail("tab_failed", `opening a new tab${tab.url ? ` at ${tab.url}` : ""} failed: ${describe(error)}`);
				}
				break;
			case "activate":
				await entry.driver.activateTab(tab.tabId as string);
				break;
			case "close":
				await entry.driver.closeTab(tab.tabId as string);
				break;
		}
	}

	// -----------------------------------------------------------------------
	// Actions
	// -----------------------------------------------------------------------

	async act(browserId: string, input: BrowserAction, caller?: ToolCaller): Promise<ActionResult> {
		const entry = this.require(browserId);
		return await this.serialize(entry, async () => {
			refuseWhileBusy(entry, caller);
			const done = await this.dispatch(entry, this.admit(entry, input, caller), caller);
			if (done.status !== "completed") {
				return this.redact(entry, { status: done.status, error: done.error, state: await this.buildState(entry).catch(() => this.staleState(entry)) });
			}
			return this.redact(entry, {
				status: "completed" as const,
				state: await this.buildState(entry),
				...(done.credential ? { credential: done.credential } : {}),
				...(done.dialogs ? { dialogs: done.dialogs } : {}),
			});
		});
	}

	/**
	 * A batch of steps under the one per-browser lock (a loop of `act` would take it once per step and let another
	 * caller's action land between two of them). Refused once; every step is checked before the first reaches the
	 * page; steps run in order until one is not `completed` or the time budget is spent (a host times a call out, and a
	 * caller that never heard back would send the same submit again). The state is read once, at the end.
	 */
	async actMany(browserId: string, steps: readonly BatchStep[], caller?: ToolCaller): Promise<ActManyResult> {
		const entry = this.require(browserId);
		if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_BATCH_STEPS) fail("bad_action", `actions must be 1-${MAX_BATCH_STEPS} steps`);
		return await this.serialize(entry, async () => {
			refuseWhileBusy(entry, caller);
			const plan = steps.map((step) => this.admitStep(entry, step, caller));
			const budget = this.options.actBudgetMs ?? ACT_BUDGET_MS;
			const deadline = Date.now() + budget;
			const outcomes: StepOutcome[] = [];
			const dialogs: HandledDialog[] = [];
			// What the batch's eval steps may still return between them.
			let valueChars = MAX_EVAL_RESULT_CHARS;
			let stopped: StepDone | undefined;
			for (const [index, step] of plan.entries()) {
				if (index > 0 && Date.now() >= deadline) {
					stopped = { status: "timeout", error: `the batch's time budget (${budget} ms) ran out after ${index} of ${plan.length} steps; send the remaining steps in a new call` };
					break;
				}
				const done = await this.runStep(entry, step, caller, valueChars);
				valueChars -= done.value?.length ?? 0;
				outcomes.push({
					kind: step.kind,
					status: done.status,
					...(done.error === undefined ? {} : { error: done.error }),
					...(done.credential ? { credential: done.credential } : {}),
					...(done.value === undefined ? {} : { value: done.value }),
					...(done.truncated ? { truncated: true as const } : {}),
				});
				if (done.dialogs) dialogs.push(...done.dialogs);
				if (done.status !== "completed") {
					stopped = done;
					break;
				}
			}
			const state = stopped ? await this.buildState(entry).catch(() => this.staleState(entry)) : await this.buildState(entry);
			const completed = outcomes.filter((outcome) => outcome.status === "completed").length;
			const newErrors = caller === "app" ? 0 : this.noticeLogs(entry);
			return this.redact(entry, {
				status: stopped?.status ?? "completed",
				...(stopped?.error === undefined ? {} : { error: stopped.error }),
				completed,
				steps: outcomes,
				state,
				...(dialogs.length === 0 ? {} : { dialogs: dialogs.slice(-MAX_BATCH_DIALOGS) }),
				...(newErrors === 0 ? {} : { newErrors }),
			});
		});
	}

	private runStep(entry: Entry, step: PlannedStep, caller: ToolCaller | undefined, valueChars: number): Promise<StepDone> {
		switch (step.kind) {
			case "wait":
				return this.waitStep(entry, step);
			case "tab":
				return this.tabStep(entry, step);
			case "eval":
				return this.evalStep(entry, step, valueChars);
			default:
				return this.dispatch(entry, step, caller);
		}
	}

	/**
	 * What about one action needs no page: its shape, and who may use a saved password where. Throws before
	 * anything of a batch is dispatched, so an action that cannot run never leaves its predecessors half done.
	 */
	private admit(entry: Entry, input: BrowserAction, caller: ToolCaller | undefined): BrowserAction {
		const action = normalizeAction(input);
		if (action.useSavedPassword || action.generatePassword) {
			// Opt-in only, and never for the View: the human's keystrokes and
			// pastes arrive as insert and must type exactly what they typed.
			if (caller === "app") fail("bad_action", "useSavedPassword and generatePassword are for the agent; the Browser View types exactly what the human typed");
			this.savedProfile(entry, "typing a saved password");
		}
		return action;
	}

	private admitStep(entry: Entry, step: BatchStep, caller: ToolCaller | undefined): PlannedStep {
		if (!step || typeof step !== "object") fail("bad_action", "each step must be an object");
		switch (step.kind) {
			case "wait":
				return { kind: "wait", ...validateWait(step) };
			case "tab":
				return admitTab(step);
			case "eval":
				return this.admitEval(entry, step);
			default:
				return this.admit(entry, step, caller);
		}
	}

	/** Model-written JavaScript runs only where nothing of the person's is in reach. */
	private admitEval(entry: Entry, step: EvalStep): PlannedEval {
		if (typeof step.expression !== "string" || step.expression.length === 0 || step.expression.length > MAX_EVAL_EXPRESSION_CHARS) {
			fail("bad_action", `eval.expression must be a string of 1-${MAX_EVAL_EXPRESSION_CHARS} characters`);
		}
		if (entry.profile !== null || entry.engine !== "chromium") {
			fail("eval_needs_throwaway", "eval runs your JavaScript in the page, so it only runs in a throwaway browser (no profile, engine chromium); this one holds a saved profile or is the user's own Chrome. Open a throwaway browser with browser_open and eval there.");
		}
		return { kind: "eval", expression: step.expression };
	}

	/** One admitted action, dispatched once on the active tab. A failure is a status, never a throw: earlier steps of a batch stay accounted for. */
	private async dispatch(entry: Entry, action: BrowserAction, caller: ToolCaller | undefined): Promise<Dispatched> {
		// The human driving the pinned page while waiting may hit the site's own submit.
		const pinned = caller === "app" && TOUCHING_KINDS[action.kind] && isPending(entry.publish) ? entry.publish : null;
		// Another tab is not the page being confirmed; an unreadable state counts as the pinned one.
		const touching = pinned !== null && ((await entry.driver.state().catch(() => null))?.activeTabId ?? pinned.record.tabId) === pinned.record.tabId ? pinned : null;
		let created = false;
		let password: PasswordSource | undefined;
		if (action.generatePassword || action.useSavedPassword) {
			const profileDir = this.store.profileDir(this.savedProfile(entry, "typing a saved password"));
			password = action.generatePassword
				? (origin: string) => {
					// The signup rule the task credential uses: the saved one, else mint and save.
					const credential = resolveCredential(profileDir, { origin, mode: "signup" });
					created = credential.created;
					entry.secrets.add(credential.password);
					return credential.password;
				}
				: (origin: string) => {
					const value = savedPassword(profileDir, origin);
					if (value) entry.secrets.add(value);
					return value;
				};
		}
		let outcome: PerformOutcome;
		try {
			outcome = await entry.driver.perform(action, password);
			if (touching) touching.touchedWhilePending = true;
		} catch (error) {
			const dispatched = !(error instanceof ActionNotDispatched);
			if (dispatched && touching) touching.touchedWhilePending = true;
			if (dispatched) entry.revision += 1;
			return {
				status: dispatched ? "unknown" : "failed",
				error: dispatched
					? `The action was sent to the page, then failed; it may or may not have taken effect. Check the page before retrying. (${describe(error)})`
					: describe(error),
			};
		}
		return {
			status: "completed",
			...(outcome.passwordOrigin ? { credential: { origin: outcome.passwordOrigin, created } } : {}),
			...(outcome.dialogs ? { dialogs: outcome.dialogs } : {}),
		};
	}

	/** One admitted wait, run like `wait()`: the masked condition, and a timeout is a status. */
	private async waitStep(entry: Entry, step: PlannedWait): Promise<StepDone> {
		const held = await entry.driver.waitFor(step.condition, step.timeoutMs, (value) => this.redact(entry, value));
		return held ? { status: "completed" } : { status: "timeout", error: `wait timed out after ${step.timeoutMs} ms` };
	}

	/** One admitted tab operation: a failure is a status, as for an action. */
	private async tabStep(entry: Entry, step: PlannedTab): Promise<StepDone> {
		try {
			await this.applyTab(entry, step);
		} catch (error) {
			return { status: error instanceof ActionNotDispatched ? "failed" : "unknown", error: describe(error) };
		}
		return { status: "completed" };
	}

	/** One admitted eval: its value as JSON text (at most `limit` characters), or what it threw. */
	private async evalStep(entry: Entry, step: PlannedEval, limit: number): Promise<StepDone> {
		let outcome: EvalOutcome;
		try {
			outcome = await entry.driver.evaluate(step.expression, limit);
		} catch (error) {
			entry.revision += 1;
			return { status: "unknown", error: `The script was sent to the page, then failed; it may or may not have taken effect. (${describe(error)})` };
		}
		if (!outcome.ok) return { status: outcome.ran ? "unknown" : "failed", error: outcome.error };
		return { status: "completed", ...(outcome.value === undefined ? {} : { value: outcome.value }), ...(outcome.truncated ? { truncated: true } : {}) };
	}

	/**
	 * Wait until the page shows what the caller is waiting for, or `timeoutMs`
	 * passes. Queued and refused exactly like `act`, so a wait never runs beside
	 * a task or a pending publish. A timeout is a result, not an error: the state
	 * is what the browser shows now.
	 */
	async wait(browserId: string, request: WaitRequest, caller?: ToolCaller): Promise<WaitResult> {
		const entry = this.require(browserId);
		const { condition, timeoutMs } = validateWait(request);
		return await this.serialize(entry, async () => {
			refuseWhileBusy(entry, caller);
			const held = await entry.driver.waitFor(condition, timeoutMs, (value) => this.redact(entry, value));
			return this.redact(entry, { status: held ? ("completed" as const) : ("timeout" as const), state: await this.buildState(entry) });
		});
	}

	/** A read like `snapshot`: the page is not touched, and no task or publish stops it. */
	async inspect(browserId: string, selector: string): Promise<InspectResult> {
		const entry = this.require(browserId);
		const css = requireReadSelector(selector);
		return await this.serialize(entry, async () => this.redact(entry, (await entry.driver.inspect(css)) ?? { found: false as const }));
	}

	// -----------------------------------------------------------------------
	// Tasks — upstream agent loops on this browser
	// -----------------------------------------------------------------------

	/**
	 * Run a whole task on an upstream agent loop. The agent attaches to this
	 * browser's Chrome; tabs it opens become the active tab, so frames show the
	 * agent working. Resolves with the finished run.
	 */
	async runTask(browserId: string, request: TaskRequest, onStep?: (step: TaskStep, run: TaskRun) => void): Promise<TaskRun> {
		const entry = this.require(browserId);
		return this.redact(entry, cloneTask(await (await this.beginTask(browserId, request, onStep)).finished));
	}

	/** Start a task and return as soon as it runs; follow it with `waitTask`. */
	async startTask(browserId: string, request: TaskRequest, caller?: ToolCaller): Promise<TaskRun> {
		const entry = this.require(browserId);
		const { run } = await this.beginTask(browserId, request, undefined, caller);
		return this.redact(entry, cloneTask(run));
	}

	private async beginTask(
		browserId: string,
		request: TaskRequest,
		onStep?: (step: TaskStep, run: TaskRun) => void,
		caller?: ToolCaller,
	): Promise<{ run: TaskRun; finished: Promise<TaskRun> }> {
		const entry = this.require(browserId);
		if (!TASK_AGENTS.includes(request.agent)) fail("bad_agent", `agent must be one of: ${TASK_AGENTS.join(", ")}`);
		// The task agents take a browser-level CDP endpoint and act on the whole
		// browser (browser-use focuses the oldest tab). On the relay that is the
		// human's own Chrome, which this pack owns only one tab of.
		if (entry.engine === "chrome-relay") {
			fail("task_unsupported_engine", "task agents drive a whole browser, and chrome-relay is your own Chrome — open a chromium profile for browser_task");
		}
		const task = typeof request.task === "string" ? request.task.trim() : "";
		if (task.length === 0 || task.length > MAX_TASK_CHARS) fail("bad_task", `task must be 1-${MAX_TASK_CHARS} characters`);
		const maxSteps = Math.min(MAX_TASK_STEPS, Math.max(1, Math.floor(request.maxSteps ?? DEFAULT_TASK_STEPS)));
		if (request.credential !== undefined) {
			// browser-use reads password fields like any other and would put a
			// filled value in front of its model; only jev never reads them.
			if (request.agent !== "jev") fail("credential_unsupported", "credential is supported with agent jev only; browser-use reads password fields, so give it the password in task or log in with browser_act");
			credentialOrigin(request.credential?.origin);
		}

		return await this.serialize(entry, async () => {
			if (entry.worker) fail("task_running", `a ${entry.task?.agent} task is already running on this browser`);
			refuseWhilePublishing(entry, caller);
			const state = await this.refreshState(entry);
			// Resolved (and, for a sign-up, minted) only once the task will run.
			const credential = request.credential ? resolveCredential(this.store.profileDir(this.savedProfile(entry, "a task credential")), request.credential) : undefined;
			if (credential) entry.secrets.add(credential.password);
			const run: TaskRun = {
				id: randomBytes(8).toString("hex"), agent: request.agent, task, status: "running", summary: "",
				steps: [], stepCount: 0, startedAt: new Date().toISOString(), elapsedMs: 0,
				usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: null },
				...(credential ? { credential: { origin: credential.origin, created: credential.created } } : {}),
			};
			const worker: RunningWorker = startWorker(
				{ agent: request.agent, cdpUrl: entry.driver.cdpEndpoint(), task, maxSteps, startUrl: state.url, ...(credential ? { credential: { origin: credential.origin, password: credential.password } } : {}) },
				(step) => {
					const record: TaskStep = { n: step.n, action: step.action, url: step.url, elapsedMs: step.elapsedMs };
					run.steps.push(record);
					if (run.steps.length > TASK_STEPS_RETAINED) run.steps.shift();
					run.stepCount = Math.max(run.stepCount, step.n);
					run.elapsedMs = step.elapsedMs;
					run.usage = step.usage;
					if (onStep) onStep(this.redact(entry, record), this.redact(entry, cloneTask(run)));
				},
			);
			const finished = worker.done.then((result) => {
				Object.assign(run, {
					status: result.status,
					summary: result.summary,
					stepCount: Math.max(run.stepCount, result.steps),
					elapsedMs: result.elapsedMs || Date.now() - Date.parse(run.startedAt),
					usage: result.usage.modelCalls > 0 || result.usage.inputTokens > 0 ? result.usage : run.usage,
				});
				// The agent navigated this Chrome: whatever frame was retained is stale.
				entry.revision += 1;
				entry.worker = null;
				entry.lastUsed = performance.now();
				return run;
			});
			entry.task = run;
			entry.worker = { process: worker, finished };
			// Returned wrapped so the serializer is released now: the task runs
			// outside the page queue, and frames keep flowing while it works.
			return { run, finished };
		});
	}

	/**
	 * The current task, once it has finished or `ms` has passed — whichever is
	 * first. Lets a caller follow a long task in bounded calls instead of one
	 * call a host may time out.
	 */
	async waitTask(browserId: string, ms: number): Promise<TaskRun> {
		const entry = this.require(browserId);
		if (!entry.task) fail("no_task", "no task has run on this browser");
		const worker = entry.worker;
		if (worker) {
			const { promise: elapsed, resolve } = Promise.withResolvers<void>();
			const timer = setTimeout(resolve, Math.max(0, ms));
			await Promise.race([worker.finished, elapsed]);
			clearTimeout(timer);
		}
		return this.redact(entry, cloneTask(entry.task));
	}

	async cancelTask(browserId: string): Promise<TaskRun> {
		const entry = this.require(browserId);
		const worker = entry.worker;
		if (!worker) {
			if (!entry.task) fail("no_task", "no task has run on this browser");
			return this.redact(entry, cloneTask(entry.task));
		}
		worker.process.cancel();
		return this.redact(entry, cloneTask(await worker.finished));
	}

	/** Stop a running task and wait for its worker to exit. */
	private async stopTask(entry: Entry): Promise<void> {
		const worker = entry.worker;
		if (!worker) return;
		worker.process.cancel();
		await worker.finished;
	}

	// -----------------------------------------------------------------------
	// Publishing — fill, park for a confirm, submit once (publish.ts)
	// -----------------------------------------------------------------------

	async publish(browserId: string, recipe: PublishRecipe, mode: PublishMode, caller?: ToolCaller, preset?: PresetRef): Promise<PublishCheck | PublishRecord> {
		const entry = this.require(browserId);
		const profile = this.savedProfile(entry, "publishing");
		const valid = validateRecipe(recipe);
		const selected = validateMode(mode);
		return await this.serialize(entry, async () => {
			refuseWhileBusy(entry, caller);
			// Even from the View: a check or a second post would navigate away from the page awaiting confirmation.
			if (isPending(entry.publish)) {
				fail("publish_pending", "a publish is already awaiting confirmation; it must be posted, cancelled or expire first");
			}
			const outcome = await prepare(entry.driver, profile, valid, selected);
			if (!("record" in outcome)) {
				// The account is page text: scrubbed like every other page read before it is persisted or reported.
				const shown = this.redact(entry, outcome);
				if (shown.status !== "failed") this.observeConnection(profile, valid.origin, shown.status === "signed-in", shown.account);
				return shown;
			}
			// The relay is the human's own Chrome: they can use this page without the runtime seeing it.
			outcome.sharedPage = entry.engine === "chrome-relay";
			if (preset !== undefined) outcome.record.preset = { name: preset.name, verified: preset.verified };
			entry.publish = outcome;
			return this.redact(entry, publishRecord(outcome));
		});
	}

	async confirmPublish(browserId: string, publishId: string, caller?: ToolCaller, expect?: PublishExpectation): Promise<PublishRecord> {
		const entry = this.require(browserId);
		return await this.serialize(entry, async () => {
			const publication = requirePending(entry.publish, publishId);
			// Before any page interaction: a refusal here leaves the publish pending and nothing clicked.
			requireExpected(this.redact(entry, publishRecord(publication)), caller, expect);
			if (entry.task?.status === "running") {
				fail("task_running", `a browser_task (${entry.task.agent}) owns this page; wait for it or cancel it`);
			}
			await confirm(entry.driver, publication);
			if (publication.record.status === "posted") this.observeConnection(publication.record.profile, publication.recipe.origin, true, this.redact(entry, publication.account));
			return this.redact(entry, publishRecord(publication));
		});
	}

	async cancelPublish(browserId: string, publishId: string): Promise<PublishRecord> {
		const entry = this.require(browserId);
		return await this.serialize(entry, async () => {
			const publication = requirePending(entry.publish, publishId);
			cancel(publication);
			return this.redact(entry, publishRecord(publication));
		});
	}

	/** Not queued: it only reads the record, and must not wait behind a confirm. */
	async waitPublish(browserId: string, publishId: string, ms: number): Promise<PublishRecord> {
		const entry = this.require(browserId);
		const publication = entry.publish;
		if (!publication || publication.record.publishId !== publishId) fail("unknown_publish", "no such publish on this browser");
		await waitSettled(publication, ms);
		return this.redact(entry, publishRecord(publication));
	}

	// -----------------------------------------------------------------------
	// Reading — one logged-out read on this runtime's own headless reader (read.ts)
	// -----------------------------------------------------------------------

	/**
	 * Read `url` in a fresh incognito context of the reader browser. A mirror
	 * or private-address target is refused before anything launches or
	 * navigates, and every request of the read (redirects included) goes
	 * through the same policy; a page that will not serve a logged-out reader
	 * comes back `blocked` with the reason, never retried. No profile and no
	 * Browser View browser is ever involved.
	 */
	async read(request: ReadRequest): Promise<ReadResult> {
		if (this.disposed) fail("disposed", "runtime has been disposed");
		if (!request || typeof request !== "object") fail("bad_read", "read request must be an object");
		const url = navigationUrl(request.url, "url", "bad_url");
		const maxChars = request.maxChars ?? DEFAULT_READ_CHARS;
		if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_READ_CHARS) {
			fail("bad_read", `maxChars must be an integer from 1 to ${MAX_READ_CHARS}`);
		}
		const policy = readPolicy(this.options.allowPrivateReadHosts);
		const refused = await policy.navigation(url);
		if (refused !== null) return { status: "blocked", url, reason: refused };
		return await this.onReader(async () => {
			if (this.disposed) fail("disposed", "runtime has been disposed");
			clearTimeout(this.readerIdle);
			try {
				const reader = await this.liveReader();
				const outcome = await reader.read(url, maxChars, READ_TIMEOUT_MS, policy);
				if (outcome.kind === "timeout") return { status: "blocked", url, reason: TIMEOUT_REASON };
				if (outcome.kind === "refused") return { status: "blocked", url: outcome.url, reason: outcome.reason };
				const seen = outcome.page;
				// The mirror check again, on where the page landed: a redirect the
				// policy did not see (a same-document URL change) is still a mirror.
				const landed = await policy.navigation(seen.url);
				const reason = landed ?? blockedReason(seen);
				if (reason !== null) return { status: "blocked", url: seen.url, reason };
				return { status: "ok", url: seen.url, title: seen.title, text: seen.text, ...(seen.truncated ? { truncated: true as const } : {}) };
			} finally {
				this.readerIdle = setTimeout(() => void this.closeReader().catch((err) => console.error("browser_read reader close failed:", describe(err))), READER_IDLE_MS);
				this.readerIdle.unref();
			}
		});
	}

	/** The reader, launched when there is none (or the last one died). Runs on `readerQueue`. */
	private async liveReader(): Promise<PageReader> {
		const current = this.pageReader;
		if (current?.usable) return current;
		if (current) {
			await current.close();
			this.pageReader = null;
		}
		// A full pool gives up an abandoned throwaway for the reader the same way it does for an open.
		while (this.byId.size + this.opening.size >= MAX_BROWSERS) {
			await this.makeRoom(undefined);
			if (this.disposed) fail("disposed", "runtime has been disposed");
		}
		this.readerLaunching = true;
		try {
			this.pageReader = await launchReader(this.options.executablePath ? { executablePath: this.options.executablePath } : {});
		} finally {
			this.readerLaunching = false;
		}
		return this.pageReader;
	}

	/** Whether the reader holds (or is taking) a browser slot. */
	private readerHeld(): boolean {
		return this.pageReader !== null || this.readerLaunching;
	}

	/** Close the reader after any read in flight; a failed close keeps it, to be retried. */
	private closeReader(): Promise<void> {
		return this.onReader(async () => {
			clearTimeout(this.readerIdle);
			const reader = this.pageReader;
			if (!reader) return;
			await reader.close();
			this.pageReader = null;
		});
	}

	/** The reader's launch, reads and close run strictly in order. */
	private onReader<T>(work: () => Promise<T>): Promise<T> {
		const next = this.readerQueue.then(work, work);
		this.readerQueue = next.catch(() => undefined);
		return next;
	}

	// -----------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------

	private require(browserId: string): Entry {
		const entry = typeof browserId === "string" ? this.byId.get(browserId) : undefined;
		if (!entry || entry.closed) this.refuseGone(browserId);
		entry.lastUsed = performance.now();
		return entry;
	}

	/**
	 * One error for "never existed" and "closed": the id is a capability and the difference is not something an unauthorized caller should
	 * learn. A browser this runtime closed on its own is the exception, and only for its own id, which the chat it is telling already holds.
	 */
	private refuseGone(browserId: string): never {
		const why = this.released.get(browserId);
		// The View reads this very phrase as "this browser is gone for good" (app/view/use-browser-stream.ts); the reason follows it.
		fail("unknown_browser", why === undefined ? "unknown or already closed browserId" : `unknown or already closed browserId: ${why}`);
	}

	/**
	 * All page work for one browser runs strictly in order, never concurrently.
	 * The closed check is re-taken when the work actually starts: the browser
	 * may have been closed (or have crashed) while this call sat in the queue.
	 */
	private serialize<T>(
		entry: Entry,
		work: (entry: Entry) => Promise<T>,
		options: { evenIfClosed?: boolean } = {},
	): Promise<T> {
		entry.pending += 1;
		const run = async (): Promise<T> => {
			try {
				if (entry.closed && !options.evenIfClosed) this.refuseGone(entry.browserId);
				return await work(entry);
			} finally {
				entry.pending -= 1;
				entry.lastUsed = performance.now();
			}
		};
		const next = entry.queue.then(run, run);
		entry.queue = next.catch(() => undefined);
		return next;
	}

	private async refreshState(entry: Entry): Promise<EngineState> {
		if (entry.closed) fail("unknown_browser", "Unknown or already closed browserId.");
		const state = await entry.driver.state();
		if (entry.closed) fail("unknown_browser", "The browser closed during inspection.");
		if (state.documentId !== entry.documentId || state.viewport.width !== entry.viewport.width || state.viewport.height !== entry.viewport.height) {
			entry.revision += 1;
			entry.documentId = state.documentId;
			entry.viewport = state.viewport;
		}
		return state;
	}

	private async buildState(entry: Entry): Promise<BrowserState> {
		const state = await this.refreshState(entry);
		return {
			browserId: entry.browserId, profile: entry.profile, engine: entry.engine, app: entry.driver.app,
			url: state.url, title: state.title, revision: entry.revision,
			viewport: state.viewport, task: entry.task ? cloneTask(entry.task) : null,
			tabs: state.tabs, activeTabId: state.activeTabId, loading: state.loading,
			canGoBack: state.canGoBack, canGoForward: state.canGoForward,
			publish: entry.publish ? publishRecord(entry.publish) : null,
			dialogs: state.dialogs,
		};
	}

	/** State when the page cannot be read (it may be mid-navigation after a failed action). */
	private staleState(entry: Entry): BrowserState {
		return {
			browserId: entry.browserId, profile: entry.profile, engine: entry.engine, app: entry.driver.app, url: "", title: "",
			revision: entry.revision, viewport: entry.viewport, task: entry.task ? cloneTask(entry.task) : null,
			tabs: [], activeTabId: "", loading: false, canGoBack: false, canGoForward: false,
			publish: entry.publish ? publishRecord(entry.publish) : null,
			dialogs: [],
		};
	}

	/**
	 * `value` with every saved password of this profile (on disk, plus any this
	 * browser used) scrubbed out. An unreadable credentials file still scrubs
	 * the ones in memory.
	 */
	private redact<T>(entry: Entry, value: T): T {
		const secrets = new Set(entry.secrets);
		if (entry.profile !== null) {
			try {
				for (const secret of savedPasswords(this.store.profileDir(entry.profile))) secrets.add(secret);
			} catch {
				// credentials_unreadable: the in-memory set is all there is to scrub.
			}
		}
		return secrets.size === 0 ? value : scrub(value, secrets);
	}

	/**
	 * The saved profile behind `entry`. A throwaway browser keeps nothing, so a
	 * sign-in, a saved password or a credential has no home on it: refused
	 * before anything reaches the page, naming the fix.
	 */
	private savedProfile(entry: Entry, needing: string): string {
		if (entry.profile === null) {
			fail("profile_required", `${needing} needs a saved profile, and this browser is a throwaway one (opened without a profile). Close it and open it again with a profile name to keep logins.`);
		}
		return entry.profile;
	}
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** A tab request checked before anything runs: its shape, its op, and the tabId that activate and close need. */
function admitTab(request: TabRequest): PlannedTab {
	if (!request || typeof request !== "object") fail("bad_tab", "tab request must be an object");
	if (request.op !== "new" && request.op !== "activate" && request.op !== "close") fail("bad_tab", "op must be one of: new, activate, close");
	if (request.op !== "new" && (typeof request.tabId !== "string" || request.tabId.length === 0 || request.tabId.length > MAX_TAB_ID_CHARS)) {
		fail("bad_tab", `${request.op} needs the tabId from state.tabs`);
	}
	const url = request.op === "new" && request.url !== undefined ? normalizeAction({ kind: "navigate", url: request.url }).url : undefined;
	return { kind: "tab", op: request.op, ...(request.tabId === undefined ? {} : { tabId: request.tabId }), ...(url === undefined ? {} : { url }) };
}

function normalizeEngine(engine: BrowserEngine | undefined): BrowserEngine {
	const selected = engine ?? "chromium";
	if (BROWSER_ENGINES.includes(selected)) return selected;
	fail("bad_engine", `Unsupported engine ${JSON.stringify(engine)}`);
}

function normalizeViewport(viewport: Viewport | undefined): Viewport {
	if (!viewport) return DEFAULT_VIEWPORT;
	const { width, height } = viewport;
	if (!Number.isFinite(width) || !Number.isFinite(height)) fail("bad_viewport", "viewport dimensions must be numbers");
	return {
		width: Math.min(MAX_VIEWPORT.width, Math.max(MIN_VIEWPORT.width, Math.floor(width))),
		height: Math.min(MAX_VIEWPORT.height, Math.max(MIN_VIEWPORT.height, Math.floor(height))),
	};
}

/** An http(s) URL to navigate to, canonicalized; refused (`code`) as anything else. */
function navigationUrl(url: unknown, name: string, code: string): string {
	if (typeof url !== "string" || url.length > MAX_URL_LENGTH) {
		fail(code, `${name} must be a string of at most ${MAX_URL_LENGTH} characters`);
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		fail(code, `${name} ${JSON.stringify(url)} is not an absolute URL`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		// javascript:, file:, data:, blob:, chrome: are all refused — a
		// navigation must never become script execution or local file reads.
		fail(code, `only http and https navigations are allowed, got ${parsed.protocol}`);
	}
	if (parsed.username || parsed.password) {
		fail(code, "Credentials in navigation URLs are not supported; sign in through the browser.");
	}
	return parsed.toString();
}

/**
 * `value` with every one of `secrets` replaced by `[saved password]` in every
 * string it holds (keys untouched), raw and as a URL carries it: percent-
 * encoded (`encodeURIComponent`, and with `+` for spaces), and form-encoded
 * the way a GET form puts `?pass=…` in the page's URL (which also encodes
 * `!'()~`, left alone by `encodeURIComponent`).
 */
function scrub<T>(value: T, secrets: ReadonlySet<string>): T {
	const forms = new Set<string>();
	for (const secret of secrets) {
		if (secret.length === 0) continue;
		const encoded = encodeURIComponent(secret);
		forms.add(secret).add(encoded).add(encoded.replace(/%20/g, "+")).add(new URLSearchParams([["", secret]]).toString().slice(1));
	}
	return scrubForms(value, [...forms]);
}

function scrubForms<T>(value: T, forms: readonly string[]): T {
	if (typeof value === "string") {
		let out: string = value;
		for (const form of forms) out = out.replaceAll(form, "[saved password]");
		return out as T;
	}
	if (Array.isArray(value)) return value.map((item) => scrubForms(item, forms)) as T;
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubForms(item, forms)])) as T;
	}
	return value;
}

/** `useSavedPassword` or `generatePassword` is `true` and stands in for `text`: exactly one of the three. */
function passwordFlag(action: BrowserAction): { useSavedPassword: true } | { generatePassword: true } {
	const given = [action.text !== undefined, action.useSavedPassword !== undefined, action.generatePassword !== undefined].filter(Boolean).length;
	if (given !== 1) fail("bad_action", `${action.kind}: pass exactly one of text, useSavedPassword: true or generatePassword: true`);
	if (action.useSavedPassword === true) return { useSavedPassword: true };
	if (action.generatePassword === true) return { generatePassword: true };
	return fail("bad_action", `${action.kind}: useSavedPassword and generatePassword can only be true`);
}

/** Validate and canonicalize an action before anything touches the page. */
function normalizeAction(action: BrowserAction): BrowserAction {
	if (!action || typeof action !== "object") fail("bad_action", "action must be an object");
	switch (action.kind) {
		case "navigate":
			return { kind: "navigate", url: navigationUrl(action.url, "navigate.url", "bad_action") };
		case "click": {
			const button = action.button ?? "left";
			if (!MOUSE_BUTTONS.includes(button)) fail("bad_action", `click.button must be one of: ${MOUSE_BUTTONS.join(", ")}`);
			const clickCount = action.clickCount ?? 1;
			if (clickCount !== 1 && clickCount !== 2 && clickCount !== 3) fail("bad_action", "click.clickCount must be 1, 2 or 3");
			const options = { ...(button === "left" ? {} : { button }), ...(clickCount === 1 ? {} : { clickCount }) };
			if (typeof action.selector === "string") {
				return { kind: "click", selector: requireSelector(action.selector), ...options };
			}
			const x = requireCoordinate(action.x, "click", "x");
			const y = requireCoordinate(action.y, "click", "y");
			return { kind: "click", x, y, ...options };
		}
		case "hover": {
			const x = requireCoordinate(action.x, "hover", "x");
			const y = requireCoordinate(action.y, "hover", "y");
			return { kind: "hover", x, y };
		}
		case "insert": {
			if (action.useSavedPassword !== undefined || action.generatePassword !== undefined) return { kind: "insert", ...passwordFlag(action) };
			if (typeof action.text !== "string" || action.text.length === 0 || action.text.length > MAX_TEXT_INPUT) {
				fail("bad_action", `insert.text must be a string of 1-${MAX_TEXT_INPUT} characters`);
			}
			return { kind: "insert", text: action.text };
		}
		case "back":
		case "forward":
		case "reload":
		case "stop":
			return { kind: action.kind };
		case "type": {
			if (action.useSavedPassword !== undefined || action.generatePassword !== undefined) return { kind: "type", selector: requireSelector(action.selector), ...passwordFlag(action) };
			// An empty string is legal and means "clear the field".
			if (typeof action.text !== "string" || action.text.length > MAX_TEXT_INPUT) {
				fail("bad_action", `type.text must be a string of at most ${MAX_TEXT_INPUT} characters`);
			}
			return { kind: "type", selector: requireSelector(action.selector), text: action.text };
		}
		case "select": {
			if (typeof action.value !== "string" || action.value.length > MAX_TEXT_INPUT) {
				fail("bad_action", `select.value must be a string of at most ${MAX_TEXT_INPUT} characters`);
			}
			return { kind: "select", selector: requireSelector(action.selector), value: action.value };
		}
		case "press": {
			const key = action.key;
			if (typeof key !== "string" || (!NAMED_KEYS[key] && [...key].length !== 1)) {
				fail("bad_action", `press.key must be a single character or one of: ${Object.keys(NAMED_KEYS).join(", ")}`);
			}
			return { kind: "press", key };
		}
		case "resize": {
			if (typeof action.width !== "number" || typeof action.height !== "number") fail("bad_action", "resize needs a numeric width and height");
			return { kind: "resize", ...normalizeViewport({ width: action.width, height: action.height }) };
		}
		case "scroll": {
			const deltaX = requireDelta(action.deltaX ?? 0, "deltaX");
			const deltaY = requireDelta(action.deltaY ?? 0, "deltaY");
			if (deltaX === 0 && deltaY === 0) fail("bad_action", "scroll needs a non-zero deltaX or deltaY");
			return { kind: "scroll", deltaX, deltaY };
		}
		default:
			fail("bad_action", `unsupported action kind ${JSON.stringify((action as BrowserAction).kind)}`);
	}
}

function requireSelector(selector: unknown): string {
	if (typeof selector !== "string" || selector.trim().length === 0 || selector.length > MAX_SELECTOR_CHARS) {
		fail("bad_action", `selector must be a non-empty CSS selector of at most ${MAX_SELECTOR_CHARS} characters`);
	}
	return selector.trim();
}

/**
 * The selector of a read that answers "is it there?": plain CSS only. Puppeteer's
 * `text/`, `xpath/`, `aria/`, `pierce/` handlers and `::-p-*` selectors match on
 * page text, which would let a caller probe text the runtime masks, a guess at a time.
 */
function requireReadSelector(selector: unknown): string {
	const css = requireSelector(selector);
	if (/::-p-/i.test(css) || /^(?:@\S+\s+)?(?:aria|text|xpath|pierce|p)\//i.test(css)) {
		fail("bad_action", "selector must be plain CSS: text/, xpath/, aria/, pierce/ and ::-p-* query handlers are not allowed here");
	}
	return css;
}

/** A finite coordinate. Whether it lies inside the viewport is the driver's to say: it is a failed action (`off_viewport`), not a malformed one. */
function requireCoordinate(value: unknown, kind: string, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		fail("bad_action", `${kind} needs ${kind === "click" ? "a selector or " : ""}a finite ${name} coordinate`);
	}
	return Math.floor(value);
}

/** Exactly one condition, and a timeout inside the cap. */
function validateWait(request: WaitRequest): { condition: WaitCondition; timeoutMs: number } {
	if (!request || typeof request !== "object") fail("bad_wait", "wait request must be an object");
	if ([request.selector, request.text, request.url].filter((given) => given !== undefined).length !== 1) {
		fail("bad_wait", "pass exactly one of selector, text or url");
	}
	const timeoutMs = request.timeoutMs ?? DEFAULT_WAIT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) fail("bad_wait", `timeoutMs must be between 0 and ${MAX_WAIT_MS}`);
	if (request.selector !== undefined) return { condition: { selector: requireReadSelector(request.selector) }, timeoutMs };
	const value = request.text ?? request.url;
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_WAIT_MATCH_CHARS) {
		fail("bad_wait", `text and url must be strings of 1-${MAX_WAIT_MATCH_CHARS} characters`);
	}
	return { condition: request.text !== undefined ? { text: value } : { url: value }, timeoutMs };
}

function requireDelta(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) fail("bad_action", `scroll.${name} must be a number`);
	return Math.max(-MAX_SCROLL_DELTA, Math.min(MAX_SCROLL_DELTA, Math.floor(value)));
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A task's page is its own, and a pending publish pins the page: neither takes another caller's page work. */
function refuseWhileBusy(entry: Entry, caller: ToolCaller | undefined): void {
	if (entry.task?.status === "running") {
		fail("task_running", `a browser_task (${entry.task.agent}) owns this page; wait for it or cancel it`);
	}
	refuseWhilePublishing(entry, caller);
}

/**
 * While a post awaits confirmation the page is pinned: only the Browser View's
 * own input ("app") may drive it. Anything else could change what is being
 * confirmed between the fill and the Post. Confirm and cancel are not gated
 * here; any caller may settle the publish.
 */
function refuseWhilePublishing(entry: Entry, caller: ToolCaller | undefined): void {
	if (caller !== "app" && isPending(entry.publish)) {
		fail("publish_pending", "a post awaits confirmation on this browser; confirm or cancel it (browser_publish_confirm / browser_publish_cancel) or wait with browser_publish_wait");
	}
}

/** The bar's Post is clicking submit and waiting for its receipt: the page is its alone until it settles, or the human could post twice or change what is posted. */
function refuseWhileSubmitting(entry: Entry): void {
	if (entry.publish?.confirming && isPending(entry.publish)) {
		fail("publish_pending", "the Post is being submitted; the page takes no input until it is done");
	}
}

/**
 * The confirm must name what it posts. A model (or unstamped) confirm must
 * carry `expect`; any `expect` must match the record the caller was shown —
 * redacted, as every reported record is — exactly: origin, profile, and every
 * field value in field order. The View's Post ("app") is the human's own
 * click on the bar that shows the record, so it may omit `expect`.
 */
function requireExpected(shown: PublishRecord, caller: ToolCaller | undefined, expect: PublishExpectation | undefined): void {
	if (expect === undefined) {
		if (caller !== "app") fail("expect_required", "expect_required: pass expect: { origin, profile, values } copied exactly from the pending publish record (values: every field's value, in field order); nothing was clicked");
		return;
	}
	const values = shown.fields.map((field) => field.value);
	const differs = [
		...(expect.origin === shown.origin ? [] : ["origin"]),
		...(expect.profile === shown.profile ? [] : ["profile"]),
		...(expect.values.length === values.length ? [] : [`values (expected ${values.length}, got ${expect.values.length})`]),
		...values.flatMap((value, index) => (index < expect.values.length && expect.values[index] !== value ? [`values[${index}]`] : [])),
	];
	if (differs.length > 0) {
		fail("publish_mismatch", `publish_mismatch: expect does not match the pending publish (mismatched: ${differs.join(", ")}); nothing was clicked and the publish is still pending. Read it with browser_publish_wait and confirm what it actually holds, or cancel it`);
	}
}

/**
 * The browser is going away under a pending publish: settle it first, so a
 * `browser_publish_wait` hears the outcome instead of waiting out the expiry.
 * A confirm already under way settles itself.
 */
function settleOnClose(entry: Entry): void {
	if (entry.publish && !entry.publish.confirming && isPending(entry.publish)) {
		cancel(entry.publish, "The browser was closed. Nothing was submitted.");
	}
}

function cloneTask(run: TaskRun): TaskRun {
	return { ...run, steps: run.steps.map((step) => ({ ...step })), usage: { ...run.usage } };
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Profiles as a refusal names them for a person to choose from: label and slug only, never anything about their logins. */
function nameProfiles(profiles: readonly { slug: string; label: string }[]): string {
	const shown = profiles.slice(0, 20).map(({ slug, label }) => (label === slug ? slug : `${label} (${slug})`));
	return profiles.length > shown.length ? `${shown.join(", ")} and ${profiles.length - shown.length} more` : shown.join(", ");
}

/** The refusal of a profile someone else holds, open or still launching: whose it is, never an id. The View recognises "is already open". */
function heldMessage(profile: string, holder: Exclude<ProfileHolder, "this chat" | null>): string {
	return `profile "${profile}" is already open, held by ${holder === "human" ? "the human in the View" : "another chat"}. Ask the human to close it, or use another profile.`;
}
