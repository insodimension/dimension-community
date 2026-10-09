var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/turndown/gfm.ts
function descendantElements(node, name) {
  const matches = [];
  for (const child of Array.from(node.children)) {
    if (child.nodeName === name) matches.push(child);
    if (child.nodeName !== "TABLE") matches.push(...descendantElements(child, name));
  }
  return matches;
}
function isHeadingTable(node) {
  if (node.nodeName !== "TABLE") return false;
  const firstRow = descendantElements(node, "TR")[0];
  if (!firstRow) return false;
  const cells = Array.from(firstRow.children);
  return cells.length > 0 && cells.every((cell) => cell.nodeName === "TH");
}
function cellAlignment(cell) {
  const explicit = cell.getAttribute("align")?.toLowerCase();
  if (explicit === "left" || explicit === "center" || explicit === "right") return explicit;
  const style = cell.getAttribute("style") ?? "";
  const styled = /(?:^|;)\s*text-align\s*:\s*(left|center|right)\s*(?:;|$)/i.exec(style)?.[1]?.toLowerCase();
  return styled === "left" || styled === "center" || styled === "right" ? styled : void 0;
}
function alignmentMarker(cell) {
  const alignment = cellAlignment(cell);
  if (alignment === "left") return ":--";
  if (alignment === "center") return ":-:";
  if (alignment === "right") return "--:";
  return "---";
}
function renderTable(service, table) {
  const rows = descendantElements(table, "TR");
  const rendered = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (!row) continue;
    const cells = Array.from(row.children).filter((cell) => cell.nodeName === "TH" || cell.nodeName === "TD");
    const values = cells.map((cell) => service.convertChildren(cell).trim());
    rendered.push(`| ${values.join(" | ")} |`);
    if (rowIndex === 0) rendered.push(`| ${cells.map(alignmentMarker).join(" | ")} |`);
  }
  return `

${rendered.join("\n")}

`;
}
var highlightedCodeBlock, strikethrough, taskListItems, tables, gfm;
var init_gfm = __esm({
  "../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/turndown/gfm.ts"() {
    "use strict";
    highlightedCodeBlock = (service) => {
      service.addRule("highlightedCodeBlock", {
        filter(node) {
          return node.nodeName === "DIV" && /(?:^|\s)highlight-source-([^\s]+)/.test(node.getAttribute("class") ?? "");
        },
        replacement(_content, node, options) {
          const language = /(?:^|\s)highlight-source-([^\s]+)/.exec(node.getAttribute("class") ?? "")?.[1] ?? "";
          const text2 = descendantElements(node, "PRE")[0]?.textContent ?? "";
          return `

${options.fence}${language}
${text2}
${options.fence}

`;
        }
      });
    };
    strikethrough = (service) => {
      service.addRule("strikethrough", {
        filter: ["del", "s", "strike"],
        replacement(content) {
          return `~${content}~`;
        }
      });
    };
    taskListItems = (service) => {
      service.addRule("taskListItems", {
        filter(node) {
          return node.nodeName === "INPUT" && node.parentNode?.nodeName === "LI" && (node.getAttribute("type") ?? "").toLowerCase() === "checkbox";
        },
        replacement(_content, node) {
          return node.hasAttribute("checked") ? "[x] " : "[ ] ";
        }
      });
    };
    tables = (service) => {
      service.addRule("table", {
        filter: isHeadingTable,
        replacement(_content, node) {
          return renderTable(service, node);
        }
      });
    };
    gfm = (service) => {
      highlightedCodeBlock(service);
      strikethrough(service);
      tables(service);
      taskListItems(service);
    };
  }
});

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/turndown/html.ts
function decodeEntities(value) {
  return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z][\da-z]+);?/gi, (entity, name) => {
    if (name.charAt(0) === "#") {
      const hexadecimal = name.charAt(1).toLowerCase() === "x";
      const number = Number.parseInt(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      if (!Number.isFinite(number) || number <= 0 || number > 1114111) return entity;
      try {
        return String.fromCodePoint(number);
      } catch {
        return "\uFFFD";
      }
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
  });
}
function escapeAttribute(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
function parseAttributes(source) {
  const attributes = /* @__PURE__ */ new Map();
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    attributes.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return attributes;
}
function* htmlTokens(html) {
  let cursor = 0;
  while (cursor < html.length) {
    if (html.charAt(cursor) !== "<") {
      const nextTag = html.indexOf("<", cursor);
      const end = nextTag < 0 ? html.length : nextTag;
      yield html.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (!/[/!a-z]/i.test(html.charAt(cursor + 1))) {
      yield "<";
      cursor++;
      continue;
    }
    if (html.startsWith("<!--", cursor)) {
      const commentEnd = html.indexOf("-->", cursor + 4);
      const end = commentEnd < 0 ? html.length : commentEnd + 3;
      yield html.slice(cursor, end);
      cursor = end;
      continue;
    }
    let quote;
    let tagEnd = cursor + 1;
    for (; tagEnd < html.length; tagEnd++) {
      const character = html.charAt(tagEnd);
      if (quote) {
        if (character === quote) quote = void 0;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    if (tagEnd >= html.length) {
      yield "<";
      cursor++;
      continue;
    }
    yield html.slice(cursor, tagEnd + 1);
    cursor = tagEnd + 1;
  }
}
function parseHtmlFragment(html) {
  const root = new HtmlFragment();
  const stack = [root];
  for (const token of htmlTokens(html)) {
    const parent = stack[stack.length - 1] ?? root;
    if (token.startsWith("<!--") || token.startsWith("<!")) continue;
    if (!token.startsWith("<")) {
      parent.append(new HtmlText(decodeEntities(token)));
      continue;
    }
    const closing = /^<\/\s*([a-z][\w:-]*)[^>]*>$/i.exec(token);
    if (closing) {
      const name = closing[1]?.toUpperCase();
      for (let index = stack.length - 1; index > 0; index--) {
        if (stack[index]?.nodeName !== name) continue;
        stack.length = index;
        break;
      }
      continue;
    }
    const opening = /^<\s*([a-z][\w:-]*)([\s\S]*?)\/?\s*>$/i.exec(token);
    if (!opening?.[1]) {
      parent.append(new HtmlText("<"));
      continue;
    }
    const element = new HtmlElement(opening[1], parseAttributes(opening[2] ?? ""));
    parent.append(element);
    if (!VOID_ELEMENTS[element.nodeName] && !/\/\s*>$/.test(token)) stack.push(element);
  }
  return root;
}
function serializeNode(node) {
  if (typeof node.outerHTML === "string") return node.outerHTML;
  if (node.nodeType === 3) return node.textContent ?? "";
  return Array.from(node.childNodes).map(serializeNode).join("");
}
var VOID_ELEMENTS, NAMED_ENTITIES, HtmlNode, HtmlText, HtmlElement, HtmlFragment;
var init_html = __esm({
  "../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/turndown/html.ts"() {
    "use strict";
    VOID_ELEMENTS = {
      AREA: true,
      BASE: true,
      BR: true,
      COL: true,
      EMBED: true,
      HR: true,
      IMG: true,
      INPUT: true,
      LINK: true,
      META: true,
      PARAM: true,
      SOURCE: true,
      TRACK: true,
      WBR: true
    };
    NAMED_ENTITIES = {
      amp: "&",
      apos: "'",
      copy: "\xA9",
      gt: ">",
      hellip: "\u2026",
      laquo: "\xAB",
      lt: "<",
      mdash: "\u2014",
      nbsp: "\xA0",
      ndash: "\u2013",
      quot: '"',
      raquo: "\xBB",
      reg: "\xAE"
    };
    HtmlNode = class {
      parentNode = null;
      childNodes = [];
      get children() {
        return this.childNodes.filter((child) => child.nodeType === 1);
      }
      get firstChild() {
        return this.childNodes[0] ?? null;
      }
      get lastChild() {
        return this.childNodes[this.childNodes.length - 1] ?? null;
      }
      get previousSibling() {
        if (!this.parentNode) return null;
        const index = this.parentNode.childNodes.indexOf(this);
        return index > 0 ? this.parentNode.childNodes[index - 1] ?? null : null;
      }
      get nextSibling() {
        if (!this.parentNode) return null;
        const index = this.parentNode.childNodes.indexOf(this);
        return index >= 0 ? this.parentNode.childNodes[index + 1] ?? null : null;
      }
      get textContent() {
        return this.childNodes.map((child) => child.textContent).join("");
      }
      getAttribute(_name) {
        return null;
      }
      hasAttribute(_name) {
        return false;
      }
      append(child) {
        child.parentNode = this;
        this.childNodes.push(child);
      }
    };
    HtmlText = class extends HtmlNode {
      nodeType = 3;
      nodeName = "#text";
      value;
      constructor(value) {
        super();
        this.value = value;
      }
      get textContent() {
        return this.value;
      }
      get outerHTML() {
        return this.value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      }
    };
    HtmlElement = class extends HtmlNode {
      nodeType = 1;
      nodeName;
      #attributes;
      constructor(name, attributes) {
        super();
        this.nodeName = name.toUpperCase();
        this.#attributes = attributes;
      }
      getAttribute(name) {
        return this.#attributes.get(name.toLowerCase()) ?? null;
      }
      hasAttribute(name) {
        return this.#attributes.has(name.toLowerCase());
      }
      get outerHTML() {
        const tag = this.nodeName.toLowerCase();
        const attributes = [...this.#attributes].map(([name, value]) => value === "" ? name : `${name}="${escapeAttribute(value)}"`).join(" ");
        const opening = `<${tag}${attributes ? ` ${attributes}` : ""}>`;
        if (VOID_ELEMENTS[this.nodeName]) return opening;
        return `${opening}${this.childNodes.map((child) => child.outerHTML).join("")}</${tag}>`;
      }
    };
    HtmlFragment = class extends HtmlNode {
      nodeType = 11;
      nodeName = "#document-fragment";
      get outerHTML() {
        return this.childNodes.map((child) => child.outerHTML).join("");
      }
    };
  }
});

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/turndown/service.ts
function matchesFilter(filter, node, options) {
  if (typeof filter === "function") return filter(node, options);
  const name = node.nodeName.toLowerCase();
  if (typeof filter === "string") return name === filter.toLowerCase();
  return filter.some((tag) => name === tag.toLowerCase());
}
function contentWithFlankingWhitespace(content, delimiter) {
  const leading = content.match(/^\s+/)?.[0] ?? "";
  const trailing = content.match(/\s+$/)?.[0] ?? "";
  const body = content.slice(leading.length, trailing ? -trailing.length : void 0);
  return body ? `${leading}${delimiter}${body}${delimiter}${trailing}` : "";
}
function languageFromCode(node) {
  const code = Array.from(node.children).find((child) => child.nodeName === "CODE");
  const className = code?.getAttribute("class") ?? "";
  return /(?:^|\s)language-([^\s]+)/.exec(className)?.[1] ?? "";
}
function listItemPrefix(node, options) {
  const parent = node.parentNode;
  if (parent?.nodeName !== "OL") return `${options.bulletListMarker}   `;
  const start = Number(parent.getAttribute("start") ?? "1");
  const siblings = Array.from(parent.children);
  return `${(Number.isFinite(start) ? start : 1) + siblings.indexOf(node)}.  `;
}
function hasNonblankDescendant(node) {
  for (const child of Array.from(node.children)) {
    if (NONBLANK_EMPTY_ELEMENTS[child.nodeName] || hasNonblankDescendant(child)) return true;
  }
  return false;
}
var BLOCK_ELEMENTS, NONBLANK_EMPTY_ELEMENTS, DEFAULT_OPTIONS, TurndownService;
var init_service = __esm({
  "../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/turndown/service.ts"() {
    "use strict";
    init_html();
    BLOCK_ELEMENTS = {
      ADDRESS: true,
      ARTICLE: true,
      ASIDE: true,
      BLOCKQUOTE: true,
      BODY: true,
      CANVAS: true,
      CENTER: true,
      DD: true,
      DETAILS: true,
      DIR: true,
      DIV: true,
      DL: true,
      DT: true,
      FIELDSET: true,
      FIGCAPTION: true,
      FIGURE: true,
      FOOTER: true,
      FORM: true,
      FRAMESET: true,
      H1: true,
      H2: true,
      H3: true,
      H4: true,
      H5: true,
      H6: true,
      HEADER: true,
      HGROUP: true,
      HR: true,
      HTML: true,
      ISINDEX: true,
      LI: true,
      MAIN: true,
      MENU: true,
      NAV: true,
      NOFRAMES: true,
      NOSCRIPT: true,
      OL: true,
      OUTPUT: true,
      P: true,
      PRE: true,
      SECTION: true,
      SUMMARY: true,
      TABLE: true,
      TBODY: true,
      TD: true,
      TFOOT: true,
      TH: true,
      THEAD: true,
      TR: true,
      UL: true
    };
    NONBLANK_EMPTY_ELEMENTS = {
      A: true,
      AUDIO: true,
      BR: true,
      HR: true,
      IFRAME: true,
      IMG: true,
      INPUT: true,
      SCRIPT: true,
      SOURCE: true,
      TD: true,
      TH: true,
      VIDEO: true
    };
    DEFAULT_OPTIONS = {
      headingStyle: "setext",
      hr: "* * *",
      bulletListMarker: "*",
      codeBlockStyle: "indented",
      fence: "```",
      emDelimiter: "_",
      strongDelimiter: "**",
      linkStyle: "inlined",
      linkReferenceStyle: "full",
      preformattedCode: false
    };
    TurndownService = class {
      options;
      #rules = [];
      #keepFilters = [];
      #removeFilters = [];
      #references = [];
      #previousSourceWhitespace = false;
      constructor(options = {}) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
      }
      /** Install a highest-priority named conversion rule. */
      addRule(key, rule) {
        const previous = this.#rules.findIndex((entry) => entry.key === key);
        if (previous >= 0) this.#rules.splice(previous, 1);
        this.#rules.unshift({ key, rule });
        return this;
      }
      /** Preserve matching elements as HTML when no custom rule handles them. */
      keep(filter) {
        this.#keepFilters.unshift(filter);
        return this;
      }
      /** Drop matching elements and all of their converted content. */
      remove(filter) {
        this.#removeFilters.unshift(filter);
        return this;
      }
      /** Install one plugin or an ordered list of plugins. */
      use(plugin) {
        if (typeof plugin === "function") {
          plugin(this);
        } else {
          for (const install of plugin) install(this);
        }
        return this;
      }
      /** Escape Markdown punctuation using Turndown's public escaping rules. */
      escape(text2) {
        return text2.replace(/\\/g, "\\\\").replace(/([*_[\]])/g, "\\$1").replace(/^(\s*)(#{1,6}|[+>])(?=\s)/gm, "$1\\$2").replace(/^(\s*)-(?=\s)/gm, "$1\\-").replace(/^(\s*\d+)\.(?=\s)/gm, "$1\\.");
      }
      /** Convert an HTML string or standards-shaped DOM node to Markdown. */
      turndown(input) {
        const root = typeof input === "string" ? parseHtmlFragment(input) : input;
        this.#references = [];
        this.#previousSourceWhitespace = false;
        let markdown = root.nodeType === 9 || root.nodeType === 11 ? this.#convertChildren(root) : this.#convertNode(root);
        markdown = markdown.replace(/^[\t\r\n]+/, "").replace(/[\t\r\n ]+$/, "").replace(/\n{3,}/g, "\n\n");
        if (this.#references.length > 0) {
          markdown += `

${this.#references.map((reference) => reference.destination).join("\n")}`;
        }
        return markdown;
      }
      /** Convert only a node's children within the active conversion. */
      convertChildren(node) {
        return this.#convertChildren(node);
      }
      #convertChildren(node) {
        let content = "";
        for (const child of Array.from(node.childNodes)) content += this.#convertNode(child);
        return content;
      }
      #convertNode(node) {
        if (node.nodeType === 3) {
          const text2 = node.textContent ?? "";
          if (node.parentNode?.nodeName === "PRE") return text2;
          let collapsed = text2.replace(/[\t\r\n\f ]+/g, " ");
          if (this.#previousSourceWhitespace && collapsed.startsWith(" ")) collapsed = collapsed.slice(1);
          this.#previousSourceWhitespace = collapsed.endsWith(" ");
          return node.parentNode?.nodeName === "CODE" ? collapsed : this.escape(collapsed);
        }
        if (node.nodeType !== 1) return this.#convertChildren(node);
        if (!(node.textContent ?? "").trim() && !NONBLANK_EMPTY_ELEMENTS[node.nodeName] && !hasNonblankDescendant(node)) {
          return this.options.blankReplacement?.("", node, this.options) ?? (BLOCK_ELEMENTS[node.nodeName] ? "\n\n" : "");
        }
        const block = Boolean(BLOCK_ELEMENTS[node.nodeName]);
        if (block) this.#previousSourceWhitespace = false;
        const content = this.#convertChildren(node);
        if (block) this.#previousSourceWhitespace = false;
        if (node.nodeName === "CODE") this.#previousSourceWhitespace = false;
        const custom = this.#rules.find((entry) => matchesFilter(entry.rule.filter, node, this.options));
        if (custom) return custom.rule.replacement(content, node, this.options);
        if (this.#keepFilters.some((filter) => matchesFilter(filter, node, this.options))) {
          return this.options.keepReplacement?.(content, node, this.options) ?? serializeNode(node);
        }
        if (this.#removeFilters.some((filter) => matchesFilter(filter, node, this.options))) return "";
        return this.#defaultReplacement(content, node);
      }
      #defaultReplacement(content, node) {
        const name = node.nodeName;
        if (name === "P") return content.trim() ? `

${content.trim()}

` : "";
        if (/^H[1-6]$/.test(name)) {
          const level = Number(name.charAt(1));
          const body = content.trim();
          if (this.options.headingStyle === "setext" && level < 3) {
            return `

${body}
${(level === 1 ? "=" : "-").repeat(body.length)}

`;
          }
          return `

${"#".repeat(level)} ${body}

`;
        }
        if (name === "BR") return "  \n";
        if (name === "HR") return `

${this.options.hr}

`;
        if (name === "BLOCKQUOTE") {
          const body = content.trim().replace(/\n{3,}/g, "\n\n").replace(/^/gm, "> ");
          return body ? `

${body}

` : "";
        }
        if (name === "UL" || name === "OL") {
          const body = content.replace(/^\n+|\n+$/g, "");
          return node.parentNode?.nodeName === "LI" ? `
${body}` : `

${body}

`;
        }
        if (name === "LI") {
          const body = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, "\n    ");
          return `${listItemPrefix(node, this.options)}${body}${node.nextSibling ? "\n" : ""}`;
        }
        if (name === "PRE" && Array.from(node.children).some((child) => child.nodeName === "CODE")) {
          return this.#replacePre(node);
        }
        if (name === "EM" || name === "I") return contentWithFlankingWhitespace(content, this.options.emDelimiter);
        if (name === "STRONG" || name === "B") {
          return contentWithFlankingWhitespace(content, this.options.strongDelimiter);
        }
        if (name === "CODE") return this.#replaceInlineCode(content);
        if (name === "A") return this.#replaceLink(content, node);
        if (name === "IMG") return this.#replaceImage(node);
        if (this.options.defaultReplacement) return this.options.defaultReplacement(content, node, this.options);
        if (BLOCK_ELEMENTS[name]) return content.trim() ? `

${content.trim()}

` : "";
        return content;
      }
      #replacePre(node) {
        const text2 = node.textContent ?? "";
        if (this.options.codeBlockStyle === "indented") {
          return `

${text2.replace(/^/gm, "    ")}

`;
        }
        const fenceCharacter = this.options.fence.charAt(0);
        let longestFence = this.options.fence.length;
        let run = 0;
        for (const character of text2) {
          run = character === fenceCharacter ? run + 1 : 0;
          longestFence = Math.max(longestFence, run + 1);
        }
        const fence = fenceCharacter.repeat(longestFence);
        const body = text2.replace(/\n$/, "");
        return `

${fence}${languageFromCode(node)}
${body}
${fence}

`;
      }
      #replaceInlineCode(text2) {
        const body = text2.trim();
        if (!body) return "";
        let longestRun = 0;
        let run = 0;
        for (const character of body) {
          run = character === "`" ? run + 1 : 0;
          longestRun = Math.max(longestRun, run);
        }
        const delimiter = "`".repeat(longestRun + 1);
        const padding = /^`|`$/.test(body) ? " " : "";
        return `${delimiter}${padding}${body}${padding}${delimiter}`;
      }
      #replaceLink(content, node) {
        const href = (node.getAttribute("href") ?? "").replace(/([()<>])/g, "\\$1");
        const title = node.getAttribute("title");
        const destination = `${href}${title ? ` "${title.replace(/"/g, '\\"')}"` : ""}`;
        if (this.options.linkStyle !== "referenced") return `[${content}](${destination})`;
        const referenceNumber = this.#references.length + 1;
        let label = String(referenceNumber);
        if (this.options.linkReferenceStyle === "collapsed") label = "";
        if (this.options.linkReferenceStyle === "shortcut") label = content;
        const marker = this.options.linkReferenceStyle === "shortcut" ? `[${content}]` : `[${content}][${label}]`;
        this.#references.push({ destination: `[${label || content}]: ${destination}` });
        return marker;
      }
      #replaceImage(node) {
        const source = (node.getAttribute("src") ?? "").replace(/([()<>])/g, "\\$1");
        if (!source) return "";
        const alternative = this.escape(node.getAttribute("alt") ?? "");
        const title = node.getAttribute("title");
        return `![${alternative}](${source}${title ? ` "${title.replace(/"/g, '\\"')}"` : ""})`;
      }
    };
  }
});

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/turndown/types.ts
var init_types = __esm({
  "../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/turndown/types.ts"() {
    "use strict";
  }
});

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/turndown/index.ts
var turndown_exports = {};
__export(turndown_exports, {
  TurndownService: () => TurndownService,
  default: () => TurndownService,
  gfm: () => gfm,
  highlightedCodeBlock: () => highlightedCodeBlock,
  strikethrough: () => strikethrough,
  tables: () => tables,
  taskListItems: () => taskListItems
});
var init_turndown = __esm({
  "../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/turndown/index.ts"() {
    "use strict";
    init_gfm();
    init_service();
    init_types();
  }
});

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/dom/parser.ts
function decodeEntities2(value) {
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (whole, entity) => {
    if (entity[0] !== "#") return NAMED_ENTITIES2[entity] ?? NAMED_ENTITIES2[entity.toLowerCase()] ?? whole;
    const hexadecimal = entity[1]?.toLowerCase() === "x";
    const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 1114111 || codePoint >= 55296 && codePoint <= 57343) {
      return "\uFFFD";
    }
    return String.fromCodePoint(codePoint);
  });
}
function findTagEnd(html, start) {
  let quote = "";
  for (let index = start; index < html.length; index++) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return html.length - 1;
}
function parseStartTag(source) {
  let index = 0;
  while (/\s/.test(source[index] ?? "")) index++;
  const nameMatch = /^[^\s/>]+/.exec(source.slice(index));
  if (!nameMatch) return null;
  const name = nameMatch[0].toLowerCase();
  index += nameMatch[0].length;
  const attributes = [];
  let selfClosing = false;
  while (index < source.length) {
    while (/\s/.test(source[index] ?? "")) index++;
    if (source[index] === "/") {
      selfClosing = true;
      break;
    }
    const attributeMatch = /^[^\s=/>]+/.exec(source.slice(index));
    if (!attributeMatch) break;
    const attributeName = attributeMatch[0];
    index += attributeMatch[0].length;
    while (/\s/.test(source[index] ?? "")) index++;
    let value = "";
    if (source[index] === "=") {
      index++;
      while (/\s/.test(source[index] ?? "")) index++;
      const quote = source[index];
      if (quote === '"' || quote === "'") {
        index++;
        const end = source.indexOf(quote, index);
        if (end < 0) {
          value = source.slice(index);
          index = source.length;
        } else {
          value = source.slice(index, end);
          index = end + 1;
        }
      } else {
        const valueMatch = /^[^\s>]+/.exec(source.slice(index));
        value = valueMatch?.[0] ?? "";
        index += value.length;
      }
    }
    if (!attributes.some(([existing]) => existing.toLowerCase() === attributeName.toLowerCase())) {
      attributes.push([attributeName, decodeEntities2(value)]);
    }
  }
  return { name, attributes, selfClosing };
}
function closeOptionalElements(stack, incoming) {
  const current = stack[stack.length - 1];
  if (!current) return;
  if (current.localName === "p" && P_CLOSERS[incoming]) {
    stack.pop();
    return;
  }
  const closeable = CLOSE_ON_OPEN[incoming];
  if (closeable?.includes(current.localName)) stack.pop();
}
function parseInto(html, document2, root, contextTag) {
  const stack = [];
  const xmlLike = root instanceof Document && /^\s*(?:<\?xml[\s\S]*?\?>\s*)?<(?:feed|rss)\b/i.test(html);
  let parent = root;
  let index = 0;
  while (index < html.length) {
    if (html.startsWith("<!--", index)) {
      const end2 = html.indexOf("-->", index + 4);
      const contentEnd = end2 < 0 ? html.length : end2;
      parent.appendChild(document2.createComment(html.slice(index + 4, contentEnd)));
      index = end2 < 0 ? html.length : end2 + 3;
      continue;
    }
    if (html[index] !== "<") {
      const next = html.indexOf("<", index);
      const end2 = next < 0 ? html.length : next;
      parent.appendChild(new Text(decodeEntities2(html.slice(index, end2)), document2, xmlLike));
      index = end2;
      continue;
    }
    if (/^<!doctype\b/i.test(html.slice(index))) {
      const end2 = html.indexOf(">", index + 2);
      index = end2 < 0 ? html.length : end2 + 1;
      continue;
    }
    if (html.startsWith("<![CDATA[", index)) {
      const end2 = html.indexOf("]]>", index + 9);
      const contentEnd = end2 < 0 ? html.length : end2;
      parent.appendChild(new Text(html.slice(index + 9, contentEnd), document2, xmlLike));
      index = end2 < 0 ? html.length : end2 + 3;
      continue;
    }
    if (html[index + 1] === "/") {
      const end2 = findTagEnd(html, index + 2);
      const closingName = html.slice(index + 2, end2).trim().split(/\s/, 1)[0].toLowerCase();
      const matchIndex = stack.findLastIndex((element2) => element2.localName === closingName);
      if (matchIndex >= 0) stack.length = matchIndex;
      parent = stack[stack.length - 1] ?? root;
      index = end2 + 1;
      continue;
    }
    if (html[index + 1] === "!" || html[index + 1] === "?") {
      const end2 = html.indexOf(">", index + 2);
      index = end2 < 0 ? html.length : end2 + 1;
      continue;
    }
    const end = findTagEnd(html, index + 1);
    const parsed = parseStartTag(html.slice(index + 1, end));
    if (!parsed) {
      parent.appendChild(document2.createTextNode("<"));
      index++;
      continue;
    }
    closeOptionalElements(stack, parsed.name);
    parent = stack[stack.length - 1] ?? root;
    const namespace = parent instanceof Element && parent.namespaceURI === "http://www.w3.org/2000/svg" ? "http://www.w3.org/2000/svg" : parsed.name === "svg" ? "http://www.w3.org/2000/svg" : "http://www.w3.org/1999/xhtml";
    const element = document2.createElementNS(namespace, parsed.name);
    for (let attributeIndex = parsed.attributes.length - 1; attributeIndex >= 0; attributeIndex--) {
      const [name, value] = parsed.attributes[attributeIndex];
      element.setAttribute(name, value);
    }
    parent.appendChild(element);
    index = end + 1;
    if (RAW_TEXT_ELEMENTS[parsed.name] && !parsed.selfClosing) {
      const closePattern = new RegExp(`</${parsed.name}\\s*>`, "ig");
      closePattern.lastIndex = index;
      const match = closePattern.exec(html);
      const rawEnd = match?.index ?? html.length;
      element.appendChild(new Text(html.slice(index, rawEnd), document2));
      index = match ? closePattern.lastIndex : html.length;
      continue;
    }
    if (!VOID_ELEMENTS2[parsed.name] && !(namespace === "http://www.w3.org/2000/svg" && parsed.selfClosing)) {
      stack.push(element);
      parent = element;
    }
  }
}
function parseFragment(html, document2, contextTag) {
  const fragment = document2.createDocumentFragment();
  parseInto(html, document2, fragment, contextTag);
  return fragment;
}
function parseDocument(html) {
  const document2 = new Document();
  parseInto(html, document2, document2);
  return document2;
}
var RAW_TEXT_ELEMENTS, VOID_ELEMENTS2, CLOSE_ON_OPEN, P_CLOSERS, NAMED_ENTITIES2;
var init_parser = __esm({
  "../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/dom/parser.ts"() {
    "use strict";
    init_core();
    RAW_TEXT_ELEMENTS = { script: true, style: true };
    VOID_ELEMENTS2 = {
      area: true,
      base: true,
      br: true,
      col: true,
      embed: true,
      hr: true,
      img: true,
      input: true,
      link: true,
      meta: true,
      param: true,
      source: true,
      track: true,
      wbr: true
    };
    CLOSE_ON_OPEN = {
      li: ["li"],
      dt: ["dt", "dd"],
      dd: ["dt", "dd"],
      tr: ["tr"],
      th: ["th", "td"],
      td: ["th", "td"],
      option: ["option"],
      thead: ["thead", "tbody", "tfoot"],
      tbody: ["thead", "tbody", "tfoot"],
      tfoot: ["thead", "tbody", "tfoot"]
    };
    P_CLOSERS = {
      address: true,
      article: true,
      aside: true,
      blockquote: true,
      div: true,
      dl: true,
      fieldset: true,
      footer: true,
      form: true,
      h1: true,
      h2: true,
      h3: true,
      h4: true,
      h5: true,
      h6: true,
      header: true,
      hr: true,
      menu: true,
      nav: true,
      ol: true,
      p: true,
      pre: true,
      section: true,
      table: true,
      ul: true
    };
    NAMED_ENTITIES2 = {
      AElig: "\xC6",
      Aacute: "\xC1",
      Acirc: "\xC2",
      Agrave: "\xC0",
      Aring: "\xC5",
      Atilde: "\xC3",
      Auml: "\xC4",
      Ccedil: "\xC7",
      ETH: "\xD0",
      Eacute: "\xC9",
      Ecirc: "\xCA",
      Egrave: "\xC8",
      Euml: "\xCB",
      Iacute: "\xCD",
      Icirc: "\xCE",
      Igrave: "\xCC",
      Iuml: "\xCF",
      Ntilde: "\xD1",
      Oacute: "\xD3",
      Ocirc: "\xD4",
      Ograve: "\xD2",
      Oslash: "\xD8",
      Otilde: "\xD5",
      Ouml: "\xD6",
      THORN: "\xDE",
      Uacute: "\xDA",
      Ucirc: "\xDB",
      Ugrave: "\xD9",
      Uuml: "\xDC",
      Yacute: "\xDD",
      aacute: "\xE1",
      acirc: "\xE2",
      aelig: "\xE6",
      agrave: "\xE0",
      aring: "\xE5",
      atilde: "\xE3",
      auml: "\xE4",
      amp: "&",
      apos: "'",
      bull: "\u2022",
      brvbar: "\xA6",
      ccedil: "\xE7",
      cedil: "\xB8",
      cent: "\xA2",
      copy: "\xA9",
      deg: "\xB0",
      curren: "\xA4",
      divide: "\xF7",
      emsp: "\u2003",
      ensp: "\u2002",
      euro: "\u20AC",
      eacute: "\xE9",
      ecirc: "\xEA",
      egrave: "\xE8",
      eth: "\xF0",
      euml: "\xEB",
      frac12: "\xBD",
      frac14: "\xBC",
      frac34: "\xBE",
      gt: ">",
      iacute: "\xED",
      icirc: "\xEE",
      iexcl: "\xA1",
      igrave: "\xEC",
      iquest: "\xBF",
      iuml: "\xEF",
      hellip: "\u2026",
      laquo: "\xAB",
      ldquo: "\u201C",
      lsquo: "\u2018",
      lt: "<",
      mdash: "\u2014",
      macr: "\xAF",
      micro: "\xB5",
      middot: "\xB7",
      nbsp: "\xA0",
      ndash: "\u2013",
      ntilde: "\xF1",
      oacute: "\xF3",
      ocirc: "\xF4",
      ograve: "\xF2",
      ordf: "\xAA",
      ordm: "\xBA",
      oslash: "\xF8",
      otilde: "\xF5",
      ouml: "\xF6",
      para: "\xB6",
      pound: "\xA3",
      plusmn: "\xB1",
      quot: '"',
      raquo: "\xBB",
      rdquo: "\u201D",
      reg: "\xAE",
      rsquo: "\u2019",
      sect: "\xA7",
      shy: "\xAD",
      szlig: "\xDF",
      thorn: "\xFE",
      sup1: "\xB9",
      sup2: "\xB2",
      sup3: "\xB3",
      thinsp: "\u2009",
      times: "\xD7",
      trade: "\u2122",
      uacute: "\xFA",
      ucirc: "\xFB",
      ugrave: "\xF9",
      uml: "\xA8",
      uuml: "\xFC",
      yacute: "\xFD",
      yuml: "\xFF",
      yen: "\xA5"
    };
  }
});

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/dom/selector.ts
function splitTopLevel(value, delimiter) {
  const parts = [];
  let start = 0;
  let brackets = 0;
  let parentheses = 0;
  let quote = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "[") brackets++;
    else if (character === "]") brackets--;
    else if (character === "(") parentheses++;
    else if (character === ")") parentheses--;
    else if (character === delimiter && brackets === 0 && parentheses === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}
function parseComplex(selector) {
  const simples = [];
  const combinators = [];
  let current = "";
  let brackets = 0;
  let parentheses = 0;
  let quote = "";
  for (let index = 0; index < selector.length; index++) {
    const character = selector[index];
    if (quote) {
      current += character;
      if (character === quote && selector[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "[") brackets++;
    else if (character === "]") brackets--;
    else if (character === "(") parentheses++;
    else if (character === ")") parentheses--;
    if (brackets || parentheses) {
      current += character;
      continue;
    }
    if (character === ">" || character === "+" || character === "~") {
      if (current.trim()) simples.push(current.trim());
      current = "";
      combinators.push(character);
      while (/\s/.test(selector[index + 1] ?? "")) index++;
      continue;
    }
    if (/\s/.test(character)) {
      while (/\s/.test(selector[index + 1] ?? "")) index++;
      const next = selector[index + 1];
      if (current.trim()) {
        simples.push(current.trim());
        current = "";
        if (next !== ">" && next !== "+" && next !== "~" && next !== void 0) combinators.push(" ");
      }
      continue;
    }
    current += character;
  }
  if (current.trim()) simples.push(current.trim());
  while (combinators.length >= simples.length) combinators.pop();
  return { simples, combinators };
}
function readIdentifier(source, start) {
  let value = "";
  let index = start;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\" && index + 1 < source.length) {
      value += source[index + 1];
      index += 2;
      continue;
    }
    if (!/[a-zA-Z0-9_-]/.test(character)) break;
    value += character;
    index++;
  }
  return { value, end: index };
}
function findClosing(source, start, opener, closer) {
  let depth = 1;
  let quote = "";
  for (let index = start + 1; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index - 1] !== "\\") quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === opener) depth++;
    else if (character === closer && --depth === 0) return index;
  }
  return source.length - 1;
}
function matchAttribute(element, expression) {
  const match = /^\s*([^\s~|^$*!=]+)\s*(?:(\^=|\$=|\*=|~=|\|=|=)\s*(?:(["'])(.*?)\3|([^\s]+))\s*([isIS])?)?\s*$/.exec(
    expression
  );
  if (!match) return false;
  const [, name, operator, , quotedValue, bareValue, flag] = match;
  const actual = element.getAttribute(name);
  if (!operator) return actual !== null;
  if (actual === null) return false;
  let left = actual;
  let right = (quotedValue ?? bareValue ?? "").replace(/\\(.)/g, "$1");
  if (flag?.toLowerCase() === "i") {
    left = left.toLowerCase();
    right = right.toLowerCase();
  }
  switch (operator) {
    case "=":
      return left === right;
    case "^=":
      return left.startsWith(right);
    case "$=":
      return left.endsWith(right);
    case "*=":
      return left.includes(right);
    case "~=":
      return left.split(/\s+/).includes(right);
    case "|=":
      return left === right || left.startsWith(`${right}-`);
    default:
      return false;
  }
}
function matchNth(element, expression) {
  const siblings = element.parentElement?.children ?? [];
  const index = siblings.indexOf(element) + 1;
  const normalized = expression.trim().toLowerCase().replace(/\s+/g, "");
  if (normalized === "odd") return index % 2 === 1;
  if (normalized === "even") return index % 2 === 0;
  if (/^[+-]?\d+$/.test(normalized)) return index === Number(normalized);
  const match = /^([+-]?\d*)n([+-]\d+)?$/.exec(normalized);
  if (!match) return false;
  const coefficient = match[1] === "" || match[1] === "+" ? 1 : match[1] === "-" ? -1 : Number(match[1]);
  const offset = Number(match[2] ?? 0);
  return coefficient === 0 ? index === offset : (index - offset) / coefficient >= 0 && Number.isInteger((index - offset) / coefficient);
}
function matchPseudo(element, name, argument) {
  switch (name) {
    case "not":
      return argument !== void 0 && !matchesSelector(element, argument);
    case "is":
    case "where":
      return argument !== void 0 && matchesSelector(element, argument);
    case "first-child":
      return element.parentElement?.firstElementChild === element;
    case "last-child":
      return element.parentElement?.lastElementChild === element;
    case "only-child":
      return element.parentElement?.children.length === 1;
    case "empty":
      return element.childNodes.every((child) => child.nodeType === Node.COMMENT_NODE || child.textContent === "");
    case "root":
      return element.ownerDocument?.documentElement === element;
    case "nth-child":
      return argument !== void 0 && matchNth(element, argument);
    case "first-of-type": {
      for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.tagName === element.tagName) return false;
      }
      return true;
    }
    case "last-of-type": {
      for (let sibling = element.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
        if (sibling.tagName === element.tagName) return false;
      }
      return true;
    }
    default:
      return false;
  }
}
function matchSimple(element, selector) {
  let index = 0;
  if (selector[index] === "*") index++;
  else if (/[a-zA-Z_]/.test(selector[index] ?? "")) {
    const tag = readIdentifier(selector, index);
    if (element.localName !== tag.value.toLowerCase()) return false;
    index = tag.end;
  }
  while (index < selector.length) {
    const marker = selector[index];
    if (marker === "#" || marker === ".") {
      const identifier = readIdentifier(selector, index + 1);
      if (!identifier.value) return false;
      if (marker === "#" ? element.id !== identifier.value : !element.classList.contains(identifier.value))
        return false;
      index = identifier.end;
      continue;
    }
    if (marker === "[") {
      const end = findClosing(selector, index, "[", "]");
      if (!matchAttribute(element, selector.slice(index + 1, end))) return false;
      index = end + 1;
      continue;
    }
    if (marker === ":") {
      const identifier = readIdentifier(selector, index + 1);
      let argument;
      index = identifier.end;
      if (selector[index] === "(") {
        const end = findClosing(selector, index, "(", ")");
        argument = selector.slice(index + 1, end);
        index = end + 1;
      }
      if (!matchPseudo(element, identifier.value.toLowerCase(), argument)) return false;
      continue;
    }
    return false;
  }
  return true;
}
function matchComplexAt(element, complex, index) {
  if (!matchSimple(element, complex.simples[index])) return false;
  if (index === 0) return true;
  const combinator = complex.combinators[index - 1] ?? " ";
  if (combinator === ">")
    return element.parentElement !== null && matchComplexAt(element.parentElement, complex, index - 1);
  if (combinator === "+")
    return element.previousElementSibling !== null && matchComplexAt(element.previousElementSibling, complex, index - 1);
  if (combinator === "~") {
    for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      if (matchComplexAt(sibling, complex, index - 1)) return true;
    }
    return false;
  }
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (matchComplexAt(ancestor, complex, index - 1)) return true;
  }
  return false;
}
function matchesSelector(element, selector) {
  for (const part of splitTopLevel(selector, ",")) {
    const complex = parseComplex(part);
    if (complex.simples.length && matchComplexAt(element, complex, complex.simples.length - 1)) return true;
  }
  return false;
}
function querySelectorAllFrom(root, selector, includeRoot) {
  const result = [];
  const visit = (node) => {
    if (node instanceof Element && matchesSelector(node, selector)) result.push(node);
    for (const child of node.childNodes) visit(child);
  };
  if (includeRoot) {
    for (const child of root.childNodes) visit(child);
  } else {
    for (const child of root.childNodes) visit(child);
  }
  return result;
}
var init_selector = __esm({
  "../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/dom/selector.ts"() {
    "use strict";
    init_core();
  }
});

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/dom/core.ts
function escapeText(value) {
  return value.replace(/&/g, "&amp;").replace(/ /g, "&#160;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttribute2(value) {
  return value.replace(/"/g, "&quot;");
}
function serializeNode2(node) {
  if (node instanceof Comment) return `<!--${node.data}-->`;
  if (node instanceof Text) return node.serializeRaw ? node.data : escapeText(node.data);
  if (node instanceof Document || node instanceof DocumentFragment) return node.childNodes.map(serializeNode2).join("");
  if (!(node instanceof Element)) return "";
  const attributes = node.attributes.map(
    (attr) => attr.value === "" && BOOLEAN_ATTRIBUTES[attr.name.toLowerCase()] ? ` ${attr.name}` : ` ${attr.name}="${escapeAttribute2(attr.value)}"`
  ).join("");
  const style = node.style.cssText && !node.attributes.getNamedItem("style") ? ` style="${escapeAttribute2(node.style.cssText)}"` : "";
  const opening = `<${node.qualifiedName}${attributes}${style}>`;
  if (VOID_ELEMENTS3[node.localName]) return opening;
  const raw = node.localName === "script" || node.localName === "style";
  const childNodes = node instanceof HTMLTemplateElement ? node.content.childNodes : node.childNodes;
  const content = raw ? childNodes.map((child) => child instanceof Text ? child.data : serializeNode2(child)).join("") : childNodes.map(serializeNode2).join("");
  return `${opening}${content}</${node.qualifiedName}>`;
}
function cssEscapeIdentifier(value) {
  return value.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}
var NodeType, Event, CustomEvent, EventTarget, Node, Text, Comment, Attr, NamedNodeMap, DOMTokenList, CSSStyleDeclaration, HTML_NAMESPACE, SVG_NAMESPACE, Element, HTMLElement, HTMLMetaElement, SVGElement, HTMLIFrameElement2, DocumentFragment, HTMLTemplateElement, Document, DOMWindow, VOID_ELEMENTS3, BOOLEAN_ATTRIBUTES;
var init_core = __esm({
  "../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/dom/core.ts"() {
    "use strict";
    init_parser();
    init_selector();
    NodeType = /* @__PURE__ */ ((NodeType2) => {
      NodeType2[NodeType2["ELEMENT"] = 1] = "ELEMENT";
      NodeType2[NodeType2["ATTRIBUTE"] = 2] = "ATTRIBUTE";
      NodeType2[NodeType2["TEXT"] = 3] = "TEXT";
      NodeType2[NodeType2["COMMENT"] = 8] = "COMMENT";
      NodeType2[NodeType2["DOCUMENT"] = 9] = "DOCUMENT";
      NodeType2[NodeType2["DOCUMENT_FRAGMENT"] = 11] = "DOCUMENT_FRAGMENT";
      return NodeType2;
    })(NodeType || {});
    Event = class {
      type;
      bubbles;
      cancelable;
      target = null;
      currentTarget = null;
      defaultPrevented = false;
      #stopped = false;
      constructor(type, init = {}) {
        this.type = type;
        this.bubbles = init.bubbles ?? false;
        this.cancelable = init.cancelable ?? false;
      }
      /** Initialize an event created through Document.createEvent. */
      initEvent(type, bubbles = false, cancelable = false) {
        this.type = type;
        this.bubbles = bubbles;
        this.cancelable = cancelable;
        this.defaultPrevented = false;
      }
      /** Cancel this event when it is cancelable. */
      preventDefault() {
        if (this.cancelable) this.defaultPrevented = true;
      }
      /** Stop bubbling this event. */
      stopPropagation() {
        this.#stopped = true;
      }
      /** Whether propagation has been stopped. */
      get propagationStopped() {
        return this.#stopped;
      }
    };
    CustomEvent = class extends Event {
      detail;
      constructor(type, init = {}) {
        super(type, init);
        this.detail = init.detail;
      }
    };
    EventTarget = class {
      #listeners = /* @__PURE__ */ new Map();
      /** Register an event listener. */
      addEventListener(type, listener) {
        if (!listener) return;
        let listeners = this.#listeners.get(type);
        if (!listeners) {
          listeners = /* @__PURE__ */ new Set();
          this.#listeners.set(type, listeners);
        }
        listeners.add(listener);
      }
      /** Remove an event listener. */
      removeEventListener(type, listener) {
        if (listener) this.#listeners.get(type)?.delete(listener);
      }
      /** Dispatch an event to listeners and optionally through node ancestors. */
      dispatchEvent(event) {
        if (!event.target) event.target = this;
        event.currentTarget = this;
        for (const listener of Array.from(this.#listeners.get(event.type) ?? [])) {
          if (typeof listener === "function") listener.call(this, event);
          else listener.handleEvent(event);
          if (event.propagationStopped) break;
        }
        if (event.bubbles && !event.propagationStopped && this instanceof Node && this.parentNode) {
          this.parentNode.dispatchEvent(event);
        }
        return !event.defaultPrevented;
      }
    };
    Node = class _Node extends EventTarget {
      static ELEMENT_NODE = 1 /* ELEMENT */;
      static ATTRIBUTE_NODE = 2 /* ATTRIBUTE */;
      static TEXT_NODE = 3 /* TEXT */;
      static COMMENT_NODE = 8 /* COMMENT */;
      static DOCUMENT_NODE = 9 /* DOCUMENT */;
      static DOCUMENT_FRAGMENT_NODE = 11 /* DOCUMENT_FRAGMENT */;
      nodeType;
      nodeName;
      parentNode = null;
      ownerDocument;
      childNodes = [];
      constructor(nodeType, nodeName, ownerDocument = null) {
        super();
        this.nodeType = nodeType;
        this.nodeName = nodeName;
        this.ownerDocument = ownerDocument;
      }
      /** First child node, if present. */
      get firstChild() {
        return this.childNodes[0] ?? null;
      }
      /** Last child node, if present. */
      get lastChild() {
        return this.childNodes[this.childNodes.length - 1] ?? null;
      }
      /** Previous node with the same parent. */
      get previousSibling() {
        if (!this.parentNode) return null;
        const index = this.parentNode.childNodes.indexOf(this);
        return index > 0 ? this.parentNode.childNodes[index - 1] : null;
      }
      /** Next node with the same parent. */
      get nextSibling() {
        if (!this.parentNode) return null;
        const index = this.parentNode.childNodes.indexOf(this);
        return index >= 0 ? this.parentNode.childNodes[index + 1] ?? null : null;
      }
      /** Connectedness to a document. */
      get isConnected() {
        let node = this;
        while (node?.parentNode) node = node.parentNode;
        return node?.nodeType === 9 /* DOCUMENT */;
      }
      /** Node value for character-data nodes. */
      get nodeValue() {
        return null;
      }
      set nodeValue(_value) {
      }
      /** Text contained by this node. */
      get textContent() {
        return this.childNodes.map((child) => child.textContent ?? "").join("");
      }
      set textContent(value) {
        this.replaceChildren();
        if (value) this.appendChild(this.documentForCreation().createTextNode(value));
      }
      /** Parent element, excluding document and fragments. */
      get parentElement() {
        return this.parentNode instanceof Element ? this.parentNode : null;
      }
      /** Append a node, moving it from its old parent. */
      appendChild(child) {
        const node = child;
        if (node === this || node.contains(this)) throw new Error("The new child is an ancestor of this node");
        if (child instanceof DocumentFragment) {
          for (const nested of Array.from(child.childNodes)) this.appendChild(nested);
          return child;
        }
        child.parentNode?.removeChild(child);
        child.parentNode = this;
        child.setOwnerDocument(this.documentForCreation());
        this.childNodes.push(child);
        return child;
      }
      /** Insert a node before a current child, or append for null. */
      insertBefore(child, reference) {
        if (reference === null) return this.appendChild(child);
        const index = this.childNodes.indexOf(reference);
        if (index < 0) throw new Error("The reference node is not a child of this node");
        if (child instanceof DocumentFragment) {
          for (const nested of Array.from(child.childNodes)) this.insertBefore(nested, reference);
          return child;
        }
        child.parentNode?.removeChild(child);
        child.parentNode = this;
        child.setOwnerDocument(this.documentForCreation());
        this.childNodes.splice(index, 0, child);
        return child;
      }
      /** Replace a current child with another node. */
      replaceChild(child, previous) {
        const index = this.childNodes.indexOf(previous);
        if (index < 0) throw new Error("The node to replace is not a child of this node");
        this.removeChild(previous);
        this.insertBefore(child, this.childNodes[index] ?? null);
        return previous;
      }
      /** Remove a current child. */
      removeChild(child) {
        const index = this.childNodes.indexOf(child);
        if (index < 0) throw new Error("The node to remove is not a child of this node");
        this.childNodes.splice(index, 1);
        child.parentNode = null;
        return child;
      }
      /** Replace all children with nodes or strings. */
      replaceChildren(...children) {
        for (const child of this.childNodes) child.parentNode = null;
        this.childNodes = [];
        this.append(...children);
      }
      /** Append nodes or strings. */
      append(...children) {
        for (const child of children) {
          this.appendChild(typeof child === "string" ? this.documentForCreation().createTextNode(child) : child);
        }
      }
      /** Prepend nodes or strings. */
      prepend(...children) {
        const reference = this.firstChild;
        for (const child of children) {
          this.insertBefore(
            typeof child === "string" ? this.documentForCreation().createTextNode(child) : child,
            reference
          );
        }
      }
      /** Remove this node from its parent. */
      remove() {
        this.parentNode?.removeChild(this);
      }
      /** Replace this node in its parent. */
      replaceWith(...nodes) {
        const parent = this.parentNode;
        if (!parent) return;
        for (const node of nodes) {
          parent.insertBefore(typeof node === "string" ? this.documentForCreation().createTextNode(node) : node, this);
        }
        parent.removeChild(this);
      }
      /** Whether this node contains another node. */
      contains(other) {
        for (let node = other; node; node = node.parentNode) if (node === this) return true;
        return false;
      }
      /** Clone this node, optionally including descendants. */
      cloneNode(deep = false) {
        const clone = new _Node(this.nodeType, this.nodeName, this.ownerDocument);
        if (deep) for (const child of this.childNodes) clone.appendChild(child.cloneNode(true));
        return clone;
      }
      /** Compare tree position sufficiently for document-order consumers. */
      compareDocumentPosition(other) {
        if (this === other) return 0;
        if (this.contains(other)) return 20;
        if (other.contains(this)) return 10;
        const root = this.ownerDocument ?? this;
        const nodes = [];
        const visit = (node) => {
          nodes.push(node);
          for (const child of node.childNodes) visit(child);
        };
        visit(root);
        return nodes.indexOf(this) < nodes.indexOf(other) ? 4 : 2;
      }
      setOwnerDocument(document2) {
        if (this.nodeType !== 9 /* DOCUMENT */) this.ownerDocument = document2;
        for (const child of this.childNodes) child.setOwnerDocument(document2);
      }
      documentForCreation() {
        if (this instanceof Document) return this;
        if (!this.ownerDocument) throw new Error("This node has no owner document");
        return this.ownerDocument;
      }
    };
    Text = class _Text extends Node {
      data;
      serializeRaw;
      constructor(data, ownerDocument = null, serializeRaw = false) {
        super(3 /* TEXT */, "#text", ownerDocument);
        this.data = data;
        this.serializeRaw = serializeRaw;
      }
      /** Number of UTF-16 code units. */
      get length() {
        return this.data.length;
      }
      get nodeValue() {
        return this.data;
      }
      set nodeValue(value) {
        this.data = value ?? "";
      }
      get textContent() {
        return this.data;
      }
      set textContent(value) {
        this.data = value ?? "";
      }
      /** Split this text node at an offset. */
      splitText(offset) {
        const tail = new _Text(this.data.slice(offset), this.ownerDocument, this.serializeRaw);
        this.data = this.data.slice(0, offset);
        this.parentNode?.insertBefore(tail, this.nextSibling);
        return tail;
      }
      cloneNode() {
        return new _Text(this.data, this.ownerDocument, this.serializeRaw);
      }
    };
    Comment = class _Comment extends Text {
      constructor(data, ownerDocument = null) {
        super(data, ownerDocument);
        Object.defineProperty(this, "nodeType", { value: 8 /* COMMENT */ });
        Object.defineProperty(this, "nodeName", { value: "#comment" });
      }
      cloneNode() {
        return new _Comment(this.data, this.ownerDocument);
      }
    };
    Attr = class _Attr extends Node {
      name;
      value;
      namespaceURI;
      constructor(name, value, ownerDocument = null, namespaceURI = null) {
        super(2 /* ATTRIBUTE */, name, ownerDocument);
        this.name = name;
        this.value = value;
        this.namespaceURI = namespaceURI;
      }
      get nodeValue() {
        return this.value;
      }
      set nodeValue(value) {
        this.value = value ?? "";
      }
      get textContent() {
        return this.value;
      }
      set textContent(value) {
        this.value = value ?? "";
      }
      cloneNode() {
        return new _Attr(this.name, this.value, this.ownerDocument, this.namespaceURI);
      }
    };
    NamedNodeMap = class extends Array {
      /** Find an attribute case-insensitively. */
      getNamedItem(name) {
        const normalized = name.toLowerCase();
        return this.find((attr) => attr.name.toLowerCase() === normalized) ?? null;
      }
      /** Set an attribute object and return the prior one. */
      setNamedItem(attr) {
        const previous = this.getNamedItem(attr.name);
        if (previous) this.splice(this.indexOf(previous), 1, attr);
        else this.push(attr);
        return previous;
      }
      /** Remove and return a named attribute. */
      removeNamedItem(name) {
        const attr = this.getNamedItem(name);
        if (!attr) throw new Error(`Attribute not found: ${name}`);
        this.splice(this.indexOf(attr), 1);
        return attr;
      }
    };
    DOMTokenList = class {
      #element;
      constructor(element) {
        this.#element = element;
      }
      #tokens() {
        return this.#element.className.trim() ? this.#element.className.trim().split(/\s+/) : [];
      }
      #write(tokens) {
        this.#element.className = [...new Set(tokens)].join(" ");
      }
      /** Token count. */
      get length() {
        return this.#tokens().length;
      }
      /** String representation. */
      get value() {
        return this.#element.className;
      }
      set value(value) {
        this.#element.className = value;
      }
      /** Add class tokens. */
      add(...tokens) {
        this.#write([...this.#tokens(), ...tokens]);
      }
      /** Remove class tokens. */
      remove(...tokens) {
        const removed = new Set(tokens);
        this.#write(this.#tokens().filter((token) => !removed.has(token)));
      }
      /** Whether a class token exists. */
      contains(token) {
        return this.#tokens().includes(token);
      }
      /** Toggle a class token. */
      toggle(token, force) {
        const present = this.contains(token);
        const enabled = force ?? !present;
        if (enabled && !present) this.add(token);
        else if (!enabled && present) this.remove(token);
        return enabled;
      }
      /** Replace one class token with another. */
      replace(previous, next) {
        const tokens = this.#tokens();
        const index = tokens.indexOf(previous);
        if (index < 0) return false;
        tokens[index] = next;
        this.#write(tokens);
        return true;
      }
      /** Token at an index. */
      item(index) {
        return this.#tokens()[index] ?? null;
      }
      [Symbol.iterator]() {
        return this.#tokens()[Symbol.iterator]();
      }
      toString() {
        return this.value;
      }
    };
    CSSStyleDeclaration = class {
      #values = /* @__PURE__ */ new Map();
      /** Serialized declarations. */
      get cssText() {
        return [...this.#values].map(([name, value]) => `${name}: ${value};`).join(" ");
      }
      set cssText(value) {
        this.#values.clear();
        for (const declaration of value.split(";")) {
          const colon = declaration.indexOf(":");
          if (colon > 0) this.setProperty(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
        }
      }
      /** Read a CSS property. */
      getPropertyValue(name) {
        return this.#values.get(name) ?? "";
      }
      /** Set a CSS property. */
      setProperty(name, value, _priority) {
        if (value === null || value === "") this.#values.delete(name);
        else this.#values.set(name, String(value));
      }
      /** Remove and return a CSS property. */
      removeProperty(name) {
        const value = this.getPropertyValue(name);
        this.#values.delete(name);
        return value;
      }
    };
    HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
    SVG_NAMESPACE = "http://www.w3.org/2000/svg";
    Element = class _Element extends Node {
      localName;
      tagName;
      namespaceURI;
      qualifiedName;
      attributes = new NamedNodeMap();
      classList;
      style = new CSSStyleDeclaration();
      constructor(tagName, ownerDocument = null, namespaceURI = HTML_NAMESPACE) {
        const localName = tagName.toLowerCase();
        const qualified = namespaceURI === HTML_NAMESPACE ? localName.toUpperCase() : tagName;
        super(1 /* ELEMENT */, qualified, ownerDocument);
        this.localName = localName;
        this.tagName = qualified;
        this.qualifiedName = tagName;
        this.namespaceURI = namespaceURI;
        this.classList = new DOMTokenList(this);
      }
      /** Element children. */
      get children() {
        return this.childNodes.filter((child) => child instanceof _Element);
      }
      /** First element child. */
      get firstElementChild() {
        return this.children[0] ?? null;
      }
      /** Last element child. */
      get lastElementChild() {
        const children = this.children;
        return children[children.length - 1] ?? null;
      }
      /** Previous sibling that is an element. */
      get previousElementSibling() {
        for (let node = this.previousSibling; node; node = node.previousSibling) if (node instanceof _Element) return node;
        return null;
      }
      /** Next sibling that is an element. */
      get nextElementSibling() {
        for (let node = this.nextSibling; node; node = node.nextSibling) if (node instanceof _Element) return node;
        return null;
      }
      /** Attribute-backed element id. */
      get id() {
        return this.getAttribute("id") ?? "";
      }
      set id(value) {
        this.setAttribute("id", value);
      }
      /** Attribute-backed class string. */
      get className() {
        return this.getAttribute("class") ?? "";
      }
      set className(value) {
        this.setAttribute("class", value);
      }
      /** Data attributes exposed as camel-cased properties. */
      get dataset() {
        const element = this;
        return new Proxy(
          {},
          {
            get(_target, property) {
              if (typeof property !== "string") return void 0;
              return element.getAttribute(`data-${property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`) ?? void 0;
            },
            set(_target, property, value) {
              if (typeof property === "string") {
                element.setAttribute(
                  `data-${property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
                  String(value)
                );
              }
              return true;
            },
            ownKeys() {
              return element.attributes.filter((attr) => attr.name.startsWith("data-")).map((attr) => attr.name.slice(5).replace(/-([a-z])/g, (_m, letter) => letter.toUpperCase()));
            },
            getOwnPropertyDescriptor() {
              return { configurable: true, enumerable: true };
            }
          }
        );
      }
      /** Linkedom-compatible legacy text property (only specialized elements define a value). */
      get text() {
        return void 0;
      }
      /** HTML contained inside this element. */
      get innerHTML() {
        return this.childNodes.map(serializeNode2).join("");
      }
      set innerHTML(value) {
        this.replaceChildren();
        for (const child of parseFragment(value, this.documentForCreation(), this.localName).childNodes.slice())
          this.appendChild(child);
      }
      /** Serialized element and descendants. */
      get outerHTML() {
        return serializeNode2(this);
      }
      set outerHTML(value) {
        const parent = this.parentNode;
        if (!parent) return;
        const fragment = parseFragment(value, this.documentForCreation(), this.parentElement?.localName);
        for (const child of Array.from(fragment.childNodes)) parent.insertBefore(child, this);
        parent.removeChild(this);
      }
      /** Read an attribute. */
      getAttribute(name) {
        if (name.toLowerCase() === "style" && this.style.cssText) return this.style.cssText;
        return this.attributes.getNamedItem(name)?.value ?? null;
      }
      /** Read an attribute object. */
      getAttributeNode(name) {
        return this.attributes.getNamedItem(name);
      }
      /** Whether an attribute exists. */
      hasAttribute(name) {
        return this.attributes.getNamedItem(name) !== null || name.toLowerCase() === "style" && Boolean(this.style.cssText);
      }
      /** Set an attribute. */
      setAttribute(name, value) {
        const normalized = name.toLowerCase();
        if (normalized === "style") this.style.cssText = String(value);
        const existing = this.attributes.getNamedItem(normalized);
        if (existing) existing.value = String(value);
        else this.attributes.unshift(new Attr(name, String(value), this.ownerDocument));
      }
      /** Set a namespaced attribute. */
      setAttributeNS(_namespace, name, value) {
        this.setAttribute(name, value);
      }
      /** Remove an attribute. */
      removeAttribute(name) {
        const existing = this.attributes.getNamedItem(name);
        if (existing) this.attributes.splice(this.attributes.indexOf(existing), 1);
        if (name.toLowerCase() === "style") this.style.cssText = "";
      }
      /** Find the first descendant matching a selector. */
      querySelector(selector) {
        return querySelectorAllFrom(this, selector, false)[0] ?? null;
      }
      /** Find all descendants matching a selector. */
      querySelectorAll(selector) {
        return querySelectorAllFrom(this, selector, false);
      }
      /** Whether this element matches a selector. */
      matches(selector) {
        return matchesSelector(this, selector);
      }
      /** Find the nearest matching ancestor including this element. */
      closest(selector) {
        for (let element = this; element; element = element.parentElement) {
          if (element.matches(selector)) return element;
        }
        return null;
      }
      /** Descendant elements with a tag name. */
      getElementsByTagName(tagName) {
        return this.querySelectorAll(tagName === "*" ? "*" : tagName);
      }
      /** Descendant elements containing all requested class tokens. */
      getElementsByClassName(classNames) {
        const tokens = classNames.trim().split(/\s+/).filter(Boolean);
        return querySelectorAllFrom(this, "*", false).filter(
          (element) => tokens.every((token) => element.classList.contains(token))
        );
      }
      /**
       * Return a zero-sized rectangle because this parser DOM has no layout.
       * Browser-side scripts only use this method's standard shape.
       */
      getBoundingClientRect() {
        return { x: 0, y: 0, bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 };
      }
      /** Focus this element in its owner document. */
      focus() {
        if (this.ownerDocument) this.ownerDocument.activeElement = this;
        this.dispatchEvent(new Event("focus"));
      }
      /** Clear focus from this element. */
      blur() {
        if (this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
        this.dispatchEvent(new Event("blur"));
      }
      /** Trigger a synthetic click event. */
      click() {
        this.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
      }
      cloneNode(deep = false) {
        const clone = this.ownerDocument?.createElementNS(this.namespaceURI, this.qualifiedName) ?? new _Element(this.qualifiedName, null, this.namespaceURI);
        for (let index = this.attributes.length - 1; index >= 0; index--) {
          const attr = this.attributes[index];
          clone.setAttribute(attr.name, attr.value);
        }
        if (deep) for (const child of this.childNodes) clone.appendChild(child.cloneNode(true));
        return clone;
      }
    };
    HTMLElement = class extends Element {
      value = "";
      checked = false;
      selected = false;
      disabled = false;
      multiple = false;
      defaultValue = "";
      defaultChecked = false;
      /** Reflected title attribute. */
      get title() {
        return this.getAttribute("title") ?? "";
      }
      set title(value) {
        this.setAttribute("title", value);
      }
      /** Reflected href attribute. */
      get href() {
        const value = this.getAttribute("href") ?? "";
        try {
          return new URL(value, this.ownerDocument?.URL || "about:blank").href;
        } catch {
          return value;
        }
      }
      set href(value) {
        this.setAttribute("href", value);
      }
      /** Reflected input type. */
      get type() {
        return this.getAttribute("type") ?? "";
      }
      set type(value) {
        this.setAttribute("type", value);
      }
      /** Reflected name. */
      get name() {
        return this.getAttribute("name") ?? "";
      }
      set name(value) {
        this.setAttribute("name", value);
      }
    };
    HTMLMetaElement = class extends HTMLElement {
      /** Reflected metadata content. */
      get content() {
        return this.getAttribute("content") ?? "";
      }
      set content(value) {
        this.setAttribute("content", value);
      }
    };
    SVGElement = class extends Element {
    };
    HTMLIFrameElement2 = class extends HTMLElement {
    };
    DocumentFragment = class _DocumentFragment extends Node {
      constructor(ownerDocument = null) {
        super(11 /* DOCUMENT_FRAGMENT */, "#document-fragment", ownerDocument);
      }
      /** Element children. */
      get children() {
        return this.childNodes.filter((child) => child instanceof Element);
      }
      /** First element child. */
      get firstElementChild() {
        return this.children[0] ?? null;
      }
      /** Last element child. */
      get lastElementChild() {
        const children = this.children;
        return children[children.length - 1] ?? null;
      }
      /** First matching descendant. */
      querySelector(selector) {
        return querySelectorAllFrom(this, selector, false)[0] ?? null;
      }
      /** All matching descendants. */
      querySelectorAll(selector) {
        return querySelectorAllFrom(this, selector, false);
      }
      cloneNode(deep = false) {
        const clone = new _DocumentFragment(this.ownerDocument);
        if (deep) for (const child of this.childNodes) clone.appendChild(child.cloneNode(true));
        return clone;
      }
    };
    HTMLTemplateElement = class _HTMLTemplateElement extends HTMLElement {
      content;
      constructor(tagName, ownerDocument = null, namespaceURI = HTML_NAMESPACE) {
        super(tagName, ownerDocument, namespaceURI);
        this.content = new DocumentFragment(ownerDocument);
      }
      get innerHTML() {
        return this.content.childNodes.map(serializeNode2).join("");
      }
      set innerHTML(value) {
        this.content.replaceChildren();
        for (const child of parseFragment(value, this.documentForCreation(), "template").childNodes.slice()) {
          this.content.appendChild(child);
        }
      }
      get textContent() {
        return this.content.textContent ?? "";
      }
      set textContent(value) {
        this.content.textContent = value;
      }
      appendChild(child) {
        return this.content.appendChild(child);
      }
      insertBefore(child, reference) {
        return this.content.insertBefore(child, reference);
      }
      replaceChild(child, previous) {
        return this.content.replaceChild(child, previous);
      }
      removeChild(child) {
        return this.content.removeChild(child);
      }
      cloneNode(deep = false) {
        const clone = new _HTMLTemplateElement(this.qualifiedName, this.ownerDocument, this.namespaceURI);
        for (let index = this.attributes.length - 1; index >= 0; index--) {
          const attr = this.attributes[index];
          clone.setAttribute(attr.name, attr.value);
        }
        if (deep) for (const child of this.content.childNodes) clone.content.appendChild(child.cloneNode(true));
        return clone;
      }
    };
    Document = class _Document extends Node {
      defaultView = null;
      URL = "about:blank";
      activeElement = null;
      constructor() {
        super(9 /* DOCUMENT */, "#document", null);
        this.ownerDocument = null;
      }
      /** Root element of the document. */
      get documentElement() {
        return this.children[0] ?? null;
      }
      /** Element children. */
      get children() {
        return this.childNodes.filter((child) => child instanceof Element);
      }
      /** HTML body, or a detached empty body when absent like linkedom. */
      get body() {
        const body = this.querySelector("body");
        return body instanceof HTMLElement ? body : this.createElement("body");
      }
      /** HTML head, or a detached empty head when absent. */
      get head() {
        const head = this.querySelector("head");
        return head instanceof HTMLElement ? head : this.createElement("head");
      }
      /** Document title text. */
      get title() {
        return this.querySelector("title")?.textContent ?? "";
      }
      set title(value) {
        let title = this.querySelector("title");
        if (!title) {
          title = this.createElement("title");
          this.head.appendChild(title);
        }
        title.textContent = value;
      }
      get textContent() {
        return null;
      }
      set textContent(_value) {
      }
      /** Create an HTML element. */
      createElement(tagName, _options) {
        switch (tagName.toLowerCase()) {
          case "iframe":
            return new HTMLIFrameElement2(tagName, this, HTML_NAMESPACE);
          case "meta":
            return new HTMLMetaElement(tagName, this, HTML_NAMESPACE);
          case "template":
            return new HTMLTemplateElement(tagName, this, HTML_NAMESPACE);
          default:
            return new HTMLElement(tagName, this, HTML_NAMESPACE);
        }
      }
      /** Create a namespaced element. */
      createElementNS(namespace, tagName) {
        if (namespace === SVG_NAMESPACE) return new SVGElement(tagName, this, namespace);
        if (namespace === null || namespace === HTML_NAMESPACE) return this.createElement(tagName);
        return new HTMLElement(tagName, this, namespace);
      }
      /** Create a text node. */
      createTextNode(data) {
        return new Text(data, this);
      }
      /** Create a comment. */
      createComment(data) {
        return new Comment(data, this);
      }
      /** Create an attribute. */
      createAttribute(name) {
        return new Attr(name.toLowerCase(), "", this);
      }
      /** Create a document fragment. */
      createDocumentFragment() {
        return new DocumentFragment(this);
      }
      /** Find the first element by id. */
      getElementById(id) {
        const element = this.querySelector(`#${cssEscapeIdentifier(id)}`);
        return element instanceof HTMLElement ? element : null;
      }
      /** Find the first matching descendant. */
      querySelector(selector) {
        return querySelectorAllFrom(this, selector, true)[0] ?? null;
      }
      /** Find all matching descendants. */
      querySelectorAll(selector) {
        return querySelectorAllFrom(this, selector, true);
      }
      /** Descendant elements with a tag name. */
      getElementsByTagName(tagName) {
        return this.querySelectorAll(tagName === "*" ? "*" : tagName);
      }
      /** Descendant elements containing all class tokens. */
      getElementsByClassName(classNames) {
        const tokens = classNames.trim().split(/\s+/).filter(Boolean);
        return this.querySelectorAll("*").filter((element) => tokens.every((token) => element.classList.contains(token)));
      }
      /** Adopt a node into this document. */
      adoptNode(node) {
        node.parentNode?.removeChild(node);
        node.setOwnerDocument(this);
        return node;
      }
      /** Import a cloned node into this document. */
      importNode(node, deep = false) {
        const clone = node.cloneNode(deep);
        clone.setOwnerDocument(this);
        return clone;
      }
      /** Legacy event factory used by libraries. */
      createEvent(_kind) {
        return new Event("");
      }
      cloneNode(deep = false) {
        const clone = new _Document();
        if (deep) for (const child of this.childNodes) clone.appendChild(child.cloneNode(true));
        return clone;
      }
    };
    DOMWindow = class extends EventTarget {
      document;
      Node = Node;
      Element = Element;
      HTMLElement = HTMLElement;
      HTMLIFrameElement = HTMLIFrameElement2;
      SVGElement = SVGElement;
      Text = Text;
      Comment = Comment;
      Document = Document;
      DocumentFragment = DocumentFragment;
      Event = Event;
      CustomEvent = CustomEvent;
      navigator = { userAgent: "pi-utils-dom", platform: "" };
      location = { href: "about:blank" };
      window;
      self;
      top;
      parent;
      constructor(document2) {
        super();
        this.document = document2;
        this.window = this;
        this.self = this;
        this.top = this;
        this.parent = this;
        document2.defaultView = this;
      }
      /** Browser-compatible computed style placeholder. */
      getComputedStyle(element) {
        return element.style;
      }
      /** Schedule an animation callback. */
      requestAnimationFrame(callback) {
        return globalThis.setTimeout(() => callback(Date.now()), 16);
      }
      /** Cancel an animation callback. */
      cancelAnimationFrame(handle) {
        globalThis.clearTimeout(handle);
      }
      /** Empty selection object. */
      getSelection() {
        return { rangeCount: 0, removeAllRanges() {
        } };
      }
    };
    VOID_ELEMENTS3 = {
      area: true,
      base: true,
      br: true,
      col: true,
      embed: true,
      hr: true,
      img: true,
      input: true,
      link: true,
      meta: true,
      param: true,
      source: true,
      track: true,
      wbr: true
    };
    BOOLEAN_ATTRIBUTES = {
      allowfullscreen: true,
      async: true,
      autofocus: true,
      autoplay: true,
      checked: true,
      controls: true,
      default: true,
      defer: true,
      disabled: true,
      formnovalidate: true,
      hidden: true,
      inert: true,
      ismap: true,
      itemscope: true,
      loop: true,
      multiple: true,
      muted: true,
      nomodule: true,
      novalidate: true,
      open: true,
      playsinline: true,
      readonly: true,
      required: true,
      reversed: true,
      selected: true
    };
  }
});

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/dom/index.ts
var dom_exports = {};
__export(dom_exports, {
  Attr: () => Attr,
  CSSStyleDeclaration: () => CSSStyleDeclaration,
  Comment: () => Comment,
  CustomEvent: () => CustomEvent,
  DOMTokenList: () => DOMTokenList,
  DOMWindow: () => DOMWindow,
  Document: () => Document,
  DocumentFragment: () => DocumentFragment,
  Element: () => Element,
  Event: () => Event,
  EventTarget: () => EventTarget,
  HTMLElement: () => HTMLElement,
  HTMLIFrameElement: () => HTMLIFrameElement2,
  HTMLMetaElement: () => HTMLMetaElement,
  HTMLTemplateElement: () => HTMLTemplateElement,
  NamedNodeMap: () => NamedNodeMap,
  Node: () => Node,
  NodeType: () => NodeType,
  SVGElement: () => SVGElement,
  Text: () => Text,
  parseHTML: () => parseHTML,
  serializeNode: () => serializeNode2
});
function parseHTML(html) {
  return new DOMWindow(parseDocument(html));
}
var init_dom = __esm({
  "../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/dom/index.ts"() {
    "use strict";
    init_core();
    init_parser();
    init_core();
  }
});

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/readability/readability.ts
var readability_exports = {};
__export(readability_exports, {
  Readability: () => Readability
});
function elements(collection) {
  return Array.from(collection);
}
function descendants(root) {
  const result = [];
  const pending = elements(root.children).reverse();
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    result.push(node);
    const children = elements(node.children);
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
  }
  return result;
}
function text(node) {
  return (node.textContent ?? "").trim().replace(NORMALIZE, " ");
}
function matchLabel(node) {
  return `${typeof node.className === "string" ? node.className : ""} ${node.id ?? ""}`;
}
function classWeight(node) {
  const label = matchLabel(node);
  return (POSITIVE.test(label) ? 25 : 0) - (NEGATIVE.test(label) ? 25 : 0);
}
function initialScore(node) {
  let score = classWeight(node);
  switch (node.tagName) {
    case "DIV":
      score += 5;
      break;
    case "PRE":
    case "TD":
    case "BLOCKQUOTE":
      score += 3;
      break;
    case "ADDRESS":
    case "OL":
    case "UL":
    case "DL":
    case "DD":
    case "DT":
    case "LI":
    case "FORM":
      score -= 3;
      break;
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
    case "TH":
      score -= 5;
      break;
  }
  return score;
}
function linkDensity(node) {
  const total2 = text(node).length;
  if (!total2) return 0;
  let linked = 0;
  for (const link of elements(node.getElementsByTagName("a"))) {
    linked += text(link).length * ((link.getAttribute("href") ?? "").startsWith("#") ? 0.3 : 1);
  }
  return linked / total2;
}
function visible(node) {
  const style = node.getAttribute("style")?.toLowerCase() ?? "";
  return !node.hasAttribute("hidden") && node.getAttribute("aria-hidden") !== "true" && !/display\s*:\s*none|visibility\s*:\s*hidden/.test(style);
}
function removeAll(root, tags) {
  const container = root;
  for (const tag of tags) {
    for (const node of elements(container.getElementsByTagName(tag))) node.remove();
  }
}
function entityDecode(value) {
  if (!value) return value;
  const named = { quot: '"', amp: "&", apos: "'", lt: "<", gt: ">" };
  return value.replace(/&(quot|amp|apos|lt|gt);/g, (_, name) => named[name] ?? "").replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, decimal) => {
    const value2 = Number.parseInt(hex ?? decimal ?? "0", hex ? 16 : 10);
    return String.fromCodePoint(
      value2 === 0 || value2 > 1114111 || value2 >= 55296 && value2 <= 57343 ? 65533 : value2
    );
  });
}
function titleFromDocument(document2) {
  const titleElement = elements(document2.getElementsByTagName("title"))[0];
  const original = typeof document2.title === "string" ? document2.title.trim() : titleElement ? text(titleElement) : "";
  let title = original;
  const separators = [...original.matchAll(/ [|\\/>»-] /g)];
  if (separators.length) {
    title = original.slice(0, separators.at(-1)?.index);
    if (title.trim().split(/\s+/).length < 3) title = original.replace(/^[^|\\/>»-]*[|\\/>»-]/, "");
  } else if (title.includes(": ")) {
    const matchingHeading = elements(document2.querySelectorAll("h1, h2")).some((node) => text(node) === title);
    if (!matchingHeading) {
      const suffix = original.slice(original.lastIndexOf(":") + 1);
      title = suffix.trim().split(/\s+/).length < 3 ? original.slice(original.indexOf(":") + 1) : suffix;
    }
  } else if (title.length > 150 || title.length < 15) {
    const headings = elements(document2.getElementsByTagName("h1"));
    if (headings.length === 1) title = text(headings[0]);
  }
  title = title.trim().replace(NORMALIZE, " ");
  if (title.split(/\s+/).length <= 4) return original;
  return title;
}
function jsonLdMetadata(document2) {
  for (const script of elements(document2.getElementsByTagName("script"))) {
    if (script.getAttribute("type") !== "application/ld+json") continue;
    try {
      const decoded = JSON.parse((script.textContent ?? "").replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, ""));
      const records = Array.isArray(decoded) ? decoded : [decoded];
      for (const candidate of records) {
        if (!candidate || typeof candidate !== "object") continue;
        const record = candidate;
        if (typeof record["@type"] !== "string" || !ARTICLE_TYPES.test(record["@type"])) continue;
        const author = record.author;
        let byline;
        if (author && typeof author === "object" && !Array.isArray(author)) {
          const name = author.name;
          if (typeof name === "string") byline = name.trim();
        } else if (Array.isArray(author)) {
          const names = author.flatMap((item) => {
            if (!item || typeof item !== "object") return [];
            const name = item.name;
            return typeof name === "string" ? [name.trim()] : [];
          });
          if (names.length) byline = names.join(", ");
        }
        const publisher = record.publisher;
        const publisherName = publisher && typeof publisher === "object" ? publisher.name : void 0;
        return {
          title: typeof record.name === "string" ? record.name.trim() : typeof record.headline === "string" ? record.headline.trim() : void 0,
          byline,
          excerpt: typeof record.description === "string" ? record.description.trim() : void 0,
          siteName: typeof publisherName === "string" ? publisherName.trim() : void 0,
          publishedTime: typeof record.datePublished === "string" ? record.datePublished.trim() : void 0
        };
      }
    } catch {
    }
  }
  return {};
}
function metadataFromDocument(document2, jsonLd) {
  const values = /* @__PURE__ */ new Map();
  for (const meta of elements(document2.getElementsByTagName("meta"))) {
    const content = meta.getAttribute("content")?.trim();
    if (!content) continue;
    const property = meta.getAttribute("property")?.toLowerCase().replace(/\s/g, "");
    const name = meta.getAttribute("name")?.toLowerCase().replace(/\s/g, "").replace(/\./g, ":");
    if (property && /^(?:article|dc|dcterm|og|twitter):(?:author|creator|description|published_time|title|site_name)$/.test(
      property
    ))
      values.set(property, content);
    else if (name && /^(?:(?:dc|dcterm|og|twitter|parsely|weibo:(?:article|webpage))[-:]?)?(?:author|creator|pub-date|description|title|site_name)$/.test(
      name
    ))
      values.set(name, content);
  }
  const articleAuthor = values.get("article:author");
  const result = {
    title: jsonLd.title ?? values.get("dc:title") ?? values.get("dcterm:title") ?? values.get("og:title") ?? values.get("title") ?? values.get("twitter:title") ?? titleFromDocument(document2),
    byline: jsonLd.byline ?? values.get("dc:creator") ?? values.get("dcterm:creator") ?? values.get("author") ?? values.get("parsely-author") ?? (articleAuthor && !/^https?:\/\//.test(articleAuthor) ? articleAuthor : void 0),
    excerpt: jsonLd.excerpt ?? values.get("dc:description") ?? values.get("dcterm:description") ?? values.get("og:description") ?? values.get("description") ?? values.get("twitter:description"),
    siteName: jsonLd.siteName ?? values.get("og:site_name"),
    publishedTime: jsonLd.publishedTime ?? values.get("article:published_time") ?? values.get("parsely-pub-date") ?? null
  };
  return {
    title: entityDecode(result.title) ?? void 0,
    byline: entityDecode(result.byline) ?? void 0,
    excerpt: entityDecode(result.excerpt) ?? void 0,
    siteName: entityDecode(result.siteName) ?? void 0,
    publishedTime: entityDecode(result.publishedTime)
  };
}
var UNLIKELY, POSSIBLE, POSITIVE, NEGATIVE, BYLINE, SCORE_TAGS, DROP_TAGS, UNLIKELY_ROLES, ARTICLE_TYPES, NORMALIZE, Readability;
var init_readability = __esm({
  "../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/readability/readability.ts"() {
    "use strict";
    UNLIKELY = /-ad-|ai2html|banner|breadcrumbs|comment|community|combx|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup/i;
    POSSIBLE = /and|article|body|column|content|main|shadow/i;
    POSITIVE = /article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story/i;
    NEGATIVE = /-ad-|hidden|^hid$| hid$| hid |^hid |banner|comment|com-|contact|footer|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|widget/i;
    BYLINE = /byline|author|dateline|writtenby|p-author/i;
    SCORE_TAGS = /* @__PURE__ */ new Set(["SECTION", "H2", "H3", "H4", "H5", "H6", "P", "TD", "PRE"]);
    DROP_TAGS = [
      "form",
      "fieldset",
      "object",
      "embed",
      "footer",
      "link",
      "aside",
      "iframe",
      "input",
      "textarea",
      "select",
      "button"
    ];
    UNLIKELY_ROLES = /* @__PURE__ */ new Set(["menu", "menubar", "complementary", "navigation", "alert", "alertdialog", "dialog"]);
    ARTICLE_TYPES = /^(?:Article|AdvertiserContentArticle|NewsArticle|AnalysisNewsArticle|OpinionNewsArticle|ReportageNewsArticle|ReviewNewsArticle|Report|ScholarlyArticle|MedicalScholarlyArticle|SocialMediaPosting|BlogPosting|LiveBlogPosting|DiscussionForumPosting|TechArticle|APIReference)$/;
    NORMALIZE = /\s{2,}/g;
    Readability = class {
      #document;
      #options;
      #scores = /* @__PURE__ */ new Map();
      #byline;
      #lang = null;
      constructor(document2, options = {}) {
        this.#document = document2;
        this.#options = options;
      }
      /** Runs extraction once; the supplied document is consumed and should not be reused. */
      parse() {
        const documentElement = this.#document.documentElement;
        if (!documentElement) return null;
        const max = this.#options.maxElemsToParse ?? 0;
        if (max > 0) {
          const count = descendants(documentElement).length + 1;
          if (count > max) throw new Error(`Aborting parsing document; ${count} elements found`);
        }
        const jsonLd = this.#options.disableJSONLD ? {} : jsonLdMetadata(this.#document);
        const metadata = metadataFromDocument(this.#document, jsonLd);
        removeAll(this.#document, ["script", "style"]);
        const body = this.#document.body;
        if (!body) return null;
        const source = body.innerHTML;
        const attempts = [];
        for (const mode of [0, 1, 2, 3]) {
          if (mode) body.innerHTML = source;
          this.#scores.clear();
          this.#byline = void 0;
          const attempt = this.#extract(body, documentElement, metadata.title ?? "", mode);
          if (attempt) attempts.push(attempt);
          if (attempt && attempt.length >= (this.#options.charThreshold || 500)) break;
        }
        attempts.sort((left, right) => right.length - left.length);
        const best = attempts[0];
        if (!best?.length) return null;
        if (!metadata.excerpt) {
          const firstParagraph = elements(best.element.getElementsByTagName("p"))[0];
          if (firstParagraph) metadata.excerpt = (firstParagraph.textContent ?? "").trim();
        }
        const contentText = best.element.textContent ?? "";
        const serializer = this.#options.serializer ?? ((node) => node.innerHTML);
        return {
          title: metadata.title,
          byline: metadata.byline ?? this.#byline,
          dir: best.dir,
          lang: this.#lang,
          content: serializer(best.element),
          textContent: contentText,
          length: contentText.length,
          excerpt: metadata.excerpt,
          siteName: metadata.siteName,
          publishedTime: metadata.publishedTime
        };
      }
      #extract(body, documentElement, articleTitle, mode) {
        this.#lang = documentElement.getAttribute("lang");
        const stripUnlikely = mode === 0;
        const weightClasses = mode < 2;
        const all = [documentElement, ...descendants(documentElement)];
        const scored = [];
        let titleRemoved = false;
        for (const node of all) {
          if (node === documentElement || node.tagName === "BODY") continue;
          const label = matchLabel(node);
          if (!visible(node) || node.getAttribute("aria-modal") === "true" && node.getAttribute("role") === "dialog") {
            node.remove();
            continue;
          }
          if (!this.#byline && this.#isByline(node, label)) {
            this.#byline = text(node);
            node.remove();
            continue;
          }
          if (!titleRemoved && /^(?:H1|H2)$/.test(node.tagName) && this.#similar(articleTitle, text(node)) > 0.75) {
            titleRemoved = true;
            node.remove();
            continue;
          }
          if (stripUnlikely && UNLIKELY.test(label) && !POSSIBLE.test(label) || UNLIKELY_ROLES.has(node.getAttribute("role") ?? "")) {
            node.remove();
            continue;
          }
          if (SCORE_TAGS.has(node.tagName)) scored.push(node);
        }
        for (const paragraph of scored) this.#scoreParagraph(paragraph, weightClasses);
        let top;
        let topScore = Number.NEGATIVE_INFINITY;
        for (const [candidate, raw] of this.#scores) {
          if (candidate.tagName === "BODY" || candidate.tagName === "HTML") continue;
          const score = raw * (1 - linkDensity(candidate));
          this.#scores.set(candidate, score);
          if (score > topScore) {
            top = candidate;
            topScore = score;
          }
        }
        if (!top || top.tagName === "BODY") top = body;
        while (top.parentNode && top.parentNode.tagName !== "BODY" && top.parentNode.children.length === 1)
          top = top.parentNode;
        const parent = top.parentNode;
        const article = this.#document.createElement("DIV");
        const siblings = parent ? elements(parent.children) : [top];
        const threshold = Math.max(10, (this.#scores.get(top) ?? topScore) * 0.2);
        for (const sibling of siblings) {
          const siblingText = text(sibling);
          const sameClassBonus = sibling.className && sibling.className === top.className ? (this.#scores.get(top) ?? 0) * 0.2 : 0;
          const include = sibling === top || (this.#scores.get(sibling) ?? 0) + sameClassBonus >= threshold || sibling.tagName === "P" && (siblingText.length > 80 && linkDensity(sibling) < 0.25 || siblingText.length > 0 && siblingText.length < 80 && linkDensity(sibling) === 0 && /\.(?: |$)/.test(siblingText));
          if (!include) continue;
          if (["DIV", "ARTICLE", "SECTION", "P", "OL", "UL"].includes(sibling.tagName)) {
            article.appendChild(sibling);
            continue;
          }
          const replacement = this.#document.createElement("DIV");
          for (const attribute of Array.from(sibling.attributes))
            replacement.setAttribute(attribute.name, attribute.value);
          while (sibling.firstChild) replacement.appendChild(sibling.firstChild);
          article.appendChild(replacement);
        }
        this.#clean(article, mode < 3);
        const page = this.#document.createElement("DIV");
        page.id = "readability-page-1";
        page.className = "page";
        while (article.firstChild) page.appendChild(article.firstChild);
        article.appendChild(page);
        const content = text(article);
        let dir;
        let ancestor = top;
        while (ancestor) {
          if (ancestor.getAttribute) {
            dir = ancestor.getAttribute("dir");
            if (dir) break;
          }
          ancestor = ancestor.parentNode;
        }
        return { element: article, length: content.length, dir };
      }
      #scoreParagraph(node, weightClasses) {
        const content = text(node);
        if (content.length < 25) return;
        const score = 1 + content.split(/[\u002c\u060c\ufe50\ufe10\ufe11\u2e41\u2e34\u2e32\uff0c]/).length + Math.min(Math.floor(content.length / 100), 3);
        let ancestor = node.parentNode;
        for (let level = 0; ancestor && level < 5; level++, ancestor = ancestor.parentNode) {
          const element = ancestor;
          if (!element.tagName || !element.parentNode || !element.parentNode.tagName) continue;
          const baseline = this.#scores.get(element) ?? initialScore(element) - (weightClasses ? 0 : classWeight(element));
          const divisor = level === 0 ? 1 : level === 1 ? 2 : level * 3;
          this.#scores.set(element, baseline + score / divisor);
        }
      }
      #clean(root, conditional) {
        removeAll(root, DROP_TAGS);
        for (const heading of elements(root.querySelectorAll("h1, h2, h3, h4, h5, h6"))) {
          if (classWeight(heading) < 0 || linkDensity(heading) > 0.33) heading.remove();
        }
        if (conditional) {
          for (const node of elements(root.querySelectorAll("table, ul, div"))) {
            if (node === root) continue;
            const nodeText = text(node);
            const paragraphs = node.getElementsByTagName("p").length;
            const images = node.getElementsByTagName("img").length;
            const inputs = node.getElementsByTagName("input").length;
            if (classWeight(node) < 0 || !nodeText && !images || nodeText.split(",").length < 10 && (images > paragraphs && paragraphs > 0 || inputs > Math.floor(paragraphs / 3) || linkDensity(node) > 0.5))
              node.remove();
          }
        }
        for (const paragraph of elements(root.getElementsByTagName("p"))) {
          if (!text(paragraph) && !paragraph.querySelector("img, embed, object, iframe")) paragraph.remove();
        }
        for (const node of [root, ...descendants(root)]) {
          if (!this.#options.keepClasses) {
            const preserved = (this.#options.classesToPreserve ?? []).filter(
              (name) => node.className.split(/\s+/).includes(name)
            );
            if (node.id === "readability-page-1") preserved.unshift("page");
            if (preserved.length) node.className = [...new Set(preserved)].join(" ");
            else node.removeAttribute("class");
          }
          for (const attr of [
            "style",
            "align",
            "background",
            "bgcolor",
            "border",
            "cellpadding",
            "cellspacing",
            "frame",
            "hspace",
            "rules",
            "valign",
            "vspace"
          ])
            node.removeAttribute(attr);
        }
      }
      #isByline(node, label) {
        const value = text(node);
        return value.length > 0 && value.length < 100 && (node.getAttribute("rel") === "author" || (node.getAttribute("itemprop") ?? "").includes("author") || BYLINE.test(label));
      }
      #similar(left, right) {
        const leftTokens = left.toLowerCase().split(/\W+/).filter(Boolean);
        const rightTokens = right.toLowerCase().split(/\W+/).filter(Boolean);
        if (!leftTokens.length || !rightTokens.length) return 0;
        const unmatched = rightTokens.filter((token) => !leftTokens.includes(token));
        return 1 - unmatched.join(" ").length / rightTokens.join(" ").length;
      }
    };
  }
});

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/cell/evaluator.ts
import { AsyncLocalStorage } from "node:async_hooks";

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/cell/display.ts
import { Console } from "node:console";
import { Writable } from "node:stream";
import * as util from "node:util";

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/bytes.ts
function headWindow(text2, max) {
  const bytes = Buffer.byteLength(text2, "utf8");
  if (bytes <= max) return { text: text2, bytes };
  if (max <= 0) return { text: "", bytes: 0 };
  const encoded = Buffer.from(text2.length > max ? text2.slice(0, max) : text2, "utf8");
  let end = Math.min(max, encoded.length);
  while (end > 0 && end < encoded.length && (encoded[end] & 192) === 128) end -= 1;
  return { text: encoded.subarray(0, end).toString("utf8"), bytes: end };
}
function tailWindow(text2, max) {
  const bytes = Buffer.byteLength(text2, "utf8");
  if (bytes <= max) return { text: text2, bytes };
  if (max <= 0) return { text: "", bytes: 0 };
  const encoded = Buffer.from(text2.length > max ? text2.slice(text2.length - max) : text2, "utf8");
  let start = Math.max(0, encoded.length - max);
  while (start < encoded.length && (encoded[start] & 192) === 128) start += 1;
  return { text: encoded.subarray(start).toString("utf8"), bytes: encoded.length - start };
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/spill.ts
import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, rmdirSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
var SPILL_FILES_KEPT = 20;
var SPILL_FILE_MAX_BYTES = 16 * 1024 * 1024;
var SPILL_SESSION_MAX_BYTES = 128 * 1024 * 1024;
var SPILL_ROOT_MAX_BYTES = 1024 * 1024 * 1024;
var SPILL_SESSION_TTL_MS = 24 * 60 * 60 * 1e3;
var SPILL_BOUNDS = {
  filesPerSession: SPILL_FILES_KEPT,
  sessionBytes: SPILL_SESSION_MAX_BYTES,
  rootBytes: SPILL_ROOT_MAX_BYTES,
  sessionTtlMs: SPILL_SESSION_TTL_MS
};
var SPILL_NAME = /^browser-run-\d{13}-\d{6}-[0-9a-f]{8}\.txt$/;
var SESSION_FOLDER = /^[0-9a-f]{16}$/;
var sequence = 0;
function spillNames(dir) {
  try {
    return readdirSync(dir).filter((name) => SPILL_NAME.test(name)).sort();
  } catch {
    return [];
  }
}
function heldIn(folder) {
  return spillNames(folder).flatMap((name) => {
    const path5 = join(folder, name);
    try {
      const stat = statSync(path5);
      return [{ folder, path: path5, name, bytes: stat.size, mtimeMs: stat.mtimeMs }];
    } catch {
      return [];
    }
  });
}
function forget(file) {
  try {
    rmSync(file.path, { force: true });
    return true;
  } catch {
    return false;
  }
}
function trimOldest(files, keep, fits) {
  files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  while (!fits(files)) {
    const index = files.findIndex((file) => file.path !== keep);
    if (index < 0) return;
    forget(files[index]);
    files.splice(index, 1);
  }
}
var total = (files) => files.reduce((sum, file) => sum + file.bytes, 0);
function enforceBounds(root, keep, reserve, now, bounds) {
  let names;
  try {
    names = readdirSync(root).filter((name) => SESSION_FOLDER.test(name));
  } catch {
    return;
  }
  const keepFolder = keep === void 0 ? void 0 : join(keep, "..");
  const sessions = names.map((name) => {
    const folder = join(root, name);
    const files = heldIn(folder);
    return { folder, files, held: files.length };
  });
  for (const session of sessions) {
    if (session.folder === keepFolder || session.files.length === 0) continue;
    if (now - Math.max(...session.files.map((file) => file.mtimeMs)) > bounds.sessionTtlMs) {
      for (const file of session.files) forget(file);
      session.files = [];
    }
  }
  const own = sessions.find((session) => session.folder === keepFolder);
  if (own) trimOldest(own.files, keep, (files) => files.length <= bounds.filesPerSession && total(files) + reserve <= bounds.sessionBytes);
  const all = sessions.flatMap((session) => session.files);
  trimOldest(all, keep, (files) => total(files) + reserve <= bounds.rootBytes);
  const alive = new Set(all.map((file) => file.path));
  for (const session of sessions) {
    if (session.folder === keepFolder || session.held === 0 || session.files.some((file) => alive.has(file.path))) continue;
    try {
      rmdirSync(session.folder);
    } catch {
    }
  }
}
function newSpillName(now) {
  sequence = (sequence + 1) % 1e6;
  return `browser-run-${String(now).padStart(13, "0")}-${String(sequence).padStart(6, "0")}-${randomBytes(4).toString("hex")}.txt`;
}
var SpillFile = class _SpillFile {
  path;
  #maxBytes;
  #fd;
  #kept = 0;
  #notKept = 0;
  constructor(path5, fd, maxBytes) {
    this.path = path5;
    this.#fd = fd;
    this.#maxBytes = maxBytes;
  }
  /** Creates a file in the session folder `dir` (made if needed, private to the user) and holds the folders to their bounds: this one's files and bytes (`maxBytes` counted whole), the root's bytes, the age limit. Undefined on any file-system error. */
  static open(dir, maxBytes = SPILL_FILE_MAX_BYTES, bounds = SPILL_BOUNDS) {
    try {
      mkdirSync(dir, { recursive: true, mode: 448 });
      const now = Date.now();
      const path5 = join(dir, newSpillName(now));
      const fd = openSync(path5, "wx", 384);
      const file = new _SpillFile(path5, fd, maxBytes);
      enforceBounds(join(dir, ".."), path5, maxBytes, now, bounds);
      return file;
    } catch {
      return void 0;
    }
  }
  /** Appends `text`, up to the cap; the rest is counted. A failed write (a full disk) ends the file where it is and counts everything after it. */
  write(text2) {
    if (text2.length === 0) return;
    const fd = this.#fd;
    if (fd === void 0) {
      this.#notKept += Buffer.byteLength(text2, "utf8");
      return;
    }
    const room = this.#maxBytes - this.#kept;
    const fits = headWindow(text2, room);
    try {
      if (fits.bytes > 0) writeSync(fd, fits.text);
      this.#kept += fits.bytes;
      this.#notKept += Buffer.byteLength(text2, "utf8") - fits.bytes;
      if (this.#kept >= this.#maxBytes || fits.bytes < Buffer.byteLength(text2, "utf8")) this.close();
    } catch {
      this.#notKept += Buffer.byteLength(text2, "utf8");
      this.close();
    }
  }
  /** Bytes in the file. */
  get keptBytes() {
    return this.#kept;
  }
  /** Bytes printed after the file stopped. */
  get notKeptBytes() {
    return this.#notKept;
  }
  close() {
    const fd = this.#fd;
    if (fd === void 0) return;
    this.#fd = void 0;
    try {
      closeSync(fd);
    } catch {
    }
  }
};

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/cell/output-sink.ts
var MAX_INLINE_BYTES = 50 * 1024;
var ERROR_LINE_BYTES = 4 * 1024;
var ELISION_MARKER_BYTES = 48;
var FOOTER_BYTES = 1024;
var HEAD_SHARE = 0.6;
var TAIL_SHARE = 0.25;
var PROGRESS_CHUNK_BYTES = 16 * 1024;
var PROGRESS_INTERVAL_MS = 100;
var NEWLINE = "\n";
function elideMiddle(head, tail, totalBytes) {
  const headCut = head.lastIndexOf(NEWLINE);
  const kept = headCut > 0 ? head.slice(0, headCut) : head;
  const tailCut = tail.indexOf(NEWLINE);
  const rest = tailCut < 0 || tailCut === tail.length - 1 ? tail : tail.slice(tailCut + 1);
  const elided = Math.max(0, totalBytes - Buffer.byteLength(kept, "utf8") - Buffer.byteLength(rest, "utf8"));
  return `${kept}
[\u2026${elided}B elided\u2026]
${rest}`;
}
var OutputSink = class {
  #max;
  #headLimit;
  /** The tail window keeps what the head did not, up to the rest of the budget, so a stream within the budget is complete; the summary shows the last 25% of it. */
  #tailLimit;
  #spillDir;
  #onChunk;
  #now;
  #head = "";
  #headBytes = 0;
  #headClosed = false;
  #tail = "";
  #tailBytes = 0;
  #total = 0;
  #spill;
  #spillTried = false;
  #closed = false;
  #pending = "";
  #pendingBytes = 0;
  #lastChunkAt = Number.NEGATIVE_INFINITY;
  #timer;
  constructor(options = {}) {
    this.#max = options.maxBytes ?? MAX_INLINE_BYTES;
    this.#headLimit = Math.floor(this.#max * HEAD_SHARE);
    this.#tailLimit = this.#max - this.#headLimit;
    this.#spillDir = options.spillDir;
    this.#onChunk = options.onChunk;
    this.#now = options.now ?? Date.now;
  }
  push(chunk2) {
    if (this.#closed || chunk2.length === 0) return;
    const bytes = Buffer.byteLength(chunk2, "utf8");
    this.#progress(chunk2, bytes);
    if (this.#spill === void 0 && !this.#spillTried && this.#spillDir !== void 0 && this.#total + bytes > this.#max) this.#openSpill(this.#spillDir);
    this.#spill?.write(chunk2);
    this.#total += bytes;
    this.#retain(chunk2, bytes);
  }
  #openSpill(dir) {
    this.#spillTried = true;
    const file = SpillFile.open(dir);
    if (file === void 0) return;
    file.write(this.#head);
    file.write(this.#tail);
    this.#spill = file;
  }
  #retain(chunk2, bytes) {
    let rest = chunk2;
    let restBytes = bytes;
    if (!this.#headClosed) {
      const room = this.#headLimit - this.#headBytes;
      if (bytes <= room) {
        this.#head += chunk2;
        this.#headBytes += bytes;
        return;
      }
      const taken = headWindow(chunk2, room);
      this.#head += taken.text;
      this.#headBytes += taken.bytes;
      this.#headClosed = true;
      rest = chunk2.slice(taken.text.length);
      restBytes = bytes - taken.bytes;
    }
    if (restBytes >= this.#tailLimit) {
      const window2 = tailWindow(rest, this.#tailLimit);
      this.#tail = window2.text;
      this.#tailBytes = window2.bytes;
      return;
    }
    this.#tail += rest;
    this.#tailBytes += restBytes;
    if (this.#tailBytes > this.#tailLimit * 2) {
      const window2 = tailWindow(this.#tail, this.#tailLimit);
      this.#tail = window2.text;
      this.#tailBytes = window2.bytes;
    }
  }
  #progress(chunk2, bytes) {
    if (this.#onChunk === void 0) return;
    this.#pendingBytes += bytes;
    this.#pending = chunk2.length >= PROGRESS_CHUNK_BYTES ? chunk2.slice(chunk2.length - PROGRESS_CHUNK_BYTES) : this.#pending + chunk2;
    if (this.#pending.length > PROGRESS_CHUNK_BYTES * 2) this.#pending = this.#pending.slice(this.#pending.length - PROGRESS_CHUNK_BYTES);
    const now = this.#now();
    const wait = PROGRESS_INTERVAL_MS - (now - this.#lastChunkAt);
    if (wait <= 0) this.#flush(now);
    else if (this.#timer === void 0) {
      this.#timer = setTimeout(() => this.#flush(this.#now()), wait);
      this.#timer.unref?.();
    }
  }
  #flush(now) {
    if (this.#timer !== void 0) {
      clearTimeout(this.#timer);
      this.#timer = void 0;
    }
    if (this.#pendingBytes === 0) return;
    const sent = tailWindow(this.#pending, PROGRESS_CHUNK_BYTES);
    const dropped = this.#pendingBytes - sent.bytes;
    this.#pending = "";
    this.#pendingBytes = 0;
    this.#lastChunkAt = now;
    this.#onChunk?.(dropped > 0 ? `[\u2026${dropped}B elided\u2026]
${sent.text}` : sent.text);
  }
  /**
   * About how many bytes {@link dump} shows of this stream so far, footer not counted: all of it while it fits the budget, else the two windows and the marker. Never less than what `dump` makes.
   */
  estimate(maxBytes = this.#max) {
    const budget = Math.min(maxBytes, this.#max);
    return Math.min(this.#total, Math.floor(budget * (HEAD_SHARE + TAIL_SHARE)) + ELISION_MARKER_BYTES);
  }
  /**
   * What the stream shows now, and the end of it: the pending progress chunk is sent, the file is closed, nothing more is taken. `maxBytes` (never more than the sink's own budget) is what the text may take, footer not
   * counted: a stream that is longer is cut to its start and its end. A stream that fit the sink but not `maxBytes` has no file yet, and gets one now, so what is cut is still somewhere.
   */
  dump(maxBytes = this.#max) {
    this.#flush(this.#now());
    this.#closed = true;
    const budget = Math.min(maxBytes, this.#max);
    if (this.#total <= budget) {
      this.#spill?.close();
      return { text: (this.#head + this.#tail).trim(), totalBytes: this.#total };
    }
    const whole = this.#total <= this.#max;
    if (whole && this.#spillDir !== void 0 && this.#spill === void 0 && !this.#spillTried) this.#openSpill(this.#spillDir);
    this.#spill?.close();
    const start = whole ? this.#head + this.#tail : this.#head;
    const end = whole ? start : this.#tail;
    const headShown = headWindow(start, Math.floor(budget * HEAD_SHARE));
    const tailShown = tailWindow(end, Math.floor(budget * TAIL_SHARE));
    const head = headShown.text.trimStart();
    const tail = tailShown.text.trimEnd();
    const trimmed = headShown.bytes - Buffer.byteLength(head, "utf8") + (tailShown.bytes - Buffer.byteLength(tail, "utf8"));
    const elided = elideMiddle(head, tail, this.#total - trimmed);
    const spill = this.#spill;
    let text2 = elided;
    if (spill !== void 0) {
      text2 += `${text2.endsWith(NEWLINE) ? "" : NEWLINE}[raw output: ${spill.path}]`;
      if (spill.notKeptBytes > 0) text2 += `
[the file stops at ${spill.keptBytes}B: ${spill.notKeptBytes}B more were printed and are not kept]`;
    }
    return {
      text: text2,
      totalBytes: this.#total,
      ...spill === void 0 ? {} : { spillPath: spill.path }
    };
  }
};

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/cell/display.ts
var BASE64_STRICT_RE = /^[A-Za-z0-9+/]+={0,2}$/;
var DECIMAL_CSV_RE = /^\d{1,3}(?:,\d{1,3})*$/;
function isStrictBase64(s) {
  if (s.length === 0 || s.length % 4 !== 0) return false;
  return BASE64_STRICT_RE.test(s);
}
function coerceImageBase64(data) {
  if (typeof data === "string") {
    if (isStrictBase64(data)) return data;
    if (DECIMAL_CSV_RE.test(data)) {
      const parts = data.split(",");
      const bytes = new Uint8Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const n = Number(parts[i]);
        if (!Number.isInteger(n) || n < 0 || n > 255) return null;
        bytes[i] = n;
      }
      return Buffer.from(bytes).toString("base64");
    }
    return null;
  }
  if (data instanceof Uint8Array) return Buffer.from(data).toString("base64");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("base64");
  if (ArrayBuffer.isView(data)) {
    const view = data;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64");
  }
  if (data && typeof data === "object") {
    const obj = data;
    if (obj.type === "Buffer" && Array.isArray(obj.data)) {
      const arr = obj.data;
      const bytes = new Uint8Array(arr.length);
      for (let i = 0; i < arr.length; i++) {
        const n = arr[i];
        if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255) return null;
        bytes[i] = n;
      }
      return Buffer.from(bytes).toString("base64");
    }
  }
  return null;
}
function describeDataType(data) {
  if (data === null) return "null";
  if (typeof data !== "object") return typeof data;
  return Object.prototype.toString.call(data).slice(8, -1);
}
function formatConsoleArgs(args) {
  return args.map((arg) => typeof arg === "string" ? arg : util.inspect(arg, { depth: 6, colors: false, breakLength: 120 })).join(" ");
}
function displayValue(value, hooks) {
  if (value === void 0) return;
  if (value && typeof value === "object") {
    const record = value;
    if (record.type === "image" && typeof record.mimeType === "string") {
      const data = coerceImageBase64(record.data);
      if (data !== null) {
        hooks.onDisplay({ type: "image", data, mimeType: record.mimeType });
        return;
      }
      hooks.onText(
        `[display: image dropped \u2014 \`data\` must be a base64 string, Uint8Array/Buffer, or ArrayBuffer; got ${describeDataType(record.data)}]
`
      );
      return;
    }
    try {
      hooks.onDisplay({ type: "json", data: structuredClone(value) });
    } catch {
      hooks.onText(`${Object.prototype.toString.call(value)}
`);
    }
    return;
  }
  hooks.onText(`${String(value)}
`);
}
function createConsoleBridge(hooks) {
  const log = (level, ...args) => {
    const prefix = level === "error" ? "[error] " : level === "warn" ? "[warn] " : "";
    const text2 = `${prefix}${formatConsoleArgs(args)}`;
    hooks.onText(text2.endsWith("\n") ? text2 : `${text2}
`);
  };
  const table = (...args) => {
    let buffer = "";
    const stream = new Writable({
      write(chunk2, _enc, cb) {
        buffer += typeof chunk2 === "string" ? chunk2 : chunk2.toString("utf8");
        cb();
      }
    });
    const tableConsole = new Console({ stdout: stream, colorMode: false });
    tableConsole.table(...args);
    hooks.onText(buffer.endsWith("\n") ? buffer : `${buffer}
`);
  };
  const timers = /* @__PURE__ */ new Map();
  const counts = /* @__PURE__ */ new Map();
  const bridge = {
    log: (...args) => log("log", ...args),
    info: (...args) => log("info", ...args),
    warn: (...args) => log("warn", ...args),
    error: (...args) => log("error", ...args),
    debug: (...args) => log("debug", ...args),
    table: (data, columns) => columns === void 0 ? table(data) : table(data, columns),
    dir: (value, _options) => log("log", value),
    dirxml: (...args) => log("log", ...args),
    trace: (...args) => {
      const stack = (new Error().stack ?? "").split("\n").slice(2).join("\n");
      log("log", args.length > 0 ? `Trace: ${args.join(" ")}` : "Trace", `
${stack}`);
    },
    assert: (condition, ...args) => {
      if (condition) return;
      if (args.length > 0) log("error", "Assertion failed:", ...args);
      else log("error", "Assertion failed");
    },
    group: (...args) => {
      if (args.length > 0) log("log", ...args);
    },
    groupCollapsed: (...args) => {
      if (args.length > 0) log("log", ...args);
    },
    groupEnd: () => {
    },
    time: (label) => {
      timers.set(String(label ?? "default"), Date.now());
    },
    timeLog: (label, ...args) => {
      const key = String(label ?? "default");
      const start = timers.get(key);
      if (start === void 0) {
        log("warn", `Timer '${key}' does not exist`);
        return;
      }
      log("log", `${key}: ${Date.now() - start}ms`, ...args);
    },
    timeEnd: (label) => {
      const key = String(label ?? "default");
      const start = timers.get(key);
      if (start === void 0) {
        log("warn", `Timer '${key}' does not exist`);
        return;
      }
      timers.delete(key);
      log("log", `${key}: ${Date.now() - start}ms`);
    },
    count: (label) => {
      const key = String(label ?? "default");
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      log("log", `${key}: ${next}`);
    },
    countReset: (label) => {
      counts.delete(String(label ?? "default"));
    }
  };
  return bridge;
}
var MAX_DISPLAY_TEXT_BYTES = 8e3;
function formatDisplayJsonForText(value) {
  let text2;
  try {
    text2 = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text2 = String(value);
  }
  if (text2.length > MAX_DISPLAY_TEXT_BYTES) {
    text2 = `${text2.slice(0, MAX_DISPLAY_TEXT_BYTES)}
[\u2026${text2.length - MAX_DISPLAY_TEXT_BYTES}ch elided\u2026]`;
  }
  return text2;
}
var MAX_IMAGE_BASE64_CHARS = 32 * 1024 * 1024;
var SECTION_GAP = "\n\n";
var CellOutput = class {
  #stream;
  #blocks = new OutputSink();
  #blockCount = 0;
  #images = [];
  #imageChars = 0;
  #imagesDropped = 0;
  constructor(options = {}) {
    this.#stream = new OutputSink({
      ...options.spillDir === void 0 ? {} : { spillDir: options.spillDir },
      ...options.onText === void 0 ? {} : { onChunk: options.onText }
    });
  }
  hooks() {
    return {
      onText: (chunk2) => this.#stream.push(chunk2),
      onDisplay: (output) => {
        if (output.type === "image") {
          if (this.#imageChars + output.data.length > MAX_IMAGE_BASE64_CHARS) this.#imagesDropped += 1;
          else {
            this.#imageChars += output.data.length;
            this.#images.push({ type: "image", data: output.data, mimeType: output.mimeType });
          }
          return;
        }
        this.#blockCount += 1;
        const block = `display[${this.#blockCount}]:
${formatDisplayJsonForText(output.data)}`;
        this.#blocks.push(this.#blockCount === 1 ? block : `

${block}`);
      }
    };
  }
  /**
   * The cell's text, within {@link MAX_INLINE_BYTES} less `reserveBytes` (room a failed cell leaves for its error line, which the tool appends). The stream and the blocks share the budget: a section that fits in its
   * half, or in what the other leaves, is shown whole; one that does not is cut to its start and its end with its own marker. A stream cut here has the whole of what it printed in the file the footer names, even if it
   * would have fitted the stream's own budget alone.
   */
  finish(reserveBytes = 0) {
    const note = this.#imagesDropped === 0 ? "" : `[display: ${this.#imagesDropped} image${this.#imagesDropped === 1 ? "" : "s"} dropped \u2014 one cell keeps at most ${MAX_IMAGE_BASE64_CHARS / (1024 * 1024)} MiB of images]`;
    const gaps = SECTION_GAP.length * 2;
    const room = Math.max(0, MAX_INLINE_BYTES - reserveBytes - gaps - Buffer.byteLength(note, "utf8"));
    let streamRoom = this.#stream.estimate() + FOOTER_BYTES;
    let blocksRoom = this.#blocks.estimate();
    if (streamRoom + blocksRoom > room) {
      const half = Math.floor(room / 2);
      if (streamRoom <= half) blocksRoom = room - streamRoom;
      else if (blocksRoom <= half) streamRoom = room - blocksRoom;
      else {
        streamRoom = half;
        blocksRoom = room - half;
      }
    }
    const stdout = this.#stream.dump(Math.max(0, streamRoom - FOOTER_BYTES)).text;
    const shown = this.#blocks.dump(Math.max(0, room - Buffer.byteLength(stdout, "utf8"))).text;
    const text2 = [stdout, shown, note].filter((part) => part.length > 0).join(SECTION_GAP);
    return { text: text2, images: this.#images };
  }
};

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/cell/wrap-code.ts
var babelParser;
async function loadBabelParser() {
  if (!babelParser) {
    babelParser = await import("@babel/parser");
  }
  return babelParser;
}
async function parseProgram(code) {
  const { parse } = await loadBabelParser();
  try {
    return parse(code, {
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowNewTargetOutsideFunction: true,
      allowSuperOutsideMethod: true,
      allowUndeclaredExports: true,
      errorRecovery: true
    });
  } catch {
    return null;
  }
}
var DYNAMIC_IMPORT_CALLEE = '(typeof __omp_import__ === "function" ? __omp_import__ : (s, o) => import(s, o))';
function buildOmpImportCall(sourceLiteral, optionsLiteral) {
  return optionsLiteral ? `__omp_import__(${sourceLiteral}, ${optionsLiteral})` : `__omp_import__(${sourceLiteral})`;
}
function walkNodes(root, visit) {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i--) stack.push(current[i]);
      continue;
    }
    const node = current;
    if (typeof node.type === "string") visit(node);
    for (const key in node) {
      if (key === "loc" || key === "extra" || key === "range") continue;
      if (key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
      const value = node[key];
      if (value && typeof value === "object") stack.push(value);
    }
  }
}
function buildOptionsLiteral(node) {
  const attrs = node.attributes;
  if (!attrs || attrs.length === 0) return void 0;
  const pairs = attrs.map((attr) => {
    const key = attr.key.type === "Identifier" ? attr.key.name : JSON.stringify(attr.key.value);
    return `${key}: ${JSON.stringify(attr.value.value)}`;
  });
  return `{ with: { ${pairs.join(", ")} } }`;
}
function rewriteImportNode(node) {
  const sourceLiteral = JSON.stringify(node.source.value);
  const optionsLiteral = buildOptionsLiteral(node);
  const importCall = buildOmpImportCall(sourceLiteral, optionsLiteral);
  let defaultName;
  let namespaceName;
  const namedPairs = [];
  for (const spec of node.specifiers) {
    if (spec.type === "ImportDefaultSpecifier") {
      defaultName = spec.local.name;
    } else if (spec.type === "ImportNamespaceSpecifier") {
      namespaceName = spec.local.name;
    } else if (spec.type === "ImportSpecifier" && spec.imported) {
      const imported = spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
      namedPairs.push([imported, spec.local.name]);
    }
  }
  if (namedPairs.length > 0) {
    const inner = namedPairs.map(([imp, loc]) => imp === loc ? imp : `${imp}: ${loc}`).join(", ");
    const props = defaultName ? `default: ${defaultName}, ${inner}` : inner;
    return `const { ${props} } = await ${importCall};`;
  }
  if (namespaceName && defaultName) {
    return `const ${namespaceName} = await ${importCall}; const ${defaultName} = ${namespaceName}.default;`;
  }
  if (namespaceName) return `const ${namespaceName} = await ${importCall};`;
  if (defaultName) return `const ${defaultName} = (await ${importCall}).default;`;
  return `await ${importCall};`;
}
async function rewriteImports(code) {
  if (!code.includes("import")) return code;
  const ast = await parseProgram(code);
  if (!ast) {
    return code;
  }
  const edits = [];
  for (const node of ast.program.body) {
    if (node.type !== "ImportDeclaration") continue;
    const decl = node;
    edits.push({ start: decl.start, end: decl.end, text: rewriteImportNode(decl) });
  }
  walkNodes(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const call = node;
    const callee = call.callee;
    if (callee?.type !== "Import" || typeof callee.start !== "number" || typeof callee.end !== "number") return;
    edits.push({ start: callee.start, end: callee.end, text: DYNAMIC_IMPORT_CALLEE });
  });
  if (edits.length === 0) return code;
  edits.sort((a, b) => b.start - a.start);
  let result = code;
  for (const edit of edits) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}
function collectBindingNames(pattern, names) {
  if (!pattern || typeof pattern !== "object") return;
  const node = pattern;
  switch (node.type) {
    case "Identifier":
      if (typeof node.name === "string") names.push(node.name);
      return;
    case "ObjectPattern":
      for (const property of node.properties ?? []) collectBindingNames(property, names);
      return;
    case "ObjectProperty":
    case "Property":
      collectBindingNames(node.value, names);
      return;
    case "ArrayPattern":
      for (const element of node.elements ?? []) collectBindingNames(element, names);
      return;
    case "AssignmentPattern":
      collectBindingNames(node.left, names);
      return;
    case "RestElement":
      collectBindingNames(node.argument, names);
      return;
    default:
      return;
  }
}
function getLexicalBindingNames(node) {
  const names = [];
  if (node.type === "VariableDeclaration") {
    for (const declaration of node.declarations ?? []) collectBindingNames(declaration.id, names);
  } else if (node.id) {
    names.push(node.id.name);
  }
  return names;
}
function appendBindingPublish(source, names) {
  if (names.length === 0) return source;
  const assignments = names.map((name) => `this[${JSON.stringify(name)}] = ${name};`).join("\n");
  return `${source};
${assignments}`;
}
async function demoteTopLevelLexicals(code) {
  if (!/\b(?:const|let|class|var|function)\b/.test(code)) return { source: code, names: [] };
  const ast = await parseProgram(code);
  if (!ast) return { source: code, names: [] };
  const targets = [];
  for (const node of ast.program.body) {
    if (node.type === "VariableDeclaration") {
      const decl = node;
      targets.push({ node: decl, demote: decl.kind === "const" || decl.kind === "let" });
    } else if (node.type === "ClassDeclaration") {
      const decl = node;
      if (decl.id) targets.push({ node: decl, demote: true });
    } else if (node.type === "FunctionDeclaration") {
      const decl = node;
      if (decl.id) targets.push({ node: decl, demote: false });
    }
  }
  if (targets.length === 0) return { source: code, names: [] };
  targets.sort((a, b) => b.node.start - a.node.start);
  const names = /* @__PURE__ */ new Set();
  let result = code;
  for (const { node, demote } of targets) {
    const segment = result.slice(node.start, node.end);
    const bindingNames = getLexicalBindingNames(node);
    for (const name of bindingNames) names.add(name);
    let replacement;
    if (!demote) {
      replacement = segment;
    } else if (node.type === "VariableDeclaration") {
      replacement = `var${segment.slice(node.kind.length)}`;
    } else {
      const id = node.id;
      if (!id) continue;
      const idEndInSegment = id.end - node.start;
      const tail = segment.slice(idEndInSegment);
      const hasTrailingSemi = segment.endsWith(";");
      replacement = `var ${id.name} = class${tail}${hasTrailingSemi ? "" : ";"}`;
    }
    result = result.slice(0, node.start) + appendBindingPublish(replacement, bindingNames) + result.slice(node.end);
  }
  return { source: result, names: [...names] };
}
async function returnFinalExpression(code) {
  const ast = await parseProgram(code);
  const body = ast?.program.body;
  if (!body) return { source: code, returned: false };
  let lastIndex = body.length - 1;
  while (lastIndex >= 0 && body[lastIndex]?.type === "EmptyStatement") lastIndex--;
  const last = lastIndex >= 0 ? body[lastIndex] : void 0;
  if (last?.type === "ExpressionStatement") {
    const expression = last;
    const prefix = code.slice(0, expression.start);
    const statement = code.slice(expression.start, expression.end);
    const suffix = code.slice(expression.end);
    const semicolonMatch = statement.match(/;\s*$/);
    const trimmedStatement = semicolonMatch ? statement.slice(0, semicolonMatch.index) : statement;
    return { source: `${prefix}__omp_set_final_expr__((${trimmedStatement}));${suffix}`, returned: true };
  }
  if (last?.type === "ReturnStatement") {
    const ret = last;
    if (!ret.argument) return { source: code, returned: false };
    const prefix = code.slice(0, ret.start);
    const suffix = code.slice(ret.end);
    const expr = code.slice(ret.argument.start, ret.argument.end);
    return { source: `${prefix}__omp_set_final_expr__((${expr}));${suffix}`, returned: true };
  }
  return { source: code, returned: false };
}
async function wrapCode(code) {
  const finalExpression = await returnFinalExpression(code);
  const importsRewritten = await rewriteImports(finalExpression.source);
  const { source, names } = await demoteTopLevelLexicals(importsRewritten);
  const republish = names.map((name) => `if (${name} !== undefined) this[${JSON.stringify(name)}] = ${name};`).join("\n");
  const body = republish ? `try {
${source}
} finally {
${republish}
}` : source;
  return {
    source: `(async () => {
${body}
})()`,
    finalExpressionReturned: finalExpression.returned
  };
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/cell/evaluator.ts
var evalInScope = new Function("return function () { with (arguments[0]) { return eval(arguments[1]); } }")();
function toKey(key) {
  return typeof key === "string" ? key : void 0;
}
function createCodeEvaluator() {
  const store = /* @__PURE__ */ Object.create(null);
  const runs = new AsyncLocalStorage();
  let latest;
  const current = () => runs.getStore() ?? latest;
  const liveHooks = () => {
    const run = runs.getStore() ?? (latest?.finished === false ? latest : void 0);
    return run?.hooks;
  };
  const routed = {
    onText: (chunk2) => liveHooks()?.onText(chunk2),
    onDisplay: (output) => liveHooks()?.onDisplay(output)
  };
  const consoleBridge = createConsoleBridge(routed);
  const builtins = {
    console: consoleBridge,
    print: consoleBridge.log,
    display: (value) => displayValue(value, routed),
    __omp_set_final_expr__: (value) => {
      const run = runs.getStore();
      if (!run) return;
      run.finalExpressionSet = true;
      run.finalExpressionValue = value;
    },
    // The specifier is the model's, chosen at run time. Node knows one import attribute, `type: "json"`; spelled as literals so esbuild (which only reads literal options) leaves the call as it is.
    __omp_import__: async (source, options) => options?.with?.type === "json" ? await import(source, { with: { type: "json" } }) : await import(source)
  };
  const owner = (key) => {
    const scope = current()?.scope;
    if (scope !== void 0 && key in scope) return "scope";
    if (key in store) return "store";
    if (key in builtins) return "builtin";
    return void 0;
  };
  const env = new Proxy(/* @__PURE__ */ Object.create(null), {
    has: (_target, key) => {
      const name = toKey(key);
      return name !== void 0 && owner(name) !== void 0;
    },
    get: (_target, key) => {
      const name = toKey(key);
      if (name === void 0) return void 0;
      switch (owner(name)) {
        case "scope":
          return current()?.scope[name];
        case "store":
          return store[name];
        case "builtin":
          return builtins[name];
        default:
          return void 0;
      }
    },
    set: (_target, key, value) => {
      const name = toKey(key);
      if (name === void 0) return false;
      const scope = current()?.scope;
      if (scope !== void 0 && name in scope) scope[name] = value;
      else store[name] = value;
      return true;
    },
    deleteProperty: (_target, key) => {
      const name = toKey(key);
      if (name !== void 0) delete store[name];
      return true;
    }
  });
  return {
    async evaluate(code, options) {
      const run = { hooks: options.hooks, scope: options.scope, finished: false, finalExpressionSet: false, finalExpressionValue: void 0 };
      latest = run;
      try {
        return await runs.run(run, async () => {
          const wrapped = await wrapCode(code);
          const withPragma = `${wrapped.source}
//# sourceURL=${options.filename}`;
          const returned = await evalInScope.call(store, env, withPragma);
          if (!run.finalExpressionSet) return returned;
          const final = run.finalExpressionValue;
          run.finalExpressionSet = false;
          run.finalExpressionValue = void 0;
          return await final;
        });
      } finally {
        run.finished = true;
      }
    }
  };
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/errors.ts
var ToolError = class extends Error {
  constructor(message, context) {
    super(message);
    this.context = context;
    this.name = "ToolError";
  }
  /** The text shown to the model. */
  render() {
    return this.message;
  }
};
var ToolAbortError = class _ToolAbortError extends Error {
  static MESSAGE = "Operation aborted";
  constructor(message = _ToolAbortError.MESSAGE, options) {
    super(message, options);
    this.name = "ToolAbortError";
  }
};
function throwIfAborted(signal) {
  if (signal?.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason : void 0;
    throw reason instanceof ToolAbortError ? reason : new ToolAbortError(void 0, { cause: signal.reason });
  }
}
var settledRejections = /* @__PURE__ */ new WeakSet();
function markRejectionHandled(reason) {
  if (reason !== null && (typeof reason === "object" || typeof reason === "function")) settledRejections.add(reason);
}
function isRejectionHandled(reason) {
  return reason !== null && (typeof reason === "object" || typeof reason === "function") && settledRejections.has(reason);
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/cell/run-code.ts
var NON_SERIALIZABLE_RUN_ARGUMENT = "Run argument is not JSON-serializable; pass plain data";
function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function hasSoleOwnKey(value, key) {
  const keys = Reflect.ownKeys(value);
  return keys.length === 1 && keys[0] === key;
}
function renderRunArg(value) {
  if (value === void 0) return "undefined";
  if (isPlainObject(value) && hasSoleOwnKey(value, "__omp_fn") && typeof value.__omp_fn === "string") {
    return `(${value.__omp_fn})`;
  }
  if (isPlainObject(value) && hasSoleOwnKey(value, "__omp_re")) {
    const marker = value.__omp_re;
    if (isPlainObject(marker) && typeof marker.source === "string" && (marker.flags === void 0 || typeof marker.flags === "string")) {
      return `new RegExp(${JSON.stringify(marker.source)}, ${JSON.stringify(marker.flags ?? "")})`;
    }
  }
  let rendered;
  try {
    rendered = JSON.stringify(value);
  } catch {
    throw new ToolError(NON_SERIALIZABLE_RUN_ARGUMENT);
  }
  if (rendered === void 0) throw new ToolError(NON_SERIALIZABLE_RUN_ARGUMENT);
  return rendered;
}
function renderFunctionRun(fnSource, scopeNames, args) {
  const scope = scopeNames.join(", ");
  const renderedArgs = args.map((value) => `, ${renderRunArg(value)}`).join("");
  return `return await (${fnSource})({ ${scope} }${renderedArgs});`;
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/tab-call.ts
var TAB_VALUE_METHODS = [
  "url",
  "title",
  "goto",
  "observe",
  "ariaSnapshot",
  "screenshot",
  "extract",
  "click",
  "type",
  "fill",
  "press",
  "scroll",
  "drag",
  "scrollIntoView",
  "select",
  "uploadFile",
  "waitForUrl",
  "evaluate"
];
var TAB_PRESENCE_METHODS = ["waitFor", "waitForSelector"];
var TAB_HANDLE_METHODS = ["id", "ref"];
var ELEMENT_METHODS = [
  "click",
  "type",
  "fill",
  "press",
  "hover",
  "focus",
  "select",
  "uploadFile",
  "scrollIntoView",
  "boundingBox",
  "isVisible",
  "isHidden",
  "evaluate"
];
var DIRECT_METHODS_DESCRIPTION = [...TAB_VALUE_METHODS, ...TAB_PRESENCE_METHODS].join(", ");
var ELEMENT_METHODS_DESCRIPTION = ELEMENT_METHODS.join(", ");
function renderStep(step) {
  return `${step.method}(${step.args.map(renderRunArg).join(", ")})`;
}
function renderElementStep(step) {
  if (step.method !== "evaluate" || typeof step.args[0] !== "string") return renderStep(step);
  const [source, ...args] = step.args;
  const renderedArgs = args.map((value) => `, ${renderRunArg(value)}`).join("");
  return `evaluate((${source})${renderedArgs})`;
}
function renderTabCall(chain) {
  if (chain.length === 0) {
    throw new ToolError("Action 'call' requires a non-empty 'chain'.");
  }
  if (chain.length > 2) {
    throw new ToolError("Call chains support one element-handle hop at most; use tab.run(fn) for longer sequences.");
  }
  const root = chain[0];
  if (TAB_VALUE_METHODS.includes(root.method)) {
    if (chain.length === 2) {
      throw new ToolError(`Only tab.id(n)/tab.ref(id) results accept a chained call; got tab.${root.method}().`);
    }
    return `return await tab.${renderStep(root)};`;
  }
  if (TAB_PRESENCE_METHODS.includes(root.method)) {
    if (chain.length === 2) {
      throw new ToolError(`Only tab.id(n)/tab.ref(id) results accept a chained call; got tab.${root.method}().`);
    }
    return `return (await tab.${renderStep(root)}) !== null;`;
  }
  if (TAB_HANDLE_METHODS.includes(root.method)) {
    if (chain.length === 1) {
      throw new ToolError(
        `tab.${root.method}() returns an element handle; call a method on it (tab.id(5).click()) or use tab.run(fn).`
      );
    }
    const element = chain[1];
    if (!ELEMENT_METHODS.includes(element.method)) {
      throw new ToolError(
        `Unknown element method "${element.method}". Element handles support: ${ELEMENT_METHODS_DESCRIPTION}.`
      );
    }
    return `return await (await tab.${renderStep(root)}).${renderElementStep(element)};`;
  }
  throw new ToolError(
    `Unknown tab helper "${root.method}". Direct helpers: ${DIRECT_METHODS_DESCRIPTION}; element handles via tab.id(n)/tab.ref(id).`
  );
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/kinds/cmux/cmux-tab.ts
import * as fs2 from "node:fs";
import * as os2 from "node:os";
import * as path2 from "node:path";

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/aria-snapshot.bundle.txt
var aria_snapshot_bundle_default = '// @generated by scripts/generate-aria-snapshot.ts from Playwright v1.61.0\n// Bundled from Playwright\'s injected ARIA-snapshot sources (Apache-2.0, (c) Microsoft).\n// Do not edit by hand. Regenerate with: bun scripts/generate-aria-snapshot.ts\nvar{defineProperty:M_,getOwnPropertyNames:WX,getOwnPropertyDescriptor:LX}=Object,zX=Object.prototype.hasOwnProperty;function MX(_){return this[_]}var jX=(_)=>{var J=(k_??=new WeakMap).get(_),Z;if(J)return J;if(J=M_({},"__esModule",{value:!0}),_&&typeof _==="object"||typeof _==="function"){for(var $ of WX(_))if(!zX.call(J,$))M_(J,$,{get:MX.bind(_,$),enumerable:!(Z=LX(_,$))||Z.enumerable})}return k_.set(_,J),J},k_;var FX=(_)=>_;function BX(_,J){this[_]=FX.bind(null,J)}var IX=(_,J)=>{for(var Z in J)M_(_,Z,{get:J[Z],enumerable:!0,configurable:!0,set:BX.bind(J,Z)})};var YZ={};IX(YZ,{resolveAriaRef:()=>$Z,ariaSnapshot:()=>ZZ});module.exports=jX(YZ);function h_(_,J){if(_.role!==J.role||_.name!==J.name)return!1;if(!VX(_,J)||d(_)!==d(J))return!1;let Z=Object.keys(_.props),$=Object.keys(J.props);return Z.length===$.length&&Z.every((X)=>_.props[X]===J.props[X])}function d(_){return _.box.cursor==="pointer"}function VX(_,J){return _.active===J.active&&_.checked===J.checked&&_.disabled===J.disabled&&_.expanded===J.expanded&&_.invalid===J.invalid&&_.selected===J.selected&&_.level===J.level&&_.pressed===J.pressed}var u_;function j_(_){let J=u_?.get(_);if(J===void 0)J=_.replace(/[\\u200b\\u00ad]/g,"").trim().replace(/\\s+/g," "),u_?.set(_,J);return J}function F_(_){return _.replace(/[.*+?^${}()|[\\]\\\\]/g,"\\\\$&")}function p_(_,J){let Z=_.length,$=J.length,X=0,Q=0,U=Array(Z+1).fill(null).map(()=>Array($+1).fill(0));for(let W=1;W<=Z;W++)for(let Y=1;Y<=$;Y++)if(_[W-1]===J[Y-1]){if(U[W][Y]=U[W-1][Y-1]+1,U[W][Y]>X)X=U[W][Y],Q=W}return _.slice(Q-X,Q)}var HZ=new RegExp("([\\\\u001B\\\\u009B][[\\\\]()#?]*(?:(?:(?:[a-zA-Z\\\\d]*(?:;[-a-zA-Z\\\\d\\\\/#&.:=?%@~_]*)*)?\\\\u0007)|(?:(?:\\\\d{0,4}(?:;\\\\d{0,4})*)?[\\\\dA-PR-TZcf-ntqry=><~])))","g");function c_(_){if(!m_(_))return _;return"\'"+_.replace(/\'/g,"\'\'")+"\'"}function e(_){if(!m_(_))return _;return\'"\'+_.replace(/[\\\\"\\x00-\\x1f\\x7f-\\x9f]/g,(J)=>{switch(J){case"\\\\":return"\\\\\\\\";case\'"\':return"\\\\\\"";case"\\b":return"\\\\b";case"\\f":return"\\\\f";case`\n`:return"\\\\n";case"\\r":return"\\\\r";case"\\t":return"\\\\t";default:return"\\\\x"+J.charCodeAt(0).toString(16).padStart(2,"0")}})+\'"\'}function m_(_){if(_.length===0)return!0;if(/^\\s|\\s$/.test(_))return!0;if(/[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f]/.test(_))return!0;if(/^-/.test(_))return!0;if(/[\\n:](\\s|$)/.test(_))return!0;if(/\\s#/.test(_))return!0;if(/[\\n\\r]/.test(_))return!0;if(/^[&*\\],?!>|@"\'#%]/.test(_))return!0;if(/[{}`]/.test(_))return!0;if(/^\\[/.test(_))return!0;if(!isNaN(Number(_))||["y","n","yes","no","true","false","on","off","null"].includes(_.toLowerCase()))return!0;return!1}var DX={};function h(_){if(_.parentElement)return _.parentElement;if(!_.parentNode)return;if(_.parentNode.nodeType===11&&_.parentNode.host)return _.parentNode.host}function d_(_){let J=_;while(J.parentNode)J=J.parentNode;if(J.nodeType===11||J.nodeType===9)return J}function OX(_){while(_.parentElement)_=_.parentElement;return h(_)}function s(_,J,Z){while(_){let $=_.closest(J);if(Z&&$!==Z&&$?.contains(Z))return;if($)return $;_=OX(_)}}function b(_,J){let Z=J==="::before"?R_:J==="::after"?D_:V_;if(Z&&Z.has(_))return Z.get(_);let $=_.ownerDocument&&_.ownerDocument.defaultView?_.ownerDocument.defaultView.getComputedStyle(_,J):void 0;return Z?.set(_,$),$}function B_(_,J){if(J=J??b(_),!J)return!0;if(Element.prototype.checkVisibility&&DX.browserNameForWorkarounds!=="webkit"){if(!_.checkVisibility())return!1}else{let Z=_.closest("details,summary");if(Z!==_&&Z?.nodeName==="DETAILS"&&!Z.open)return!1}if(J.visibility!=="visible")return!1;return!0}function i(_){let J=b(_);if(!J)return{visible:!0,inline:!1};let Z=J.cursor;if(J.display==="contents"){for(let X=_.firstChild;X;X=X.nextSibling){if(X.nodeType===1&&__(X))return{visible:!0,inline:!1,cursor:Z};if(X.nodeType===3&&I_(X))return{visible:!0,inline:!0,cursor:Z}}return{visible:!1,inline:!1,cursor:Z}}if(!B_(_,J))return{cursor:Z,visible:!1,inline:!1};let $=_.getBoundingClientRect();return{cursor:Z,visible:$.width>0&&$.height>0,inline:J.display==="inline"}}function __(_){return i(_).visible}function I_(_){let J=_.ownerDocument.createRange();J.selectNode(_);let Z=J.getBoundingClientRect();return Z.width>0&&Z.height>0}function V(_){let J=_.tagName;if(typeof J==="string")return J.toUpperCase();if(_ instanceof HTMLFormElement)return"FORM";return _.tagName.toUpperCase()}var V_,R_,D_,s_=0;function i_(){++s_,V_??=new Map,R_??=new Map,D_??=new Map}function l_(){if(!--s_)V_=void 0,R_=void 0,D_=void 0}var R=function(_,J,Z){return _>=J&&_<=Z};function A(_){return R(_,48,57)}function r_(_){return A(_)||R(_,65,70)||R(_,97,102)}function wX(_){return R(_,65,90)}function AX(_){return R(_,97,122)}function EX(_){return wX(_)||AX(_)}function PX(_){return _>=128}function J_(_){return EX(_)||PX(_)||_===95}function a_(_){return J_(_)||A(_)||_===45}function fX(_){return R(_,0,8)||_===11||R(_,14,31)||_===127}function u(_){return _===10}function T(_){return u(_)||_===9||_===32}var CX=1114111;class Z_ extends Error{constructor(_){super(_);this.name="InvalidCharacterError"}}function bX(_){let J=[];for(let Z=0;Z<_.length;Z++){let $=_.charCodeAt(Z);if($===13&&_.charCodeAt(Z+1)===10)$=10,Z++;if($===13||$===12)$=10;if($===0)$=65533;if(R($,55296,56319)&&R(_.charCodeAt(Z+1),56320,57343)){let X=$-55296,Q=_.charCodeAt(Z+1)-56320;$=Math.pow(2,16)+X*Math.pow(2,10)+Q,Z++}J.push($)}return J}function D(_){if(_<=65535)return String.fromCharCode(_);_-=Math.pow(2,16);let J=Math.floor(_/Math.pow(2,10))+55296,Z=_%Math.pow(2,10)+56320;return String.fromCharCode(J)+String.fromCharCode(Z)}function n_(_){let J=bX(_),Z=-1,$=[],X,Q=0,U=0,W=0,Y=function(){Q+=1,W=U,U=0},K={line:Q,column:U},z=function(G){if(G>=J.length)return-1;return J[G]},q=function(G){if(G===void 0)G=1;if(G>3)throw"Spec Error: no more than three codepoints of lookahead.";return z(Z+G)},L=function(G){if(G===void 0)G=1;if(Z+=G,X=z(Z),u(X))Y();else U+=G;return!0},I=function(){if(Z-=1,u(X))Q-=1,U=W;else U-=1;return K.line=Q,K.column=U,!0},H=function(G){if(G===void 0)G=X;return G===-1},F=function(){},j=function(){},w=function(){if(E(),L(),T(X)){while(T(q()))L();return new $_}else if(X===34)return K_();else if(X===35)if(a_(q())||k(q(1),q(2))){let G=new jJ("");if(o(q(1),q(2),q(3)))G.type="id";return G.value=t(),G}else return new O(X);else if(X===36)if(q()===61)return L(),new KJ;else return new O(X);else if(X===39)return K_();else if(X===40)return new HJ;else if(X===41)return new Y_;else if(X===42)if(q()===61)return L(),new WJ;else return new O(X);else if(X===43)if(W_())return I(),S();else return new O(X);else if(X===44)return new XJ;else if(X===45)if(W_())return I(),S();else if(q(1)===45&&q(2)===62)return L(2),new e_;else if(QX())return I(),m();else return new O(X);else if(X===46)if(W_())return I(),S();else return new O(X);else if(X===58)return new _J;else if(X===59)return new JJ;else if(X===60)if(q(1)===33&&q(2)===45&&q(3)===45)return L(3),new t_;else return new O(X);else if(X===64)if(o(q(1),q(2),q(3)))return new MJ(t());else return new O(X);else if(X===91)return new YJ;else if(X===92)if(n())return I(),m();else return j(),new O(X);else if(X===93)return new QJ;else if(X===94)if(q()===61)return L(),new UJ;else return new O(X);else if(X===123)return new ZJ;else if(X===124)if(q()===61)return L(),new GJ;else if(q()===124)return L(),new LJ;else return new O(X);else if(X===125)return new $J;else if(X===126)if(q()===61)return L(),new qJ;else return new O(X);else if(A(X))return I(),S();else if(J_(X))return I(),m();else if(H())return new zJ;else return new O(X)},E=function(){while(q(1)===47&&q(2)===42){L(2);while(!0)if(L(),X===42&&q()===47){L();break}else if(H()){j();return}}},S=function(){let G=qX();if(o(q(1),q(2),q(3))){let M=new VJ;return M.value=G.value,M.repr=G.repr,M.type=G.type,M.unit=t(),M}else if(q()===37){L();let M=new IJ;return M.value=G.value,M.repr=G.repr,M}else{let M=new BJ;return M.value=G.value,M.repr=G.repr,M.type=G.type,M}},m=function(){let G=t();if(G.toLowerCase()==="url"&&q()===40){L();while(T(q(1))&&T(q(2)))L();if(q()===34||q()===39)return new p(G);else if(T(q())&&(q(2)===34||q(2)===39))return new p(G);else return a()}else if(q()===40)return L(),new p(G);else return new Q_(G)},K_=function(G){if(G===void 0)G=X;let M="";while(L())if(X===G||H())return new H_(M);else if(u(X))return j(),I(),new o_;else if(X===92)if(H(q()))F();else if(u(q()))L();else M+=D(C());else M+=D(X);throw Error("Internal error")},a=function(){let G=new FJ("");while(T(q()))L();if(H(q()))return G;while(L())if(X===41||H())return G;else if(T(X)){while(T(q()))L();if(q()===41||H(q()))return L(),G;else return L_(),new X_}else if(X===34||X===39||X===40||fX(X))return j(),L_(),new X_;else if(X===92)if(n())G.value+=D(C());else return j(),L_(),new X_;else G.value+=D(X);throw Error("Internal error")},C=function(){if(L(),r_(X)){let G=[X];for(let P=0;P<5;P++)if(r_(q()))L(),G.push(X);else break;if(T(q()))L();let M=parseInt(G.map(function(P){return String.fromCharCode(P)}).join(""),16);if(M>CX)M=65533;return M}else if(H())return 65533;else return X},k=function(G,M){if(G!==92)return!1;if(u(M))return!1;return!0},n=function(){return k(X,q())},o=function(G,M,P){if(G===45)return J_(M)||M===45||k(M,P);else if(J_(G))return!0;else if(G===92)return k(G,M);else return!1},QX=function(){return o(X,q(1),q(2))},HX=function(G,M,P){if(G===43||G===45){if(A(M))return!0;if(M===46&&A(P))return!0;return!1}else if(G===46){if(A(M))return!0;return!1}else if(A(G))return!0;else return!1},W_=function(){return HX(X,q(1),q(2))},t=function(){let G="";while(L())if(a_(X))G+=D(X);else if(n())G+=D(C());else return I(),G;throw Error("Internal parse error")},qX=function(){let G="",M="integer";if(q()===43||q()===45)L(),G+=D(X);while(A(q()))L(),G+=D(X);if(q(1)===46&&A(q(2))){L(),G+=D(X),L(),G+=D(X),M="number";while(A(q()))L(),G+=D(X)}let P=q(1),z_=q(2),UX=q(3);if((P===69||P===101)&&A(z_)){L(),G+=D(X),L(),G+=D(X),M="number";while(A(q()))L(),G+=D(X)}else if((P===69||P===101)&&(z_===43||z_===45)&&A(UX)){L(),G+=D(X),L(),G+=D(X),L(),G+=D(X),M="number";while(A(q()))L(),G+=D(X)}let KX=GX(G);return{type:M,value:KX,repr:G}},GX=function(G){return+G},L_=function(){while(L())if(X===41||H())return;else if(n())C(),F();else F()},N_=0;while(!H(q()))if($.push(w()),N_++,N_>J.length*2)throw Error("I\'m infinite-looping!");return $}class B{tokenType="";value;toJSON(){return{token:this.tokenType}}toString(){return this.tokenType}toSource(){return""+this}}class o_ extends B{tokenType="BADSTRING"}class X_ extends B{tokenType="BADURL"}class $_ extends B{tokenType="WHITESPACE";toString(){return"WS"}toSource(){return" "}}class t_ extends B{tokenType="CDO";toSource(){return"<!--"}}class e_ extends B{tokenType="CDC";toSource(){return"-->"}}class _J extends B{tokenType=":"}class JJ extends B{tokenType=";"}class XJ extends B{tokenType=","}class g extends B{value="";mirror=""}class ZJ extends g{tokenType="{";constructor(){super();this.value="{",this.mirror="}"}}class $J extends g{tokenType="}";constructor(){super();this.value="}",this.mirror="{"}}class YJ extends g{tokenType="[";constructor(){super();this.value="[",this.mirror="]"}}class QJ extends g{tokenType="]";constructor(){super();this.value="]",this.mirror="["}}class HJ extends g{tokenType="(";constructor(){super();this.value="(",this.mirror=")"}}class Y_ extends g{tokenType=")";constructor(){super();this.value=")",this.mirror="("}}class qJ extends B{tokenType="~="}class GJ extends B{tokenType="|="}class UJ extends B{tokenType="^="}class KJ extends B{tokenType="$="}class WJ extends B{tokenType="*="}class LJ extends B{tokenType="||"}class zJ extends B{tokenType="EOF";toSource(){return""}}class O extends B{tokenType="DELIM";value="";constructor(_){super();this.value=D(_)}toString(){return"DELIM("+this.value+")"}toJSON(){let _=this.constructor.prototype.constructor.prototype.toJSON.call(this);return _.value=this.value,_}toSource(){if(this.value==="\\\\")return"\\\\\\n";else return this.value}}class N extends B{value="";ASCIIMatch(_){return this.value.toLowerCase()===_.toLowerCase()}toJSON(){let _=this.constructor.prototype.constructor.prototype.toJSON.call(this);return _.value=this.value,_}}class Q_ extends N{constructor(_){super();this.value=_}tokenType="IDENT";toString(){return"IDENT("+this.value+")"}toSource(){return l(this.value)}}class p extends N{tokenType="FUNCTION";mirror;constructor(_){super();this.value=_,this.mirror=")"}toString(){return"FUNCTION("+this.value+")"}toSource(){return l(this.value)+"("}}class MJ extends N{tokenType="AT-KEYWORD";constructor(_){super();this.value=_}toString(){return"AT("+this.value+")"}toSource(){return"@"+l(this.value)}}class jJ extends N{tokenType="HASH";type;constructor(_){super();this.value=_,this.type="unrestricted"}toString(){return"HASH("+this.value+")"}toJSON(){let _=this.constructor.prototype.constructor.prototype.toJSON.call(this);return _.value=this.value,_.type=this.type,_}toSource(){if(this.type==="id")return"#"+l(this.value);else return"#"+yX(this.value)}}class H_ extends N{tokenType="STRING";constructor(_){super();this.value=_}toString(){return\'"\'+RJ(this.value)+\'"\'}}class FJ extends N{tokenType="URL";constructor(_){super();this.value=_}toString(){return"URL("+this.value+")"}toSource(){return\'url("\'+RJ(this.value)+\'")\'}}class BJ extends B{tokenType="NUMBER";type;repr;constructor(){super();this.type="integer",this.repr=""}toString(){if(this.type==="integer")return"INT("+this.value+")";return"NUMBER("+this.value+")"}toJSON(){let _=super.toJSON();return _.value=this.value,_.type=this.type,_.repr=this.repr,_}toSource(){return this.repr}}class IJ extends B{tokenType="PERCENTAGE";repr;constructor(){super();this.repr=""}toString(){return"PERCENTAGE("+this.value+")"}toJSON(){let _=this.constructor.prototype.constructor.prototype.toJSON.call(this);return _.value=this.value,_.repr=this.repr,_}toSource(){return this.repr+"%"}}class VJ extends B{tokenType="DIMENSION";type;repr;unit;constructor(){super();this.type="integer",this.repr="",this.unit=""}toString(){return"DIM("+this.value+","+this.unit+")"}toJSON(){let _=this.constructor.prototype.constructor.prototype.toJSON.call(this);return _.value=this.value,_.type=this.type,_.repr=this.repr,_.unit=this.unit,_}toSource(){let _=this.repr,J=l(this.unit);if(J[0].toLowerCase()==="e"&&(J[1]==="-"||R(J.charCodeAt(1),48,57)))J="\\\\65 "+J.slice(1,J.length);return _+J}}function l(_){_=""+_;let J="",Z=_.charCodeAt(0);for(let $=0;$<_.length;$++){let X=_.charCodeAt($);if(X===0)throw new Z_("Invalid character: the input contains U+0000.");if(R(X,1,31)||X===127||$===0&&R(X,48,57)||$===1&&R(X,48,57)&&Z===45)J+="\\\\"+X.toString(16)+" ";else if(X>=128||X===45||X===95||R(X,48,57)||R(X,65,90)||R(X,97,122))J+=_[$];else J+="\\\\"+_[$]}return J}function yX(_){_=""+_;let J="";for(let Z=0;Z<_.length;Z++){let $=_.charCodeAt(Z);if($===0)throw new Z_("Invalid character: the input contains U+0000.");if($>=128||$===45||$===95||R($,48,57)||R($,65,90)||R($,97,122))J+=_[Z];else J+="\\\\"+$.toString(16)+" "}return J}function RJ(_){_=""+_;let J="";for(let Z=0;Z<_.length;Z++){let $=_.charCodeAt(Z);if($===0)throw new Z_("Invalid character: the input contains U+0000.");if(R($,1,31)||$===127)J+="\\\\"+$.toString(16)+" ";else if($===34||$===92)J+="\\\\"+_[Z];else J+=_[Z]}return J}function DJ(_){return _.hasAttribute("aria-label")||_.hasAttribute("aria-labelledby")}var OJ="article:not([role]), aside:not([role]), main:not([role]), nav:not([role]), section:not([role]), [role=article], [role=complementary], [role=main], [role=navigation], [role=region]",TX=[["aria-atomic",void 0],["aria-busy",void 0],["aria-controls",void 0],["aria-current",void 0],["aria-describedby",void 0],["aria-details",void 0],["aria-dropeffect",void 0],["aria-flowto",void 0],["aria-grabbed",void 0],["aria-hidden",void 0],["aria-keyshortcuts",void 0],["aria-label",["caption","code","deletion","emphasis","generic","insertion","paragraph","presentation","strong","subscript","superscript"]],["aria-labelledby",["caption","code","deletion","emphasis","generic","insertion","paragraph","presentation","strong","subscript","superscript"]],["aria-live",void 0],["aria-owns",void 0],["aria-relevant",void 0],["aria-roledescription",["generic"]]];function fJ(_,J){return TX.some(([Z,$])=>{return!$?.includes(J||"")&&_.hasAttribute(Z)})}function CJ(_){return!Number.isNaN(Number(String(_.getAttribute("tabindex"))))}function xX(_){return!mJ(_)&&(vX(_)||CJ(_))}function vX(_){let J=V(_);if(["BUTTON","DETAILS","SELECT","TEXTAREA"].includes(J))return!0;if(J==="A"||J==="AREA")return _.hasAttribute("href");if(J==="INPUT")return!_.hidden;return!1}var gX={A:(_)=>{return _.hasAttribute("href")?"link":null},AREA:(_)=>{return _.hasAttribute("href")?"link":null},ARTICLE:()=>"article",ASIDE:()=>"complementary",BLOCKQUOTE:()=>"blockquote",BUTTON:()=>"button",CAPTION:()=>"caption",CODE:()=>"code",DATALIST:()=>"listbox",DD:()=>"definition",DEL:()=>"deletion",DETAILS:()=>"group",DFN:()=>"term",DIALOG:()=>"dialog",DT:()=>"term",EM:()=>"emphasis",FIELDSET:()=>"group",FIGURE:()=>"figure",FOOTER:(_)=>s(_,OJ)?null:"contentinfo",FORM:(_)=>DJ(_)?"form":null,H1:()=>"heading",H2:()=>"heading",H3:()=>"heading",H4:()=>"heading",H5:()=>"heading",H6:()=>"heading",HEADER:(_)=>s(_,OJ)?null:"banner",HR:()=>"separator",HTML:()=>"document",IMG:(_)=>_.getAttribute("alt")===""&&!_.getAttribute("title")&&!fJ(_)&&!CJ(_)?"presentation":"img",INPUT:(_)=>{let J=_.type.toLowerCase();if(J==="search")return _.hasAttribute("list")?"combobox":"searchbox";if(["email","tel","text","url",""].includes(J)){let Z=G_(_,_.getAttribute("list"))[0];return Z&&V(Z)==="DATALIST"?"combobox":"textbox"}if(J==="hidden")return null;if(J==="file")return"button";return lX[J]||"textbox"},INS:()=>"insertion",LI:()=>"listitem",MAIN:()=>"main",MARK:()=>"mark",MATH:()=>"math",MENU:()=>"list",METER:()=>"meter",NAV:()=>"navigation",OL:()=>"list",OPTGROUP:()=>"group",OPTION:()=>"option",OUTPUT:()=>"status",P:()=>"paragraph",PROGRESS:()=>"progressbar",SEARCH:()=>"search",SECTION:(_)=>DJ(_)?"region":null,SELECT:(_)=>_.hasAttribute("multiple")||_.size>1?"listbox":"combobox",STRONG:()=>"strong",SUB:()=>"subscript",SUP:()=>"superscript",SVG:()=>"img",TABLE:()=>"table",TBODY:()=>"rowgroup",TD:(_)=>{let J=s(_,"table"),Z=J?O_(J):"";return Z==="grid"||Z==="treegrid"?"gridcell":"cell"},TEXTAREA:()=>"textbox",TFOOT:()=>"rowgroup",TH:(_)=>{let J=_.getAttribute("scope");if(J==="col"||J==="colgroup")return"columnheader";if(J==="row"||J==="rowgroup")return"rowheader";let{nextElementSibling:Z,previousElementSibling:$}=_,X=!!_.parentElement&&V(_.parentElement)==="TR"?_.parentElement:void 0;if(!Z&&!$){if(X){let Q=s(X,"table");if(Q&&Q.rows.length<=1)return null}return"columnheader"}if(wJ(Z)&&wJ($))return"columnheader";if(AJ(Z)||AJ($))return"rowheader";return"columnheader"},THEAD:()=>"rowgroup",TIME:()=>"time",TR:()=>"row",UL:()=>"list"};function wJ(_){return!!_&&V(_)==="TH"}function AJ(_){if(!_||V(_)!=="TD")return!1;return!!(_.textContent?.trim()||_.children.length>0)}var NX={DD:["DL","DIV"],DIV:["DL"],DT:["DL","DIV"],LI:["OL","UL"],TBODY:["TABLE"],TD:["TR"],TFOOT:["TABLE"],TH:["TR"],THEAD:["TABLE"],TR:["THEAD","TBODY","TFOOT","TABLE"]};function EJ(_){let J=gX[V(_)]?.(_)||"";if(!J)return null;let Z=_;while(Z){let $=h(Z),X=NX[V(Z)];if(!X||!$||!X.includes(V($)))break;let Q=O_($);if((Q==="none"||Q==="presentation")&&!bJ($,Q))return Q;Z=$}return J}var kX=["alert","alertdialog","application","article","banner","blockquote","button","caption","cell","checkbox","code","columnheader","combobox","complementary","contentinfo","definition","deletion","dialog","directory","document","emphasis","feed","figure","form","generic","grid","gridcell","group","heading","img","insertion","link","list","listbox","listitem","log","main","mark","marquee","math","meter","menu","menubar","menuitem","menuitemcheckbox","menuitemradio","navigation","none","note","option","paragraph","presentation","progressbar","radio","radiogroup","region","row","rowgroup","rowheader","scrollbar","search","searchbox","separator","slider","spinbutton","status","strong","subscript","superscript","switch","tab","table","tablist","tabpanel","term","textbox","time","timer","toolbar","tooltip","tree","treegrid","treeitem"];function O_(_){return(_.getAttribute("role")||"").split(" ").map((Z)=>Z.trim()).find((Z)=>kX.includes(Z))||null}function bJ(_,J){return fJ(_,J)||xX(_)}function f(_){let J=O_(_);if(!J)return EJ(_);if(J==="none"||J==="presentation"){let Z=EJ(_);if(bJ(_,Z))return Z}return J}function yJ(_){return _===null?void 0:_.toLowerCase()==="true"}function SJ(_){return["STYLE","SCRIPT","NOSCRIPT","TEMPLATE"].includes(V(_))}function y(_){if(SJ(_))return!0;let J=b(_),Z=_.nodeName==="SLOT";if(J?.display==="contents"&&!Z){for(let X=_.firstChild;X;X=X.nextSibling){if(X.nodeType===1&&!y(X))return!1;if(X.nodeType===3&&I_(X))return!1}return!0}if(!(_.nodeName==="OPTION"&&!!_.closest("select"))&&!Z&&!B_(_,J))return!0;return TJ(_)}function TJ(_){let J=q_?.get(_);if(J===void 0){if(J=!1,_.parentElement&&_.parentElement.shadowRoot&&!_.assignedSlot)J=!0;if(!J){let Z=b(_);J=!Z||Z.display==="none"||yJ(_.getAttribute("aria-hidden"))===!0}if(!J){let Z=h(_);if(Z)J=TJ(Z)}q_?.set(_,J)}return J}function G_(_,J){if(!J)return[];let Z=d_(_);if(!Z)return[];try{let $=J.split(" ").filter((Q)=>!!Q),X=[];for(let Q of $){let U=Z.querySelector("#"+CSS.escape(Q));if(U&&!X.includes(U))X.push(U)}return X}catch($){return[]}}function x(_){return _.trim()}function hX(_){return _.split("\xA0").map((J)=>J.replace(/\\r\\n/g,`\n`).replace(/[\\u200b\\u00ad]/g,"").replace(/\\s\\s*/g," ")).join("\xA0").trim()}function PJ(_,J){let Z=[..._.querySelectorAll(J)];for(let $ of G_(_,_.getAttribute("aria-owns"))){if($.matches(J))Z.push($);Z.push(...$.querySelectorAll(J))}return Z}function c(_,J){let Z=J==="::before"?T_:J==="::after"?x_:S_;if(Z?.has(_))return Z?.get(_);let $=b(_,J),X;if($){let Q=$.content;if(Q&&Q!=="none"&&Q!=="normal"){if($.display!=="none"&&$.visibility!=="hidden")X=uX(_,Q,!!J)}}if(J&&X!==void 0){if(($?.display||"inline")!=="inline")X=" "+X+" "}if(Z)Z.set(_,X);return X}function uX(_,J,Z){if(!J||J==="none"||J==="normal")return;try{let $=n_(J).filter((W)=>!(W instanceof $_)),X=$.findIndex((W)=>W instanceof O&&W.value==="/");if(X!==-1)$=$.slice(X+1);else if(!Z)return;let Q=[],U=0;while(U<$.length)if($[U]instanceof H_)Q.push($[U].value),U++;else if(U+2<$.length&&$[U]instanceof p&&$[U].value==="attr"&&$[U+1]instanceof Q_&&$[U+2]instanceof Y_){let W=$[U+1].value;Q.push(_.getAttribute(W)||""),U+=3}else return;return Q.join("")}catch{}}function pX(_){let J=_.getAttribute("aria-labelledby");if(J===null)return null;let Z=G_(_,J);return Z.length?Z:null}function cX(_,J){let Z=["button","cell","checkbox","columnheader","gridcell","heading","link","menuitem","menuitemcheckbox","menuitemradio","option","radio","row","rowheader","switch","tab","tooltip","treeitem"].includes(_),$=J&&["","caption","code","contentinfo","definition","deletion","emphasis","insertion","list","listitem","mark","none","paragraph","presentation","region","row","rowgroup","section","strong","subscript","superscript","table","term","time"].includes(_);return Z||$}function xJ(_,J){let Z=J?y_:b_,$=Z?.get(_);if($===void 0){if($="",!["caption","code","definition","deletion","emphasis","generic","insertion","mark","paragraph","presentation","strong","subscript","suggestion","superscript","term","time"].includes(f(_)||""))$=hX(v(_,{includeHidden:J,visitedElements:new Set,embeddedInTargetElement:"self"}));Z?.set(_,$)}return $}var vJ=["application","checkbox","columnheader","combobox","gridcell","listbox","radiogroup","rowheader","searchbox","slider","spinbutton","switch","textbox","tree"];function gJ(_){let J=_.getAttribute("aria-invalid");if(!J||J.trim()===""||J.toLocaleLowerCase()==="false")return"false";if(J==="true"||J==="grammar"||J==="spelling")return J;return"true"}function v(_,J){if(J.visitedElements.has(_))return"";let Z={...J,embeddedInTargetElement:J.embeddedInTargetElement==="self"?"descendant":J.embeddedInTargetElement};if(!J.includeHidden){let Y=!!J.embeddedInLabelledBy?.hidden||!!J.embeddedInDescribedBy?.hidden||!!J.embeddedInNativeTextAlternative?.hidden||!!J.embeddedInLabel?.hidden;if(SJ(_)||!Y&&y(_))return J.visitedElements.add(_),""}let $=pX(_);if(!J.embeddedInLabelledBy){let Y=($||[]).map((K)=>v(K,{...J,embeddedInLabelledBy:{element:K,hidden:y(K)},embeddedInDescribedBy:void 0,embeddedInTargetElement:void 0,embeddedInLabel:void 0,embeddedInNativeTextAlternative:void 0})).join(" ");if(Y)return Y}let X=f(_)||"",Q=V(_);if(!!J.embeddedInLabel||!!J.embeddedInLabelledBy||J.embeddedInTargetElement==="descendant"){let Y=[..._.labels||[]].includes(_),K=($||[]).includes(_);if(!Y&&!K){if(X==="textbox"){if(J.visitedElements.add(_),Q==="INPUT"||Q==="TEXTAREA")return _.value;return _.textContent||""}if(["combobox","listbox"].includes(X)){J.visitedElements.add(_);let z;if(Q==="SELECT"){if(z=[..._.selectedOptions],!z.length&&_.options.length)z.push(_.options[0])}else{let q=X==="combobox"?PJ(_,"*").find((L)=>f(L)==="listbox"):_;z=q?PJ(q,\'[aria-selected="true"]\').filter((L)=>f(L)==="option"):[]}if(!z.length&&Q==="INPUT")return _.value;return z.map((q)=>v(q,Z)).join(" ")}if(["progressbar","scrollbar","slider","spinbutton","meter"].includes(X)){if(J.visitedElements.add(_),_.hasAttribute("aria-valuetext"))return _.getAttribute("aria-valuetext")||"";if(_.hasAttribute("aria-valuenow"))return _.getAttribute("aria-valuenow")||"";return _.getAttribute("value")||""}if(["menu"].includes(X))return J.visitedElements.add(_),""}}let U=_.getAttribute("aria-label")||"";if(x(U))return J.visitedElements.add(_),U;if(!["presentation","none"].includes(X)){if(Q==="INPUT"&&["button","submit","reset"].includes(_.type)){J.visitedElements.add(_);let Y=_.value||"";if(x(Y))return Y;if(_.type==="submit")return"Submit";if(_.type==="reset")return"Reset";return _.getAttribute("title")||""}if(Q==="INPUT"&&_.type==="file"){J.visitedElements.add(_);let Y=_.labels||[];if(Y.length&&!J.embeddedInLabelledBy)return r(Y,J);return"Choose File"}if(Q==="INPUT"&&_.type==="image"){J.visitedElements.add(_);let Y=_.labels||[];if(Y.length&&!J.embeddedInLabelledBy)return r(Y,J);let K=_.getAttribute("alt")||"";if(x(K))return K;let z=_.getAttribute("title")||"";if(x(z))return z;return"Submit"}if(!$&&Q==="BUTTON"){J.visitedElements.add(_);let Y=_.labels||[];if(Y.length)return r(Y,J)}if(!$&&Q==="OUTPUT"){J.visitedElements.add(_);let Y=_.labels||[];if(Y.length)return r(Y,J);return _.getAttribute("title")||""}if(!$&&(Q==="TEXTAREA"||Q==="SELECT"||Q==="INPUT")){J.visitedElements.add(_);let Y=_.labels||[];if(Y.length)return r(Y,J);let K=Q==="INPUT"&&["text","password","search","tel","email","url"].includes(_.type)||Q==="TEXTAREA",z=_.getAttribute("placeholder")||"",q=_.getAttribute("title")||"";if(!K||q)return q;return z}if(!$&&Q==="FIELDSET"){J.visitedElements.add(_);for(let K=_.firstElementChild;K;K=K.nextElementSibling)if(V(K)==="LEGEND")return v(K,{...Z,embeddedInNativeTextAlternative:{element:K,hidden:y(K)}});return _.getAttribute("title")||""}if(!$&&Q==="FIGURE"){J.visitedElements.add(_);for(let K=_.firstElementChild;K;K=K.nextElementSibling)if(V(K)==="FIGCAPTION")return v(K,{...Z,embeddedInNativeTextAlternative:{element:K,hidden:y(K)}});return _.getAttribute("title")||""}if(Q==="IMG"){J.visitedElements.add(_);let Y=_.getAttribute("alt")||"";if(x(Y))return Y;return _.getAttribute("title")||""}if(Q==="TABLE"){J.visitedElements.add(_);for(let K=_.firstElementChild;K;K=K.nextElementSibling)if(V(K)==="CAPTION")return v(K,{...Z,embeddedInNativeTextAlternative:{element:K,hidden:y(K)}});let Y=_.getAttribute("summary")||"";if(Y)return Y}if(Q==="AREA"){J.visitedElements.add(_);let Y=_.getAttribute("alt")||"";if(x(Y))return Y;return _.getAttribute("title")||""}if(Q==="SVG"||_.ownerSVGElement){J.visitedElements.add(_);for(let Y=_.firstElementChild;Y;Y=Y.nextElementSibling)if(V(Y)==="TITLE"&&Y.ownerSVGElement)return v(Y,{...Z,embeddedInLabelledBy:{element:Y,hidden:y(Y)}})}if(_.ownerSVGElement&&Q==="A"){let Y=_.getAttribute("xlink:title")||"";if(x(Y))return J.visitedElements.add(_),Y}}let W=Q==="SUMMARY"&&!["presentation","none"].includes(X);if(cX(X,J.embeddedInTargetElement==="descendant")||W||!!J.embeddedInLabelledBy||!!J.embeddedInDescribedBy||!!J.embeddedInLabel||!!J.embeddedInNativeTextAlternative){J.visitedElements.add(_);let Y=mX(_,Z);if(J.embeddedInTargetElement==="self"?x(Y):Y)return Y}if(!["presentation","none"].includes(X)||Q==="IFRAME"){J.visitedElements.add(_);let Y=_.getAttribute("title")||"";if(x(Y))return Y}return J.visitedElements.add(_),""}function mX(_,J){let Z=[],$=(Q,U)=>{if(U&&Q.assignedSlot)return;if(Q.nodeType===1){let W=b(Q)?.display||"inline",Y=v(Q,J);if(W!=="inline"||Q.nodeName==="BR")Y=" "+Y+" ";Z.push(Y)}else if(Q.nodeType===3)Z.push(Q.textContent||"")};Z.push(c(_,"::before")||"");let X=c(_);if(X!==void 0)Z.push(X);else{let Q=_.nodeName==="SLOT"?_.assignedNodes():[];if(Q.length)for(let U of Q)$(U,!1);else{for(let U=_.firstChild;U;U=U.nextSibling)$(U,!0);if(_.shadowRoot)for(let U=_.shadowRoot.firstChild;U;U=U.nextSibling)$(U,!0);for(let U of G_(_,_.getAttribute("aria-owns")))$(U,!0)}}return Z.push(c(_,"::after")||""),Z.join("")}var w_=["gridcell","option","row","tab","rowheader","columnheader","treeitem"];function NJ(_){if(V(_)==="OPTION")return _.selected;if(w_.includes(f(_)||""))return yJ(_.getAttribute("aria-selected"))===!0;return!1}var A_=["checkbox","menuitemcheckbox","option","radio","switch","menuitemradio","treeitem"];function kJ(_){let J=dX(_,!0);return J==="error"?!1:J}function dX(_,J){let Z=V(_);if(J&&Z==="INPUT"&&_.indeterminate)return"mixed";if(Z==="INPUT"&&["checkbox","radio"].includes(_.type))return _.checked;if(A_.includes(f(_)||"")){let $=_.getAttribute("aria-checked");if($==="true")return!0;if(J&&$==="mixed")return"mixed";return!1}return"error"}var E_=["button"];function hJ(_){if(E_.includes(f(_)||"")){let J=_.getAttribute("aria-pressed");if(J==="true")return!0;if(J==="mixed")return"mixed"}return!1}var P_=["application","button","checkbox","combobox","gridcell","link","listbox","menuitem","row","rowheader","tab","treeitem","columnheader","menuitemcheckbox","menuitemradio","rowheader","switch"];function uJ(_){if(V(_)==="DETAILS")return _.open;if(P_.includes(f(_)||"")){let J=_.getAttribute("aria-expanded");if(J===null)return;if(J==="true")return!0;return!1}return}var f_=["heading","listitem","row","treeitem"];function pJ(_){let J={H1:1,H2:2,H3:3,H4:4,H5:5,H6:6}[V(_)];if(J)return J;if(f_.includes(f(_)||"")){let Z=_.getAttribute("aria-level"),$=Z===null?Number.NaN:Number(Z);if(Number.isInteger($)&&$>=1)return $}return 0}var C_=["application","button","composite","gridcell","group","input","link","menuitem","scrollbar","separator","tab","checkbox","columnheader","combobox","grid","listbox","menu","menubar","menuitemcheckbox","menuitemradio","option","radio","radiogroup","row","rowheader","searchbox","select","slider","spinbutton","switch","tablist","textbox","toolbar","tree","treegrid","treeitem"];function cJ(_){return mJ(_)||dJ(_)}function mJ(_){return["BUTTON","INPUT","SELECT","TEXTAREA","OPTION","OPTGROUP"].includes(V(_))&&(_.hasAttribute("disabled")||sX(_)||iX(_))}function sX(_){return V(_)==="OPTION"&&!!_.closest("OPTGROUP[DISABLED]")}function iX(_){let J=_?.closest("FIELDSET[DISABLED]");if(!J)return!1;let Z=J.querySelector(":scope > LEGEND");return!Z||!Z.contains(_)}function dJ(_,J=!1){if(!_)return!1;if(J||C_.includes(f(_)||"")){let Z=(_.getAttribute("aria-disabled")||"").toLowerCase();if(Z==="true")return!0;if(Z==="false")return!1;return dJ(h(_),!0)}return!1}function r(_,J){return[..._].map((Z)=>v(Z,{...J,embeddedInLabel:{element:Z,hidden:y(Z)},embeddedInNativeTextAlternative:void 0,embeddedInLabelledBy:void 0,embeddedInDescribedBy:void 0,embeddedInTargetElement:void 0})).filter((Z)=>!!Z).join(" ")}function sJ(_){let J=v_,Z=_,$,X=[];for(;Z;Z=h(Z)){let Q=J.get(Z);if(Q!==void 0){$=Q;break}X.push(Z);let U=b(Z);if(!U){$=!0;break}let W=U.pointerEvents;if(W){$=W!=="none";break}}if($===void 0)$=!0;for(let Q of X)J.set(Q,$);return $}var b_,y_,iJ,lJ,rJ,q_,S_,T_,x_,v_,aJ=0;function nJ(){i_(),++aJ,b_??=new Map,y_??=new Map,iJ??=new Map,lJ??=new Map,rJ??=new Map,q_??=new Map,S_??=new Map,T_??=new Map,x_??=new Map,v_??=new Map}function oJ(){if(!--aJ)b_=void 0,y_=void 0,iJ=void 0,lJ=void 0,rJ=void 0,q_=void 0,S_=void 0,T_=void 0,x_=void 0,v_=void 0;l_()}var lX={button:"button",checkbox:"checkbox",image:"button",number:"spinbutton",radio:"radio",range:"slider",reset:"button",submit:"button"};var aX=0;function eJ(_){let J=_.boxes;if(_.mode==="ai")return{visibility:"ariaOrVisible",refs:"interactable",refPrefix:_.refPrefix,includeGenericRole:!0,renderActive:!_.doNotRenderActive,renderCursorPointer:!0,renderBoxes:J};if(_.mode==="autoexpect")return{visibility:"ariaAndVisible",refs:"none",renderBoxes:J};if(_.mode==="codegen")return{visibility:"aria",refs:"none",renderStringsAsRegex:!0,renderBoxes:J};return{visibility:"aria",refs:"none",renderBoxes:J}}function _X(_,J){let Z=eJ(J),$=new Set,X={root:{role:"fragment",name:"",children:[],props:{},box:i(_),receivesPointerEvents:!0},elements:new Map,refs:new Map,iframeRefs:[]};g_(X.root,_);let Q=(W,Y,K)=>{if($.has(Y))return;if($.add(Y),Y.nodeType===Node.TEXT_NODE&&Y.nodeValue){if(!K)return;let F=Y.nodeValue;if(W.role!=="textbox"&&F)W.children.push(Y.nodeValue||"");return}if(Y.nodeType!==Node.ELEMENT_NODE)return;let z=Y,q=!y(z),L=q;if(Z.visibility==="ariaOrVisible")L=q||__(z);if(Z.visibility==="ariaAndVisible")L=q&&__(z);if(Z.visibility==="aria"&&!L)return;let I=[];if(z.hasAttribute("aria-owns")){let F=z.getAttribute("aria-owns").split(/\\s+/);for(let j of F){let w=_.ownerDocument.getElementById(j);if(w)I.push(w)}}let H=L?nX(z,Z):null;if(H){if(H.ref){if(X.elements.set(H.ref,z),X.refs.set(z,H.ref),H.role==="iframe")X.iframeRefs.push(H.ref)}W.children.push(H)}U(H||W,z,I,L)};function U(W,Y,K,z){let L=(b(Y)?.display||"inline")!=="inline"||Y.nodeName==="BR"?" ":"";if(L)W.children.push(L);W.children.push(c(Y,"::before")||"");let I=Y.nodeName==="SLOT"?Y.assignedNodes():[];if(I.length)for(let H of I)Q(W,H,z);else{for(let H=Y.firstChild;H;H=H.nextSibling)if(!H.assignedSlot)Q(W,H,z);if(Y.shadowRoot)for(let H=Y.shadowRoot.firstChild;H;H=H.nextSibling)Q(W,H,z)}for(let H of K)Q(W,H,z);if(W.children.push(c(Y,"::after")||""),L)W.children.push(L);if(W.children.length===1&&W.name===W.children[0])W.children=[];if(W.role==="link"&&Y.hasAttribute("href")){let H=Y.getAttribute("href");W.props.url=H}if(W.role==="textbox"&&Y.hasAttribute("placeholder")&&Y.getAttribute("placeholder")!==W.name){let H=Y.getAttribute("placeholder");W.props.placeholder=H}}nJ();try{Q(X.root,_,!0)}finally{oJ()}return tX(X.root),oX(X.root),X}function tJ(_,J){if(J.refs==="none")return;if(J.refs==="interactable"&&(!_.box.visible||!_.receivesPointerEvents))return;let Z=$X(_),$=Z._ariaRef;if(!$||$.role!==_.role||$.name!==_.name)$={role:_.role,name:_.name,ref:(J.refPrefix??"")+"e"+ ++aX},Z._ariaRef=$;_.ref=$.ref}function nX(_,J){let Z=_.ownerDocument.activeElement===_;if(_.nodeName==="IFRAME"){let K={role:"iframe",name:"",children:[],props:{},box:i(_),receivesPointerEvents:!0,active:Z};return g_(K,_),tJ(K,J),K}let $=J.includeGenericRole?"generic":null,X=f(_)??$;if(!X||X==="presentation"||X==="none")return null;let Q=j_(xJ(_,!1)||""),U=sJ(_),W=i(_);if(X==="generic"&&W.inline&&_.childNodes.length===1&&_.childNodes[0].nodeType===Node.TEXT_NODE)return null;let Y={role:X,name:Q,children:[],props:{},box:W,receivesPointerEvents:U,active:Z};if(g_(Y,_),tJ(Y,J),A_.includes(X))Y.checked=kJ(_);if(C_.includes(X))Y.disabled=cJ(_);if(P_.includes(X))Y.expanded=uJ(_);if(vJ.includes(X)){let K=gJ(_);Y.invalid=K==="false"?!1:K==="true"?!0:K}if(f_.includes(X))Y.level=pJ(_);if(E_.includes(X))Y.pressed=hJ(_);if(w_.includes(X))Y.selected=NJ(_);if(_ instanceof HTMLInputElement||_ instanceof HTMLTextAreaElement){if(_.type!=="checkbox"&&_.type!=="radio"&&_.type!=="file")Y.children=[_.value]}return Y}function oX(_){let J=(Z)=>{let $=[];for(let Q of Z.children||[]){if(typeof Q==="string"){$.push(Q);continue}let U=J(Q);$.push(...U)}if(Z.role==="generic"&&!Z.name&&$.length<=1&&$.every((Q)=>typeof Q!=="string"&&!!Q.ref))return $;return Z.children=$,[Z]};J(_)}function tX(_){let J=($,X)=>{if(!$.length)return;let Q=j_($.join(""));if(Q)X.push(Q);$.length=0},Z=($)=>{let X=[],Q=[];for(let U of $.children||[])if(typeof U==="string")Q.push(U);else J(Q,X),Z(U),X.push(U);if(J(Q,X),$.children=X.length?X:[],$.children.length===1&&$.children[0]===$.name)$.children=[]};Z(_)}var jZ=Symbol("cachedRegex");function JX(_,J=new Map){if(_?.ref)J.set(_.ref,_);for(let Z of _?.children||[])if(typeof Z!=="string")JX(Z,J);return J}function eX(_,J){let Z=JX(J?.root),$=new Map,X=(Q,U)=>{let W=Q.children.length===U?.children.length&&h_(Q,U),Y=W;for(let K=0;K<Q.children.length;K++){let z=Q.children[K],q=U?.children[K];if(typeof z==="string")W&&=z===q,Y&&=z===q;else{let L=typeof q!=="string"?q:void 0;if(z.ref)L=Z.get(z.ref);let I=X(z,L);if(!L||!I&&!z.ref||L!==q)Y=!1;W&&=I&&L===q}}return $.set(Q,W?"same":Y?"skip":"changed"),W};return X(_.root,Z.get(J?.root?.ref)),$}function _Z(_,J){let Z=[],$=(X)=>{let Q=J.get(X);if(Q==="same");else if(Q==="skip"){for(let U of X.children)if(typeof U!=="string")$(U)}else Z.push(X)};for(let X of _)if(typeof X==="string")Z.push(X);else $(X);return Z}function U_(_){return"  ".repeat(_)}function XX(_,J,Z){let $=eJ(J),X=[],Q={},U=$.renderStringsAsRegex?XZ:()=>!0,W=$.renderStringsAsRegex?JZ:(H)=>H,Y=_.root.role==="fragment"?_.root.children:[_.root],K=eX(_,Z);if(Z)Y=_Z(Y,K);let z=(H,F)=>{if(J.depth&&F>J.depth)return;let j=e(W(H));if(j)X.push(U_(F)+"- text: "+j)},q=(H,F)=>{let j=H.role;if(H.name&&H.name.length<=900){let w=W(H.name);if(w){let E=w.startsWith("/")&&w.endsWith("/")?w:JSON.stringify(w);j+=" "+E}}if(H.checked==="mixed")j+=" [checked=mixed]";if(H.checked===!0)j+=" [checked]";if(H.disabled)j+=" [disabled]";if(H.expanded)j+=" [expanded]";if(H.active&&$.renderActive)j+=" [active]";if(H.invalid==="grammar"||H.invalid==="spelling")j+=` [invalid=${H.invalid}]`;if(H.invalid===!0)j+=" [invalid]";if(H.level)j+=` [level=${H.level}]`;if(H.pressed==="mixed")j+=" [pressed=mixed]";if(H.pressed===!0)j+=" [pressed]";if(H.selected===!0)j+=" [selected]";if(H.ref){if(j+=` [ref=${H.ref}]`,F&&d(H))j+=" [cursor=pointer]"}if($.renderBoxes){let w=$X(H);if(w){let E=w.getBoundingClientRect();j+=` [box=${Math.round(E.x)},${Math.round(E.y)},${Math.round(E.width)},${Math.round(E.height)}]`}}return j},L=(H)=>{return H?.children.length===1&&typeof H.children[0]==="string"&&!Object.keys(H.props).length?H.children[0]:void 0},I=(H,F,j)=>{if(J.depth&&F>J.depth)return;if(H.role==="iframe"&&H.ref)Q[H.ref]=F;if(K.get(H)==="same"&&H.ref){X.push(U_(F)+`- ref=${H.ref} [unchanged]`);return}let w=!!Z&&!F,E=U_(F)+"- "+(w?"<changed> ":"")+c_(q(H,j)),S=L(H),m=!!J.depth&&F===J.depth;if(!S&&(!H.children.length||m)&&!Object.keys(H.props).length)X.push(E);else if(S!==void 0)if(U(H,S))X.push(E+": "+e(W(S)));else X.push(E);else{X.push(E+":");for(let[C,k]of Object.entries(H.props))X.push(U_(F+1)+"- /"+C+": "+e(k));let a=!!H.ref&&j&&d(H);for(let C of H.children)if(typeof C==="string")z(U(H,C)?C:"",F+1);else I(C,F+1,j&&!a)}};for(let H of Y)if(typeof H==="string")z(H,0);else I(H,0,!!$.renderCursorPointer);return{text:X.join(`\n`),iframeDepths:Q}}function JZ(_){let J=[{regex:/\\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\b/,replacement:"[0-9a-fA-F-]+"},{regex:/\\b[\\d,.]+[bkmBKM]+\\b/,replacement:"[\\\\d,.]+[bkmBKM]+"},{regex:/\\b\\d+[hmsp]+\\b/,replacement:"\\\\d+[hmsp]+"},{regex:/\\b[\\d,.]+[hmsp]+\\b/,replacement:"[\\\\d,.]+[hmsp]+"},{regex:/\\b\\d+,\\d+\\b/,replacement:"\\\\d+,\\\\d+"},{regex:/\\b\\d+\\.\\d{2,}\\b/,replacement:"\\\\d+\\\\.\\\\d+"},{regex:/\\b\\d{2,}\\.\\d+\\b/,replacement:"\\\\d+\\\\.\\\\d+"},{regex:/\\b\\d{2,}\\b/,replacement:"\\\\d+"}],Z="",$=0,X=new RegExp(J.map((Q)=>"("+Q.regex.source+")").join("|"),"g");if(_.replace(X,(Q,...U)=>{let W=U[U.length-2],Y=U.slice(0,-2);Z+=F_(_.slice($,W));for(let K=0;K<Y.length;K++)if(Y[K]){let{replacement:z}=J[K];Z+=z;break}return $=W+Q.length,Q}),!Z)return _;return Z+=F_(_.slice($)),String(new RegExp(Z))}function XZ(_,J){if(!J.length)return!1;if(!_.name)return!0;let Z=J.length<=200&&_.name.length<=200?p_(J,_.name):"",$=J;while(Z&&$.includes(Z))$=$.replace(Z,"");return $.trim().length/J.length>0.1}var ZX=Symbol("element");function $X(_){return _[ZX]}function g_(_,J){_[ZX]=J}function YX(_){let J=(Z)=>{for(let $ of Array.from(Z.querySelectorAll("*"))){_($);let X=$.shadowRoot;if(X)J(X)}};J(document)}function ZZ(_,J={}){YX((Q)=>{if(Q._ariaRef)delete Q._ariaRef});let Z=_??document.body??document.documentElement,$={mode:"ai",depth:J.depth,boxes:J.boxes},X=_X(Z,$);return XX(X,$).text}function $Z(_){let J=null;return YX((Z)=>{if(!J&&Z._ariaRef?.ref===_)J=Z}),J}\n';

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/aria-snapshot.ts
function buildEvaluator(params, call) {
  return new Function(
    ...params.split(",").map((p) => p.trim()),
    `var module = { exports: {} };
${aria_snapshot_bundle_default}
return module.exports.${call};`
  );
}
var evaluateAriaSnapshot;
var evaluateResolveRef;
async function captureAriaSnapshot(page, root, options = {}) {
  const request = { depth: options.depth, boxes: options.boxes };
  evaluateAriaSnapshot ??= buildEvaluator("root, request", "ariaSnapshot(root, request)");
  return await page.evaluate(evaluateAriaSnapshot, root, request);
}
async function resolveAriaRefHandle(page, ref) {
  evaluateResolveRef ??= buildEvaluator("ref", "resolveAriaRef(ref)");
  const handle = await page.evaluateHandle(evaluateResolveRef, ref);
  const element = handle.asElement();
  if (!element) {
    await handle.dispose().catch(() => void 0);
    return null;
  }
  return element;
}
function buildAriaSnapshotScript(selector, options = {}) {
  const request = { depth: options.depth, boxes: options.boxes };
  const sel = selector ? JSON.stringify(selector) : "null";
  return `(function(){var module={exports:{}};
${aria_snapshot_bundle_default}
var __sel=${sel};var __root=__sel?document.querySelector(__sel):null;if(__sel&&!__root)throw new Error("tab.ariaSnapshot: selector "+__sel+" matched no element");return module.exports.ariaSnapshot(__root,${JSON.stringify(request)});})()`;
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/markdown.ts
async function createTurndown() {
  const { default: Turndown, gfm: gfm2 } = await Promise.resolve().then(() => (init_turndown(), turndown_exports));
  const turndown = new Turndown({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-"
  });
  turndown.use(gfm2);
  turndown.addRule("strikethrough", {
    filter: ["del", "s", "strike"],
    replacement(content) {
      return `~~${content}~~`;
    }
  });
  turndown.addRule("heading", {
    filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
    replacement(content, node) {
      const level = Number(node.nodeName.charAt(1));
      const prefix = "#".repeat(level);
      const cleaned = content.replace(/\\([.])/g, "$1").trim();
      return `

${prefix} ${cleaned}

`;
    }
  });
  turndown.addRule("listItem", {
    filter: "li",
    replacement(content, node, options) {
      const body = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, "\n  ");
      const parent = node.parentNode;
      let prefix = `${options.bulletListMarker} `;
      if (parent?.nodeName === "OL") {
        const start = parent.getAttribute("start");
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${(start ? Number(start) : 1) + index}. `;
      }
      return prefix + body + (node.nextSibling ? "\n" : "");
    }
  });
  return turndown;
}
var turndownPromise;
async function htmlToBasicMarkdown(html) {
  const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  turndownPromise ||= createTurndown();
  return (await turndownPromise).turndown(cleaned).trim();
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/extract/readable.ts
function normalize(text2) {
  const trimmed = text2?.trim();
  return trimmed || void 0;
}
async function extractReadableFromHtml(html, url, format) {
  const [{ parseHTML: parseHTML2 }, { Readability: Readability2 }] = await Promise.all([Promise.resolve().then(() => (init_dom(), dom_exports)), Promise.resolve().then(() => (init_readability(), readability_exports))]);
  const { document: document2 } = parseHTML2(html);
  const article = new Readability2(document2).parse();
  if (article) {
    const result = await toReadableResult(url, format, article.textContent, article.content, {
      title: article.title,
      byline: article.byline,
      excerpt: article.excerpt,
      length: article.length
    });
    if (result) return result;
  }
  const candidates = [
    document2.querySelector("[data-pagefind-body]"),
    document2.querySelector("main article"),
    document2.querySelector("article"),
    document2.querySelector("main"),
    document2.querySelector("[role='main']"),
    document2.body
  ];
  for (const el of candidates) {
    if (!el) continue;
    const innerHTML = el.innerHTML?.trim();
    const textContent = el.textContent?.trim();
    if (!innerHTML || !textContent) continue;
    const result = await toReadableResult(url, format, textContent, innerHTML, {
      title: document2.title,
      excerpt: textContent.slice(0, 240),
      length: textContent.length
    });
    if (result) return result;
  }
  return null;
}
async function toReadableResult(url, format, textContent, htmlContent, meta) {
  const text2 = normalize(textContent);
  const markdown = format === "markdown" ? normalize(await htmlToBasicMarkdown(htmlContent ?? "")) ?? text2 : void 0;
  const normalizedText = format === "text" ? text2 : void 0;
  if (!normalizedText && !markdown) return null;
  return {
    url,
    title: normalize(meta.title),
    byline: normalize(meta.byline),
    excerpt: normalize(meta.excerpt),
    contentLength: meta.length ?? text2?.length ?? markdown?.length ?? 0,
    text: normalizedText,
    markdown
  };
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/selectors.ts
var LEGACY_SELECTOR_PREFIXES = ["p-aria/", "p-text/", "p-xpath/", "p-pierce/"];
var SELECTOR_HANDLER_PREFIXES = [
  "aria/",
  "text/",
  "xpath/",
  "pierce/",
  "aria-ref=",
  "aria-ref/",
  "ariaref/",
  "p-"
];
var PLAYWRIGHT_ONLY_SELECTOR_RE = /:has-text\(|:text\(|:text-is\(|:text-matches\(|:visible\b|:hidden\b|:nth-match\(|:near\(|:above\(|:below\(|:right-of\(|:left-of\(/;
var ARIA_REF_PREFIXES = ["aria-ref=", "aria-ref/", "ariaref/"];
function assertSelectorString(selector) {
  if (typeof selector === "string") return;
  let kind;
  if (selector !== null && typeof selector === "object") {
    kind = "then" in selector && typeof selector.then === "function" ? "a Promise (missing await?)" : "an ElementHandle";
  } else {
    kind = `a ${typeof selector}`;
  }
  throw new ToolError(
    `Browser selector must be a string; got ${kind}. tab.click/type/fill/waitFor take string selectors only \u2014 call the handle method directly (e.g. (await tab.id(n)).click()) or pass a string like "aria-ref=eN".`
  );
}
function parseAriaRefSelector(selector) {
  assertSelectorString(selector);
  const trimmed = selector.trim();
  for (const prefix of ARIA_REF_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      const id = trimmed.slice(prefix.length).trim();
      return /^e\d+$/.test(id) ? id : null;
    }
  }
  const bare = /^@?(e\d+)$/.exec(trimmed);
  return bare ? bare[1] : null;
}
function normalizeSelector(selector) {
  assertSelectorString(selector);
  if (!selector) return selector;
  if (!SELECTOR_HANDLER_PREFIXES.some((prefix) => selector.startsWith(prefix)) && PLAYWRIGHT_ONLY_SELECTOR_RE.test(selector)) {
    throw new ToolError(
      `Playwright-only selector ${JSON.stringify(selector)} is not supported by the browser tool. Use a puppeteer text selector ("text/Allow all"), an aria selector ("aria/Name"), CSS, or "xpath/...".`
    );
  }
  if (selector.startsWith("p-") && !LEGACY_SELECTOR_PREFIXES.some((prefix) => selector.startsWith(prefix))) {
    throw new ToolError(
      `Unsupported selector prefix. Use CSS or puppeteer query handlers (aria/, text/, xpath/, pierce/). Got: ${selector}`
    );
  }
  if (selector.startsWith("p-text/")) return `text/${selector.slice("p-text/".length)}`;
  if (selector.startsWith("p-xpath/")) return `xpath/${selector.slice("p-xpath/".length)}`;
  if (selector.startsWith("p-pierce/")) return `pierce/${selector.slice("p-pierce/".length)}`;
  if (selector.startsWith("p-aria/")) {
    const rest = selector.slice("p-aria/".length);
    const nameMatch = rest.match(/\[\s*name\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\]]+))\s*\]/);
    const name = nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3];
    if (name) return `aria/${name.trim()}`;
    return `aria/${rest}`;
  }
  return selector;
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/abortable.ts
import assert from "node:assert/strict";
var AbortError = class extends Error {
  constructor(signal) {
    assert(signal.aborted, "Abort signal must be aborted");
    const message = signal.reason instanceof Error ? signal.reason.message : "Cancelled";
    super(`Aborted: ${message}`, { cause: signal.reason });
    this.name = "AbortError";
  }
};
function untilAborted(signal, pr) {
  if (!signal) return typeof pr === "function" ? pr() : pr;
  if (signal.aborted) return Promise.reject(new AbortError(signal));
  const { promise, resolve: resolve3, reject } = Promise.withResolvers();
  const onAbort = () => reject(new AbortError(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  void (async () => {
    try {
      resolve3(await (typeof pr === "function" ? pr() : pr));
    } catch (err) {
      reject(err);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  })();
  return promise;
}
function withTimeout(promise, ms, timeout, signal) {
  if (signal?.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason : new Error("Aborted");
    return Promise.reject(reason);
  }
  const { promise: wrapped, resolve: resolve3, reject } = Promise.withResolvers();
  let settled = false;
  const timeoutId = setTimeout(() => {
    if (settled) return;
    settled = true;
    if (signal) signal.removeEventListener("abort", onAbort);
    reject(typeof timeout === "string" ? new Error(timeout) : timeout);
  }, ms);
  const onAbort = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutId);
    reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
  };
  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  promise.then(
    (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve3(value);
    },
    (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(err);
    }
  );
  return wrapped;
}
function sleep(ms) {
  const { promise, resolve: resolve3 } = Promise.withResolvers();
  setTimeout(resolve3, ms);
  return promise;
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/run-output.ts
var TAB_TEXT_CUT_NOTE = "[tab output over 50 KiB: its middle was not kept here; print less, or return the value]";
function droppedImagesNote(dropped, ceilingChars) {
  return `[tab output: ${dropped} image${dropped === 1 ? "" : "s"} dropped \u2014 one call keeps at most ${ceilingChars / (1024 * 1024)} MiB of images]`;
}
var RunOutput = class {
  #displays = [];
  #textLimit;
  #imageLimit;
  #textBuffer = "";
  /** Bytes of text held in the entries and the buffer, until the run outgrows its budget. */
  #textBytes = 0;
  #imageChars = 0;
  #imagesDropped = 0;
  /** The run's whole text once it outgrew the budget; absent until then. */
  #sink;
  /** Something has been put into the sink, so an entry after it is separated by a newline. */
  #sinkStarted = false;
  #sinkInStream = false;
  /** The stream's last newline is held back: an entry that follows replaces it with its own separator, the way the entries of a run are joined. */
  #heldNewline = false;
  constructor(limits = {}) {
    this.#textLimit = limits.textBytes ?? MAX_INLINE_BYTES;
    this.#imageLimit = limits.imageChars ?? MAX_IMAGE_BASE64_CHARS;
  }
  /** Buffer a stream-text chunk; it joins the entries at the next push or on finish(). */
  pushText(chunk2) {
    if (this.#sink !== void 0) {
      this.#intoStream(this.#sink, chunk2);
      return;
    }
    this.#textBuffer += chunk2;
    this.#textBytes += Buffer.byteLength(chunk2, "utf8");
    if (this.#textBytes > this.#textLimit) this.#outgrown();
  }
  /** Append a `display()` payload (image or json), flushing buffered text first. */
  pushDisplay(output) {
    if (output.type === "image") {
      this.push({ type: "image", data: output.data, mimeType: output.mimeType });
      return;
    }
    this.push({ type: "text", text: safeJsonStringify(output.data) });
  }
  /** Append a pre-built entry (e.g. a screenshot caption/image), flushing buffered text first. */
  push(entry) {
    if (entry.type === "image") {
      this.#flush();
      if (this.#imageChars + entry.data.length > this.#imageLimit) {
        this.#imagesDropped += 1;
        return;
      }
      this.#imageChars += entry.data.length;
      this.#displays.push(entry);
      return;
    }
    if (this.#sink !== void 0) {
      this.#asEntry(this.#sink, entry.text);
      return;
    }
    this.#flush();
    this.#displays.push(entry);
    this.#textBytes += Buffer.byteLength(entry.text, "utf8");
    if (this.#textBytes > this.#textLimit) this.#outgrown();
  }
  /** Flush any remaining stream text and return the ordered entries. */
  finish() {
    this.#flush();
    const note = this.#imagesDropped === 0 ? "" : droppedImagesNote(this.#imagesDropped, this.#imageLimit);
    if (this.#sink === void 0) return note === "" ? this.#displays : [...this.#displays, { type: "text", text: note }];
    const text2 = [this.#sink.dump().text, TAB_TEXT_CUT_NOTE, note].filter((part) => part.length > 0).join("\n");
    return [{ type: "text", text: text2 }, ...this.#displays];
  }
  #flush() {
    if (!this.#textBuffer) return;
    this.#displays.push({ type: "text", text: this.#textBuffer.replace(/\n$/, "") });
    this.#textBuffer = "";
  }
  /** The text of the run no longer fits its budget: everything so far goes into a sink, and the entries keep only the images. */
  #outgrown() {
    const sink = new OutputSink({ maxBytes: this.#textLimit });
    this.#sink = sink;
    const images = [];
    for (const entry of this.#displays) {
      if (entry.type === "text") this.#asEntry(sink, entry.text);
      else images.push(entry);
    }
    this.#displays.length = 0;
    this.#displays.push(...images);
    const buffered = this.#textBuffer;
    this.#textBuffer = "";
    this.#intoStream(sink, buffered);
  }
  #asEntry(sink, text2) {
    this.#heldNewline = false;
    this.#sinkInStream = false;
    if (this.#sinkStarted) sink.push("\n");
    sink.push(text2);
    this.#sinkStarted = true;
  }
  #intoStream(sink, chunk2) {
    if (!this.#sinkInStream) {
      if (this.#sinkStarted) sink.push("\n");
      this.#sinkInStream = true;
      this.#sinkStarted = true;
    }
    if (this.#heldNewline) {
      sink.push("\n");
      this.#heldNewline = false;
    }
    if (chunk2.endsWith("\n")) {
      this.#heldNewline = true;
      sink.push(chunk2.slice(0, -1));
    } else sink.push(chunk2);
  }
};
function safeJsonStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
function cloneSafe(value) {
  if (value === void 0) return void 0;
  try {
    structuredClone(value);
    return value;
  } catch {
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
  }
  return String(value);
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/run-scope.ts
import { AsyncLocalStorage as AsyncLocalStorage2 } from "node:async_hooks";
var EXPECTED_CLEANUP = Symbol.for("dimension.browser.expectedCleanupError");
function markExpectedCleanupError(reason) {
  Reflect.set(reason, EXPECTED_CLEANUP, true);
  return reason;
}
function isExpectedCleanupError(reason) {
  let current = reason;
  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
    if (Reflect.get(current, EXPECTED_CLEANUP) === true) return true;
    current = Reflect.get(current, "cause");
  }
  return false;
}
var browserRunRejections = /* @__PURE__ */ new WeakMap();
function markBrowserRunRejection(reason, owner) {
  if (reason !== null && (typeof reason === "object" || typeof reason === "function")) {
    browserRunRejections.set(reason, owner);
  }
  return reason;
}
function isBrowserRunRejection(reason, owner) {
  return reason !== null && (typeof reason === "object" || typeof reason === "function") && browserRunRejections.get(reason) === owner;
}
function isBrowserRunOwnedRejection(reason, owner, filename) {
  if (isBrowserRunRejection(reason, owner)) return true;
  return reason instanceof Error && typeof reason.stack === "string" && reason.stack.includes(filename);
}
var observedBrowserPromises = /* @__PURE__ */ new WeakMap();
var observedPromiseConstructor = { [Symbol.species]: Promise };
var PROMISE_COMBINATORS = ["all", "race", "allSettled", "any"];
var NativePromise = Promise;
var nativePromiseCombinators = {
  all: Promise.all,
  race: Promise.race,
  allSettled: Promise.allSettled,
  any: Promise.any
};
var promiseCombinatorTracking = new AsyncLocalStorage2();
var previousPromiseDescriptor;
var promiseCombinatorTrackingScopes = 0;
async function withBrowserPromiseCombinatorTracking(owner, onFloatingRejection, run) {
  installPromiseCombinatorTracking();
  try {
    return await promiseCombinatorTracking.run({ owner, onFloatingRejection }, run);
  } finally {
    restorePromiseCombinatorTracking();
  }
}
function installPromiseCombinatorTracking() {
  if (promiseCombinatorTrackingScopes > 0) {
    promiseCombinatorTrackingScopes++;
    return;
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Promise");
  if (!descriptor) throw new Error("Global Promise descriptor is unavailable");
  const trackedPromise = createTrackedPromiseConstructor();
  Object.defineProperty(globalThis, "Promise", { ...descriptor, value: trackedPromise });
  previousPromiseDescriptor = descriptor;
  promiseCombinatorTrackingScopes = 1;
}
function restorePromiseCombinatorTracking() {
  if (promiseCombinatorTrackingScopes > 1) {
    promiseCombinatorTrackingScopes--;
    return;
  }
  const descriptor = previousPromiseDescriptor;
  try {
    if (!descriptor) throw new Error("Global Promise tracking scope is not installed");
    Object.defineProperty(globalThis, "Promise", descriptor);
  } finally {
    previousPromiseDescriptor = void 0;
    promiseCombinatorTrackingScopes = 0;
  }
}
function createTrackedPromiseConstructor() {
  class TrackedPromise extends NativePromise {
  }
  for (const name of PROMISE_COMBINATORS) {
    const original = nativePromiseCombinators[name];
    Object.defineProperty(TrackedPromise, name, {
      configurable: true,
      writable: true,
      value(values) {
        let hasObservedInput = false;
        const result = Reflect.apply(original, this, [
          tapObservedBrowserPromises(values, () => {
            hasObservedInput = true;
          })
        ]);
        const context = promiseCombinatorTracking.getStore();
        return hasObservedInput && context ? observeBrowserRunPromise(result, context.owner, context.onFloatingRejection) : result;
      }
    });
  }
  return TrackedPromise;
}
function* tapObservedBrowserPromises(values, onObserved) {
  for (const value of values) {
    if (observedBrowserPromises.has(value)) onObserved();
    yield value;
  }
}
function observeBrowserRunPromise(promise, owner, onFloatingRejection) {
  return observeBrowserRunPromiseWithState(promise, owner, onFloatingRejection, {
    handled: false,
    userContinuationFailed: false
  });
}
function observeBrowserRunPromiseWithState(promise, owner, onFloatingRejection, state) {
  if (observedBrowserPromises.has(promise)) return promise;
  observedBrowserPromises.set(promise, state);
  const originalThen = promise.then.bind(promise);
  const originalFinally = promise.finally.bind(promise);
  void originalThen(void 0, (reason) => {
    setTimeout(() => {
      if (!state.handled && (state.userContinuationFailed || !isBrowserRunRejection(reason, owner))) {
        onFloatingRejection(reason);
      }
    }, 0);
  });
  Object.defineProperties(promise, {
    constructor: { configurable: true, value: observedPromiseConstructor },
    // oxlint-disable-next-line unicorn/no-thenable -- native Promise continuations must remain thenable.
    then: {
      configurable: true,
      value: (onFulfilled, onRejected) => {
        state.handled = true;
        const childState = createContinuationState();
        return observeBrowserRunPromiseWithState(
          originalThen(
            recordContinuationFailure(onFulfilled, childState),
            recordContinuationFailure(onRejected, childState)
          ),
          owner,
          onFloatingRejection,
          childState
        );
      }
    },
    catch: {
      configurable: true,
      value: (onRejected) => {
        state.handled = true;
        const childState = createContinuationState();
        return observeBrowserRunPromiseWithState(
          originalThen(void 0, recordContinuationFailure(onRejected, childState)),
          owner,
          onFloatingRejection,
          childState
        );
      }
    },
    finally: {
      configurable: true,
      value: (onFinally) => {
        state.handled = true;
        const childState = createContinuationState();
        return observeBrowserRunPromiseWithState(
          originalFinally(recordContinuationFailure(onFinally, childState)),
          owner,
          onFloatingRejection,
          childState
        );
      }
    }
  });
  return promise;
}
function createContinuationState() {
  return { handled: false, userContinuationFailed: false };
}
function recordContinuationFailure(continuation, state) {
  if (!continuation) return continuation;
  return (...args) => {
    try {
      const result = continuation(...args);
      if (!isThenable(result)) return result;
      return Promise.resolve(result).catch((reason) => {
        state.userContinuationFailed = true;
        throw reason;
      });
    } catch (reason) {
      state.userContinuationFailed = true;
      throw reason;
    }
  };
}
function isThenable(value) {
  if (value === null || typeof value !== "object" && typeof value !== "function") return false;
  return typeof Reflect.get(value, "then") === "function";
}
function trackBrowserRunPromise(promise, owner, onFloatingRejection) {
  if (!owner) return markHandled(promise);
  const tracked = promise.catch((error) => {
    throw markBrowserRunRejection(error, owner);
  });
  return onFloatingRejection ? observeBrowserRunPromise(tracked, owner, onFloatingRejection) : tracked;
}
function installBrowserWorkerRejectionGuard(consume) {
  const onRejection = (reason) => {
    if (isExpectedCleanupError(reason) || consume(reason)) {
      markRejectionHandled(reason);
      return;
    }
    if (process.listenerCount("unhandledRejection") > 1) return;
    setTimeout(() => {
      throw reason;
    }, 0);
  };
  process.on("unhandledRejection", onRejection);
  return () => process.off("unhandledRejection", onRejection);
}
function markHandled(promise) {
  void promise.catch(() => void 0);
  return promise;
}
var CELL_BUDGET_SLACK_MS = 1e3;
var DEFAULT_PREDICATE_TIMEOUT_MS = 3e4;
function resolvePredicateTimeout(cellTimeoutMs, explicit) {
  const budgetBound = Math.max(1, cellTimeoutMs - CELL_BUDGET_SLACK_MS);
  if (explicit === 0 || explicit === Number.POSITIVE_INFINITY) return budgetBound;
  if (explicit !== void 0 && Number.isFinite(explicit) && explicit > 0) return Math.min(explicit, budgetBound);
  return Math.min(DEFAULT_PREDICATE_TIMEOUT_MS, budgetBound);
}
function waitForRun(msOrPredicate, signal, opts) {
  const promise = (async () => {
    throwIfAborted(signal);
    if (typeof msOrPredicate === "number") {
      await untilAborted(signal, async () => await sleep(msOrPredicate));
      throwIfAborted(signal);
      return void 0;
    }
    if (typeof msOrPredicate !== "function") {
      throw new ToolError("wait(...) expects milliseconds (number) or a predicate function to poll");
    }
    const timeout = opts?.timeout !== void 0 && Number.isFinite(opts.timeout) && opts.timeout > 0 ? opts.timeout : DEFAULT_PREDICATE_TIMEOUT_MS;
    const interval = Math.max(opts?.interval ?? 100, 10);
    const deadline = Date.now() + timeout;
    for (; ; ) {
      const value = await untilAborted(signal, async () => await msOrPredicate());
      throwIfAborted(signal);
      if (value) return value;
      if (Date.now() + interval > deadline) {
        throw new ToolError(`wait(predicate) timed out after ${timeout}ms \u2014 predicate never returned truthy`);
      }
      await untilAborted(signal, async () => await sleep(interval));
    }
  })();
  return trackBrowserRunPromise(promise);
}
function bindRunFacade(target, signal, rejectionOwner, onFloatingRejection) {
  const cache = /* @__PURE__ */ new Map();
  return new Proxy(target, {
    get(current, prop) {
      throwIfAborted(signal);
      const cached = cache.get(prop);
      if (cached) return cached;
      const value = Reflect.get(current, prop, current);
      if (typeof value === "function") {
        const wrapped = (...args) => {
          throwIfAborted(signal);
          const result = Reflect.apply(value, current, args);
          if (result && typeof result === "object") {
            const then = Reflect.get(result, "then");
            if (typeof then === "function") {
              return trackBrowserRunPromise(
                Promise.resolve(result).then((resolved) => {
                  throwIfAborted(signal);
                  return resolved;
                }),
                rejectionOwner,
                onFloatingRejection
              );
            }
          }
          throwIfAborted(signal);
          return result;
        };
        cache.set(prop, wrapped);
        return wrapped;
      }
      if (value && typeof value === "object") {
        if (value instanceof AbortSignal) return value;
        const wrapped = bindRunFacade(value, signal, rejectionOwner, onFloatingRejection);
        cache.set(prop, wrapped);
        return wrapped;
      }
      return value;
    }
  });
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/screenshot.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/image-size.ts
function u16be(b, o) {
  return b[o] << 8 | b[o + 1];
}
function u32be(b, o) {
  return (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
}
function u24le(b, o) {
  return b[o] | b[o + 1] << 8 | b[o + 2] << 16;
}
function ascii(b, o, n) {
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]);
  return s;
}
function png(b) {
  if (b.length < 24 || ascii(b, 1, 3) !== "PNG" || ascii(b, 12, 4) !== "IHDR") return void 0;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  return width > 0 && height > 0 ? { width, height, mimeType: "image/png" } : void 0;
}
function jpeg(b) {
  if (b.length < 4 || b[0] !== 255 || b[1] !== 216) return void 0;
  let o = 2;
  while (o + 3 < b.length) {
    if (b[o] !== 255) {
      o++;
      continue;
    }
    while (o < b.length && b[o] === 255) o++;
    if (o >= b.length) return void 0;
    const marker = b[o++];
    if (marker === 217 || marker === 218) return void 0;
    if (marker === 1 || marker >= 208 && marker <= 215) continue;
    if (o + 1 >= b.length) return void 0;
    const length = u16be(b, o);
    if (length < 2) return void 0;
    const sof = marker >= 192 && marker <= 195 || marker >= 197 && marker <= 199 || marker >= 201 && marker <= 203 || marker >= 205 && marker <= 207;
    if (sof) {
      if (o + 7 >= b.length) return void 0;
      const height = u16be(b, o + 3);
      const width = u16be(b, o + 5);
      return width > 0 && height > 0 ? { width, height, mimeType: "image/jpeg" } : void 0;
    }
    o += length;
  }
  return void 0;
}
function webp(b) {
  if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return void 0;
  const chunk2 = ascii(b, 12, 4);
  let width;
  let height;
  if (chunk2 === "VP8X") {
    width = u24le(b, 24) + 1;
    height = u24le(b, 27) + 1;
  } else if (chunk2 === "VP8L") {
    if (b[20] !== 47) return void 0;
    const bits = b[21] | b[22] << 8 | b[23] << 16 | b[24] << 24;
    width = (bits & 16383) + 1;
    height = (bits >>> 14 & 16383) + 1;
  } else if (chunk2 === "VP8 ") {
    if (b[23] !== 157 || b[24] !== 1 || b[25] !== 42) return void 0;
    width = (b[26] | b[27] << 8) & 16383;
    height = (b[28] | b[29] << 8) & 16383;
  } else return void 0;
  return width > 0 && height > 0 ? { width, height, mimeType: "image/webp" } : void 0;
}
function readImageDimensions(bytes) {
  return png(bytes) ?? jpeg(bytes) ?? webp(bytes);
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/screenshot.ts
var MODEL_SHOT_EDGE = 1024;
var MODEL_SHOT_MAX_BYTES = 150 * 1024;
var MODEL_SHOT_QUALITY = 70;
var MODEL_SHOT_MIN_EDGE = 200;
var QUALITY_STEPS = [60, 50, 40];
var SCALE_STEPS = [0.75, 0.5, 0.35, 0.25];
function describeScreenshot(opts) {
  if (opts?.selector) return `tab.screenshot({ selector: ${JSON.stringify(opts.selector)} })`;
  if (opts?.fullPage) return "tab.screenshot({ fullPage: true })";
  return "tab.screenshot()";
}
async function preparePageForScreenshot(page, signal, activate) {
  if (activate) {
    await untilAborted(signal, () => page.bringToFront()).catch(() => void 0);
    return;
  }
  const visible2 = await untilAborted(signal, () => page.evaluate(() => document.visibilityState === "visible")).catch(
    () => false
  );
  if (!visible2) {
    throw new ToolError("The attached browser tab is not visible; switch to it before taking a screenshot");
  }
}
function shortenPath(filePath, homeDir = os.homedir()) {
  const windowsStyle = /^[A-Za-z]:[\\/]/.test(homeDir) || homeDir.startsWith("\\\\");
  const hasHomePrefix = windowsStyle ? filePath.toLowerCase().startsWith(homeDir.toLowerCase()) : filePath.startsWith(homeDir);
  if (homeDir && hasHomePrefix) {
    const suffix = filePath.slice(homeDir.length);
    if (suffix === "" || suffix.startsWith(path.posix.sep) || suffix.startsWith(path.win32.sep)) {
      return `~${suffix.replaceAll(path.win32.sep, path.posix.sep)}`;
    }
  }
  return filePath;
}
function formatDimensionNote(info) {
  if (!info.originalWidth || !info.originalHeight || !info.width || !info.height) return void 0;
  if (info.width === info.originalWidth && info.height === info.originalHeight) return void 0;
  const scale = info.originalWidth / info.width;
  return `[Image: original ${info.originalWidth}x${info.originalHeight}, displayed at ${info.width}x${info.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}
function formatScreenshot(opts) {
  const lines = ["Screenshot captured"];
  if (opts.saveFullRes) {
    lines.push(`Saved: ${opts.savedMimeType} (${(opts.savedByteLength / 1024).toFixed(2)} KB) to ${shortenPath(opts.dest)}`);
    lines.push(`Model: ${opts.resized.mimeType} (${(opts.resized.bytes / 1024).toFixed(2)} KB, ${opts.resized.width}x${opts.resized.height})`);
  } else {
    lines.push(`Format: ${opts.resized.mimeType} (${(opts.resized.bytes / 1024).toFixed(2)} KB)`);
    lines.push(`Dimensions: ${opts.resized.width}x${opts.resized.height}`);
  }
  const dimensionNote = formatDimensionNote(opts.resized);
  if (dimensionNote) lines.push(dimensionNote);
  return lines;
}
function resolveScreenshotDir(env, home = os.homedir()) {
  const raw = env.DIMENSION_BROWSER_SCREENSHOT_DIR?.trim();
  if (!raw) return void 0;
  if (raw === "~") return home;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(home, raw.slice(2));
  return raw;
}
async function scrollElementIntoView(handle, signal) {
  await untilAborted(
    signal,
    () => handle.evaluate((el) => {
      const target = el;
      target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    })
  ).catch(() => void 0);
}
async function measure(target, opts, signal) {
  const { page } = target;
  const cdp = await untilAborted(signal, () => target.cdp());
  const [metrics, dpr] = await Promise.all([
    untilAborted(signal, () => cdp.send("Page.getLayoutMetrics")),
    untilAborted(signal, () => page.evaluate(() => window.devicePixelRatio))
  ]);
  const view = metrics.cssVisualViewport;
  const viewport = { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, inView: true };
  if (opts.selector !== void 0) {
    const handle = await target.resolveElement(opts.selector);
    if (!handle) throw new ToolError("Screenshot selector did not resolve to an element");
    try {
      await scrollElementIntoView(handle, signal);
      const box = await untilAborted(signal, () => handle.boundingBox());
      if (!box || box.width < 1 || box.height < 1) {
        throw new ToolError(`Screenshot selector ${JSON.stringify(opts.selector)} has no visible box to capture`);
      }
      const region = { x: box.x + view.pageX, y: box.y + view.pageY, width: box.width, height: box.height };
      const inView = box.x >= 0 && box.y >= 0 && box.x + box.width <= view.clientWidth && box.y + box.height <= view.clientHeight;
      return { region: { ...region, inView }, dpr: dpr || 1 };
    } finally {
      await handle.dispose().catch(() => void 0);
    }
  }
  if (opts.fullPage) {
    const size = metrics.cssContentSize;
    return { region: { x: 0, y: 0, width: size.width, height: size.height, inView: false }, dpr: dpr || 1 };
  }
  return { region: viewport, dpr: dpr || 1 };
}
function modelPixelRatio(region, dpr) {
  const longest = Math.max(region.width, region.height);
  const shortest = Math.min(region.width, region.height);
  let ratio = Math.min(dpr, MODEL_SHOT_EDGE / longest);
  if (shortest * ratio < MODEL_SHOT_MIN_EDGE) ratio = Math.min(MODEL_SHOT_MIN_EDGE / shortest, MODEL_SHOT_EDGE / longest);
  return ratio;
}
function extensionOf(mimeType) {
  return mimeType === "image/webp" ? "webp" : mimeType === "image/jpeg" ? "jpg" : "png";
}
async function captureScreenshot(target, config, output, screenshots, signal, opts = {}) {
  const { page } = target;
  await preparePageForScreenshot(page, signal, config.activate);
  const effective = opts.selector ? { ...opts, fullPage: false } : opts;
  const { region, dpr } = await measure(target, effective, signal);
  const clip = { x: region.x, y: region.y, width: Math.max(1, Math.ceil(region.width)), height: Math.max(1, Math.ceil(region.height)) };
  const format = config.excludeWebP ? "jpeg" : "webp";
  const mimeType = config.excludeWebP ? "image/jpeg" : "image/webp";
  const ratio = modelPixelRatio(region, dpr);
  const cdp = await untilAborted(signal, () => target.cdp());
  let pixelFactor = 1;
  const capture = async (type, quality, pixelsPerCss) => {
    const { data } = await untilAborted(
      signal,
      () => cdp.send("Page.captureScreenshot", {
        format: type,
        ...quality === void 0 ? {} : { quality },
        captureBeyondViewport: !region.inView,
        clip: { ...clip, scale: pixelsPerCss / pixelFactor }
      })
    );
    return Buffer.from(data, "base64");
  };
  let best;
  let learned = false;
  const attempt = async (pixelsPerCss, quality) => {
    let bytes = await capture(format, quality, pixelsPerCss);
    if (!learned) {
      learned = true;
      const wide = readImageDimensions(bytes)?.width;
      const factor = wide === void 0 || wide < 100 ? 1 : wide / (clip.width * pixelsPerCss);
      if (Math.abs(factor - 1) > 0.1) {
        pixelFactor = factor;
        bytes = await capture(format, quality, pixelsPerCss);
      }
    }
    if (!best || bytes.length < best.bytes.length) best = { bytes, ratio: pixelsPerCss };
    return bytes.length <= MODEL_SHOT_MAX_BYTES;
  };
  let fits = await attempt(ratio, MODEL_SHOT_QUALITY);
  for (const quality of QUALITY_STEPS) {
    if (fits) break;
    fits = await attempt(ratio, quality);
  }
  for (const scale of SCALE_STEPS) {
    if (fits) break;
    if (clip.width * ratio * scale < 100 || clip.height * ratio * scale < 100) break;
    for (const quality of [MODEL_SHOT_QUALITY, ...QUALITY_STEPS]) {
      fits = await attempt(ratio * scale, quality);
      if (fits) break;
    }
  }
  const modelBytes = best.bytes;
  const dims = readImageDimensions(modelBytes);
  const width = dims?.width ?? Math.round(clip.width * best.ratio);
  const height = dims?.height ?? Math.round(clip.height * best.ratio);
  const resized = {
    mimeType,
    bytes: modelBytes.length,
    width,
    height,
    originalWidth: Math.round(clip.width * dpr),
    originalHeight: Math.round(clip.height * dpr)
  };
  const saveFullRes = !!config.dir;
  const saved = saveFullRes ? await capture("png", void 0, dpr) : modelBytes;
  const savedMimeType = saveFullRes ? "image/png" : mimeType;
  const ext = extensionOf(savedMimeType);
  const dest = config.dir ? path.join(config.dir, `screenshot-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, -1)}.${ext}`) : path.join(os.tmpdir(), `dimension-sshots-${crypto.randomUUID()}.${ext}`);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.writeFile(dest, saved);
  screenshots.push({ dest, mimeType: savedMimeType, bytes: saved.length, width, height });
  if (!opts.silent) {
    const lines = formatScreenshot({ saveFullRes, savedMimeType, savedByteLength: saved.length, dest, resized });
    output.push({ type: "text", text: lines.join("\n") });
    const image = { type: "image", data: Buffer.from(modelBytes).toString("base64"), mimeType };
    output.push(image);
  }
  return dest;
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/kinds/cmux/rpc.ts
var GEOMETRY_SCRIPT = "(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio||1, scrollX: window.scrollX, scrollY: window.scrollY, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight }))()";
function cmuxSnapshotToObservation(result, viewport, geometry) {
  const elements2 = [];
  const refs = result.refs ?? {};
  for (const ref in refs) {
    const value = refs[ref];
    if (!value) continue;
    const id = Number.parseInt(ref.replace(/^@?e/, ""), 10);
    if (Number.isNaN(id)) continue;
    const role = typeof value.role === "string" && value.role.length > 0 ? value.role : "generic";
    const name = typeof value.name === "string" && value.name.length > 0 ? value.name : void 0;
    elements2.push({ id, role, name, states: [] });
  }
  elements2.sort((a, b) => a.id - b.id);
  const url = (typeof result.url === "string" && result.url.length > 0 ? result.url : void 0) ?? (typeof result.page?.url === "string" && result.page.url.length > 0 ? result.page.url : void 0) ?? "about:blank";
  const title = (typeof result.title === "string" && result.title.length > 0 ? result.title : void 0) ?? (typeof result.page?.title === "string" && result.page.title.length > 0 ? result.page.title : void 0);
  return {
    url,
    title,
    viewport,
    scroll: {
      x: geometry.scrollX,
      y: geometry.scrollY,
      width: geometry.innerWidth,
      height: geometry.innerHeight,
      scrollWidth: geometry.scrollWidth,
      scrollHeight: geometry.scrollHeight
    },
    elements: elements2
  };
}
function serializeEval(fn, args) {
  if (typeof fn === "string") {
    return fn;
  }
  return `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(",")})`;
}
function serializeEvalWithEnvelope(fn, args) {
  const inner = serializeEval(fn, args);
  const expr = typeof fn === "string" ? `(0, eval)(${JSON.stringify(inner)})` : inner;
  return `(() => {
		try {
			const __v = (${expr});
			if (__v && typeof __v.then === "function") return { __ompPromise: true };
			return { __ompOk: __v === undefined ? null : __v };
		} catch (e) {
			return { __ompErr: (e && (e.stack || e.message)) || String(e) };
		}
	})()`;
}
function unwrapEvalEnvelope(value, label) {
  if (value && typeof value === "object") {
    if ("__ompErr" in value && typeof value.__ompErr === "string") {
      throw new ToolError(`${label} threw a JavaScript exception:
${value.__ompErr}`);
    }
    if ("__ompPromise" in value && value.__ompPromise === true) {
      throw new ToolError(
        `${label} returned a Promise, but this surface evaluates synchronously and cannot await it \u2014 return a plain value (poll with waitForFunction for async state instead)`
      );
    }
    if ("__ompOk" in value) {
      return value.__ompOk;
    }
  }
  return value;
}
function mapWaitUntil(waitUntil) {
  return waitUntil === "domcontentloaded" ? "interactive" : "complete";
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/kinds/cmux/png.ts
import { deflateSync, inflateSync } from "node:zlib";
var SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
var MODEL_PICTURE_EDGE = 1024;
var CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let c = 4294967295;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 255] ^ c >>> 8;
  return (c ^ 4294967295) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}
function pngSize(png2) {
  if (png2.length < 24 || !png2.subarray(0, 8).equals(SIGNATURE) || png2.toString("latin1", 12, 16) !== "IHDR") return void 0;
  return { width: png2.readUInt32BE(16), height: png2.readUInt32BE(20) };
}
function readHeader(png2) {
  const size = pngSize(png2);
  if (!size) return void 0;
  const bitDepth = png2[24];
  const colorType = png2[25];
  const interlace = png2[28];
  if (bitDepth !== 8 || interlace !== 0) return void 0;
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  return channels === void 0 ? void 0 : { ...size, channels };
}
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
function decode(png2, header) {
  const idat = [];
  for (let at = 8; at + 12 <= png2.length; ) {
    const length = png2.readUInt32BE(at);
    const type = png2.toString("latin1", at + 4, at + 8);
    if (type === "IDAT") idat.push(png2.subarray(at + 8, at + 8 + length));
    if (type === "IEND") break;
    at += 12 + length;
  }
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return void 0;
  }
  const stride = header.width * header.channels;
  if (raw.length < (stride + 1) * header.height) return void 0;
  const pixels = Buffer.alloc(stride * header.height);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= header.channels ? pixels[y * stride + x - header.channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= header.channels ? pixels[(y - 1) * stride + x - header.channels] : 0;
      const predicted = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? left + up >> 1 : filter === 4 ? paeth(left, up, upLeft) : -1;
      if (predicted < 0) return void 0;
      pixels[y * stride + x] = line[x] + predicted & 255;
    }
  }
  return pixels;
}
function encode(pixels, width, height, channels, colorType) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function downscalePng(png2, edge = MODEL_PICTURE_EDGE) {
  const size = pngSize(png2);
  if (!size) return { buffer: png2, width: 0, height: 0, originalWidth: 0, originalHeight: 0, note: "the picture is not a PNG the pack can read; it is sent as it is" };
  const whole = { buffer: png2, ...size, originalWidth: size.width, originalHeight: size.height };
  if (Math.max(size.width, size.height) <= edge) return whole;
  const unreadable = { ...whole, note: `the picture is ${size.width}x${size.height} and this PNG encoding is not one the pack can shrink; it is sent at full size` };
  const header = readHeader(png2);
  if (!header) return unreadable;
  const pixels = decode(png2, header);
  if (!pixels) return unreadable;
  const ratio = edge / Math.max(size.width, size.height);
  const width = Math.max(1, Math.round(size.width * ratio));
  const height = Math.max(1, Math.round(size.height * ratio));
  const { channels } = header;
  const out = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * size.height / height);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * size.height / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * size.width / width);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * size.width / width));
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += pixels[(yy * size.width + xx) * channels + c];
        out[(y * width + x) * channels + c] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
      }
    }
  }
  return { buffer: encode(out, width, height, channels, png2[25]), width, height, originalWidth: size.width, originalHeight: size.height };
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/kinds/cmux/cmux-tab.ts
var DEFAULT_VIEWPORT = { width: 1365, height: 768, deviceScaleFactor: 1.25 };
var PAGE_SELECTOR_HELPERS = `
const isVisible = element => {
	const style = getComputedStyle(element);
	const rect = element.getBoundingClientRect();
	return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
};
const textOf = element => (element.innerText || element.textContent || "").trim();
const allElements = () => Array.from(document.querySelectorAll("body *"));
const pierceQuery = (root, selector) => {
	const direct = root.querySelector?.(selector);
	if (direct) return direct;
	const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll("*")) : [];
	for (const node of nodes) {
		if (node.shadowRoot) {
			const found = pierceQuery(node.shadowRoot, selector);
			if (found) return found;
		}
	}
	return null;
};
const accessibleName = element =>
	(
		element.getAttribute("aria-label") ||
		element.getAttribute("alt") ||
		element.getAttribute("title") ||
		textOf(element)
	).trim();
const findElement = spec => {
	if (spec.kind === "css") return document.querySelector(spec.value);
	if (spec.kind === "pierce") return pierceQuery(document, spec.value);
	if (spec.kind === "aria-ref") {
		const wanted = spec.value;
		const scan = root => {
			for (const el of Array.from(root.querySelectorAll("*"))) {
				if (el._ariaRef && el._ariaRef.ref === wanted) return el;
				if (el.shadowRoot) {
					const found = scan(el.shadowRoot);
					if (found) return found;
				}
			}
			return null;
		};
		return scan(document);
	}
	if (spec.kind === "xpath") {
		const result = document.evaluate(spec.value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
		return result.singleNodeValue instanceof Element ? result.singleNodeValue : null;
	}
	if (spec.kind === "text") {
		const wanted = spec.value.trim();
		return allElements().find(element => isVisible(element) && textOf(element).includes(wanted)) || null;
	}
	if (spec.kind === "aria" || spec.kind === "ax") {
		const wanted = (spec.name || spec.value).trim();
		const role = spec.role || "";
		return (
			allElements().find(element => {
				if (!isVisible(element)) return false;
				if (role && element.getAttribute("role") !== role) return false;
				const name = accessibleName(element);
				return name === wanted || name.includes(wanted);
			}) || null
		);
	}
	return null;
};
const event = (target, type, init = {}) =>
	target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
const mouseEvent = (target, type, init = {}) =>
	target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, ...init }));
const inputEvent = target => {
	event(target, "input");
	event(target, "change");
};
const setValue = (target, value, append = false) => {
	if ("value" in target) {
		target.value = append ? String(target.value || "") + value : value;
		inputEvent(target);
		return;
	}
	if (target.isContentEditable) {
		target.textContent = append ? String(target.textContent || "") + value : value;
		inputEvent(target);
	}
};
`;
var RESPONSE_OBSERVER_SCRIPT = String.raw`
(() => {
	const key = "__ompCmuxResponses";
	if (globalThis[key]) return true;
	const state = { nextId: 1, records: [] };
	Object.defineProperty(globalThis, key, { value: state, configurable: true });
	const headersObject = headers => {
		const out = {};
		if (headers && typeof headers.forEach === "function") headers.forEach((value, name) => (out[name] = value));
		return out;
	};
	const remember = async response => {
		try {
			const clone = response.clone();
			const body = await clone.text().catch(() => "");
			state.records.push({
				id: state.nextId++,
				url: response.url,
				status: response.status,
				statusText: response.statusText,
				headers: headersObject(response.headers),
				body,
			});
			if (state.records.length > 200) state.records.splice(0, state.records.length - 200);
		} catch {
		}
	};
	const originalFetch = globalThis.fetch;
	if (typeof originalFetch === "function") {
		globalThis.fetch = async (...args) => {
			const response = await originalFetch(...args);
			void remember(response);
			return response;
		};
	}
	const OriginalXHR = globalThis.XMLHttpRequest;
	if (typeof OriginalXHR === "function") {
		globalThis.XMLHttpRequest = function XMLHttpRequestProxy() {
			const xhr = new OriginalXHR();
			xhr.addEventListener("loadend", () => {
				const rawHeaders = xhr.getAllResponseHeaders();
				const headers = {};
				for (const line of rawHeaders.trim().split(/[\r\n]+/)) {
					const index = line.indexOf(":");
					if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
				}
				state.records.push({
					id: state.nextId++,
					url: xhr.responseURL || "",
					status: xhr.status,
					statusText: xhr.statusText,
					headers,
					body: typeof xhr.responseText === "string" ? xhr.responseText : "",
				});
				if (state.records.length > 200) state.records.splice(0, state.records.length - 200);
			});
			return xhr;
		};
	}
	return true;
})()
`;
var CmuxTab = class {
  #client;
  #surfaceId;
  #lastUrl = "about:blank";
  #lastTitle;
  #lastViewport = DEFAULT_VIEWPORT;
  #runContext;
  #elementRefs = /* @__PURE__ */ new Map();
  #pageFacade;
  #browserFacade;
  constructor(opts) {
    this.#client = opts.client;
    this.#surfaceId = opts.surfaceId;
    if (opts.url) this.#lastUrl = opts.url;
    this.#lastTitle = opts.title;
  }
  get surfaceId() {
    return this.#surfaceId;
  }
  get page() {
    this.#pageFacade ??= new CmuxPageFacade(this);
    return this.#pageFacade;
  }
  get browser() {
    this.#browserFacade ??= new CmuxBrowserFacade(this);
    return this.#browserFacade;
  }
  viewport() {
    return this.#lastViewport;
  }
  async setViewport(viewport) {
    this.#lastViewport = {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor
    };
  }
  url() {
    return this.#lastUrl;
  }
  async title() {
    const result = await this.#request("browser.eval", { script: "document.title" });
    this.#lastTitle = String(result.value ?? "");
    return this.#lastTitle;
  }
  async readyInfo(viewport = DEFAULT_VIEWPORT) {
    const urlResult = await this.#request("browser.url.get", {});
    if (typeof urlResult.url === "string" && urlResult.url.length > 0) {
      this.#lastUrl = urlResult.url;
    }
    const geometry = await this.#readGeometry().catch(() => void 0);
    this.#lastViewport = geometry ? { width: geometry.innerWidth, height: geometry.innerHeight, deviceScaleFactor: geometry.dpr } : viewport;
    await this.title().catch(() => "");
    return {
      url: this.#lastUrl,
      title: this.#lastTitle,
      viewport: this.#lastViewport,
      targetId: this.#surfaceId
    };
  }
  setRunContext(context) {
    this.#runContext = context;
  }
  clearRunContext() {
    this.#runContext = void 0;
  }
  async goto(url, opts) {
    const timeoutMs = opts?.timeoutMs ?? this.#runContext?.timeoutMs ?? 3e4;
    const result = await this.#request("browser.navigate", { url }, timeoutMs);
    const navigatedUrl = result.url;
    this.#lastUrl = typeof navigatedUrl === "string" && navigatedUrl.length > 0 ? navigatedUrl : url;
    if (opts?.waitUntil) {
      await this.#request(
        "browser.wait",
        { load_state: mapWaitUntil(opts.waitUntil), timeout_ms: timeoutMs },
        timeoutMs
      );
    }
  }
  async observe(opts) {
    void opts?.viewportOnly;
    const timeoutMs = Math.min(this.#runContext?.timeoutMs ?? 3e4, 3e4);
    const [snapshot, geometry] = await Promise.all([
      this.#request("browser.snapshot", { interactive: !opts?.includeAll, max_depth: 12 }, timeoutMs),
      this.#readGeometry(timeoutMs)
    ]);
    const viewport = {
      width: geometry.innerWidth,
      height: geometry.innerHeight,
      deviceScaleFactor: geometry.dpr
    };
    this.#lastViewport = viewport;
    const observation = cmuxSnapshotToObservation(snapshot, viewport, geometry);
    this.#lastUrl = observation.url;
    this.#lastTitle = observation.title;
    this.#rememberObservedElements(observation);
    return observation;
  }
  async ariaSnapshot(selector, opts) {
    const timeoutMs = Math.min(this.#runContext?.timeoutMs ?? 3e4, 3e4);
    const result = await this.#request(
      "browser.eval",
      { script: buildAriaSnapshotScript(selector, opts) },
      timeoutMs
    );
    return result.value;
  }
  async ref(id) {
    const refId = /^e\d+$/.test(id.trim()) ? id.trim() : id.trim().replace(/^(?:aria-ref=|aria-ref\/|ariaref\/)/, "");
    const selector = `aria-ref=${refId}`;
    const timeoutMs = this.#runContext?.timeoutMs ?? 3e4;
    await this.#waitForSelector(selector, timeoutMs);
    return new CmuxElementHandle(this, selector);
  }
  async click(selector) {
    await this.#selectorAction(selector, "click");
  }
  async dblclick(selector) {
    await this.#selectorAction(selector, "dblclick");
  }
  async hover(selector) {
    await this.#selectorAction(selector, "hover");
  }
  async focus(selector) {
    await this.#selectorAction(selector, "focus");
  }
  async check(selector) {
    await this.#selectorAction(selector, "check");
  }
  async uncheck(selector) {
    await this.#selectorAction(selector, "uncheck");
  }
  async type(selector, text2) {
    await this.#selectorAction(selector, "type", { text: text2 });
  }
  async fill(selector, value) {
    await this.#selectorAction(selector, "fill", { value });
  }
  async press(key, opts) {
    if (opts?.selector) {
      await this.focus(opts.selector);
    }
    await this.#request("browser.press", { key });
  }
  async scroll(dx, dy) {
    await this.#request("browser.scroll", { dx, dy });
  }
  async waitFor(selector, opts) {
    const timeoutMs = opts?.timeout ?? this.#runContext?.timeoutMs ?? 3e4;
    await this.#waitForSelector(selector, timeoutMs);
    return new CmuxElementHandle(this, selector);
  }
  async waitForSelector(selector, opts) {
    const timeoutMs = opts?.timeout ?? this.#runContext?.timeoutMs ?? 3e4;
    await this.#waitForSelector(selector, timeoutMs);
    return new CmuxElementHandle(this, selector);
  }
  async evaluate(fn, ...args) {
    const script = serializeEvalWithEnvelope(fn, args);
    const result = await this.#request("browser.eval", { script });
    return unwrapEvalEnvelope(result.value, "tab.evaluate()");
  }
  async scrollIntoView(selector) {
    await this.#selectorAction(selector, "scrollIntoView");
  }
  async select(selector, ...values) {
    return await this.#selectorAction(selector, "select", { values });
  }
  async extract(format = "markdown") {
    const result = await this.#request("browser.snapshot", { interactive: false });
    const html = typeof result.page?.html === "string" ? result.page.html : "";
    const url = (typeof result.url === "string" && result.url.length > 0 ? result.url : void 0) ?? (typeof result.page?.url === "string" && result.page.url.length > 0 ? result.page.url : void 0) ?? this.#lastUrl;
    const readable = await extractReadableFromHtml(html, url, format);
    if (!readable) {
      throw new ToolError(`tab.extract(${JSON.stringify(format)}) found no readable content on ${url}`);
    }
    const content = format === "markdown" ? readable.markdown : readable.text;
    if (!content) {
      throw new ToolError(`tab.extract(${JSON.stringify(format)}) produced empty ${format} content for ${url}`);
    }
    return content;
  }
  async screenshot(opts = {}) {
    const context = this.#requireRunContext("tab.screenshot()");
    const captureNotes = [];
    if (opts.selector) {
      await this.scrollIntoView(opts.selector);
      captureNotes.push(
        `selector ${JSON.stringify(opts.selector)} was scrolled into view, but this surface cannot clip to an element \u2014 the image is the full viewport`
      );
    }
    if (opts.fullPage) {
      captureNotes.push("fullPage is unavailable on this surface \u2014 the image is the viewport only");
    }
    const result = await this.#captureScreenshotPng(context.timeoutMs);
    const buffer = Buffer.from(result.png_base64, "base64");
    const captureMime = "image/png";
    const resized = downscalePng(buffer);
    if (resized.note) captureNotes.push(resized.note);
    const saveFullRes = !!context.session.screenshotDir;
    const savedBuffer = saveFullRes ? buffer : Buffer.from(resized.buffer);
    const savedMimeType = captureMime;
    const ext = "png";
    const dest = context.session.screenshotDir ? path2.join(context.session.screenshotDir, `screenshot-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, -1)}.${ext}`) : path2.join(os2.tmpdir(), `dimension-sshots-${crypto.randomUUID()}.${ext}`);
    await fs2.promises.mkdir(path2.dirname(dest), { recursive: true });
    await fs2.promises.writeFile(dest, savedBuffer);
    const info = {
      dest,
      mimeType: savedMimeType,
      bytes: savedBuffer.length,
      width: resized.width,
      height: resized.height
    };
    context.screenshots.push(info);
    if (!opts.silent) {
      const lines = formatScreenshot({
        saveFullRes,
        savedMimeType,
        savedByteLength: savedBuffer.length,
        dest,
        resized: { mimeType: captureMime, bytes: resized.buffer.length, width: resized.width, height: resized.height, originalWidth: resized.originalWidth, originalHeight: resized.originalHeight }
      });
      if (captureNotes.length > 0) {
        lines.push(`[cmux surface: ${captureNotes.join("; ")}]`);
      }
      context.output.push({ type: "text", text: lines.join("\n") });
      context.output.push({ type: "image", data: Buffer.from(resized.buffer).toString("base64"), mimeType: captureMime });
    }
    return dest;
  }
  async waitForUrl(pattern, opts) {
    const timeoutMs = opts?.timeout ?? this.#runContext?.timeoutMs ?? 3e4;
    const signal = this.#runContext?.signal;
    if (typeof pattern === "string") {
      await this.#request("browser.wait", { url_contains: pattern, timeout_ms: timeoutMs }, timeoutMs, signal);
      const result = await this.#request("browser.url.get", {}, timeoutMs, signal);
      if (typeof result.url === "string" && result.url.length > 0) {
        this.#lastUrl = result.url;
      }
      return this.#lastUrl;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const result = await this.#request(
        "browser.url.get",
        {},
        Math.min(timeoutMs, 5e3),
        signal
      );
      if (typeof result.url === "string" && result.url.length > 0) {
        this.#lastUrl = result.url;
        if (pattern.test(result.url)) return result.url;
      }
      await untilAborted(signal, () => sleep(200));
    }
    throw new ToolError(`tab.waitForUrl() timed out after ${timeoutMs}ms`);
  }
  async waitForNavigation(opts) {
    const timeoutMs = opts?.timeout ?? this.#runContext?.timeoutMs ?? 3e4;
    const signal = this.#runContext?.signal;
    const baseline = await this.#request(
      "browser.url.get",
      {},
      Math.min(timeoutMs, 5e3),
      signal
    );
    const startUrl = typeof baseline.url === "string" && baseline.url.length > 0 ? baseline.url : this.#lastUrl;
    if (typeof baseline.url === "string" && baseline.url.length > 0) this.#lastUrl = baseline.url;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const result = await this.#request(
        "browser.url.get",
        {},
        Math.min(timeoutMs, 5e3),
        signal
      );
      if (typeof result.url === "string" && result.url.length > 0) {
        this.#lastUrl = result.url;
        if (result.url !== startUrl) {
          if (opts?.waitUntil) {
            await this.#request(
              "browser.wait",
              { load_state: mapWaitUntil(opts.waitUntil), timeout_ms: timeoutMs },
              timeoutMs,
              signal
            );
          }
          return null;
        }
      }
      await untilAborted(signal, () => sleep(200));
    }
    throw new ToolError(`tab.waitForNavigation() timed out after ${timeoutMs}ms`);
  }
  async drag(from, to) {
    const start = await this.#dragPoint(from);
    const end = await this.#dragPoint(to);
    await this.#evalScript(
      `(() => {
				const points = ${JSON.stringify({ start, end })};
				const target = document.elementFromPoint(points.start.x, points.start.y) || document.body;
				const dispatch = (type, point) => target.dispatchEvent(new MouseEvent(type, {
					bubbles: true,
					cancelable: true,
					view: window,
					clientX: point.x,
					clientY: point.y,
					buttons: type === "mouseup" ? 0 : 1,
				}));
				dispatch("mousemove", points.start);
				dispatch("mousedown", points.start);
				dispatch("mousemove", points.end);
				dispatch("mouseup", points.end);
				return true;
			})()`
    );
  }
  async uploadFile(selector, ...filePaths) {
    if (!filePaths.length) throw new ToolError("tab.uploadFile() requires at least one file path");
    const files = [];
    for (const filePath of filePaths) {
      const cwd = this.#requireRunContext("tab.uploadFile()").session.cwd;
      if (!path2.isAbsolute(filePath) && cwd === void 0) throw new ToolError(`tab.uploadFile() needs an absolute path (got ${JSON.stringify(filePath)})`);
      const absolute = path2.resolve(cwd ?? "", filePath);
      const data = (await fs2.promises.readFile(absolute)).toString("base64");
      files.push({ name: path2.basename(absolute), type: mimeTypeOf(absolute), data });
    }
    await this.#selectorAction(selector, "uploadFile", { files });
  }
  async waitForResponse(pattern, opts) {
    const timeoutMs = opts?.timeout ?? this.#runContext?.timeoutMs ?? 3e4;
    const signal = this.#runContext?.signal;
    await this.#installResponseObserver();
    const startId = await this.#responseCursor();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const records = await this.#responseRecordsAfter(startId);
      for (const record of records) {
        const response = new CmuxResponse(record);
        if (typeof pattern === "function") {
          if (await pattern(response)) return response;
        } else if (pattern instanceof RegExp ? pattern.test(record.url) : record.url.includes(pattern)) {
          return response;
        }
      }
      await untilAborted(signal, () => sleep(100));
    }
    throw new ToolError(`tab.waitForResponse() timed out after ${timeoutMs}ms`);
  }
  async id(id) {
    const ref = this.#elementRefs.get(id)?.ref ?? `@e${id}`;
    await this.#waitForSelector(ref, this.#runContext?.timeoutMs ?? 3e4);
    return new CmuxElementHandle(this, ref);
  }
  async #request(method, params, timeoutMs, signal = this.#runContext?.signal) {
    throwIfAborted(signal);
    const result = await untilAborted(
      signal,
      () => this.#client.request(method, { surface_id: this.#surfaceId, ...params }, { timeoutMs })
    );
    throwIfAborted(signal);
    return result;
  }
  async #readGeometry(timeoutMs) {
    const result = await this.#request("browser.eval", { script: GEOMETRY_SCRIPT }, timeoutMs);
    return this.#normalizeGeometry(result.value);
  }
  elementHandle(selector) {
    return new CmuxElementHandle(this, selector);
  }
  async elementExists(selector) {
    return await this.#selectorExists(this.#selectorSpec(selector));
  }
  async elementBox(selector) {
    return await this.#selectorBox(this.#selectorSpec(selector));
  }
  async evaluateOnSelector(selector, source, args) {
    const spec = this.#selectorSpec(selector);
    const script = `(() => {
			const spec = ${JSON.stringify(spec)};
			const source = ${JSON.stringify(source)};
			const args = ${JSON.stringify(args)};
			${PAGE_SELECTOR_HELPERS}
			const element = findElement(spec);
			if (!element) throw new Error("Element handle selector no longer resolves");
			const callable = (0, eval)("(" + source + ")");
			return callable(element, ...args);
		})()`;
    const result = await this.#request("browser.eval", {
      script: serializeEvalWithEnvelope(script, [])
    });
    return unwrapEvalEnvelope(result.value, "elementHandle.evaluate()");
  }
  async pageContent() {
    return await this.#evalScript("document.documentElement.outerHTML");
  }
  async pageScreenshot(opts = {}) {
    if (opts.selector) await this.scrollIntoView(opts.selector);
    const result = await this.#captureScreenshotPng(this.#runContext?.timeoutMs ?? 3e4);
    return opts.encoding === "base64" ? result.png_base64 : Buffer.from(result.png_base64, "base64");
  }
  async waitForFunction(fn, opts, ...args) {
    const timeoutMs = opts?.timeout ?? this.#runContext?.timeoutMs ?? 3e4;
    const signal = this.#runContext?.signal;
    const pollingMs = typeof opts?.polling === "number" ? opts.polling : 200;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const value = typeof fn === "string" ? await this.#evalScript(fn) : await this.evaluate(fn, ...args);
      if (value) return value;
      await untilAborted(signal, () => sleep(pollingMs));
    }
    throw new ToolError(`page.waitForFunction() timed out after ${timeoutMs}ms`);
  }
  async #evalScript(script, timeoutMs) {
    const result = await this.#request("browser.eval", { script }, timeoutMs);
    return result.value;
  }
  async #captureScreenshotPng(timeoutMs) {
    const result = await this.#request("browser.screenshot", {}, timeoutMs);
    if (typeof result.png_base64 !== "string" || result.png_base64.length === 0) {
      throw new ToolError("cmux browser screenshot response did not include png_base64");
    }
    return result;
  }
  async #selectorAction(selector, action, args = {}) {
    const spec = this.#selectorSpec(selector);
    const nativeSelector = this.#nativeSelector(spec);
    if (nativeSelector && action !== "select" && action !== "uploadFile") {
      switch (action) {
        case "click":
          await this.#request("browser.click", { selector: nativeSelector });
          return void 0;
        case "dblclick":
          await this.#request("browser.dblclick", { selector: nativeSelector });
          return void 0;
        case "hover":
          await this.#request("browser.hover", { selector: nativeSelector });
          return void 0;
        case "focus":
          await this.#request("browser.focus", { selector: nativeSelector });
          return void 0;
        case "check":
          await this.#request("browser.check", { selector: nativeSelector });
          return void 0;
        case "uncheck":
          await this.#request("browser.uncheck", { selector: nativeSelector });
          return void 0;
        case "type":
          await this.#request("browser.type", { selector: nativeSelector, text: String(args.text ?? "") });
          return void 0;
        case "fill":
          await this.#request("browser.fill", { selector: nativeSelector, text: String(args.value ?? "") });
          return void 0;
        case "scrollIntoView":
          await this.#request("browser.scroll_into_view", { selector: nativeSelector });
          return void 0;
      }
    }
    return await this.#evalSelectorAction(spec, action, args);
  }
  async #evalSelectorAction(spec, action, args) {
    const script = `(() => {
			const spec = ${JSON.stringify(spec)};
			const action = ${JSON.stringify(action)};
			const args = ${JSON.stringify(args)};
			${PAGE_SELECTOR_HELPERS}
			const element = findElement(spec);
			if (!element) throw new Error("No element matched " + spec.raw);
			if (action !== "exists") element.scrollIntoView({ block: "center", inline: "center" });
			switch (action) {
				case "click":
					mouseEvent(element, "mousedown");
					mouseEvent(element, "mouseup");
					if (typeof element.click === "function") element.click();
					else mouseEvent(element, "click");
					return true;
				case "dblclick":
					mouseEvent(element, "dblclick");
					return true;
				case "hover":
					mouseEvent(element, "mouseover");
					mouseEvent(element, "mouseenter");
					mouseEvent(element, "mousemove");
					return true;
				case "focus":
					if (typeof element.focus === "function") element.focus();
					return true;
				case "check":
					element.checked = true;
					inputEvent(element);
					return true;
				case "uncheck":
					element.checked = false;
					inputEvent(element);
					return true;
				case "type":
					if (typeof element.focus === "function") element.focus();
					setValue(element, String(args.text || ""), true);
					return true;
				case "fill":
					if (typeof element.focus === "function") element.focus();
					setValue(element, String(args.value || ""), false);
					return true;
				case "scrollIntoView":
					return true;
				case "select": {
					const values = Array.isArray(args.values) ? args.values.map(String) : [String(args.value || "")];
					if (element.tagName !== "SELECT") throw new Error("tab.select() requires a <select> element");
					const wanted = new Set(values);
					const selected = [];
					for (const option of Array.from(element.options)) {
						option.selected = wanted.has(option.value);
						if (option.selected) selected.push(option.value);
					}
					inputEvent(element);
					return selected;
				}
				case "uploadFile": {
					if (element.tagName !== "INPUT" || element.type !== "file") {
						throw new Error("tab.uploadFile() requires an <input type=file> element");
					}
					const transfer = new DataTransfer();
					for (const file of args.files || []) {
						const bytes = Uint8Array.from(atob(file.data), char => char.charCodeAt(0));
						transfer.items.add(new File([bytes], file.name, { type: file.type || "application/octet-stream" }));
					}
					element.files = transfer.files;
					inputEvent(element);
					return true;
				}
			}
			throw new Error("Unsupported selector action " + action);
		})()`;
    const result = await this.#request("browser.eval", { script }, this.#runContext?.timeoutMs);
    return result.value;
  }
  async #waitForSelector(selector, timeoutMs) {
    const signal = this.#runContext?.signal;
    const spec = this.#selectorSpec(selector);
    const nativeSelector = this.#nativeSelector(spec);
    if (nativeSelector) {
      await this.#request("browser.wait", { selector: nativeSelector, timeout_ms: timeoutMs }, timeoutMs, signal);
      return;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if (await this.#selectorExists(spec)) return;
      await untilAborted(signal, () => sleep(100));
    }
    throw new ToolError(`tab.waitFor(${JSON.stringify(selector)}) timed out after ${timeoutMs}ms`);
  }
  async #selectorExists(spec) {
    if (spec.kind === "ref") return this.#elementRefs.has(Number(spec.value));
    const script = `(() => {
			const spec = ${JSON.stringify(spec)};
			${PAGE_SELECTOR_HELPERS}
			return !!findElement(spec);
		})()`;
    return !!await this.#evalScript(script);
  }
  async #selectorBox(spec) {
    if (spec.kind === "ref") return null;
    const script = `(() => {
			const spec = ${JSON.stringify(spec)};
			${PAGE_SELECTOR_HELPERS}
			const element = findElement(spec);
			if (!element) return null;
			const rect = element.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) return null;
			return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
		})()`;
    const value = await this.#evalScript(script);
    if (!value || typeof value !== "object") return null;
    const object = value;
    return {
      x: numberFrom(object.x, 0),
      y: numberFrom(object.y, 0),
      width: numberFrom(object.width, 0),
      height: numberFrom(object.height, 0)
    };
  }
  async #dragPoint(target) {
    if (typeof target === "string") {
      const box = await this.#selectorBox(this.#selectorSpec(target));
      if (!box) throw new ToolError(`Drag selector did not resolve to a visible element: ${target}`);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
      return { x: target.x, y: target.y };
    }
    throw new ToolError("Drag target must be a selector string or { x: number, y: number } point");
  }
  async #installResponseObserver() {
    await this.#evalScript(RESPONSE_OBSERVER_SCRIPT);
  }
  async #responseCursor() {
    const value = await this.#evalScript(
      "(() => Math.max(0, ((globalThis.__ompCmuxResponses && globalThis.__ompCmuxResponses.nextId) || 1) - 1))()"
    );
    return numberFrom(value, 0);
  }
  async #responseRecordsAfter(id) {
    const value = await this.#evalScript(
      `(() => ((globalThis.__ompCmuxResponses && globalThis.__ompCmuxResponses.records) || []).filter(record => record.id > ${JSON.stringify(id)}))()`
    );
    if (!Array.isArray(value)) return [];
    const records = [];
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const object = item;
      const headers = object.headers && typeof object.headers === "object" ? object.headers : {};
      records.push({
        id: numberFrom(object.id, 0),
        url: typeof object.url === "string" ? object.url : "",
        status: numberFrom(object.status, 0),
        statusText: typeof object.statusText === "string" ? object.statusText : "",
        headers: Object.fromEntries(
          Object.entries(headers).map(([key, value2]) => [key, String(value2)])
        ),
        body: typeof object.body === "string" ? object.body : ""
      });
    }
    return records;
  }
  #selectorSpec(selector) {
    assertSelectorString(selector);
    const raw = selector;
    let normalized = selector;
    if (normalized.startsWith("p-text/")) normalized = `text/${normalized.slice("p-text/".length)}`;
    else if (normalized.startsWith("p-aria/")) normalized = `aria/${normalized.slice("p-aria/".length)}`;
    else if (normalized.startsWith("p-xpath/")) normalized = `xpath/${normalized.slice("p-xpath/".length)}`;
    else if (normalized.startsWith("p-pierce/")) normalized = `pierce/${normalized.slice("p-pierce/".length)}`;
    const ariaRef = /^(?:aria-ref=|aria-ref\/|ariaref\/)(e\d+)$/.exec(normalized);
    if (ariaRef) return { kind: "aria-ref", value: ariaRef[1], raw };
    const ref = /^@?e(\d+)$/.exec(normalized);
    if (ref) return { kind: "ref", value: ref[1], raw, ref: `@e${ref[1]}` };
    const slash = normalized.indexOf("/");
    if (slash > 0) {
      const prefix = normalized.slice(0, slash);
      const value = normalized.slice(slash + 1);
      if (prefix === "text" || prefix === "aria" || prefix === "xpath" || prefix === "pierce") {
        return { kind: prefix, value, raw, name: prefix === "aria" ? value : void 0 };
      }
    }
    return { kind: "css", value: normalized, raw };
  }
  #nativeSelector(spec) {
    if (spec.kind === "css") return spec.value;
    if (spec.kind === "ref") return spec.ref;
    return void 0;
  }
  #rememberObservedElements(observation) {
    this.#elementRefs.clear();
    for (const element of observation.elements) {
      this.#elementRefs.set(element.id, {
        ref: `@e${element.id}`,
        name: element.name,
        role: element.role
      });
    }
  }
  #normalizeGeometry(value) {
    const object = value && typeof value === "object" ? value : {};
    return {
      innerWidth: numberFrom(object.innerWidth, DEFAULT_VIEWPORT.width),
      innerHeight: numberFrom(object.innerHeight, DEFAULT_VIEWPORT.height),
      dpr: numberFrom(object.dpr, DEFAULT_VIEWPORT.deviceScaleFactor ?? 1),
      scrollX: numberFrom(object.scrollX, 0),
      scrollY: numberFrom(object.scrollY, 0),
      scrollWidth: numberFrom(object.scrollWidth, DEFAULT_VIEWPORT.width),
      scrollHeight: numberFrom(object.scrollHeight, DEFAULT_VIEWPORT.height)
    };
  }
  #requireRunContext(operation) {
    if (!this.#runContext) {
      throw new ToolError(`${operation} requires an active cmux browser run`);
    }
    return this.#runContext;
  }
};
var CmuxResponse = class {
  #record;
  constructor(record) {
    this.#record = record;
  }
  url() {
    return this.#record.url;
  }
  status() {
    return this.#record.status;
  }
  statusText() {
    return this.#record.statusText;
  }
  headers() {
    return { ...this.#record.headers };
  }
  async text() {
    return this.#record.body;
  }
  async json() {
    return JSON.parse(this.#record.body);
  }
};
var CmuxElementHandle = class {
  #tab;
  #selector;
  constructor(tab, selector) {
    this.#tab = tab;
    this.#selector = selector;
  }
  async click() {
    await this.#tab.click(this.#selector);
  }
  async type(text2) {
    await this.#tab.type(this.#selector, text2);
  }
  async fill(value) {
    await this.#tab.fill(this.#selector, value);
  }
  async press(key) {
    await this.#tab.press(key, { selector: this.#selector });
  }
  async focus() {
    await this.#tab.focus(this.#selector);
  }
  async hover() {
    await this.#tab.hover(this.#selector);
  }
  async evaluate(fn, ...args) {
    return await this.#tab.evaluateOnSelector(this.#selector, fn.toString(), args);
  }
  async boundingBox() {
    return await this.#tab.elementBox(this.#selector);
  }
  async uploadFile(...paths) {
    await this.#tab.uploadFile(this.#selector, ...paths);
  }
  async dispose() {
  }
};
var CmuxLocator = class {
  #tab;
  #selector;
  #timeoutMs;
  constructor(tab, selector) {
    this.#tab = tab;
    this.#selector = selector;
  }
  setTimeout(timeoutMs) {
    this.#timeoutMs = timeoutMs;
    return this;
  }
  async click() {
    await this.#tab.waitFor(this.#selector, { timeout: this.#timeoutMs });
    await this.#tab.click(this.#selector);
  }
  async fill(value) {
    await this.#tab.waitFor(this.#selector, { timeout: this.#timeoutMs });
    await this.#tab.fill(this.#selector, value);
  }
  async waitHandle() {
    return await this.#tab.waitFor(this.#selector, { timeout: this.#timeoutMs });
  }
};
var CmuxPageFacade = class {
  #tab;
  keyboard;
  mouse;
  constructor(tab) {
    this.#tab = tab;
    this.keyboard = { press: (key) => this.#tab.press(key) };
    let lastPoint = { x: 0, y: 0 };
    let dragStart;
    this.mouse = {
      wheel: (delta) => this.#tab.scroll(delta.deltaX ?? 0, delta.deltaY ?? 0),
      move: (x, y) => {
        lastPoint = { x, y };
        return Promise.resolve();
      },
      down: () => {
        dragStart = lastPoint;
        return Promise.resolve();
      },
      up: async () => {
        if (dragStart) await this.#tab.drag(dragStart, lastPoint);
        dragStart = void 0;
      }
    };
  }
  url() {
    return this.#tab.url();
  }
  async title() {
    return await this.#tab.title();
  }
  viewport() {
    return this.#tab.viewport();
  }
  async setViewport(viewport) {
    await this.#tab.setViewport(viewport);
  }
  async goto(url, opts) {
    await this.#tab.goto(url, { waitUntil: opts?.waitUntil, timeoutMs: opts?.timeout });
    return { url: this.#tab.url() };
  }
  async evaluate(fn, ...args) {
    return await this.#tab.evaluate(fn, ...args);
  }
  async content() {
    return await this.#tab.pageContent();
  }
  locator(selector) {
    return new CmuxLocator(this.#tab, selector);
  }
  async $(selector) {
    return await this.#tab.elementExists(selector) ? this.#tab.elementHandle(selector) : null;
  }
  async waitForSelector(selector, opts) {
    return await this.#tab.waitFor(selector, opts);
  }
  async waitForFunction(fn, opts, ...args) {
    return await this.#tab.waitForFunction(fn, opts, ...args);
  }
  async waitForResponse(pattern, opts) {
    return await this.#tab.waitForResponse(pattern, opts);
  }
  async screenshot(opts = {}) {
    return await this.#tab.pageScreenshot(opts);
  }
};
var CmuxBrowserFacade = class {
  #tab;
  connected = true;
  constructor(tab) {
    this.#tab = tab;
  }
  async pages() {
    return [this.#tab.page];
  }
  async version() {
    return "cmux";
  }
  wsEndpoint() {
    return `cmux://${this.#tab.surfaceId}`;
  }
  disconnect() {
    this.connected = false;
  }
  async close() {
    this.connected = false;
  }
};
async function runCmuxCode(tab, opts) {
  const runAc = new AbortController();
  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
  const signal = AbortSignal.any(opts.signal ? [timeoutSignal, opts.signal, runAc.signal] : [timeoutSignal, runAc.signal]);
  const runEndedError = markExpectedCleanupError(new ToolAbortError("Browser run ended"));
  const output = new RunOutput();
  const screenshots = [];
  const runId = crypto.randomUUID();
  const filename = `cmux-run-${runId}.js`;
  tab.setRunContext({ session: opts.settings, output, screenshots, signal, timeoutMs: opts.timeoutMs });
  const { promise: cancelRejection, reject } = Promise.withResolvers();
  cancelRejection.catch(() => {
  });
  const rejectionOwner = {};
  const { promise: floatingFailure, reject: rejectFloatingFailure } = Promise.withResolvers();
  floatingFailure.catch(() => {
  });
  let runActive = true;
  let hasFloatingFailure = false;
  const recordFloatingFailure = (reason) => {
    if (hasFloatingFailure || isExpectedCleanupError(reason)) return;
    const message = reason instanceof Error ? reason.message : String(reason);
    if (!runActive) {
      console.error(`[browser] Unhandled rejection after browser run ended (run ${runId}): ${message}`);
      return;
    }
    hasFloatingFailure = true;
    const error = new Error(`Unhandled rejection (missing await?): ${message}`, { cause: reason });
    if (reason instanceof Error) error.name = reason.name;
    rejectFloatingFailure(error);
  };
  const uninstallRejectionInterceptor = installBrowserWorkerRejectionGuard((reason) => {
    if (!isBrowserRunOwnedRejection(reason, rejectionOwner, filename)) return false;
    recordFloatingFailure(reason);
    return true;
  });
  const onAbort = () => {
    if (timeoutSignal.aborted) {
      reject(new ToolError(`Browser code execution timed out after ${opts.timeoutMs}ms`));
    } else {
      const reason = signal.reason;
      if (reason instanceof ToolError) reject(reason);
      else reject(reason instanceof ToolAbortError ? reason : new ToolAbortError(void 0, { cause: reason }));
    }
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    const runTab = bindRunFacade(tab, signal, rejectionOwner, recordFloatingFailure);
    const scope = {
      page: bindRunFacade(tab.page, signal, rejectionOwner, recordFloatingFailure),
      browser: bindRunFacade(tab.browser, signal, rejectionOwner, recordFloatingFailure),
      tab: runTab,
      assert: (cond, text2) => {
        if (!cond) throw new ToolError(text2 ?? "Assertion failed");
      },
      wait: (msOrPredicate, waitOpts) => observeBrowserRunPromise(
        waitForRun(
          msOrPredicate,
          signal,
          typeof msOrPredicate === "number" ? waitOpts : { timeout: resolvePredicateTimeout(opts.timeoutMs, waitOpts?.timeout), interval: waitOpts?.interval }
        ).catch((error) => {
          throw markBrowserRunRejection(error, rejectionOwner);
        }),
        rejectionOwner,
        recordFloatingFailure
      )
    };
    const hooks = {
      onText: (chunk2) => {
        throwIfAborted(signal);
        output.pushText(chunk2);
      },
      onDisplay: (displayed) => {
        throwIfAborted(signal);
        output.pushDisplay(displayed);
      }
    };
    let returnValue;
    let runError;
    let runFailed = false;
    try {
      returnValue = await withBrowserPromiseCombinatorTracking(
        rejectionOwner,
        recordFloatingFailure,
        async () => await Promise.race([opts.evaluator.evaluate(opts.code, { filename, scope, hooks }), cancelRejection, floatingFailure])
      );
    } catch (error) {
      runFailed = true;
      runError = error;
    }
    runAc.abort(runEndedError);
    const turn = Promise.withResolvers();
    setImmediate(turn.resolve);
    await turn.promise;
    if (hasFloatingFailure && !runFailed) await floatingFailure;
    if (runFailed) throw runError;
    return { displays: output.finish(), returnValue: cloneSafe(returnValue), screenshots };
  } finally {
    runActive = false;
    uninstallRejectionInterceptor();
    signal.removeEventListener("abort", onAbort);
    runAc.abort(runEndedError);
    tab.clearRunContext();
  }
}
function mimeTypeOf(file) {
  const known = {
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".json": "application/json",
    ".html": "text/html",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".zip": "application/zip"
  };
  return known[path2.extname(file).toLowerCase()] ?? "application/octet-stream";
}
function numberFrom(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/kinds/cmux/socket-client.ts
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as net from "node:net";
import * as os3 from "node:os";
import * as path3 from "node:path";
var DEFAULT_CONNECT_TIMEOUT_MS = 1e4;
var DEFAULT_REQUEST_TIMEOUT_MS = 3e4;
var UTF8 = new TextEncoder();
function parseRelayCredentials(relayIdValue, relayTokenValue) {
  if (typeof relayIdValue !== "string" || typeof relayTokenValue !== "string") {
    return null;
  }
  const relayId = relayIdValue.trim();
  const relayTokenHex = relayTokenValue.trim();
  if (relayId.length === 0 || relayTokenHex.length === 0 || relayTokenHex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(relayTokenHex)) {
    return null;
  }
  const relayToken = new Uint8Array(new ArrayBuffer(relayTokenHex.length / 2));
  for (let index = 0; index < relayToken.length; index++) {
    relayToken[index] = Number.parseInt(relayTokenHex.slice(index * 2, index * 2 + 2), 16);
  }
  return { relayId, relayToken };
}
function formatCmuxError(error) {
  const code = typeof error?.code === "string" && error.code.length > 0 ? error.code : "error";
  const message = typeof error?.message === "string" && error.message.length > 0 ? error.message : "cmux error";
  const details = error?.details === void 0 ? "" : ` details=${JSON.stringify(error.details)}`;
  return `${code}: ${message}${details}`;
}
var CmuxSocketClient = class {
  #socketPath;
  #password;
  #relayId;
  #relayToken;
  #socket = null;
  #connectPromise = null;
  #connected = false;
  #disposed = false;
  #buffer = "";
  #lineWaiters = [];
  #queue = [];
  #activeJob = null;
  #pumping = false;
  constructor(opts) {
    this.#socketPath = opts.socketPath;
    this.#password = opts.password;
    this.#relayId = opts.relayId ?? process.env.CMUX_RELAY_ID;
    this.#relayToken = opts.relayToken ?? process.env.CMUX_RELAY_TOKEN;
  }
  async connect() {
    if (this.#disposed) {
      throw new ToolError("cmux socket closed");
    }
    if (this.#connected && this.#socket && !this.#socket.destroyed) {
      return;
    }
    if (this.#connectPromise) {
      return await this.#connectPromise;
    }
    this.#connectPromise = this.#openSocket();
    try {
      await this.#connectPromise;
    } finally {
      this.#connectPromise = null;
    }
  }
  async request(method, params, opts) {
    if (this.#disposed) {
      throw new ToolError("cmux socket closed");
    }
    const { promise, resolve: resolve3, reject } = Promise.withResolvers();
    this.#queue.push({
      method,
      params,
      timeoutMs: opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      resolve: resolve3,
      reject
    });
    this.#pump();
    return await promise;
  }
  close() {
    this.#disposed = true;
    const err = new ToolError("cmux socket closed");
    this.#rejectAll(err);
    this.#socket?.end();
    this.#socket?.destroy();
    this.#socket = null;
    this.#connected = false;
    this.#connectPromise = null;
  }
  async #openSocket() {
    const relayEndpoint = this.#parseRelayEndpoint();
    const relayCredentials = relayEndpoint ? await this.#loadRelayCredentials(relayEndpoint) : null;
    const socket = relayEndpoint ? net.createConnection({ host: relayEndpoint.host, port: relayEndpoint.port }) : net.createConnection({ path: this.#socketPath });
    this.#socket = socket;
    this.#buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk2) => this.#onData(String(chunk2)));
    socket.on("error", (err) => this.#handleSocketFailure(err));
    socket.on("close", () => this.#handleSocketClose());
    try {
      await this.#waitForConnect(socket);
      if (relayEndpoint && relayCredentials) {
        await this.#authenticateRelay(relayEndpoint, relayCredentials);
      }
      if (this.#password) {
        const line = await this.#sendLine(`auth ${this.#password}`, DEFAULT_CONNECT_TIMEOUT_MS);
        if (line.startsWith("ERROR:") && !line.includes("Unknown command 'auth'")) {
          throw new ToolError(line);
        }
      }
      this.#connected = true;
    } catch (err) {
      this.#connected = false;
      socket.destroy();
      if (err instanceof ToolError) throw err;
      throw new ToolError(
        `Failed to connect to cmux socket at ${this.#socketPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  #parseRelayEndpoint() {
    const value = this.#socketPath.trim();
    if (value.length === 0 || value.startsWith("/")) {
      return null;
    }
    const match = /^(127\.0\.0\.1|localhost):([0-9]+)$/.exec(value);
    if (!match) {
      return null;
    }
    const port = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return null;
    }
    return { host: "127.0.0.1", port };
  }
  async #loadRelayCredentials(endpoint) {
    const environmentCredentials = parseRelayCredentials(this.#relayId, this.#relayToken);
    if (environmentCredentials) {
      return environmentCredentials;
    }
    const authPath = path3.join(os3.homedir(), ".cmux", "relay", `${endpoint.port}.auth`);
    let payload;
    try {
      payload = JSON.parse(await readFile(authPath, "utf8"));
    } catch {
      throw new ToolError(
        `Missing cmux relay auth metadata for ${endpoint.host}:${endpoint.port}; set CMUX_RELAY_ID/CMUX_RELAY_TOKEN or restore ~/.cmux/relay/${endpoint.port}.auth`
      );
    }
    const relayId = payload && typeof payload === "object" && "relay_id" in payload ? payload.relay_id : void 0;
    const relayToken = payload && typeof payload === "object" && "relay_token" in payload ? payload.relay_token : void 0;
    const fileCredentials = parseRelayCredentials(relayId, relayToken);
    if (!fileCredentials) {
      throw new ToolError(`Invalid cmux relay auth metadata in ~/.cmux/relay/${endpoint.port}.auth`);
    }
    return fileCredentials;
  }
  async #authenticateRelay(endpoint, credentials) {
    const challengeLine = await this.#nextLine(DEFAULT_CONNECT_TIMEOUT_MS);
    let challenge;
    try {
      challenge = JSON.parse(challengeLine);
    } catch {
      throw new ToolError(`Invalid cmux relay authentication challenge from ${endpoint.host}:${endpoint.port}`);
    }
    if (!challenge || typeof challenge !== "object" || !("protocol" in challenge) || challenge.protocol !== "cmux-relay-auth" || !("version" in challenge) || typeof challenge.version !== "number" || !Number.isInteger(challenge.version) || !("relay_id" in challenge) || challenge.relay_id !== credentials.relayId || !("nonce" in challenge) || typeof challenge.nonce !== "string" || challenge.nonce.length === 0) {
      throw new ToolError(`Invalid cmux relay authentication challenge from ${endpoint.host}:${endpoint.port}`);
    }
    const message = `relay_id=${challenge.relay_id}
nonce=${challenge.nonce}
version=${challenge.version}`;
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      credentials.relayToken,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = await globalThis.crypto.subtle.sign("HMAC", key, UTF8.encode(message));
    const authLine = JSON.stringify({
      relay_id: credentials.relayId,
      mac: Buffer.from(mac).toString("hex")
    });
    const responseLine = await this.#sendLine(authLine, DEFAULT_CONNECT_TIMEOUT_MS);
    let response;
    try {
      response = JSON.parse(responseLine);
    } catch {
      throw new ToolError(`Cmux relay authentication failed for ${endpoint.host}:${endpoint.port}`);
    }
    if (!response || typeof response !== "object" || !("ok" in response) || response.ok !== true) {
      throw new ToolError(`Cmux relay authentication failed for ${endpoint.host}:${endpoint.port}`);
    }
  }
  #waitForConnect(socket) {
    const { promise, resolve: resolve3, reject } = Promise.withResolvers();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ToolError(`Failed to connect to cmux socket at ${this.#socketPath}: timed out`));
    }, DEFAULT_CONNECT_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve3();
    };
    const onError = (err) => {
      cleanup();
      reject(new ToolError(`Failed to connect to cmux socket at ${this.#socketPath}: ${err.message}`));
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    return promise;
  }
  #pump() {
    if (this.#pumping) return;
    this.#pumping = true;
    void this.#pumpLoop();
  }
  async #pumpLoop() {
    try {
      while (this.#queue.length > 0 && !this.#disposed) {
        const job = this.#queue.shift();
        if (!job) continue;
        this.#activeJob = job;
        try {
          await this.connect();
          const request = JSON.stringify({ id: randomUUID(), method: job.method, params: job.params });
          const line = await this.#sendLine(request, job.timeoutMs);
          job.resolve(this.#parseResponse(line));
        } catch (err) {
          job.reject(err instanceof Error ? err : new ToolError(String(err)));
        } finally {
          if (this.#activeJob === job) {
            this.#activeJob = null;
          }
        }
      }
    } finally {
      this.#pumping = false;
      if (this.#queue.length > 0 && !this.#disposed) {
        this.#pump();
      }
    }
  }
  #sendLine(line, timeoutMs) {
    if (!this.#socket || this.#socket.destroyed) {
      throw new ToolError("cmux socket is not connected");
    }
    const read = this.#nextLine(timeoutMs);
    this.#socket.write(`${line}
`, (err) => {
      if (err) {
        this.#handleSocketFailure(err);
      }
    });
    return read;
  }
  #nextLine(timeoutMs) {
    const { promise, resolve: resolve3, reject } = Promise.withResolvers();
    let waiter;
    const timer = setTimeout(() => {
      const index = this.#lineWaiters.indexOf(waiter);
      if (index >= 0) {
        this.#lineWaiters.splice(index, 1);
      }
      reject(new ToolError("Timed out waiting for cmux socket response"));
      this.#destroySocketForDesync();
    }, timeoutMs);
    waiter = {
      resolve: (line) => {
        clearTimeout(timer);
        resolve3(line);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
      timer
    };
    this.#lineWaiters.push(waiter);
    this.#drainLines();
    return promise;
  }
  #onData(chunk2) {
    this.#buffer += chunk2;
    this.#drainLines();
  }
  #drainLines() {
    while (this.#lineWaiters.length > 0) {
      const newlineIndex = this.#buffer.indexOf("\n");
      if (newlineIndex < 0) return;
      let line = this.#buffer.slice(0, newlineIndex);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      const waiter = this.#lineWaiters.shift();
      waiter?.resolve(line);
    }
  }
  #parseResponse(line) {
    if (line.startsWith("ERROR:")) {
      throw new ToolError(line);
    }
    let payload;
    try {
      payload = JSON.parse(line);
    } catch (err) {
      throw new ToolError(`Invalid cmux socket JSON response: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!payload || typeof payload !== "object") {
      throw new ToolError("Invalid cmux socket response: expected object");
    }
    const response = payload;
    if (response.ok === true) {
      return response.result ?? {};
    }
    if (response.ok === false) {
      throw new ToolError(formatCmuxError(response.error));
    }
    throw new ToolError("Invalid cmux socket response: missing ok flag");
  }
  #handleSocketFailure(err) {
    if (this.#disposed) return;
    this.#connected = false;
    this.#connectPromise = null;
    this.#rejectAll(new ToolError(`cmux socket error: ${err.message}`));
    this.#socket?.destroy();
    this.#socket = null;
  }
  #handleSocketClose() {
    const hadPendingRead = this.#lineWaiters.length > 0;
    this.#connected = false;
    this.#connectPromise = null;
    this.#socket = null;
    if (!this.#disposed && hadPendingRead) {
      this.#rejectAll(new ToolError("cmux socket closed"));
    }
  }
  #destroySocketForDesync() {
    this.#connected = false;
    this.#connectPromise = null;
    this.#socket?.destroy();
    this.#socket = null;
  }
  #rejectAll(err) {
    for (const waiter of this.#lineWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    if (this.#activeJob) {
      this.#activeJob.reject(err);
      this.#activeJob = null;
    }
    for (const job of this.#queue.splice(0)) {
      job.reject(err);
    }
  }
};

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/kinds/cmux/cmux-realm.ts
var RUN_SCOPE = ["tab", "page", "browser", "wait", "assert"];
async function connectCmux(connection) {
  const client = new CmuxSocketClient({
    socketPath: connection.socketPath,
    ...connection.password ? { password: connection.password } : {},
    ...connection.relayId ? { relayId: connection.relayId } : {},
    ...connection.relayToken ? { relayToken: connection.relayToken } : {}
  });
  await client.connect();
  return client;
}
var CmuxRealm = class {
  #options;
  #sessions = /* @__PURE__ */ new Map();
  /** One connection per daemon, shared by every tab on it. */
  #clients = /* @__PURE__ */ new Map();
  constructor(options) {
    this.#options = options;
  }
  names() {
    return [...this.#sessions.keys()];
  }
  has(name) {
    return this.#sessions.has(name);
  }
  #client(connection) {
    let client = this.#clients.get(connection.socketPath);
    if (client === void 0) {
      client = (this.#options.connect ?? connectCmux)(connection);
      this.#clients.set(connection.socketPath, client);
      client.catch(() => {
        if (this.#clients.get(connection.socketPath) === client) this.#clients.delete(connection.socketPath);
      });
    }
    return client;
  }
  /** Take the surface the host opened (or attached to) as the tab `name`. */
  async adopt(name, handle) {
    if (handle.kind !== "cmux" || handle.cmux === void 0) throw new ToolError("A cmux tab needs the connection to its daemon that the host resolved");
    const held = this.#sessions.get(name);
    if (held && held.surfaceId === handle.targetId && held.browserId === handle.browserId) return;
    const client = await this.#client(handle.cmux);
    const tab = new CmuxTab({ client, surfaceId: handle.targetId, url: handle.url, ...handle.title ? { title: handle.title } : {} });
    this.#sessions.set(name, { name, tab, browserId: handle.browserId, surfaceId: handle.targetId, evaluator: void 0, active: null, done: null });
    if (held) await this.#close(held, new ToolError(`Tab "${name}" was closed`));
  }
  async run(r) {
    const hasCode = r.code !== void 0 && r.code.trim().length > 0;
    const hasFn = r.fn !== void 0 && r.fn.trim().length > 0;
    if (hasCode === hasFn) throw new ToolError("Action 'run' requires exactly one of 'code' or 'fn'.");
    const code = hasFn ? renderFunctionRun(r.fn.trim(), RUN_SCOPE, r.args ?? []) : r.code.trim();
    return await this.#execute(this.#alive(r.name), code, r.timeoutMs, r.signal);
  }
  async call(r) {
    return await this.#execute(this.#alive(r.name), renderTabCall(r.chain), r.timeoutMs, r.signal);
  }
  /** Let go of the tab `name`. The surface stays: the host closes a split it opened, and a surface the person pointed at is theirs. */
  async release(name) {
    const session = this.#sessions.get(name);
    if (!session) return false;
    this.#sessions.delete(name);
    await this.#close(session, new ToolError(`Tab "${name}" was closed`));
    return true;
  }
  /** The browser the tabs belonged to went away: they go with it, and a run on one ends now saying why. */
  async end(browserId, reason) {
    for (const session of [...this.#sessions.values()]) {
      if (session.browserId !== browserId) continue;
      this.#sessions.delete(session.name);
      await this.#close(session, new ToolError(reason ?? `Tab "${session.name}" was closed`));
    }
  }
  async dispose() {
    for (const name of [...this.#sessions.keys()]) await this.release(name);
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    for (const client of clients) (await client.catch(() => void 0))?.close();
  }
  #alive(name) {
    const session = this.#sessions.get(name);
    if (!session) throw new ToolError(`Tab ${JSON.stringify(name)} is not alive. Open it first with action:"open".`);
    return session;
  }
  async #execute(session, code, timeoutMs, hostSignal) {
    if (session.active) throw new ToolError(`Tab ${JSON.stringify(session.name)} is busy`);
    if (hostSignal.aborted) throw new ToolAbortError();
    const closeAc = new AbortController();
    const finished = Promise.withResolvers();
    session.active = closeAc;
    session.done = finished.promise;
    try {
      const evaluator = session.evaluator ??= this.#options.evaluator();
      return await runCmuxCode(session.tab, { code, timeoutMs, signal: AbortSignal.any([hostSignal, closeAc.signal]), settings: this.#options.settings(), evaluator });
    } finally {
      if (session.active === closeAc) session.active = null;
      finished.resolve();
    }
  }
  async #close(session, reason) {
    session.active?.abort(reason);
    await session.done?.catch(() => void 0);
  }
};

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/kinds/realm.ts
function createKindRealm(parts) {
  const { tab, cmux } = parts;
  return {
    async adopt(name, handle) {
      if (handle.kind === "cmux") {
        await tab.release(name);
        await cmux.adopt(name, handle);
        return;
      }
      if (cmux.has(name)) await cmux.release(name);
      await tab.adopt(name, handle);
    },
    async release(name) {
      if (cmux.has(name)) {
        await cmux.release(name);
        return;
      }
      await tab.release(name);
    },
    async run(request) {
      return cmux.has(request.name) ? await cmux.run(request) : await tab.run(request);
    },
    async call(request) {
      return cmux.has(request.name) ? await cmux.call(request) : await tab.call(request);
    },
    names() {
      return [...tab.names(), ...cmux.names()];
    },
    async end(browserId, reason) {
      await Promise.all([tab.end(browserId, reason), cmux.end(browserId, reason)]);
    },
    async dispose() {
      await Promise.all([tab.dispose(), cmux.dispose()]);
    }
  };
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/serve.ts
import { parentPort } from "node:worker_threads";

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/dispatch.ts
import { isMainThread } from "node:worker_threads";
import { z } from "zod";

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/cell/cell.ts
import { AsyncLocalStorage as AsyncLocalStorage3 } from "node:async_hooks";

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/facade/prelude.js.txt
var prelude_js_default = '// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/prelude.js @ dc5f95d9e1 (Dimension omp fork).\n// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can B\xF6l\xFCk; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.\n// Changed for the Browser pack: nothing. The block below is OMP\'s file, byte for byte.\n{\n	const validateOptions = (label, options) => {\n		if (options === undefined) return {};\n		if (options === null || typeof options !== "object" || Array.isArray(options)) {\n			throw new TypeError(`${label}() expects an options object`);\n		}\n		return options;\n	};\n	const serializeFunction = (label, fn) => {\n		const source = String(fn);\n		if (source.includes("[native code]")) {\n			throw new TypeError(`${label} cannot serialize a native or bound function; pass an arrow or function expression`);\n		}\n		return source;\n	};\n	const encodeArg = (label, value) => {\n		if (typeof value === "function") return { __omp_fn: serializeFunction(label, value) };\n		if (value instanceof RegExp) return { __omp_re: { source: value.source, flags: value.flags } };\n		return value;\n	};\n	const encodeArgs = (label, args) => {\n		const trimmed = [...args];\n		while (trimmed.length > 0 && trimmed[trimmed.length - 1] === undefined) trimmed.pop();\n		return trimmed.map(value => encodeArg(label, value));\n	};\n	const invoke = async (action, options) => {\n		const response = await globalThis.__omp_prelude__("browser", { ...options, action });\n		if (response && typeof response.text === "string" && response.text.length > 0) {\n			globalThis.__omp_display__(response.text);\n		}\n		return response && typeof response.details === "object" && response.details !== null ? response.details : {};\n	};\n	const callValue = async (name, chain) => {\n		const details = await invoke("call", { name, chain });\n		return details.value;\n	};\n	const directMethods = [\n		"url",\n		"title",\n		"goto",\n		"observe",\n		"ariaSnapshot",\n		"screenshot",\n		"extract",\n		"click",\n		"type",\n		"fill",\n		"press",\n		"scroll",\n		"drag",\n		"scrollIntoView",\n		"select",\n		"uploadFile",\n		"waitForUrl",\n		"evaluate",\n		"waitFor",\n		"waitForSelector",\n	];\n	const elementMethods = [\n		"click",\n		"type",\n		"fill",\n		"press",\n		"hover",\n		"focus",\n		"select",\n		"uploadFile",\n		"scrollIntoView",\n		"boundingBox",\n		"isVisible",\n		"isHidden",\n		"evaluate",\n	];\n	const makeElement = (name, handleMethod, handleArgs) => {\n		const element = {};\n		const renderedArgs = handleArgs.map(value => JSON.stringify(value)).join(", ");\n		element.toString = () => `<element tab.${handleMethod}(${renderedArgs}) on ${name}>`;\n		for (const method of elementMethods) {\n			element[method] = (...args) =>\n				callValue(name, [\n					{ method: handleMethod, args: handleArgs },\n					{ method, args: encodeArgs("tab helper argument", args) },\n				]);\n		}\n		return Object.freeze(element);\n	};\n	const makeTab = name => {\n		const tab = {};\n		Object.defineProperty(tab, "name", { value: name, enumerable: true });\n		tab.toString = () => `<tab ${name}>`;\n		for (const method of directMethods) {\n			tab[method] = (...args) => callValue(name, [{ method, args: encodeArgs("tab helper argument", args) }]);\n		}\n		tab.id = id => makeElement(name, "id", encodeArgs("tab helper argument", [id]));\n		tab.ref = id => makeElement(name, "ref", encodeArgs("tab helper argument", [id]));\n		tab.run = async (fnOrCode, options) => {\n			if (typeof fnOrCode !== "function" && typeof fnOrCode !== "string") {\n				throw new TypeError("tab.run() expects a function or code string");\n			}\n			const opts = validateOptions("tab.run", options);\n			const parameters = { name };\n			if (opts.timeout !== undefined) parameters.timeout = opts.timeout;\n			if (typeof fnOrCode === "function") {\n				parameters.fn = serializeFunction("tab.run()", fnOrCode);\n				parameters.args = encodeArgs("tab helper argument", Array.isArray(opts.args) ? opts.args : []);\n			} else {\n				parameters.code = fnOrCode;\n			}\n			const details = await invoke("run", parameters);\n			return details.value;\n		};\n		tab.close = async options => {\n			const opts = validateOptions("tab.close", options);\n			await invoke("close", { ...opts, name });\n		};\n		return Object.freeze(tab);\n	};\n	globalThis.browser = Object.freeze({\n		async open(options) {\n			const opts = validateOptions("browser.open", options);\n			const details = await invoke("open", opts);\n			return makeTab(typeof details.name === "string" ? details.name : opts.name ?? "main");\n		},\n		tab(name = "main") {\n			if (typeof name !== "string" || name.length === 0) {\n				throw new TypeError("browser.tab() expects a tab name");\n			}\n			return makeTab(name);\n		},\n		async close(options) {\n			await invoke("close", validateOptions("browser.close", options));\n		},\n	});\n}\n';

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/facade/pack-extensions.js.txt
var pack_extensions_js_default = '// Written for the Browser pack, to run right after prelude.js.txt (OMP\'s file, byte for byte) in the same realm.\n// What it adds to `browser`, and nothing else: `tabs()` and `active()` (doc 77 matrix B12). OMP\'s own methods are copied over as they are.\n{\n	const base = globalThis.browser;\n	const invoke = async (action, options) => {\n		const response = await globalThis.__omp_prelude__("browser", { ...options, action });\n		if (response && typeof response.text === "string" && response.text.length > 0) {\n			globalThis.__omp_display__(response.text);\n		}\n		return response && typeof response.details === "object" && response.details !== null ? response.details : {};\n	};\n	// The helper names are read off OMP\'s own tab and element handles, so a helper the facade gains is on the active handle too.\n	const sampleTab = base.tab("x");\n	const sampleElement = sampleTab.id(0);\n	const helpers = (handle, skip) => Object.keys(handle).filter(key => typeof handle[key] === "function" && !skip.includes(key));\n	const tabMethods = helpers(sampleTab, ["toString", "id", "ref"]);\n	const elementMethods = helpers(sampleElement, ["toString"]);\n\n	// Every tab handle OMP makes has a string `name`, and `browser.tab(handle.name)` is that tab. The active tab\'s own name is known only after the host has said which tab is active, so its handle is named by an alias\n	// (`active#1`) that `browser.tab` and `browser.close` read back to the handle\'s pinned tab; a tab nobody asked `active()` about is never called that, and only the newest aliases are kept.\n	const MAX_ALIASES = 256;\n	const aliases = new Map();\n	let minted = 0;\n	const makeActiveTab = () => {\n		// The tab is asked for once, on first use, and kept: ids from one `observe()` belong to one tab, even if the human switches tabs between two calls.\n		let found;\n		const nameOfActive = () => {\n			found ??= invoke("active", {}).then(\n				details => {\n					if (typeof details.name !== "string" || details.name.length === 0) throw new Error("browser.active() found no active tab");\n					return details.name;\n				},\n				error => {\n					found = undefined;\n					throw error;\n				},\n			);\n			return found;\n		};\n		const tab = {};\n		const alias = `active#${++minted}`;\n		Object.defineProperty(tab, "name", { value: alias, enumerable: true });\n		tab.toString = () => "<tab active>";\n		for (const method of tabMethods) {\n			tab[method] = async (...args) => base.tab(await nameOfActive())[method](...args);\n		}\n		for (const handleMethod of ["id", "ref"]) {\n			tab[handleMethod] = (...handleArgs) => {\n				const element = {};\n				element.toString = () => `<element tab.${handleMethod}(${handleArgs.map(value => JSON.stringify(value)).join(", ")}) on active>`;\n				for (const method of elementMethods) {\n					element[method] = async (...args) => base.tab(await nameOfActive())[handleMethod](...handleArgs)[method](...args);\n				}\n				return Object.freeze(element);\n			};\n		}\n		const handle = Object.freeze(tab);\n		aliases.set(alias, { handle, nameOfActive });\n		if (aliases.size > MAX_ALIASES) aliases.delete(aliases.keys().next().value);\n		return handle;\n	};\n\n	globalThis.browser = Object.freeze({\n		...base,\n		async tabs() {\n			const details = await invoke("tabs", {});\n			return Array.isArray(details.value) ? details.value : [];\n		},\n		active() {\n			return makeActiveTab();\n		},\n		tab(...args) {\n			return aliases.get(args[0])?.handle ?? base.tab(...args);\n		},\n		async close(options) {\n			const pinned = options !== null && typeof options === "object" ? aliases.get(options.name) : undefined;\n			await base.close(pinned === undefined ? options : { ...options, name: await pinned.nameOfActive() });\n		},\n	});\n}\n';

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/cell/cell.ts
var WORKER_RESET_NOTE = "The JS worker was force-killed and its VM state was reset; variables from earlier cells are gone.";
var CellTimeoutError = class extends Error {
  recoverTab = true;
  budget = true;
  constructor(timeoutMs) {
    super(`Command timed out after ${Math.max(1, Math.round(timeoutMs / 1e3))} seconds. ${WORKER_RESET_NOTE}`);
    this.name = "CellTimeoutError";
  }
};
var callerRun = new AsyncLocalStorage3();
var invokeFailures = /* @__PURE__ */ new WeakMap();
var GLOBAL_KEYS = ["__omp_prelude__", "__omp_display__", "browser"];
var facadeUsers = 0;
function installFacade() {
  if (facadeUsers++ > 0) return;
  const target = globalThis;
  target.__omp_prelude__ = async (name, parameters) => {
    const run = callerRun.getStore();
    if (!run || run.ended) throw new ToolError("browser can only be used while a cell is running");
    if (name !== "browser") throw new ToolError(`Unknown prelude ${JSON.stringify(name)}`);
    let response;
    try {
      throwIfAborted(run.signal);
      response = await run.invoke(parameters, { runId: run.runId, signal: run.signal });
    } catch (error) {
      if (error !== null && typeof error === "object") invokeFailures.set(error, run);
      throw error;
    }
    for (const image of response.images ?? []) run.hooks.onDisplay(image);
    if (response.details.screenshots) run.screenshots.push(...response.details.screenshots);
    return { text: response.text, details: response.details };
  };
  target.__omp_display__ = (value) => {
    const run = callerRun.getStore();
    if (run && !run.ended) displayValue(value, run.hooks);
  };
  const geval = globalThis.eval;
  geval(prelude_js_default);
  geval(pack_extensions_js_default);
}
function uninstallFacade() {
  if (--facadeUsers > 0) return;
  for (const key of GLOBAL_KEYS) delete globalThis[key];
}
function failureOf(error) {
  if (error instanceof Error) {
    const recoverTab = error.recoverTab === true;
    return {
      name: error.name,
      message: error.message,
      ...error.stack === void 0 ? {} : { stack: error.stack },
      isAbort: error.name === "AbortError" || error.name === "ToolAbortError",
      ...recoverTab ? { recoverTab } : {},
      ...error instanceof CellTimeoutError ? { budget: true, resetNoted: true } : {}
    };
  }
  return { name: "Error", message: String(error), isAbort: false };
}
function abandonedFailure(error) {
  if (error.resetNoted === true) return error;
  return { ...error, message: `${error.message.replace(/\.?$/, ".")} ${WORKER_RESET_NOTE}`, recoverTab: true, resetNoted: true };
}
var Abandoned = class {
  constructor(reason) {
    this.reason = reason;
  }
};
var CellFailure = class extends Error {
  constructor(error, partial) {
    super(error.message);
    this.error = error;
    this.partial = partial;
    this.name = error.name;
  }
};
var RECENT_CELL_FILES_MAX = 256;
var CodeCell = class {
  #evaluator;
  #live = /* @__PURE__ */ new Map();
  #recentFiles = /* @__PURE__ */ new Set();
  #uninstallGuard;
  #disposed = false;
  /**
   * `guardRejections`: take part in the process's `unhandledRejection` events so a promise the cell floated fails the run that owns it (OMP: "Unhandled rejection (missing await?)")
   * instead of taking the worker down. One a cell cannot claim is rethrown, as OMP does, so a worker with a real fault still dies.
   */
  constructor(options = {}) {
    this.#evaluator = options.evaluator ?? createCodeEvaluator();
    installFacade();
    this.#uninstallGuard = options.guardRejections ? this.#installGuard() : void 0;
  }
  #installGuard() {
    const onRejection = (reason) => {
      if (this.consumeRejection(reason)) return;
      setTimeout(() => {
        if (!isRejectionHandled(reason)) throw reason;
      }, 0);
    };
    process.on("unhandledRejection", onRejection);
    return () => process.off("unhandledRejection", onRejection);
  }
  /** Whether `reason` is the cell's: a run floated it (kept for that run) or a finished cell did (only logged by the caller). False: not cell activity. */
  consumeRejection(reason) {
    const invoker = reason !== null && typeof reason === "object" ? invokeFailures.get(reason) : void 0;
    if (invoker) {
      if (this.#live.get(invoker.runId) === invoker) {
        invoker.floating.push(reason);
        return true;
      }
      if (this.#recentFiles.has(invoker.filename)) return true;
    }
    const stack = reason instanceof Error && typeof reason.stack === "string" ? reason.stack : void 0;
    if (stack !== void 0) {
      let owner;
      let ownerIndex = -1;
      for (const run of this.#live.values()) {
        const index = stack.lastIndexOf(run.filename);
        if (index > ownerIndex) {
          ownerIndex = index;
          owner = run;
        }
      }
      if (owner) {
        owner.floating.push(reason);
        return true;
      }
      for (const filename of this.#recentFiles) if (stack.includes(filename)) return true;
    }
    const only = this.#live.size === 1 ? this.#live.values().next().value : void 0;
    if (only && stack === void 0) {
      only.floating.push(reason);
      return true;
    }
    return false;
  }
  async run(o) {
    if (this.#disposed) throw new ToolError("The code realm is closed");
    const output = new CellOutput({ ...o.spillDir === void 0 ? {} : { spillDir: o.spillDir }, ...o.onText === void 0 ? {} : { onText: o.onText } });
    const filename = `browser-cell-${o.runId}.js`;
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(new CellTimeoutError(o.timeoutMs)), o.timeoutMs);
    const onCancel = () => budget.abort(o.signal.reason instanceof ToolAbortError ? o.signal.reason : new ToolAbortError(void 0, { cause: o.signal.reason }));
    if (o.signal.aborted) onCancel();
    else o.signal.addEventListener("abort", onCancel, { once: true });
    const signal = budget.signal;
    const run = {
      runId: o.runId,
      filename,
      signal,
      invoke: o.invoke,
      screenshots: [],
      floating: [],
      ended: false,
      hooks: { onText: () => {
      }, onDisplay: () => {
      } }
    };
    const live = output.hooks();
    run.hooks = { onText: (chunk2) => {
      if (!run.ended) live.onText(chunk2);
    }, onDisplay: (display) => {
      if (!run.ended) live.onDisplay(display);
    } };
    this.#live.set(o.runId, run);
    const abandoned = new Promise((_, reject) => {
      if (signal.aborted) reject(new Abandoned(signal.reason));
      else signal.addEventListener("abort", () => reject(new Abandoned(signal.reason)), { once: true });
    });
    abandoned.catch(() => {
    });
    let failure;
    let failed = false;
    let gaveUp = false;
    try {
      throwIfAborted(signal);
      const evaluated = callerRun.run(run, () => this.#evaluator.evaluate(o.code, { filename, scope: {}, hooks: run.hooks }));
      evaluated.catch(() => {
      });
      const value = await Promise.race([evaluated, abandoned]);
      displayValue(value, run.hooks);
      await new Promise((resolve3) => setTimeout(resolve3, 0));
      if (run.floating.length > 0) {
        const [first, ...rest] = run.floating;
        for (const reason of rest) {
          const detail2 = failureOf(reason);
          run.hooks.onText(`[unhandled rejection] ${detail2.name}: ${detail2.message}
`);
        }
        const detail = failureOf(first);
        throw Object.assign(new Error(`Unhandled rejection (missing await?): ${detail.message}`), { name: detail.name });
      }
    } catch (error) {
      failed = true;
      if (error instanceof Abandoned) {
        gaveUp = true;
        failure = error.reason;
      } else {
        failure = error;
      }
    } finally {
      clearTimeout(timer);
      o.signal.removeEventListener("abort", onCancel);
      this.#live.delete(o.runId);
      this.#recentFiles.add(filename);
      if (this.#recentFiles.size > RECENT_CELL_FILES_MAX) this.#recentFiles.delete(this.#recentFiles.values().next().value);
    }
    const { text: text2, images } = output.finish(failed ? ERROR_LINE_BYTES : 0);
    run.ended = true;
    const result = {
      displays: [...images, ...text2.length > 0 ? [{ type: "text", text: text2 }] : []],
      screenshots: run.screenshots
    };
    if (failed) {
      const error = failureOf(failure);
      throw new CellFailure(gaveUp ? abandonedFailure(error) : error, result);
    }
    return result;
  }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#uninstallGuard?.();
    uninstallFacade();
  }
};

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/memory-guard.ts
import { getHeapStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
var MB = 1024 * 1024;
var STRIDE = 16 * MB;
var TYPED_ARRAYS = ["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array"];
var CellMemoryError = class extends RangeError {
  name = "CellMemoryError";
};
function heldBytes() {
  const { used_heap_size, external_memory } = getHeapStatistics();
  return used_heap_size + external_memory;
}
function collectGarbage() {
  try {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc");
    setFlagsFromString("--no-expose-gc");
    gc();
  } catch {
  }
}
function guardAllocations(scope, limitMb, { held = heldBytes, collect = collectGarbage } = {}) {
  const limit = limitMb * MB;
  let unseen = 0;
  let shared = 0;
  const admit = (bytes, label, asked) => {
    unseen += bytes;
    if (unseen < STRIDE) return;
    unseen = 0;
    let now = held() + shared;
    if (now + bytes > limit) {
      collect();
      now = held() + shared;
    }
    if (now + bytes > limit) {
      throw new CellMemoryError(`${label}(${String(asked)}) was refused: this code worker holds ${Math.round(now / MB)} MB and the limit is ${limitMb} MB (DIMENSION_BROWSER_CODE_MEMORY_MB). Nothing was allocated and the cell's variables are intact. Free what you hold, or keep large data in a file and handle it in pieces.`);
    }
  };
  for (const name of ["alloc", "allocUnsafe", "allocUnsafeSlow"]) {
    const original = scope.Buffer[name];
    const label = `Buffer.${name}`;
    scope.Buffer[name] = {
      [name](size, fill, encoding) {
        if (typeof size === "number" && size > 0) admit(size, label, size);
        return original.call(this, size, fill, encoding);
      }
    }[name];
  }
  const wrap = (name) => {
    const original = scope[name];
    if (typeof original !== "function") return;
    const unit = original.BYTES_PER_ELEMENT ?? 1;
    const label = `new ${name}`;
    const counted = name === "SharedArrayBuffer";
    scope[name] = new Proxy(original, {
      construct(target, args, newTarget) {
        const size = args[0];
        if (typeof size === "number" && size > 0) {
          admit(size * unit, label, size);
          if (counted && size >= MB) shared += size;
        }
        return Reflect.construct(target, args, newTarget);
      }
    });
    Object.defineProperty(original.prototype, "constructor", { value: scope[name], writable: true, configurable: true });
  };
  for (const name of ["ArrayBuffer", "SharedArrayBuffer", ...TYPED_ARRAYS]) wrap(name);
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/dispatch.ts
var DEFAULT_TAB_NAME = "main";
var BROWSER_TIMEOUT = { default: 30, min: 1, max: 300 };
var appSchema = z.object({
  path: z.string().optional(),
  cdp_url: z.string().optional(),
  relay: z.boolean().optional(),
  args: z.array(z.string()).optional(),
  target: z.string().optional()
});
var bridgeRequestSchema = z.object({
  action: z.enum(["open", "close", "run", "call", "tabs", "active"]),
  name: z.string().optional(),
  url: z.string().optional(),
  app: appSchema.optional(),
  viewport: z.object({ width: z.number(), height: z.number(), scale: z.number().optional() }).optional(),
  wait_until: z.enum(["load", "domcontentloaded", "networkidle0", "networkidle2"]).optional(),
  dialogs: z.enum(["accept", "dismiss"]).optional(),
  code: z.string().optional(),
  fn: z.string().optional(),
  args: z.array(z.unknown()).optional(),
  chain: z.array(z.object({ method: z.string(), args: z.array(z.unknown()) })).optional(),
  timeout: z.number().optional(),
  all: z.boolean().optional(),
  kill: z.boolean().optional(),
  persist: z.boolean().optional(),
  profile: z.string().optional()
});
function scrubEnvironment(target, env) {
  for (const key of Object.keys(target)) if (!Object.hasOwn(env, key)) delete target[key];
  Object.assign(target, env);
}
function clampBrowserTimeout(raw) {
  const timeout = raw ?? BROWSER_TIMEOUT.default;
  return Math.max(BROWSER_TIMEOUT.min, Math.min(BROWSER_TIMEOUT.max, timeout));
}
function summarize(error) {
  return error.issues.map((issue) => `${issue.path.length > 0 ? `${issue.path.join(".")} ` : ""}${issue.message}`).join("; ");
}
function runTarget(request) {
  const code = request.code?.trim();
  const fn = request.fn?.trim();
  if ((code === void 0 || code.length === 0) === (fn === void 0 || fn.length === 0)) {
    throw new ToolError("Action 'run' requires exactly one of 'code' or 'fn'.");
  }
  return fn !== void 0 && fn.length > 0 ? { fn, args: request.args ?? [] } : { code: code ?? "" };
}
function boundedText(parts) {
  let total2 = Math.max(0, parts.length - 1);
  for (const part of parts) {
    total2 += Buffer.byteLength(part, "utf8");
    if (total2 > MAX_INLINE_BYTES) break;
  }
  if (total2 <= MAX_INLINE_BYTES) return parts.join("\n");
  const sink = new OutputSink();
  parts.forEach((part, index) => {
    if (index > 0) sink.push("\n");
    sink.push(part);
  });
  return `${sink.dump().text}
${TAB_TEXT_CUT_NOTE}`;
}
function boundedImages(images) {
  const kept = [];
  let chars = 0;
  for (const image of images) {
    if (chars + image.data.length > MAX_IMAGE_BASE64_CHARS) continue;
    chars += image.data.length;
    kept.push(image);
  }
  return { kept, dropped: images.length - kept.length };
}
function bridgeResponse(result, details) {
  const { kept: images, dropped } = boundedImages(result.displays.flatMap((part) => part.type === "image" ? [part] : []));
  const note = dropped === 0 ? "" : droppedImagesNote(dropped, MAX_IMAGE_BASE64_CHARS);
  const text2 = [boundedText(result.displays.flatMap((part) => part.type === "text" ? [part.text] : [])), note].filter((part) => part.length > 0).join("\n");
  if (result.screenshots.length > 0) details.screenshots = result.screenshots;
  if (result.returnValue !== void 0) details.value = result.returnValue;
  return { text: text2, details, ...images.length > 0 ? { images } : {} };
}
function createDispatcher(ports) {
  const { realm, host } = ports;
  return async (parameters, { runId, signal }) => {
    const parsed = bridgeRequestSchema.safeParse(parameters);
    if (!parsed.success) throw new ToolError(`browser received invalid arguments: ${summarize(parsed.error)}`);
    const request = parsed.data;
    throwIfAborted(signal);
    const timeoutSeconds = clampBrowserTimeout(request.timeout);
    const timeoutMs = timeoutSeconds * 1e3;
    const name = request.name ?? DEFAULT_TAB_NAME;
    const details = { action: request.action, name };
    switch (request.action) {
      case "open": {
        const reply = await host({ ...request, name, timeout: timeoutSeconds }, { runId, signal });
        if (reply.attach) await realm.adopt(name, reply.attach);
        return { text: reply.text, details: { ...details, ...reply.details, name }, ...reply.images ? { images: reply.images } : {} };
      }
      case "close": {
        const reply = await host({ ...request, name, timeout: timeoutSeconds }, { runId, signal });
        for (const held of request.all ? realm.names() : [name]) await realm.release(held);
        return { text: reply.text, details: { ...details, ...reply.details, name }, ...reply.images ? { images: reply.images } : {} };
      }
      case "tabs": {
        const reply = await host({ ...request, name, timeout: timeoutSeconds }, { runId, signal });
        return { text: reply.text, details: { ...details, ...reply.details, action: "tabs", name: reply.details.name ?? name } };
      }
      case "active": {
        const reply = await host({ ...request, name, timeout: timeoutSeconds }, { runId, signal });
        const found = reply.details.name;
        if (typeof found !== "string" || found.length === 0) throw new ToolError("There is no active tab to drive");
        if (reply.attach) await realm.adopt(found, reply.attach);
        return { text: reply.text, details: { ...details, ...reply.details, action: "active", name: found }, ...reply.images ? { images: reply.images } : {} };
      }
      case "call":
        ports.activity?.(runId, name);
        return bridgeResponse(await realm.call({ name, chain: request.chain ?? [], timeoutMs, signal }), details);
      case "run":
        ports.activity?.(runId, name);
        return bridgeResponse(await realm.run({ name, ...runTarget(request), timeoutMs, signal }), details);
    }
  };
}
function errorOf(payload) {
  if (payload.isAbort) return new ToolAbortError(payload.message);
  const error = payload.name === "ToolError" ? new ToolError(payload.message) : new Error(payload.message);
  error.name = payload.name;
  if (payload.stack !== void 0) error.stack = payload.stack;
  return error;
}
var WorkerCore = class {
  #transport;
  #options;
  #runs = /* @__PURE__ */ new Map();
  #pending = /* @__PURE__ */ new Map();
  #unsubscribe;
  #realm;
  #cell;
  /** The session's folder (from `init`) for the file that keeps a cell's output longer than the inline budget. */
  #outputDir;
  #nextBridgeId = 1;
  #closing = false;
  constructor(options) {
    this.#options = options;
    this.#transport = options.transport;
    this.#unsubscribe = this.#transport.onMessage((message) => this.#handle(message));
  }
  #send(message) {
    try {
      this.#transport.send(message);
    } catch (error) {
      if (!this.#closing) throw error;
    }
  }
  #handle(message) {
    switch (message.t) {
      case "init":
        this.#outputDir = message.outputDir;
        void this.#init(message);
        return;
      case "run":
        void this.#runOne(message.runId, message.code, message.timeoutMs);
        return;
      case "bridge-reply": {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(errorOf(message.error));
        return;
      }
      case "abort":
        this.#runs.get(message.runId)?.abort(new ToolAbortError());
        return;
      case "end":
        void this.#realm?.end(message.browserId, message.reason).catch((error) => this.#send({ t: "log", level: "warn", msg: `Dropping the tabs of ${message.browserId} failed: ${failureOf(error).message}` }));
        return;
      case "close":
        void this.#close();
        return;
    }
  }
  async #init(message) {
    try {
      if (!isMainThread) {
        scrubEnvironment(process.env, message.env);
        if (message.memoryLimitMb !== void 0 && message.memoryLimitMb > 0) guardAllocations(globalThis, message.memoryLimitMb);
      }
      const { session, env, screenshotDir, cwd, refusePasswordFields, excludeWebP } = message;
      const realm = this.#options.createRealm({ session, env, screenshotDir, cwd, refusePasswordFields, excludeWebP });
      this.#realm = realm;
      this.#cell = new CodeCell({ guardRejections: this.#options.guardRejections ?? false });
      for (const { name, handle } of message.tabs ?? []) {
        await realm.adopt(name, handle).catch((error) => this.#send({ t: "log", level: "warn", msg: `Re-adopting tab "${name}" failed: ${failureOf(error).message}` }));
      }
      this.#send({ t: "ready" });
    } catch (error) {
      this.#send({ t: "log", level: "error", msg: `The code worker could not start: ${failureOf(error).message}` });
      void this.#close();
    }
  }
  /** One `open`/`close`/`tabs`/`active` to the host, cancelled with the run that asked. */
  #hostCall(request, { runId, signal }) {
    throwIfAborted(signal);
    const id = this.#nextBridgeId++;
    return new Promise((resolve3, reject) => {
      const onAbort = () => {
        this.#pending.delete(id);
        reject(signal.reason instanceof Error ? signal.reason : new ToolAbortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        runId,
        resolve: (reply) => {
          signal.removeEventListener("abort", onAbort);
          resolve3(reply);
        },
        reject: (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      });
      this.#send({ t: "bridge", id, runId, request });
    });
  }
  async #runOne(runId, code, timeoutMs) {
    const realm = this.#realm;
    const cell = this.#cell;
    if (!realm || !cell) {
      this.#send({ t: "result", runId, ok: false, error: { name: "ToolError", message: "The code worker has not been initialised", isAbort: false } });
      return;
    }
    const controller = new AbortController();
    this.#runs.set(runId, controller);
    const invoke = createDispatcher({ realm, host: (request, o) => this.#hostCall(request, o), activity: (id, name) => this.#send({ t: "activity", runId: id, name }) });
    try {
      const payload = await cell.run({ runId, code, timeoutMs, signal: controller.signal, invoke, onText: (chunk2) => this.#send({ t: "text", runId, chunk: chunk2 }), ...this.#outputDir === void 0 ? {} : { spillDir: this.#outputDir } });
      this.#send({ t: "result", runId, ok: true, payload });
    } catch (error) {
      const error_ = error instanceof CellFailure ? { ...error.error, partial: error.partial } : failureOf(error);
      this.#send({ t: "result", runId, ok: false, error: error_ });
    } finally {
      this.#runs.delete(runId);
      for (const [id, pending] of this.#pending) {
        if (pending.runId !== runId) continue;
        this.#pending.delete(id);
        pending.reject(new ToolAbortError());
      }
    }
  }
  async #close() {
    if (this.#closing) return;
    this.#closing = true;
    for (const controller of this.#runs.values()) controller.abort(new ToolAbortError());
    this.#unsubscribe();
    try {
      await this.#realm?.dispose();
    } catch (error) {
      this.#transport.send({ t: "log", level: "warn", msg: `Closing the tab realm failed: ${failureOf(error).message}` });
    }
    this.#cell?.dispose();
    this.#transport.send({ t: "closed" });
    this.#transport.close();
  }
};

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/serve.ts
function serveOnParentPort(createRealm) {
  const port = parentPort;
  if (!port) throw new Error("The code worker must run in a worker thread");
  const transport = {
    send: (message) => port.postMessage(message),
    onMessage: (handler) => {
      const listener = (message) => handler(message);
      port.on("message", listener);
      return () => port.off("message", listener);
    },
    close: () => port.close()
  };
  return new WorkerCore({ transport, guardRejections: true, createRealm });
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/tab-realm.ts
import { isMainThread as isMainThread2 } from "node:worker_threads";
import puppeteer from "puppeteer-core";

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/run-error.ts
var RequestInterceptionCleanupError = class extends ToolError {
  recoverTab = true;
};

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/run-page-scope.ts
var REQUEST_INTERCEPTION_CLEANUP_TIMEOUT_MS = 500;
function createRunPageScope(page) {
  const requestHandlers = [];
  const on = page.on;
  const off = page.off;
  const once = page.once;
  const removeAllListeners = page.removeAllListeners;
  const onDescriptor = Object.getOwnPropertyDescriptor(page, "on");
  const offDescriptor = Object.getOwnPropertyDescriptor(page, "off");
  const onceDescriptor = Object.getOwnPropertyDescriptor(page, "once");
  const removeAllDescriptor = Object.getOwnPropertyDescriptor(page, "removeAllListeners");
  Object.defineProperties(page, {
    on: {
      configurable: true,
      value: (type, handler) => {
        Reflect.apply(on, page, [type, handler]);
        if (type === "request") requestHandlers.push(handler);
        return page;
      }
    },
    once: {
      configurable: true,
      value: (type, handler) => {
        if (type !== "request" || typeof handler !== "function") {
          Reflect.apply(once, page, [type, handler]);
          return page;
        }
        const wrapper = (event) => {
          const index = requestHandlers.lastIndexOf(wrapper);
          if (index >= 0) requestHandlers.splice(index, 1);
          Reflect.apply(off, page, ["request", wrapper]);
          Reflect.apply(handler, page, [event]);
        };
        requestHandlers.push(wrapper);
        Reflect.apply(on, page, [type, wrapper]);
        return page;
      }
    },
    off: {
      configurable: true,
      value: (type, handler) => {
        Reflect.apply(off, page, [type, handler]);
        if (type === "request") {
          if (handler === void 0) requestHandlers.length = 0;
          else {
            const index = requestHandlers.lastIndexOf(handler);
            if (index >= 0) requestHandlers.splice(index, 1);
          }
        }
        return page;
      }
    },
    removeAllListeners: {
      configurable: true,
      value: (type) => {
        Reflect.apply(removeAllListeners, page, [type]);
        if (type === void 0 || type === "request") requestHandlers.length = 0;
        return page;
      }
    }
  });
  return {
    page,
    async cleanup() {
      if (onDescriptor) Object.defineProperty(page, "on", onDescriptor);
      else Reflect.deleteProperty(page, "on");
      if (offDescriptor) Object.defineProperty(page, "off", offDescriptor);
      else Reflect.deleteProperty(page, "off");
      if (onceDescriptor) Object.defineProperty(page, "once", onceDescriptor);
      else Reflect.deleteProperty(page, "once");
      if (removeAllDescriptor) Object.defineProperty(page, "removeAllListeners", removeAllDescriptor);
      else Reflect.deleteProperty(page, "removeAllListeners");
      for (const handler of requestHandlers) Reflect.apply(off, page, ["request", handler]);
      requestHandlers.length = 0;
      try {
        await withTimeout(
          page.setRequestInterception(false),
          REQUEST_INTERCEPTION_CLEANUP_TIMEOUT_MS,
          "Timed out clearing browser request interception"
        );
      } catch (error) {
        throw new RequestInterceptionCleanupError("Failed to clear browser request interception after browser.run", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/tab-api.ts
import * as os4 from "node:os";
import * as path4 from "node:path";

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/handles.ts
var HANDLE_ACTION_INVALIDATION_TIMEOUT_MS = 500;
var GUARDED_HANDLE_METHODS = [
  "click",
  "type",
  "hover",
  "tap",
  "focus",
  "press",
  "select",
  "uploadFile",
  "scrollIntoView",
  "drag",
  "dragEnter",
  "dragOver",
  "drop",
  "dragAndDrop",
  "touchStart",
  "touchMove",
  "touchEnd",
  "autofill"
];
var RAW_HANDLE_METHODS = Symbol("browser.rawHandleMethods");
async function runGuardedHandleAction(handle, state, label, signal, action, invalidate) {
  if (state.invalidatedBy) {
    throw new ToolError(
      `${label} cannot run: this handle was invalidated after ${state.invalidatedBy} timed out; run tab.observe() or tab.ariaSnapshot() to resolve a fresh handle`
    );
  }
  throwIfAborted(signal);
  const pending = action();
  try {
    return await untilAborted(signal, () => pending);
  } catch (error) {
    if (!signal.aborted) throw error;
    state.invalidatedBy = label;
    void pending.catch(() => void 0);
    await withTimeout(
      Promise.all([handle.dispose().catch(() => void 0), invalidate?.().catch(() => void 0)]),
      HANDLE_ACTION_INVALIDATION_TIMEOUT_MS,
      `Timed out invalidating ${label}`
    ).catch(() => void 0);
    throw error;
  }
}
function toActionableHandle(handle, guard, invalidate) {
  const enriched = handle;
  const methods = enriched;
  const preserved = enriched[RAW_HANDLE_METHODS];
  if (!guard) {
    if (preserved) {
      for (const method of GUARDED_HANDLE_METHODS) {
        const original = preserved.interactive[method];
        if (original) methods[method] = original;
      }
    }
    enriched.fill = (value) => fillViaHandle(enriched, value, void 0, preserved?.type);
    return enriched;
  }
  let originals = preserved;
  if (!originals) {
    const interactive = {};
    for (const method of GUARDED_HANDLE_METHODS) {
      const original = methods[method];
      if (typeof original === "function") interactive[method] = original.bind(enriched);
    }
    originals = { interactive, type: enriched.type.bind(enriched) };
    enriched[RAW_HANDLE_METHODS] = originals;
  }
  for (const method of GUARDED_HANDLE_METHODS) {
    if (method === "type") continue;
    const original = originals.interactive[method];
    if (!original) continue;
    methods[method] = (...args) => guard(
      `handle.${method}()`,
      (signal) => runGuardedHandleAction(
        enriched,
        originals,
        `handle.${method}()`,
        signal,
        () => original(...args),
        invalidate
      )
    );
  }
  enriched.type = (text2, options) => guard(
    "handle.type()",
    (signal) => runGuardedHandleAction(
      enriched,
      originals,
      "handle.type()",
      signal,
      () => typeViaHandle(enriched, text2, options, signal),
      invalidate
    )
  );
  enriched.fill = (value) => guard(
    "handle.fill()",
    (signal) => runGuardedHandleAction(
      enriched,
      originals,
      "handle.fill()",
      signal,
      () => fillViaHandle(enriched, value, signal, (text2) => typeViaHandle(enriched, text2, { delay: 0 }, signal)),
      invalidate
    )
  );
  return enriched;
}
async function typeViaHandle(handle, text2, options, signal) {
  await untilAborted(
    signal,
    () => handle.evaluate((el) => {
      const node = el;
      node.focus?.();
    })
  );
  for (const character of text2) {
    throwIfAborted(signal);
    await untilAborted(signal, () => handle.frame.page().keyboard.type(character, options));
  }
}
async function fillViaHandle(handle, value, signal, type = (text2) => handle.type(text2, { delay: 0 })) {
  await untilAborted(
    signal,
    () => handle.evaluate((el) => {
      const node = el;
      node.focus?.();
      if ("value" in node) node.value = "";
    })
  );
  await untilAborted(signal, () => type(value));
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/observe.ts
var INTERACTIVE_AX_ROLES = {
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
  treeitem: true
};
function isInteractiveNode(node) {
  if (INTERACTIVE_AX_ROLES[node.role] === true) return true;
  return node.checked !== void 0 || node.pressed !== void 0 || node.selected !== void 0 || node.expanded !== void 0 || node.focused === true;
}
async function collectObservationEntries(elements2, node, entries, options) {
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
        const id = elements2.nextId();
        const states = [];
        if (node.disabled) states.push("disabled");
        if (node.checked !== void 0) states.push(`checked=${String(node.checked)}`);
        if (node.pressed !== void 0) states.push(`pressed=${String(node.pressed)}`);
        if (node.selected !== void 0) states.push(`selected=${String(node.selected)}`);
        if (node.expanded !== void 0) states.push(`expanded=${String(node.expanded)}`);
        if (node.required) states.push("required");
        if (node.readonly) states.push("readonly");
        if (node.multiselectable) states.push("multiselectable");
        if (node.multiline) states.push("multiline");
        if (node.modal) states.push("modal");
        if (node.focused) states.push("focused");
        elements2.set(id, handle);
        entries.push({
          id,
          role: node.role,
          name: node.name,
          value: node.value,
          description: node.description,
          keyshortcuts: node.keyshortcuts,
          states
        });
      } else {
        await handle.dispose();
      }
    }
  }
  for (const child of node.children ?? []) {
    await collectObservationEntries(elements2, child, entries, options);
  }
}
async function collectObservation(page, elements2, options) {
  elements2.clear();
  const includeAll = options.includeAll ?? false;
  const viewportOnly = options.viewportOnly ?? false;
  const snapshot = await untilAborted(
    options.signal,
    () => page.accessibility.snapshot({ interestingOnly: !includeAll })
  );
  if (!snapshot) throw new ToolError("Accessibility snapshot unavailable");
  const entries = [];
  await collectObservationEntries(elements2, snapshot, entries, { includeAll, viewportOnly });
  const scroll = await untilAborted(
    options.signal,
    () => page.evaluate(() => {
      const doc = document.documentElement;
      return {
        x: window.scrollX,
        y: window.scrollY,
        width: window.innerWidth,
        height: window.innerHeight,
        scrollWidth: doc.scrollWidth,
        scrollHeight: doc.scrollHeight,
        deviceScaleFactor: window.devicePixelRatio
      };
    })
  );
  const { deviceScaleFactor, ...frame } = scroll;
  return {
    url: page.url(),
    title: await untilAborted(options.signal, () => page.title()),
    viewport: { width: frame.width, height: frame.height, deviceScaleFactor },
    scroll: frame,
    elements: entries
  };
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/password-guard.ts
var MAX_FRAME_HOPS = 16;
var TEXT_KEY_NAME = /^(?:Key[A-Z]|Digit\d|Numpad(?:\d|Add|Subtract|Multiply|Divide|Decimal)|Space|Backquote|Minus|Equal|Bracket(?:Left|Right)|Backslash|Semicolon|Quote|Comma|Period|Slash|IntlBackslash)$/;
function producesText(key) {
  return [...key].length === 1 || TEXT_KEY_NAME.test(key);
}
function focusedKindHere() {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  if (element instanceof HTMLIFrameElement || element instanceof HTMLFrameElement) return "frame";
  return element instanceof HTMLInputElement && element.type === "password" ? "password" : "other";
}
function focusedElementHere() {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}
async function keysReachPasswordField(page, sig) {
  let frame = page.mainFrame();
  for (let hop = 0; hop < MAX_FRAME_HOPS; hop++) {
    const kind = await untilAborted(sig, () => frame.evaluate(focusedKindHere));
    if (kind !== "frame") return kind === "password";
    const iframe = (await untilAborted(sig, () => frame.evaluateHandle(focusedElementHere))).asElement();
    if (!iframe) return false;
    try {
      const inner = await untilAborted(sig, () => iframe.contentFrame());
      if (!inner) return false;
      frame = inner;
    } finally {
      await iframe.dispose().catch(() => void 0);
    }
  }
  return true;
}
function refusal(subject) {
  return new ToolError(
    `${subject}; browser_run does not type into password fields from code. Ask the user to type it themselves in the Browser View, where they can drive this browser, or to sign in to a saved profile with browser_view({ profile }) so the login is kept. Then carry on from the page they leave.`
  );
}
function createPasswordGuard(page) {
  return {
    async beforeTyping(target, label, sig) {
      if (await untilAborted(sig, () => target.evaluate((el) => el instanceof HTMLInputElement && el.type === "password"))) throw refusal(`${label} is a password field`);
      await untilAborted(sig, () => target.evaluate((el) => el.focus?.()));
      if (await keysReachPasswordField(page, sig)) throw refusal(`typing into ${label} would reach a password field (the focused element is one)`);
    },
    async beforePress(key, label, sig) {
      if (producesText(key) && await keysReachPasswordField(page, sig)) throw refusal(`${label} would reach a password field (the focused element is one)`);
    }
  };
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/tab-ops.ts
var QUICK_OP_TIMEOUT_MS = 2e4;
var ACTION_OP_TIMEOUT_MS = 8e3;
var SCROLL_ACK_TIMEOUT_MS = 2e3;
var OP_DEADLINE_SLACK_MS = CELL_BUDGET_SLACK_MS;
var ZERO_MATCH_FAIL_FAST_MS = 2e3;
var ZERO_MATCH_POLL_MS = 250;
function resolveOpTimeouts(cellTimeoutMs) {
  const budgetBound = Math.max(1, cellTimeoutMs - OP_DEADLINE_SLACK_MS);
  return {
    budgetBound,
    quickOpMs: Math.min(budgetBound, QUICK_OP_TIMEOUT_MS),
    actionOpMs: Math.min(budgetBound, ACTION_OP_TIMEOUT_MS)
  };
}
async function dispatchScroll(dispatch, ackTimeoutMs = SCROLL_ACK_TIMEOUT_MS) {
  const deadline = Promise.withResolvers();
  const timer = setTimeout(() => deadline.resolve(), ackTimeoutMs);
  timer.unref();
  try {
    await Promise.race([dispatch(), deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
}
function resolveWaitTimeout(cellTimeoutMs, explicit) {
  const { budgetBound, actionOpMs } = resolveOpTimeouts(cellTimeoutMs);
  if (explicit === void 0) return actionOpMs;
  if (explicit === 0 || explicit === Number.POSITIVE_INFINITY) return budgetBound;
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(explicit, budgetBound);
  return actionOpMs;
}
function formatSelectorMatchHint(count) {
  return count === 0 ? "; selector currently matches no elements \u2014 run tab.observe() or tab.ariaSnapshot() to inspect the page" : `; selector currently matches ${count} element(s) but the action never became possible \u2014 the element may be hidden or covered (try tab.scrollIntoView() or a more specific selector)`;
}
function describeInflight(inflight) {
  const now = Date.now();
  return [...inflight.values()].sort((a, b) => a.startedAt - b.startedAt).map((op) => `${op.label} (${((now - op.startedAt) / 1e3).toFixed(1)}s)`).join(", ");
}
var OpRunner = class {
  #page;
  constructor(page) {
    this.#page = page;
  }
  /**
   * Wrap a tab helper so it (a) registers in the active run's in-flight map for
   * timeout diagnostics and (b) honors an optional per-op deadline that fails fast
   * with a named error instead of silently consuming the whole cell budget. Pass
   * `Number.POSITIVE_INFINITY` for `perOpTimeoutMs` to bound the op only by the cell
   * budget (used for `evaluate` running user code and for locator helpers that already
   * carry puppeteer's own `.setTimeout(timeoutMs)`). When the op targets a `selector`,
   * the fail-fast timeout carries a best-effort match-count hint, and — when
   * `zeroMatchAfterMs` is set — a watchdog aborts the op early once the selector has
   * matched nothing for that long.
   */
  async runOp(active, label, cellSignal, perOpTimeoutMs, fn, opts) {
    const opId = active.opCounter++;
    active.inflight.set(opId, { label, startedAt: Date.now() });
    const capped = Number.isFinite(perOpTimeoutMs) && perOpTimeoutMs > 0;
    const opTimeout = capped ? AbortSignal.timeout(perOpTimeoutMs) : void 0;
    const opSignal = opTimeout ? AbortSignal.any([cellSignal, opTimeout]) : cellSignal;
    const selector = opts?.selector;
    const watchdog = selector !== void 0 && opts?.zeroMatchAfterMs !== void 0 && parseAriaRefSelector(selector) === null ? { selector, afterMs: opts.zeroMatchAfterMs } : void 0;
    const earlyAc = new AbortController();
    try {
      if (!watchdog) return await fn(opSignal);
      const racedSignal = AbortSignal.any([opSignal, earlyAc.signal]);
      return await Promise.race([
        fn(racedSignal),
        this.#zeroMatchWatchdog(watchdog.selector, label, watchdog.afterMs, racedSignal)
      ]);
    } catch (err) {
      if (capped && !cellSignal.aborted && (opTimeout?.aborted || err instanceof Error && err.name === "TimeoutError")) {
        const hint = selector ? await this.#selectorTimeoutHint(selector) : "";
        throw markBrowserRunRejection(
          new ToolError(`${label} timed out after ${perOpTimeoutMs}ms${hint}`),
          active.rejectionOwner
        );
      }
      throw markBrowserRunRejection(err, active.rejectionOwner);
    } finally {
      earlyAc.abort();
      active.inflight.delete(opId);
    }
  }
  /**
   * Fail-fast arm raced against a selector op: rejects once the selector has matched
   * nothing for the whole `afterMs` window, so a wrong selector or wrong page (consent
   * wall, pre-navigation document) costs ~2s instead of the full action deadline.
   * Disarms — hangs until the settled race drops it — the moment at least one element
   * matches; an inconclusive probe (mid-navigation, detached frame) never counts
   * toward the zero-match window.
   */
  async #zeroMatchWatchdog(selector, label, afterMs, signal) {
    const page = this.#page();
    const resolved = normalizeSelector(selector);
    const deadline = Date.now() + afterMs;
    while (!signal.aborted) {
      let count = null;
      try {
        const handles = await page.$$(resolved);
        count = handles.length;
        for (const handle of handles) void handle.dispose().catch(() => void 0);
      } catch {
      }
      if (count !== null && count > 0) break;
      if (count === 0 && Date.now() >= deadline) {
        throw new ToolError(`${label} failed fast after ${afterMs}ms${formatSelectorMatchHint(0)}`);
      }
      try {
        await untilAborted(signal, () => sleep(ZERO_MATCH_POLL_MS));
      } catch {
        break;
      }
    }
    return await new Promise(() => {
    });
  }
  /**
   * Best-effort match-count probe for a timed-out selector op. Never throws;
   * empty string when the probe fails, stalls, or the selector is an aria-ref.
   */
  async #selectorTimeoutHint(selector) {
    if (parseAriaRefSelector(selector) !== null) return "";
    try {
      const handles = await Promise.race([
        this.#page().$$(normalizeSelector(selector)),
        sleep(1e3).then(() => null)
      ]);
      if (!handles) return "";
      const count = handles.length;
      for (const handle of handles) void handle.dispose().catch(() => void 0);
      return formatSelectorMatchHint(count);
    } catch {
      return "";
    }
  }
};

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/tab-api.ts
var TEXT_CLICK_LOOP_SLACK_MS = 250;
function textClickLoopMs(actionOpMs) {
  return Math.max(1, actionOpMs / 2, actionOpMs - TEXT_CLICK_LOOP_SLACK_MS);
}
async function resolveActionableQueryHandlerClickTarget(handles) {
  const candidates = [];
  for (const handle of handles) {
    let clickable = handle;
    let clickableProxy = null;
    try {
      const proxy = await handle.evaluateHandle((el) => {
        const target = el.closest('a,button,[role="button"],[role="link"],input[type="button"],input[type="submit"]') ?? el;
        return target;
      });
      clickableProxy = proxy.asElement() ? proxy.asElement() : null;
      if (clickableProxy) clickable = clickableProxy;
    } catch {
    }
    try {
      const intersecting = await clickable.isIntersectingViewport();
      if (!intersecting) continue;
      const rect = await clickable.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      });
      if (rect.w < 1 || rect.h < 1) continue;
      candidates.push({ handle: clickable, rect, ownedProxy: clickableProxy ?? void 0 });
    } catch {
    } finally {
      if (clickableProxy && clickableProxy !== handle && clickable !== clickableProxy) {
        await clickableProxy.dispose().catch(() => void 0);
      }
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  const winner = candidates[0]?.handle ?? null;
  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (candidate.ownedProxy) await candidate.ownedProxy.dispose().catch(() => void 0);
  }
  return winner;
}
async function isClickActionable(handle) {
  return await handle.evaluate((el) => {
    const element = el;
    const style = globalThis.getComputedStyle(element);
    if (style.display === "none") return { ok: false, reason: "display:none" };
    if (style.visibility === "hidden") return { ok: false, reason: "visibility:hidden" };
    if (style.pointerEvents === "none") return { ok: false, reason: "pointer-events:none" };
    if (Number(style.opacity) === 0) return { ok: false, reason: "opacity:0" };
    const r = element.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return { ok: false, reason: "zero-size" };
    const left = Math.max(0, Math.min(globalThis.innerWidth, r.left));
    const right = Math.max(0, Math.min(globalThis.innerWidth, r.right));
    const top = Math.max(0, Math.min(globalThis.innerHeight, r.top));
    const bottom = Math.max(0, Math.min(globalThis.innerHeight, r.bottom));
    if (right - left < 1 || bottom - top < 1) return { ok: false, reason: "off-viewport" };
    const x = Math.floor((left + right) / 2);
    const y = Math.floor((top + bottom) / 2);
    const topEl = globalThis.document.elementFromPoint(x, y);
    if (!topEl) return { ok: false, reason: "elementFromPoint-null" };
    if (topEl === element || element.contains(topEl) || topEl.contains(element)) return { ok: true, x, y };
    return { ok: false, reason: "obscured" };
  });
}
async function clickQueryHandlerText(page, selector, timeoutMs, signal) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const clickSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const start = Date.now();
  let lastSeen = 0;
  let lastReason = null;
  const timedOut = () => new ToolError(
    `Timed out clicking ${selector} (seen ${lastSeen} matches; last reason: ${lastReason ?? "unknown"}). If there are multiple matching elements, use observe + tab.id() or a more specific selector.`
  );
  try {
    while (Date.now() - start < timeoutMs) {
      throwIfAborted(clickSignal);
      const handles = await untilAborted(clickSignal, () => page.$$(selector));
      try {
        lastSeen = handles.length;
        const target = await resolveActionableQueryHandlerClickTarget(handles);
        if (!target) {
          lastReason = handles.length ? "no-visible-candidate" : "no-matches";
          await untilAborted(clickSignal, () => sleep(100));
          continue;
        }
        const actionability = await isClickActionable(target);
        if (!actionability.ok) {
          lastReason = actionability.reason;
          await untilAborted(clickSignal, () => sleep(100));
          continue;
        }
        try {
          await untilAborted(clickSignal, () => target.click());
          return;
        } catch (err) {
          lastReason = err instanceof Error ? err.message : String(err);
          await untilAborted(clickSignal, () => sleep(100));
        }
      } finally {
        await Promise.all(handles.map(async (handle) => handle.dispose().catch(() => void 0)));
      }
    }
  } catch (err) {
    if (timeoutSignal.aborted && !signal?.aborted) throw timedOut();
    throw err;
  }
  throw timedOut();
}
function resolveUploadPath(filePath, cwd) {
  const expanded = filePath === "~" ? os4.homedir() : /^~[\\/]/.test(filePath) ? path4.join(os4.homedir(), filePath.slice(2)) : filePath;
  if (path4.isAbsolute(expanded)) return expanded;
  if (cwd) return path4.resolve(cwd, expanded);
  throw new ToolError(
    `tab.uploadFile() needs an absolute path; got ${JSON.stringify(filePath)}. browser_run has no working directory to resolve a relative path against.`
  );
}
function createTabApi(c, output, screenshots) {
  const { session, run, signal, timeoutMs, shot } = c;
  const { page, elements: elements2 } = session;
  const { budgetBound, quickOpMs, actionOpMs } = resolveOpTimeouts(timeoutMs);
  const waitMs = (explicit) => resolveWaitTimeout(timeoutMs, explicit);
  const INF = Number.POSITIVE_INFINITY;
  const op = (label, perOpMs, fn, selectorOpts) => markHandled(session.ops.runOp(run, label, signal, perOpMs, fn, selectorOpts));
  const passwordGuard = createPasswordGuard(page);
  const resolveAriaRef = async (id) => {
    const ref = parseAriaRefSelector(id) ?? id.trim();
    const handle = await resolveAriaRefHandle(page, ref);
    if (!handle) {
      throw new ToolError(
        `Unknown ARIA ref ${JSON.stringify(ref)}. Run tab.ariaSnapshot() to refresh refs (they renumber each snapshot).`
      );
    }
    return handle;
  };
  const resolveActionHandle = async (selector, ms, sig) => {
    if (parseAriaRefSelector(selector) !== null) return resolveAriaRef(selector);
    return await untilAborted(
      sig,
      () => page.locator(normalizeSelector(selector)).setTimeout(ms).waitHandle({ signal: sig })
    );
  };
  const enrich = (handle) => {
    const enriched = toActionableHandle(
      handle,
      (label, fn) => op(label, actionOpMs, fn),
      async () => {
        elements2.clear();
        await session.stopLoading();
      }
    );
    if (c.refusePasswordFields) {
      const type = enriched.type.bind(enriched);
      const fill = enriched.fill.bind(enriched);
      enriched.type = async (...args) => {
        await passwordGuard.beforeTyping(enriched, "handle", signal);
        return type(...args);
      };
      enriched.fill = async (value) => {
        await passwordGuard.beforeTyping(enriched, "handle", signal);
        return fill(value);
      };
    }
    return enriched;
  };
  const drag = async (from, to, sig) => {
    const resolveDragPoint = async (target, role) => {
      if (typeof target === "string") {
        const handle = parseAriaRefSelector(target) !== null ? await resolveAriaRef(target) : await untilAborted(sig, () => page.$(normalizeSelector(target)));
        if (!handle) throw new ToolError(`Drag ${role} selector did not resolve: ${target}`);
        const box = await untilAborted(sig, () => handle.boundingBox());
        if (!box) {
          await handle.dispose().catch(() => void 0);
          throw new ToolError(`Drag ${role} element has no bounding box (likely not visible): ${target}`);
        }
        return { x: box.x + box.width / 2, y: box.y + box.height / 2, handle };
      }
      if (target !== null && typeof target === "object" && typeof target.x === "number" && typeof target.y === "number") {
        return { x: target.x, y: target.y };
      }
      throw new ToolError(`Drag ${role} must be a selector string or { x: number, y: number } point. Got: ${typeof target}`);
    };
    const start = await resolveDragPoint(from, "from");
    let end;
    try {
      end = await resolveDragPoint(to, "to");
      await untilAborted(sig, () => page.mouse.move(start.x, start.y));
      await untilAborted(sig, () => page.mouse.down());
      await untilAborted(sig, () => page.mouse.move(end.x, end.y, { steps: 12 }));
      await untilAborted(sig, () => page.mouse.up());
    } finally {
      if (start.handle) await start.handle.dispose().catch(() => void 0);
      if (end?.handle) await end.handle.dispose().catch(() => void 0);
    }
  };
  const select = async (selector, values, ms, sig) => {
    const handle = await resolveActionHandle(selector, ms, sig);
    try {
      return await untilAborted(
        sig,
        () => handle.evaluate((el, vals) => {
          const sel = el;
          if (sel?.tagName !== "SELECT") throw new Error("tab.select() requires a <select> element");
          const EventCtor = globalThis.Event;
          const wanted = new Set(vals);
          for (let i = 0; i < sel.options.length; i++) {
            const opt = sel.options[i];
            opt.selected = wanted.has(opt.value);
          }
          const selected = [];
          for (let i = 0; i < sel.options.length; i++) {
            const opt = sel.options[i];
            if (opt.selected) selected.push(opt.value);
          }
          sel.dispatchEvent(new EventCtor("input", { bubbles: true }));
          sel.dispatchEvent(new EventCtor("change", { bubbles: true }));
          return selected;
        }, values)
      );
    } finally {
      await handle.dispose().catch(() => void 0);
    }
  };
  const uploadFile = async (selector, filePaths, ms, sig) => {
    if (!filePaths.length) throw new ToolError("tab.uploadFile() requires at least one file path");
    const handle = await resolveActionHandle(selector, ms, sig);
    try {
      const absolute = filePaths.map((filePath) => resolveUploadPath(filePath, c.cwd));
      const upload = handle;
      const tagName = await untilAborted(sig, () => handle.evaluate((el) => el.tagName));
      if (tagName !== "INPUT") {
        throw new ToolError(`tab.uploadFile() requires an <input type="file"> element (got <${tagName.toLowerCase()}>)`);
      }
      await untilAborted(sig, () => upload.uploadFile(...absolute));
    } finally {
      await handle.dispose().catch(() => void 0);
    }
  };
  const waitForUrl = async (pattern, timeout, sig) => {
    const isRegex = pattern instanceof RegExp;
    const matcher = isRegex ? pattern.source : pattern;
    const flags = isRegex ? pattern.flags : "";
    await untilAborted(
      sig,
      () => page.waitForFunction(
        (m, isRe, fl) => {
          const url = globalThis.location.href;
          return isRe ? new RegExp(m, fl).test(url) : url.includes(m);
        },
        { timeout, polling: 200, signal: sig },
        matcher,
        isRegex,
        flags
      )
    );
    return page.url();
  };
  const waitForResponse = async (pattern, timeout, sig) => {
    const predicate = typeof pattern === "function" ? pattern : pattern instanceof RegExp ? (response) => pattern.test(response.url()) : (response) => response.url().includes(pattern);
    return await untilAborted(sig, () => page.waitForResponse(predicate, { timeout, signal: sig }));
  };
  return {
    name: session.name,
    page,
    signal,
    url: () => page.url(),
    title: () => op("tab.title()", INF, (sig) => untilAborted(sig, () => page.title())),
    goto: (url, opts) => op(`tab.goto(${JSON.stringify(url)})`, INF, async (sig) => {
      elements2.clear();
      try {
        await untilAborted(sig, () => page.goto(url, { waitUntil: opts?.waitUntil ?? "load", timeout: budgetBound }));
      } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") {
          await session.stopLoading();
          throw new ToolError(
            `tab.goto(${JSON.stringify(url)}) timed out after ${budgetBound}ms; pending navigation stopped \u2014 retry with a longer tool timeout or waitUntil:"domcontentloaded"`
          );
        }
        throw err;
      }
    }),
    observe: (opts) => op("tab.observe()", quickOpMs, (sig) => collectObservation(page, elements2, { ...opts, signal: sig })),
    ariaSnapshot: (selector, opts) => op(selector ? `tab.ariaSnapshot(${JSON.stringify(selector)})` : "tab.ariaSnapshot()", quickOpMs, async (sig) => {
      let root = null;
      if (selector) {
        root = await untilAborted(sig, () => page.$(normalizeSelector(selector)));
        if (!root) throw new ToolError(`tab.ariaSnapshot: selector ${JSON.stringify(selector)} matched no element`);
      }
      try {
        return await untilAborted(sig, () => captureAriaSnapshot(page, root, opts));
      } finally {
        await root?.dispose().catch(() => void 0);
      }
    }),
    screenshot: (opts) => op(
      describeScreenshot(opts),
      quickOpMs,
      (sig) => captureScreenshot(
        {
          page,
          cdp: () => session.cdp(),
          resolveElement: async (selector) => parseAriaRefSelector(selector) !== null ? resolveAriaRef(selector) : await untilAborted(sig, () => page.$(normalizeSelector(selector)))
        },
        shot,
        output,
        screenshots,
        sig,
        opts
      )
    ),
    extract: (format = "markdown") => op(`tab.extract(${JSON.stringify(format)})`, quickOpMs, async (sig) => {
      const html = await untilAborted(sig, () => page.content());
      const result = await extractReadableFromHtml(html, page.url(), format);
      if (!result) {
        throw new ToolError(`tab.extract(${JSON.stringify(format)}) found no readable content on ${page.url()}`);
      }
      const content = format === "markdown" ? result.markdown : result.text;
      if (!content) {
        throw new ToolError(`tab.extract(${JSON.stringify(format)}) produced empty ${format} content for ${page.url()}`);
      }
      return content;
    }),
    click: (selector) => op(
      `tab.click(${JSON.stringify(selector)})`,
      actionOpMs,
      async (sig) => {
        if (parseAriaRefSelector(selector) !== null) {
          const handle = await resolveAriaRef(selector);
          try {
            await untilAborted(sig, () => handle.click());
          } finally {
            await handle.dispose().catch(() => void 0);
          }
          return;
        }
        const resolved = normalizeSelector(selector);
        if (resolved.startsWith("text/")) await clickQueryHandlerText(page, resolved, textClickLoopMs(actionOpMs), sig);
        else await untilAborted(sig, () => page.locator(resolved).setTimeout(actionOpMs).click({ signal: sig }));
      },
      { selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS }
    ),
    type: (selector, text2) => op(
      `tab.type(${JSON.stringify(selector)})`,
      actionOpMs,
      async (sig) => {
        const handle = await resolveActionHandle(selector, actionOpMs, sig);
        try {
          if (c.refusePasswordFields) await passwordGuard.beforeTyping(handle, JSON.stringify(selector), sig);
          await untilAborted(sig, () => handle.type(text2, { delay: 0 }));
        } finally {
          await handle.dispose().catch(() => void 0);
        }
      },
      { selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS }
    ),
    fill: (selector, value) => op(
      `tab.fill(${JSON.stringify(selector)})`,
      actionOpMs,
      async (sig) => {
        if (parseAriaRefSelector(selector) !== null) {
          const handle = await resolveAriaRef(selector);
          try {
            if (c.refusePasswordFields) await passwordGuard.beforeTyping(handle, JSON.stringify(selector), sig);
            await fillViaHandle(handle, value, sig);
          } finally {
            await handle.dispose().catch(() => void 0);
          }
          return;
        }
        const locator = page.locator(normalizeSelector(selector)).setTimeout(actionOpMs);
        if (!c.refusePasswordFields) {
          await untilAborted(sig, () => locator.fill(value, { signal: sig }));
          return;
        }
        const resolved = await resolveActionHandle(selector, actionOpMs, sig);
        try {
          await passwordGuard.beforeTyping(resolved, JSON.stringify(selector), sig);
        } finally {
          await resolved.dispose().catch(() => void 0);
        }
        await untilAborted(sig, () => locator.filter((el) => !(el instanceof HTMLInputElement && el.type === "password")).fill(value, { signal: sig }));
      },
      { selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS }
    ),
    press: (key, opts) => op(`tab.press(${JSON.stringify(key)})`, actionOpMs, async (sig) => {
      const selector = opts?.selector;
      if (selector) {
        if (parseAriaRefSelector(selector) !== null) {
          const handle = await resolveAriaRef(selector);
          try {
            await untilAborted(sig, () => handle.focus());
          } finally {
            await handle.dispose().catch(() => void 0);
          }
        } else await untilAborted(sig, () => page.focus(normalizeSelector(selector)));
      }
      if (c.refusePasswordFields) await passwordGuard.beforePress(key, `tab.press(${JSON.stringify(key)}${selector ? `, { selector: ${JSON.stringify(selector)} }` : ""})`, sig);
      await untilAborted(sig, () => page.keyboard.press(key));
    }),
    scroll: (deltaX, deltaY) => op("tab.scroll()", actionOpMs, (sig) => untilAborted(sig, () => dispatchScroll(() => page.mouse.wheel({ deltaX, deltaY })))),
    drag: (from, to) => op("tab.drag()", actionOpMs, (sig) => drag(from, to, sig)),
    waitFor: (selector, opts) => {
      const w = waitMs(opts?.timeout);
      return op(
        `tab.waitFor(${JSON.stringify(selector)})`,
        w,
        async (sig) => enrich(await resolveActionHandle(selector, w, sig)),
        { selector, zeroMatchAfterMs: opts?.timeout === void 0 ? ZERO_MATCH_FAIL_FAST_MS : void 0 }
      );
    },
    waitForSelector: (selector, opts) => {
      const w = waitMs(opts?.timeout);
      return op(
        `tab.waitForSelector(${JSON.stringify(selector)})`,
        w,
        async (sig) => {
          if (parseAriaRefSelector(selector) !== null) return enrich(await resolveAriaRef(selector));
          const handle = await untilAborted(
            sig,
            () => page.waitForSelector(normalizeSelector(selector), {
              timeout: w,
              visible: opts?.visible,
              hidden: opts?.hidden,
              signal: sig
            })
          );
          return handle ? enrich(handle) : null;
        },
        {
          selector,
          // `hidden: true` waits for zero matches: that is success, never a fast-fail.
          zeroMatchAfterMs: opts?.timeout === void 0 && !opts?.hidden ? ZERO_MATCH_FAIL_FAST_MS : void 0
        }
      );
    },
    waitForNavigation: (opts) => {
      const w = waitMs(opts?.timeout);
      return op(
        "tab.waitForNavigation()",
        w,
        (sig) => untilAborted(sig, () => page.waitForNavigation({ waitUntil: opts?.waitUntil ?? "load", timeout: w, signal: sig }))
      );
    },
    evaluate: (fn, ...args) => op(
      "tab.evaluate()",
      INF,
      (sig) => untilAborted(sig, () => {
        const frame = page.mainFrame();
        const realm = frame.mainRealm?.();
        const rest = args;
        return realm ? realm.evaluate(fn, ...rest) : page.evaluate(fn, ...rest);
      })
    ),
    scrollIntoView: (selector) => op(
      `tab.scrollIntoView(${JSON.stringify(selector)})`,
      actionOpMs,
      async (sig) => {
        const handle = await resolveActionHandle(selector, actionOpMs, sig);
        try {
          await untilAborted(
            sig,
            () => handle.evaluate((el) => {
              const target = el;
              target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
            })
          );
        } finally {
          await handle.dispose().catch(() => void 0);
        }
      },
      { selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS }
    ),
    select: (selector, ...values) => op(`tab.select(${JSON.stringify(selector)})`, actionOpMs, (sig) => select(selector, values, actionOpMs, sig), {
      selector,
      zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS
    }),
    uploadFile: (selector, ...filePaths) => op(`tab.uploadFile(${JSON.stringify(selector)})`, actionOpMs, (sig) => uploadFile(selector, filePaths, actionOpMs, sig), {
      selector,
      zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS
    }),
    waitForUrl: (pattern, opts) => {
      const w = waitMs(opts?.timeout);
      return op("tab.waitForUrl()", w, (sig) => waitForUrl(pattern, w, sig));
    },
    waitForResponse: (pattern, opts) => {
      const w = waitMs(opts?.timeout);
      return op("tab.waitForResponse()", w, (sig) => waitForResponse(pattern, w, sig));
    },
    // Through `op` like every sibling above. These two returned the raw promise in OMP's first version, so a caller that did not await left the rejection
    // unobserved and a stale ARIA ref killed a live session: `op` supplies markHandled, the run's abort signal, a per-op timeout and a labelled failure.
    id: (n) => op(`tab.id(${JSON.stringify(n)})`, actionOpMs, async () => {
      const handle = await session.elements.resolve(n);
      return enrich(handle);
    }),
    ref: (refId) => op(`tab.ref(${JSON.stringify(refId)})`, actionOpMs, async () => enrich(await resolveAriaRef(refId)))
  };
}

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/element-cache.ts
var ElementCache = class {
  #handles = /* @__PURE__ */ new Map();
  #counter = 0;
  get size() {
    return this.#handles.size;
  }
  nextId() {
    this.#counter += 1;
    return this.#counter;
  }
  set(id, handle) {
    this.#handles.set(id, handle);
  }
  /** The live handle for `id`, or the OMP message naming what to do. */
  async resolve(id) {
    const handle = this.#handles.get(id);
    if (!handle) throw new ToolError(`Unknown element id ${id}. Run tab.observe() to refresh the element list.`);
    try {
      const isConnected = await handle.evaluate((el) => el.isConnected);
      if (!isConnected) {
        this.clear();
        throw new ToolError(`Element id ${id} is stale. Run tab.observe() again.`);
      }
    } catch (err) {
      if (err instanceof ToolError) throw err;
      this.clear();
      throw new ToolError(`Element id ${id} is stale. Run tab.observe() again.`);
    }
    return handle;
  }
  /** Forget every id and dispose the handles; the next observe numbers from 1 again. */
  clear() {
    if (this.#handles.size === 0) {
      this.#counter = 0;
      return;
    }
    const handles = [...this.#handles.values()];
    this.#handles.clear();
    this.#counter = 0;
    for (const handle of handles) void handle.dispose().catch(() => void 0);
  }
};

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/tab-session.ts
var TabSession = class {
  constructor(name, handle, browser, page, activateForScreenshot) {
    this.name = name;
    this.handle = handle;
    this.browser = browser;
    this.page = page;
    this.activateForScreenshot = activateForScreenshot;
    this.ops = new OpRunner(() => this.page);
    this.#observeDialogs();
  }
  elements = new ElementCache();
  ops;
  /** The run in flight on this tab, if any. */
  active = null;
  /** Settles when the last run on this tab has finished unwinding (a closing tab waits a grace for it). */
  done = Promise.resolve();
  /** The evaluator that holds this tab's `tab.run` variables (one per tab when the realm is given a factory). */
  evaluator;
  openDialog;
  #cdp;
  #disposers = [];
  /** One CDP session on the page, shared by layout metrics, `Page.stopLoading` and the dialog-closed event. */
  cdp() {
    this.#cdp ??= this.page.createCDPSession();
    return this.#cdp;
  }
  /**
   * Record JS dialogs for timeout attribution without handling them. Cleared when the dialog is answered (by the engine or by the code) or a main-frame navigation
   * proves the modal is gone.
   */
  #observeDialogs() {
    const { page } = this;
    const onDialog = (dialog) => {
      this.openDialog = { type: dialog.type(), message: dialog.message() };
    };
    const onNavigated = (frame) => {
      if (frame === page.mainFrame()) this.openDialog = void 0;
    };
    page.on("dialog", onDialog);
    page.on("framenavigated", onNavigated);
    this.#disposers.push(
      () => page.off("dialog", onDialog),
      () => page.off("framenavigated", onNavigated)
    );
    void this.cdp().then((session) => {
      const onClosed = () => {
        this.openDialog = void 0;
      };
      session.on("Page.javascriptDialogClosed", onClosed);
      this.#disposers.push(() => session.off("Page.javascriptDialogClosed", onClosed));
      return session.send("Page.enable");
    }).catch(() => void 0);
  }
  /**
   * Tell the omp browser relay this worker drives the adopted page, so the relay adds it to the per-window "omp" tab group. Best-effort: plain CDP
   * backends reject the relay-private method.
   */
  async claimRelayTarget() {
    let session;
    try {
      session = await this.page.createCDPSession();
      const raw = session;
      await raw.send("OMP.claimTarget");
    } catch {
    } finally {
      await session?.detach().catch(() => void 0);
    }
  }
  /** Best-effort `Page.stopLoading` so an abandoned navigation cannot stall later ops. */
  async stopLoading() {
    try {
      await (await this.cdp()).send("Page.stopLoading");
    } catch {
    }
  }
  /** Forget the page: listeners off, handles disposed, the CDP session detached. The page itself is the engine's and stays open. */
  async dispose() {
    for (const dispose of this.#disposers.splice(0)) dispose();
    this.elements.clear();
    const session = await this.#cdp?.catch(() => void 0);
    this.#cdp = void 0;
    await session?.detach().catch(() => void 0);
  }
};

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/tab-realm.ts
var BROWSER_PROTOCOL_TIMEOUT_MS = 6e4;
var GRACE_MS = 750;
var TARGET_APPEAR_TIMEOUT_MS = 5e3;
var RUN_SCOPE2 = ["tab", "page", "browser", "wait", "assert"];
var REFUSE_PASSWORD_FIELDS_BY_DEFAULT = true;
function withdrawDisconnect(browser) {
  const release = browser.disconnect.bind(browser);
  Object.defineProperty(browser, "disconnect", { configurable: true, value: async () => void 0 });
  return release;
}
function privateTargetId(target) {
  const raw = target;
  return typeof raw._targetId === "string" ? raw._targetId : void 0;
}
async function targetIdOf(target) {
  const fast = privateTargetId(target);
  if (fast) return fast;
  const session = await target.createCDPSession();
  try {
    const info = await session.send("Target.getTargetInfo");
    if (info.targetInfo?.targetId) return info.targetInfo.targetId;
    throw new ToolError("Target id unavailable from CDP target info");
  } finally {
    await session.detach().catch(() => void 0);
  }
}
function createTabRealm(options) {
  return new BrowserTabRealm(options);
}
var BrowserTabRealm = class {
  #options;
  #sessions = /* @__PURE__ */ new Map();
  #connections = /* @__PURE__ */ new Map();
  /** Why a tab's browser ended, by tab name, so a later call on that name can say so instead of just that it is not alive. */
  #ended = /* @__PURE__ */ new Map();
  #uninstallGuard;
  #runCounter = 0;
  #disposed = false;
  constructor(options) {
    this.#options = options;
    if (options.guardRejections ?? !isMainThread2) {
      this.#uninstallGuard = installBrowserWorkerRejectionGuard((reason) => this.#consumeUnhandledRejection(reason));
    }
  }
  names() {
    return [...this.#sessions.keys()];
  }
  async adopt(name, handle) {
    if (this.#disposed) throw new ToolError("The tab realm is closed");
    const held = this.#sessions.get(name);
    if (held && held.handle.targetId === handle.targetId && held.handle.browserId === handle.browserId && !held.page.isClosed()) return;
    const browser = await this.#connect(handle);
    const page = await this.#pageFor(browser, handle.targetId);
    const session = new TabSession(name, handle, browser, page, handle.activateForScreenshot ?? (handle.created || handle.kind !== "connected" && handle.kind !== "relay"));
    if (handle.kind === "relay") await session.claimRelayTarget();
    if (held) await this.#drop(held, new ToolError(`Tab "${name}" was closed`));
    this.#ended.delete(name);
    this.#sessions.set(name, session);
  }
  async release(name) {
    this.#ended.delete(name);
    const session = this.#sessions.get(name);
    if (!session) return;
    await this.#drop(session, new ToolError(`Tab "${name}" was closed`));
    await this.#disconnectIfUnused(session.handle.browserId);
  }
  async end(browserId, reason) {
    const sessions = [...this.#sessions.values()].filter((session) => session.handle.browserId === browserId);
    for (const session of sessions) {
      if (reason) this.#ended.set(session.name, reason);
      await this.#drop(session, new ToolError(`Tab "${session.name}" was closed${reason ? `: ${reason}` : ""}`));
    }
    await this.#disconnectIfUnused(browserId);
  }
  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#uninstallGuard?.();
    for (const session of [...this.#sessions.values()]) await this.#drop(session, new ToolError(`Tab "${session.name}" was closed`));
    for (const browserId of [...this.#connections.keys()]) await this.#disconnectIfUnused(browserId);
  }
  async run(r) {
    const session = this.#alive(r.name);
    const hasCode = r.code !== void 0 && r.code.trim().length > 0;
    const hasFn = r.fn !== void 0 && r.fn.trim().length > 0;
    if (hasCode === hasFn) throw new ToolError("Action 'run' requires exactly one of 'code' or 'fn'.");
    const code = hasFn ? renderFunctionRun(r.fn.trim(), RUN_SCOPE2, r.args ?? []) : r.code.trim();
    return this.#execute(session, code, r.timeoutMs, r.signal);
  }
  async call(r) {
    const session = this.#alive(r.name);
    return this.#execute(session, renderTabCall(r.chain), r.timeoutMs, r.signal);
  }
  #alive(name) {
    const session = this.#sessions.get(name);
    if (!session || session.page.isClosed()) {
      const why = this.#ended.get(name);
      throw new ToolError(`Tab ${JSON.stringify(name)} is not alive. Open it first with action:"open".${why ? ` Its browser ended (${why}).` : ""}`);
    }
    return session;
  }
  /** One connection per browser, shared by every tab of it; a changed endpoint under the same id is a new browser. */
  async #connect(handle) {
    const held = this.#connections.get(handle.browserId);
    if (held && held.wsEndpoint === handle.wsEndpoint) {
      const browser = await held.browser;
      if (browser.connected) return browser;
    }
    if (held) await this.end(handle.browserId);
    const connection = {
      wsEndpoint: handle.wsEndpoint,
      browser: puppeteer.connect({ browserWSEndpoint: handle.wsEndpoint, defaultViewport: null, protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS })
    };
    this.#connections.set(handle.browserId, connection);
    try {
      const browser = await connection.browser;
      connection.release = withdrawDisconnect(browser);
      browser.on("disconnected", () => {
        if (this.#connections.get(handle.browserId) === connection) void this.end(handle.browserId, "the browser disconnected").catch(() => void 0);
      });
      return browser;
    } catch (error) {
      if (this.#connections.get(handle.browserId) === connection) this.#connections.delete(handle.browserId);
      throw error;
    }
  }
  async #pageFor(browser, targetId) {
    const matches = (target2) => privateTargetId(target2) === targetId;
    let target = browser.targets().find(matches);
    if (!target) {
      for (const candidate of browser.targets()) {
        if (await targetIdOf(candidate).catch(() => "") === targetId) {
          target = candidate;
          break;
        }
      }
    }
    target ??= await browser.waitForTarget(matches, { timeout: TARGET_APPEAR_TIMEOUT_MS }).catch(() => void 0);
    if (!target) throw new ToolError(`Target ${targetId} is no longer available on the attached browser`);
    const page = await target.page();
    if (!page) throw new ToolError(`Target ${targetId} is no longer available on the attached browser`);
    return page;
  }
  /** Stop the run in flight on a tab (it gets `reason`), wait a grace for it to unwind, then forget the page. The page itself is the engine's and stays open. */
  async #drop(session, reason) {
    if (this.#sessions.get(session.name) === session) this.#sessions.delete(session.name);
    const active = session.active;
    if (active) {
      active.ac.abort(reason);
      await Promise.race([session.done, sleep(GRACE_MS)]);
    }
    await session.dispose();
  }
  /** The realm's own connection to a browser is released (never the browser) when no tab of it remains. */
  async #disconnectIfUnused(browserId) {
    for (const session of this.#sessions.values()) if (session.handle.browserId === browserId) return;
    const connection = this.#connections.get(browserId);
    if (!connection) return;
    this.#connections.delete(browserId);
    await connection.browser.catch(() => void 0);
    await connection.release?.().catch(() => void 0);
  }
  #consumeUnhandledRejection(reason) {
    for (const session of this.#sessions.values()) {
      const active = session.active;
      if (!active) continue;
      if (!isBrowserRunOwnedRejection(reason, active.rejectionOwner, active.filename)) continue;
      this.#recordFloatingRejection(active, session, reason);
      return true;
    }
    return false;
  }
  #recordFloatingRejection(active, session, reason) {
    if (isExpectedCleanupError(reason)) return;
    if (session.active !== active) {
      this.#options.log?.("warn", `Unhandled rejection after browser run ended (run ${active.id}): ${reason instanceof Error ? reason.message : String(reason)}`);
      return;
    }
    const isFirst = active.floatingRejections.length === 0;
    active.floatingRejections.push(reason);
    if (isFirst) active.floatingFailure.reject(this.#floatingRejectionError(reason));
  }
  #floatingRejectionError(reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    const error = new Error(`Unhandled rejection (missing await?): ${message}`, { cause: reason });
    if (reason instanceof Error) error.name = reason.name;
    return error;
  }
  #foldFloatingRejections(active, failure) {
    const rejections = active.floatingRejections;
    if (rejections.length === 0) return failure;
    let reported = rejections;
    if (!failure) {
      failure = { error: this.#floatingRejectionError(rejections[0]) };
      reported = rejections.slice(1);
    } else if (failure.error instanceof Error && failure.error.cause === rejections[0]) {
      reported = rejections.slice(1);
    }
    for (const reason of reported) {
      this.#options.log?.("warn", `Additional unhandled browser-run rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
    return failure;
  }
  /** OMP's `#run`: one run on one tab, under the run's own deadline, with the helpers' per-operation guards and the floating-rejection routing. */
  async #execute(session, code, timeoutMs, hostSignal) {
    if (session.active) throw new ToolError(`Tab ${JSON.stringify(session.name)} is busy`);
    const runId = String(++this.#runCounter);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const ac = new AbortController();
    const runAc = new AbortController();
    const signal = AbortSignal.any([timeoutSignal, hostSignal, ac.signal, runAc.signal]);
    const output = new RunOutput();
    const screenshots = [];
    const floatingFailure = Promise.withResolvers();
    const active = {
      id: runId,
      ac,
      signal,
      output,
      screenshots,
      filename: `browser-run-${runId}.js`,
      rejectionOwner: {},
      floatingRejections: [],
      floatingFailure,
      inflight: /* @__PURE__ */ new Map(),
      opCounter: 0
    };
    const finished = Promise.withResolvers();
    session.active = active;
    session.done = finished.promise;
    let completed = false;
    let returnValue;
    let failure;
    let runPage;
    try {
      throwIfAborted(signal);
      runPage = createRunPageScope(session.page);
      const shot = {
        dir: this.#options.screenshotDir ?? resolveScreenshotDir(this.#options.env ?? {}),
        excludeWebP: this.#options.excludeWebP ?? false,
        activate: session.activateForScreenshot
      };
      const tabApi = createTabApi(
        { session, run: active, signal, timeoutMs, shot, cwd: this.#options.cwd, refusePasswordFields: this.#options.refusePasswordFields ?? REFUSE_PASSWORD_FIELDS_BY_DEFAULT },
        output,
        screenshots
      );
      const onFloatingRejection = (reason) => this.#recordFloatingRejection(active, session, reason);
      const wait = (msOrPredicate, opts) => {
        const label = typeof msOrPredicate === "number" ? `wait(${msOrPredicate}ms)` : "wait(predicate)";
        const resolved = typeof msOrPredicate === "number" ? void 0 : { timeout: resolvePredicateTimeout(timeoutMs, opts?.timeout), interval: opts?.interval };
        return observeBrowserRunPromise(
          session.ops.runOp(active, label, signal, Number.POSITIVE_INFINITY, (sig) => waitForRun(msOrPredicate, sig, resolved)),
          active.rejectionOwner,
          onFloatingRejection
        );
      };
      const scope = {
        page: bindRunFacade(runPage.page, signal, active.rejectionOwner, onFloatingRejection),
        browser: bindRunFacade(session.browser, signal, active.rejectionOwner, onFloatingRejection),
        tab: bindRunFacade(tabApi, signal, active.rejectionOwner, onFloatingRejection),
        assert: (cond, text2) => {
          if (!cond) throw new ToolError(text2 ?? "Assertion failed");
        },
        wait
      };
      const { promise: cancelRejection, reject: rejectCancel } = Promise.withResolvers();
      const onCancel = () => {
        if (timeoutSignal.aborted) {
          const stalled = describeInflight(active.inflight);
          const dialog = session.openDialog;
          const dialogNote = dialog ? `; a ${dialog.type}(${JSON.stringify(dialog.message.slice(0, 80))}) dialog opened during this run and may still block the page \u2014 reopen the tab with dialogs:"accept"|"dismiss" or handle page.on('dialog')` : "";
          rejectCancel(new ToolError(`Browser code execution timed out after ${timeoutMs}ms${stalled ? ` (stalled on ${stalled})` : ""}${dialogNote}`));
          return;
        }
        const reason = signal.reason;
        if (reason instanceof ToolError) rejectCancel(reason);
        else rejectCancel(reason instanceof ToolAbortError ? reason : new ToolAbortError(void 0, { cause: reason }));
      };
      if (signal.aborted) onCancel();
      else signal.addEventListener("abort", onCancel, { once: true });
      try {
        const evaluator = session.evaluator ??= this.#options.evaluator();
        const hooks = {
          onText: (chunk2) => {
            throwIfAborted(signal);
            output.pushText(chunk2);
          },
          onDisplay: (display) => {
            throwIfAborted(signal);
            output.pushDisplay(display);
          }
        };
        returnValue = await withBrowserPromiseCombinatorTracking(
          active.rejectionOwner,
          onFloatingRejection,
          async () => await Promise.race([evaluator.evaluate(code, { filename: active.filename, scope, hooks }), cancelRejection, floatingFailure.promise])
        );
        completed = true;
      } finally {
        signal.removeEventListener("abort", onCancel);
      }
    } catch (error) {
      failure = { error };
    } finally {
      runAc.abort(markExpectedCleanupError(new ToolAbortError("Browser run ended")));
      const turn = Promise.withResolvers();
      setImmediate(turn.resolve);
      await turn.promise;
      try {
        await runPage?.cleanup();
      } catch (error) {
        if (failure === void 0) failure = { error };
        else if (typeof failure.error === "object" && failure.error !== null) Reflect.set(failure.error, "recoverTab", true);
      }
      failure = this.#foldFloatingRejections(active, failure);
      if (session.active === active) session.active = null;
      finished.resolve();
    }
    if (failure) throw failure.error;
    if (!completed) throw new ToolError("Browser code execution did not complete");
    return { displays: output.finish(), returnValue: cloneSafe(returnValue), screenshots };
  }
};

// ../inso-browser-one-tool-dock-profiles-browser-r13-engine/marketplace/packs/.browser-completion-proof/src/code/worker/entry.ts
serveOnParentPort(({ env, screenshotDir, cwd, refusePasswordFields, excludeWebP }) => {
  const shots = screenshotDir ?? resolveScreenshotDir(env);
  return createKindRealm({
    tab: createTabRealm({ evaluator: createCodeEvaluator, env, screenshotDir, cwd, refusePasswordFields, excludeWebP }),
    cmux: new CmuxRealm({ evaluator: createCodeEvaluator, settings: () => ({ ...shots === void 0 ? {} : { screenshotDir: shots }, ...cwd === void 0 ? {} : { cwd }, ...excludeWebP === void 0 ? {} : { excludeWebP } }) })
  });
});
