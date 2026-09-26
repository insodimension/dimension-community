// The human's gate on every post. The agent filled the compose page and
// parked the publish; nothing is submitted until Post here. The bar shows
// where it goes (the compose page URL, the profile) and every exact value,
// and afterwards what the page said: the posted URL, or why it did not (or
// may not have) posted. Post and Cancel are the only callers of the app-only
// confirm and cancel tools.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PublishRecord, PublishStatus } from "../../src/contracts";
import { Icon } from "@fraym/ui/icons";
import { type BrowserClient, failureText } from "./browser-client";

const OUTCOME: Record<Exclude<PublishStatus, "awaiting-confirmation">, string> = {
	posted: "Posted",
	unknown: "May have posted. Check the page before trying again.",
	failed: "Not posted",
	cancelled: "Cancelled. Nothing was posted.",
	expired: "Expired. Nothing was posted.",
};

/** Two or fewer values this short show whole: no scroll box to hunt through. */
const FIT_MAX_FIELDS = 2;
const FIT_MAX_CHARS = 280;
const FIT_MAX_LINES = 4;

export interface PublishBarProps {
	readonly client: BrowserClient;
	readonly browserId: string;
	readonly publish: PublishRecord;
	/** The call settled: pull fresh state so the page and the record agree. */
	readonly onSettled: () => void;
	readonly onDismiss: () => void;
}

export function PublishBar({ client, browserId, publish, onSettled, onDismiss }: PublishBarProps) {
	const [step, setStep] = useState<"idle" | "posting" | "cancelling">("idle");
	/** The record a call answered, shown until the poll catches up. */
	const [answered, setAnswered] = useState<PublishRecord | null>(null);
	const [error, setError] = useState<string | null>(null);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const record = answered?.publishId === publish.publishId && publish.status === "awaiting-confirmation" ? answered : publish;
	const busy = step !== "idle";

	// The fields list fades its bottom edge while more of it is below the fold.
	const fieldsRef = useRef<HTMLOListElement | null>(null);
	const [clipped, setClipped] = useState(false);
	const measure = useCallback(() => {
		const list = fieldsRef.current;
		setClipped(list !== null && list.scrollTop + list.clientHeight < list.scrollHeight - 1);
	}, []);
	useLayoutEffect(() => {
		const list = fieldsRef.current;
		if (list === null) return;
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(list);
		return () => observer.disconnect();
	}, [measure, record.publishId, record.status]);

	const decide = async (verb: "post" | "cancel") => {
		if (busy) return;
		setStep(verb === "post" ? "posting" : "cancelling");
		setError(null);
		try {
			const next = verb === "post" ? await client.confirmPublish(browserId, record.publishId) : await client.cancelPublish(browserId, record.publishId);
			if (mounted.current) setAnswered(next);
		} catch (cause) {
			if (mounted.current) setError(failureText(cause));
		} finally {
			if (mounted.current) setStep("idle");
			onSettled();
		}
	};

	if (record.status !== "awaiting-confirmation") {
		return (
			<div className="bx-publish" data-status={record.status} role="status">
				<div className="bx-publish-row">
					<span className="bx-publish-mark" aria-hidden="true">
						<Icon name={record.status === "posted" ? "check" : record.status === "cancelled" || record.status === "expired" ? "x" : "warnTri"} size={14} strokeWidth={2.25} />
					</span>
					<span className="bx-publish-text">
						<span className="bx-publish-title">{OUTCOME[record.status]}</span>
						{record.status === "posted" && record.url !== undefined && <span className="bx-publish-url">{record.url}</span>}
						{record.status !== "posted" && record.error !== undefined && <span className="bx-publish-detail">{record.error}</span>}
					</span>
					<button type="button" className="bx-toast-close" aria-label="Dismiss" onClick={onDismiss}>
						<Icon name="x" size={13} strokeWidth={2.25} />
					</button>
				</div>
			</div>
		);
	}

	const expires = new Date(record.expiresAt);
	const fits =
		record.fields.length <= FIT_MAX_FIELDS &&
		record.fields.every(field => field.value.length <= FIT_MAX_CHARS && field.value.split("\n").length <= FIT_MAX_LINES);
	return (
		<section className="bx-publish" aria-label="Confirm post" aria-busy={busy || undefined}>
			<div className="bx-publish-row">
				<span className="bx-publish-mark" aria-hidden="true">
					<Icon name="send" size={14} strokeWidth={2.25} />
				</span>
				<span className="bx-publish-text">
					<span className="bx-publish-title">
						Post to <span className="bx-publish-key">{record.composeUrl || record.origin}</span> from browser profile{" "}
						<span className="bx-publish-key">{record.profile}</span>?
					</span>
					<span className="bx-publish-detail">
						Nothing is sent until you press Post.
						{Number.isFinite(expires.getTime()) && (
							<>
								{" "}
								Expires <span className="bx-publish-num">{expires.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>.
							</>
						)}
					</span>
				</span>
			</div>
			<h3 className="bx-publish-heading" id={`bx-publish-heading-${record.publishId}`}>
				What will be posted
			</h3>
			<ol
				ref={fieldsRef}
				className="bx-publish-fields"
				aria-labelledby={`bx-publish-heading-${record.publishId}`}
				tabIndex={fits ? undefined : 0}
				data-fit={fits || undefined}
				data-clipped={clipped || undefined}
				onScroll={measure}
			>
				{record.fields.map((field, index) => (
					<li key={`${index}:${field.selector}`} className="bx-publish-field">
						<span className="bx-publish-label">{field.label ?? `Field ${index + 1}`}</span>
						<span className="bx-publish-value">{field.value.length > 0 ? field.value : <span className="bx-publish-empty">(empty)</span>}</span>
					</li>
				))}
			</ol>
			{error !== null && (
				<p className="bx-publish-error" role="alert">
					{error}
				</p>
			)}
			<div className="bx-publish-actions">
				<button type="button" className="bx-publish-cancel" disabled={busy} onClick={() => void decide("cancel")}>
					{step === "cancelling" ? "Cancelling…" : "Cancel"}
				</button>
				<button type="button" className="bx-annotate-send bx-publish-post" disabled={busy} onClick={() => void decide("post")}>
					{step === "posting" ? <span className="bx-tab-spinner" aria-hidden="true" /> : <Icon name="send" size={14} strokeWidth={2.25} />}
					{step === "posting" ? "Posting…" : "Post"}
				</button>
			</div>
		</section>
	);
}
