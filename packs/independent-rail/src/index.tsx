// An INDEPENDENT session rail, assembled from published parts.
//
// Parts from @fraym/ui:
//   `SessionRail`          — THE session catalog: groups, rows, compact mode,
//                            drag-reorder, rename, flyouts. It was ALREADY pure
//                            (props + ReactNode sockets, no context, no store,
//                            no driver), which is why this pack needs no
//                            reimplementation of the list itself.
//   `FraymRailBrand` · `FraymRailActions` · `FraymRailSessionBar` ·
//   `FraymRailFooter` · `StoreMigrationCard`
//                          — the chrome that mounts in SessionRail's sockets.
//   `useRailGroupAction` · `useRailSessionPresence` · `useRailActionSet`
//                          — the assembly hooks. These carry decisions a third
//                            party could NOT re-derive from the facts: that
//                            blocked-on-the-human outranks a live vibr signal,
//                            that reorder anchors trade with the RENDERED
//                            neighbour rather than the registry's, and that a
//                            primary create action is never droppable. A rail
//                            that reimplemented them would look right and lie
//                            about state.
//   `useObservable` · `useSettings`
//                          — the store-subscription brick and the user's rail
//                            style preference.
//
// Imports from our rail implementation: NOTHING. The reference composes these
// same parts (shell/fraym-frame-rail-core.tsx), so parity is structural — what
// is OURS here is the section wiring: the channel unpacking, the composition
// order, the memo boundary, and the search-ref fallback.
import {
	FraymRailActions,
	FraymRailBrand,
	FraymRailFooter,
	FraymRailSessionBar,
	SessionRail,
	StoreMigrationCard,
	useObservable,
	useRailActionSet,
	useRailGroupAction,
	useRailSessionPresence,
	useSettings,
} from "@fraym/ui";
import { type ComponentProps, memo, type ReactNode, useMemo, useRef } from "react";

/** The prop shape this section uses, declared structurally.
 *
 *  NO tsconfig on purpose (and so no typecheck of these shapes). The pattern
 *  this avoids: the retired rail-t3 pack typed itself by extending
 *  `../../../fraym/tsconfig.base.json`, which only resolves while the pack sits
 *  beside the fraym checkout — exactly the coupling this pack does not have. It
 *  builds byte-identically from a bare directory with vite and nothing else.
 *  The alternative — a hand-written `@fraym/ui` ambient declaration — would be a
 *  SECOND source of truth for the contract, free to drift silently. Until the
 *  host publishes real types for the granted surface, these shapes are
 *  documentation plus the live parity gate, and the gate is what catches
 *  divergence. */
interface RailSectionProps {
	/** The facts channel: the session fold plus the chrome facts. */
	readonly rail: {
		subscribe: (fn: () => void) => () => void;
		getSnapshot: () => RailFacts;
	};
	/** Every mutation this rail may ask for, as verbs. */
	readonly actions: RailActions;
	/** What the host offers a creation gesture. */
	readonly capabilities: { readonly agents?: unknown; readonly bodies?: unknown };
	/** The host-resolved space switcher, already elided when it does not apply. */
	readonly switcher?: ReactNode;
}

type RailFacts = {
	readonly identity: {
		readonly version: string;
		readonly productLabel: string;
		readonly userName: string;
		readonly userAvatarUrl?: string;
		readonly planLabel: string;
	};
	readonly mode: { readonly app: string; readonly rail: string; readonly activeSurface: unknown };
	readonly sessions: ComponentProps<typeof SessionRail>["groups"];
	readonly spaces: unknown;
	readonly projectLabel: string;
	readonly search: { readonly open: boolean; readonly value: string; readonly inputRef?: unknown };
	readonly menu: unknown;
	readonly renamingItemId?: string | null;
	readonly presence: Parameters<typeof useRailSessionPresence>[0];
	readonly storeMigration?: unknown;
};

type RailActions = {
	toggleCompact: () => void;
	intent: (intent: unknown) => void;
	setSearch: (value: string) => void;
	setSearchOpen: (open: boolean | ((current: boolean) => boolean)) => void;
	openFilterMenu: (event: never) => void;
	openUserMenu: (event: never) => void;
	sessionContextMenu: ComponentProps<typeof SessionRail>["onSessionContextMenu"];
	resolveSession?: ComponentProps<typeof SessionRail>["onResolveSession"];
	reopenSession?: ComponentProps<typeof SessionRail>["onReopenSession"];
	dismissReopenRequest?: ComponentProps<typeof SessionRail>["onDismissReopenRequest"];
	newSession?: (workspace?: never) => void;
	newSessionAs?: (agentName: string, workspace?: never) => void;
	newSessionOn?: (harnessId: string, workspace?: never) => void;
	openProjectFilter?: (project: string, event: never) => void;
	selectSession?: ComponentProps<typeof SessionRail>["onSessionClick"];
	sessionMultiContextMenu?: ComponentProps<typeof SessionRail>["onSessionMultiContextMenu"];
	groupContextMenu?: ComponentProps<typeof SessionRail>["onGroupContextMenu"];
	reorderProject?: (workspace: never, direction: "up" | "down", anchorWorkspaceId?: string) => void;
	renameItem?: ComponentProps<typeof SessionRail>["onRenameItem"];
	showAllActivity?: ComponentProps<typeof SessionRail>["onShowAllActivity"];
};

/** The rail section, assembled from the parts.
 *
 *  Memoized at the boundary for the same reason the reference is: the facts
 *  observable re-publishes on every catalog movement, and the catalog is the
 *  most frequently moving fold in the app. */
export const IndependentRailSection = memo(function IndependentRailSection({
	rail,
	actions,
	capabilities,
	switcher,
}: RailSectionProps) {
	const facts = useObservable(rail);
	const { config } = useSettings();
	const compact = facts.mode.rail === "compact";
	// The host's search input ref when it published one; otherwise our own. The
	// shipped session bar REQUIRES a ref object, and a rail with no host ref
	// should simply never receive programmatic focus — not crash.
	const ownSearchRef = useRef<HTMLInputElement | null>(null);
	const searchInputRef = (facts.search.inputRef ?? ownSearchRef) as ComponentProps<
		typeof FraymRailSessionBar
	>["searchInputRef"];

	// The three assembly hooks — the pieces with judgement in them.
	const renderGroupAction = useRailGroupAction(facts.sessions, {
		onNewSession: actions.newSession as Parameters<typeof useRailGroupAction>[1]["onNewSession"],
		onOpenProjectFilter: actions.openProjectFilter as Parameters<
			typeof useRailGroupAction
		>[1]["onOpenProjectFilter"],
		onReorderProject: actions.reorderProject as Parameters<typeof useRailGroupAction>[1]["onReorderProject"],
	});
	const renderSessionPresence = useRailSessionPresence(facts.presence);
	const railActions = useRailActionSet(
		facts.spaces as Parameters<typeof useRailActionSet>[0],
		facts.mode.app as Parameters<typeof useRailActionSet>[1],
	);

	// The three sockets are MEMOIZED, matching the reference exactly
	// (fraym-frame-rail-core.tsx memoizes brand, actions and sessionBar). Built
	// inline they would hand `SessionRail` fresh element identities every render
	// where the shipped rail hands it stable ones — identical pixels, but the
	// parity claim would be visual rather than structural, in the component this
	// pack calls the most frequently moving fold in the app. Found in review.
	const brand = useMemo(
		() => <FraymRailBrand version={facts.identity.version} compact={compact} onToggle={actions.toggleCompact} />,
		[facts.identity.version, compact, actions.toggleCompact],
	);
	const railActionsNode = useMemo(
		() => (
			<FraymRailActions
				actions={railActions}
				onNewSession={actions.newSession as ComponentProps<typeof FraymRailActions>["onNewSession"]}
				newSessionAgents={capabilities.agents as ComponentProps<typeof FraymRailActions>["newSessionAgents"]}
				newSessionBodies={capabilities.bodies as ComponentProps<typeof FraymRailActions>["newSessionBodies"]}
				onNewSessionOn={actions.newSessionOn as ComponentProps<typeof FraymRailActions>["onNewSessionOn"]}
				onNewSessionAs={actions.newSessionAs as ComponentProps<typeof FraymRailActions>["onNewSessionAs"]}
				onIntent={actions.intent as ComponentProps<typeof FraymRailActions>["onIntent"]}
				activeSurface={facts.mode.activeSurface as ComponentProps<typeof FraymRailActions>["activeSurface"]}
			/>
		),
		[railActions, actions, capabilities.agents, capabilities.bodies, facts.mode.activeSurface],
	);
	const sessionBar = useMemo(
		() => (
			<FraymRailSessionBar
				projectLabel={facts.projectLabel}
				menu={facts.menu as ComponentProps<typeof FraymRailSessionBar>["menu"]}
				sessionSearchOpen={facts.search.open}
				sessionSearch={facts.search.value}
				searchInputRef={searchInputRef}
				onSessionSearchChange={actions.setSearch}
				onSessionSearchOpenChange={actions.setSearchOpen}
				onOpenFilterMenu={actions.openFilterMenu as ComponentProps<typeof FraymRailSessionBar>["onOpenFilterMenu"]}
			/>
		),
		[
			facts.projectLabel,
			facts.menu,
			facts.search.open,
			facts.search.value,
			searchInputRef,
			actions.setSearch,
			actions.setSearchOpen,
			actions.openFilterMenu,
		],
	);
	return (
		<SessionRail
			brand={brand}
			tabs={switcher}
			actions={railActionsNode}
			sessionBar={sessionBar}
			notice={
				<StoreMigrationCard
					snapshot={facts.storeMigration as ComponentProps<typeof StoreMigrationCard>["snapshot"]}
					compact={compact}
				/>
			}
			groups={facts.sessions}
			compact={compact}
			style={config.sessionRailStyle}
			onSessionClick={actions.selectSession}
			onSessionContextMenu={actions.sessionContextMenu}
			onResolveSession={actions.resolveSession}
			onReopenSession={actions.reopenSession}
			onDismissReopenRequest={actions.dismissReopenRequest}
			onSessionMultiContextMenu={actions.sessionMultiContextMenu}
			onGroupContextMenu={actions.groupContextMenu}
			groupAction={renderGroupAction}
			sessionPresence={renderSessionPresence}
			renamingItemId={facts.renamingItemId}
			onRenameItem={actions.renameItem}
			onShowAllActivity={actions.showAllActivity}
			footer={
				<FraymRailFooter
					userName={facts.identity.userName}
					userAvatarUrl={facts.identity.userAvatarUrl}
					planLabel={facts.identity.planLabel}
					productLabel={facts.identity.productLabel}
					compact={compact}
					onOpenUserMenu={actions.openUserMenu as ComponentProps<typeof FraymRailFooter>["onOpenUserMenu"]}
				/>
			}
		/>
	);
});

/** The declarative half — the host validates id/contract against its own
 *  manifest record, so what matters here is that the implementation names the
 *  contract version it speaks. */
export const implementation = {
	specVersion: 2,
	id: "independent-rail",
	slot: "rail",
	component: IndependentRailSection,
} as const;

/** The bundle contract (doc 68 §16.2): the host takes the default export. */
export default IndependentRailSection;
