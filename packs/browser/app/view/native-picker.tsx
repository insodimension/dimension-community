import { type CSSProperties, Fragment, useEffect, useRef } from "react";
import type { NativePicker, Viewport } from "../../src/contracts";

const PAGE_STEP = 10;
const TYPEAHEAD_RESET_MS = 1_000;

export const PICKER_STEP_KEYS: Readonly<Record<string, true>> = { ArrowDown: true, ArrowUp: true, Home: true, End: true, PageDown: true, PageUp: true };

export function initialHighlight(picker: NativePicker): number {
	const choosable = picker.options.filter(option => !option.disabled);
	return (choosable.find(option => option.index === picker.selected) ?? choosable[0])?.index ?? -1;
}

export function steppedHighlight(picker: NativePicker, from: number, key: string): number {
	const choosable = picker.options.filter(option => !option.disabled);
	if (choosable.length === 0) return -1;
	const at = choosable.findIndex(option => option.index === from);
	const last = choosable.length - 1;
	const target =
		key === "Home" ? 0
		: key === "End" ? last
		: key === "ArrowDown" ? (at === -1 ? 0 : at + 1)
		: key === "ArrowUp" ? (at === -1 ? 0 : at - 1)
		: key === "PageDown" ? (at === -1 ? 0 : at + PAGE_STEP)
		: key === "PageUp" ? (at === -1 ? 0 : at - PAGE_STEP)
		: at;
	return choosable[Math.max(0, Math.min(last, target))]?.index ?? from;
}

export interface Typeahead {
	text: string;
	at: number;
}

export function typedHighlight(picker: NativePicker, from: number, typed: Typeahead, char: string, now: number): { highlight: number; typed: Typeahead } {
	const text = (now - typed.at > TYPEAHEAD_RESET_MS ? char : typed.text + char).toLocaleLowerCase();
	const choosable = picker.options.filter(option => !option.disabled);
	const at = choosable.findIndex(option => option.index === from);
	const start = text.length === 1 ? at + 1 : Math.max(at, 0);
	const ordered = [...choosable.slice(start), ...choosable.slice(0, start)];
	const match = ordered.find(option => option.label.trim().toLocaleLowerCase().startsWith(text));
	return { highlight: match?.index ?? from, typed: { text, at: now } };
}

export interface NativePickerListProps {
	readonly picker: NativePicker;
	readonly viewport: Viewport;
	readonly highlight: number;
	readonly interactive: boolean;
	readonly onHover: (index: number) => void;
	readonly onPick: (index: number) => void;
}

const percent = (value: number, of: number) => `${(Math.max(0, value) / of) * 100}%`;

export function NativePickerList({ picker, viewport, highlight, interactive, onHover, onPick }: NativePickerListProps) {
	const listRef = useRef<HTMLDivElement | null>(null);
	const { box } = picker;
	const bottomEdge = box.y + box.height;
	const roomBelow = viewport.height - bottomEdge;
	const below = roomBelow >= box.y;
	const style: CSSProperties = {
		left: percent(Math.min(box.x, viewport.width - 1), viewport.width),
		minWidth: percent(box.width, viewport.width),
		maxWidth: percent(viewport.width - box.x, viewport.width),
		...(below ? { top: percent(bottomEdge, viewport.height), maxHeight: percent(roomBelow, viewport.height) } : { bottom: percent(viewport.height - box.y, viewport.height), maxHeight: percent(box.y, viewport.height) }),
	};

	useEffect(() => {
		listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
	}, [highlight, picker.id]);

	const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
	let group: string | null = null;
	return (
		<div
			ref={listRef}
			className="bx-picker"
			role="listbox"
			aria-label="Options"
			data-interactive={interactive || undefined}
			style={style}
			onPointerDown={event => {
				event.stopPropagation();
				event.preventDefault();
			}}
			onPointerMove={stop}
			onPointerUp={stop}
			onMouseDown={stop}
			onMouseUp={stop}
			onClick={stop}
			onContextMenu={event => {
				event.stopPropagation();
				event.preventDefault();
			}}
		>
			{picker.options.map(option => {
				const header = option.group !== group && option.group !== null;
				group = option.group;
				return (
					<Fragment key={option.index}>
						{header && (
							<div className="bx-picker-group" role="presentation">
								{option.group}
							</div>
						)}
						<div
							className="bx-picker-option"
							role="option"
							data-index={option.index}
							data-grouped={option.group !== null || undefined}
							aria-selected={option.index === highlight}
							aria-disabled={option.disabled || undefined}
							onPointerEnter={() => {
								if (interactive && !option.disabled) onHover(option.index);
							}}
							onClick={() => {
								if (interactive && !option.disabled) onPick(option.index);
							}}
						>
							{option.label.length > 0 ? option.label : "\u00a0"}
						</div>
					</Fragment>
				);
			})}
		</div>
	);
}
