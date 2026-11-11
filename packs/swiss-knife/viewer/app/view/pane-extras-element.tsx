import {
	AnnotationNotice,
	ElementPicker,
	ElementToolbar,
	NotePopover,
	useElementPicks,
	useElementShortcuts,
} from "@dimension/mcp-app-kit/annotate/react";
import { MAX_NOTE_CHARS, type PickKeyIntent, pageScriptsRun, setPageScripts } from "@dimension/mcp-app-kit/annotate";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Footer, type PaneExtrasProps, revisionOf, Strip, useSlot } from "./pane-shared";

const HTML_FRAME = '[data-slot="viewer-html-frame"]';
const FALLBACK_ANCHOR = { x: 8, y: 28, width: 24, height: 24 };

export function ElementPicks({ app, tab, active, ready, frame, mode, store }: PaneExtrasProps): ReactNode {
	const slot = useSlot(frame, ready, HTML_FRAME);
	const reading = slot instanceof HTMLIFrameElement ? slot : null;
	const up = mode === "elements";
	const [armed, setArmed] = useState(false);
	useEffect(() => {
		if (up) setArmed(false);
	}, [up]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: annotateRequests is the trigger.
	useEffect(() => {
		if (tab.annotateRequests > 0 && up) setArmed(true);
	}, [tab.annotateRequests]);
	const [running, setRunning] = useState(true);
	useEffect(() => setRunning(reading === null || pageScriptsRun(reading)), [reading]);
	const runScripts = useCallback(
		(run: boolean) => {
			if (reading === null) return;
			setArmed(false);
			setPageScripts(reading, run);
			setRunning(run);
		},
		[reading],
	);
	const live = active && up && armed;
	const [unreadable, setUnreadable] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: live and reading are the triggers.
	useEffect(() => setUnreadable(false), [live, reading]);
	const session = useElementPicks({ app, file: tab.path, rev: revisionOf(tab), autoStage: active && up, store });
	const { picks, retarget } = session;
	const [openId, setOpenId] = useState<number | null>(null);
	const [bounds, setBounds] = useState({ width: 0, height: 0 });
	useEffect(() => {
		if (frame === null) return;
		const measure = () => {
			const width = frame.clientWidth || frame.getBoundingClientRect().width || 0;
			const height = frame.clientHeight || frame.getBoundingClientRect().height || 0;
			setBounds(previous => previous.width === width && previous.height === height ? previous : { width, height });
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(frame);
		return () => observer.disconnect();
	}, [frame]);
	useEffect(() => {
		if (openId !== null && !picks.some(pick => pick.id === openId)) setOpenId(null);
	}, [picks, openId]);
	const onIntent = useCallback(
		(intent: PickKeyIntent) => {
			if (intent === "exit") {
				if (openId !== null) setOpenId(null);
				else setArmed(false);
				return;
			}
			const id = openId ?? picks[picks.length - 1]?.id;
			if (id !== undefined) retarget(id, intent === "wider" ? "parent" : "child");
		},
		[openId, picks, retarget],
	);
	useElementShortcuts({ enabled: live, onIntent });
	const openIndex = picks.findIndex(pick => pick.id === openId);
	const opened = picks[openIndex];
	return (
		<>
			{frame === null || reading === null
				? null
				: createPortal(
						<>
							<ElementPicker
								source={reading}
								active={live}
								link={session.link}
								picks={picks}
								openId={openId}
								onOpen={setOpenId}
								onClose={() => setOpenId(null)}
								onNote={session.setNote}
								onRemove={id => {
									session.remove(id);
									setOpenId(null);
								}}
								onRetarget={retarget}
								onPick={session.onPick}
								onMoved={session.onMoved}
								onReady={session.onReady}
								onKey={onIntent}
								onUnpick={session.unpick}
								onUnavailable={setUnreadable}
								label={`Pick from ${tab.filename}`}
								frameSlot="viewer-html-pick-frame"
							/>
							<div className="dam-root dam-pick-navigation-host" data-slot="element-note-host" data-annotate-ignore="">
								<div
									className="dam-pick-access"
									data-slot="element-note-navigation"
									role="region"
									aria-label="Notes on this page"
								>
									{picks.map((pick, index) => (
										<button
											key={pick.id}
											type="button"
											data-slot="element-note-navigation-item"
											onClick={() => setOpenId(pick.id)}
										>
											Note {index + 1}: {pick.target.selector} · {pick.note || "No note yet"}
										</button>
									))}
								</div>
								{!live && opened !== undefined && (
									<NotePopover
										key={opened.id}
										anchor={FALLBACK_ANCHOR}
										bounds={bounds}
										number={openIndex + 1}
										heading={<span title={opened.target.selector}>{opened.target.selector}</span>}
										headingStyle="code"
										note={opened.note}
										maxLength={MAX_NOTE_CHARS}
										label={`Note ${openIndex + 1}`}
										onChange={note => session.setNote(opened.id, note)}
										onClose={() => setOpenId(null)}
										onDelete={() => {
											session.remove(opened.id);
											setOpenId(null);
										}}
										isOpener={target =>
											target instanceof Element && target.closest('[data-slot="element-note-navigation-item"]') !== null
										}
									/>
								)}
							</div>
						</>,
						frame,
					)}
			{up ? (
				<Strip frame={frame}>
					<ElementToolbar
						onWholePage={session.pickWholePage}
						armed={armed}
						onArm={setArmed}
						unavailable={unreadable}
						full={session.full}
						placement="strip"
						scripts={reading === null ? undefined : { running, onRun: runScripts }}
					/>
				</Strip>
			) : null}
			{up ? (
				<Footer frame={frame}>
					<AnnotationNotice status={session.status} />
				</Footer>
			) : null}
		</>
	);
}
