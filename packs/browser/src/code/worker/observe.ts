// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/tab-worker.ts (INTERACTIVE_AX_ROLES, isInteractiveNode, collectObservationEntries, #collectObservation)
// and tab-protocol.ts (Observation, ObservationEntry) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack: (matrix D10) the observation lives with its element cache instead of WorkerCore; `viewport` is the page's real size (the worker adopts a page and never sets its
// viewport, so puppeteer's `page.viewport()` is null and OMP would print its 1365x768 default whatever the page is).

import type { ElementHandle, Page, SerializedAXNode } from "puppeteer-core";
import { ToolError } from "../errors";
import { untilAborted } from "./abortable";
import type { ElementCache } from "./element-cache";

export interface ObservationEntry {
  id: number;
  role: string;
  name?: string;
  value?: string | number;
  description?: string;
  keyshortcuts?: string;
  states: string[];
}

export interface Observation {
  url: string;
  title?: string;
  viewport: { width: number; height: number; deviceScaleFactor?: number };
  scroll: {
    x: number;
    y: number;
    width: number;
    height: number;
    scrollWidth: number;
    scrollHeight: number;
  };
  elements: ObservationEntry[];
}

const INTERACTIVE_AX_ROLES: Record<string, true> = {
  button: true,
  link: true,
  textbox: true,
  combobox: true,
  listbox: true,
  option: true,
  checkbox: true,
  radio: true,
  switch: true,
  tab: true,
  menuitem: true,
  menuitemcheckbox: true,
  menuitemradio: true,
  slider: true,
  spinbutton: true,
  searchbox: true,
  treeitem: true,
};

function isInteractiveNode(node: SerializedAXNode): boolean {
  if (INTERACTIVE_AX_ROLES[node.role] === true) return true;
  return (
    node.checked !== undefined ||
    node.pressed !== undefined ||
    node.selected !== undefined ||
    node.expanded !== undefined ||
    node.focused === true
  );
}

async function collectObservationEntries(
  elements: ElementCache,
  node: SerializedAXNode,
  entries: ObservationEntry[],
  options: { viewportOnly: boolean; includeAll: boolean },
): Promise<void> {
  if (options.includeAll || isInteractiveNode(node)) {
    const handle = await node.elementHandle();
    if (handle) {
      let inViewport = true;
      if (options.viewportOnly) {
        try {
          inViewport = await handle.isIntersectingViewport();
        } catch {
          inViewport = false;
        }
      }
      if (inViewport) {
        const id = elements.nextId();
        const states: string[] = [];
        if (node.disabled) states.push("disabled");
        if (node.checked !== undefined) states.push(`checked=${String(node.checked)}`);
        if (node.pressed !== undefined) states.push(`pressed=${String(node.pressed)}`);
        if (node.selected !== undefined) states.push(`selected=${String(node.selected)}`);
        if (node.expanded !== undefined) states.push(`expanded=${String(node.expanded)}`);
        if (node.required) states.push("required");
        if (node.readonly) states.push("readonly");
        if (node.multiselectable) states.push("multiselectable");
        if (node.multiline) states.push("multiline");
        if (node.modal) states.push("modal");
        if (node.focused) states.push("focused");
        elements.set(id, handle as ElementHandle);
        entries.push({
          id,
          role: node.role,
          name: node.name,
          value: node.value,
          description: node.description,
          keyshortcuts: node.keyshortcuts,
          states,
        });
      } else {
        await handle.dispose();
      }
    }
  }
  for (const child of node.children ?? []) {
    await collectObservationEntries(elements, child, entries, options);
  }
}

/** The page's interactive elements (or every node with `includeAll`), numbered from 1 in `elements`; the previous numbering is dropped. */
export async function collectObservation(
  page: Page,
  elements: ElementCache,
  options: { includeAll?: boolean; viewportOnly?: boolean; signal?: AbortSignal },
): Promise<Observation> {
  elements.clear();
  const includeAll = options.includeAll ?? false;
  const viewportOnly = options.viewportOnly ?? false;
  const snapshot = (await untilAborted(options.signal, () =>
    page.accessibility.snapshot({ interestingOnly: !includeAll }),
  )) as SerializedAXNode | null;
  if (!snapshot) throw new ToolError("Accessibility snapshot unavailable");
  const entries: ObservationEntry[] = [];
  await collectObservationEntries(elements, snapshot, entries, { includeAll, viewportOnly });
  const scroll = await untilAborted(options.signal, () =>
    page.evaluate(() => {
      const doc = document.documentElement;
      return {
        x: window.scrollX,
        y: window.scrollY,
        width: window.innerWidth,
        height: window.innerHeight,
        scrollWidth: doc.scrollWidth,
        scrollHeight: doc.scrollHeight,
        deviceScaleFactor: window.devicePixelRatio,
      };
    }),
  );
  const { deviceScaleFactor, ...frame } = scroll;
  return {
    url: page.url(),
    title: (await untilAborted(options.signal, () => page.title())) as string,
    viewport: { width: frame.width, height: frame.height, deviceScaleFactor },
    scroll: frame,
    elements: entries,
  };
}
