import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const SHELF_REPO = "insodimension/dimension-community";
export const SHELF_REPOSITORY = `https://github.com/${SHELF_REPO}`;
const SHELF_RELEASES_PREFIX = `${SHELF_REPOSITORY}/releases/download/`;

export const packReleaseTag = (name, version) => `${name}-v${version}`;
export const packArchiveName = (name, version) => `${name}-${version}.tgz`;
export const packReleaseUrl = (name, version) =>
	`${SHELF_RELEASES_PREFIX}${packReleaseTag(name, version)}/${packArchiveName(name, version)}`;

export function packDirectories(root) {
	const packsDir = join(root, "packs");
	if (!existsSync(packsDir)) return [];
	return readdirSync(packsDir)
		.filter(dir => statSync(join(packsDir, dir)).isDirectory() && existsSync(join(packsDir, dir, "package.json")))
		.sort();
}
