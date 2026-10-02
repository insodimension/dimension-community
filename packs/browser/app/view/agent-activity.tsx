// Agent activity over the page. While a task runs: a slim pill — who is
// driving, what it is doing right now, how long, how many steps, Stop —
// that expands into the step list. When it ends: a brief result toast.
import { useEffect, useRef, useState } from "react";
import type { TaskRun, TaskStatus } from "../../src/contracts";
import { Icon } from "@fraym/ui/icons";

const AGENT_LABEL: Record<TaskRun["agent"], string> = { jev: "Jev", "browser-use": "Browser Use" };

const RESULT_LABEL: Record<Exclude<TaskStatus, "running">, string> = {
	done: "Task done",
	blocked: "Task blocked",
	failed: "Task failed",
	cancelled: "Task stopped",
};

export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}:${String(seconds % 60).padStart(2, "0")}` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A clock that keeps moving between state updates while the task runs. */
function useElapsed(task: TaskRun): number {
	const running = task.status === "running";
	const started = Date.parse(task.startedAt);
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!running) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [running, task.id]);
	return running && Number.isFinite(started) ? now - started : task.elapsedMs;
}

export interface AgentPillProps {
	readonly task: TaskRun;
	readonly cancelling: boolean;
	readonly onCancel: () => void;
}

export function AgentPill({ task, cancelling, onCancel }: AgentPillProps) {
	const [expanded, setExpanded] = useState(false);
	const elapsed = useElapsed(task);
	const latest = task.steps[task.steps.length - 1];
	const current = latest?.action ?? "Starting up…";

	return (
		<div className="bx-agent" data-expanded={expanded || undefined} role="group" aria-label={`${AGENT_LABEL[task.agent]} is working`}>
			<div className="bx-agent-row">
				<span className="bx-agent-mark" aria-hidden="true">
					<Icon name="bot" size={15} strokeWidth={2} />
				</span>
				<span className="bx-agent-name">{AGENT_LABEL[task.agent]}</span>
				<span className="bx-agent-step" role="status" aria-live="polite">
					{current}
				</span>
				<span className="bx-agent-meta">
					<span>{task.stepCount} step{task.stepCount === 1 ? "" : "s"}</span>
					<span className="bx-agent-sep" aria-hidden="true" />
					<span className="bx-num">{formatElapsed(elapsed)}</span>
				</span>
				<button
					type="button"
					className="bx-agent-toggle"
					aria-label={expanded ? "Hide steps" : "Show steps"}
					aria-expanded={expanded}
					onClick={() => setExpanded(open => !open)}
				>
					<Icon name="caretD" size={14} strokeWidth={2.25} />
				</button>
				<button type="button" className="bx-agent-stop" disabled={cancelling} onClick={onCancel}>
					{cancelling ? "Stopping…" : "Stop"}
				</button>
			</div>
			{expanded && (
				<div className="bx-agent-body">
					<p className="bx-agent-goal">{task.task}</p>
					{task.steps.length === 0 ? (
						<p className="bx-agent-empty">Waiting for the first step…</p>
					) : (
						<ol className="bx-agent-steps">
							{task.steps.toReversed().map(step => (
								<li key={step.n}>
									<span className="bx-num">{step.n}</span>
									<span className="bx-agent-steptext">{step.action}</span>
									<span className="bx-num bx-agent-steptime">{formatElapsed(step.elapsedMs)}</span>
								</li>
							))}
						</ol>
					)}
				</div>
			)}
		</div>
	);
}

export interface ResultToastProps {
	readonly task: TaskRun;
	readonly onDismiss: () => void;
}

export function ResultToast({ task, onDismiss }: ResultToastProps) {
	const dismissRef = useRef(onDismiss);
	dismissRef.current = onDismiss;
	useEffect(() => {
		const timer = window.setTimeout(() => dismissRef.current(), 9000);
		return () => window.clearTimeout(timer);
	}, [task.id]);
	if (task.status === "running") return null;
	return (
		<div className="bx-toast" data-status={task.status} role="status">
			<span className="bx-toast-icon" aria-hidden="true">
				<Icon name={task.status === "done" ? "check" : task.status === "failed" ? "warnTri" : task.status === "blocked" ? "hand" : "square"} size={14} strokeWidth={2.25} />
			</span>
			<span className="bx-toast-text">
				<span className="bx-toast-title">
					{RESULT_LABEL[task.status]}
					<span className="bx-toast-meta">
						{" "}
						· {task.stepCount} step{task.stepCount === 1 ? "" : "s"} · {formatElapsed(task.elapsedMs)}
					</span>
				</span>
				{task.summary.length > 0 && <span className="bx-toast-summary">{task.summary}</span>}
			</span>
			<button type="button" className="bx-toast-close" aria-label="Dismiss" onClick={onDismiss}>
				<Icon name="x" size={13} strokeWidth={2.25} />
			</button>
		</div>
	);
}

/** An agent's page action is "now" for this long. Long enough to bridge its pauses between calls, short enough to be gone when it is. */
export const AGENT_ACTIVE_MS = 12_000;

/** True from an agent's action (`at`, epoch ms) until AGENT_ACTIVE_MS later, re-rendering when it ends; same machine, same clock. */
export function useAgentActive(at: number | null): boolean {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (at === null) return;
		const left = at + AGENT_ACTIVE_MS - Date.now();
		if (left <= 0) return;
		setNow(Date.now());
		const timer = window.setTimeout(() => setNow(Date.now()), left + 50);
		return () => window.clearTimeout(timer);
	}, [at]);
	return at !== null && now - at < AGENT_ACTIVE_MS;
}

export interface ControlPillProps {
	/** The person has the wheel. Otherwise an agent is acting and the pill offers it. */
	readonly takenOver: boolean;
	readonly busy: boolean;
	readonly onTakeOver: () => void;
	readonly onHandBack: () => void;
}

/** Who is driving, when it is not just the person: "your agent is working here" with Take over, and "you have control" with Hand back. */
export function ControlPill({ takenOver, busy, onTakeOver, onHandBack }: ControlPillProps) {
	return (
		<div className="bx-control" data-state={takenOver ? "yours" : "agent"} role="status" aria-live="polite">
			<span className="bx-control-mark" aria-hidden="true">
				{takenOver ? <Icon name="hand" size={14} strokeWidth={2} /> : <span className="bx-dot" />}
			</span>
			<span className="bx-control-text">
				<span className="bx-control-title">{takenOver ? "You have control" : "Your agent is working here"}</span>
				<span className="bx-control-sub">{takenOver ? "Your agent is paused until you hand back." : "Take over to stop it and use the page yourself."}</span>
			</span>
			<button type="button" className="bx-control-btn" disabled={busy} onClick={takenOver ? onHandBack : onTakeOver}>
				{takenOver ? "Hand back" : "Take over"}
			</button>
		</div>
	);
}
