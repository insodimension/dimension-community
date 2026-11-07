import { execFileSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

export const SHELF_SCRIPTS = [
	"build-index.ts",
	"pack-archive.mjs",
	"pack-manifest.mjs",
	"publish-pack-releases.mjs",
	"shelf-release.mjs",
	"space-showcase.mjs",
	"validate-marketplace.mjs",
];

const shelfDependencies = resolve(import.meta.dir, "..", "..", "node_modules");

export function git(root: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
}

export function initGitShelf(root: string): void {
	git(root, "init", "--quiet");
	git(root, "config", "core.autocrlf", "false");
	symlinkSync(shelfDependencies, join(root, "node_modules"), "junction");
}
