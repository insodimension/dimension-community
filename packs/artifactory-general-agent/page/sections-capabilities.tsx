// What the agent may use, drawn with the Capabilities page's own marks: one
// tab per kind, each a grid of mark cards from the host's catalog, checked for
// what the agent is limited to. "Every X" is its own state (the manifest's
// absent key), never a wall of checks; an entry the catalog does not know
// (an uninstalled pack's skill) still shows, with a generic mark.
import { Icon, Input, MarketplaceFilterPills, McpMark, PluginMark, Segmented, SkillMark, ToolMark, cn } from "@fraym/ui";
import { type ReactNode, useState } from "react";
import { heldByExtra } from "../src/agent-md";
import { parseExtra } from "../src/extra";
import { GrantLock, PANEL, Section } from "./chrome";
import { flowList, setExtraPath } from "./extra-edit";
import { pluginMatches } from "./home";
import type { SectionProps } from "./profile";
import { allowlistOf, type CapabilityKind, humanize } from "./roster";
import { ProposedBadge } from "./sections-identity";
import type { CatalogFact } from "./types";

const TABS: readonly CapabilityKind[] = ["skills", "plugins", "mcp", "tools"];

const WORDS: Readonly<Record<CapabilityKind, { readonly tab: string; readonly every: string; readonly one: string; readonly many: string }>> = {
	skills: { tab: "Skills", every: "Every skill", one: "skill", many: "skills" },
	plugins: { tab: "Plugins", every: "Every plugin", one: "plugin", many: "plugins" },
	mcp: { tab: "MCP", every: "Every MCP server", one: "server", many: "servers" },
	tools: { tab: "Tools", every: "Every tool", one: "tool", many: "tools" },
};

/** Which allowlists grant (doc 58 §3): only a human sets them. */
const GRANTS: Readonly<Record<CapabilityKind, boolean>> = { skills: false, plugins: true, mcp: true, tools: true };

interface Item {
	readonly name: string;
	readonly label: string;
	readonly detail?: string;
	readonly source?: string;
	readonly mark: ReactNode;
	readonly known: boolean;
}

function itemsOf(kind: CapabilityKind, catalog: CatalogFact | undefined, allowed: readonly string[]): Item[] {
	const pluginTitle = (id: string | undefined) => {
		if (id === undefined) return undefined;
		const plugin = catalog?.plugins.find(record => record.id === id);
		return plugin?.title ?? plugin?.name ?? id;
	};
	const items: Item[] = [];
	if (kind === "skills") {
		for (const skill of catalog?.skills ?? []) {
			const owner = skill.pluginId === undefined ? undefined : catalog?.plugins.find(record => record.id === skill.pluginId);
			const source = pluginTitle(skill.pluginId);
			items.push({ name: skill.name, label: humanize(skill.name), ...(skill.description ? { detail: skill.description } : {}), ...(source ? { source } : {}), mark: <SkillMark name={skill.name} {...(owner ? { pluginIcon: owner } : {})} size="include" />, known: true });
		}
	} else if (kind === "plugins") {
		for (const plugin of catalog?.plugins ?? []) {
			items.push({ name: plugin.name, label: plugin.title ?? humanize(plugin.name), ...(plugin.description ? { detail: plugin.description } : {}), source: plugin.enabled ? plugin.kind : `${plugin.kind} · off`, mark: <PluginMark plugin={plugin} size="include" />, known: true });
		}
	} else if (kind === "mcp") {
		for (const server of catalog?.mcp ?? []) {
			const source = pluginTitle(server.pluginId);
			items.push({ name: server.name, label: server.name, ...(server.description ? { detail: server.description } : {}), ...(source ? { source } : server.status ? { source: server.status } : {}), mark: <McpMark name={server.name} size="include" />, known: true });
		}
	} else {
		for (const tool of catalog?.tools ?? []) {
			const source = tool.source === "builtin" ? "Built in" : pluginTitle(tool.pluginId);
			items.push({ name: tool.name, label: tool.name, ...(tool.description ? { detail: tool.description } : {}), ...(source ? { source } : {}), mark: <ToolMark name={tool.name} size="include" />, known: true });
		}
	}
	const matches = (item: Item, name: string) => (kind === "plugins" ? pluginMatches(item.name, name) : item.name === name);
	for (const name of allowed) {
		if (items.some(item => matches(item, name))) continue;
		const mark = kind === "plugins" ? <PluginMark plugin={{ name }} size="include" /> : kind === "skills" ? <SkillMark name={name} size="include" /> : kind === "mcp" ? <McpMark name={name} size="include" /> : <ToolMark name={name} size="include" />;
		items.push({ name, label: kind === "tools" || kind === "mcp" ? name : humanize(name), detail: "Not installed here. It still counts when it is.", mark, known: false });
	}
	return items;
}

function MarkItem({ item, checked, every, disabled, onToggle }: { readonly item: Item; readonly checked: boolean; readonly every: boolean; readonly disabled: boolean; readonly onToggle: () => void }) {
	const on = checked || every;
	return (
		<button
			type="button"
			role="checkbox"
			aria-checked={on}
			disabled={disabled}
			onClick={onToggle}
			className={cn(
				"relative flex min-w-0 items-start gap-3 rounded-lg border p-3 text-left fr-t-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fr-accent-line",
				checked ? "border-fr-accent-line bg-fr-accent-dim" : "border-fr-border-soft bg-fr-surface",
				!disabled && !checked && "hover:border-fr-border hover:bg-fr-surface-2",
				disabled && "cursor-default",
				!item.known && "border-dashed",
			)}
		>
			<span className="shrink-0">{item.mark}</span>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5 pr-5">
				<span className="fr-overflow text-fr-sm font-medium text-fr-text">{item.label}</span>
				{item.detail ? <span className="line-clamp-2 text-fr-xs leading-relaxed text-fr-text-2">{item.detail}</span> : null}
				{item.source ? <span className="fr-overflow font-secondary text-fr-2xs text-fr-text-3">{item.source}</span> : null}
			</span>
			<span
				aria-hidden="true"
				className={cn(
					"absolute top-3 right-3 flex size-4 items-center justify-center rounded-sm border",
					checked ? "border-fr-accent bg-fr-accent text-fr-accent-ink" : every ? "border-fr-border bg-fr-surface-3 text-fr-text-2" : "border-fr-border bg-fr-bg text-transparent",
				)}
			>
				<Icon name="check" size={10} strokeWidth={3} />
			</span>
		</button>
	);
}

export function CapabilitiesSection({ draft, set, editable, catalog, marked }: SectionProps & { readonly catalog: CatalogFact | undefined; readonly marked: ReadonlySet<string> }) {
	const [tab, setTab] = useState<CapabilityKind>("skills");
	const [query, setQuery] = useState("");
	const [picking, setPicking] = useState<Partial<Record<CapabilityKind, boolean>>>({});
	const held = heldByExtra(draft);
	const lists = Object.fromEntries(TABS.map(kind => [kind, allowlistOf(draft, kind)])) as Record<CapabilityKind, ReturnType<typeof allowlistOf>>;
	const list = lists[tab];
	const words = WORDS[tab];
	// Held: the file says it in a form the tab cannot draw (`[]`, `*`, a
	// mapping); Other settings shows it as written.
	const inlineSection = parseExtra(draft.extra).blocks.some(block => block.key === "capabilities" && block.children === null && block.inline !== "");
	const isHeld = tab === "plugins" ? inlineSection || list.kind === "none" : held.has(`capabilities.${tab}`);
	const names = list.kind === "some" ? list.names : [];
	const mode: "every" | "some" = list.kind === "some" || picking[tab] === true ? "some" : "every";
	const canEdit = editable && !isHeld;

	const write = (next: readonly string[]) => {
		if (tab === "plugins") set({ extra: setExtraPath(draft.extra, "capabilities.plugins", next.length === 0 ? null : flowList(next)) });
		else set({ [tab]: [...next] });
	};
	const toggle = (name: string) => {
		const has = tab === "plugins" ? names.some(entry => pluginMatches(name, entry)) : names.includes(name);
		write(has ? names.filter(entry => (tab === "plugins" ? !pluginMatches(name, entry) : entry !== name)) : [...names, name]);
	};
	const setMode = (next: "every" | "some") => {
		setPicking(current => ({ ...current, [tab]: next === "some" }));
		if (next === "every") write([]);
	};

	const items = itemsOf(tab, catalog, names);
	const needle = query.trim().toLowerCase();
	const shown = needle === "" ? items : items.filter(item => `${item.name} ${item.label} ${item.detail ?? ""}`.toLowerCase().includes(needle));
	const isChecked = (item: Item) => (tab === "plugins" ? names.some(entry => pluginMatches(item.name, entry)) : names.includes(item.name));
	shown.sort((a, b) => Number(isChecked(b)) - Number(isChecked(a)));

	const filters = TABS.map(kind => {
		const entry = lists[kind];
		return { id: kind, label: WORDS[kind].tab, count: entry.kind === "some" ? entry.names.length : entry.kind === "none" ? 0 : undefined } as { id: CapabilityKind; label: string; count?: number };
	});
	const countLine = list.kind === "some" ? `${names.length} ${names.length === 1 ? words.one : words.many} of ${items.length}` : list.kind === "none" ? `No ${words.many}` : `${words.every}${catalog ? ` (${items.length})` : ""}`;

	return (
		<Section
			id="agent-capabilities"
			title="Capabilities"
			lede="What it may use. Leave a kind at Every to follow what is installed; choose to limit it to the ones you check."
			aside={marked.has("skills") ? <ProposedBadge /> : undefined}
		>
			<div className={cn(PANEL, "flex flex-col gap-4 p-4")}>
				<div className="flex flex-wrap items-center justify-between gap-3">
					<MarketplaceFilterPills filters={filters} active={tab} onChange={next => { setTab(next); setQuery(""); }} ariaLabel="Capability kind" />
					<span className="flex items-center gap-2 font-secondary text-fr-xs text-fr-text-2">
						{GRANTS[tab] ? <GrantLock /> : null}
						{countLine}
					</span>
				</div>
				<div className="flex flex-wrap items-center gap-3">
					<Segmented
						options={["every", "some"] as const}
						value={mode}
						onChange={next => canEdit && setMode(next)}
						label={value => (value === "every" ? words.every : "Only the ones I check")}
						className={cn(!canEdit && "pointer-events-none opacity-70")}
					/>
					<div className="relative min-w-48 flex-1">
						<Icon name="search" size={13} strokeWidth={2} className="pointer-events-none absolute top-1/2 left-2.5 z-[1] -translate-y-1/2 text-fr-text-3" />
						<Input size="sm" value={query} onChange={event => setQuery(event.target.value)} placeholder={`Search ${words.many}`} aria-label={`Search ${words.many}`} className="pl-8" />
					</div>
				</div>
				{isHeld ? (
					<p className="m-0 flex items-center gap-2 text-fr-xs text-fr-text-2">
						<Icon name="sliders" size={12} strokeWidth={2} />
						{list.kind === "none" ? `It may use no ${words.many}.` : `Its ${words.many} are set in Other settings.`} Change it there, under Advanced.
					</p>
				) : mode === "some" && names.length === 0 ? (
					<p className="m-0 text-fr-xs text-fr-accent">Check the {words.many} it may use. Until you check one it keeps {words.every.toLowerCase()}.</p>
				) : null}
				{catalog === undefined ? (
					<p className="m-0 rounded-md border border-dashed border-fr-border px-3 py-3 text-fr-xs text-fr-text-2">The host has not published its capabilities catalog yet, so only what this agent names is shown.</p>
				) : null}
				{shown.length === 0 ? (
					<p className="m-0 py-6 text-center text-fr-sm text-fr-text-2">{needle === "" ? `No ${words.many} installed.` : `No ${words.many} match “${query}”.`}</p>
				) : (
					<div className="grid grid-cols-1 gap-2 @2xl:grid-cols-2 @5xl:grid-cols-3">
						{shown.map(item => (
							<MarkItem key={item.name} item={item} checked={mode === "some" && isChecked(item)} every={mode === "every" && list.kind === "all"} disabled={!canEdit || mode === "every"} onToggle={() => toggle(item.name)} />
						))}
					</div>
				)}
			</div>
		</Section>
	);
}
