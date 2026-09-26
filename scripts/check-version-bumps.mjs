#!/usr/bin/env bun
// A pack whose shipped files changed must bump its version.
//
// A host caches an installed pack by `<marketplace>__<name>__<version>` and never
// re-fetches a version it already holds. A change that ships under the SAME
// version therefore never reaches anyone who installed it before: their Browser
// pack kept the old app/server.mjs after dimension-community#119 until they
// uninstalled and reinstalled (Traction Night friction #63). This check compares
// every pack against the base it will merge into and refuses a changed pack whose
// package.json version is unchanged. Tests are not shipped, so test/ is exempt.
//
// Usage: bun scripts/check-version-bumps.mjs [baseRef]   (default: origin/main)

import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const base = process.argv[2] ?? process.env.BASE_REF ?? "origin/main";
const mergeBase = git("merge-base", base, "HEAD");

const changedByPack = new Map();
for (const file of git("diff", "--name-only", `${mergeBase}...HEAD`, "--", "packs").split("\n")) {
	const match = /^packs\/([^/]+)\/(.+)$/.exec(file);
	if (!match) continue;
	const [, pack, rest] = match;
	if (rest.startsWith("test/")) continue;
	changedByPack.set(pack, [...(changedByPack.get(pack) ?? []), rest]);
}

const versionAt = (ref, pack) => {
	try {
		return JSON.parse(git("show", `${ref}:packs/${pack}/package.json`)).version;
	} catch {
		return undefined; // the pack (or its package.json) does not exist there
	}
};

const failures = [];
for (const [pack, files] of changedByPack) {
	const before = versionAt(mergeBase, pack);
	const after = versionAt("HEAD", pack);
	if (before === undefined || after === undefined) continue; // added or removed pack
	if (before === after) failures.push(`packs/${pack}: ${files.length} shipped file(s) changed but the version is still ${after} (e.g. ${files[0]}). Bump package.json and plugin.json, then run scripts/build-index.ts.`);
}

if (failures.length > 0) {
	console.error(`check-version-bumps: against ${base} (${mergeBase.slice(0, 8)})\n${failures.join("\n")}`);
	process.exit(1);
}
console.log(`check-version-bumps: ${changedByPack.size} changed pack(s) against ${base}, all bumped`);
