import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPackArchives } from "./pack-archive.mjs";
import { packArchiveName, packReleaseTag, packReleaseUrl, SHELF_REPO } from "./shelf-release.mjs";
import { shelfPackDir } from "./space-showcase.mjs";

const GITHUB_API_VERSION = "2022-11-28";
const SHA256_DIGEST_PREFIX = "sha256:";
const GITHUB_UPLOADS_HOST = "uploads.github.com";

class GitHubError extends Error {
	constructor(method, url, status, text) {
		super(`${method} ${url} answered HTTP ${status}: ${text.slice(0, 300)}`);
		this.status = status;
	}
}

function githubClient(api, token) {
	const tokenHosts = new Set([new URL(api).host, GITHUB_UPLOADS_HOST]);
	const tokenUrl = url => {
		const { host } = new URL(url);
		if (!tokenHosts.has(host)) throw new Error(`GitHub answered with ${url}, whose host ${host} is not ${[...tokenHosts].join(" or ")}; the token is never sent there`);
		return url;
	};
	const headers = {
		accept: "application/vnd.github+json",
		authorization: `Bearer ${token}`,
		"x-github-api-version": GITHUB_API_VERSION,
		"user-agent": `${SHELF_REPO}-pack-releases`,
	};
	async function call(method, url, { body, contentType } = {}) {
		const response = await fetch(tokenUrl(url), {
			method,
			headers: contentType ? { ...headers, "content-type": contentType } : headers,
			body: contentType === "application/json" ? JSON.stringify(body) : body,
		});
		if (!response.ok) throw new GitHubError(method, url, response.status, await response.text());
		return response.json();
	}
	return {
		async releaseByTag(tag) {
			try {
				return await call("GET", `${api}/repos/${SHELF_REPO}/releases/tags/${encodeURIComponent(tag)}`);
			} catch (error) {
				if (error instanceof GitHubError && error.status === 404) return undefined;
				throw error;
			}
		},
		createRelease(release) {
			return call("POST", `${api}/repos/${SHELF_REPO}/releases`, { body: release, contentType: "application/json" });
		},
		uploadAsset(release, name, bytes) {
			const uploadUrl = String(release.upload_url).replace(/\{.*\}$/, "");
			return call("POST", `${uploadUrl}?name=${encodeURIComponent(name)}`, { body: bytes, contentType: "application/gzip" });
		},
		async assetSha256(asset) {
			if (typeof asset.digest === "string" && asset.digest.startsWith(SHA256_DIGEST_PREFIX)) {
				return asset.digest.slice(SHA256_DIGEST_PREFIX.length);
			}
			const first = await fetch(tokenUrl(asset.url), { headers: { ...headers, accept: "application/octet-stream" }, redirect: "manual" });
			const location = first.headers.get("location");
			const response = first.status >= 300 && first.status < 400 && location ? await fetch(location) : first;
			if (!response.ok) throw new GitHubError("GET", asset.url, response.status, await response.text());
			return createHash("sha256").update(new Uint8Array(await response.arrayBuffer())).digest("hex");
		},
	};
}

function shelfBuilds(root, catalog) {
	const builds = [];
	const failures = [];
	for (const entry of catalog.plugins ?? []) {
		if (!shelfPackDir(root, entry)) continue;
		const { name, version, source } = entry;
		if (source.url !== packReleaseUrl(name, version)) {
			failures.push(`${name}: the catalog points at ${source.url}, not this shelf's release build ${packReleaseUrl(name, version)}`);
			continue;
		}
		builds.push({ name, version, sha256: source.sha256, size: source.size, tag: packReleaseTag(name, version), file: packArchiveName(name, version) });
	}
	return { builds, failures };
}

async function publishedAssetProblem(github, build, asset) {
	if (asset.state !== undefined && asset.state !== "uploaded") {
		return `${build.name}: ${build.file} in release ${build.tag} is an unfinished upload (state ${asset.state}); a maintainer deletes that asset by hand so the next run uploads it`;
	}
	const sha256 = await github.assetSha256(asset);
	if (asset.size === build.size && sha256 === build.sha256) return undefined;
	return `${build.name}: release ${build.tag} already holds ${build.file} (sha256 ${sha256}, ${asset.size} bytes) but the catalog says sha256 ${build.sha256}, ${build.size} bytes. A published build is never replaced; bump the pack's version`;
}

async function ensureRelease(github, build, commit) {
	try {
		return await github.createRelease({
			tag_name: build.tag,
			target_commitish: commit,
			name: `${build.name} ${build.version}`,
			body: `Release build of packs/${build.name} ${build.version}.\n\nsha256 ${build.sha256}, ${build.size} bytes.`,
			make_latest: "false",
		});
	} catch (error) {
		if (!(error instanceof GitHubError) || error.status !== 422) throw error;
		const existing = await github.releaseByTag(build.tag);
		if (!existing) throw error;
		return existing;
	}
}

export async function publishPackReleases({ root, catalog, api, token, commit, log = console.log }) {
	const github = githubClient(api, token);
	const { builds, failures } = shelfBuilds(root, catalog);
	const missing = [];
	let present = 0;
	for (const build of builds) {
		const release = await github.releaseByTag(build.tag);
		const asset = release?.assets?.find(candidate => candidate.name === build.file);
		if (!asset) {
			missing.push({ ...build, release });
			continue;
		}
		const problem = await publishedAssetProblem(github, build, asset);
		if (problem) failures.push(problem);
		else present += 1;
	}
	const archives = missing.length > 0 ? buildPackArchives(root, missing.map(build => build.name)) : new Map();
	const published = [];
	for (const build of missing) {
		const archive = archives.get(build.name);
		if (archive.sha256 !== build.sha256 || archive.size !== build.size) {
			failures.push(
				`${build.name}: a fresh build is sha256 ${archive.sha256}, ${archive.size} bytes but the catalog says sha256 ${build.sha256}, ${build.size} bytes; run scripts/build-index.ts. Nothing was uploaded`,
			);
			continue;
		}
		const release = build.release ?? (await ensureRelease(github, build, commit));
		try {
			const asset = await github.uploadAsset(release, build.file, archive.bytes);
			const problem = await publishedAssetProblem(github, build, asset);
			if (problem) failures.push(problem);
			else {
				published.push(build.file);
				log(`published ${build.tag}/${build.file} (sha256 ${build.sha256}, ${build.size} bytes)`);
			}
		} catch (error) {
			if (!(error instanceof GitHubError) || error.status !== 422) throw error;
			const raced = (await github.releaseByTag(build.tag))?.assets?.find(candidate => candidate.name === build.file);
			if (!raced) throw error;
			const problem = await publishedAssetProblem(github, build, raced);
			if (problem) failures.push(problem);
			else present += 1;
		}
	}
	return { published, present, failures };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const token = process.env.GITHUB_TOKEN;
	const commit = process.env.GITHUB_SHA;
	if (!token || !commit) {
		console.error("publish-pack-releases: GITHUB_TOKEN and GITHUB_SHA are required (this runs in CI on a push to main)");
		process.exit(2);
	}
	const catalog = JSON.parse(readFileSync(join(root, ".dimension-plugin", "marketplace.json"), "utf8"));
	let result;
	try {
		result = await publishPackReleases({
			root,
			catalog,
			api: (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, ""),
			token,
			commit,
		});
	} catch (error) {
		console.error(`publish-pack-releases: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
	console.log(`publish-pack-releases: ${result.published.length} published, ${result.present} already published`);
	if (result.failures.length > 0) {
		console.error(`publish-pack-releases: ${result.failures.length} problem(s)\n${result.failures.map(failure => `  - ${failure}`).join("\n")}`);
		process.exit(1);
	}
}
