import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type } from "arktype";

export const PROVIDERS = ["beehiiv", "kit", "buttondown", "ghost"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const PROVIDER_LABEL: Readonly<Record<ProviderId, string>> = {
	beehiiv: "beehiiv",
	kit: "Kit",
	buttondown: "Buttondown",
	ghost: "Ghost",
};

const keyCredential = type({ access: "string > 0" });
const beehiivCredential = type({ access: "string > 0", "publicationId?": "string" });
const ghostCredential = type({ access: /^[0-9a-f]+:[0-9a-f]+$/i, url: /^https?:\/\/\S+$/ });

export type KeyCredential = typeof keyCredential.infer;
export type BeehiivCredential = typeof beehiivCredential.infer;
export type GhostCredential = typeof ghostCredential.infer;

export interface CredentialOf {
	beehiiv: BeehiivCredential;
	kit: KeyCredential;
	buttondown: KeyCredential;
	ghost: GhostCredential;
}

const SCHEMA = {
	beehiiv: beehiivCredential,
	kit: keyCredential,
	buttondown: keyCredential,
	ghost: ghostCredential,
} as const;

export function configPath(id: ProviderId): string {
	return join(homedir(), ".config", "dimension-newsletter", `${id}.json`);
}

export function connectPath(id: ProviderId): string {
	return `Plugins, Newsletter, Connect, ${PROVIDER_LABEL[id]}`;
}

export function connectedProviders(): ProviderId[] {
	return PROVIDERS.filter(id => existsSync(configPath(id)));
}

export function isProviderId(value: unknown): value is ProviderId {
	return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

export function resolveProvider(requested: string | undefined): ProviderId {
	const connected = connectedProviders();
	if (requested !== undefined && requested !== "") {
		if (!isProviderId(requested)) {
			throw new Error(
				`"${requested}" is not a provider this plugin connects to (beehiiv, kit, buttondown, ghost). Substack has no API for drafts or stats: hand the person the text to paste, and read Substack numbers from its stats pages.`,
			);
		}
		if (!connected.includes(requested)) {
			throw new Error(`${PROVIDER_LABEL[requested]} is not connected. The person connects it under ${connectPath(requested)}.`);
		}
		return requested;
	}
	if (connected.length === 1 && connected[0] !== undefined) return connected[0];
	if (connected.length === 0) {
		throw new Error(
			"No newsletter provider is connected. The person connects one under Plugins, Newsletter, Connect (beehiiv, Kit, Buttondown or Ghost). A Substack newsletter has no API: hand the person the text to paste.",
		);
	}
	throw new Error(
		`Several providers are connected (${connected.map(id => PROVIDER_LABEL[id]).join(", ")}). Pass provider: one of ${connected.join(", ")}.`,
	);
}

export async function readCredential<P extends ProviderId>(id: P): Promise<CredentialOf[P]> {
	let raw: string;
	try {
		raw = await readFile(configPath(id), "utf8");
	} catch {
		throw new Error(`${PROVIDER_LABEL[id]} is not connected. The person connects it under ${connectPath(id)}.`);
	}
	let json: unknown = null;
	try {
		json = JSON.parse(raw);
	} catch {
		json = null;
	}
	const trimmed =
		typeof json === "object" && json !== null
			? Object.fromEntries(Object.entries(json).map(([key, value]) => [key, typeof value === "string" ? value.trim() : value]))
			: json;
	const parsed = SCHEMA[id](trimmed);
	if (parsed instanceof type.errors) {
		throw new Error(`The saved ${PROVIDER_LABEL[id]} key is unreadable. Reconnect under ${connectPath(id)}.`);
	}
	return parsed as CredentialOf[P];
}
