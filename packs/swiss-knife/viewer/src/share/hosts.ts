import { join } from "node:path";
import { z } from "zod";
import { readJsonFile, writePrivateJsonFile } from "./fs-json";

export const DEFAULT_RELAY_URL = "https://share.insodimension.ai";
export const P2P_HOST_ID = "p2p";
export const CLOUD_HOST_ID = "cloud";
export const HOST_KINDS = ["self", "company", "dimension"] as const;
export type HostKind = (typeof HOST_KINDS)[number];

const HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

const storedHostSchema = z.looseObject({
	id: z
		.string()
		.regex(HOST_ID_PATTERN)
		.refine(id => id !== P2P_HOST_ID && id !== CLOUD_HOST_ID, "p2p and cloud are reserved"),
	kind: z.enum(HOST_KINDS),
	name: z.string().min(1).max(120),
	baseUrl: z.string().min(1).max(2048),
	token: z.string().min(1).max(512).optional(),
	managed: z.boolean().optional(),
});
export type StoredHost = z.infer<typeof storedHostSchema>;

const hostsFileSchema = z.looseObject({
	relay: z.string().min(1).max(2048).optional(),
	displayName: z.string().trim().min(1).max(80).optional(),
	policy: z.looseObject({ only: z.array(z.string()).optional(), p2p: z.boolean().optional() }).optional(),
	hosts: z.array(storedHostSchema).default([]),
});
export type HostsFile = z.infer<typeof hostsFileSchema>;

export class HostConfigError extends Error {
	override readonly name = "HostConfigError";
}

export function normalizeBaseUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new HostConfigError(`"${raw}" is not a web address`);
	}
	const loopback = LOOPBACK_HOSTS.includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new HostConfigError("a share server must be reached over https (plain http is only accepted for this computer)");
	}
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export interface Pairing {
	readonly baseUrl: string;
	readonly token: string;
}

export function parsePairingLink(link: string): Pairing {
	let url: URL;
	try {
		url = new URL(link.trim());
	} catch {
		throw new HostConfigError("that is not a pairing link (expected https://<your server>/pair#t=<token>)");
	}
	const token = new URLSearchParams(url.hash.replace(/^#/, "")).get("t");
	const prefix = url.pathname.replace(/\/pair\/?$/, "");
	if (token === null || token === "" || prefix === url.pathname) {
		throw new HostConfigError("that is not a pairing link (expected https://<your server>/pair#t=<token>)");
	}
	return { baseUrl: normalizeBaseUrl(`${url.origin}${prefix}`), token };
}

export function relayUrlOf(file: HostsFile): string {
	return normalizeBaseUrl(file.relay ?? DEFAULT_RELAY_URL);
}

export function p2pAllowed(file: HostsFile): boolean {
	return file.policy?.p2p ?? file.policy?.only === undefined;
}

export function cloudAllowed(file: HostsFile): boolean {
	const only = file.policy?.only;
	return file.policy?.p2p !== false && (only === undefined || only.includes(CLOUD_HOST_ID));
}

export function visibleHosts(file: HostsFile): readonly StoredHost[] {
	const only = file.policy?.only;
	return only === undefined ? file.hosts : file.hosts.filter(host => only.includes(host.id));
}

export function additionRefusal(file: HostsFile): string | undefined {
	return file.policy?.only === undefined ? undefined : "your administrator limits sharing to approved servers, so another one cannot be added here";
}

export class HostStore {
	readonly path: string;
	#queue: Promise<unknown> = Promise.resolve();

	constructor(home: string) {
		this.path = join(home, "artifacts", "hosts.json");
	}

	async read(): Promise<HostsFile> {
		return (await readJsonFile(this.path, hostsFileSchema)) ?? { hosts: [] };
	}

	#update<T>(change: (file: HostsFile) => { readonly file: HostsFile; readonly result: T }): Promise<T> {
		const run = this.#queue.then(async () => {
			const { file, result } = change(await this.read());
			await writePrivateJsonFile(this.path, hostsFileSchema, file);
			return result;
		});
		this.#queue = run.catch(() => undefined);
		return run;
	}

	add(host: StoredHost): Promise<StoredHost> {
		return this.#update(file => {
			const refusal = additionRefusal(file);
			if (refusal !== undefined) throw new HostConfigError(refusal);
			const existing = file.hosts.find(entry => entry.baseUrl === host.baseUrl);
			if (existing?.managed === true) throw new HostConfigError("that server is managed by your administrator and is already available");
			const stored = existing === undefined ? host : { ...existing, kind: host.kind, name: host.name, ...(host.token === undefined ? {} : { token: host.token }) };
			const hosts = existing === undefined ? [...file.hosts, stored] : file.hosts.map(entry => (entry.id === existing.id ? stored : entry));
			return { file: { ...file, hosts }, result: stored };
		});
	}

	remove(id: string): Promise<void> {
		return this.#update(file => {
			const host = file.hosts.find(entry => entry.id === id);
			if (host === undefined) throw new HostConfigError("that server is not in your list");
			if (host.managed === true) throw new HostConfigError("that server is managed by your administrator and cannot be removed here");
			return { file: { ...file, hosts: file.hosts.filter(entry => entry.id !== id) }, result: undefined };
		});
	}
}
