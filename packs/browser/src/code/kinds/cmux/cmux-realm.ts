// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/tab-supervisor.ts:587-700 (the cmux branch of runInTab) and :766-911 (releaseTab for a cmux surface) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../../third-party/omp/LICENSE.
// Changed for the Browser pack: (matrix F6) OMP's supervisor, its process-global tab map and idle clocks are not here (the code host owns lifetime and opens the surface: cmux-surface.ts); this is only what a cmux surface needs beside
// the puppeteer tab realm: adopt a surface by its UUID, run a cell or a call chain on it, and drop it.

/**
 * The tabs of a cmux browser, by name. A cmux surface is not a Chrome page (there is no CDP, no engine, no puppeteer): it is driven over the cmux daemon's
 * socket by {@link CmuxTab}, so it has its own small realm beside the one for Chrome pages. It answers the same questions the code worker asks of
 * any realm (`run`, `call`, `release`, `end`, `dispose`, `names`) with the same texts for a tab that is gone or busy. It never opens or closes a surface:
 * the host did the one and does the other, and this realm only lets go.
 */
import type { CmuxConnection, CodeEvaluator, RunResult, TabHandle } from "../../contracts.js";
import { renderFunctionRun } from "../../cell/run-code.js";
import { ToolAbortError, ToolError } from "../../errors.js";
import { renderTabCall, type TabCallStep } from "../../worker/tab-call.js";
import { CmuxTab, type CmuxRunSettings, runCmuxCode } from "./cmux-tab.js";
import { CmuxSocketClient } from "./socket-client.js";

/** The names a function run receives (OMP `BROWSER_RUN_SCOPE`). */
const RUN_SCOPE: readonly string[] = ["tab", "page", "browser", "wait", "assert"];

export interface CmuxRealmOptions {
	/** One evaluator per tab NAME, so a tab's top-level names persist per tab as they do in OMP. */
	evaluator: () => CodeEvaluator;
	/** What a run needs of its session: the screenshot folder, the working folder for `uploadFile`, the picture format. */
	settings: () => CmuxRunSettings;
	/** Reaches the daemon the host resolved. Default: a connected {@link CmuxSocketClient}. A test passes its fake socket. */
	connect?: (connection: CmuxConnection) => Promise<CmuxSocketClient>;
}

interface Session {
	name: string;
	tab: CmuxTab;
	browserId: string;
	surfaceId: string;
	evaluator: CodeEvaluator | undefined;
	/** The run in flight on this tab, if any. */
	active: AbortController | null;
	done: Promise<void> | null;
}

async function connectCmux(connection: CmuxConnection): Promise<CmuxSocketClient> {
	const client = new CmuxSocketClient({
		socketPath: connection.socketPath,
		...(connection.password ? { password: connection.password } : {}),
		...(connection.relayId ? { relayId: connection.relayId } : {}),
		...(connection.relayToken ? { relayToken: connection.relayToken } : {}),
	});
	await client.connect();
	return client;
}

export class CmuxRealm {
	readonly #options: CmuxRealmOptions;
	readonly #sessions = new Map<string, Session>();
	/** One connection per daemon, shared by every tab on it. */
	readonly #clients = new Map<string, Promise<CmuxSocketClient>>();

	constructor(options: CmuxRealmOptions) {
		this.#options = options;
	}

	names(): string[] {
		return [...this.#sessions.keys()];
	}

	has(name: string): boolean {
		return this.#sessions.has(name);
	}

	#client(connection: CmuxConnection): Promise<CmuxSocketClient> {
		let client = this.#clients.get(connection.socketPath);
		if (client === undefined) {
			client = (this.#options.connect ?? connectCmux)(connection);
			this.#clients.set(connection.socketPath, client);
			// A connection that failed is not kept: the next adopt tries again.
			client.catch(() => {
				if (this.#clients.get(connection.socketPath) === client) this.#clients.delete(connection.socketPath);
			});
		}
		return client;
	}

	/** Take the surface the host opened (or attached to) as the tab `name`. */
	async adopt(name: string, handle: TabHandle): Promise<void> {
		if (handle.kind !== "cmux" || handle.cmux === undefined) throw new ToolError("A cmux tab needs the connection to its daemon that the host resolved");
		const held = this.#sessions.get(name);
		if (held && held.surfaceId === handle.targetId && held.browserId === handle.browserId) return;
		const client = await this.#client(handle.cmux);
		const tab = new CmuxTab({ client, surfaceId: handle.targetId, url: handle.url, ...(handle.title ? { title: handle.title } : {}) });
		this.#sessions.set(name, { name, tab, browserId: handle.browserId, surfaceId: handle.targetId, evaluator: undefined, active: null, done: null });
		if (held) await this.#close(held, new ToolError(`Tab "${name}" was closed`));
	}

	async run(r: { name: string; code?: string; fn?: string; args?: unknown[]; timeoutMs: number; signal: AbortSignal }): Promise<RunResult> {
		const hasCode = r.code !== undefined && r.code.trim().length > 0;
		const hasFn = r.fn !== undefined && r.fn.trim().length > 0;
		if (hasCode === hasFn) throw new ToolError("Action 'run' requires exactly one of 'code' or 'fn'.");
		const code = hasFn ? renderFunctionRun(r.fn!.trim(), RUN_SCOPE, r.args ?? []) : r.code!.trim();
		return await this.#execute(this.#alive(r.name), code, r.timeoutMs, r.signal);
	}

	async call(r: { name: string; chain: Array<{ method: string; args: unknown[] }>; timeoutMs: number; signal: AbortSignal }): Promise<RunResult> {
		return await this.#execute(this.#alive(r.name), renderTabCall(r.chain as readonly TabCallStep[]), r.timeoutMs, r.signal);
	}

	/** Let go of the tab `name`. The surface stays: the host closes a split it opened, and a surface the person pointed at is theirs. */
	async release(name: string): Promise<boolean> {
		const session = this.#sessions.get(name);
		if (!session) return false;
		this.#sessions.delete(name);
		await this.#close(session, new ToolError(`Tab "${name}" was closed`));
		return true;
	}

	/** The browser the tabs belonged to went away: they go with it, and a run on one ends now saying why. */
	async end(browserId: string, reason?: string): Promise<void> {
		for (const session of [...this.#sessions.values()]) {
			if (session.browserId !== browserId) continue;
			this.#sessions.delete(session.name);
			await this.#close(session, new ToolError(reason ?? `Tab "${session.name}" was closed`));
		}
	}

	async dispose(): Promise<void> {
		for (const name of [...this.#sessions.keys()]) await this.release(name);
		const clients = [...this.#clients.values()];
		this.#clients.clear();
		for (const client of clients) (await client.catch(() => undefined))?.close();
	}

	#alive(name: string): Session {
		const session = this.#sessions.get(name);
		if (!session) throw new ToolError(`Tab ${JSON.stringify(name)} is not alive. Open it first with action:"open".`);
		return session;
	}

	async #execute(session: Session, code: string, timeoutMs: number, hostSignal: AbortSignal): Promise<RunResult> {
		if (session.active) throw new ToolError(`Tab ${JSON.stringify(session.name)} is busy`);
		if (hostSignal.aborted) throw new ToolAbortError();
		// A tab closed under a run ends the run at once, not at its budget: the run's signal carries that abort.
		const closeAc = new AbortController();
		const finished = Promise.withResolvers<void>();
		session.active = closeAc;
		session.done = finished.promise;
		try {
			const evaluator = (session.evaluator ??= this.#options.evaluator());
			return await runCmuxCode(session.tab, { code, timeoutMs, signal: AbortSignal.any([hostSignal, closeAc.signal]), settings: this.#options.settings(), evaluator });
		} finally {
			if (session.active === closeAc) session.active = null;
			finished.resolve();
		}
	}

	async #close(session: Session, reason: Error): Promise<void> {
		session.active?.abort(reason);
		await session.done?.catch(() => undefined);
	}
}
