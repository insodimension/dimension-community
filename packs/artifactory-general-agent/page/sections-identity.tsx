// Who the agent is and what it runs by: its name and line, its face (a gallery
// of every face the host can paint, still until pointed at), how it talks, its
// charter, and the standing instructions that follow it from workspace to
// workspace. Each is drawn as the thing it is (a face, a choice, a file).
import { Badge, Icon, Input, Textarea, cn } from "@fraym/ui";
import { useState } from "react";
import { heldByExtra, normalizeTypedName, type Personality, type PromptMode } from "../src/agent-md";
import type { AgentHome, InstructionFile, ListedAgent } from "../src/contracts";
import { ChoiceCard, ChoiceGroup, FaceTile, FieldRow, PANEL, Section } from "./chrome";
import { faceOptions } from "./faces";
import type { SectionProps } from "./profile";
import type { FieldErrors } from "./profile-state";
import type { BridgedPresences, FaceBinding } from "./types";

/** The Machinist set this and the human has not decided yet. */
export function ProposedBadge() {
	return (
		<Badge tone="accent" variant="soft" className="text-fr-xs">
			Proposed
		</Badge>
	);
}

function InlineError({ text }: { readonly text: string | undefined }) {
	if (text === undefined) return null;
	return (
		<span role="alert" className="mt-1.5 flex items-center gap-1.5 text-fr-xs text-fr-del">
			<Icon name="warnTri" size={12} strokeWidth={2} />
			{text}
		</span>
	);
}

const PERSONALITY: readonly { readonly id: Personality; readonly icon: "aether" | "chat" | "bolt" | "minus"; readonly title: string; readonly detail: string }[] = [
	{ id: "default", icon: "aether", title: "Dimension's default", detail: "Whatever personality you set for Dimension." },
	{ id: "friendly", icon: "chat", title: "Friendly", detail: "Warm, encouraging, explains as it goes." },
	{ id: "pragmatic", icon: "bolt", title: "Pragmatic", detail: "Direct and brief; the answer first." },
	{ id: "none", icon: "minus", title: "No personality", detail: "Only its charter shapes how it talks." },
];

const SPEAKS: readonly { readonly id: PromptMode; readonly icon: "user" | "layers"; readonly title: string; readonly detail: string }[] = [
	{ id: "replace", icon: "user", title: "Only as itself", detail: "Its charter is its whole voice. Right for a writer, a researcher, a CMO." },
	{ id: "append", icon: "layers", title: "As Dimension, plus its charter", detail: "The full coding prompt first, then its charter. Right for an agent that codes." },
];

function GalleryFace({
	id,
	label,
	checked,
	disabled,
	bridged,
	onPick,
	skin,
	accent,
}: {
	readonly id: string;
	readonly label: string;
	readonly checked: boolean;
	readonly disabled: boolean;
	readonly bridged: BridgedPresences | undefined;
	readonly onPick: () => void;
	readonly skin?: FaceBinding["skin"];
	readonly accent?: FaceBinding["accent"];
}) {
	const [live, setLive] = useState(false);
	return (
		<button
			type="button"
			role="radio"
			aria-checked={checked}
			aria-label={label}
			disabled={disabled}
			onClick={onPick}
			onPointerEnter={() => setLive(true)}
			onPointerLeave={() => setLive(false)}
			onFocus={() => setLive(true)}
			onBlur={() => setLive(false)}
			className={cn(
				"group/face flex min-w-0 flex-col items-center gap-1.5 rounded-lg p-1.5 fr-t-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fr-accent-line",
				checked ? "bg-fr-accent-dim" : "hover:bg-fr-surface-2",
				disabled && "cursor-default",
			)}
		>
			<FaceTile
				face={{ avatar: id as FaceBinding["avatar"], ...(checked && skin ? { skin } : {}), ...(checked && accent ? { accent } : {}) }}
				tile={72}
				presence={56}
				live={live}
				bridged={bridged}
				name={label}
				className={cn(checked && "border-fr-accent")}
			/>
			<span className={cn("fr-overflow max-w-full font-secondary text-fr-xs", checked ? "text-fr-text" : "text-fr-text-2")}>{label}</span>
		</button>
	);
}

export function IdentitySection({
	draft,
	set,
	editable,
	creating,
	errors,
	face,
	bridged,
	marked,
}: SectionProps & {
	readonly creating: boolean;
	readonly errors: FieldErrors;
	readonly face: FaceBinding;
	readonly faceOf: (name: string) => FaceBinding;
	readonly bridged: BridgedPresences | undefined;
	readonly marked: ReadonlySet<string>;
}) {
	const heldFace = heldByExtra(draft).has("avatar");
	const faces = faceOptions(bridged);
	const current = draft.vibr === "" ? null : draft.vibr;
	return (
		<Section id="agent-identity" title="Identity" lede="Its name, its line, the face it wears everywhere it appears, and how it talks.">
			<div className={cn(PANEL, "flex flex-col gap-5 p-4")}>
				<FieldRow label="Name" hint={creating ? "Its id: lowercase letters, digits and dashes. It cannot change once written." : "Its id. Fixed once written."}>
					{creating ? (
						<>
							<Input
								value={draft.name}
								placeholder="release-herald"
								aria-invalid={errors.name !== undefined}
								onChange={event => set({ name: normalizeTypedName(event.target.value) })}
								className="max-w-md font-secondary"
							/>
							<InlineError text={errors.name} />
						</>
					) : (
						<span className="inline-flex items-center rounded-sm bg-fr-surface-3 px-2 py-1 font-secondary text-fr-sm text-fr-text">{draft.name}</span>
					)}
				</FieldRow>
				<FieldRow label="What it is for" hint="One line. Rooms route to it by this when it declares no card.">
					<div className="flex items-center gap-2">
						<Input value={draft.description} disabled={!editable} placeholder="Writes our changelog in my voice" aria-invalid={errors.description !== undefined} onChange={event => set({ description: event.target.value })} />
						{marked.has("description") ? <ProposedBadge /> : null}
					</div>
					<InlineError text={errors.description} />
				</FieldRow>
			</div>

			<div className={cn(PANEL, "flex flex-col gap-3 p-4")}>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<span className="flex items-center gap-2 text-fr-sm font-medium text-fr-text">
						Face
						{marked.has("vibr") ? <ProposedBadge /> : null}
					</span>
					<span className="font-secondary text-fr-xs text-fr-text-2">
						{heldFace ? "It wears a face with its own skin or accent, set in Other settings under Advanced." : current === null ? "It wears the neutral agent face until you pick one." : "Point at a face to see it move."}
					</span>
				</div>
				<div role="radiogroup" aria-label="Face" className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-1">
					{faces.map(option => (
						<GalleryFace
							key={option.id}
							id={option.id}
							label={option.label}
							checked={!heldFace && option.id === current}
							disabled={!editable || heldFace}
							bridged={bridged}
							onPick={() => set({ vibr: option.id })}
							{...(face.skin ? { skin: face.skin } : {})}
							{...(face.accent ? { accent: face.accent } : {})}
						/>
					))}
				</div>
			</div>

			<div className="grid grid-cols-1 gap-4 @4xl:grid-cols-[3fr_2fr]">
				<div className="flex flex-col gap-2.5">
					<span className="flex items-center gap-2 text-fr-sm font-medium text-fr-text">
						Personality
						{marked.has("personality") ? <ProposedBadge /> : null}
					</span>
					<ChoiceGroup label="Personality" columns={2}>
						{PERSONALITY.map(option => (
							<ChoiceCard key={option.id} icon={option.icon} title={option.title} detail={option.detail} checked={draft.personality === option.id} disabled={!editable} onSelect={() => set({ personality: option.id })} />
						))}
					</ChoiceGroup>
				</div>
				<div className="flex flex-col gap-2.5">
					<span className="text-fr-sm font-medium text-fr-text">Speaks as</span>
					<div role="radiogroup" aria-label="Speaks as" className="grid grid-cols-1 gap-2.5">
						{SPEAKS.map(option => (
							<ChoiceCard key={option.id} icon={option.icon} title={option.title} detail={option.detail} checked={draft.promptMode === option.id} disabled={!editable} onSelect={() => set({ promptMode: option.id })} />
						))}
					</div>
				</div>
			</div>
		</Section>
	);
}

/** A file, as the page draws one: its glyph, its name, where it lives and what it is. */
export function FileCard({ name, path, note, tone = "mute" }: { readonly name: string; readonly path: string; readonly note?: string; readonly tone?: "accent" | "mute" }) {
	return (
		<div data-slot="file-card" className="flex min-w-0 items-center gap-3">
			<span className={cn("flex size-9 shrink-0 items-center justify-center rounded-md", tone === "accent" ? "bg-fr-accent-dim text-fr-accent" : "bg-fr-surface-3 text-fr-text-2")}>
				<Icon name="file" size={16} strokeWidth={1.8} />
			</span>
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="flex items-center gap-2 text-fr-sm font-medium text-fr-text">
					{name}
					{note ? <span className="font-secondary text-fr-xs font-normal text-fr-text-2">{note}</span> : null}
				</span>
				<span className="fr-overflow font-secondary text-fr-xs text-fr-text-2" title={path}>
					{path}
				</span>
			</div>
		</div>
	);
}

export function CharterSection({
	draft,
	set,
	editable,
	errors,
	agent,
	marked,
}: SectionProps & { readonly errors: FieldErrors; readonly agent: ListedAgent | undefined; readonly marked: ReadonlySet<string> }) {
	const words = draft.charter.trim() === "" ? 0 : draft.charter.trim().split(/\s+/).length;
	const path = agent?.path ?? `Your agents / ${draft.name || "<name>"} / agent.md`;
	return (
		<Section id="agent-charter" title="Charter" lede="The instructions it runs by: the body of its agent.md. It is never inherited from an agent it extends.">
			<div className={cn(PANEL, "overflow-hidden", errors.charter !== undefined && "border-fr-del/60")}>
				<div className="flex flex-wrap items-center justify-between gap-3 border-b border-fr-border-soft bg-fr-surface-2/50 px-4 py-3">
					<FileCard name="agent.md" path={path} note={agent?.source === "pack" ? "Shipped with its pack" : agent === undefined ? "Written when you create it" : "The file it loads"} tone="accent" />
					<span className="flex items-center gap-2 font-secondary text-fr-xs text-fr-text-2 tabular-nums">
						{marked.has("charter") ? <ProposedBadge /> : null}
						{words} {words === 1 ? "word" : "words"}
					</span>
				</div>
				<Textarea
					variant="ghost"
					resize="vertical"
					value={draft.charter}
					readOnly={!editable}
					aria-label="Charter"
					aria-invalid={errors.charter !== undefined}
					placeholder={"You write the changelog.\n\nRead the merged pull requests since the last release, group them by what a user notices, and never invent a change."}
					onChange={event => set({ charter: event.target.value })}
					className="max-h-none min-h-72 rounded-none border-0 px-4 py-3 font-code text-fr-sm leading-relaxed"
				/>
			</div>
			<InlineError text={errors.charter} />
		</Section>
	);
}

const TIER_OF_FILE: Readonly<Record<InstructionFile["kind"], string>> = {
	"workspace-copy": "This project's copy",
	home: "Its home",
	pack: "Beside it in its pack",
	"agent-dir": "Beside its agent.md",
};

export function InstructionsSection({
	home,
	error,
	creating,
	text,
	onText,
	editable,
}: {
	readonly home: AgentHome | undefined;
	readonly error: string | undefined;
	readonly creating: boolean;
	readonly text: string;
	readonly onText: (text: string) => void;
	readonly editable: boolean;
}) {
	const winner = home?.instructions.files.find(file => file.wins);
	const writable = editable && home?.instructions.editable === true && home.instructions.target !== null;
	return (
		<Section id="agent-instructions" title="Standing instructions" lede="The AGENTS.md it reads at the start of every session, wherever it works. The first file that exists wins.">
			{creating ? (
				<p className="m-0 rounded-lg border border-dashed border-fr-border px-4 py-3 text-fr-sm text-fr-text-2">Create the agent first: its standing instructions live in its home, which it gets when it is written.</p>
			) : error !== undefined ? (
				<p role="alert" className="m-0 rounded-lg border border-fr-border-soft bg-fr-surface px-4 py-3 text-fr-sm text-fr-warn">
					{error}
				</p>
			) : home === undefined ? (
				<div className={cn(PANEL, "h-40 animate-pulse")} />
			) : (
				<div className={cn(PANEL, "overflow-hidden")}>
					<div className="flex flex-col gap-3 border-b border-fr-border-soft bg-fr-surface-2/50 px-4 py-3">
						<FileCard
							name="AGENTS.md"
							path={winner?.path ?? home.instructions.target?.path ?? "No file yet"}
							note={winner ? `${TIER_OF_FILE[winner.kind]} · in force` : "None yet"}
							tone={winner ? "accent" : "mute"}
						/>
						<ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Where it looks">
							{home.instructions.files.map(file => (
								<li
									key={file.path}
									title={file.path}
									className={cn(
										"inline-flex items-center gap-1.5 rounded-sm px-2 py-1 font-secondary text-fr-xs",
										file.wins ? "bg-fr-accent-dim text-fr-accent" : file.exists ? "bg-fr-surface-3 text-fr-text-2" : "border border-dashed border-fr-border text-fr-text-3",
									)}
								>
									<Icon name={file.wins ? "check" : file.exists ? "file" : "minus"} size={11} strokeWidth={2} />
									{TIER_OF_FILE[file.kind]}
									{file.wins ? "" : file.exists ? " · set aside" : " · none"}
								</li>
							))}
						</ul>
					</div>
					<Textarea
						variant="ghost"
						resize="vertical"
						value={text}
						readOnly={!writable}
						aria-label="Standing instructions"
						placeholder="Nothing here yet. What should it always know, whichever project it is working in?"
						onChange={event => onText(event.target.value)}
						className="max-h-none min-h-44 rounded-none border-0 px-4 py-3 font-code text-fr-sm leading-relaxed"
					/>
					<p className="m-0 border-t border-fr-border-soft px-4 py-2 font-secondary text-fr-xs text-fr-text-2">{home.instructions.note}</p>
				</div>
			)}
		</Section>
	);
}
