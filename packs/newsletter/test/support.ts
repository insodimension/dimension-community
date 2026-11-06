import { afterAll, afterEach } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import newsletterExtension from "../index";

export const packRoot = join(import.meta.dir, "..");
export const manifest = JSON.parse(await readFile(join(packRoot, "plugin.json"), "utf8"));
export const dimension = manifest.extensions["ai.insodimension.dimension"];

export function useTempHome(): string {
	const home = join(tmpdir(), `dimension-newsletter-${process.pid}-${Math.random().toString(36).slice(2)}`);
	const priorHome = process.env.HOME;
	const priorUserProfile = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	const configDir = join(home, ".config", "dimension-newsletter");
	const realFetch = globalThis.fetch;
	afterEach(async () => {
		globalThis.fetch = realFetch;
		await rm(configDir, { recursive: true, force: true });
	});
	afterAll(async () => {
		if (priorHome === undefined) delete process.env.HOME;
		else process.env.HOME = priorHome;
		if (priorUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = priorUserProfile;
		await rm(home, { recursive: true, force: true });
	});
	return configDir;
}

export async function connect(provider: string, values: Record<string, string>): Promise<void> {
	const configDir = join(homedir(), ".config", "dimension-newsletter");
	const template = await readFile(join(packRoot, "connect", `${provider}.template.json`), "utf8");
	const rendered = template.replace(/\$\{(\w+)\}/g, (_, field: string) => JSON.stringify(values[field] ?? "").slice(1, -1));
	await mkdir(configDir, { recursive: true });
	await writeFile(join(configDir, `${provider}.json`), rendered);
}

export interface Sent {
	readonly url: string;
	readonly method: string;
	readonly headers: Record<string, string>;
	readonly body: unknown;
}

export function stubFetch(answer: (request: Sent) => Response): Sent[] {
	const sent: Sent[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const request: Sent = {
			url: String(input),
			method: init?.method ?? "GET",
			headers: Object.fromEntries(new Headers(init?.headers).entries()),
			body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
		};
		sent.push(request);
		return answer(request);
	}) as typeof fetch;
	return sent;
}

export interface RegisteredTool {
	name: string;
	approval?: unknown;
	formatApprovalDetails?: (args: unknown) => string[];
	execute: (id: string, params: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

const tools = new Map<string, RegisteredTool>();
newsletterExtension({
	registerTool(tool: RegisteredTool) {
		tools.set(tool.name, tool);
	},
} as unknown as Parameters<typeof newsletterExtension>[0]);

export function tool(name: string): RegisteredTool {
	const found = tools.get(name);
	if (!found) throw new Error(`newsletter did not register ${name}`);
	return found;
}

export async function run(name: string, params: unknown): Promise<string> {
	const result = await tool(name).execute("call-1", params);
	return result.content.map(part => part.text).join("\n");
}

export const registeredNames = [...tools.keys()];
