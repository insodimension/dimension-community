import { execFileSync } from "node:child_process";

export const SHELF_SCRIPTS = [
	"build-index.ts",
	"pack-archive.mjs",
	"pack-manifest.mjs",
	"publish-pack-releases.mjs",
	"space-showcase.mjs",
	"validate-marketplace.mjs",
];

export function git(root: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
}

export function initGitShelf(root: string): void {
	git(root, "init", "--quiet");
	git(root, "config", "core.autocrlf", "false");
}
