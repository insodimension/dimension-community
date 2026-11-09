// The pane's DOM: built once, then updated in place. The part that matters
// (pictures at 30-60 per second) never goes through a render. The toolbar, the
// markup layer over the screen and the request footer are the shared annotation
// kit's React components (chrome.tsx), mounted into the three slots made here.

import type { MissingTool, Screen, StreamStatus } from "./view-model";

type Child = Node | string;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== "") node.className = className;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

export interface ShellHandlers {
  boot(avd: string): void;
  refresh(): void;
  nav(key: "back" | "home" | "recents"): void;
}

export interface Shell {
  readonly canvas: HTMLCanvasElement;
  /** Where the toolbar mounts: the top of the pane. */
  readonly bar: HTMLElement;
  /** Over the screen, exactly the canvas's box: where a frozen frame and its marks go. */
  readonly freeze: HTMLElement;
  /** Under the stage: the request footer, while a device is on screen. */
  readonly foot: HTMLElement;
  render(screen: Screen, problem: string | null): void;
  status(status: StreamStatus | null): void;
  aspect(width: number, height: number): void;
  /** False while a tool is in hand: the screen and the device buttons take no input, so drawing never reaches the device. */
  driving(on: boolean): void;
}

const NAV: readonly { readonly key: "back" | "home" | "recents"; readonly label: string; readonly glyph: string }[] = [
  { key: "back", label: "Back", glyph: "M15 5l-7 7 7 7" },
  { key: "home", label: "Home", glyph: "M12 4a8 8 0 100 16 8 8 0 000-16z" },
  { key: "recents", label: "Recents", glyph: "M5 5h14v14H5z" },
];

function icon(path: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path);
  shape.setAttribute("fill", "none");
  shape.setAttribute("stroke", "currentColor");
  shape.setAttribute("stroke-width", "2");
  shape.setAttribute("stroke-linecap", "round");
  shape.setAttribute("stroke-linejoin", "round");
  svg.append(shape);
  return svg;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = el("button", `sim-btn ${className}`.trim(), { type: "button" }, label);
  node.addEventListener("click", onClick);
  return node;
}

export function createShell(root: HTMLElement, handlers: ShellHandlers): Shell {
  const bar = el("header", "sim-bar-slot");
  const canvas = el("canvas", "sim-canvas", { tabindex: "0", role: "application", "aria-label": "Device screen. Click and drag to touch, type to enter text." });
  const veil = el("div", "sim-veil", { role: "status" });
  const freeze = el("div", "sim-freeze-slot");
  const bezel = el("div", "sim-bezel", {}, canvas, veil, freeze);
  const screenbox = el("div", "sim-screenbox", {}, bezel);
  const navRow = el("nav", "sim-nav", { "aria-label": "Device buttons" });
  for (const item of NAV) {
    const node = el("button", "sim-nav-btn", { type: "button", "aria-label": item.label, title: item.label }, icon(item.glyph));
    node.addEventListener("click", () => handlers.nav(item.key));
    navRow.append(node);
  }
  const note = el("p", "sim-note", { role: "note" });
  const phone = el("section", "sim-phone", {}, note, screenbox, navRow);
  const panel = el("section", "sim-panel", { role: "region" });
  const stage = el("main", "sim-stage", {}, phone, panel);
  const problemBanner = el("p", "sim-problem", { role: "alert" });
  const foot = el("div", "sim-foot-slot");
  root.replaceChildren(el("div", "sim-root", {}, bar, problemBanner, stage, foot));

  function showPanel(title: string, body: Child[], actions: HTMLElement[] = [], tone: "plain" | "problem" = "plain"): void {
    panel.dataset.tone = tone;
    panel.replaceChildren(el("h1", "sim-panel-title", {}, title), ...body, ...(actions.length > 0 ? [el("div", "sim-actions", {}, ...actions)] : []));
  }

  function missingList(missing: readonly MissingTool[]): HTMLElement {
    const list = el("ul", "sim-missing");
    for (const item of missing) list.append(el("li", "", {}, el("code", "sim-code", {}, item.tool), el("span", "sim-missing-need", {}, ` — needed for ${item.needed}`), el("p", "sim-missing-fix", {}, item.fix)));
    return list;
  }

  return {
    canvas,
    bar,
    freeze,
    foot,
    aspect: (width, height) => {
      bezel.style.setProperty("--aw", String(width));
      bezel.style.setProperty("--ah", String(height));
    },
    status: status => {
      const covered = status !== null && (status.phase === "connecting" || status.phase === "reconnecting" || status.phase === "ended");
      veil.hidden = !covered;
      if (status === null) return;
      veil.textContent = status.phase === "ended" ? `Stopped${status.detail ? `: ${status.detail}` : ""}` : status.phase === "reconnecting" ? `Reconnecting${status.detail ? ` (${status.detail})` : ""}…` : "Connecting…";
    },
    driving: on => {
      canvas.inert = !on;
      navRow.inert = !on;
    },
    render: (screen, problem) => {
      problemBanner.hidden = problem === null;
      problemBanner.textContent = problem ?? "";
      phone.hidden = screen.kind !== "device";
      foot.hidden = screen.kind !== "device";
      panel.hidden = screen.kind === "device";
      if (screen.kind === "device") {
        const live = screen.notes.find(item => item.tool === "scrcpy-server");
        const lines = [...(live === undefined ? [] : [`Live video needs scrcpy-server, so this is Shot fallback (still pictures). ${live.fix}`]), ...screen.bootNotes];
        note.hidden = lines.length === 0;
        note.textContent = lines.join(" ");
        return;
      }
      switch (screen.kind) {
        case "loading":
          showPanel("Looking for devices…", [el("p", "sim-lede", {}, "Asking the simulator for what is running.")]);
          break;
        case "unavailable":
          showPanel("The simulator is not available", [el("p", "sim-lede", {}, screen.reason)], [button("Try again", "", () => handlers.refresh())], "problem");
          break;
        case "missing-adb":
          showPanel("Android tools not found", [el("p", "sim-lede", {}, "The simulator drives devices with adb, which this machine does not have (or the pack cannot find)."), missingList(screen.missing)], [button("Check again", "sim-btn-primary", () => handlers.refresh())], "problem");
          break;
        case "no-device": {
          const avds = screen.avds;
          const actions = avds.map((name, index) => button(`Boot ${name}`, index === 0 ? "sim-btn-primary" : "", () => handlers.boot(name)));
          const body: Child[] = [
            el("p", "sim-lede", {}, avds.length > 0 ? "No device is running. Boot one to watch and drive it here, beside your conversation." : "No device is running, and there is no Android virtual device to boot."),
          ];
          if (screen.missing.length > 0) body.push(missingList(screen.missing));
          else if (avds.length === 0) body.push(el("p", "sim-missing-fix", {}, "Create one in Android Studio → Device Manager (or with avdmanager), then check again."));
          if (screen.hiddenPhones > 0) body.push(el("p", "sim-missing-fix", {}, `${screen.hiddenPhones === 1 ? "A physical phone is attached and is" : `${screen.hiddenPhones} physical phones are attached and are`} not shown: the pane lists emulators only, unless Show physical devices is on.`));
          if (screen.listedPhones > 0) body.push(el("p", "sim-missing-fix", {}, "Pick your physical phone from the device list to open it here. The pane never opens one for you."));
          showPanel("No device running", body, [...actions, button("Check again", "sim-btn-quiet", () => handlers.refresh())]);
          break;
        }
        case "booting":
          showPanel(`Booting ${screen.avd}…`, [
            el("div", "sim-spinner", { role: "progressbar", "aria-label": "Booting" }),
            el("p", "sim-lede", {}, "A cold boot takes up to a minute. This pane opens the device the moment it is ready."),
            ...screen.notes.map(line => el("p", "sim-lede sim-boot-note", { role: "status" }, line)),
          ]);
          break;
      }
    },
  };
}
