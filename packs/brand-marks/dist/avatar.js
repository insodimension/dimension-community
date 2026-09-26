// src/marks.ts
var MARKS = [
  {
    id: "x",
    label: "X",
    hex: "#000000",
    fill: "theme",
    path: "M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z"
  },
  {
    id: "reddit",
    label: "Reddit",
    hex: "#FF4500",
    fill: "#FF4500",
    backing: '<circle cx="12" cy="12" r="11.4" fill="#FFFFFF"/>',
    path: "M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z"
  },
  {
    id: "youtube",
    label: "YouTube",
    hex: "#FF0000",
    fill: "#FF0000",
    backing: '<rect x="9" y="8" width="7.5" height="8" fill="#FFFFFF"/>',
    path: "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"
  },
  {
    id: "discord",
    label: "Discord",
    hex: "#5865F2",
    fill: "#5865F2",
    path: "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"
  },
  {
    id: "ycombinator",
    label: "Y Combinator",
    hex: "#F0652F",
    fill: "#F0652F",
    backing: '<rect x="6.5" y="5.5" width="11" height="13.5" fill="#FFFFFF"/>',
    path: "M0 24V0h24v24H0zM6.951 5.896l4.112 7.708v5.064h1.583v-4.972l4.148-7.799h-1.749l-2.457 4.875c-.372.745-.688 1.434-.688 1.434s-.297-.708-.651-1.434L8.831 5.896h-1.88z"
  },
  {
    id: "producthunt",
    label: "Product Hunt",
    hex: "#DA552F",
    fill: "#DA552F",
    backing: '<circle cx="12" cy="12" r="11.4" fill="#FFFFFF"/>',
    path: "M13.604 8.4h-3.405V12h3.405c.995 0 1.801-.806 1.801-1.801 0-.993-.805-1.799-1.801-1.799zM12 0C5.372 0 0 5.372 0 12s5.372 12 12 12 12-5.372 12-12S18.628 0 12 0zm1.604 14.4h-3.405V18H7.801V6h5.804c2.319 0 4.2 1.88 4.2 4.199 0 2.321-1.881 4.201-4.201 4.201z"
  },
  {
    id: "bluesky",
    label: "Bluesky",
    hex: "#1185FE",
    fill: "#1185FE",
    path: "M5.202 2.857C7.954 4.922 10.913 9.11 12 11.358c1.087-2.247 4.046-6.436 6.798-8.501C20.783 1.366 24 .213 24 3.883c0 .732-.42 6.156-.667 7.037-.856 3.061-3.978 3.842-6.755 3.37 4.854.826 6.089 3.562 3.422 6.299-5.065 5.196-7.28-1.304-7.847-2.97-.104-.305-.152-.448-.153-.327 0-.121-.05.022-.153.327-.568 1.666-2.782 8.166-7.847 2.97-2.667-2.737-1.432-5.473 3.422-6.3-2.777.473-5.899-.308-6.755-3.369C.42 10.04 0 4.615 0 3.883c0-3.67 3.217-2.517 5.202-1.026"
  },
  {
    id: "threads",
    label: "Threads",
    hex: "#000000",
    fill: "theme",
    path: "M18.263 11.097c-.03-3.486-1.92-5.586-5.111-5.586-2.13 0-3.922.963-4.863 2.499l2.062 1.438c.535-.843 1.272-1.543 2.628-1.543 1.528 0 2.318.85 2.544 2.431a15 15 0 0 0-2.236-.173c-4.125 0-6.068 1.867-6.068 4.336s1.943 3.99 4.804 3.99c3.139 0 5.013-2.115 5.781-4.735.798.361 1.348 1.204 1.348 2.47 0 3.387-3.907 5.232-7.22 5.232-4.885 0-8.077-3.207-8.077-8.424 0-6.392 4.223-10.487 9.9-10.487 3.808 0 5.69 1.671 6.97 3.914l2.108-1.475C21.44 2.078 18.331 0 13.663 0 6.227 0 1.168 5.277 1.168 12.934c0 7 4.953 11.066 10.856 11.066 4.878 0 9.809-2.846 9.809-7.716 0-2.545-1.46-4.231-3.569-5.187m-6.33 4.855c-1.077 0-2.026-.512-2.026-1.453 0-1.483 1.822-1.934 3.606-1.934.678 0 1.34.045 1.927.173-.422 1.927-1.671 3.215-3.508 3.214Z"
  },
  {
    id: "instagram",
    label: "Instagram",
    hex: "#FF0069",
    fill: "#FF0069",
    path: "M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077"
  },
  {
    id: "tiktok",
    label: "TikTok",
    hex: "#000000",
    fill: "theme",
    path: "M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"
  }
];

// src/avatar.ts
var PROTOCOL_VERSION = 5;
function isObject(value) {
  return typeof value === "object" && value !== null;
}
function isFrame(data) {
  return isObject(data) && data.__fraymPack === true && typeof data.v === "number" && data.v <= PROTOCOL_VERSION && typeof data.kind === "string";
}
function asTheme(value) {
  if (!isObject(value) || typeof value.tokens !== "string")
    return;
  return value.mode === "dark" || value.mode === "light" ? { mode: value.mode } : undefined;
}
function asPresence(value) {
  if (!isObject(value))
    return;
  const { state, mode, energy, emotion, motion, gateOpen, fpsCap } = value;
  if (state !== "idle" && state !== "thinking" && state !== "typing")
    return;
  if (typeof mode !== "string" || typeof energy !== "number" || typeof emotion !== "string")
    return;
  if (motion !== undefined && typeof motion !== "string")
    return;
  if (gateOpen !== undefined && typeof gateOpen !== "boolean")
    return;
  if (fpsCap !== undefined && typeof fpsCap !== "number")
    return;
  return { state, mode, energy, emotion, motion, gateOpen, fpsCap };
}
function post(frame) {
  window.parent.postMessage({ __fraymPack: true, v: PROTOCOL_VERSION, ...frame }, "*");
}
var CSS = `
#fraym-pack-root{display:grid;place-items:center;overflow:hidden}
.bm{--bm-amp:.04;--bm-bob:2%;--bm-orbit:1.8s;position:relative;width:min(100vw,100vh);height:min(100vw,100vh);color:#fff}
.bm[data-theme="light"]{color:#000}
.bm-halo,.bm-ring,.bm-sweep{position:absolute;border-radius:50%;opacity:0;pointer-events:none;transition:opacity .45s ease}
.bm-halo{inset:2%;background:radial-gradient(circle,color-mix(in srgb,var(--bm-tint) 55%,transparent) 0%,color-mix(in srgb,var(--bm-tint) 18%,transparent) 45%,transparent 70%)}
.bm-ring{inset:5%;border:2px solid transparent;border-top-color:var(--bm-tint);border-right-color:color-mix(in srgb,var(--bm-tint) 35%,transparent)}
.bm-sweep{inset:5%;background:conic-gradient(from 0deg,transparent 0 70%,color-mix(in srgb,var(--bm-tint) 45%,transparent) 100%);-webkit-mask:radial-gradient(circle,transparent 60%,#000 61%);mask:radial-gradient(circle,transparent 60%,#000 61%)}
.bm-motion,.bm-pop{position:absolute;inset:0}
.bm-mark{position:absolute;inset:14%;width:72%;height:72%;display:block}

/* Static cue (costs nothing): the halo shows whenever the session is busy. */
.bm:not([data-state="idle"]) .bm-halo{opacity:.55}
.bm[data-state="typing"] .bm-halo{opacity:.8}

/* Everything below animates, and ONLY while data-live="1". */
.bm[data-live="1"][data-state="thinking"] .bm-motion{animation:bm-breathe 3.2s ease-in-out infinite}
.bm[data-live="1"][data-state="typing"] .bm-motion{animation:bm-bob .9s ease-in-out infinite}
.bm[data-live="1"][data-state="thinking"] .bm-halo{animation:bm-glow 3.2s ease-in-out infinite}
.bm[data-live="1"]:not([data-state="idle"]):is([data-mode="run"],[data-mode="edit"]) .bm-ring{opacity:1;animation:bm-orbit var(--bm-orbit) linear infinite}
.bm[data-live="1"]:not([data-state="idle"]):is([data-mode="search"],[data-mode="read"]) .bm-sweep{opacity:1;animation:bm-orbit calc(var(--bm-orbit) * 1.3) linear infinite}
.bm[data-live="1"]:not([data-state="idle"])[data-pop="1"] .bm-pop{animation:bm-pop .52s cubic-bezier(.3,1.6,.5,1) 1}

@keyframes bm-breathe{0%,100%{transform:scale(1)}50%{transform:scale(calc(1 + var(--bm-amp)))}}
@keyframes bm-bob{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(calc(-1 * var(--bm-bob))) scale(calc(1 + var(--bm-amp) / 2))}}
@keyframes bm-glow{0%,100%{opacity:.35}50%{opacity:.75}}
@keyframes bm-orbit{to{transform:rotate(1turn)}}
@keyframes bm-pop{0%,100%{transform:scale(1)}40%{transform:scale(1.1)}}

/* Reduced motion: no animation AND no transition, whatever the host says. */
@media (prefers-reduced-motion: reduce){
	.bm *{animation:none!important;transition:none!important}
}
`;
var SVG_NS = "http://www.w3.org/2000/svg";
function markSvg(mark) {
  const fill = mark.fill === "theme" ? "currentColor" : mark.fill;
  return `<svg class="bm-mark" xmlns="${SVG_NS}" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${mark.label}">` + `<title>${mark.label}</title>${mark.backing ?? ""}<path fill="${fill}" d="${mark.path}"/></svg>`;
}
var POP_EMOTIONS = { pleased: true, proud: true, playful: true };
function mount(root, mark) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const stage = document.createElement("div");
  stage.className = "bm";
  stage.dataset.mark = mark.id;
  stage.innerHTML = `<div class="bm-halo"></div><div class="bm-sweep"></div><div class="bm-ring"></div>` + `<div class="bm-motion"><div class="bm-pop">${markSvg(mark)}</div></div>`;
  root.replaceChildren(stage);
  const pop = stage.querySelector(".bm-pop");
  const clearPop = () => {
    delete stage.dataset.pop;
  };
  pop?.addEventListener("animationend", clearPop);
  pop?.addEventListener("animationcancel", clearPop);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let lastPresence;
  let lastTheme;
  let lastEmotion = "";
  const paint = (presence, theme) => {
    lastPresence = presence;
    lastTheme = theme;
    const mode = theme?.mode ?? "dark";
    stage.dataset.theme = mode;
    if (theme)
      document.documentElement.style.colorScheme = mode;
    stage.style.setProperty("--bm-tint", mark.fill === "theme" ? mode === "dark" ? "#FFFFFF" : "#000000" : mark.hex);
    const state = presence?.state ?? "idle";
    stage.dataset.state = state;
    stage.dataset.mode = presence?.mode ?? "";
    const motion = presence?.motion;
    const live = presence !== undefined && motion !== "off" && motion !== "still" && presence.gateOpen !== false && !reducedMotion.matches;
    stage.dataset.live = live ? "1" : "0";
    const energy = Number.isFinite(presence?.energy) ? Math.min(1, Math.max(0, presence?.energy ?? 0)) : 0;
    const damp = motion === "idle" ? 0.5 : 1;
    stage.style.setProperty("--bm-amp", ((0.025 + 0.045 * energy) * damp).toFixed(4));
    stage.style.setProperty("--bm-bob", `${((1 + 2.5 * energy) * damp).toFixed(2)}%`);
    stage.style.setProperty("--bm-orbit", `${(2.4 - 1.2 * energy).toFixed(2)}s`);
    const emotion = presence?.emotion ?? "";
    if (!live || state === "idle")
      clearPop();
    else if (emotion !== lastEmotion && POP_EMOTIONS[emotion] === true) {
      clearPop();
      stage.offsetWidth;
      stage.dataset.pop = "1";
    }
    lastEmotion = emotion;
  };
  reducedMotion.addEventListener("change", () => paint(lastPresence, lastTheme));
  return paint;
}
function boot() {
  const root = document.getElementById("fraym-pack-root");
  const requested = root?.dataset.avatar ?? null;
  const mark = requested === null ? MARKS[0] : MARKS.find((m) => m.id === requested);
  if (!root) {
    post({ kind: "error", message: "brand-marks: #fraym-pack-root is missing from the host document" });
    return;
  }
  if (!mark) {
    post({
      kind: "error",
      message: `brand-marks: unknown avatar "${requested}" (this bundle ships ${MARKS.map((m) => m.id).join(", ")})`
    });
    return;
  }
  const paint = mount(root, mark);
  let presence;
  let theme;
  paint(presence, theme);
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || !isFrame(event.data))
      return;
    const frame = event.data;
    if (frame.kind === "init") {
      const channels = isObject(frame.channels) ? frame.channels : {};
      theme = asTheme(channels.theme) ?? theme;
      presence = asPresence(channels.presence) ?? presence;
    } else if (frame.kind === "state") {
      if (frame.channel === "theme")
        theme = asTheme(frame.value) ?? theme;
      else if (frame.channel === "presence")
        presence = asPresence(frame.value) ?? presence;
      else
        return;
    } else {
      return;
    }
    paint(presence, theme);
  });
  post({ kind: "ready", subscribe: ["theme", "presence"] });
}
boot();
