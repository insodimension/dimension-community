// The human's gate on every post. The agent filled the compose page and
// parked the publish; nothing is submitted until Post here. The bar shows
// where it goes (origin host, profile) and every exact value, and afterwards
// what the page said: the posted URL, or why it did not (or may not have)
// posted. Post and Cancel are the only callers of the app-only confirm and
// cancel tools.
import { useEffect, useRef, useState } from "react";
import type { PublishRecord, PublishStatus } from "../../src/contracts";
import { Icon } from "@fraym/ui/icons";
import { type BrowserClient, failureText } from "./browser-client";

const OUTCOME: Record<Exclude<PublishStatus, "awaiting-confirmation">, string> = {
	posted: "Posted",
	unknown: "May have posted — check the page before trying again",
	failed: "Not posted",
	cancelled: "Cancelled — nothing was posted",
	expired: "Expired — nothing was posted",
};

function hostOf(origin: string): string {
	try {
		return new URL(origin).host;
	} catch {
		return origin;
	}
}

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
	return (
		<section className="bx-publish" aria-label="Confirm post" aria-busy={busy || undefined}>
			<div className="bx-publish-row">
				<span className="bx-publish-mark" aria-hidden="true">
					<Icon name="send" size={14} strokeWidth={2.25} />
				</span>
				<span className="bx-publish-text">
					<span className="bx-publish-title">
						Post to {hostOf(record.origin)} as profile {record.profile}?
					</span>
					<span className="bx-publish-detail">
						Nothing is sent until you press Post.
						{Number.isFinite(expires.getTime()) && ` Expires ${expires.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`}
					</span>
				</span>
			</div>
			<ol className="bx-publish-fields" aria-label="What will be posted" tabIndex={0}>
				{record.fields.map((field, index) => (
					<li key={`${index}:${field.selector}`} className="bx-publish-field">
						{field.value.length > 0 ? field.value : <span className="bx-publish-empty">(empty)</span>}
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
				<button type="button" className="bx-annotate-send" disabled={busy} onClick={() => void decide("post")}>
					{step === "posting" ? (
						"Posting…"
					) : (
						<>
							<Icon name="send" size={14} strokeWidth={2.25} />
							Post
						</>
					)}
				</button>
			</div>
		</section>
	);
}
