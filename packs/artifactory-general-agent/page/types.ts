// What the page is mounted with and what it reads, typed STRUCTURALLY: a pack
// bundle imports only the granted `@fraym/ui` surface at runtime, so the host's
// own fact types (packages/app `GeneralAgentFact`, the driver's snapshots) are
// mirrored here field for field, and only the fields the page reads.
import type { ComponentProps } from "react";
import type { PresenceSurface } from "@fraym/ui";
import type { VoiceAssigner, VoiceSampler } from "./voice";

type PresenceProps = ComponentProps<typeof PresenceSurface>;
export type AvatarId = NonNullable<PresenceProps["avatar"]>;
export type BridgedPresences = NonNullable<PresenceProps["bridgedPresences"]>;

/** The face one agent paints (the host's `PresenceBinding`). */
export interface FaceBinding {
	readonly avatar: AvatarId;
	readonly skin?: PresenceProps["skin"];
	readonly accent?: PresenceProps["accent"];
}

export interface ObservableFact<T> {
	getSnapshot(): T | undefined;
	subscribe(listener: () => void): () => void;
}

/** The fenced Store the seat hands the page (C-A), with the result-returning
 *  `call` door its `artifactory:call` grant opens (C-B). */
export interface PageStore {
	watch<T = unknown>(key: string): ObservableFact<T>;
	call?(intent: string, payload: unknown): Promise<unknown>;
}

/** The workspace-surface fill props the page reads (the rest are ignored). */
export interface GeneralAgentsPageProps {
	readonly store: PageStore;
	/** The user's painted avatar: what the kit's face rule resolves against. */
	readonly avatar: AvatarId;
	/** General Agent name → the face its sessions paint. */
	readonly agentPresences?: ReadonlyMap<string, FaceBinding>;
	/** Plugin-contributed faces (`plugin:<pack>/<id>`), painted over the bridge. */
	readonly bridgedPresences?: BridgedPresences;
	/** The active workspace: its project agents join the roster. */
	readonly workspace?: { readonly workspaceId: string; readonly path: string; readonly displayName?: string } | null;
	/** The shell's one navigation channel (`dock.open` reveals the Machinist). */
	readonly onIntent?: (intent: { readonly t: "dock.open"; readonly tab?: string }) => void;
	/** The doors the voice lane lends this seat: a sample to hear and a write for the agent's voice.
	 *  Each is absent on a build that does not have it (the section then says so). */
	readonly voice?: { readonly sampler?: VoiceSampler; readonly assigner?: VoiceAssigner };
}

export type CapabilityCount = number | "all";

/** One row of `agents/list` (C-C). */
export interface AgentFact {
	readonly name: string;
	readonly description: string;
	readonly title?: string;
	readonly provenance: "dimension" | "community" | "local" | "workspace";
	readonly pluginId?: string;
	readonly enabled: boolean;
	readonly listed: boolean;
	readonly defaultEnabled?: boolean;
	readonly workspacePolicy?: string;
	readonly avatar?: { readonly id: string; readonly skin?: string; readonly accent?: string };
	readonly capabilities?: {
		readonly tools: CapabilityCount;
		readonly skills: CapabilityCount;
		readonly mcp: CapabilityCount;
		readonly plugins: CapabilityCount;
	};
	readonly homeWorkspaceId?: string;
}

/** `capabilities/catalog` (C-C). */
export interface CatalogPlugin {
	readonly id: string;
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
	readonly icon?: string;
	readonly iconUrl?: string;
	readonly kind: string;
	readonly enabled: boolean;
	readonly marketplace?: string;
}
export interface CatalogSkill {
	readonly name: string;
	readonly description?: string;
	readonly pluginId?: string;
}
export interface CatalogMcp {
	readonly name: string;
	readonly description?: string;
	readonly pluginId?: string;
	readonly status?: string;
}
export interface CatalogTool {
	readonly name: string;
	readonly description?: string;
	readonly source: "builtin" | "plugin";
	readonly pluginId?: string;
}
export interface CatalogFact {
	readonly plugins: readonly CatalogPlugin[];
	readonly skills: readonly CatalogSkill[];
	readonly mcp: readonly CatalogMcp[];
	readonly tools: readonly CatalogTool[];
}

/** `agents/usage` (C-C). */
export interface UsageFact {
	readonly range: "7d";
	readonly updatedAt: number;
	readonly agents: readonly { readonly name: string; readonly tokens: number; readonly cost: number; readonly turns: number }[];
}

/** One `sessions/list` row: the fields the KPI fold reads (host `CatalogEntry`). */
export interface SessionRow {
	readonly ref: { readonly sessionId: string };
	readonly kind?: "room";
	readonly roomAuthority?: string;
	readonly profile?: string;
	readonly source?: "user" | "autonomy" | "agent";
	readonly updatedAt: string;
	readonly archivedAt?: string;
	readonly continuedFrom?: string;
	readonly continuedInto?: { readonly toSessionId: string };
	readonly liveStatus?: "running" | "background" | "attached" | "idle";
	readonly blockedOnInput?: boolean;
	readonly attention?: { readonly kind: string };
}

/** One `models` row (the engine's catalog), the fields a model card draws. */
export interface ModelFact {
	readonly providerId: string;
	readonly providerName: string;
	readonly modelId: string;
	readonly label: string;
	readonly available: boolean;
	readonly reasoning: boolean;
	readonly contextWindow?: number;
	readonly kind?: "classify";
}

export const AGENTS_KEY = "agents/list";
export const SESSIONS_KEY = "sessions/list";
export const USAGE_KEY = "agents/usage";
export const CATALOG_KEY = "capabilities/catalog";
export const MODELS_KEY = "models";

/** The page's root element's `data-slot`: the scope `page.css` puts every utility under. */
export const PAGE_SLOT = "general-agents-page";
