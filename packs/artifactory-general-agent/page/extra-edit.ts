// A human gesture that sets a manifest key the profile does not draw (the
// plugins allowlist, the control lanes) writes it into Other settings, the
// text the file keeps as written. One key at a time: the rest of the text
// stays exactly as the author left it.
import { parseExtra, reindent } from "../src/extra";

/** `extra` with `path` (`key` or `section.key`) set to the YAML `value`, or
 *  removed when `value` is null; an emptied section goes with it. */
export function setExtraPath(extra: string, path: string, value: string | null): string {
	const [head, child] = path.split(".") as [string, string | undefined];
	const out: string[][] = [];
	let placed = false;
	for (const block of parseExtra(extra).blocks) {
		if (block.key !== head) {
			out.push([...block.lines]);
			continue;
		}
		// A section written inline (`capabilities: { … }`) is not this editor's to
		// split; the profile shows such a key as held and never calls here for it.
		if (child !== undefined && block.children === null && block.inline !== "") {
			out.push([...block.lines]);
			placed = true;
			continue;
		}
		placed = true;
		if (child === undefined) {
			if (value !== null) out.push([`${head}: ${value}`]);
			continue;
		}
		const kept = (block.children ?? []).filter(entry => entry.key !== child).map(entry => reindent(entry.lines, block.childIndent, 2));
		if (value !== null) kept.push([`  ${child}: ${value}`]);
		if (kept.length > 0) out.push([`${head}:`, ...kept.flat()]);
	}
	if (!placed && value !== null) out.push(child === undefined ? [`${head}: ${value}`] : [`${head}:`, `  ${child}: ${value}`]);
	return out.map(lines => lines.join("\n")).join("\n");
}

/** A YAML flow list of plain names. */
export function flowList(names: readonly string[]): string {
	return `[${names.join(", ")}]`;
}
