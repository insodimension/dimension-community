import { OpeningThreadSkeleton, StoreThread } from "@fraym/ui";
import { memo, useCallback, useLayoutEffect } from "react";
import { jsx } from "react/jsx-runtime";
//#region src/styles.ts
var STYLE_SLOT = "chat-thread-styles";
var EMBER_THREAD_CSS = `
[data-slot="chat-thread"] {
	display: flex;
	flex: 1 1 0%;
	flex-direction: column;
	min-height: 0;
	min-width: 0;
}
[data-slot="chat-thread"] > [data-slot="store-thread"] {
	padding-block: 32px 48px;
	padding-inline: max(28px, calc((100% - var(--fr-thread-w, 780px)) / 2 + 28px));
}
`;
function ensureStyles() {
	if (typeof document === "undefined") return;
	if (document.head.querySelector(`style[data-slot="chat-thread-styles"]`)) return;
	const style = document.createElement("style");
	style.dataset.slot = STYLE_SLOT;
	style.textContent = EMBER_THREAD_CSS;
	document.head.appendChild(style);
}
//#endregion
//#region src/index.tsx
function ChatThreadSection(props) {
	useLayoutEffect(() => ensureStyles(), []);
	const { actions, avatar, avatarSkin, opening, sessionRef, store } = props;
	const onRemoveQueuedMessage = useCallback((id) => void actions?.removeQueuedMessage(id), [actions]);
	const onSendQueuedMessage = useCallback((id) => void actions?.interruptRunForQueuedMessage(id), [actions]);
	const loading = opening ? /* @__PURE__ */ jsx(OpeningThreadSkeleton, {}) : void 0;
	return /* @__PURE__ */ jsx("div", {
		"data-slot": "chat-thread",
		children: store?.watch && sessionRef ? /* @__PURE__ */ jsx(StoreThread, {
			store,
			sessionId: sessionRef.sessionId,
			density: "worked",
			avatar,
			skin: avatarSkin,
			empty: loading,
			className: "fr-scroll-stable overscroll-contain",
			...actions ? {
				onRemoveQueuedMessage,
				onSendQueuedMessage
			} : {}
		}) : loading
	});
}
var src_default = memo(ChatThreadSection);
//#endregion
export { src_default as default };
