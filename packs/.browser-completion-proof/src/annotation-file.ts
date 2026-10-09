/**
 * Where the full facts of an annotation live.
 *
 * The shared annotation kit keeps the message the agent receives under the host's
 * text limit by leaving the long part out of it: it assembles ONE JSON document
 * (every mark by its number, with the elements under it) and asks the View for a
 * place the agent can read, then names that place in the message. A View cannot
 * write files, so its own server stores the document here.
 *
 * This is not a general file writer: it keeps only the kit's document (by its
 * schema id), at most {@link MAX_DETAIL_BYTES}, under one folder of its own with
 * names it picks, and removes the oldest beyond {@link ANNOTATION_FILES_KEPT}.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fail } from "./store";

/** The kit's document id, up to its version (`dimension.annotation-detail/1`): a reader of the file checks the rest. */
const SCHEMA_PREFIX = "dimension.annotation-detail/";
/** The kit refuses to build a larger document; the server holds the same line. */
export const MAX_DETAIL_BYTES = 1024 * 1024;
/** Annotations whose files are kept: the one being read and a good few before it. */
export const ANNOTATION_FILES_KEPT = 20;

const OWN_NAME = /^annotation-\d{13}-\d{6}-[0-9a-f]{8}\.json$/;

export class AnnotationFiles {
	private readonly dir: string;
	private sequence = 0;

	constructor(dir: string) {
		this.dir = resolve(dir);
	}

	/** Keep `json` and answer the absolute path it can be read at. */
	save(json: string): string {
		const bytes = Buffer.byteLength(json, "utf8");
		if (bytes > MAX_DETAIL_BYTES) fail("bad_detail", `the detail is ${bytes} bytes, above the ${MAX_DETAIL_BYTES} byte limit`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(json);
		} catch {
			fail("bad_detail", "the detail is not JSON");
		}
		const schema = typeof parsed === "object" && parsed !== null && "schema" in parsed ? parsed.schema : undefined;
		if (typeof schema !== "string" || !schema.startsWith(SCHEMA_PREFIX)) {
			fail("bad_detail", `the detail is not an annotation document (its schema must start with ${SCHEMA_PREFIX})`);
		}

		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		this.sequence += 1;
		// Time first, then this server's own count, so the names sort in the order they were made.
		const name = `annotation-${String(Date.now()).padStart(13, "0")}-${String(this.sequence).padStart(6, "0")}-${randomBytes(4).toString("hex")}.json`;
		const path = join(this.dir, name);
		writeFileSync(path, json, { encoding: "utf8", mode: 0o600, flag: "wx" });
		this.prune();
		return path;
	}

	private prune(): void {
		let names: string[];
		try {
			names = readdirSync(this.dir).filter(name => OWN_NAME.test(name)).sort();
		} catch {
			return;
		}
		for (const name of names.slice(0, Math.max(0, names.length - ANNOTATION_FILES_KEPT))) {
			try {
				rmSync(join(this.dir, name), { force: true });
			} catch {
				// A file another process holds open stays until the next save.
			}
		}
	}
}
