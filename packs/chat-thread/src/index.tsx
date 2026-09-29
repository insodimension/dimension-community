// The CHAT thread section: the conversation and nothing else.
//
// Chat is a personal assistant, not a workbench. The reader wants what was
// said - their words, the assistant's words - and to know the assistant did
// work in between, not to audit it. So this section draws text blocks and ONE
// quiet, non-expandable "Worked for Xs" line per turn, and no tool rows at all
// (`StoreThread density="worked"`, the shared kit contract). Anyone who wants
// the tool cards binds `independent-thread` instead: same seat, other pack.
//
// Parts from @fraym/ui: `StoreThread` (the Store-fed conversation: rows off the
// `session/<id>/transcript` cell, the presence + verb tail off `verb` /
// `isStreaming`, queued-message ghosts, provider notices - it reads ONLY the
// fenced Store this seat is handed, no session provider) and
// `OpeningThreadSkeleton` (the loading face).
//
// Imports from our section implementations: NOTHING. What is OURS here is only
// the section wiring - which session, which density, the queue gestures - and
// the reading column (`styles.ts`).
import { OpeningThreadSkeleton, StoreThread } from "@fraym/ui";
import { type ComponentProps, memo, useCallback, useLayoutEffect } from "react";
import { ensureStyles } from "./styles";

/** The prop shape this section uses, declared structurally - a marketplace
 *  author has no path into the host's internal contract modules, and none is
 *  needed: the host passes these fields, types are erased at build. NO tsconfig
 *  on purpose, exactly like `independent-thread`: the pack builds from a bare
 *  directory with vite and nothing else. */
interface ThreadSectionProps {
	readonly sessionRef: { readonly workspaceId: string; readonly sessionId: string } | null;
	/** The host Store, fenced to this seat's session. `watch` is all a thread needs. */
	readonly store?: ComponentProps<typeof StoreThread>["store"] | null;
	/** The registered session verbs; the queue ghosts' remove / send-now ride these. */
	readonly actions?: {
		readonly removeQueuedMessage: (messageId: string) => Promise<void>;
		readonly interruptRunForQueuedMessage: (messageId?: string) => Promise<void>;
	} | null;
	/** The session's face (its General Agent's) and Mochi's pinned colour axes. */
	readonly avatar?: ComponentProps<typeof StoreThread>["avatar"];
	readonly avatarSkin?: ComponentProps<typeof StoreThread>["skin"];
	/** The transcript is not paintable yet: show the loading face, never a blank. */
	readonly opening: boolean;
}

function ChatThreadSection(props: ThreadSectionProps) {
	useLayoutEffect(() => ensureStyles(), []);
	const { actions, avatar, avatarSkin, opening, sessionRef, store } = props;
	const onRemoveQueuedMessage = useCallback((id: string) => void actions?.removeQueuedMessage(id), [actions]);
	const onSendQueuedMessage = useCallback((id: string) => void actions?.interruptRunForQueuedMessage(id), [actions]);
	// Still the loading face while the transcript is merely UNKNOWN: the same
	// skeleton part the classic thread shows, so the opening transition is one
	// skeleton -> content, never skeleton -> void -> content.
	const loading = opening ? <OpeningThreadSkeleton /> : undefined;
	return (
		<div data-slot="chat-thread">
			{store?.watch && sessionRef ? (
				<StoreThread
					store={store}
					sessionId={sessionRef.sessionId}
					density="worked"
					avatar={avatar}
					skin={avatarSkin}
					empty={loading}
					// `fr-scroll-stable` / `overscroll-contain` are the classic thread's own
					// scroller classes: the scrollbar gutter is reserved on both edges so the
					// column does not shift when a scrollbar appears.
					className="fr-scroll-stable overscroll-contain"
					{...(actions ? { onRemoveQueuedMessage, onSendQueuedMessage } : {})}
				/>
			) : (
				loading
			)}
		</div>
	);
}

// memo: the host mount re-renders per fold flush, but this section's props are
// identity-stable across flushes, so only the Store subscriptions inside
// `StoreThread` re-render the rows.
export default memo(ChatThreadSection);
