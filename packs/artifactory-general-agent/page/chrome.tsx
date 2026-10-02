// The page's shared visual vocabulary: the pieces the home and the profile both
// speak (a label, a section, a card stat, the vitals strip, a face on its tile,
// a choice card, the lock), so a reading or a face looks the same everywhere
// it appears. Token-only (`--fr-*` through the kit's utilities); the anatomy is
// the Autonomy page's, so the two pages read as one product.
import { Icon, Input, PresenceSurface, cn } from "@fraym/ui";
import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from "react";
import { faceWash } from "./faces";
import type { BridgedPresences, FaceBinding } from "./types";

type IconName = ComponentProps<typeof Icon>["name"];

/** A panel's or a column's label: the kit's eyebrow size and weight in the
 *  secondary face, sentence case (DESIGN.md: no uppercase eyebrows), text-2 for
 *  contrast on a surface. */
export const LABEL = "font-secondary text-fr-2xs font-semibold tracking-fr-label text-fr-text-2";

/** One scrolling column. Container queries, not the viewport: the Machinist's
 *  dock opening beside the page reflows it. */
export function ViewColumn({ slot, children, footer }: { readonly slot: string; readonly children: ReactNode; readonly footer?: ReactNode }) {
	return (
		<div className="relative flex h-full min-h-0 flex-col">
			<div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
				<div data-slot={slot} className="@container mx-auto flex w-full max-w-295 flex-col gap-7 px-5 pt-5 pb-12">
					{children}
				</div>
			</div>
			{footer}
		</div>
	);
}

/** Section chrome: a real heading with a quiet count, a lede and an aside. */
export function Section({
	title,
	count,
	lede,
	aside,
	children,
	className,
	id,
}: {
	readonly title: string;
	readonly count?: number;
	readonly lede?: ReactNode;
	readonly aside?: ReactNode;
	readonly children: ReactNode;
	readonly className?: string;
	readonly id?: string;
}) {
	return (
		<section id={id} aria-label={title} className={cn("flex scroll-mt-16 flex-col gap-3", className)}>
			<div className="flex min-h-5 flex-wrap items-end justify-between gap-x-3 gap-y-1">
				<div className="flex min-w-0 flex-col gap-1">
					<h2 className="m-0 flex items-baseline gap-2 text-fr-md font-semibold text-fr-text">
						{title}
						{count !== undefined ? <span className="font-secondary text-fr-sm font-normal text-fr-text-2 tabular-nums">{count}</span> : null}
					</h2>
					{lede ? <p className="m-0 max-w-prose text-fr-sm leading-relaxed text-pretty text-fr-text-2">{lede}</p> : null}
				</div>
				{aside}
			</div>
			{children}
		</section>
	);
}

/** One figure in a card's footer: the reading over its label. */
export function CardStat({ value, label, title, quiet }: { readonly value: string; readonly label: string; readonly title?: string; readonly quiet?: boolean }) {
	return (
		<div title={title} className="flex min-w-0 flex-col-reverse items-center gap-1 px-2 py-2.5">
			<dt className={cn("fr-overflow leading-none", LABEL)}>{label}</dt>
			<dd className={cn("m-0 fr-overflow font-secondary text-fr-sm leading-none font-medium tabular-nums", quiet ? "text-fr-text-2" : "text-fr-text")}>{value}</dd>
		</div>
	);
}

export interface Vital {
	readonly key: string;
	readonly icon: IconName;
	readonly label: string;
	readonly value: string;
	readonly title?: string;
	/** A reading of nothing (no sessions, $0.00): stated, but quietly. */
	readonly quiet?: boolean;
}

/** The agent's vitals as one instrument strip on a solid card (the Autonomy
 *  page's `VitalsStrip`): each cell a small glyph beside the reading, which
 *  leads, over its label. Two across a page at its floor, three from 28rem,
 *  six across a wide one; a reading wraps rather than ellipsizes. */
export function VitalsStrip({ vitals, caption, className }: { readonly vitals: readonly Vital[]; readonly caption?: string; readonly className?: string }) {
	return (
		<div data-slot="agent-vitals" className={cn("overflow-hidden rounded-lg border border-fr-border-soft bg-fr-surface", className)}>
			<dl className="m-0 grid grid-cols-2 gap-y-1 py-1 @md:grid-cols-3 @4xl:grid-cols-6">
				{vitals.map(vital => (
					<div key={vital.key} title={vital.title} className="flex min-w-0 items-start gap-2 px-3.5 py-2">
						<span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-md text-fr-text-2">
							<Icon name={vital.icon} size={12} strokeWidth={2} />
						</span>
						<div className="flex min-w-0 flex-col-reverse gap-1.5">
							<dt className={cn("leading-tight break-words", LABEL)}>{vital.label}</dt>
							<dd className={cn("m-0 font-secondary text-fr-lg leading-tight break-words tabular-nums", vital.quiet ? "font-medium text-fr-text-2" : "font-semibold text-fr-text")}>
								{vital.value}
							</dd>
						</div>
					</div>
				))}
			</dl>
			{caption ? <p className="m-0 border-t border-fr-border-soft px-3.5 py-2 font-secondary text-fr-2xs text-fr-text-2">{caption}</p> : null}
		</div>
	);
}

/** Whether `ref`'s element is on screen or near it (300px). A face's frame,
 *  WebGL context or sandboxed iframe is paid for only while it can be seen. */
export function useNearViewport<T extends Element>(): [React.RefObject<T | null>, boolean] {
	const ref = useRef<T | null>(null);
	const [near, setNear] = useState(false);
	useEffect(() => {
		const element = ref.current;
		if (!element || typeof IntersectionObserver === "undefined") {
			setNear(true);
			return;
		}
		const observer = new IntersectionObserver(
			entries => {
				for (const entry of entries) setNear(entry.isIntersecting);
			},
			{ rootMargin: "300px" },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return [ref, near];
}

/** A face on its tile: the agent's accent washed behind it, still unless
 *  `live` (the hovered or focused card), mounted only near the viewport, with
 *  the name's initial underneath for a face that paints nothing (the user's
 *  Vibr switch off, a contributed face whose pack is gone). */
export function FaceTile({
	face,
	tile,
	presence,
	live,
	bridged,
	name,
	className,
	ring = true,
}: {
	readonly face: FaceBinding;
	/** Tile edge, px. */
	readonly tile: number;
	/** Face edge, px. */
	readonly presence: number;
	readonly live: boolean;
	readonly bridged: BridgedPresences | undefined;
	readonly name: string;
	readonly className?: string;
	readonly ring?: boolean;
}) {
	const [ref, near] = useNearViewport<HTMLSpanElement>();
	const initial = name.charAt(0).toUpperCase();
	return (
		<span
			ref={ref}
			aria-hidden="true"
			data-slot="agent-face"
			data-live={live || undefined}
			className={cn(
				"relative isolate flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-fr-bg",
				ring && "border border-fr-border-soft",
				className,
			)}
			style={{ width: tile, height: tile }}
		>
			<span className="absolute inset-0" style={{ background: `radial-gradient(circle at 50% 42%, ${faceWash(face, 26)}, transparent 72%)` }} />
			{near && face.avatar !== "none" ? (
				<span className="relative flex items-center justify-center" style={{ width: presence, height: presence }}>
					<PresenceSurface
						avatar={face.avatar}
						skin={face.skin}
						accent={face.accent}
						bridgedPresences={bridged}
						size={presence}
						state="idle"
						mode=""
						energy={live ? 0.35 : 0}
						{...(live ? {} : { motion: "still" as const })}
					/>
				</span>
			) : (
				<span className="relative font-secondary text-fr-lg font-semibold text-fr-text-3">{initial}</span>
			)}
		</span>
	);
}

/** Only a human sets this (doc 58 §3): the lock, spoken once in words by the
 *  profile's legend and marked per control with this glyph. */
export function GrantLock({ className }: { readonly className?: string }) {
	return (
		<span data-slot="grant-lock" role="img" aria-label="Only you can change this" title="Only you can change this" className={cn("inline-flex text-fr-text-2", className)}>
			<Icon name="lock" size={12} strokeWidth={2} aria-hidden="true" />
		</span>
	);
}

/** One option of a choice drawn as a card: its glyph on a tile, its name, and
 *  what it means. A radio in a radiogroup; checked reads in the accent. */
export function ChoiceCard({
	icon,
	title,
	detail,
	checked,
	disabled,
	onSelect,
	illustration,
}: {
	readonly icon: IconName;
	readonly title: string;
	readonly detail: string;
	readonly checked: boolean;
	readonly disabled?: boolean;
	readonly onSelect: () => void;
	/** Drawn above the name instead of the glyph tile (a face, a folder). */
	readonly illustration?: ReactNode;
}) {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={checked}
			disabled={disabled}
			onClick={onSelect}
			className={cn(
				"group/choice relative flex min-w-0 flex-col items-start gap-2.5 rounded-lg border p-3.5 text-left fr-t-colors",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fr-accent-line",
				checked ? "border-fr-accent-line bg-fr-accent-dim" : "border-fr-border-soft bg-fr-surface",
				disabled ? "cursor-default" : checked ? "" : "hover:border-fr-border hover:bg-fr-surface-2",
				disabled && !checked && "opacity-60",
			)}
		>
			{illustration ?? (
				<span className={cn("flex size-8 items-center justify-center rounded-md", checked ? "bg-fr-accent text-fr-accent-ink" : "bg-fr-surface-3 text-fr-text-2")}>
					<Icon name={icon} size={16} strokeWidth={1.8} />
				</span>
			)}
			<span className="flex min-w-0 flex-col gap-0.5">
				<span className={cn("text-fr-sm font-semibold", checked ? "text-fr-text" : "text-fr-text")}>{title}</span>
				<span className="text-fr-xs leading-relaxed text-pretty text-fr-text-2">{detail}</span>
			</span>
			{checked ? (
				<span aria-hidden="true" className="absolute top-3 right-3 flex size-4 items-center justify-center rounded-full bg-fr-accent text-fr-accent-ink">
					<Icon name="check" size={10} strokeWidth={3} />
				</span>
			) : null}
		</button>
	);
}

/** A labelled group of choice cards (one radiogroup). */
export function ChoiceGroup({ label, columns = 3, children }: { readonly label: string; readonly columns?: 2 | 3 | 4; readonly children: ReactNode }) {
	return (
		<div
			role="radiogroup"
			aria-label={label}
			className={cn("grid grid-cols-1 gap-2.5", columns === 2 ? "@xl:grid-cols-2" : columns === 3 ? "@xl:grid-cols-3" : "@xl:grid-cols-2 @4xl:grid-cols-4")}
		>
			{children}
		</div>
	);
}

/** A labelled field row inside a panel: the label and its hint on the left, the
 *  control on the right; stacks on a narrow page. */
export function FieldRow({ label, hint, locked, children }: { readonly label: string; readonly hint?: ReactNode; readonly locked?: boolean; readonly children: ReactNode }) {
	return (
		<div className="flex flex-col gap-2 @2xl:flex-row @2xl:items-start @2xl:gap-6">
			<div className="flex w-full shrink-0 flex-col gap-0.5 @2xl:w-56">
				<span className="flex items-center gap-1.5 text-fr-sm font-medium text-fr-text">
					{label}
					{locked ? <GrantLock /> : null}
				</span>
				{hint ? <span className="text-fr-xs leading-relaxed text-fr-text-2">{hint}</span> : null}
			</div>
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	);
}

/** The page's one panel: a bordered surface holding a section's body. */
export const PANEL = "rounded-lg border border-fr-border-soft bg-fr-surface";

export interface PickOption {
	readonly id: string;
	readonly label: string;
	readonly detail?: string;
	readonly lead?: ReactNode;
}

/** An "add one" control: a search field that lists what matches beneath it,
 *  each a button. The kit grants no menu primitive to a pack, and a native
 *  select cannot draw a face or a vendor mark. */
export function PickList({ placeholder, options, onPick, disabled }: { readonly placeholder: string; readonly options: readonly PickOption[]; readonly onPick: (id: string) => void; readonly disabled?: boolean }) {
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const needle = query.trim().toLowerCase();
	const shown = (needle === "" ? options : options.filter(option => `${option.id} ${option.label} ${option.detail ?? ""}`.toLowerCase().includes(needle))).slice(0, 8);
	return (
		<div
			className="relative w-full max-w-md"
			onBlur={event => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
			}}
		>
			<Icon name="plus" size={13} strokeWidth={2} className="pointer-events-none absolute top-1/2 left-2.5 z-[1] -translate-y-1/2 text-fr-text-3" />
			<Input
				size="sm"
				value={query}
				disabled={disabled}
				placeholder={placeholder}
				aria-label={placeholder}
				onFocus={() => setOpen(true)}
				onChange={event => {
					setQuery(event.target.value);
					setOpen(true);
				}}
				className="pl-8"
			/>
			{open && !disabled ? (
				<ul className="absolute top-full right-0 left-0 z-20 m-0 mt-1 flex max-h-72 list-none flex-col overflow-y-auto rounded-md border border-fr-border bg-fr-surface p-1 shadow-md">
					{shown.length === 0 ? <li className="px-2.5 py-2 text-fr-xs text-fr-text-2">Nothing matches.</li> : null}
					{shown.map(option => (
						<li key={option.id}>
							<button
								type="button"
								onClick={() => {
									onPick(option.id);
									setQuery("");
									setOpen(false);
								}}
								className="flex w-full min-w-0 items-center gap-2.5 rounded-sm px-2 py-1.5 text-left fr-t-colors hover:bg-fr-surface-2 focus-visible:bg-fr-surface-2 focus-visible:outline-none"
							>
								{option.lead}
								<span className="flex min-w-0 flex-col">
									<span className="fr-overflow text-fr-sm text-fr-text">{option.label}</span>
									{option.detail ? <span className="fr-overflow font-secondary text-fr-xs text-fr-text-2">{option.detail}</span> : null}
								</span>
							</button>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
