// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/utils/turndown.ts (createTurndown) and src/web/scrapers/types.ts (htmlToBasicMarkdown) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack: OMP's `@oh-my-pi/pi-utils/turndown` is the copy in ./turndown (OMP's own HTML-to-markdown converter, not the npm package), loaded on first extraction as OMP does, so a cell that never extracts never loads it; the table normaliser only the document engine used is not copied.

import type { TurndownService } from "./turndown/index";

type TurndownListParent = {
  nodeName: string;
  getAttribute(name: string): string | null;
  children: ArrayLike<unknown>;
};

/**
 * Build a Turndown instance configured for GFM with the fixes OMP relies on:
 * `~~strikethrough~~`, unescaped heading periods, and single-space list markers.
 */
export async function createTurndown(): Promise<TurndownService> {
  const { default: Turndown, gfm } = await import("./turndown/index");
  const turndown = new Turndown({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  turndown.use(gfm);
  // GFM spec uses ~~ (double tilde), not ~ (single)
  turndown.addRule("strikethrough", {
    filter: ["del", "s", "strike"],
    replacement(content) {
      return `~~${content}~~`;
    },
  });
  // Unescape the backslash turndown inserts before periods in headings ("1." -> "1\.")
  turndown.addRule("heading", {
    filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
    replacement(content, node) {
      const level = Number(node.nodeName.charAt(1));
      const prefix = "#".repeat(level);
      const cleaned = content.replace(/\\([.])/g, "$1").trim();
      return `\n\n${prefix} ${cleaned}\n\n`;
    },
  });
  // Single space after the marker (turndown hardcodes three)
  turndown.addRule("listItem", {
    filter: "li",
    replacement(content, node, options) {
      const body = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, "\n  ");
      const parent = node.parentNode as unknown as TurndownListParent | null;
      let prefix = `${options.bulletListMarker} `;
      if (parent?.nodeName === "OL") {
        const start = parent.getAttribute("start");
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${(start ? Number(start) : 1) + index}. `;
      }
      return prefix + body + (node.nextSibling ? "\n" : "");
    },
  });
  return turndown;
}

let turndownPromise: Promise<TurndownService> | undefined;

/**
 * Convert HTML to markdown using Turndown with GFM support.
 * Strips script/style tags before conversion.
 */
export async function htmlToBasicMarkdown(html: string): Promise<string> {
  const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  turndownPromise ||= createTurndown();
  return (await turndownPromise).turndown(cleaned).trim();
}
