// The ElevenLabs Agents REST side of Live (doc 92 §8): create the ONE shared agent and its ONE client
// tool on first use, keep them in step with the body this code wants, and mint the short-lived signed
// URL a call connects with. The ids (never a secret) live in `<engine home>/speech/elevenlabs-agents.json`
// beside a hash of each body, so an edited body PATCHes the remote and a deleted remote is recreated.
//
// The agent is generic on purpose: the persona, the first message and the voice arrive PER CALL as
// overrides (`convai.ts`), so nothing about a session is ever written to the account.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SpeechReadiness } from "@dimension/sdk/provider";
import { DEFAULT_VOICES } from "./catalog.js";
import { agentBody, toolBody } from "./convai.js";
import { API_HOST, isRecord } from "./protocol.js";

const RECORD_FILE = join("speech", "elevenlabs-agents.json");
const REQUEST_TIMEOUT_MS = 15_000;
const PROBE_TTL_MS = 5 * 60_000;
/** A failed probe (offline, a blip) is retried soon rather than pinning "unavailable" for minutes. */
const PROBE_FAILURE_TTL_MS = 30_000;

export const AGENTS_PERMISSION_DETAIL = "the key needs the ElevenLabs Agents permissions (convai read + write)";

/** A non-2xx answer from the Agents API. `message` is safe to show: it never carries the key. */
export class ConvaiHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ConvaiHttpError";
	}
}

/** What ElevenLabs said, reduced to one short sentence (`detail.message`), without quoting the request. */
function describeFailure(status: number, body: unknown): string {
	const detail = isRecord(body) && isRecord(body.detail) ? body.detail : undefined;
	const message = typeof detail?.message === "string" ? detail.message.slice(0, 200) : "";
	if (status === 401 || status === 403) {
		const missing = status === 403 || detail?.status === "missing_permissions" || message.includes("permission");
		return missing ? `ElevenLabs refused the Agents call: ${AGENTS_PERMISSION_DETAIL}` : "ElevenLabs rejected the API key";
	}
	return `ElevenLabs Agents answered ${status}${message ? `: ${message}` : ""}`;
}

interface AgentRecord {
	readonly version: 1;
	readonly agentId: string;
	readonly toolId: string;
	readonly toolHash: string;
	readonly agentHash: string;
}

function hashOf(body: unknown): string {
	return createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
}

function asRecord(value: unknown): AgentRecord | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	const { agentId, toolId, toolHash, agentHash } = value;
	if (typeof agentId !== "string" || typeof toolId !== "string") return undefined;
	if (typeof toolHash !== "string" || typeof agentHash !== "string") return undefined;
	return { version: 1, agentId, toolId, toolHash, agentHash };
}

export interface MintArgs {
	readonly apiKey: string;
	/** The engine home: where the ids are kept. */
	readonly home: string;
	/** The agent's TTS model (`eleven_v4_turbo` / `eleven_v4`). */
	readonly ttsModel: string;
	readonly signal: AbortSignal;
}

export class Agents {
	readonly #fetch: typeof fetch;
	/** Provisioning for one home is serial: two calls must not both create an agent. */
	readonly #tails = new Map<string, Promise<unknown>>();
	readonly #probes = new Map<string, { readonly at: number; readonly result: Promise<SpeechReadiness>; ok: boolean }>();
	readonly #now: () => number;

	constructor(doFetch: typeof fetch, now: () => number = Date.now) {
		this.#fetch = doFetch;
		this.#now = now;
	}

	async #call(
		apiKey: string,
		method: string,
		path: string,
		body: unknown,
		signal: AbortSignal | undefined,
	): Promise<unknown> {
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const res = await this.#fetch(`https://${API_HOST}${path}`, {
			method,
			headers: { "xi-api-key": apiKey, ...(body === undefined ? {} : { "content-type": "application/json" }) },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		const text = await res.text();
		let json: unknown;
		try {
			json = text ? JSON.parse(text) : undefined;
		} catch {
			json = undefined;
		}
		if (!res.ok) throw new ConvaiHttpError(res.status, describeFailure(res.status, json));
		return json;
	}

	// ---- the stored ids ---------------------------------------------------------------------------

	async #read(home: string): Promise<AgentRecord | undefined> {
		try {
			return asRecord(JSON.parse(await readFile(join(home, RECORD_FILE), "utf8")));
		} catch {
			return undefined;
		}
	}

	async #write(home: string, record: AgentRecord): Promise<void> {
		const path = join(home, RECORD_FILE);
		await mkdir(dirname(path), { recursive: true });
		const scratch = `${path}.${process.pid}.tmp`;
		await writeFile(scratch, `${JSON.stringify(record, null, "\t")}\n`);
		await rename(scratch, path);
	}

	#serial<T>(home: string, work: () => Promise<T>): Promise<T> {
		const run = (this.#tails.get(home) ?? Promise.resolve()).then(work);
		this.#tails.set(
			home,
			run.catch(() => undefined),
		);
		return run;
	}

	// ---- provisioning -------------------------------------------------------------------------------

	/**
	 * The agent id, creating the tool and the agent on first use and PATCHing whichever body changed.
	 * `verify` re-checks the remote even when the stored hashes match (after a call found the agent gone).
	 */
	ensure(args: MintArgs & { readonly verify?: boolean }): Promise<string> {
		return this.#serial(args.home, () => this.#ensure(args));
	}

	async #ensure({ apiKey, home, ttsModel, signal, verify = false }: MintArgs & { verify?: boolean }): Promise<string> {
		const stored = await this.#read(home);
		const wantedTool = toolBody();
		const toolHash = hashOf(wantedTool);

		let toolId = stored?.toolId;
		if (toolId && (stored?.toolHash !== toolHash || verify)) {
			try {
				// The PATCH doubles as the existence check: a deleted tool is a 404.
				await this.#call(apiKey, "PATCH", `/v1/convai/tools/${toolId}`, wantedTool, signal);
			} catch (error) {
				if (!(error instanceof ConvaiHttpError && error.status === 404)) throw error;
				toolId = undefined;
			}
		}
		if (!toolId) {
			const created = await this.#call(apiKey, "POST", "/v1/convai/tools", wantedTool, signal);
			toolId = isRecord(created) && typeof created.id === "string" ? created.id : undefined;
			if (!toolId) throw new Error("ElevenLabs created the delegate tool but returned no id");
			// Keep the new tool before the agent step can fail or be cancelled: the next call must find it, not POST another.
			await this.#write(home, { version: 1, agentId: stored?.agentId ?? "", agentHash: stored?.agentHash ?? "", toolId, toolHash });
		}

		const wantedAgent = agentBody(toolId, ttsModel, DEFAULT_VOICES[0].id);
		const agentHash = hashOf(wantedAgent);
		let agentId = stored?.agentId;
		if (agentId && (stored?.agentHash !== agentHash || verify)) {
			try {
				await this.#call(apiKey, "PATCH", `/v1/convai/agents/${agentId}`, wantedAgent, signal);
			} catch (error) {
				if (!(error instanceof ConvaiHttpError && error.status === 404)) throw error;
				agentId = undefined;
			}
		}
		if (!agentId) {
			const created = await this.#call(apiKey, "POST", "/v1/convai/agents/create", wantedAgent, signal);
			agentId = isRecord(created) && typeof created.agent_id === "string" ? created.agent_id : undefined;
			if (!agentId) throw new Error("ElevenLabs created the live agent but returned no id");
		}

		const record: AgentRecord = { version: 1, agentId, toolId, toolHash, agentHash };
		if (stored?.agentId !== agentId || stored.toolId !== toolId || stored.toolHash !== toolHash || stored.agentHash !== agentHash) {
			await this.#write(home, record);
		}
		return agentId;
	}

	/**
	 * The ids no longer match the account (a socket refused an override the agent should allow): forget
	 * the hashes so the next call re-sends the full body.
	 */
	forget(home: string): Promise<void> {
		return this.#serial(home, async () => {
			const stored = await this.#read(home);
			if (stored) await this.#write(home, { ...stored, toolHash: "", agentHash: "" });
		});
	}

	/**
	 * A fresh signed socket URL for the shared agent (15-minute start window; mint per connect, never
	 * cache). If the agent turns out to be gone (deleted remotely, or the key now belongs to another
	 * account) it is recreated once and the mint retried.
	 */
	async mintSignedUrl(args: MintArgs): Promise<string> {
		const agentId = await this.ensure(args);
		try {
			return await this.#signedUrl(args, agentId);
		} catch (error) {
			if (!(error instanceof ConvaiHttpError && error.status === 404)) throw error;
			return this.#signedUrl(args, await this.ensure({ ...args, verify: true }));
		}
	}

	async #signedUrl({ apiKey, signal }: MintArgs, agentId: string): Promise<string> {
		const body = await this.#call(
			apiKey,
			"GET",
			`/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
			undefined,
			signal,
		);
		const url = isRecord(body) ? body.signed_url : undefined;
		if (typeof url !== "string" || !url.startsWith("wss://")) throw new Error("ElevenLabs returned no signed URL for the live agent");
		return url;
	}

	// ---- readiness ------------------------------------------------------------------------------------

	/**
	 * Whether this key can use Agents: one cheap authorized read, cached per key. A key limited to Text to
	 * Speech answers 401/403 `missing_permissions`. (Only the read scope is probed; the write scope is
	 * proved by the first provisioning call, which names the permission if it is refused.)
	 */
	probe(apiKey: string): Promise<SpeechReadiness> {
		const id = hashOf(apiKey);
		const cached = this.#probes.get(id);
		if (cached && this.#now() - cached.at < (cached.ok ? PROBE_TTL_MS : PROBE_FAILURE_TTL_MS)) return cached.result;
		const entry = { at: this.#now(), ok: false, result: this.#probe(apiKey) };
		this.#probes.set(id, entry);
		void entry.result.then(result => {
			entry.ok = result.ready;
		});
		return entry.result;
	}

	async #probe(apiKey: string): Promise<SpeechReadiness> {
		try {
			await this.#call(apiKey, "GET", "/v1/convai/agents?page_size=1", undefined, undefined);
			return { ready: true };
		} catch (error) {
			if (error instanceof ConvaiHttpError && (error.status === 401 || error.status === 403)) {
				const permissions = error.message.includes(AGENTS_PERMISSION_DETAIL);
				return { ready: false, reason: "needs-key", detail: permissions ? AGENTS_PERMISSION_DETAIL : error.message };
			}
			const why = error instanceof ConvaiHttpError ? error.message : "could not reach ElevenLabs";
			return { ready: false, reason: "unavailable", detail: why };
		}
	}
}
