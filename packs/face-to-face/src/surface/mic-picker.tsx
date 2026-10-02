import { type KeyboardEvent, memo, useEffect, useMemo, useRef, useState } from "react";
import { describeMicMenu, micName } from "./mic-model";
import type { FaceVoice } from "./voice";

export type MicPickerVoice = Pick<FaceVoice, "micDevices" | "micDeviceId" | "micLabel" | "micSilent" | "setMicDevice">;

// Its own rules, on the surface's own variables (`--f2f-*`, set on `.f2f-root`): the picker is one file that
// the surface mounts, so the surface's stylesheet does not need to know it.
export const MIC_PICKER_STYLES = `
.f2f-mp { position: relative; display: inline-flex; }
.f2f-mp-btn { max-width: 16em; }
.f2f-mp-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.f2f-mp-btn[data-warn="true"] { color: var(--f2f-warn, #e8a33d); border-color: currentColor; }
.f2f-mp-btn .f2f-mp-chev { width: 12px; height: 12px; opacity: .7; transition: transform .16s ease; }
.f2f-mp-btn[aria-expanded="true"] .f2f-mp-chev { transform: rotate(180deg); }
.f2f-mp-menu {
	position: absolute; right: 0; top: calc(100% + 8px); z-index: 6;
	min-width: 17em; max-width: min(30em, 86vw); padding: 6px; border-radius: 14px;
	display: flex; flex-direction: column; gap: 2px;
	border: 1px solid var(--f2f-line); background: var(--f2f-panel, #1d1c1a);
	box-shadow: 0 14px 34px -12px rgba(0,0,0,.55);
}
.f2f-mp-item {
	display: flex; align-items: center; gap: 10px; width: 100%; cursor: pointer;
	padding: 9px 10px; border: 0; border-radius: 9px; background: transparent;
	color: var(--f2f-ink-2); text-align: left; font-size: 13px; line-height: 1.35;
}
.f2f-mp-item:hover, .f2f-mp-item:focus-visible { background: var(--f2f-hover); color: var(--f2f-ink); }
.f2f-mp-item[aria-checked="true"] { color: var(--f2f-ink); }
.f2f-mp-check { width: 14px; height: 14px; flex: none; color: var(--f2f-coral); }
.f2f-mp-label { min-width: 0; overflow-wrap: anywhere; }
`;

const ICON = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", viewBox: "0 0 24 24" } as const;

/** The five fields of the voice the picker reads: the voice object itself changes with every word, these do not. */
export function sameMicVoice({ voice: a }: { voice: MicPickerVoice }, { voice: b }: { voice: MicPickerVoice }): boolean {
	return (
		a.micDevices === b.micDevices &&
		a.micDeviceId === b.micDeviceId &&
		a.micLabel === b.micLabel &&
		a.micSilent === b.micSilent &&
		a.setMicDevice === b.setMicDevice
	);
}

/** The input menu: which microphone the conversation listens through, changeable without ending it. Re-renders only when one of those five fields moves. */
export const MicPicker = memo(function MicPicker({ voice }: { voice: MicPickerVoice }) {
	const { micDevices, micDeviceId, micLabel, micSilent, setMicDevice } = voice;
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const items = useMemo(() => describeMicMenu({ micDevices, micDeviceId, micLabel }), [micDevices, micDeviceId, micLabel]);

	// Clicking anywhere else dismisses it.
	useEffect(() => {
		if (!open) return;
		const away = (e: PointerEvent) => {
			if (!root.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", away);
		return () => document.removeEventListener("pointerdown", away);
	}, [open]);

	// Opening puts the keyboard on the live entry.
	useEffect(() => {
		if (!open) return;
		const entries = root.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
		(root.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? entries?.[0])?.focus();
	}, [open]);

	if (items.length === 0) return null;

	const close = () => {
		setOpen(false);
		button.current?.focus();
	};
	const choose = (id: string) => {
		setMicDevice(id);
		close();
	};
	const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
		const entries = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
		const at = entries.indexOf(document.activeElement as HTMLElement);
		const move = (to: number) => {
			e.preventDefault();
			entries[(to + entries.length) % entries.length]?.focus();
		};
		if (e.key === "ArrowDown") move(at + 1);
		else if (e.key === "ArrowUp") move(at - 1);
		else if (e.key === "Home") move(0);
		else if (e.key === "End") move(entries.length - 1);
		else if (e.key === "Escape") {
			// Closes the menu, not the surface: a handled Esc is not a "leave" (see `isLeaveKey`).
			e.preventDefault();
			close();
		} else if (e.key === "Tab") setOpen(false);
	};

	return (
		<div className="f2f-mp" ref={root}>
			<style>{MIC_PICKER_STYLES}</style>
			<button
				type="button"
				ref={button}
				className="f2f-btn f2f-mp-btn"
				aria-haspopup="menu"
				aria-expanded={open}
				data-warn={micSilent}
				onClick={() => setOpen(!open)}
			>
				<span className="f2f-mp-name">{micName(micLabel) ?? "Microphone"}</span>
				<svg {...ICON} className="f2f-mp-chev" aria-hidden="true">
					<path d="M6 9l6 6 6-6" />
				</svg>
			</button>
			{open && (
				<div className="f2f-mp-menu f2f-fade" role="menu" aria-label="Microphone" onKeyDown={onMenuKey}>
					{items.map(item => (
						<button
							key={item.id}
							type="button"
							role="menuitemradio"
							aria-checked={item.checked}
							className="f2f-mp-item"
							onClick={() => choose(item.id)}
						>
							<span className="f2f-mp-check" aria-hidden="true">
								{item.checked && (
									<svg {...ICON} width="14" height="14">
										<path d="M5 12.5l4.5 4.5L19 7.5" />
									</svg>
								)}
							</span>
							<span className="f2f-mp-label">{item.label}</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}, sameMicVoice);
