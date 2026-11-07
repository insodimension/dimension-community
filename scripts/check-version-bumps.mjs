#!/usr/bin/env bun
// A pack whose shipped files changed must bump its version.
//
// A host caches an installed pack by `<marketplace>__<name>__<version>` and never
// re-fetches a version it already holds. A change that ships under the SAME
// version therefore never reaches anyone who installed it before: their Browser
// pack kept the old app/server.mjs after dimension-community#119 until they
// uninstalled and reinstalled (Traction Night friction #63). This check compares
// every pack against the base it will merge into and refuses a changed pack whose
// package.json version is unchanged.
//
// The same walk holds the README rule (docs/plugins/authoring.md, "Document it:
// README.md", in the Dimension repository): the details page in Capabilities shows
// a plugin's README.md, so a pack that is NEW against the base must ship one at its
// root or the check fails. A pack that already existed and still has none only
// prints a warning: the shelf is being brought up to the standard one pack at a time.
//
// Usage: bun scripts/check-version-bumps.mjs [baseRef]   (default: origin/main)

import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", windowsHide: true }).trim();
const base = process.argv[2] ?? process.env.BASE_REF ?? "origin/main";
const mergeBase = git("merge-base", base, "HEAD");

const changedByPack = new Map();
for (const file of git("diff", "--name-only", `${mergeBase}...HEAD`, "--", "packs").split("\n")) {
	const match = /^packs\/([^/]+)\/(.+)$/.exec(file);
	if (!match) continue;
	const [, pack, rest] = match;
	changedByPack.set(pack, [...(changedByPack.get(pack) ?? []), rest]);
}

const versionAt = (ref, pack) => {
	try {
		return JSON.parse(git("show", `${ref}:packs/${pack}/package.json`)).version;
	} catch {
		return undefined; // the pack (or its package.json) does not exist there
	}
};

// A README.md at the pack root, in any case: the engine finds it case-insensitively.
const hasReadmeAt = (ref, pack) =>
	git("ls-tree", "--name-only", ref, `packs/${pack}/`)
		.split("\n")
		.some(entry => /^README\.md$/i.test(entry.slice(entry.lastIndexOf("/") + 1)));

const failures = [];
const warnings = [];
for (const [pack, files] of changedByPack) {
	const before = versionAt(mergeBase, pack);
	const after = versionAt("HEAD", pack);
	if (after === undefined) continue; // removed pack
	if (!hasReadmeAt("HEAD", pack)) {
		const needs = `packs/${pack} has no README.md at its root (see "Document it: README.md" in docs/plugins/authoring.md in the Dimension repository)`;
		if (before === undefined) failures.push(`${needs}. A new pack must ship one.`);
		else warnings.push(`${needs}.`);
	}
	if (before === undefined) continue; // added pack
	if (before === after) failures.push(`packs/${pack}: ${files.length} shipped file(s) changed but the version is still ${after} (e.g. ${files[0]}). Bump package.json and plugin.json, then run scripts/build-index.ts.`);
}

const releasesAt = ref => {
	let catalog;
	try {
		catalog = JSON.parse(git("show", `${ref}:.dimension-plugin/marketplace.json`));
	} catch {
		return new Map();
	}
	return new Map((catalog.plugins ?? []).filter(entry => entry.release).map(entry => [entry.name, entry]));
};
const publishedBefore = releasesAt(mergeBase);
for (const [name, entry] of releasesAt("HEAD")) {
	const before = publishedBefore.get(name);
	if (!before || before.version !== entry.version || before.release.url !== entry.release.url) continue;
	if (before.release.sha256 !== entry.release.sha256 || before.release.size !== entry.release.size) {
		failures.push(`${name}: the release build of ${entry.version} changed (sha256 ${before.release.sha256}, ${before.release.size} bytes → sha256 ${entry.release.sha256}, ${entry.release.size} bytes) but its version did not. A published build is never replaced: bump the pack's version.`);
	}
}

for (const warning of warnings) console.warn(`check-version-bumps: warning: ${warning}`);

if (failures.length > 0) {
	console.error(`check-version-bumps: against ${base} (${mergeBase.slice(0, 8)})\n${failures.join("\n")}`);
	process.exit(1);
}
console.log(`check-version-bumps: ${changedByPack.size} changed pack(s) against ${base}, all bumped`);
