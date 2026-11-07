import { existsSync, lstatSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, posix, relative } from "node:path";

export const SHOWCASE_KEYS = ["tagline", "summary", "screenshots", "video", "needs", "onboarding"];
export const SHOWCASE_MAX_SCREENSHOTS = 8;
export const SHOWCASE_MAX_NEEDS = 6;
export const SHOWCASE_IMAGE_EXTENSIONS = [".png", ".webp", ".jpg", ".jpeg", ".svg"];
export const SHOWCASE_VIDEO_EXTENSIONS = [".mp4", ".webm"];
export const SHOWCASE_VIDEO_MAX_BYTES = 48 * 1024 * 1024;
export const RELEASE_MAX_BYTES = 256 * 1024 * 1024;
export const RETIRED_LISTING_FIELDS = ["tagline", "screenshots"];

const SHA256 = /^[0-9a-f]{64}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = value => typeof value === "string" && value.trim().length > 0;

export function isReleaseSource(source) {
	return isRecord(source) && source.source === "release";
}

export function shelfPackDir(root, plugin) {
	if (typeof plugin.name !== "string" || !/^[a-z0-9-]+$/.test(plugin.name) || plugin.source !== `./packs/${plugin.name}`) return undefined;
	const packDir = join(root, "packs", plugin.name);
	return existsSync(join(packDir, "package.json")) ? packDir : undefined;
}

export function releaseSourceProblems(label, plugin, field = "source") {
	const source = plugin[field];
	const problems = [];
	if (!isText(plugin.version)) problems.push(`plugin "${label}": a release entry must state its version`);
	let url;
	try {
		url = new URL(String(source.url));
	} catch {
		problems.push(`plugin "${label}": ${field}.url must be an absolute URL`);
	}
	if (url && url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
		problems.push(`plugin "${label}": ${field}.url must be https (http only for a loopback host)`);
	}
	if (typeof source.sha256 !== "string" || !SHA256.test(source.sha256)) {
		problems.push(`plugin "${label}": ${field}.sha256 must be 64 lowercase hex characters`);
	}
	if (!Number.isSafeInteger(source.size) || source.size <= 0 || source.size > RELEASE_MAX_BYTES) {
		problems.push(`plugin "${label}": ${field}.size must be a whole number of bytes between 1 and ${RELEASE_MAX_BYTES}`);
	}
	return problems;
}

function shelfFileProblem(root, path, extensions, what, maxBytes) {
	if (!isText(path)) return `${what} must be a non-empty string`;
	if (path.startsWith("data:")) {
		return extensions === SHOWCASE_IMAGE_EXTENSIONS && path.startsWith("data:image/")
			? undefined
			: `${what} cannot be a data-URI`;
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("/") || path.startsWith("\\")) {
		return `${what} "${path}" must be a shelf-relative path, not a URL or an absolute path`;
	}
	const normalized = posix.normalize(path.replaceAll("\\", "/"));
	if (normalized === ".." || normalized.startsWith("../")) return `${what} "${path}" leaves the shelf`;
	const extension = extname(normalized).toLowerCase();
	if (!extensions.includes(extension)) return `${what} "${path}" must be one of ${extensions.join(", ")}`;
	const file = join(root, normalized);
	const entry = lstatSync(file, { throwIfNoEntry: false });
	if (!entry) return `${what} "${path}" does not exist in the shelf`;
	if (entry.isSymbolicLink()) return `${what} "${path}" is a symlink; commit the file itself`;
	if (!entry.isFile()) return `${what} "${path}" does not exist in the shelf`;
	const inShelf = relative(realpathSync(root), realpathSync(file));
	if (inShelf === "" || inShelf.startsWith("..") || isAbsolute(inShelf)) return `${what} "${path}" leaves the shelf`;
	if (maxBytes !== undefined && entry.size > maxBytes) {
		return `${what} "${path}" is ${entry.size} bytes, over the ${maxBytes}-byte cap`;
	}
	return undefined;
}

function showcaseProblems(root, where, showcase) {
	if (!isRecord(showcase)) return [`${where}.showcase must be an object`];
	const problems = [];
	for (const key of Object.keys(showcase)) {
		if (!SHOWCASE_KEYS.includes(key)) problems.push(`${where}.showcase.${key} is not a showcase field`);
	}
	for (const key of ["tagline", "summary", "onboarding"]) {
		if (showcase[key] !== undefined && !isText(showcase[key])) {
			problems.push(`${where}.showcase.${key} must be a non-empty string`);
		}
	}
	const { screenshots, needs, video } = showcase;
	if (screenshots !== undefined) {
		if (!Array.isArray(screenshots) || screenshots.length === 0) {
			problems.push(`${where}.showcase.screenshots must be a non-empty array`);
		} else {
			if (screenshots.length > SHOWCASE_MAX_SCREENSHOTS) {
				problems.push(`${where}.showcase.screenshots holds ${screenshots.length}; at most ${SHOWCASE_MAX_SCREENSHOTS}`);
			}
			screenshots.forEach((shot, index) => {
				const problem = shelfFileProblem(root, shot, SHOWCASE_IMAGE_EXTENSIONS, `${where}.showcase.screenshots[${index}]`);
				if (problem) problems.push(problem);
			});
		}
	}
	if (needs !== undefined && (!Array.isArray(needs) || needs.length > SHOWCASE_MAX_NEEDS || !needs.every(isText))) {
		problems.push(`${where}.showcase.needs must be at most ${SHOWCASE_MAX_NEEDS} non-empty strings`);
	}
	if (video !== undefined) {
		if (!isRecord(video)) {
			problems.push(`${where}.showcase.video must be an object { src, poster? }`);
		} else {
			const src = shelfFileProblem(root, video.src, SHOWCASE_VIDEO_EXTENSIONS, `${where}.showcase.video.src`, SHOWCASE_VIDEO_MAX_BYTES);
			if (src) problems.push(src);
			if (video.poster !== undefined) {
				const poster = shelfFileProblem(root, video.poster, SHOWCASE_IMAGE_EXTENSIONS, `${where}.showcase.video.poster`);
				if (poster) problems.push(poster);
			}
		}
	}
	return problems;
}

export function spaceListingProblems(root, label, plugin) {
	const release = isReleaseSource(plugin.source);
	if (release && (!Array.isArray(plugin.spaces) || plugin.spaces.length === 0)) {
		return [`plugin "${label}": a release entry must list the space it installs`];
	}
	if (plugin.spaces === undefined) return [];
	if (!Array.isArray(plugin.spaces)) return [`plugin "${label}": spaces must be an array`];
	const problems = [];
	for (const listing of plugin.spaces) {
		const where = `plugin "${label}": space "${listing?.id ?? "<no id>"}"`;
		if (!isRecord(listing) || !isText(listing.id) || !isText(listing.label)) {
			problems.push(`${where} needs an id and a label`);
			continue;
		}
		for (const field of RETIRED_LISTING_FIELDS) {
			if (listing[field] !== undefined) problems.push(`${where} carries the retired ${field}; it lives in showcase.${field}`);
		}
		if (listing.showcase !== undefined) problems.push(...showcaseProblems(root, where, listing.showcase));
		if (release) {
			const showcase = isRecord(listing.showcase) ? listing.showcase : {};
			if (!isText(showcase.summary)) problems.push(`${where}: a release listing must carry showcase.summary`);
			if (!Array.isArray(showcase.screenshots) || showcase.screenshots.length === 0) {
				problems.push(`${where}: a release listing must carry at least one showcase screenshot`);
			}
			if (!isRecord(showcase.video)) problems.push(`${where}: a release listing must carry a showcase video`);
		}
	}
	return problems;
}
