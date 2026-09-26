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
	unknown: "May have posted",
	failed: "Not posted",
	cancelled: "Cancelled. Nothing was posted.",
	expired: "Expired. Nothing was posted.",
};

/**
 * The engine's outcome errors, in the human's words. The raw text stays in a
 * tooltip for debugging; an error not listed here is already user copy (the
 * browser closing, the page used while waiting) or is shown as it came.
 */
const DETAIL_COPY: readonly (readonly [prefix: string, copy: string])[] = [
	["submitted, but no receipt was seen", "Submitted, but no confirmation appeared. Check the account before posting again."],
	["submit was clicked, then errored", "Post was pressed on the page, then the page errored. Check the account before posting again."],
	["publishing errored", "Something went wrong while posting. Check the account before posting again."],
	["changed since shown", "The page changed after it was shown here, so nothing was submitted."],
	["submit was not clicked", "The page's post button could not be pressed, so nothing was submitted."],
	["not confirmed within 10 minutes", "Not confirmed within 10 minutes."],
];

/** Both labels share one grid cell, so the button is as wide as the longer one and never resizes. */
function StableLabel({ shown, labels }: { readonly shown: string; readonly labels: readonly string[] }) {
	return (
		<span className="bx-publish-label-slot">
			{labels.map(label => (
				<span key={label} aria-hidden={label === shown ? undefined : true} data-hidden={label === shown ? undefined : true}>
					{label}
				</span>
			))}
		</span>
	);
}

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

	// The fields list fades whichever edge has more of it beyond the fold.
	const fieldsRef = useRef<HTMLOListElement | null>(null);
	const [more, setMore] = useState({ above: false, below: false });
	const measure = useCallback(() => {
		const list = fieldsRef.current;
		const above = list !== null && list.scrollTop > 1;
		const below = list !== null && list.scrollTop + list.clientHeight < list.scrollHeight - 1;
		setMore(current => (current.above === above && current.below === below ? current : { above, below }));
	}, []);
	useLayoutEffect(() => {
		const list = fieldsRef.current;
		if (list === null) return;
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(list);
		return () => observer.disconnect();
	}, [measure, record.publishId, record.status]);

	// A keyboard user must be able to reach the bar: when it appears, and only
	// if this View already has focus (never stealing it from the host), focus
	// moves to the bar itself. Not to Post: a stray Enter there would post.
	// Only from nowhere, the body or the page surface: never out of an input,
	// textarea or contenteditable in the View, where the human is typing. The
	// outcome follows the same rule, so when the pressed button's disappearing
	// drops focus on the body, Tab carries on from the bar.
	const barRef = useRef<HTMLDivElement | null>(null);
	const awaiting = record.status === "awaiting-confirmation";
	useEffect(() => {
		if (!document.hasFocus()) return;
		const active = document.activeElement;
		if (active === null || active === document.body || active.matches(".bx-page")) barRef.current?.focus({ preventScroll: true });
	}, [awaiting, record.publishId]);

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
			<div ref={barRef} className="bx-publish" data-status={record.status} role="status" tabIndex={-1}>
				<div className="bx-publish-row">
					<span className="bx-publish-mark" aria-hidden="true">
						<Icon name={record.status === "posted" ? "check" : record.status === "cancelled" || record.status === "expired" ? "minus" : "warnTri"} size={14} strokeWidth={2.25} />
					</span>
					<span className="bx-publish-text">
						<span className="bx-publish-title">{OUTCOME[record.status]}</span>
						{record.status === "posted" && record.url !== undefined && <span className="bx-publish-url">{record.url}</span>}
						{record.status !== "posted" && record.error !== undefined && (
							<span className="bx-publish-detail" title={record.error}>
								{DETAIL_COPY.find(([prefix]) => record.error?.startsWith(prefix))?.[1] ?? record.error}
							</span>
						)}
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
		<section ref={barRef} className="bx-publish" aria-label="Confirm post" aria-busy={busy || undefined} tabIndex={-1}>
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
			<div className="bx-publish-fields-frame">
				<ol
					ref={fieldsRef}
					className="bx-publish-fields"
					aria-labelledby={`bx-publish-heading-${record.publishId}`}
					tabIndex={fits ? undefined : 0}
					data-fit={fits || undefined}
					data-more-above={more.above || undefined}
					data-more-below={more.below || undefined}
					onScroll={measure}
				>
					{record.fields.map((field, index) => (
						<li key={`${index}:${field.selector}`} className="bx-publish-field">
							<span className="bx-publish-label">{field.label ?? `Field ${index + 1}`}</span>
							<span className="bx-publish-value">{field.value.length > 0 ? field.value : <span className="bx-publish-empty">(empty)</span>}</span>
						</li>
					))}
				</ol>
			</div>
			{error !== null && (
				<p className="bx-publish-error" role="alert">
					{error}
				</p>
			)}
			<div className="bx-publish-actions">
				<button type="button" className="bx-publish-cancel" disabled={busy} onClick={() => void decide("cancel")}>
					<StableLabel shown={step === "cancelling" ? "Cancelling…" : "Cancel"} labels={["Cancel", "Cancelling…"]} />
				</button>
				{/* Busy, not disabled-looking: "Posting…" stays legible for the whole receipt wait. */}
				<button type="button" className="bx-annotate-send bx-publish-post" disabled={busy} data-busy={step === "posting" || undefined} onClick={() => void decide("post")}>
					{step === "posting" ? <span className="bx-tab-spinner" aria-hidden="true" /> : <Icon name="send" size={14} strokeWidth={2.25} />}
					<StableLabel shown={step === "posting" ? "Posting…" : "Post"} labels={["Post", "Posting…"]} />
				</button>
			</div>
		</section>
	);
}
