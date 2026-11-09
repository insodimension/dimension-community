import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "../src/share/hosts";
import { P2pStore } from "../src/share/p2p-store";

const FIRST = { relay: "https://relay.example", tunnelId: "t-1", token: "token-1", baseUrl: "https://relay.example/p/t-1" };
const SECOND = { ...FIRST, tunnelId: "t-2", token: "token-2", baseUrl: "https://relay.example/p/t-2" };
const SHARE_ID = "share-state-0123456789";
const SHARE = { version: 1, prefix: "a", size: 10, mtimeMs: 1, createdAt: 1, manifest: "m" };

let home: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "swiss-share-store-"));
	spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
	mock.restore();
	await rm(home, { recursive: true, force: true });
});

async function filesHolding(secret: string): Promise<string[]> {
	const artifacts = join(home, "artifacts");
	const holding: string[] = [];
	for (const entry of await readdir(artifacts, { withFileTypes: true })) {
		if (entry.isFile() && (await Bun.file(join(artifacts, entry.name)).text()).includes(secret)) holding.push(entry.name);
	}
	return holding;
}

async function artifactNames(): Promise<string[]> {
	return (await readdir(join(home, "artifacts"))).sort();
}

test("a torn tunnel credential is not read, not copied and not backed up: no second file ever holds its token", async () => {
	const store = new P2pStore(home);
	await store.writeTunnel(FIRST);
	await store.writeTunnel(SECOND);
	await writeFile(join(home, "artifacts", "tunnel.json"), '{"relay":');
	expect(await store.readTunnel()).toBeUndefined();
	expect(await artifactNames()).toEqual(["tunnel.json"]);
	expect(await filesHolding(FIRST.token)).toEqual([]);
});

for (const damage of ['{"relay":', '{"relay":"https://relay.example"}']) {
	test(`a write over a tunnel credential damaged to ${damage} replaces it and keeps no copy`, async () => {
		const store = new P2pStore(home);
		await store.writeTunnel(FIRST);
		await writeFile(join(home, "artifacts", "tunnel.json"), damage);
		const third = { ...FIRST, tunnelId: "t-3", token: "token-3" };
		await store.writeTunnel(third);
		expect(await store.readTunnel()).toEqual(third);
		expect(await artifactNames()).toEqual(["tunnel.json"]);
	});
}

test("a write over a tunnel credential deletes the backup and damaged copies an older build left", async () => {
	const store = new P2pStore(home);
	const tunnelPath = join(home, "artifacts", "tunnel.json");
	await store.writeTunnel(FIRST);
	await writeFile(`${tunnelPath}.bak`, JSON.stringify(FIRST));
	await writeFile(`${tunnelPath}.corrupt-k3x9`, JSON.stringify(FIRST));
	await store.writeTunnel(SECOND);
	expect(await artifactNames()).toEqual(["tunnel.json"]);
	expect(await filesHolding(FIRST.token)).toEqual([]);
});

test("a cleared tunnel leaves no file holding its token, backups and damaged copies included", async () => {
	const store = new P2pStore(home);
	const tunnelPath = join(home, "artifacts", "tunnel.json");
	await store.writeTunnel(FIRST);
	await writeFile(`${tunnelPath}.bak`, JSON.stringify(FIRST));
	await writeFile(`${tunnelPath}.corrupt-k3x9`, JSON.stringify(FIRST));
	await store.clearTunnel();
	expect(await store.readTunnel()).toBeUndefined();
	expect(await artifactNames()).toEqual([]);
});

const SELF_HOST = { id: "home-server", kind: "self", name: "Home server", baseUrl: "https://share.example", token: "host-token-1" } as const;

test("a removed server never comes back after the hosts file tears, and no file keeps its token", async () => {
	const store = new HostStore(home);
	await store.add(SELF_HOST);
	await store.add({ ...SELF_HOST, id: "office", name: "Office", baseUrl: "https://office.example", token: "host-token-2" });
	await store.remove(SELF_HOST.id);
	expect(await filesHolding(SELF_HOST.token)).toEqual([]);
	await writeFile(join(home, "artifacts", "hosts.json"), '{"hosts": [');
	await expect(store.read()).rejects.toThrow("has no readable backup");
	expect(await artifactNames()).toEqual(["hosts.json"]);
	expect(await filesHolding(SELF_HOST.token)).toEqual([]);
});

test("a server whose token is replaced keeps no copy of the old token", async () => {
	const store = new HostStore(home);
	await store.add(SELF_HOST);
	await store.add({ ...SELF_HOST, token: "host-token-new" });
	expect((await store.read()).hosts.map(host => host.token)).toEqual(["host-token-new"]);
	expect(await filesHolding(SELF_HOST.token)).toEqual([]);
});

test("a cleared tunnel and a removed share stay gone: their backups go with them", async () => {
	const store = new P2pStore(home);
	await store.writeTunnel(FIRST);
	await store.writeTunnel(SECOND);
	await store.clearTunnel();
	expect(await store.readTunnel()).toBeUndefined();

	await store.writeShare(SHARE_ID, SHARE);
	await store.writeShare(SHARE_ID, { ...SHARE, version: 2 });
	await store.removeShare(SHARE_ID);
	expect(await store.readShare(SHARE_ID)).toBeUndefined();
	expect(await store.shareIds()).toEqual([]);
});

test("a hosts file that is unreadable with no backup is refused, never replaced by an empty list", async () => {
	const path = join(home, "artifacts", "hosts.json");
	await mkdir(join(home, "artifacts"), { recursive: true });
	await writeFile(path, '{"hosts": [');
	await expect(new HostStore(home).read()).rejects.toThrow("has no readable backup");
	expect(await Bun.file(path).text()).toBe('{"hosts": [');
});
