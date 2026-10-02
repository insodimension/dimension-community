// Types for the three extraction dependencies, kept to the surface src/code/extract uses. `@mozilla/readability` ships its own types and
// `turndown` has @types/turndown, but neither is in the shared install yet and `turndown-plugin-gfm` has none at all; an ambient
// declaration wins over module resolution, so this file is correct before and after the packages are installed.
declare module "@mozilla/readability" {
  export interface ReadabilityArticle {
    title?: string | null;
    byline?: string | null;
    excerpt?: string | null;
    content?: string | null;
    textContent?: string | null;
    length?: number | null;
  }
  export class Readability {
    constructor(document: unknown, options?: Record<string, unknown>);
    parse(): ReadabilityArticle | null;
  }
}

declare module "turndown" {
  interface TurndownNode {
    nodeName: string;
    nextSibling: unknown;
    parentNode: unknown;
  }
  interface TurndownOptions {
    headingStyle?: "setext" | "atx";
    codeBlockStyle?: "indented" | "fenced";
    bulletListMarker?: "-" | "+" | "*";
  }
  interface TurndownRule {
    filter: string | string[];
    replacement(content: string, node: TurndownNode, options: Required<TurndownOptions>): string;
  }
  export default class TurndownService {
    constructor(options?: TurndownOptions);
    use(plugin: unknown): this;
    addRule(key: string, rule: TurndownRule): this;
    turndown(html: string): string;
  }
}

declare module "turndown-plugin-gfm" {
  export const gfm: unknown;
}
