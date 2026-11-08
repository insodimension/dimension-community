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

test("a torn tunnel credential is read from the copy the last write kept, and the torn bytes are kept beside it", async () => {
	const store = new P2pStore(home);
	await store.writeTunnel(FIRST);
	await store.writeTunnel(SECOND);
	await writeFile(join(home, "artifacts", "tunnel.json"), '{"relay":');
	expect(await store.readTunnel()).toEqual(FIRST);
	expect((await readdir(join(home, "artifacts"))).filter(name => name.startsWith("tunnel.json.corrupt-"))).toHaveLength(1);
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
