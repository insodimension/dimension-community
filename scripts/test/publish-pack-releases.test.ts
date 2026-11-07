import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { initGitShelf, SHELF_SCRIPTS } from "./git-shelf";

type Json = Record<string, unknown>;
type Asset = { id: number; name: string; size: number; state: string; digest?: string; url: string; bytes: Uint8Array };
type Release = { id: number; tag_name: string; target_commitish: string; upload_url: string; assets: Asset[] };

setDefaultTimeout(30_000);

const scriptsDir = resolve(import.meta.dir, "..");
const REPO_PATH = "/repos/insodimension/dimension-community";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const shelves: string[] = [];

afterAll(() => {
	for (const shelf of shelves) rmSync(shelf, { recursive: true, force: true });
});

function writeFile(root: string, path: string, text: string) {
	const file = join(root, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

function writePack(root: string, name: string, version: string, readme: string) {
	writeFile(root, `packs/${name}/package.json`, JSON.stringify({ name, version, description: `The ${name} pack for release tests.` }));
	writeFile(root, `packs/${name}/README.md`, readme);
}

function builtShelf(): string {
	const root = mkdtempSync(join(tmpdir(), "pack-releases-"));
	shelves.push(root);
	initGitShelf(root);
	for (const file of SHELF_SCRIPTS) cpSync(join(scriptsDir, file), join(root, "scripts", file));
	writeFile(root, ".dimension-plugin/marketplace.json", JSON.stringify({ name: "test-shelf", owner: { name: "Tests" }, plugins: [] }));
	writePack(root, "alpha", "1.0.0", "# Alpha\n");
	writePack(root, "beta", "2.1.0", "# Beta\n");
	const built = spawnSync(process.execPath, [join(root, "scripts", "build-index.ts")], { cwd: root, encoding: "utf8" });
	expect(built.status).toBe(0);
	return root;
}

function catalogRelease(root: string, name: string): { url: string; sha256: string; size: number } {
	const catalog = JSON.parse(readFileSync(join(root, ".dimension-plugin/marketplace.json"), "utf8")) as { plugins: Json[] };
	return catalog.plugins.find(plugin => plugin.name === name)?.release as { url: string; sha256: string; size: number };
}

const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fakeGitHub() {
	const releases: Release[] = [];
	const writes: string[] = [];
	let nextId = 1;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const url = new URL(request.url);
			const base = `http://127.0.0.1:${server.port}`;
			const publicAsset = ({ bytes: _bytes, ...asset }: Asset) => asset;
			const publicRelease = (release: Release) => ({ ...release, assets: release.assets.map(publicAsset) });
			if (request.method === "GET" && url.pathname.startsWith(`${REPO_PATH}/releases/tags/`)) {
				const tag = decodeURIComponent(url.pathname.slice(`${REPO_PATH}/releases/tags/`.length));
				const release = releases.find(candidate => candidate.tag_name === tag);
				return release ? Response.json(publicRelease(release)) : Response.json({ message: "Not Found" }, { status: 404 });
			}
			if (request.method === "POST" && url.pathname === `${REPO_PATH}/releases`) {
				const body = (await request.json()) as { tag_name: string; target_commitish: string };
				writes.push(`create ${body.tag_name}`);
				if (releases.some(release => release.tag_name === body.tag_name)) return Response.json({ message: "already_exists" }, { status: 422 });
				const id = nextId++;
				const release = { id, tag_name: body.tag_name, target_commitish: body.target_commitish, upload_url: `${base}/uploads/${id}/assets{?name,label}`, assets: [] };
				releases.push(release);
				return Response.json(publicRelease(release), { status: 201 });
			}
			const upload = /^\/uploads\/(\d+)\/assets$/.exec(url.pathname);
			if (request.method === "POST" && upload) {
				const release = releases.find(candidate => candidate.id === Number(upload[1])) as Release;
				const name = url.searchParams.get("name") as string;
				writes.push(`upload ${release.tag_name}/${name}`);
				if (release.assets.some(asset => asset.name === name)) return Response.json({ message: "already_exists" }, { status: 422 });
				const bytes = new Uint8Array(await request.arrayBuffer());
				const id = nextId++;
				const asset = { id, name, size: bytes.length, state: "uploaded", digest: `sha256:${sha256Of(bytes)}`, url: `${base}/assets/${id}`, bytes };
				release.assets.push(asset);
				return Response.json(publicAsset(asset), { status: 201 });
			}
			const download = /^\/assets\/(\d+)$/.exec(url.pathname);
			const asset = download && releases.flatMap(release => release.assets).find(candidate => candidate.id === Number(download[1]));
			if (request.method === "GET" && asset) return new Response(asset.bytes);
			return Response.json({ message: `unexpected ${request.method} ${url.pathname}` }, { status: 500 });
		},
	});
	const seed = (tag: string, name: string, bytes: Uint8Array) => {
		const id = nextId++;
		releases.push({
			id,
			tag_name: tag,
			target_commitish: "older",
			upload_url: `http://127.0.0.1:${server.port}/uploads/${id}/assets{?name,label}`,
			assets: [{ id: nextId, name, size: bytes.length, state: "uploaded", url: `http://127.0.0.1:${server.port}/assets/${nextId++}`, bytes }],
		});
	};
	return { server, releases, writes, seed };
}

async function publish(root: string, api: string) {
	const child = Bun.spawn([process.execPath, join(root, "scripts", "publish-pack-releases.mjs")], {
		cwd: root,
		env: { ...process.env, GITHUB_API_URL: api, GITHUB_TOKEN: "test-token", GITHUB_SHA: COMMIT },
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	return { status, output: `${stdout}${stderr}` };
}

describe("publishing release builds from main", () => {
	test("each missing build is published once at the merged commit, with the catalog's bytes, and a second run changes nothing", async () => {
		const root = builtShelf();
		const github = fakeGitHub();
		try {
			const first = await publish(root, github.server.url.origin);
			expect(first).toMatchObject({ status: 0 });
			expect(github.releases.map(release => [release.tag_name, release.target_commitish, release.assets.map(asset => asset.name)])).toEqual([
				["alpha-v1.0.0", COMMIT, ["alpha-1.0.0.tgz"]],
				["beta-v2.1.0", COMMIT, ["beta-2.1.0.tgz"]],
			]);
			for (const [name, release] of [["alpha", github.releases[0]], ["beta", github.releases[1]]] as const) {
				const build = catalogRelease(root, name);
				expect(build.url.endsWith(`/releases/download/${release.tag_name}/${release.assets[0].name}`)).toBeTrue();
				expect(sha256Of(release.assets[0].bytes)).toBe(build.sha256);
				expect(release.assets[0].size).toBe(build.size);
			}
			const writesAfterFirst = github.writes.length;

			const second = await publish(root, github.server.url.origin);
			expect(second.status).toBe(0);
			expect(second.output).toContain("0 published, 2 already published");
			expect(github.writes.length).toBe(writesAfterFirst);
		} finally {
			github.server.stop(true);
		}
	});

	test("a published build whose bytes differ from the catalog fails loudly and is never replaced", async () => {
		const root = builtShelf();
		const github = fakeGitHub();
		const impostor = new TextEncoder().encode("not the build the catalog pins");
		github.seed("alpha-v1.0.0", "alpha-1.0.0.tgz", impostor);
		try {
			const result = await publish(root, github.server.url.origin);

			expect(result.status).toBe(1);
			expect(result.output).toContain("alpha: release alpha-v1.0.0 already holds alpha-1.0.0.tgz");
			expect(github.writes).toEqual(["create beta-v2.1.0", "upload beta-v2.1.0/beta-2.1.0.tgz"]);
			expect(github.releases[0].assets.map(asset => asset.bytes)).toEqual([impostor]);
		} finally {
			github.server.stop(true);
		}
	});

	test("a pack edited after the catalog was built is not uploaded", async () => {
		const root = builtShelf();
		writeFile(root, "packs/beta/README.md", "# Beta, edited after the catalog\n");
		const github = fakeGitHub();
		try {
			const result = await publish(root, github.server.url.origin);

			expect(result.status).toBe(1);
			expect(result.output).toContain("beta: a fresh build is sha256");
			expect(github.writes).toEqual(["create alpha-v1.0.0", "upload alpha-v1.0.0/alpha-1.0.0.tgz"]);
		} finally {
			github.server.stop(true);
		}
	});

	test("an upload url on a host other than the API's is refused before the token is sent", async () => {
		const root = builtShelf();
		const github = fakeGitHub();
		const elsewhere: string[] = [];
		const stranger = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(request) {
				elsewhere.push(`${request.method} ${new URL(request.url).pathname} ${request.headers.get("authorization")}`);
				return Response.json({}, { status: 201 });
			},
		});
		github.releases.push({ id: 900, tag_name: "alpha-v1.0.0", target_commitish: "older", upload_url: `${stranger.url.origin}/uploads/900/assets{?name,label}`, assets: [] });
		try {
			const result = await publish(root, github.server.url.origin);

			expect(result.status).toBe(1);
			expect(result.output).toContain(`whose host ${stranger.url.host} is not ${github.server.url.host} or uploads.github.com`);
			expect(elsewhere).toEqual([]);
		} finally {
			stranger.stop(true);
			github.server.stop(true);
		}
	});
});
