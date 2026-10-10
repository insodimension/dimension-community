import { FraymRailActions, FraymRailBrand, FraymRailFooter, FraymRailSessionBar, SessionRail, StoreMigrationCard, useObservable, useRailActionSet, useRailGroupAction, useRailSessionPresence, useSettings } from "@fraym/ui";
import { memo, useMemo, useRef } from "react";
import { jsx } from "react/jsx-runtime";
//#region src/index.tsx
/** The rail section, assembled from the parts.
*
*  Memoized at the boundary for the same reason the reference is: the facts
*  observable re-publishes on every catalog movement, and the catalog is the
*  most frequently moving fold in the app. */
var IndependentRailSection = memo(function IndependentRailSection({ rail, actions, capabilities, switcher }) {
	const facts = useObservable(rail);
	const { config } = useSettings();
	const compact = facts.mode.rail === "compact";
	const ownSearchRef = useRef(null);
	const searchInputRef = facts.search.inputRef ?? ownSearchRef;
	const renderGroupAction = useRailGroupAction(facts.sessions, {
		onNewSession: actions.newSession,
		onOpenProjectFilter: actions.openWorkspaceFilter,
		onReorderProject: actions.reorderWorkspace
	});
	const renderSessionPresence = useRailSessionPresence(facts.presence);
	const railActions = useRailActionSet(facts.spaces, facts.mode.app);
	return /* @__PURE__ */ jsx(SessionRail, {
		brand: useMemo(() => /* @__PURE__ */ jsx(FraymRailBrand, {
			version: facts.identity.version,
			compact,
			onToggle: actions.toggleCompact
		}), [
			facts.identity.version,
			compact,
			actions.toggleCompact
		]),
		tabs: switcher,
		actions: useMemo(() => /* @__PURE__ */ jsx(FraymRailActions, {
			actions: railActions,
			onNewSession: actions.newSession,
			newSessionAgents: capabilities.agents,
			newSessionBodies: capabilities.bodies,
			onNewSessionOn: actions.newSessionOn,
			onNewSessionAs: actions.newSessionAs,
			onIntent: actions.intent,
			activeSurface: facts.mode.activeSurface
		}), [
			railActions,
			actions,
			capabilities.agents,
			capabilities.bodies,
			facts.mode.activeSurface
		]),
		sessionBar: useMemo(() => /* @__PURE__ */ jsx(FraymRailSessionBar, {
			workspaceLabel: facts.workspaceLabel,
			menu: facts.menu,
			sessionSearchOpen: facts.search.open,
			sessionSearch: facts.search.value,
			searchInputRef,
			onSessionSearchChange: actions.setSearch,
			onSessionSearchOpenChange: actions.setSearchOpen,
			onOpenFilterMenu: actions.openFilterMenu
		}), [
			facts.workspaceLabel,
			facts.menu,
			facts.search.open,
			facts.search.value,
			searchInputRef,
			actions.setSearch,
			actions.setSearchOpen,
			actions.openFilterMenu
		]),
		notice: /* @__PURE__ */ jsx(StoreMigrationCard, {
			snapshot: facts.storeMigration,
			compact
		}),
		groups: facts.sessions,
		compact,
		style: config.sessionRailStyle,
		onSessionClick: actions.selectSession,
		onSessionContextMenu: actions.sessionContextMenu,
		onSessionMultiContextMenu: actions.sessionMultiContextMenu,
		onGroupContextMenu: actions.groupContextMenu,
		groupAction: renderGroupAction,
		sessionPresence: renderSessionPresence,
		renamingItemId: facts.renamingItemId,
		onRenameItem: actions.renameItem,
		onShowAllActivity: actions.showAllActivity,
		footer: /* @__PURE__ */ jsx(FraymRailFooter, {
			userName: facts.identity.userName,
			userAvatarUrl: facts.identity.userAvatarUrl,
			planLabel: facts.identity.planLabel,
			productLabel: facts.identity.productLabel,
			compact,
			onOpenUserMenu: actions.openUserMenu
		})
	});
});
/** The declarative half — the host validates id/contract against its own
*  manifest record, so what matters here is that the implementation names the
*  contract version it speaks. */
var implementation = {
	specVersion: 2,
	id: "independent-rail",
	slot: "rail",
	component: IndependentRailSection
};
//#endregion
export { IndependentRailSection, IndependentRailSection as default, implementation };
