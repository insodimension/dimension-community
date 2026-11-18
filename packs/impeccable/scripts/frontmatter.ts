import { YAML } from "bun";

const SKILL_FIELDS: Record<string, true> = {
	name: true,
	description: true,
	license: true,
	"allowed-tools": true,
	metadata: true,
	compatibility: true,
};

export function conformSkillFrontmatter(markdown: string): string {
	const text = markdown.replace(/\r\n?/g, "\n");
	if (!text.startsWith("---\n")) return markdown;
	const end = text.indexOf("\n---", 3);
	if (end === -1) return markdown;

	const blocks: string[][] = [];
	for (const line of text.slice(4, end).split("\n")) {
		const last = blocks[blocks.length - 1];
		if (last === undefined || /^[^\s#-][^:]*:/.test(line)) blocks.push([line]);
		else last.push(line);
	}

	const kept: string[] = [];
	const metadata = new Map<string, string>();
	for (const block of blocks) {
		const source = block.join("\n");
		const entries = Object.entries((YAML.parse(source) as Record<string, unknown> | null) ?? {});
		const [key, value] = entries[0] ?? [];
		if (entries.length !== 1 || key === undefined) {
			kept.push(source);
		} else if (key === "metadata" && value !== null && typeof value === "object" && !Array.isArray(value)) {
			for (const [field, inner] of Object.entries(value)) metadata.set(field, typeof inner === "string" ? inner : JSON.stringify(inner));
		} else if (key === "allowed-tools" && Array.isArray(value)) {
			const tools = value.map(String).join(" ");
			let plain = false;
			try {
				plain = (YAML.parse(`allowed-tools: ${tools}`) as Record<string, unknown>)["allowed-tools"] === tools;
			} catch {}
			kept.push(`allowed-tools: ${plain ? tools : JSON.stringify(tools)}`);
		} else if (SKILL_FIELDS[key]) {
			kept.push(source);
		} else {
			metadata.set(key, typeof value === "string" ? value : JSON.stringify(value));
		}
	}
	if (metadata.size > 0) {
		kept.push(["metadata:", ...[...metadata].map(([field, value]) => `  ${field}: ${JSON.stringify(value)}`)].join("\n"));
	}
	return `---\n${kept.join("\n")}${text.slice(end)}`;
}
