// src/index.tsx
import { useEffect, useMemo, useSyncExternalStore } from "react";

// src/model.ts
var LOCAL_PROVIDER = "local";
var LAYERS = { workspace: true, user: true, pack: true, builtin: true };
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var text = (value) => typeof value === "string" && value !== "" ? value : undefined;
function readReadiness(value) {
  if (!isRecord(value) || typeof value.ready !== "boolean")
    return;
  const reason = text(value.reason);
  const detail = text(value.detail);
  return { ready: value.ready, ...reason ? { reason } : {}, ...detail ? { detail } : {} };
}
function readStep(value) {
  if (!isRecord(value))
    return;
  const provider = text(value.provider);
  const model = text(value.model);
  if (!provider || !model)
    return;
  const voice = text(value.voice);
  return { provider, model, ...voice ? { voice } : {} };
}
function readProfile(value) {
  if (!isRecord(value))
    return;
  const name = text(value.name);
  if (!name || typeof value.layer !== "string" || !Object.hasOwn(LAYERS, value.layer))
    return;
  const description = text(value.description);
  const speak = Array.isArray(value.speak) ? value.speak.flatMap((step) => readStep(step) ?? []) : [];
  return { name, layer: value.layer, speak, ...description ? { description } : {} };
}
function readProvider(value) {
  if (!isRecord(value))
    return;
  const id = text(value.id);
  if (!id)
    return;
  const speak = readReadiness(value.speak);
  const listen = readReadiness(value.listen);
  return { id, label: text(value.label) ?? id, ...speak ? { speak } : {}, ...listen ? { listen } : {} };
}
function readProfilesFact(raw) {
  if (!isRecord(raw))
    return null;
  const profiles = Array.isArray(raw.profiles) ? raw.profiles.flatMap((row) => readProfile(row) ?? []) : [];
  const providers = Array.isArray(raw.providers) ? raw.providers.flatMap((row) => readProvider(row) ?? []) : [];
  const fallback = isRecord(raw.default) ? text(raw.default.name) : undefined;
  return {
    profiles,
    providers,
    default: fallback ? { name: fallback, why: isRecord(raw.default) && text(raw.default.why) || "" } : null
  };
}
var REASONS = {
  "needs-key": "Needs an API key",
  "needs-download": "Needs a download",
  unavailable: "Unavailable"
};
function stateLine(readiness, verb) {
  if (!readiness)
    return { tone: "off", text: verb === "speak" ? "Does not speak" : "Does not listen" };
  if (readiness.ready)
    return { tone: "ok", text: "Ready" };
  const reason = readiness.reason;
  return { tone: "warn", text: reason !== undefined && Object.hasOwn(REASONS, reason) ? REASONS[reason] : "Not ready" };
}
var LAYER_LABELS = {
  workspace: "This workspace",
  user: "Yours",
  pack: "From a plugin",
  builtin: "Built in"
};
function stepOf(step, providers) {
  const provider = providers.get(step.provider);
  const state = provider ? stateLine(provider.speak, "speak") : { tone: "warn", text: "Not installed" };
  const detail = provider?.speak && !provider.speak.ready ? provider.speak.detail : undefined;
  return {
    providerLabel: provider?.label ?? step.provider,
    model: step.model,
    ...step.voice ? { voice: step.voice } : {},
    state,
    ...detail ? { detail } : {},
    ready: state.tone === "ok"
  };
}
function profileViews(view) {
  const providers = new Map(view.providers.map((provider) => [provider.id, provider]));
  const local = providers.get(LOCAL_PROVIDER);
  const localReady = local?.speak?.ready === true;
  return view.profiles.map((profile) => {
    const steps = profile.speak.map((step) => stepOf(step, providers));
    const firstReady = steps.findIndex((step) => step.ready);
    const head = steps[0];
    const because = head && firstReady !== 0 ? head.providerLabel : undefined;
    const spoken = steps[firstReady];
    const speaksWith = spoken ? { label: spoken.providerLabel, fellBack: firstReady > 0, ...because ? { because } : {} } : localReady ? { label: local?.label ?? "On-device voice", fellBack: true, ...because ? { because } : {} } : null;
    return {
      name: profile.name,
      layer: profile.layer,
      layerLabel: LAYER_LABELS[profile.layer],
      ...profile.description ? { description: profile.description } : {},
      isDefault: view.default?.name === profile.name,
      steps,
      speaksWith
    };
  });
}
function headline(view) {
  if (!view)
    return { tone: "off", text: "This engine has no speech runtime, so voice mode is not available here." };
  const profiles = profileViews(view);
  const chosen = profiles.find((profile) => profile.isDefault);
  if (!chosen)
    return { tone: "warn", text: "No default voice is set." };
  if (!chosen.speaksWith) {
    return { tone: "warn", text: `The default voice, ${chosen.name}, has nothing ready to speak with.` };
  }
  return {
    tone: "ok",
    text: chosen.speaksWith.fellBack ? `The default voice, ${chosen.name}, speaks with ${chosen.speaksWith.label}${chosen.speaksWith.because ? `: ${chosen.speaksWith.because} is not ready` : ""}.` : `The default voice, ${chosen.name}, speaks with ${chosen.speaksWith.label}.`
  };
}
function readAgents(raw) {
  if (!Array.isArray(raw))
    return [];
  const seen = new Set;
  const rows = [];
  for (const value of raw) {
    if (!isRecord(value))
      continue;
    const name = text(value.name);
    if (!name || seen.has(name) || value.enabled === false)
      continue;
    seen.add(name);
    rows.push({ name, title: text(value.title) ?? name, voice: text(value.voice) ?? null });
  }
  return rows.sort((a, b) => a.title.localeCompare(b.title));
}
function readModelsFact(raw) {
  if (!Array.isArray(raw))
    return null;
  let chat = 0;
  const classifiers = [];
  for (const value of raw) {
    if (!isRecord(value) || value.available !== true)
      continue;
    if (value.kind === "classify") {
      const label = text(value.label) ?? text(value.modelId);
      if (label && !classifiers.includes(label))
        classifiers.push(label);
    } else {
      chat += 1;
    }
  }
  return { chat, classifiers };
}
function modelRows(models) {
  const voiceHint = "Set the voice model in Models to pick the small model that writes what is spoken. Unset, it falls back to your tiny model, then your small one.";
  const classifierHint = "The classifier is the judge model (Jev by default). It only decides whether a message is worth saying; voice mode works without it.";
  const voice = !models ? { role: "voice", title: "Voice model", tone: "off", says: "Not known yet.", hint: voiceHint } : models.chat > 0 ? { role: "voice", title: "Voice model", tone: "ok", says: `${models.chat} chat ${models.chat === 1 ? "model is" : "models are"} connected to write spoken replies.`, hint: voiceHint } : { role: "voice", title: "Voice model", tone: "warn", says: "No chat model is connected, so replies are read out as written, only cleaned up.", hint: voiceHint };
  const classifier = !models ? { role: "classifier", title: "Classifier", tone: "off", says: "Not known yet.", hint: classifierHint } : models.classifiers.length > 0 ? { role: "classifier", title: "Classifier", tone: "ok", says: `${models.classifiers.join(", ")} can judge what is worth saying.`, hint: classifierHint } : { role: "classifier", title: "Classifier", tone: "off", says: "None connected: a plain rule decides what is worth saying.", hint: classifierHint };
  return [voice, classifier];
}
var TUNING_KEYS = [
  { key: "vocalizer.mode", fallback: "brief", what: "What is spoken: brief, assistant (every block in full), all (thinking too) or yield (only the final message)." },
  { key: "vocalizer.enhanced", fallback: "on when a voice model is connected", what: "Rewrite replies into spoken prose with the small model." },
  { key: "attention.catchUpAfterMinutes", fallback: "60", what: "How long away from an agent before it welcomes you back." },
  { key: "attention.chimes", fallback: "on", what: "A soft tone when a message is waiting." }
];

// src/styles.ts
var STYLE_SLOT = "voice-mode-styles";
var VOICE_PANE_CSS = `
[data-slot="voice-pane"] {
	display: flex;
	flex-direction: column;
	gap: 28px;
	max-width: 720px;
	padding: 4px 2px 32px;
	color: var(--fr-text-2);
	font-family: var(--fr-font-primary);
	font-size: var(--fr-fs-sm);
	line-height: 1.5;
}
[data-slot="voice-pane"] h2 {
	margin: 0 0 4px;
	color: var(--fr-text);
	font-size: var(--fr-fs-base);
	font-weight: 600;
}
[data-slot="voice-pane"] .vm-sub {
	margin: 0 0 10px;
	color: var(--fr-text-3);
	font-size: var(--fr-fs-xs);
}
[data-slot="voice-pane"] .vm-headline {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 12px 14px;
	border: 1px solid var(--fr-border-soft);
	border-radius: var(--fr-r);
	background: var(--fr-surface-2);
	color: var(--fr-text);
}
[data-slot="voice-pane"] .vm-dot {
	flex: none;
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: var(--fr-text-3);
}
[data-slot="voice-pane"] .vm-dot[data-tone="ok"] { background: var(--fr-add); }
[data-slot="voice-pane"] .vm-dot[data-tone="warn"] { background: var(--fr-warn); }
[data-slot="voice-pane"] .vm-list {
	display: flex;
	flex-direction: column;
	margin: 0;
	padding: 0;
	list-style: none;
	border: 1px solid var(--fr-border-soft);
	border-radius: var(--fr-r);
	overflow: hidden;
}
[data-slot="voice-pane"] .vm-row {
	display: flex;
	align-items: flex-start;
	gap: 12px;
	padding: 10px 14px;
	background: var(--fr-surface);
}
[data-slot="voice-pane"] .vm-row + .vm-row { border-top: 1px solid var(--fr-border-soft); }
[data-slot="voice-pane"] .vm-grow { flex: 1; min-width: 0; }
[data-slot="voice-pane"] .vm-name {
	color: var(--fr-text);
	font-weight: 500;
}
[data-slot="voice-pane"] .vm-meta {
	color: var(--fr-text-3);
	font-size: var(--fr-fs-xs);
}
[data-slot="voice-pane"] .vm-tag {
	display: inline-block;
	margin-left: 8px;
	padding: 0 6px;
	border: 1px solid var(--fr-accent-line);
	border-radius: var(--fr-r);
	color: var(--fr-accent);
	font-size: var(--fr-fs-2xs);
	letter-spacing: var(--fr-tracking-caps);
	text-transform: uppercase;
	vertical-align: 1px;
}
[data-slot="voice-pane"] .vm-state { color: var(--fr-text-3); white-space: nowrap; }
[data-slot="voice-pane"] .vm-state[data-tone="ok"] { color: var(--fr-add); }
[data-slot="voice-pane"] .vm-state[data-tone="warn"] { color: var(--fr-warn); }
[data-slot="voice-pane"] .vm-chain {
	display: flex;
	flex-direction: column;
	gap: 2px;
	margin: 6px 0 0;
	padding: 0;
	list-style: none;
}
[data-slot="voice-pane"] .vm-chain li {
	display: flex;
	justify-content: space-between;
	gap: 12px;
	color: var(--fr-text-2);
	font-size: var(--fr-fs-xs);
}
[data-slot="voice-pane"] code {
	font-family: var(--fr-font-mono);
	font-size: var(--fr-fs-xs);
	color: var(--fr-text);
}
[data-slot="voice-pane"] .vm-help {
	margin: 0;
	padding-left: 18px;
	color: var(--fr-text-2);
}
[data-slot="voice-pane"] .vm-help li + li { margin-top: 6px; }
[data-slot="voice-pane"] .vm-empty {
	padding: 14px;
	border: 1px dashed var(--fr-border);
	border-radius: var(--fr-r);
	color: var(--fr-text-3);
}
`;
function ensureStyles() {
  if (typeof document === "undefined")
    return;
  if (document.head.querySelector(`style[data-slot="${STYLE_SLOT}"]`))
    return;
  const style = document.createElement("style");
  style.dataset.slot = STYLE_SLOT;
  style.textContent = VOICE_PANE_CSS;
  document.head.appendChild(style);
}

// src/index.tsx
import { jsx, jsxs, Fragment } from "react/jsx-runtime";
var SPEECH_PROFILES_KEY = "speech/profiles";
var AGENTS_LIST_KEY = "agents/list";
var MODELS_KEY = "models";
var NO_UNSUBSCRIBE = () => {
  return;
};
function useFact(store, key) {
  const observable = useMemo(() => store?.watch(key), [store, key]);
  const subscribe = useMemo(() => (listener) => observable ? observable.subscribe(listener) : NO_UNSUBSCRIBE, [observable]);
  const read = () => observable?.getSnapshot();
  return useSyncExternalStore(subscribe, read, read);
}
function Dot({ tone }) {
  return /* @__PURE__ */ jsx("span", {
    className: "vm-dot",
    "data-tone": tone,
    "aria-hidden": "true"
  });
}
function Profile({ profile }) {
  return /* @__PURE__ */ jsxs("li", {
    className: "vm-row",
    children: [
      /* @__PURE__ */ jsxs("div", {
        className: "vm-grow",
        children: [
          /* @__PURE__ */ jsxs("div", {
            children: [
              /* @__PURE__ */ jsx("span", {
                className: "vm-name",
                children: profile.name
              }),
              profile.isDefault ? /* @__PURE__ */ jsx("span", {
                className: "vm-tag",
                children: "Default"
              }) : null
            ]
          }),
          /* @__PURE__ */ jsxs("div", {
            className: "vm-meta",
            children: [
              profile.layerLabel,
              profile.description ? ` · ${profile.description}` : ""
            ]
          }),
          /* @__PURE__ */ jsx("ul", {
            className: "vm-chain",
            children: profile.steps.map((step, index) => /* @__PURE__ */ jsxs("li", {
              children: [
                /* @__PURE__ */ jsxs("span", {
                  children: [
                    step.providerLabel,
                    " · ",
                    step.model,
                    step.voice ? ` · ${step.voice}` : ""
                  ]
                }),
                /* @__PURE__ */ jsx("span", {
                  className: "vm-state",
                  "data-tone": step.state.tone,
                  title: step.detail,
                  children: step.state.text
                })
              ]
            }, `${step.providerLabel}:${step.model}:${index}`))
          })
        ]
      }),
      /* @__PURE__ */ jsx("div", {
        className: "vm-state vm-meta",
        "data-tone": profile.speaksWith ? "ok" : "warn",
        children: profile.speaksWith ? profile.speaksWith.fellBack ? `Falls back to ${profile.speaksWith.label}` : `Speaks with ${profile.speaksWith.label}` : "Cannot speak yet"
      })
    ]
  });
}
function Engines({ view }) {
  if (view.providers.length === 0)
    return /* @__PURE__ */ jsx("div", {
      className: "vm-empty",
      children: "No speech engine is installed."
    });
  return /* @__PURE__ */ jsx("ul", {
    className: "vm-list",
    children: view.providers.map((provider) => {
      const speak = stateLine(provider.speak, "speak");
      const listen = stateLine(provider.listen, "listen");
      return /* @__PURE__ */ jsxs("li", {
        className: "vm-row",
        children: [
          /* @__PURE__ */ jsxs("div", {
            className: "vm-grow",
            children: [
              /* @__PURE__ */ jsx("div", {
                className: "vm-name",
                children: provider.label
              }),
              /* @__PURE__ */ jsx("div", {
                className: "vm-meta",
                children: provider.listen ? `Listening: ${listen.text}${provider.listen.detail && !provider.listen.ready ? ` (${provider.listen.detail})` : ""}` : "Speaks only"
              })
            ]
          }),
          /* @__PURE__ */ jsx("div", {
            className: "vm-state",
            "data-tone": speak.tone,
            title: provider.speak?.detail,
            children: provider.speak ? `Speaking: ${speak.text}` : speak.text
          })
        ]
      }, provider.id);
    })
  });
}
function VoicePane({ store }) {
  useEffect(ensureStyles, []);
  const rawProfiles = useFact(store, SPEECH_PROFILES_KEY);
  const rawAgents = useFact(store, AGENTS_LIST_KEY);
  const rawModels = useFact(store, MODELS_KEY);
  const profiles = useMemo(() => readProfilesFact(rawProfiles), [rawProfiles]);
  const agents = useMemo(() => readAgents(rawAgents), [rawAgents]);
  const models = useMemo(() => readModelsFact(rawModels), [rawModels]);
  const voices = useMemo(() => profiles ? profileViews(profiles) : [], [profiles]);
  const top = headline(profiles);
  const defaultName = profiles?.default?.name;
  return /* @__PURE__ */ jsxs("div", {
    "data-slot": "voice-pane",
    children: [
      /* @__PURE__ */ jsxs("section", {
        children: [
          /* @__PURE__ */ jsxs("div", {
            className: "vm-headline",
            role: "status",
            children: [
              /* @__PURE__ */ jsx(Dot, {
                tone: top.tone
              }),
              /* @__PURE__ */ jsx("span", {
                children: top.text
              })
            ]
          }),
          /* @__PURE__ */ jsx("p", {
            className: "vm-sub",
            children: "Turn voice mode on from the speaker beside the microphone in the composer. It works in any space, with any agent."
          })
        ]
      }),
      profiles ? /* @__PURE__ */ jsxs(Fragment, {
        children: [
          /* @__PURE__ */ jsxs("section", {
            children: [
              /* @__PURE__ */ jsx("h2", {
                children: "Speech engines"
              }),
              /* @__PURE__ */ jsx("p", {
                className: "vm-sub",
                children: "What can speak and listen on this machine right now."
              }),
              /* @__PURE__ */ jsx(Engines, {
                view: profiles
              })
            ]
          }),
          /* @__PURE__ */ jsxs("section", {
            children: [
              /* @__PURE__ */ jsx("h2", {
                children: "Voices"
              }),
              /* @__PURE__ */ jsx("p", {
                className: "vm-sub",
                children: "A voice says how an agent sounds: the first ready choice below speaks, and the on-device voice is always the last resort."
              }),
              voices.length === 0 ? /* @__PURE__ */ jsx("div", {
                className: "vm-empty",
                children: "No voice profile is visible from this workspace."
              }) : /* @__PURE__ */ jsx("ul", {
                className: "vm-list",
                children: voices.map((profile) => /* @__PURE__ */ jsx(Profile, {
                  profile
                }, profile.name))
              })
            ]
          }),
          /* @__PURE__ */ jsxs("section", {
            children: [
              /* @__PURE__ */ jsx("h2", {
                children: "Agents"
              }),
              /* @__PURE__ */ jsx("p", {
                className: "vm-sub",
                children: "The voice each agent ships with. A voice you assign in your own config outranks it, and a workspace's outranks yours."
              }),
              agents.length === 0 ? /* @__PURE__ */ jsx("div", {
                className: "vm-empty",
                children: "No agents are listed yet."
              }) : /* @__PURE__ */ jsx("ul", {
                className: "vm-list",
                children: agents.map((agent) => /* @__PURE__ */ jsxs("li", {
                  className: "vm-row",
                  children: [
                    /* @__PURE__ */ jsx("div", {
                      className: "vm-grow vm-name",
                      children: agent.title
                    }),
                    /* @__PURE__ */ jsx("div", {
                      className: "vm-meta",
                      children: agent.voice ? agent.voice : defaultName ? `${defaultName} (default)` : "No voice set"
                    })
                  ]
                }, agent.name))
              })
            ]
          })
        ]
      }) : null,
      /* @__PURE__ */ jsxs("section", {
        children: [
          /* @__PURE__ */ jsx("h2", {
            children: "Models"
          }),
          /* @__PURE__ */ jsx("p", {
            className: "vm-sub",
            children: "Two small models make voice mode feel attentive. Neither is required."
          }),
          /* @__PURE__ */ jsx("ul", {
            className: "vm-list",
            children: modelRows(models).map((row) => /* @__PURE__ */ jsxs("li", {
              className: "vm-row",
              children: [
                /* @__PURE__ */ jsx(Dot, {
                  tone: row.tone
                }),
                /* @__PURE__ */ jsxs("div", {
                  className: "vm-grow",
                  children: [
                    /* @__PURE__ */ jsx("div", {
                      className: "vm-name",
                      children: row.title
                    }),
                    /* @__PURE__ */ jsx("div", {
                      children: row.says
                    }),
                    /* @__PURE__ */ jsx("div", {
                      className: "vm-meta",
                      children: row.hint
                    })
                  ]
                })
              ]
            }, row.role))
          })
        ]
      }),
      /* @__PURE__ */ jsxs("section", {
        children: [
          /* @__PURE__ */ jsx("h2", {
            children: "Change it"
          }),
          /* @__PURE__ */ jsxs("ul", {
            className: "vm-help",
            children: [
              /* @__PURE__ */ jsxs("li", {
                children: [
                  "Give an agent a voice with ",
                  /* @__PURE__ */ jsx("code", {
                    children: "voice: <name>"
                  }),
                  " in its ",
                  /* @__PURE__ */ jsx("code", {
                    children: "agent.md"
                  }),
                  ", or with",
                  " ",
                  /* @__PURE__ */ jsx("code", {
                    children: "voice.agents.<agent>"
                  }),
                  " in ",
                  /* @__PURE__ */ jsx("code", {
                    children: "~/.inso/config.json"
                  }),
                  " (yours) or the workspace's",
                  " ",
                  /* @__PURE__ */ jsx("code", {
                    children: ".inso/config.json"
                  }),
                  "."
                ]
              }),
              /* @__PURE__ */ jsxs("li", {
                children: [
                  "Add a voice by dropping a ",
                  /* @__PURE__ */ jsx("code", {
                    children: "<name>.yml"
                  }),
                  " into ",
                  /* @__PURE__ */ jsx("code", {
                    children: "voice-profiles/"
                  }),
                  " beside your agents, or into the workspace's ",
                  /* @__PURE__ */ jsx("code", {
                    children: ".inso/voice-profiles/"
                  }),
                  ". It appears above as soon as it is saved."
                ]
              }),
              /* @__PURE__ */ jsxs("li", {
                children: [
                  "Tune how it behaves in the ",
                  /* @__PURE__ */ jsx("code", {
                    children: "voice"
                  }),
                  " block of the same ",
                  /* @__PURE__ */ jsx("code", {
                    children: "config.json"
                  }),
                  ":",
                  /* @__PURE__ */ jsx("ul", {
                    className: "vm-help",
                    children: TUNING_KEYS.map((tuning) => /* @__PURE__ */ jsxs("li", {
                      children: [
                        /* @__PURE__ */ jsx("code", {
                          children: tuning.key
                        }),
                        " (",
                        tuning.fallback,
                        "): ",
                        tuning.what
                      ]
                    }, tuning.key))
                  })
                ]
              })
            ]
          })
        ]
      })
    ]
  });
}
export {
  VoicePane as default
};
