// The design harness's voice lane: the two public facts the real engine publishes (`speech/profiles`,
// `speech/agents`) in their exact shapes, a stand-in for the engine's assignment order, and the two
// doors the lane lends (a sample to hear, a write for `voice.agents.<agent>`). Nothing here ships.
//
// `?voice=` picks the lane the page meets: full (default) · none (no speech lane at all) ·
// readonly (the facts, no doors) · nokey (ElevenLabs is installed but has no key) · nolayers (an engine
// that resolves each agent but does not say which layers hold what).
// `&assign=fail` makes the write refuse, to see the page say so.
import type { VoiceAssigner } from "../page/voice";
import { type Observable, observable } from "./observable";

interface SamplerState {
	readonly phase: "idle" | "preparing" | "playing" | "error";
	readonly profile: string | null;
	readonly message?: string;
}

interface Layers {
	workspace?: string;
	user?: string;
	agent?: string;
}

const DEFAULT_PROFILE = "calm";

const PROFILES = [
	{
		name: "warm",
		layer: "user",
		description: "Warm and unhurried. Good for long explanations.",
		speak: [
			{ provider: "elevenlabs", model: "eleven_v4_turbo", voice: "EXAVITQu4vr4xnSDxMaL" },
			{ provider: "local", model: "kokoro", voice: "af_heart" },
		],
	},
	{
		name: "calm",
		layer: "pack",
		description: "Even and quiet. Ships with the Voice plugin.",
		speak: [{ provider: "local", model: "kokoro", voice: "af_sky" }],
	},
	{
		name: "bright",
		layer: "workspace",
		description: "Quick and upbeat, for this project's release notes.",
		speak: [
			{ provider: "elevenlabs", model: "eleven_flash_v2_5", voice: "JBFqnCBsd6RMkjVDRZzb" },
			{ provider: "local", model: "kokoro", voice: "af_bella" },
		],
	},
	{
		name: "broadcast",
		layer: "pack",
		description: "Studio narration, from a provider this machine does not have.",
		speak: [{ provider: "studio-voice", model: "narrator-2" }],
	},
	{
		name: "local",
		layer: "builtin",
		description: "The on-device voice. Needs no key.",
		speak: [{ provider: "local", model: "kokoro", voice: "af_heart" }],
	},
] as const;

/** The engine's own order, most specific first (doc: assignment). The page never does this; the harness
 *  stands in for the engine so a pick visibly moves the card, the chip and the Sounds-like line. */
function resolve(layers: Layers) {
	if (layers.workspace) return { name: layers.workspace, source: "workspace-config", why: "Set in this project's config" };
	if (layers.user) return { name: layers.user, source: "user-config", why: "Set in your config" };
	if (layers.agent) return { name: layers.agent, source: "agent", why: "The agent's own file names it" };
	return { name: DEFAULT_PROFILE, source: "default", why: "The default voice for every agent" };
}

const INITIAL: Readonly<Record<string, Layers>> = {
	"release-herald": { user: "warm", agent: "calm" },
	cmo: { agent: "bright" },
	"x-agent": { workspace: "bright", user: "warm" },
	coding: {},
	machinist: {},
	reviewer: {},
};

export function createVoiceFixture(params: URLSearchParams) {
	const lane = params.get("voice") ?? "full";
	const layers = new Map<string, Layers>(Object.entries(INITIAL).map(([name, value]) => [name, { ...value }]));
	const agentsFact = () => Object.fromEntries([...layers].map(([name, held]) => [name, { ...resolve(held), ...(lane === "nolayers" ? {} : { layers: { ...held } }) }]));

	const profilesCell = observable<unknown>({
		profiles: PROFILES,
		providers: [
			{
				id: "elevenlabs",
				label: "ElevenLabs",
				speak: lane === "nokey" ? { ready: false, reason: "needs-key", detail: "Add your ElevenLabs key in Settings, then Voice." } : { ready: true },
			},
			{ id: "local", label: "On-device", speak: { ready: true } },
		],
		default: { name: DEFAULT_PROFILE, source: "default", why: "The default voice for every agent" },
	});
	const agentsCell = observable<unknown>(agentsFact());
	const cells = new Map<string, Observable<unknown>>();
	if (lane !== "none") {
		cells.set("speech/profiles", profilesCell);
		cells.set("speech/agents", agentsCell);
	}

	const sampler = observable<SamplerState>({ phase: "idle", profile: null });
	let timer: ReturnType<typeof setTimeout> | undefined;
	const play = (profile: string) => {
		clearTimeout(timer);
		sampler.set({ phase: "preparing", profile });
		timer = setTimeout(() => {
			sampler.set({ phase: "playing", profile });
			timer = setTimeout(() => sampler.set({ phase: "idle", profile: null }), 3200);
		}, 500);
	};
	const stop = () => {
		clearTimeout(timer);
		sampler.set({ phase: "idle", profile: null });
	};

	const assigner: VoiceAssigner = {
		async assign(agent, profile, scope) {
			await new Promise(resolveWait => setTimeout(resolveWait, 150));
			if (params.get("assign") === "fail") throw new Error("The config store refused the write: ~/.inso/config.json is read-only.");
			const held = { ...(layers.get(agent) ?? {}) };
			if (profile === null) delete held[scope];
			else held[scope] = profile;
			layers.set(agent, held);
			agentsCell.set(agentsFact());
		},
	};

	return {
		cells,
		/** What the host lends the page; each is absent on a lane that does not have it. */
		doors: lane === "full" || lane === "nokey" || lane === "nolayers" ? { sampler: { state: sampler, play, stop }, assigner } : undefined,
	};
}
