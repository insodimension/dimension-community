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
 *    never re-handed-out; `profiles()` lists profile names only.
 *  - Persistent profiles are never deleted, foreign locks are never stolen, a
 *    profile lock is released only once the owned Chrome process is gone, and a
 *    relay (the human's own Chrome) is never closed.
 *  - Whole tasks run on upstream agent loops (jev, browser-use) against the
 *    same Chrome, through `task.ts`. We keep their progress, not their logic.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type {
	ActionResult,
	BrowserAction,
	BrowserAnnotation,
	BrowserEngine,
	BrowserFrame,
	BrowserOpenOptions,
	BrowserRegion,
	BrowserRuntimePort,
	BrowserState,
	FrameFormat,
	MouseButton,
	PresetRef,
	PublishCheck,
	PublishMode,
	PublishRecipe,
	PublishRecord,
	TabRequest,
	TaskRequest,
	TaskRun,
	TaskStep,
	ToolCaller,
	Viewport,
} from "./contracts.js";
import { BROWSER_ENGINES, TASK_AGENTS } from "./contracts.js";
import { credentialOrigin, resolveCredential } from "./credentials.js";
import { assertEngineAvailable, createEngineDriver } from "./engines/index.js";
import type { EngineDriver, EngineState } from "./engines/types.js";
import { cropRegion, MAX_FRAME_BYTES } from "./image.js";
import { type Publication, cancel, confirm, isPending, prepare, publishRecord, requirePending, validateMode, validateRecipe, waitSettled } from "./publish.js";
import { ActionNotDispatched, fail, ProfileStore, validateProfile } from "./store.js";
import { type RunningWorker, startWorker } from "./task.js";

// ---------------------------------------------------------------------------
// Bounds. Every unbounded thing in a long-lived runtime is a leak or a weapon.
// ---------------------------------------------------------------------------
const MAX_BROWSERS = 4;
const MAX_FRAMES_RETAINED = 8;
const MAX_SNAPSHOT_CHARS = 20_000;
const MAX_ELEMENT_CHARS = 4_000;
const MAX_TEXT_INPUT = 4_096;
const MAX_NOTE_CHARS = 8_192;
const MAX_SELECTOR_CHARS = 512;
const MAX_TAB_ID_CHARS = 128;
const MOUSE_BUTTONS: readonly MouseButton[] = ["left", "right", "middle"];
const MAX_URL_LENGTH = 2_048;
const MAX_SCROLL_DELTA = 5_000;
const MAX_TASK_CHARS = 8_192;
const MAX_TASK_STEPS = 200;
const DEFAULT_TASK_STEPS = 60;
const TASK_STEPS_RETAINED = 100;
const MIN_WIDTH = 320;
const MAX_WIDTH = 2_560;
const MIN_HEIGHT = 240;
const MAX_HEIGHT = 2_000;
const DEFAULT_VIEWPORT: Viewport = { width: 1_280, height: 800 };
/**
 * Reserved slug for the chrome-relay engine. The relay is a single running
 * Chrome with a single cookie jar, so exactly one relay lease exists per
 * profile root and it is never confused with an isolated chromium profile.
 */
const RELAY_PROFILE = "relay";

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

export interface BrowserRuntimeOptions {
	/** Profile root; defaults to `$INSO_HOME/browser` else `~/.inso/browser`. */
	rootDir?: string;
	/** Chrome/Chromium binary. Omitted → puppeteer's installed `chrome` channel. */
	executablePath?: string;
	/** chrome-relay CDP endpoint. Defaults to http://127.0.0.1:9224. */
	relayUrl?: string;
	/** Explicit browser visibility; omitted uses each engine's supported default. */
	headless?: boolean;
}

interface FrameRecord {
	id: string;
	bytes: Buffer;
	url: string;
	revision: number;
	viewport: Viewport;
	capturedAt: string;
}

interface Entry {
	/** Opaque capability. Never listed, never re-handed-out. */
	browserId: string;
	profile: string;
	engine: BrowserEngine;
	viewport: Viewport;
	driver: EngineDriver;
	documentId: string;
	release(): void;
	revision: number;
	frames: FrameRecord[];
	/** Per-browser serializer: page reads and actions run in order. */
	queue: Promise<unknown>;
	closed: boolean;
	/** The running or most recent task. */
	task: TaskRun | null;
	/** The live task worker, while one runs. */
	worker: { process: RunningWorker; finished: Promise<TaskRun> } | null;
	/** The current or most recent publish (publish.ts). */
	publish: Publication | null;
}

export class BrowserRuntime implements BrowserRuntimePort {
	private readonly store: ProfileStore;
	private readonly options: BrowserRuntimeOptions;
	private readonly byId = new Map<string, Entry>();
	private readonly byProfile = new Map<string, Entry>();
	/** In-flight launches, so a second open cannot race a first one. */
	private readonly opening = new Map<string, Promise<Entry>>();
	/**
	 * Drivers whose rollback close failed during launch. Their shutdown is
	 * unconfirmed, so their profile lock is deliberately retained; keeping the
	 * driver here is what makes that close retryable instead of orphaning a
	 * process the runtime can no longer name.
	 */
	private readonly stranded = new Set<{ driver: EngineDriver; release: () => void }>();
	private disposed = false;

	constructor(options: BrowserRuntimeOptions = {}) {
		this.options = options;
		this.store = new ProfileStore(options.rootDir);
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	/**
	 * Open a browser for `profile` and mint a fresh capability for it.
	 *
	 * A profile that is already open — or in the middle of opening — is REFUSED.
	 * One engine server serves many sessions, so returning the live browserId of
	 * somebody else's browser would hand out their capability; and launching a
	 * second Chrome on the same user-data dir would fork the cookie jar. The
	 * holder of the existing capability closes it, or the caller picks another
	 * profile.
	 */
	async open(options: BrowserOpenOptions): Promise<BrowserState> {
		if (this.disposed) fail("disposed", "runtime has been disposed");
		const profile = validateProfile(options.profile);
		const engine = normalizeEngine(options.engine);
		const viewport = normalizeViewport(options.viewport);

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
		const live = this.byProfile.get(profile);
		if (live || this.opening.has(profile)) {
			fail(
				"profile_in_use",
				`profile "${profile}" is already open in this runtime; close that browser before opening it again`,
			);
		}
		// Count launches in flight too: four concurrent opens must not slip past
		// the bound just because none of them has finished launching yet.
		if (this.byId.size + this.opening.size >= MAX_BROWSERS) {
			fail("too_many_browsers", `at most ${MAX_BROWSERS} browsers may be open at once; close one first`);
		}

		assertEngineAvailable(engine);
		const started = this.launch(profile, engine, viewport).finally(() => this.opening.delete(profile));
		this.opening.set(profile, started);
		const entry = await started;
		return await this.buildState(entry);
	}

	private async launch(profile: string, engine: BrowserEngine, viewport: Viewport): Promise<Entry> {
		const lock = this.store.acquireLock(profile);
		let released = false;
		let entry: Entry | undefined;
		let driver: EngineDriver | undefined;
		const release = (): void => {
			if (released) return;
			this.store.releaseLock(lock);
			released = true;
			if (entry) this.detach(entry);
		};
		try {
			// Native backends never reuse an incompatible engine's cookie store.
			const profileDirectory = engine === "chromium"
				? this.store.userDataDir(profile)
				: join(this.store.profileDir(profile), engine);
			driver = await createEngineDriver(engine, {
				profileDirectory, viewport, onClosed: release,
				...(this.options.headless === undefined ? {} : { headless: this.options.headless }),
				...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
				...(this.options.relayUrl && engine === "chrome-relay" ? { relayUrl: this.options.relayUrl } : {}),
			});
			const initial = await driver.state();
			if (released) fail("browser_closed", "The browser closed during initialization.");
			entry = {
				browserId: randomBytes(24).toString("base64url"),
				profile, engine, viewport: initial.viewport, documentId: initial.documentId,
				driver, release, revision: 1, frames: [], queue: Promise.resolve(), closed: false,
				task: null, worker: null, publish: null,
			};
			this.byId.set(entry.browserId, entry);
			this.byProfile.set(profile, entry);
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
			throw error;
		}
	}


	/** Refused (`publish_pending`) while a publish awaits confirmation, unless `caller` is "app". */
	async close(browserId: string, caller?: ToolCaller): Promise<void> {
		// A failed close revokes reads/actions but remains retryable for cleanup.
		const entry = this.byId.get(browserId);
		if (!entry) fail("unknown_browser", "Unknown or already closed browserId.");
		await this.serialize(entry, async () => {
			if (!entry.closed) refuseWhilePublishing(entry, caller);
			await this.teardown(entry);
		}, { evenIfClosed: true });
	}

	/** Retain ownership and the lock until the driver confirms shutdown. */
	private async teardown(entry: Entry): Promise<void> {
		if (this.byId.get(entry.browserId) !== entry) return;
		settleOnClose(entry);
		entry.closed = true;
		entry.frames.length = 0;
		// A task agent drives this Chrome; it stops before the browser does.
		await this.stopTask(entry);
		await entry.driver.close();
		entry.release();
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		// Let in-flight launches finish first: a browser born after we started
		// disposing would otherwise outlive the runtime holding its lock.
		await Promise.allSettled([...this.opening.values()]);
		const errors: string[] = [];
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
		if (errors.length > 0) fail("dispose_incomplete", `some browsers did not shut down cleanly: ${errors.join("; ")}`);
	}

	/** Drop in-memory state and make the capability dead. Does NOT free the lock. */
	private detach(entry: Entry): void {
		settleOnClose(entry);
		entry.closed = true;
		entry.frames.length = 0;
		entry.worker?.process.cancel();
		this.byId.delete(entry.browserId);
		if (this.byProfile.get(entry.profile) === entry) this.byProfile.delete(entry.profile);
	}

	// -----------------------------------------------------------------------
	// Read paths
	// -----------------------------------------------------------------------

	async state(browserId: string): Promise<BrowserState> {
		return await this.serialize(this.require(browserId), (entry) => this.buildState(entry));
	}

	/**
	 * `png` (default): a fresh capture, retained so it can be annotated.
	 * `jpeg`: the live screencast's newest frame, straight from memory. It is
	 * deliberately NOT queued behind page work — the live view keeps moving
	 * while a navigation or action is in flight — and is not annotatable.
	 */
	async frame(browserId: string, format: FrameFormat = "png"): Promise<BrowserFrame> {
		if (format === "jpeg") {
			const entry = this.require(browserId);
			const live = await entry.driver.liveFrame();
			return { state: await this.buildState(entry), frameId: live.id, mimeType: "image/jpeg", data: live.data, capturedAt: live.capturedAt };
		}
		if (format !== "png") fail("bad_format", `format must be "jpeg" or "png"`);
		return await this.serialize(this.require(browserId), async (entry) => {
			const before = await this.refreshState(entry);
			const revision = entry.revision;
			const url = before.url;
			const shot = await entry.driver.screenshot();
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
				bytes,
				url,
				revision,
				viewport: entry.viewport,
				capturedAt,
			};
			entry.frames.push(record);
			while (entry.frames.length > MAX_FRAMES_RETAINED) entry.frames.shift();
			return {
				state,
				frameId: record.id,
				mimeType: "image/png" as const,
				data: bytes.toString("base64"),
				capturedAt: record.capturedAt,
			};
		});
	}

	async snapshot(browserId: string): Promise<{ state: BrowserState; text: string }> {
		return await this.serialize(this.require(browserId), async (entry) => {
			await this.refreshState(entry);
			const revision = entry.revision;
			const text = await entry.driver.snapshot(MAX_SNAPSHOT_CHARS);
			const state = await this.buildState(entry);
			if (entry.revision !== revision) fail("stale_snapshot", "The document changed during inspection.");
			return { state, text };
		});
	}

	/**
	 * Crop the STORED bytes of `frameId` and attach bounded live element context.
	 *
	 * Honesty note baked into the returned payload: the crop is the captured
	 * frame, while the element list is read from the page as it is NOW. On a
	 * dynamic page those can disagree even at the same revision; we never claim
	 * they are the same instant.
	 */
	async annotate(
		browserId: string,
		frameId: string,
		region: BrowserRegion,
		note: string,
	): Promise<BrowserAnnotation> {
		const entry = this.require(browserId);
		const text = note ?? "";
		if (typeof text !== "string" || text.length > MAX_NOTE_CHARS) {
			fail("bad_note", `note must be a string of at most ${MAX_NOTE_CHARS} characters`);
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
			const { png, region: clamped } = cropRegion(record.bytes, region);
			const elements = await entry.driver.elements(clamped, MAX_ELEMENT_CHARS);
			await this.refreshState(entry);
			if (record.revision !== entry.revision) fail("stale_frame", "The document changed while reading annotation context.");
			return {
				url: record.url,
				note: text,
				region: clamped,
				capturedAt: record.capturedAt,
				mimeType: "image/png" as const,
				data: png.toString("base64"),
				elements:
					`${elements}\n\n[live DOM read at ${new Date().toISOString()}, revision ${entry.revision}; ` +
					`the image is the frame captured at ${record.capturedAt} — a dynamic page may have changed between them]`,
			};
		});
	}

	async profiles(): Promise<string[]> {
		return this.store.list();
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
			return await this.buildState(entry);
		});
	}

	/**
	 * Open, show or close a tab. Every read and action works on the active tab.
	 * Refused while a task runs: switching away from the agent's tab hides it,
	 * and a hidden tab renders no frames, so the agent would stall.
	 */
	async tab(browserId: string, request: TabRequest, caller?: ToolCaller): Promise<BrowserState> {
		const entry = this.require(browserId);
		if (!request || typeof request !== "object") fail("bad_tab", "tab request must be an object");
		const navigate = request.op === "new" && request.url !== undefined
			? normalizeAction({ kind: "navigate", url: request.url }, entry.viewport)
			: undefined;
		if ((request.op === "activate" || request.op === "close") && (typeof request.tabId !== "string" || request.tabId.length === 0 || request.tabId.length > MAX_TAB_ID_CHARS)) {
			fail("bad_tab", `${request.op} needs the tabId from state.tabs`);
		}
		return await this.serialize(entry, async () => {
			if (entry.task?.status === "running") {
				fail("task_running", `a ${entry.task.agent} task is driving this browser; wait for it or cancel it first`);
			}
			refuseWhilePublishing(entry, caller);
			switch (request.op) {
				case "new":
					try {
						await entry.driver.openTab(navigate?.url);
					} catch (error) {
						fail("tab_failed", `opening a new tab${navigate ? ` at ${navigate.url}` : ""} failed: ${describe(error)}`);
					}
					break;
				case "activate":
					await entry.driver.activateTab(request.tabId as string);
					break;
				case "close":
					await entry.driver.closeTab(request.tabId as string);
					break;
				default:
					fail("bad_tab", `op must be one of: new, activate, close`);
			}
			return await this.buildState(entry);
		});
	}

	// -----------------------------------------------------------------------
	// Actions
	// -----------------------------------------------------------------------

	async act(browserId: string, input: BrowserAction, caller?: ToolCaller): Promise<ActionResult> {
		const entry = this.require(browserId);
		return await this.serialize(entry, async () => {
			if (entry.task?.status === "running") {
				fail("task_running", `a ${entry.task.agent} task is driving this browser; wait for it or cancel it first`);
			}
			refuseWhilePublishing(entry, caller);
			const action = normalizeAction(input, entry.viewport);
			// The human driving the pinned page while waiting may hit the site's own submit.
			const pinned = caller === "app" && TOUCHING_KINDS[action.kind] && isPending(entry.publish) ? entry.publish : null;
			// Another tab is not the page being confirmed; an unreadable state counts as the pinned one.
			const touching = pinned !== null && ((await entry.driver.state().catch(() => null))?.activeTabId ?? pinned.record.tabId) === pinned.record.tabId ? pinned : null;
			try {
				await entry.driver.perform(action);
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
					state: await this.buildState(entry).catch(() => this.staleState(entry)),
				};
			}
			return { status: "completed", state: await this.buildState(entry) };
		});
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
		return await (await this.beginTask(browserId, request, onStep)).finished;
	}

	/** Start a task and return as soon as it runs; follow it with `waitTask`. */
	async startTask(browserId: string, request: TaskRequest, caller?: ToolCaller): Promise<TaskRun> {
		const { run } = await this.beginTask(browserId, request, undefined, caller);
		return cloneTask(run);
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
			if (request.agent !== "jev") fail("credential_unsupported", "credential is supported with agent jev only; with browser-use the user signs in by hand in the View");
			credentialOrigin(request.credential?.origin);
		}

		return await this.serialize(entry, async () => {
			if (entry.worker) fail("task_running", `a ${entry.task?.agent} task is already running on this browser`);
			refuseWhilePublishing(entry, caller);
			const state = await this.refreshState(entry);
			// Resolved (and, for a sign-up, minted) only once the task will run.
			const credential = request.credential ? resolveCredential(this.store.profileDir(entry.profile), request.credential) : undefined;
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
					onStep?.(record, run);
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
		return cloneTask(entry.task);
	}

	async cancelTask(browserId: string): Promise<TaskRun> {
		const entry = this.require(browserId);
		const worker = entry.worker;
		if (!worker) {
			if (!entry.task) fail("no_task", "no task has run on this browser");
			return entry.task;
		}
		worker.process.cancel();
		return await worker.finished;
	}

	/** Stop a running task and wait for its worker to exit. */
	private async stopTask(entry: Entry): Promise<void> {
		const worker = entry.worker;
		if (!worker) return;
		worker.process.cancel();
		await worker.finished;
	}

	// -----------------------------------------------------------------------
	// Publishing — fill, park for the human's Post, submit once (publish.ts)
	// -----------------------------------------------------------------------

	async publish(browserId: string, recipe: PublishRecipe, mode: PublishMode, caller?: ToolCaller, preset?: PresetRef): Promise<PublishCheck | PublishRecord> {
		const entry = this.require(browserId);
		const valid = validateRecipe(recipe);
		const selected = validateMode(mode);
		return await this.serialize(entry, async () => {
			if (entry.task?.status === "running") {
				fail("task_running", `a ${entry.task.agent} task is driving this browser; wait for it or cancel it first`);
			}
			refuseWhilePublishing(entry, caller);
			// Even from the View: a check or a second post would navigate away from the page the human is confirming.
			if (isPending(entry.publish)) {
				fail("publish_pending", "a publish is already waiting for the human's confirmation in the Browser View; it must be posted, cancelled or expire first");
			}
			const outcome = await prepare(entry.driver, entry.profile, valid, selected);
			if (!("record" in outcome)) return outcome;
			// The relay is the human's own Chrome: they can use this page without the runtime seeing it.
			outcome.sharedPage = entry.engine === "chrome-relay";
			if (preset !== undefined) outcome.record.preset = { name: preset.name, verified: preset.verified };
			entry.publish = outcome;
			return publishRecord(outcome);
		});
	}

	async confirmPublish(browserId: string, publishId: string): Promise<PublishRecord> {
		const entry = this.require(browserId);
		return await this.serialize(entry, async () => {
			const publication = requirePending(entry.publish, publishId);
			if (entry.task?.status === "running") {
				fail("task_running", `a ${entry.task.agent} task is driving this browser; wait for it or cancel it first`);
			}
			await confirm(entry.driver, publication);
			return publishRecord(publication);
		});
	}

	async cancelPublish(browserId: string, publishId: string): Promise<PublishRecord> {
		const entry = this.require(browserId);
		return await this.serialize(entry, async () => {
			const publication = requirePending(entry.publish, publishId);
			cancel(publication);
			return publishRecord(publication);
		});
	}

	/** Not queued: it only reads the record, and must not wait behind a confirm. */
	async waitPublish(browserId: string, publishId: string, ms: number): Promise<PublishRecord> {
		const publication = this.require(browserId).publish;
		if (!publication || publication.record.publishId !== publishId) fail("unknown_publish", "no such publish on this browser");
		await waitSettled(publication, ms);
		return publishRecord(publication);
	}

	// -----------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------

	private require(browserId: string): Entry {
		const entry = typeof browserId === "string" ? this.byId.get(browserId) : undefined;
		// Same error for "never existed" and "closed": the id is a capability and
		// the difference is not something an unauthorized caller should learn.
		if (!entry || entry.closed) fail("unknown_browser", "unknown or already closed browserId");
		return entry;
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
		const run = async (): Promise<T> => {
			if (entry.closed && !options.evenIfClosed) fail("unknown_browser", "unknown or already closed browserId");
			return await work(entry);
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
			browserId: entry.browserId, profile: entry.profile, engine: entry.engine,
			url: state.url, title: state.title, revision: entry.revision,
			viewport: state.viewport, task: entry.task ? cloneTask(entry.task) : null,
			tabs: state.tabs, activeTabId: state.activeTabId, loading: state.loading,
			canGoBack: state.canGoBack, canGoForward: state.canGoForward,
			publish: entry.publish ? publishRecord(entry.publish) : null,
		};
	}

	/** State when the page cannot be read (it may be mid-navigation after a failed action). */
	private staleState(entry: Entry): BrowserState {
		return {
			browserId: entry.browserId, profile: entry.profile, engine: entry.engine, url: "", title: "",
			revision: entry.revision, viewport: entry.viewport, task: entry.task ? cloneTask(entry.task) : null,
			tabs: [], activeTabId: "", loading: false, canGoBack: false, canGoForward: false,
			publish: entry.publish ? publishRecord(entry.publish) : null,
		};
	}
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

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
		width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.floor(width))),
		height: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.floor(height))),
	};
}

/** Validate and canonicalize an action before anything touches the page. */
function normalizeAction(action: BrowserAction, viewport: Viewport): BrowserAction {
	if (!action || typeof action !== "object") fail("bad_action", "action must be an object");
	switch (action.kind) {
		case "navigate": {
			if (typeof action.url !== "string" || action.url.length > MAX_URL_LENGTH) {
				fail("bad_action", `navigate.url must be a string of at most ${MAX_URL_LENGTH} characters`);
			}
			let parsed: URL;
			try {
				parsed = new URL(action.url);
			} catch {
				fail("bad_action", `navigate.url ${JSON.stringify(action.url)} is not an absolute URL`);
			}
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				// javascript:, file:, data:, blob:, chrome: are all refused — a
				// navigation must never become script execution or local file reads.
				fail("bad_action", `only http and https navigations are allowed, got ${parsed.protocol}`);
			}
			if (parsed.username || parsed.password) {
				fail("bad_action", "Credentials in navigation URLs are not supported; sign in through the browser.");
			}
			return { kind: "navigate", url: parsed.toString() };
		}
		case "click": {
			const button = action.button ?? "left";
			if (!MOUSE_BUTTONS.includes(button)) fail("bad_action", `click.button must be one of: ${MOUSE_BUTTONS.join(", ")}`);
			const clickCount = action.clickCount ?? 1;
			if (clickCount !== 1 && clickCount !== 2 && clickCount !== 3) fail("bad_action", "click.clickCount must be 1, 2 or 3");
			const options = { ...(button === "left" ? {} : { button }), ...(clickCount === 1 ? {} : { clickCount }) };
			if (typeof action.selector === "string") {
				return { kind: "click", selector: requireSelector(action.selector), ...options };
			}
			const x = requireCoordinate(action.x, "click", "x", viewport.width);
			const y = requireCoordinate(action.y, "click", "y", viewport.height);
			return { kind: "click", x, y, ...options };
		}
		case "hover": {
			const x = requireCoordinate(action.x, "hover", "x", viewport.width);
			const y = requireCoordinate(action.y, "hover", "y", viewport.height);
			return { kind: "hover", x, y };
		}
		case "insert": {
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

function requireCoordinate(value: unknown, kind: string, name: string, bound: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		fail("bad_action", `${kind} needs ${kind === "click" ? "a selector or " : ""}a finite ${name} coordinate`);
	}
	const rounded = Math.floor(value);
	if (rounded < 0 || rounded >= bound) {
		fail("bad_action", `${kind}.${name}=${rounded} is outside the ${bound}px viewport`);
	}
	return rounded;
}

function requireDelta(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) fail("bad_action", `scroll.${name} must be a number`);
	return Math.max(-MAX_SCROLL_DELTA, Math.min(MAX_SCROLL_DELTA, Math.floor(value)));
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * While the human is confirming a post, the page is theirs: only the Browser
 * View's own input ("app") may drive it. Anything else could change what the
 * human is approving between their look and their Post.
 */
function refuseWhilePublishing(entry: Entry, caller: ToolCaller | undefined): void {
	if (caller !== "app" && isPending(entry.publish)) {
		fail("publish_pending", "the human is confirming a post in the Browser View; wait with browser_publish_wait");
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
