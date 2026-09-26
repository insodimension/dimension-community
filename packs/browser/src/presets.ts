/**
 * Publish presets — named, tested recipes shipped as data in `recipes/`.
 *
 * A preset is a recipe without values: the site's origin, where to compose
 * (a fixed `composeUrl`, or the caller's `target` page on the origin), the
 * signed-in marker, labelled fields, the submit control and the receipt path.
 * `resolvePreset` fills the caller's values in, in order, and returns an
 * ordinary recipe, which then takes the one publish path (validateRecipe,
 * prepare, one confirm). A preset adds no power a hand-written recipe
 * lacks; it only saves an agent from pasting selectors.
 *
 * `verified` is true only after a real post was observed through the preset.
 * The shipped presets are modelled on each site's page and tested against
 * fixture copies (test/platform-fixtures), never against the live sites.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PresetRef, PublishRecipe } from "./contracts.js";
import { validateRecipe } from "./publish.js";
import { fail } from "./store.js";

const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_PLATFORM_CHARS = 40;
const MAX_NOTES_CHARS = 2_000;
/** Where the shipped presets live, beside both `src/` and the bundled `app/server.mjs`. */
const PRESETS_DIR = fileURLToPath(new URL("../recipes/", import.meta.url));

export interface PublishPreset {
	name: string;
	platform: string;
	/** True only after a real live post was observed through this preset. */
	verified: boolean;
	verifiedAt: string | null;
	/** What each selector is modelled on. */
	notes: string;
	origin: string;
	/** Exactly one of `composeUrl` (on `origin`) or `composeFrom: "target"` (the caller's page on `origin`). */
	composeUrl?: string;
	composeFrom?: "target";
	signedIn: string;
	/** The caller's values fill these in order. */
	fields: { label: string; selector: string }[];
	submit: string;
	receipt: { path: string; linkSelector?: string };
}

/** What a caller passes as `browser_publish`'s `preset`. */
export interface PresetRequest {
	name: string;
	values: string[];
	target?: string;
}

/** One row of `browser_publish_presets`. */
export interface PresetSummary {
	name: string;
	platform: string;
	verified: boolean;
	fields: string[];
	needsTarget: boolean;
}

const PRESET_KEYS: readonly string[] = ["name", "platform", "verified", "verifiedAt", "notes", "origin", "composeUrl", "composeFrom", "signedIn", "fields", "submit", "receipt"];

/**
 * Read and check every `*.json` in `dir`. A malformed preset is a startup
 * error: a shipped preset that cannot resolve must not reach an agent.
 */
export async function loadPresets(dir: string = PRESETS_DIR): Promise<PublishPreset[]> {
	const files = (await readdir(dir)).filter((file) => extname(file) === ".json").sort();
	const presets: PublishPreset[] = [];
	for (const file of files) {
		const where = join(dir, file);
		let raw: unknown;
		try {
			raw = JSON.parse(await readFile(where, "utf8"));
		} catch (error) {
			throw new Error(`publish preset ${where} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
		const preset = parsePreset(raw, where);
		if (preset.name !== basename(file, ".json")) throw new Error(`publish preset ${where} is named ${JSON.stringify(preset.name)}; the file must be ${preset.name}.json`);
		presets.push(preset);
	}
	return presets;
}

/** Check one preset's shape, then prove it resolves to a valid recipe (selectors, origin, receipt path). */
export function parsePreset(input: unknown, where: string): PublishPreset {
	const bad = (message: string): never => {
		throw new Error(`publish preset ${where}: ${message}`);
	};
	if (!isObject(input)) return bad("must be an object");
	for (const key of Object.keys(input)) if (!PRESET_KEYS.includes(key)) bad(`unknown key ${JSON.stringify(key)}`);
	const { name, platform, verified, verifiedAt, notes, composeUrl, composeFrom, fields, receipt } = input;
	if (typeof name !== "string" || !NAME.test(name)) bad("name must be lowercase letters, digits and dashes");
	if (typeof platform !== "string" || platform.length === 0 || platform.length > MAX_PLATFORM_CHARS) bad(`platform must be 1-${MAX_PLATFORM_CHARS} characters`);
	if (typeof verified !== "boolean") bad("verified must be a boolean");
	if (verified ? typeof verifiedAt !== "string" || !Number.isFinite(Date.parse(verifiedAt)) : verifiedAt !== null) {
		bad("verifiedAt must be the date a live post was observed when verified, else null");
	}
	if (typeof notes !== "string" || notes.length > MAX_NOTES_CHARS) bad(`notes must be a string of at most ${MAX_NOTES_CHARS} characters`);
	if ((composeUrl === undefined) === (composeFrom === undefined)) bad('give exactly one of composeUrl or composeFrom: "target"');
	if (composeFrom !== undefined && composeFrom !== "target") bad('composeFrom must be "target"');
	if (!Array.isArray(fields)) return bad("fields must be an array");
	const labelled = fields.map((field: unknown, index) => {
		if (!isObject(field) || Object.keys(field).some((key) => key !== "label" && key !== "selector")) bad(`fields[${index}] must be { label, selector }`);
		const { label, selector } = field as Record<string, unknown>;
		if (typeof label !== "string" || typeof selector !== "string") return bad(`fields[${index}] needs a label and a selector`);
		return { label, selector };
	});
	if (!isObject(receipt) || Object.keys(receipt).some((key) => key !== "path" && key !== "linkSelector")) bad("receipt must be { path, linkSelector? }");
	const preset = input as unknown as PublishPreset;
	// The recipe checks (origin, composeUrl on origin, selectors, labels, path) are the one source of truth.
	try {
		const recipe = toRecipe(preset, labelled.map(() => ""), preset.composeUrl ?? `${String(preset.origin)}/`);
		const valid = validateRecipe(recipe);
		return {
			name: preset.name,
			platform: preset.platform,
			verified: preset.verified,
			verifiedAt: preset.verifiedAt,
			notes: preset.notes,
			origin: valid.origin,
			...(preset.composeUrl === undefined ? { composeFrom: "target" as const } : { composeUrl: valid.composeUrl }),
			signedIn: valid.signedIn,
			fields: valid.fields.map((field) => ({ label: field.label ?? "", selector: field.selector })),
			submit: valid.submit,
			receipt: valid.receipt,
		};
	} catch (error) {
		return bad(error instanceof Error ? error.message : String(error));
	}
}

/** What `browser_publish_presets` lists: enough to choose one and call it, no selectors. */
export function summarizePresets(presets: readonly PublishPreset[]): PresetSummary[] {
	return presets.map((preset) => ({
		name: preset.name,
		platform: preset.platform,
		verified: preset.verified,
		fields: preset.fields.map((field) => field.label),
		needsTarget: preset.composeFrom === "target",
	}));
}

/**
 * The recipe a preset request stands for, and the provenance the record keeps.
 * Refuses an unknown name (listing the known ones), a value count that is not
 * the preset's field count, and a target that is missing, not wanted, or not
 * on the preset's origin. Everything else is checked by validateRecipe on the
 * one publish path.
 */
export function resolvePreset(presets: readonly PublishPreset[], request: PresetRequest): { recipe: PublishRecipe; preset: PresetRef } {
	if (!isObject(request)) fail("bad_preset", "preset must be { name, values, target? }");
	const preset = presets.find((candidate) => candidate.name === request.name);
	if (preset === undefined) {
		fail("bad_preset", `unknown preset ${JSON.stringify(request.name)}; known presets: ${presets.map((candidate) => candidate.name).join(", ") || "none"}`);
	}
	const labels = preset.fields.map((field) => field.label);
	if (!Array.isArray(request.values) || request.values.length !== labels.length || request.values.some((value) => typeof value !== "string")) {
		fail("bad_preset", `${preset.name} takes ${labels.length} value${labels.length === 1 ? "" : "s"} in this order: ${labels.join(", ")}`);
	}
	let composeUrl: string;
	if (preset.composeFrom === "target") {
		if (typeof request.target !== "string") fail("bad_preset", `${preset.name} needs target: the page on ${preset.origin} to post on`);
		composeUrl = onOrigin(request.target, preset);
	} else {
		if (request.target !== undefined) fail("bad_preset", `${preset.name} takes no target; it always composes at ${preset.composeUrl}`);
		composeUrl = preset.composeUrl ?? fail("bad_preset", `${preset.name} has no composeUrl`);
	}
	return { recipe: toRecipe(preset, request.values, composeUrl), preset: { name: preset.name, verified: preset.verified } };
}

function onOrigin(target: string, preset: PublishPreset): string {
	let url: URL;
	try {
		url = new URL(target);
	} catch {
		fail("bad_preset", `target ${JSON.stringify(target)} is not an absolute URL`);
	}
	if (url.origin !== preset.origin) fail("bad_preset", `target must be a page on ${preset.origin}, got ${url.origin}`);
	return url.href;
}

function toRecipe(preset: PublishPreset, values: readonly string[], composeUrl: string): PublishRecipe {
	return {
		origin: preset.origin,
		composeUrl,
		signedIn: preset.signedIn,
		fields: preset.fields.map((field, index) => ({ label: field.label, selector: field.selector, value: values[index] ?? "" })),
		submit: preset.submit,
		receipt: { ...preset.receipt },
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
