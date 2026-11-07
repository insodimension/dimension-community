export const SHELF_REPO = "insodimension/dimension-community";
export const SHELF_REPOSITORY = `https://github.com/${SHELF_REPO}`;
export const SHELF_RELEASES_PREFIX = `${SHELF_REPOSITORY}/releases/download/`;

export const packReleaseTag = (name, version) => `${name}-v${version}`;
export const packArchiveName = (name, version) => `${name}-${version}.tgz`;
export const packReleaseUrl = (name, version) =>
	`${SHELF_RELEASES_PREFIX}${packReleaseTag(name, version)}/${packArchiveName(name, version)}`;
