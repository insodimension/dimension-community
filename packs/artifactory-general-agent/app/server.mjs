// src/stdio.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// src/server.ts
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join as join4, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parse as parseYaml4 } from "yaml";

// src/guards.ts
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// src/extra.ts
var KEY_LINE = /^( *)("[^"]+"|'[^']+'|[A-Za-z0-9_][\w./-]*) *:(?: +(.*))?$/;
function indentOf(line) {
  return line.length - line.trimStart().length;
}
function isBlank(line) {
  return line.trim() === "";
}
function unquote(key) {
  return key.startsWith('"') || key.startsWith("'") ? key.slice(1, -1) : key;
}
function splitLevel(lines, indent) {
  const blocks = [];
  const stray = [];
  let current = null;
  let pending = [];
  for (const line of lines) {
    const match = KEY_LINE.exec(line);
    if (match && (match[1] ?? "").length === indent) {
      current = { key: unquote(match[2] ?? ""), lines: [...pending, line], rest: match[3] ?? "" };
      pending = [];
      blocks.push(current);
    } else if (isBlank(line) || line.trimStart().startsWith("#") && indentOf(line) <= indent) {
      pending.push(line);
    } else if (current) {
      current.lines.push(...pending, line);
      pending = [];
    } else {
      stray.push(line);
      pending = [];
    }
  }
  for (const block of blocks) {
    while (block.lines.length > 0 && isBlank(block.lines[0] ?? "")) block.lines.shift();
    while (block.lines.length > 0 && isBlank(block.lines[block.lines.length - 1] ?? "")) block.lines.pop();
  }
  return { blocks, stray };
}
function describe(raw, depth) {
  const inline = raw.rest.replace(/^#.*$/, "").replace(/\s+#.*$/, "").trim();
  const keyAt = raw.lines.findIndex((line) => {
    const match = KEY_LINE.exec(line);
    return match !== null && unquote(match[2] ?? "") === raw.key;
  });
  const body = raw.lines.slice(keyAt + 1);
  const first = body.find((line) => !isBlank(line) && !line.trimStart().startsWith("#"));
  const base = { key: raw.key, lines: raw.lines, inline };
  if (depth > 0 || inline !== "") return { ...base, children: null, childIndent: 0 };
  if (first === void 0) return { ...base, children: [], childIndent: 2 };
  const childIndent = indentOf(first);
  if (childIndent === 0 || !KEY_LINE.test(first)) return { ...base, children: null, childIndent: 0 };
  return { ...base, children: splitLevel(body, childIndent).blocks.map((child) => describe(child, 1)), childIndent };
}
function parseExtra(text) {
  const { blocks, stray } = splitLevel(text.replace(/\r\n?/g, "\n").split("\n"), 0);
  return { blocks: blocks.map((block) => describe(block, 0)), stray };
}
function extraPaths(blocks) {
  const paths = /* @__PURE__ */ new Set();
  for (const block of blocks) {
    paths.add(block.key);
    for (const child of block.children ?? []) paths.add(`${block.key}.${child.key}`);
  }
  return paths;
}
function reindent(lines, from, to) {
  return lines.map((line) => isBlank(line) ? "" : " ".repeat(to) + line.slice(Math.min(from, indentOf(line))));
}
function childLines(block, indent) {
  return (block.children ?? []).flatMap((child) => reindent(child.lines, block.childIndent, indent));
}
var GRANT_SECTIONS = { gate: true, workspace: true };
var MIXED_SECTIONS = { capabilities: true, subagents: true };
var GRANT_PATHS = {
  "capabilities.tools": true,
  "capabilities.mcp": true,
  "capabilities.plugins": true,
  "capabilities.control": true,
  "capabilities.optIn": true,
  "subagents.allowed": true,
  harness: true,
  allowedHarnesses: true,
  tools: true,
  spawns: true
};
function grantPathsOf(sections) {
  const found = [];
  for (const [key, children] of sections) {
    if (Object.hasOwn(GRANT_SECTIONS, key) || Object.hasOwn(GRANT_PATHS, key)) found.push(key);
    else if (Object.hasOwn(MIXED_SECTIONS, key)) {
      if (children === null) found.push(`${key} (inline)`);
      else for (const child of children) if (Object.hasOwn(GRANT_PATHS, `${key}.${child}`)) found.push(`${key}.${child}`);
    }
  }
  return found;
}
function grantPathsIn(text) {
  return grantPathsOf(parseExtra(text).blocks.map((block) => [block.key, block.children === null ? null : block.children.map((child) => child.key)]));
}
function grantPathsInDocument(document) {
  if (!isRecord(document)) return [];
  return grantPathsOf(Object.entries(document).map(([key, value]) => [key, value === null || value === void 0 ? [] : isRecord(value) ? Object.keys(value) : null]));
}

// src/agent-md.ts
var PERSONALITIES = ["default", "friendly", "pragmatic", "none"];
var PROMPT_MODES = ["replace", "append"];
var THINKING_STEPS = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh"];
var APPROVAL_SETTINGS = ["always-ask", "write", "yolo", "inherit"];
var HABITATS = ["bound", "home", "ephemeral"];
var MEMORY_BACKENDS = ["inherit", "engram", "local", "hindsight", "mnemopi", "off"];
var MEMORY_SCOPES = ["project", "global"];
var VOICE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
var NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
var FLAT_ALIASES = {
  tools: "capabilities.tools",
  thinkingLevel: "engine.thinkingLevel",
  thinking: "engine.thinkingLevel",
  model: "engine.model"
};
var DRAWN_CHILDREN = {
  identity: ["personality", "prompt"],
  engine: ["thinkingLevel", "model"],
  capabilities: ["tools", "skills", "mcp"],
  gate: ["approval"],
  memory: ["backend"],
  workspace: ["policy", "id", "reach"]
};
var FIXED_PATHS = {
  name: true,
  description: true,
  specVersion: true,
  extends: true,
  "identity.prompt": true
};
function draftProblems(draft) {
  const problems = [];
  if (!NAME_RE.test(draft.name)) problems.push("Name it: 2\u201364 lowercase letters, digits or dashes.");
  if (draft.voice !== "" && !VOICE_NAME_RE.test(draft.voice)) problems.push("A voice is a profile name: lowercase letters, digits and single dashes.");
  if (draft.description.trim() === "") problems.push("Give it one line that says what it is for.");
  if (draft.charter.trim() === "") problems.push("Write its charter: the instructions it runs by.");
  problems.push(...manifestDocument(draft).problems);
  return problems;
}
var PLAIN_SCALAR = /^[A-Za-z0-9][A-Za-z0-9 _./@:+-]*$/;
var YAML_WORDS = /^(true|false|yes|no|on|off|null|~)$/i;
function readsAsNumber(value) {
  return value.trim() !== "" && !Number.isNaN(Number(value));
}
function scalar(value) {
  if (PLAIN_SCALAR.test(value) && !YAML_WORDS.test(value) && !readsAsNumber(value) && !/:\s/.test(value) && !/\s$/.test(value)) return value;
  return JSON.stringify(value);
}
function list(values) {
  return `[${values.map(scalar).join(", ")}]`;
}
function manifestDocument(draft, homeId) {
  const parsed = parseExtra(draft.extra);
  const problems = [];
  for (const stray of parsed.stray) problems.push(`Other settings must be \`key: value\` lines, not \u201C${stray.trim()}\u201D.`);
  if (draft.extra.split("\n").some((line2) => /^(---|\.\.\.)/.test(line2))) problems.push("Other settings cannot hold a document separator (---).");
  const byKey = new Map(parsed.blocks.map((block) => [block.key, block]));
  const held = extraPaths(parsed.blocks);
  const fixed = [...held].filter((path) => FIXED_PATHS[path] !== void 0);
  for (const path of fixed) problems.push(`\`${path}\` is set on the profile itself (identity, lineage or charter). Remove it from Other settings.`);
  const yields = (path) => held.has(path) && FIXED_PATHS[path] === void 0;
  const line = (field, text) => ({ field, text });
  const units = [
    { key: "name", lines: [line("name", `name: ${scalar(draft.name || "unnamed")}`)] },
    { key: "description", lines: [line("description", `description: ${scalar(draft.description || "\u2026")}`)] },
    { key: "avatar", lines: draft.vibr === "" ? [] : [line("avatar", `avatar: ${scalar(draft.vibr)}`)] },
    { key: "voice", lines: draft.voice === "" ? [] : [line("voice", `voice: ${scalar(draft.voice)}`)] },
    { key: "specVersion", lines: [line("specVersion", "specVersion: 1")] }
  ];
  if (draft.lineage.length > 0) units.push({ key: "extends", lines: [line("extends", `extends: ${list(draft.lineage)}`)] });
  const child = (path, text) => ({ key: path.split(".")[1] ?? path, lines: [line(path, text)] });
  const section = (key, children) => units.push({ key, children });
  section("identity", [
    ...draft.personality !== "default" ? [child("identity.personality", `  personality: ${draft.personality}`)] : [],
    child("identity.prompt", `  prompt: ${draft.promptMode}`)
  ]);
  section("engine", [
    ...draft.thinking !== "inherit" ? [child("engine.thinkingLevel", `  thinkingLevel: ${draft.thinking}`)] : [],
    ...draft.models.length > 0 ? [child("engine.model", `  model: ${list(draft.models)}`)] : []
  ]);
  section("capabilities", [
    ...draft.tools.length > 0 ? [child("capabilities.tools", `  tools: ${list(draft.tools)}`)] : [],
    ...draft.skills.length > 0 ? [child("capabilities.skills", `  skills: ${list(draft.skills)}`)] : [],
    ...draft.mcp.length > 0 ? [child("capabilities.mcp", `  mcp: ${list(draft.mcp)}`)] : []
  ]);
  section("gate", draft.approval !== "inherit" ? [child("gate.approval", `  approval: ${draft.approval}`)] : []);
  section("memory", draft.memory !== "inherit" ? [child("memory.backend", `  backend: ${draft.memory}`)] : []);
  const reachAll = draft.memory !== "off" && draft.memoryScope === "global";
  const extraWorkspace = (byKey.get("workspace")?.children?.length ?? 0) > 0 || (byKey.get("workspace")?.inline ?? "") !== "";
  section(
    "workspace",
    draft.habitat !== "bound" || reachAll || extraWorkspace ? [
      child("workspace.policy", `  policy: ${draft.habitat}`),
      // `home` REQUIRES an id (agent-manifest.ts AgentWorkspacePolicy): the agent's
      // own derived home, which the engine registers as `home-<name>`.
      ...draft.habitat === "home" ? [child("workspace.id", `  id: ${scalar(homeId ?? "(its home id)")}`)] : [],
      ...reachAll ? [child("workspace.reach", "  reach: all")] : []
    ] : []
  );
  const used = /* @__PURE__ */ new Set();
  const lines = [line("fence", "---")];
  const pushAll = (field, texts) => {
    for (const text of texts) lines.push(line(field, text));
  };
  for (const unit of units) {
    const block = byKey.get(unit.key);
    if (unit.lines !== void 0) {
      if (block !== void 0 && yields(unit.key)) {
        used.add(unit.key);
        pushAll(`extra.${unit.key}`, block.lines);
      } else {
        if (block !== void 0) used.add(unit.key);
        lines.push(...unit.lines);
      }
      continue;
    }
    const kept = (unit.children ?? []).filter((entry2) => !yields(`${unit.key}.${entry2.key}`));
    if (block === void 0) {
      if (kept.length > 0) {
        lines.push(line(unit.key, `${unit.key}:`));
        for (const entry2 of kept) lines.push(...entry2.lines);
      }
      continue;
    }
    used.add(unit.key);
    if (kept.length === 0) pushAll(`extra.${unit.key}`, block.lines);
    else if (block.children === null) {
      problems.push(`\`${unit.key}\` is written inline in Other settings, so the profile's own ${unit.key} settings cannot join it. Write its keys indented, one per line.`);
      lines.push(line(unit.key, `${unit.key}:`));
      for (const entry2 of kept) lines.push(...entry2.lines);
    } else {
      lines.push(line(unit.key, `${unit.key}:`));
      for (const entry2 of kept) lines.push(...entry2.lines);
      pushAll(`extra.${unit.key}`, childLines(block, 2));
    }
  }
  for (const block of parsed.blocks) if (!used.has(block.key)) pushAll(`extra.${block.key}`, block.lines);
  lines.push(line("fence", "---"));
  const body = draft.charter.trim() === "" ? ["\u2026"] : draft.charter.replace(/\s+$/, "").split("\n");
  for (const text of body) lines.push(line("body", text));
  return { lines, problems };
}
function manifestLines(draft, homeId) {
  return manifestDocument(draft, homeId).lines;
}
function toAgentMd(draft, homeId) {
  return `${manifestLines(draft, homeId).map((entry2) => entry2.text).join("\n")}
`;
}

// src/home.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import { mkdir as mkdir2, readFile as readFile2, rename as rename2, rm as rm2, stat, writeFile as writeFile2 } from "node:fs/promises";
import { basename as basename2, dirname, join as join2 } from "node:path";

// ../../../omp/packages/omptype/src/errors.ts
function format(override, context, fallback2) {
  return typeof override === "function" ? override(context) : override ?? fallback2;
}
var OmpError = class {
  constructor(path, expected, data, config) {
    this.path = path;
    this.data = data;
    this.#rawExpected = expected;
    this.#config = config;
  }
  #rawExpected;
  #config;
  /** Prefix this failure when a nested schema delegates validation. */
  prefix(key) {
    this.path.unshift(key);
    return this;
  }
  /** Apply schema-local formatting to this failure. */
  configure(config) {
    this.#config = { ...this.#config, ...config };
    return this;
  }
  /** Stable category for programmatic error handling. */
  get code() {
    return errorCode(this.#rawExpected, this.data);
  }
  #context(expected, actual, problem = "") {
    const { description, rule } = describeExpectation(this.#rawExpected);
    return {
      code: this.code,
      path: this.path,
      propString: formatPath(this.path),
      data: this.data,
      expected,
      actual,
      problem,
      description,
      ...rule === void 0 ? {} : { rule }
    };
  }
  /** Human-readable expectation, including a configured override. */
  get expected() {
    const actual = describeValue(this.data, this.#config?.preserveActual ? "predicate" : this.code);
    const parts = this.#rawExpected.split(" or ");
    const fallback2 = parts.length < 3 ? this.#rawExpected : `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
    return format(this.#config?.expected, this.#context(fallback2, actual), fallback2);
  }
  /** Short description of the received value, e.g. `"a number"` or `"missing"`. */
  get actual() {
    const actual = describeValue(this.data, this.#config?.preserveActual ? "predicate" : this.code);
    const override = this.#config?.actual;
    return typeof override === "function" ? override(this.data) : override ?? actual;
  }
  /** Path-less problem statement: `must be <expected> (was <actual>)`. */
  get problem() {
    const expected = this.expected;
    const actual = this.actual;
    const fallback2 = this.data === MISSING ? `must be ${expected} (was missing)` : actual === "" ? `must be ${expected}` : `must be ${expected} (was ${actual})`;
    return format(this.#config?.problem, this.#context(expected, actual, fallback2), fallback2);
  }
  get message() {
    const expected = this.expected;
    const actual = this.actual;
    const problem = this.problem;
    const at = this.path.length === 0 ? "" : `${formatPath(this.path)} `;
    const messageActual = this.#config?.actual === void 0 ? describeKind(this.data) : actual;
    return format(this.#config?.message, this.#context(expected, messageActual, problem), `${at}${problem}`);
  }
  toString() {
    return this.message;
  }
};
var MISSING = Symbol("omptype.missing");
function stringifyValue(data) {
  const seen = /* @__PURE__ */ new WeakSet();
  return JSON.stringify(data, (_key, value) => {
    if (typeof value !== "object" || value === null) return value;
    if (seen.has(value)) return "(cycle)";
    seen.add(value);
    return value;
  }) ?? "an object";
}
function describeValue(data, code) {
  if (data === MISSING) return "missing";
  if (code === "undeclared") return "";
  if (code === "referenceSame") return "";
  if (code === "domain") return describeKind(data);
  if (data === null) return "null";
  if (Array.isArray(data)) return "an array";
  switch (typeof data) {
    case "string":
      return data.length <= 40 ? JSON.stringify(data) : `a string (length ${data.length})`;
    case "number":
      return String(data);
    case "bigint":
      return `${data}n`;
    case "boolean":
      return String(data);
    case "undefined":
      return "undefined";
    case "object":
      return stringifyValue(data);
    case "function":
      return "a function";
    default:
      return "a symbol";
  }
}
function describeKind(data) {
  if (data === MISSING) return "missing";
  if (typeof data === "number" && Number.isNaN(data)) return "NaN";
  if (data === null) return "null";
  if (Array.isArray(data)) return "an object";
  switch (typeof data) {
    case "string":
      return "a string";
    case "number":
      return "a number";
    case "bigint":
      return "a bigint";
    case "boolean":
      return "boolean";
    case "undefined":
      return "undefined";
    case "object": {
      const ctor = Object.getPrototypeOf(data)?.constructor;
      return typeof ctor?.name === "string" && ctor.name !== "Object" ? ctor.name : "an object";
    }
    case "function":
      return "a function";
    default:
      return "a symbol";
  }
}
function describeExpectation(expected) {
  const divisor = /divisible by (\d+(?:\.\d+)?)/.exec(expected);
  if (divisor) {
    const rule = Number(divisor[1]);
    return { description: rule === 2 ? "even" : `divisible by ${rule}`, rule };
  }
  return { description: expected.replace(/^(?:an?|the) /, "") };
}
function formatPath(path) {
  let out = "";
  for (const key of path) {
    if (typeof key === "number") out += `[${key}]`;
    else if (typeof key === "symbol") out += `[${String(key)}]`;
    else out += out.length === 0 ? key : `.${key}`;
  }
  return out;
}
function errorCode(expected, data) {
  if (data === MISSING) return "required";
  if (expected === "removed") return "undeclared";
  if (expected.includes("serialized to the same value")) return "referenceSame";
  if (expected.includes("divisible by") || expected.includes("integer")) return "divisor";
  if (expected === "true" || expected === "false" || expected === "null" || expected === "undefined" || expected === "NaN" || expected === "Infinity" || expected === "-Infinity" || /^-?\d+(?:\.\d+)?n?$/.test(expected) || expected.includes(" or ") && expected.split(" or ").every((part) => /^".*"$|^-?\d+(?:\.\d+)?n?$|^(?:true|false|null|undefined)$/.test(part))) {
    return "unit";
  }
  if (expected.includes("at least") || expected.includes("more than") || expected.includes("timestamp after") || expected === "non-negative" || expected === "positive") {
    return "min";
  }
  if (expected.includes("at most") || expected.includes("less than") || expected.includes("timestamp before") || expected === "non-positive" || expected === "negative") {
    return "max";
  }
  if (expected.includes("matching") || expected.includes("format") || expected.includes("email") || expected.includes("parsable") || expected.includes("only digits")) {
    return "pattern";
  }
  if (expected.includes("predicate") || expected.includes("satisfying") || expected.includes("according to"))
    return "predicate";
  if (expected.startsWith('"') || expected.startsWith("the date ")) return "unit";
  if (expected === "an Error" || expected === "a Date" || expected.startsWith("an instance of ")) return "domain";
  if (expected.includes(" or ") && !expected.includes("IPv") || expected.endsWith(" instance") || expected.startsWith("a number representing") || [
    "a string",
    "a number",
    "a bigint",
    "a symbol",
    "boolean",
    "an object",
    "an array",
    "a tuple",
    "undefined",
    "null",
    "unknown",
    "never"
  ].includes(expected))
    return "domain";
  return "predicate";
}
var OmpErrors = class _OmpErrors {
  #path;
  #expected;
  #data;
  #entry;
  #entries;
  #config;
  #separator = "\n";
  constructor(path, expected, data, config) {
    this.#path = path;
    this.#expected = expected;
    this.#data = data;
    this.#config = config;
  }
  get length() {
    return this.#entries?.length ?? 1;
  }
  get 0() {
    return this.#entries?.[0] ?? this.#getEntry();
  }
  static single(path, expected, data, config) {
    return new _OmpErrors(path, expected, data, config);
  }
  #getEntry() {
    if (this.#entry) return this.#entry;
    const path = this.#path === void 0 ? [] : Array.isArray(this.#path) ? [...this.#path] : [this.#path];
    const entry2 = new OmpError(path, this.#expected, this.#data, this.#config);
    this.#entry = entry2;
    return entry2;
  }
  /** Append all failures from `other`, preserving traversal order. */
  append(other) {
    this.#entries ??= [this.#getEntry()];
    const entries = this.#entries;
    for (const entry2 of other) entries.push(entry2);
    return this;
  }
  /** Prefix every failure path with `key` when nesting sub-schemas. */
  prefix(key) {
    if (this.#entries) {
      for (const entry2 of this.#entries) entry2.prefix(key);
    } else {
      const path = this.#path;
      this.#path = path === void 0 ? [key] : Array.isArray(path) ? [key, ...path] : [key, path];
      this.#entry = void 0;
    }
    return this;
  }
  /** Apply schema-local message formatting without rebuilding failures. */
  configure(config) {
    if (this.#entries) {
      for (const entry2 of this.#entries) entry2.configure(config);
    } else {
      this.#config = { ...this.#config, ...config };
      this.#entry = void 0;
    }
    return this;
  }
  get byPath() {
    const result = {};
    for (const entry2 of this) result[entry2.path.map(String).join(".")] = entry2;
    return result;
  }
  map(fn) {
    const result = [];
    let index = 0;
    for (const entry2 of this) result.push(fn(entry2, index++, this));
    return result;
  }
  filter(fn) {
    const result = [];
    let index = 0;
    for (const entry2 of this) {
      if (fn(entry2, index++, this)) result.push(entry2);
    }
    return result;
  }
  *[Symbol.iterator]() {
    if (this.#entries) {
      yield* this.#entries;
    } else {
      yield this.#getEntry();
    }
  }
  /** @internal Render multiple branch failures as alternatives rather than independent failures. */
  asAlternatives() {
    this.#separator = " or ";
    return this;
  }
  get summary() {
    const entries = [...this];
    if (this.#separator === "\n" && entries.length > 1 && entries.every(
      (entry2) => Object.is(entry2.data, entries[0].data) && entry2.path.length === entries[0].path.length && entry2.path.every((key, index) => key === entries[0].path[index])
    )) {
      const at = formatPath(entries[0].path);
      const actual = typeof entries[0].data === "string" ? JSON.stringify(entries[0].data) : String(entries[0].data);
      return `${at}${at === "" ? "" : " "}(${actual}) must be...
${entries.map((entry2) => `  \u25E6 ${entry2.expected}`).join("\n")}`;
    }
    return entries.map((error) => error.message).join(this.#separator);
  }
  toString() {
    return this.summary;
  }
  throw() {
    throw new TraversalError(this);
  }
};
var TraversalError = class extends Error {
  constructor(errors) {
    super(errors.summary);
    this.errors = errors;
    this.name = "TraversalError";
  }
};
var OmpTypeError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "OmpTypeError";
  }
};

// ../../../omp/packages/omptype/src/keywords.ts
var NUMERIC = /^(?:(?!^-0\.?0*$)(?:-?(?:(?:0|[1-9]\d*)(?:\.\d+)?)|\.\d+?))$/;
var INTEGER = /^[+-]?(?:0|[1-9]\d*)$/;
var EMAIL = /^[\w%+.-]+@[\d.A-Za-z-]+\.[A-Za-z]{2,}$/;
var SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*))?(?:\+([\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*))?$/;
var UUID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
var IPV4_SEGMENT = "(?:[0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])";
var IPV4_ADDRESS = `(?:${IPV4_SEGMENT}[.]){3}${IPV4_SEGMENT}`;
var IPV4 = new RegExp(`^${IPV4_ADDRESS}$`);
var IPV6_SEGMENT = "(?:[0-9a-fA-F]{1,4})";
var IPV6 = new RegExp(
  `^((?:${IPV6_SEGMENT}:){7}(?:${IPV6_SEGMENT}|:)|(?:${IPV6_SEGMENT}:){6}(?:${IPV4_ADDRESS}|:${IPV6_SEGMENT}|:)|(?:${IPV6_SEGMENT}:){5}(?::${IPV4_ADDRESS}|(:${IPV6_SEGMENT}){1,2}|:)|(?:${IPV6_SEGMENT}:){4}(?:(:${IPV6_SEGMENT}){0,1}:${IPV4_ADDRESS}|(:${IPV6_SEGMENT}){1,3}|:)|(?:${IPV6_SEGMENT}:){3}(?:(:${IPV6_SEGMENT}){0,2}:${IPV4_ADDRESS}|(:${IPV6_SEGMENT}){1,4}|:)|(?:${IPV6_SEGMENT}:){2}(?:(:${IPV6_SEGMENT}){0,3}:${IPV4_ADDRESS}|(:${IPV6_SEGMENT}){1,5}|:)|(?:${IPV6_SEGMENT}:){1}(?:(:${IPV6_SEGMENT}){0,4}:${IPV4_ADDRESS}|(:${IPV6_SEGMENT}){1,6}|:)|(?::((?::${IPV6_SEGMENT}){0,5}:${IPV4_ADDRESS}|(?::${IPV6_SEGMENT}){1,7}|:)))(?:%[\\d.A-Za-z]{1,})?$`
);
var ISO_DATE = /^([+-]?\d{4}(?!\d{2}\b))((-?)((0[1-9]|1[0-2])(\3([12]\d|0[1-9]|3[01]))?|W([0-4]\d|5[0-3])(-?[1-7])?|(00[1-9]|0[1-9]\d|[12]\d{2}|3([0-5]\d|6[1-6])))(T((([01]\d|2[0-3])((:?)[0-5]\d)?|24:?00)([,.]\d+(?!:))?)?(\17[0-5]\d([,.]\d+)?)?([Zz]|([+-])([01]\d|2[0-3]):?([0-5]\d)?)?)?)?$/;
function pattern(regex, expected, format2) {
  return {
    k: "refine",
    base: { k: "string" },
    pred: (value) => {
      regex.lastIndex = 0;
      return regex.test(value);
    },
    expected,
    json: format2 === void 0 ? { pattern: regex.source } : { pattern: regex.source, format: format2 }
  };
}
function morph(input, fn, out) {
  return { k: "morph", input, fn: (value, context) => fn(value, context), out };
}
function parsableJson() {
  return {
    k: "refine",
    base: { k: "string" },
    pred: (value) => {
      try {
        JSON.parse(value);
        return true;
      } catch {
        return false;
      }
    },
    expected: "a JSON string",
    json: { contentMediaType: "application/json" }
  };
}
function parsableDate(expected = "a parsable date") {
  return {
    k: "refine",
    base: { k: "string" },
    pred: (value) => !Number.isNaN(new Date(value).valueOf()),
    expected,
    json: { format: "date-time" }
  };
}
function normalize(form) {
  return morph({ k: "string" }, (value) => value.normalize(form), patternForNormalized(form));
}
function patternForNormalized(form) {
  return {
    k: "refine",
    base: { k: "string" },
    pred: (value) => value.normalize(form) === value,
    expected: `${form}-normalized unicode`
  };
}
function uuidVersion(version) {
  return pattern(
    new RegExp(`^[\\da-f]{8}-[\\da-f]{4}-${version}[\\da-f]{3}-[89ab][\\da-f]{3}-[\\da-f]{12}$`, "i"),
    `a UUIDv${version}`,
    "uuid"
  );
}
function isLuhnValid(input) {
  const value = input.replace(/[ -]+/g, "");
  let sum = 0;
  let double = false;
  for (let index = value.length - 1; index >= 0; index--) {
    let digit = Number(value[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return value.length > 0 && sum % 10 === 0;
}
function finiteNumber(expected = "a number") {
  return {
    k: "refine",
    base: { k: "unknown" },
    pred: (value) => typeof value === "number" && !Number.isNaN(value),
    expected
  };
}
function jsonObject() {
  const value = {};
  const resolveValue = () => value.current;
  const object = {
    k: "object",
    props: [],
    index: { k: "alias", name: "$jsonValue", resolve: resolveValue },
    extras: "keep"
  };
  const array = {
    k: "array",
    el: { k: "alias", name: "$jsonValue", resolve: resolveValue },
    desc: "an object"
  };
  value.current = {
    k: "union",
    members: [
      object,
      array,
      { k: "number" },
      { k: "string" },
      { k: "lit", v: false },
      { k: "null" },
      { k: "lit", v: true }
    ]
  };
  return object;
}
function instance(ctor, name) {
  return { k: "instance", ctor, expected: `${/^[AEIOU]/.test(name) ? "an" : "a"} ${name} instance` };
}
var keywordFactories = {
  string: () => ({ k: "string" }),
  Key: () => ({ k: "union", members: [{ k: "string" }, { k: "symbol" }] }),
  "unknown.any": () => ({ k: "unknown" }),
  Array: () => ({ k: "array", el: { k: "unknown" } }),
  Function: () => instance(Function, "Function"),
  RegExp: () => instance(RegExp, "RegExp"),
  File: () => instance(File, "File"),
  Error: () => instance(Error, "Error"),
  Set: () => instance(Set, "Set"),
  Map: () => instance(Map, "Map"),
  WeakSet: () => instance(WeakSet, "WeakSet"),
  WeakMap: () => instance(WeakMap, "WeakMap"),
  Promise: () => instance(Promise, "Promise"),
  FormData: () => instance(FormData, "FormData"),
  "FormData.parse": () => ({
    k: "morph",
    input: instance(FormData, "FormData"),
    fn: (value) => {
      const out = {};
      for (const [key, entry2] of value.entries()) {
        const current = out[key];
        out[key] = current === void 0 ? entry2 : Array.isArray(current) ? [...current, entry2] : [current, entry2];
      }
      return out;
    },
    out: { k: "object", props: [], index: { k: "unknown" }, extras: "keep" }
  }),
  "object.json": jsonObject,
  "object.json.stringify": () => ({
    k: "morph",
    input: jsonObject(),
    fn: (value) => JSON.stringify(value),
    out: { k: "string" }
  }),
  "number.epoch": () => ({
    k: "refine",
    base: {
      k: "refine",
      base: {
        k: "refine",
        base: finiteNumber("a number representing a Unix timestamp"),
        pred: (value) => Number.isInteger(value),
        expected: "an integer representing a Unix timestamp"
      },
      pred: (value) => value >= -864e13,
      expected: "a Unix timestamp after -8640000000000000"
    },
    pred: (value) => value <= 864e13,
    expected: "a Unix timestamp before 8640000000000000"
  }),
  "number.safe": () => ({
    k: "refine",
    base: {
      k: "refine",
      base: finiteNumber(),
      pred: (value) => value >= Number.MIN_SAFE_INTEGER,
      expected: `at least ${Number.MIN_SAFE_INTEGER}`
    },
    pred: (value) => value <= Number.MAX_SAFE_INTEGER,
    expected: `at most ${Number.MAX_SAFE_INTEGER}`
  }),
  "number.NaN": () => ({
    k: "refine",
    base: { k: "unknown" },
    pred: Number.isNaN,
    expected: "NaN"
  }),
  "number.Infinity": () => ({ k: "lit", v: Number.POSITIVE_INFINITY }),
  "number.NegativeInfinity": () => ({ k: "lit", v: Number.NEGATIVE_INFINITY }),
  "string.alpha": () => pattern(/^[A-Za-z]*$/, "only letters"),
  "string.alphanumeric": () => pattern(/^[\dA-Za-z]*$/, "only letters and digits 0-9"),
  "string.hex": () => pattern(/^[\dA-Fa-f]+$/, "hex characters only"),
  "string.base64": () => pattern(/^(?:[\d+/A-Za-z]{4})*(?:[\d+/A-Za-z]{2}==|[\d+/A-Za-z]{3}=)?$/, "base64-encoded"),
  "string.base64.url": () => pattern(/^(?:[\w-]{4})*(?:[\w-]{2}(?:==|%3D%3D)?|[\w-]{3}(?:=|%3D)?)?$/, "base64url-encoded"),
  "string.capitalize": () => morph({ k: "string" }, (value) => value.charAt(0).toUpperCase() + value.slice(1)),
  "string.capitalize.preformatted": () => pattern(/^[A-Z].*$/, "capitalized"),
  "string.creditCard": () => ({
    k: "refine",
    base: pattern(
      /^(?:4\d{12}(?:\d{3,6})?|5[1-5]\d{14}|3[47]\d{13}|6(?:011|5\d\d)\d{12,15})$/,
      "a credit card number"
    ),
    pred: (value) => isLuhnValid(value),
    expected: "a credit card number"
  }),
  "string.date": () => parsableDate(),
  "string.date.parse": () => morph(parsableDate(), (value) => new Date(value), { k: "instance", ctor: Date, expected: "a Date" }),
  "string.date.iso": () => pattern(ISO_DATE, "an ISO 8601 date", "date-time"),
  "string.date.iso.parse": () => morph(pattern(ISO_DATE, "an ISO 8601 date", "date-time"), (value) => new Date(value), {
    k: "instance",
    ctor: Date,
    expected: "a Date"
  }),
  "string.date.epoch": () => pattern(INTEGER, "an integer string representing a Unix timestamp"),
  "string.date.epoch.parse": () => morph(pattern(INTEGER, "an integer string representing a Unix timestamp"), (value) => new Date(Number(value)), {
    k: "instance",
    ctor: Date,
    expected: "a Date"
  }),
  "string.digits": () => pattern(/^\d*$/, "only digits 0-9"),
  "string.email": () => pattern(EMAIL, "an email address", "email"),
  "string.integer": () => pattern(INTEGER, "a well-formed integer string"),
  "string.integer.parse": () => morph(
    pattern(INTEGER, "a well-formed integer string"),
    (value, context) => {
      const parsed = Number.parseInt(value, 10);
      return Number.isSafeInteger(parsed) ? parsed : context.error("a safe integer string");
    },
    { k: "number", int: true }
  ),
  "string.ip": () => ({
    k: "union",
    members: [pattern(IPV4, "an IPv4 address", "ipv4"), pattern(IPV6, "an IPv6 address", "ipv6")]
  }),
  "string.ip.v4": () => pattern(IPV4, "an IPv4 address", "ipv4"),
  "string.ip.v6": () => pattern(IPV6, "an IPv6 address", "ipv6"),
  "string.json": () => parsableJson(),
  "string.json.parse": () => morph(parsableJson(), (value, context) => {
    try {
      return JSON.parse(value);
    } catch {
      return context.error("a JSON string");
    }
  }),
  "string.lower": () => morph({ k: "string" }, (value) => value.toLowerCase()),
  "string.lower.preformatted": () => pattern(/^[a-z]*$/, "only lowercase letters"),
  "string.normalize": () => normalize("NFC"),
  "string.normalize.NFC": () => normalize("NFC"),
  "string.normalize.NFC.preformatted": () => patternForNormalized("NFC"),
  "string.normalize.NFD": () => normalize("NFD"),
  "string.normalize.NFD.preformatted": () => patternForNormalized("NFD"),
  "string.normalize.NFKC": () => normalize("NFKC"),
  "string.normalize.NFKC.preformatted": () => patternForNormalized("NFKC"),
  "string.normalize.NFKD": () => normalize("NFKD"),
  "string.normalize.NFKD.preformatted": () => patternForNormalized("NFKD"),
  "string.numeric": () => pattern(NUMERIC, "a well-formed numeric string"),
  "string.numeric.parse": () => morph(pattern(NUMERIC, "a well-formed numeric string"), (value) => Number.parseFloat(value), { k: "number" }),
  "string.regex": () => ({
    k: "refine",
    base: { k: "string" },
    pred: (value) => {
      try {
        new RegExp(value);
        return true;
      } catch {
        return false;
      }
    },
    expected: "a regex pattern",
    json: { format: "regex" }
  }),
  "string.semver": () => pattern(SEMVER, "a semantic version"),
  "string.trim": () => morph({ k: "string" }, (value) => value.trim()),
  "string.trim.preformatted": () => pattern(/^\S.*\S$|^\S?$/, "trimmed"),
  "string.upper": () => morph({ k: "string" }, (value) => value.toUpperCase()),
  "string.upper.preformatted": () => pattern(/^[A-Z]*$/, "only uppercase letters"),
  "string.url": () => ({ k: "string", url: true }),
  "string.url.parse": () => morph({ k: "string", url: true }, (value) => new URL(value), { k: "instance", ctor: URL, expected: "a URL" }),
  "string.uuid": () => pattern(UUID, "a UUID", "uuid"),
  "string.uuid.v1": () => uuidVersion("1"),
  "string.uuid.v2": () => uuidVersion("2"),
  "string.uuid.v3": () => uuidVersion("3"),
  "string.uuid.v4": () => uuidVersion("4"),
  "string.uuid.v5": () => uuidVersion("5"),
  "string.uuid.v6": () => uuidVersion("6"),
  "string.uuid.v7": () => uuidVersion("7"),
  "string.uuid.v8": () => uuidVersion("8"),
  "parse.number": () => morph(pattern(NUMERIC, "a well-formed numeric string"), (value) => Number.parseFloat(value), { k: "number" }),
  "parse.integer": () => morph(pattern(INTEGER, "a well-formed integer string"), (value) => Number.parseInt(value, 10), {
    k: "number",
    int: true
  }),
  "parse.json": () => keywordFactories["string.json.parse"](),
  "parse.date": () => keywordFactories["string.date.parse"](),
  "parse.url": () => keywordFactories["string.url.parse"](),
  "parse.boolean": () => morph(pattern(/^(?:true|false)$/, "a boolean string"), (value) => value === "true", { k: "boolean" }),
  "parse.bigint": () => morph(pattern(INTEGER, "an integer string"), (value) => BigInt(value), { k: "bigint" })
};
function keywordIR(name) {
  return keywordFactories[name]?.();
}
function patternIR(regex) {
  return pattern(regex, `a string matching ${regex}`);
}
function templateIR(source) {
  let patternSource = "^";
  let index = 0;
  const placeholder = /\$\{(string|number|bigint|boolean)\}/g;
  for (let match = placeholder.exec(source); match; match = placeholder.exec(source)) {
    patternSource += escapeRegex(source.slice(index, match.index));
    switch (match[1]) {
      case "number":
        patternSource += "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
        break;
      case "bigint":
        patternSource += "[+-]?\\d+";
        break;
      case "boolean":
        patternSource += "(?:true|false)";
        break;
      default:
        patternSource += ".*";
    }
    index = match.index + match[0].length;
  }
  patternSource += `${escapeRegex(source.slice(index))}$`;
  return pattern(new RegExp(patternSource), `a string matching \`${source}\``);
}
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ../../../omp/packages/omptype/src/ir.ts
var IR_BRAND = Symbol("omptype.schema");
var kMorph = Symbol("omptype.hasMorph");
var kMorphOwner = Symbol("omptype.hasMorphOwner");
var kAlias = Symbol("omptype.hasAlias");
var kAliasOwner = Symbol("omptype.hasAliasOwner");
var kSimple = Symbol("omptype.simple");
var kSimpleOwner = Symbol("omptype.simpleOwner");
var SIMPLE_OPS = "|&()[]=?%,#";
function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "	" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "d" && (src[i + 1] === "'" || src[i + 1] === '"')) {
      const quote = src[i + 1];
      const end = src.indexOf(quote, i + 2);
      if (end < 0) throw new OmpTypeError(`unterminated date literal in "${src}"`);
      const source = src.slice(i + 2, end).trim();
      const value = /^\d+$/.test(source) ? new Date(Number(source)) : new Date(source);
      if (Number.isNaN(value.valueOf())) throw new OmpTypeError(`invalid date literal in "${src}"`);
      toks.push({ t: "date", v: value });
      i = end + 1;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let value = "";
      for (; j < n && src[j] !== c; j++) {
        if (src[j] === "\\") {
          j++;
          if (j >= n) break;
        }
        value += src[j];
      }
      if (j >= n) throw new OmpTypeError(`unterminated string literal in "${src}"`);
      toks.push({ t: "str", v: value });
      i = j + 1;
      continue;
    }
    if (c === "/") {
      let j = i + 1;
      for (; j < n; j++) {
        if (src[j] === "\\") j++;
        else if (src[j] === "/") break;
      }
      if (j >= n) throw new OmpTypeError(`unterminated regular expression in "${src}"`);
      let end = j + 1;
      while (end < n && /[dgimsuvy]/.test(src[end])) end++;
      const source = src.slice(i + 1, j);
      const flags = src.slice(j + 1, end);
      try {
        toks.push({ t: "regex", v: new RegExp(source, flags) });
      } catch {
        throw new OmpTypeError(`invalid regular expression "${src.slice(i, end)}"`);
      }
      i = end;
      continue;
    }
    if (c >= "0" && c <= "9" || c === "-" && i + 1 < n && src[i + 1] >= "0" && src[i + 1] <= "9") {
      let j = i + 1;
      while (j < n && /[\w.+-]/.test(src[j])) j++;
      const raw = src.slice(i, j);
      if (/^-?(?:0|[1-9]\d*)n$/.test(raw) && raw !== "-0n") {
        toks.push({ t: "bigint", v: BigInt(raw.slice(0, -1)) });
      } else {
        const valid = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw) && !Object.is(Number(raw), -0) && String(Number(raw)) === raw;
        if (!valid) throw new OmpTypeError(`Malformed number literal '${raw}'`);
        toks.push({ t: "num", v: Number(raw) });
      }
      i = j;
      continue;
    }
    if (/[a-zA-Z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.$]/.test(src[j])) j++;
      toks.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === "<" || c === ">") {
      if (src[i + 1] === "=") {
        toks.push({ t: "op", v: `${c}=` });
        i += 2;
      } else {
        toks.push({ t: "op", v: c });
        i++;
      }
      continue;
    }
    if (c === "=" && src[i + 1] === "=") {
      toks.push({ t: "op", v: "==" });
      i += 2;
      continue;
    }
    if (SIMPLE_OPS.includes(c)) {
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new OmpTypeError(`unexpected character '${c}' in "${src}"`);
  }
  return toks;
}
var CMP = { "<": true, "<=": true, ">": true, ">=": true };
var KEYWORDS = {
  number: () => ({ k: "number" }),
  "number.integer": () => ({ k: "number", int: true }),
  boolean: () => ({ k: "boolean" }),
  bigint: () => ({ k: "bigint" }),
  symbol: () => ({ k: "symbol" }),
  never: () => ({ k: "never" }),
  null: () => ({ k: "null" }),
  undefined: () => ({ k: "undefined" }),
  unknown: () => ({ k: "unknown" }),
  any: () => ({ k: "unknown" }),
  object: () => ({ k: "anyobject" }),
  Date: () => ({ k: "instance", ctor: Date, expected: "a Date" }),
  true: () => ({ k: "lit", v: true }),
  false: () => ({ k: "lit", v: false })
};
var THIS_ONLY_RESOLVERS = /* @__PURE__ */ new WeakSet();
function markThisOnlyResolver(resolve2) {
  THIS_ONLY_RESOLVERS.add(resolve2);
}
var StrParser = class {
  #toks;
  #pos = 0;
  #src;
  #resolve;
  constructor(src, resolve2) {
    this.#src = src;
    this.#resolve = resolve2;
    this.#toks = tokenize(src);
  }
  #peek(offset = 0) {
    return this.#toks[this.#pos + offset];
  }
  #next() {
    const t = this.#toks[this.#pos++];
    if (!t) throw new OmpTypeError(`unexpected end of definition "${this.#src}"`);
    return t;
  }
  #eatOp(v) {
    const t = this.#peek();
    if (t?.t === "op" && t.v === v) {
      this.#pos++;
      return true;
    }
    return false;
  }
  /** Full definition with optional trailing `= literal` default and/or `?` optional marker. */
  parseTop() {
    const ir = this.parseUnion();
    let def;
    let hasDefault = false;
    if (this.#eatOp("=")) {
      const t = this.#next();
      if (t.t === "num" || t.t === "bigint" || t.t === "date" || t.t === "str") def = t.v;
      else if (t.t === "id" && (t.v === "true" || t.v === "false")) def = t.v === "true";
      else if (t.t === "id" && t.v === "null") def = null;
      else if (t.t === "id" && t.v === "undefined") def = void 0;
      else throw new OmpTypeError(`unsupported default literal in "${this.#src}"`);
      hasDefault = true;
    }
    const optional = this.#eatOp("?");
    this.#expectEnd();
    return { ir, def, hasDefault, optional };
  }
  #expectEnd() {
    if (this.#pos < this.#toks.length) {
      throw new OmpTypeError(`trailing tokens in definition "${this.#src}"`);
    }
  }
  parseUnion() {
    const first = this.parseIntersection();
    if (!this.#eatOp("|")) return first;
    const members = [first, this.parseIntersection()];
    while (this.#eatOp("|")) members.push(this.parseIntersection());
    return { k: "union", members };
  }
  parseIntersection() {
    const first = this.parseBounded();
    if (!this.#eatOp("&")) return first;
    const members = [first, this.parseBounded()];
    while (this.#eatOp("&")) members.push(this.parseBounded());
    const literal = members.find((member) => member.k === "lit");
    if (literal && typeof literal.v === "number") {
      for (const member of members) {
        if (member.k === "number" && (member.int && !Number.isInteger(literal.v) || member.divisor !== void 0 && literal.v % member.divisor !== 0 || member.min !== void 0 && (member.xmin ? literal.v <= member.min : literal.v < member.min) || member.max !== void 0 && (member.xmax ? literal.v >= member.max : literal.v > member.max))) {
          throw new OmpTypeError("literal is excluded by intersection");
        }
      }
      return literal;
    }
    return { k: "intersection", members };
  }
  /**
   * `NUM CMP base (CMP NUM)?` or `base (CMP NUM)?`, with `[]*` postfix on the
   * base AND after a trailing bound — `string>0[]` is an array of bounded
   * strings, matching ArkType precedence (bounds bind tighter than `[]`).
   */
  parseBounded() {
    const t = this.#peek();
    const t1 = this.#peek(1);
    if ((t?.t === "num" || t?.t === "date") && t1?.t === "op" && (t1.v === "<" || t1.v === "<=")) {
      const lo = t.v;
      this.#pos += 2;
      let node2 = this.#eatDivisor(this.parsePostfix());
      node2 = applyBound(node2, flip(t1.v), lo, this.#src);
      const t22 = this.#peek();
      if (!(t22?.t === "op" && CMP[t22.v])) {
        throw new OmpTypeError(`left bound requires a corresponding right bound in "${this.#src}"`);
      }
      if (t22.v === ">" || t22.v === ">=") {
        throw new OmpTypeError(`right bound must use < or <= in "${this.#src}"`);
      }
      this.#pos++;
      const hi = this.#next();
      if (hi.t !== "num" && hi.t !== "date") {
        throw new OmpTypeError(`expected bound after comparator in "${this.#src}"`);
      }
      node2 = applyBound(node2, t22.v, hi.v, this.#src);
      return this.#eatArraySuffixes(node2);
    }
    let node = this.#eatDivisor(this.parsePostfix());
    const t2 = this.#peek();
    if (t2?.t === "op" && t2.v === "==") {
      this.#pos++;
      const limit = this.#next();
      if (limit.t !== "num" && limit.t !== "bigint" && limit.t !== "date") {
        throw new OmpTypeError(`expected literal after == in "${this.#src}"`);
      }
      node = applyEquality(node, limit.v, this.#src);
    } else if (t2?.t === "op" && CMP[t2.v] && (this.#peek(1)?.t === "num" || this.#peek(1)?.t === "date")) {
      this.#pos++;
      const limit = this.#next();
      node = applyBound(node, t2.v, limit.v, this.#src);
      node = this.#eatArraySuffixes(node);
    }
    return node;
  }
  #eatDivisor(node) {
    if (!this.#eatOp("%")) return node;
    const divisor = this.#next();
    if (divisor.t !== "num") throw new OmpTypeError(`expected number after % in "${this.#src}"`);
    if (node.k !== "number") throw new OmpTypeError(`% requires number in "${this.#src}"`);
    if (!Number.isFinite(divisor.v) || !Number.isInteger(divisor.v) || divisor.v === 0)
      throw new OmpTypeError(`divisor must be a non-zero integer in "${this.#src}"`);
    return { ...node, divisor: Math.abs(divisor.v) };
  }
  /** Wrap `node` in array IR for each `[]` pair at the cursor. */
  #eatArraySuffixes(node) {
    for (; ; ) {
      const t = this.#peek();
      if (!(t?.t === "op" && t.v === "[")) return node;
      this.#pos++;
      if (!this.#eatOp("]")) throw new OmpTypeError(`expected ']' in "${this.#src}"`);
      node = { k: "array", el: node };
    }
  }
  parsePostfix() {
    let node = this.parsePrimary();
    for (; ; ) {
      const t = this.#peek();
      if (t?.t === "op" && t.v === "[") {
        this.#pos++;
        if (!this.#eatOp("]")) throw new OmpTypeError(`expected ']' in "${this.#src}"`);
        node = { k: "array", el: node };
        continue;
      }
      if (t?.t === "op" && t.v === "#") {
        this.#pos++;
        const name = this.#next();
        if (name.t !== "id") throw new OmpTypeError(`expected brand name after # in "${this.#src}"`);
        continue;
      }
      break;
    }
    return node;
  }
  #parseGenericArguments() {
    this.#eatOp("<");
    const arguments_ = [];
    if (this.#eatOp(">")) return arguments_;
    for (; ; ) {
      arguments_.push(this.parseUnion());
      if (this.#eatOp(">")) return arguments_;
      if (!this.#eatOp(",")) throw new OmpTypeError(`expected ',' or '>' in "${this.#src}"`);
      const next = this.#peek();
      if (next?.t === "op" && (next.v === "," || next.v === ">")) {
        throw new OmpTypeError(`generic arguments cannot be empty in "${this.#src}"`);
      }
    }
  }
  parsePrimary() {
    const t = this.#next();
    if (t.t === "op" && t.v === "(") {
      const inner = this.parseUnion();
      if (!this.#eatOp(")")) throw new OmpTypeError(`expected ')' in "${this.#src}"`);
      return inner;
    }
    if (t.t === "str" || t.t === "num" || t.t === "bigint" || t.t === "date") return { k: "lit", v: t.v };
    if (t.t === "regex") return patternIR(t.v);
    if (t.t === "id") {
      if (t.v === "keyof") {
        try {
          return keyOf(this.parsePostfix());
        } catch (error) {
          if (error instanceof OmpTypeError) throw new OmpTypeError("keyof operand must be an object");
          throw error;
        }
      }
      if (t.v === "Array.liftFrom" && this.#peek()?.t === "op" && this.#peek()?.v === "<") {
        this.#pos++;
        const element = this.parsePrimary();
        if (!this.#eatOp(">")) throw new OmpTypeError(`expected '>' in "${this.#src}"`);
        const array = { k: "array", el: element, desc: "an object" };
        return {
          k: "morph",
          input: { k: "union", members: [element, array] },
          fn: (value) => Array.isArray(value) ? value : [value],
          out: array
        };
      }
      if (t.v === "Record" && this.#peek()?.t === "op" && this.#peek()?.v === "<") {
        const arguments_ = this.#parseGenericArguments();
        if (arguments_.length !== 2) throw new OmpTypeError("Record requires two arguments");
        return { k: "object", props: [], index: arguments_[1], extras: "keep" };
      }
      if (this.#peek()?.t === "op" && this.#peek()?.v === "<" && this.#resolve?.hasGeneric?.(t.v)) {
        const arguments_ = this.#parseGenericArguments();
        const instantiated = this.#resolve.generic?.(t.v, arguments_);
        if (!instantiated) throw new OmpTypeError(`unknown generic "${t.v}" in "${this.#src}"`);
        return instantiated;
      }
      const scoped = this.#resolve?.(t.v);
      const make = KEYWORDS[t.v];
      const keyword = scoped ?? make?.() ?? keywordIR(t.v);
      if (!keyword) throw new OmpTypeError(`unknown keyword "${t.v}" in "${this.#src}"`);
      return keyword;
    }
    throw new OmpTypeError(`unexpected token in "${this.#src}"`);
  }
};
var STRING_DEF_CACHE_MAX = 1024;
var stringDefCache = /* @__PURE__ */ new Map();
function isWhitespaceAt(src, index) {
  const code = src.charCodeAt(index);
  return code === 32 || code >= 9 && code <= 13 || code > 127 && /\s/.test(src[index]);
}
function parseLiteralUnion(src) {
  const members = [];
  let index = 0;
  while (index < src.length && isWhitespaceAt(src, index)) index++;
  for (; ; ) {
    const quote = src[index];
    if (quote !== "'" && quote !== '"') return void 0;
    const end = src.indexOf(quote, index + 1);
    if (end < 0) return void 0;
    members.push({ k: "lit", v: src.slice(index + 1, end) });
    index = end + 1;
    while (index < src.length && isWhitespaceAt(src, index)) index++;
    if (index === src.length) {
      const ir = members.length === 1 ? members[0] : { k: "union", members };
      let simple = true;
      for (let member = 1; simple && member < members.length; member++) {
        for (let previous = 0; previous < member; previous++) {
          if (members[previous].k === "lit" && members[previous].v === members[member].v) {
            simple = false;
            break;
          }
        }
      }
      ir[kSimple] = simple;
      ir[kSimpleOwner] = ir;
      return ir;
    }
    if (src[index] !== "|") return void 0;
    index++;
    while (index < src.length && isWhitespaceAt(src, index)) index++;
  }
}
function genericArguments(src) {
  const open = src.indexOf("<");
  if (open < 1 || !src.endsWith(">")) return void 0;
  const name = src.slice(0, open).trim();
  const body = src.slice(open + 1, -1);
  const args = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (quote !== "") {
      if (char === quote && body[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "<" || char === "(" || char === "[") {
      depth++;
    } else if (char === ">" || char === ")" || char === "]") {
      depth--;
    } else if (char === "," && depth === 0) {
      args.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  args.push(body.slice(start).trim());
  return { name, args };
}
function genericKeys(ir) {
  const keys = /* @__PURE__ */ new Set();
  const visit2 = (node) => {
    if (node.k === "lit" && typeof node.v === "string") keys.add(node.v);
    else if (node.k === "union") for (const member of node.members) visit2(member);
  };
  visit2(ir);
  return keys;
}
function resolveStructuralIR(ir) {
  const seen = /* @__PURE__ */ new Set();
  while (ir.k === "alias") {
    if (seen.has(ir)) throw new OmpTypeError(`cannot structurally transform recursive alias "${ir.name}"`);
    seen.add(ir);
    ir = ir.resolve();
  }
  return ir;
}
function mergeObjectIR(left, right) {
  left = resolveStructuralIR(left);
  right = resolveStructuralIR(right);
  if (left.k !== "object" || right.k !== "object") {
    throw new OmpTypeError("Merge requires object arguments");
  }
  const props = [...left.props];
  for (const prop of right.props) {
    const index = props.findIndex((candidate) => candidate.key === prop.key);
    if (index < 0) props.push(prop);
    else props[index] = prop;
  }
  return {
    k: "object",
    props,
    index: right.index ?? left.index,
    symbolIndex: right.symbolIndex ?? left.symbolIndex,
    patternIndexes: left.patternIndexes === void 0 && right.patternIndexes === void 0 ? void 0 : [...left.patternIndexes ?? [], ...right.patternIndexes ?? []],
    extras: right.extras === "keep" ? left.extras : right.extras
  };
}
function parseGeneric(src, resolve2) {
  const generic = genericArguments(src);
  if (generic === void 0) return void 0;
  if (generic.name === "Array.liftFrom" && generic.args.length === 1) {
    const element = parseDef(generic.args[0], resolve2);
    const array = { k: "array", el: element, desc: "an object" };
    return {
      k: "morph",
      input: { k: "union", members: [element, array] },
      fn: (value) => Array.isArray(value) ? value : [value],
      out: array
    };
  }
  if (generic.name === "Record" && generic.args.length === 2) {
    return { k: "object", props: [], index: parseDef(generic.args[1], resolve2), extras: "keep" };
  }
  if ((generic.name === "Extract" || generic.name === "Exclude") && generic.args.length === 2) {
    return distributeFilter(
      parseDef(generic.args[0], resolve2),
      parseDef(generic.args[1], resolve2),
      generic.name === "Extract"
    );
  }
  if ((generic.name === "Partial" || generic.name === "Required") && generic.args.length === 1) {
    const object = resolveStructuralIR(parseDef(generic.args[0], resolve2));
    if (object.k !== "object") throw new OmpTypeError(`${generic.name} requires an object`);
    const optional = generic.name === "Partial";
    return { ...object, props: object.props.map((prop) => ({ ...prop, opt: optional })) };
  }
  if ((generic.name === "Pick" || generic.name === "Omit") && generic.args.length === 2) {
    const object = resolveStructuralIR(parseDef(generic.args[0], resolve2));
    if (object.k !== "object") throw new OmpTypeError(`${generic.name} requires an object`);
    const keys = genericKeys(parseDef(generic.args[1], resolve2));
    const pick = generic.name === "Pick";
    return { ...object, props: object.props.filter((prop) => keys.has(prop.key) === pick) };
  }
  if (generic.name === "Merge" && generic.args.length === 2) {
    return mergeObjectIR(parseDef(generic.args[0], resolve2), parseDef(generic.args[1], resolve2));
  }
  return void 0;
}
var isAssignable = () => false;
function useAssignability(compare) {
  isAssignable = compare;
}
function distributeFilter(base, target, keepAssignable) {
  const resolved = base.k === "alias" ? base.resolve() : base;
  const members = resolved.k === "union" ? resolved.members : [resolved];
  const retained = members.filter((member) => isAssignable(member, target) === keepAssignable);
  if (retained.length === 0) return { k: "never" };
  return retained.length === 1 ? retained[0] : { k: "union", members: retained };
}
function parseRegexExec(src) {
  if (!src.startsWith("x/")) return void 0;
  const end = src.lastIndexOf("/");
  if (end < 2) throw new OmpTypeError(`unterminated regular expression in "${src}"`);
  let regex;
  try {
    regex = new RegExp(src.slice(2, end), src.slice(end + 1));
  } catch {
    throw new OmpTypeError(`invalid regular expression "${src.slice(1)}"`);
  }
  return {
    k: "morph",
    input: patternIR(regex),
    fn: (value, context) => {
      regex.lastIndex = 0;
      return regex.exec(value) ?? context.error(`a string matching ${regex}`);
    }
  };
}
function parseStringDef(src, resolve2) {
  const cacheable = resolve2 === void 0 || !src.includes("this") && THIS_ONLY_RESOLVERS.has(resolve2);
  if (cacheable) {
    const cached = stringDefCache.get(src);
    if (cached) return cached;
  }
  const pipeIndex = src.indexOf("|>");
  if (pipeIndex >= 0) {
    const input = src.slice(0, pipeIndex).trim();
    const output = src.slice(pipeIndex + 2).trim();
    if (input.length === 0 || output.length === 0) {
      throw new OmpTypeError(`pipe expression requires operands in "${src}"`);
    }
    const parsedInput = parseStringDef(input, resolve2);
    if (parsedInput.hasDefault) {
      throw new OmpTypeError(`unexpected pipe expression after default in "${src}"`);
    }
    const parsed2 = {
      ir: {
        k: "morph",
        input: parsedInput.ir,
        fn: (value) => value,
        out: parseStringDef(output, resolve2).ir
      },
      hasDefault: false,
      optional: false
    };
    if (cacheable && stringDefCache.size < STRING_DEF_CACHE_MAX) stringDefCache.set(src, parsed2);
    return parsed2;
  }
  let ir = parseLiteralUnion(src) ?? parseRegexExec(src) ?? parseGeneric(src, resolve2);
  if (ir === void 0 && src.startsWith("`") && src.endsWith("`")) {
    ir = templateIR(src.slice(1, -1));
  }
  const parsed = ir === void 0 ? new StrParser(src, resolve2).parseTop() : { ir, hasDefault: false, optional: false };
  if (cacheable && stringDefCache.size < STRING_DEF_CACHE_MAX) stringDefCache.set(src, parsed);
  return parsed;
}
function flip(op) {
  switch (op) {
    case "<":
      return ">";
    case "<=":
      return ">=";
    case ">":
      return "<";
    default:
      return "<=";
  }
}
function applyEquality(node, value, src) {
  if (node.k === "union") {
    return { k: "union", members: node.members.map((member) => applyEquality(member, value, src)) };
  }
  if (value instanceof Date) {
    if (!acceptsDate(node)) throw new OmpTypeError(`Date equality requires Date in "${src}"`);
    return { k: "lit", v: value };
  }
  if (node.k === "number" && typeof value === "number") return { k: "lit", v: value };
  if (node.k === "bigint" && typeof value === "bigint") return { k: "lit", v: value };
  if ((node.k === "string" || node.k === "array") && typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new OmpTypeError(`exact length must be a non-negative integer in "${src}"`);
    }
    return { ...node, min: value, max: value };
  }
  throw new OmpTypeError(`equality literal is incompatible with ${node.k} in "${src}"`);
}
function applyBound(node, op, value, src) {
  if (node.k === "alias") return applyBound(node.resolve(), op, value, src);
  if (node.k === "refine" && !(value instanceof Date)) {
    return { ...node, base: applyBound(node.base, op, value, src) };
  }
  if (node.k === "union") {
    const kinds = new Set(node.members.map(boundKind));
    if (kinds.size !== 1) throw new OmpTypeError(`cannot apply one bound to multiple bound kinds in "${src}"`);
    return { k: "union", members: node.members.map((member) => applyBound(member, op, value, src)) };
  }
  if (!(value instanceof Date) && acceptsDate(node)) {
    return applyBound(node, op, new Date(value), src);
  }
  if (value instanceof Date) {
    if (!acceptsDate(node)) throw new OmpTypeError(`date bound requires Date in "${src}"`);
    const limit = value.valueOf();
    const relation = op === ">=" ? "on or after" : op === ">" ? "later than" : op === "<=" ? "on or before" : "earlier than";
    return {
      k: "refine",
      base: node,
      pred: (input) => {
        if (!(input instanceof Date)) return false;
        const time = input.valueOf();
        return op === ">=" ? time >= limit : op === ">" ? time > limit : op === "<=" ? time <= limit : time < limit;
      },
      expected: `a Date ${relation} ${value.toISOString()}`
    };
  }
  if (node.k === "number") {
    const bounded = { ...node };
    switch (op) {
      case ">=":
        bounded.min = value;
        bounded.xmin = false;
        break;
      case ">":
        bounded.min = value;
        bounded.xmin = true;
        break;
      case "<=":
        bounded.max = value;
        bounded.xmax = false;
        break;
      case "<":
        bounded.max = value;
        bounded.xmax = true;
        break;
    }
    if (bounded.min !== void 0 && bounded.max !== void 0 && (bounded.min > bounded.max || bounded.min === bounded.max && (bounded.xmin || bounded.xmax))) {
      throw new OmpTypeError(`numeric range is unsatisfiable in "${src}"`);
    }
    return bounded;
  }
  if (node.k === "string" || node.k === "array") {
    if (!Number.isInteger(value) || value < 0) {
      throw new OmpTypeError(`length bound must be a non-negative integer in "${src}"`);
    }
    const bounded = { ...node };
    switch (op) {
      case ">=":
        bounded.min = value;
        break;
      case ">":
        bounded.min = value + 1;
        break;
      case "<=":
        bounded.max = value;
        break;
      case "<":
        bounded.max = value - 1;
        break;
    }
    if (bounded.min !== void 0 && bounded.max !== void 0 && bounded.min > bounded.max || (bounded.max ?? 0) < 0) {
      throw new OmpTypeError(`length range is unsatisfiable in "${src}"`);
    }
    return bounded;
  }
  throw new OmpTypeError(`cannot bound ${node.k} in "${src}"`);
}
function acceptsDate(node) {
  return node.k === "instance" && node.ctor === Date || node.k === "refine" && acceptsDate(node.base);
}
function isEmbedded(def) {
  return (typeof def === "function" || typeof def === "object" && def !== null) && IR_BRAND in def;
}
function embed(schema) {
  if (schema.hasSteps) return { k: "sub", schema, desc: schema.description, descAuto: schema.ir.desc === void 0 };
  if (schema.description !== void 0 && schema.ir.desc === void 0) {
    return { ...schema.ir, desc: schema.description, descAuto: true };
  }
  return schema.ir;
}
function boundKind(node) {
  if (node.k === "number") return "number";
  if (node.k === "string" || node.k === "array") return "length";
  if (acceptsDate(node)) return "date";
  return void 0;
}
function isCallback(value) {
  return typeof value === "function";
}
function isConstructor(value) {
  return typeof value === "function" && value.prototype !== void 0;
}
function parseTupleItem(def, resolve2) {
  if (Array.isArray(def) && def.length === 2 && def[1] === "?") {
    return { val: parseDef(def[0], resolve2), opt: true };
  }
  if (Array.isArray(def) && def.length === 3 && def[1] === "=") {
    return {
      val: parseDef(def[0], resolve2),
      opt: true,
      def: def[2],
      defFactory: typeof def[2] === "function",
      hasDefault: true
    };
  }
  if (typeof def === "string") {
    const parsed = parseStringDef(def, resolve2);
    return {
      val: parsed.ir,
      opt: parsed.optional || parsed.hasDefault,
      def: parsed.def,
      hasDefault: parsed.hasDefault
    };
  }
  return { val: parseDef(def, resolve2), opt: false };
}
function cloneTuple(tuple) {
  return {
    ...tuple,
    prefix: tuple.prefix.map((item) => ({ ...item })),
    postfix: [...tuple.postfix]
  };
}
function hasOptionalPrefix(tuple) {
  return tuple.prefix.some((item) => item.opt || item.hasDefault === true);
}
function appendTupleItem(tuple, item) {
  if (tuple.variadic !== void 0) {
    if (item.opt || item.hasDefault) {
      throw new OmpTypeError("An optional element may not follow a variadic element");
    }
    if (hasOptionalPrefix(tuple)) {
      throw new OmpTypeError("A postfix required element cannot follow an optional or defaultable element");
    }
    tuple.postfix.push(item.val);
    return;
  }
  if (item.hasDefault && tuple.prefix.some((prefixItem) => prefixItem.opt && !prefixItem.hasDefault)) {
    throw new OmpTypeError("A defaultable element may not follow an optional element without a default");
  }
  if (hasOptionalPrefix(tuple) && !item.opt) {
    throw new OmpTypeError("required tuple elements cannot follow optional elements");
  }
  tuple.prefix.push(item);
}
function appendTuple(target, spread) {
  if (target.variadic !== void 0 && spread.variadic !== void 0) {
    throw new OmpTypeError("a tuple may have one spread followed by an array definition");
  }
  for (const item of spread.prefix) appendTupleItem(target, { ...item });
  if (spread.variadic !== void 0) {
    target.variadic = spread.variadic;
  }
  for (const item of spread.postfix) appendTupleItem(target, { val: item, opt: false });
}
function spreadAlternatives(spread) {
  if (spread.k === "alias") return spreadAlternatives(spread.resolve());
  if (spread.k === "sub") return spreadAlternatives(spread.schema.ir);
  if (spread.k === "union") return spread.members.flatMap(spreadAlternatives);
  if (spread.k === "array") return [{ k: "tuple", prefix: [], variadic: spread.el, postfix: [] }];
  if (spread.k === "tuple") return [spread];
  throw new OmpTypeError("tuple spread element must be an array");
}
function parseTuple(def, resolve2) {
  let branches = [{ k: "tuple", prefix: [], postfix: [] }];
  for (let index = 0; index < def.length; index++) {
    if (def[index] === "...") {
      if (index + 1 >= def.length) {
        throw new OmpTypeError("a tuple may have one spread followed by an array definition");
      }
      const alternatives = spreadAlternatives(parseDef(def[++index], resolve2));
      const distributed = [];
      for (const branch of branches) {
        for (const alternative of alternatives) {
          const next = cloneTuple(branch);
          appendTuple(next, alternative);
          distributed.push(next);
        }
      }
      branches = distributed;
      continue;
    }
    const item = parseTupleItem(def[index], resolve2);
    for (const branch of branches) appendTupleItem(branch, { ...item });
  }
  return branches.length === 1 ? branches[0] : { k: "union", members: branches };
}
function keyOf(node) {
  if (node.k === "alias") return keyOf(node.resolve());
  if (node.k === "sub") return keyOf(node.schema.ir);
  if (node.k === "refine") return keyOf(node.base);
  if (node.k === "intersection") {
    const members = node.members.flatMap((member) => {
      const keys = keyOf(member);
      return keys.k === "union" ? keys.members : [keys];
    });
    return members.length === 1 ? members[0] : { k: "union", members };
  }
  if (node.k === "object") {
    const members = node.props.map((prop) => ({ k: "lit", v: prop.key }));
    if (node.index !== void 0 || (node.patternIndexes?.length ?? 0) > 0) members.push({ k: "string" });
    if (node.symbolIndex !== void 0) members.push({ k: "symbol" });
    if (members.length === 0) return { k: "never" };
    return members.length === 1 ? members[0] : { k: "union", members };
  }
  if (node.k === "tuple") return { k: "number", int: true, min: 0 };
  if (node.k === "union") {
    if (node.members.length === 0) return { k: "never" };
    const literalSets = node.members.map((member) => {
      const keyed = keyOf(member);
      const literals = keyed.k === "union" ? keyed.members : [keyed];
      const keys = /* @__PURE__ */ new Set();
      for (const literal of literals) {
        if (literal.k === "lit" && (typeof literal.v === "string" || typeof literal.v === "number" || typeof literal.v === "symbol")) {
          keys.add(literal.v);
        }
      }
      return keys;
    });
    const common = [...literalSets[0]].filter((key) => literalSets.slice(1).every((keys) => keys.has(key)));
    if (common.length === 0) throw new OmpTypeError("keyof operand must be an object");
    const members = common.map((value) => ({ k: "lit", v: value }));
    return members.length === 1 ? members[0] : { k: "union", members };
  }
  throw new OmpTypeError("keyof operand must be an object");
}
function parseArrayExpression(def, resolve2) {
  if (def.length === 2 && def[1] === "[]") return { k: "array", el: parseDef(def[0], resolve2) };
  if (def.length === 2 && def[0] === "keyof") return keyOf(parseDef(def[1], resolve2));
  if (def[0] === "instanceof") {
    const members = [];
    for (let index = 1; index < def.length; index++) {
      const ctor = def[index];
      if (!isConstructor(ctor)) throw new OmpTypeError("instanceof operands must be constructors");
      members.push({
        k: "instance",
        ctor,
        expected: ctor === Error ? "an Error" : `an instance of ${ctor.name || "the constructor"}`
      });
    }
    return members.length === 1 ? members[0] : { k: "union", members };
  }
  if (def[0] === "===") {
    const members = def.slice(1).map((value) => ({ k: "lit", v: value }));
    if (members.length === 0) return { k: "never" };
    return members.length === 1 ? members[0] : { k: "union", members };
  }
  if (def.length >= 3 && def[1] === "|") {
    return { k: "union", members: [parseDef(def[0], resolve2), parseDef(def[2], resolve2)] };
  }
  if (def.length >= 3 && def[1] === "&") {
    return { k: "intersection", members: [parseDef(def[0], resolve2), parseDef(def[2], resolve2)] };
  }
  if (def.length === 3 && def[1] === "=>") {
    if (!isCallback(def[2])) throw new OmpTypeError("morph operator requires a function");
    return { k: "morph", input: parseDef(def[0], resolve2), fn: def[2] };
  }
  if (def.length === 3 && def[1] === "|>") {
    return { k: "morph", input: parseDef(def[0], resolve2), fn: (value) => value, out: parseDef(def[2], resolve2) };
  }
  if (def.length === 3 && def[1] === ":") {
    if (!isCallback(def[2])) throw new OmpTypeError("narrow operator requires a predicate");
    const predicate = def[2];
    const name = predicate.name;
    const expected = name.length === 0 ? "valid according to an anonymous predicate" : `valid according to ${name}`;
    return {
      k: "refine",
      base: parseDef(def[0], resolve2),
      pred: (value) => {
        let errors;
        const error = (input) => {
          const detail = typeof input === "string" ? { expected: input } : input;
          const next = OmpErrors.single([...detail.path ?? detail.relativePath ?? []], detail.expected, value, {
            preserveActual: true,
            ...Object.hasOwn(detail, "actual") ? { actual: String(detail.actual) } : {}
          });
          if (errors) errors.append(next);
          else errors = next;
          return next;
        };
        const result = predicate(value, { error, reject: error });
        return errors ?? (result instanceof OmpErrors ? result : result === true);
      },
      expected
    };
  }
  if (def.length >= 3 && def[1] === "@") {
    const base = parseDef(def[0], resolve2);
    const meta = def[2];
    if (typeof meta === "string") return { ...base, desc: meta, cfg: { ...base.cfg, expected: meta } };
    if (typeof meta === "object" && meta !== null) {
      const config = meta;
      return {
        ...base,
        cfg: {
          ...typeof config.description === "string" ? { expected: config.description } : {},
          ...config
        },
        ...typeof config.description === "string" ? { desc: config.description } : {}
      };
    }
    return base;
  }
  return parseTuple(def, resolve2);
}
function isObjectDefinition(def) {
  return typeof def === "object" && def !== null && !Array.isArray(def) && !(def instanceof RegExp) && !(def instanceof Date);
}
function spreadObjectOf(ir) {
  if (ir.k === "alias") return spreadObjectOf(ir.resolve());
  if (ir.k === "sub") return spreadObjectOf(ir.schema.ir);
  if (ir.k === "refine") return spreadObjectOf(ir.base);
  if (ir.k === "anyobject") return { k: "object", props: [], extras: "keep" };
  if (ir.k === "object") return ir;
  if (ir.k !== "intersection") return void 0;
  let result = { k: "object", props: [], extras: "keep" };
  for (const member of ir.members) {
    const object = spreadObjectOf(member);
    if (object === void 0) return void 0;
    result = mergeObjectIR(result, object);
  }
  return result;
}
function indexKeyKind(key, value, props, indexes) {
  if (key.k === "alias") return indexKeyKind(key.resolve(), value, props, indexes);
  if (key.k === "union") {
    for (const member of key.members) indexKeyKind(member, value, props, indexes);
    return;
  }
  if (key.k === "lit" && (typeof key.v === "string" || typeof key.v === "symbol")) {
    props.push({ key: key.v, opt: false, val: value });
    return;
  }
  if (key.k === "string") {
    indexes.string = value;
    return;
  }
  if (key.k === "symbol") {
    indexes.symbol = value;
    return;
  }
  if (key.k === "refine" && key.base.k === "string") {
    indexes.patterns.push({ key, val: value });
    return;
  }
  throw new OmpTypeError(`indexed key definition must resolve to a string or symbol (was ${expectedOf(key)})`);
}
function addObjectProp(props, spreadKeys, prop) {
  if (spreadKeys === void 0) {
    props.push(prop);
    return;
  }
  const previous = props.findIndex((candidate) => candidate.key === prop.key);
  if (previous < 0) {
    props.push(prop);
    return;
  }
  if (!spreadKeys.delete(prop.key)) throw new OmpTypeError(`duplicate object key ${String(prop.key)}`);
  props[previous] = prop;
}
function parseObjectDefinition(def, resolve2) {
  const props = [];
  let spreadKeys;
  let normalizedKey;
  let normalizedKeys;
  let indexes;
  let extras = "keep";
  let simple = true;
  for (const originalKey in def) {
    if (!Object.hasOwn(def, originalKey)) continue;
    const val = def[originalKey];
    if (originalKey === "+") {
      if (val === "reject" || val === "delete") {
        extras = val;
        if (val === "delete") simple = false;
      } else if (val === "ignore") extras = "keep";
      else throw new OmpTypeError(`bad "+" value ${String(val)}`);
      continue;
    }
    if (originalKey === "...") {
      const parsed = parseDef(val, resolve2);
      const spread = spreadObjectOf(parsed);
      if (spread === void 0) {
        throw new OmpTypeError(`object spread must resolve to an object literal (was ${expectedOf(parsed)})`);
      }
      if (simple && !isSimpleIR(spread)) simple = false;
      spreadKeys ??= /* @__PURE__ */ new Set();
      for (const prop2 of spread.props) {
        const previous = props.findIndex((candidate) => candidate.key === prop2.key);
        if (previous < 0) props.push(prop2);
        else props[previous] = prop2;
        spreadKeys.add(prop2.key);
      }
      if (spread.index !== void 0 || spread.symbolIndex !== void 0 || spread.patternIndexes !== void 0) {
        const objectIndexes = indexes ?? { patterns: [] };
        indexes = objectIndexes;
        objectIndexes.string ??= spread.index;
        objectIndexes.symbol ??= spread.symbolIndex;
        if (spread.patternIndexes !== void 0) objectIndexes.patterns.push(...spread.patternIndexes);
      }
      if (spread.extras !== "keep") extras = spread.extras;
      continue;
    }
    if (typeof originalKey === "string" && originalKey.startsWith("[") && originalKey.endsWith("]")) {
      let value;
      if (typeof val === "string") {
        const parsed = parseStringDef(val, resolve2);
        if (parsed.hasDefault) throw new OmpTypeError("index signatures cannot specify a default");
        value = parsed.ir;
      } else {
        if (Array.isArray(val) && val.length === 3 && val[1] === "=") {
          throw new OmpTypeError("index signatures cannot specify a default");
        }
        value = parseDef(val, resolve2);
        if (isEmbedded(val) && val.hasDefault) {
          throw new OmpTypeError("index signatures cannot specify a default");
        }
      }
      const keyDefinition = originalKey.slice(1, -1);
      const regex = /^\/((?:\\.|[^\\/])*)\/([dgimsuvy]*)$/.exec(keyDefinition);
      let key2;
      if (regex === null) {
        key2 = parseDef(keyDefinition, resolve2);
      } else {
        try {
          key2 = patternIR(new RegExp(regex[1], regex[2]));
        } catch {
          throw new OmpTypeError(`invalid index signature pattern ${keyDefinition}`);
        }
      }
      const objectIndexes = indexes ?? { patterns: [] };
      indexes = objectIndexes;
      indexKeyKind(key2, value, props, objectIndexes);
      if (simple && (!isSimpleIR(key2) || !isSimpleIR(value))) simple = false;
      continue;
    }
    const escapedOptional = typeof originalKey === "string" && originalKey.endsWith("\\?");
    const escapedMeta = typeof originalKey === "string" && (originalKey === "\\+" || originalKey === "\\..." || originalKey.startsWith("\\["));
    const rawKey = escapedOptional ? `${originalKey.slice(0, -2)}?` : escapedMeta ? originalKey.slice(1) : originalKey;
    const opt = typeof rawKey === "string" && !escapedOptional && !escapedMeta && rawKey.endsWith("?");
    const key = opt ? rawKey.slice(0, -1) : rawKey;
    let prop;
    if (typeof val === "string") {
      const parsed = parseStringDef(val, resolve2);
      prop = { key, opt: opt || parsed.optional, val: parsed.ir };
      if (parsed.hasDefault) {
        prop.def = parsed.def;
        prop.hasDefault = true;
      }
    } else if (Array.isArray(val) && val.length === 2 && val[1] === "?") {
      prop = { key, opt: true, val: parseDef(val[0], resolve2) };
    } else if (Array.isArray(val) && val.length === 3 && val[1] === "=") {
      prop = {
        key,
        opt,
        val: parseDef(val[0], resolve2),
        def: val[2],
        defFactory: typeof val[2] === "function",
        hasDefault: true
      };
    } else if (isEmbedded(val)) {
      prop = val.hasDefault ? {
        key,
        opt,
        val: embed(val),
        def: val.hasDefaultOutput ? val.defaultOutput : val.defaultValue,
        defFactory: typeof val.defaultValue === "function",
        hasDefault: true,
        defValidated: val.hasDefaultOutput
      } : { key, opt, val: embed(val) };
    } else {
      prop = {
        key,
        opt,
        val: isObjectDefinition(val) ? parseObjectDefinition(val, resolve2) : parseDef(val, resolve2)
      };
    }
    if (key !== originalKey) {
      if (!spreadKeys?.has(key) && props.some((candidate) => candidate.key === key)) {
        throw new OmpTypeError(`duplicate object key ${String(key)}`);
      }
      if (normalizedKey === void 0) normalizedKey = key;
      else {
        normalizedKeys ??= [normalizedKey];
        normalizedKeys.push(key);
      }
    } else if (!spreadKeys?.has(key) && (key === normalizedKey || normalizedKeys?.includes(key))) {
      throw new OmpTypeError(`duplicate object key ${String(key)}`);
    }
    if (opt && prop.hasDefault) throw new OmpTypeError(`optional key ${String(key)} cannot specify a default`);
    if (simple && (prop.hasDefault || !isSimpleIR(prop.val))) simple = false;
    addObjectProp(props, spreadKeys, prop);
  }
  for (const key of Object.getOwnPropertySymbols(def)) {
    if (!Object.prototype.propertyIsEnumerable.call(def, key)) continue;
    const val = def[key];
    let prop;
    if (typeof val === "string") {
      const parsed = parseStringDef(val, resolve2);
      prop = { key, opt: parsed.optional, val: parsed.ir };
      if (parsed.hasDefault) {
        prop.def = parsed.def;
        prop.hasDefault = true;
      }
    } else if (Array.isArray(val) && val.length === 2 && val[1] === "?") {
      prop = { key, opt: true, val: parseDef(val[0], resolve2) };
    } else if (Array.isArray(val) && val.length === 3 && val[1] === "=") {
      prop = {
        key,
        opt: false,
        val: parseDef(val[0], resolve2),
        def: val[2],
        defFactory: typeof val[2] === "function",
        hasDefault: true
      };
    } else if (isEmbedded(val)) {
      prop = val.hasDefault ? {
        key,
        opt: false,
        val: embed(val),
        def: val.hasDefaultOutput ? val.defaultOutput : val.defaultValue,
        defFactory: typeof val.defaultValue === "function",
        hasDefault: true,
        defValidated: val.hasDefaultOutput
      } : { key, opt: false, val: embed(val) };
    } else {
      prop = {
        key,
        opt: false,
        val: isObjectDefinition(val) ? parseObjectDefinition(val, resolve2) : parseDef(val, resolve2)
      };
    }
    if (simple && (prop.hasDefault || !isSimpleIR(prop.val))) simple = false;
    addObjectProp(props, spreadKeys, prop);
  }
  const object = {
    k: "object",
    props,
    index: indexes?.string,
    symbolIndex: indexes?.symbol,
    patternIndexes: indexes === void 0 || indexes.patterns.length === 0 ? void 0 : indexes.patterns,
    extras
  };
  object[kSimple] = simple;
  object[kSimpleOwner] = object;
  return object;
}
function parseDef(def, resolve2) {
  if (typeof def === "string") {
    const parsed = parseStringDef(def, resolve2);
    if (parsed.hasDefault) {
      throw new OmpTypeError("A default may only be specified for an object property or tuple element");
    }
    if (parsed.optional) {
      throw new OmpTypeError(`optional "?" marker is only valid on object property values`);
    }
    return parsed.ir;
  }
  if (Array.isArray(def)) {
    if (def.length === 3 && def[1] === "=") {
      throw new OmpTypeError("A default may only be specified for an object property or tuple element");
    }
    return parseArrayExpression(def, resolve2);
  }
  if (def instanceof RegExp) return patternIR(def);
  if (def instanceof Date) return { k: "lit", v: def };
  if (isEmbedded(def)) return embed(def);
  if (typeof def === "function") {
    const resolved = Reflect.apply(def, void 0, []);
    if (!isEmbedded(resolved)) {
      throw new OmpTypeError(`thunk must return a Type (was ${typeof resolved})`);
    }
    return embed(resolved);
  }
  if (isObjectDefinition(def)) return parseObjectDefinition(def, resolve2);
  throw new OmpTypeError(`unsupported definition ${String(def)} (was ${typeof def})`);
}
function isSimpleIR(ir) {
  const cached = ir[kSimpleOwner] === ir ? ir[kSimple] : void 0;
  if (cached !== void 0) return cached;
  const simple = scanSimpleIR(ir);
  ir[kSimple] = simple;
  ir[kSimpleOwner] = ir;
  return simple;
}
function scanSimpleIR(ir) {
  switch (ir.k) {
    case "intersection":
    case "morph":
    case "sub":
    case "alias":
      return false;
    case "refine":
      return scanSimpleIR(ir.base);
    case "union":
      if (ir.members.length < 2) return false;
      if (ir.members.length === 2 && ir.members.every((member) => member.k === "lit" && typeof member.v === "boolean")) {
        return false;
      }
      for (let index = 0; index < ir.members.length; index++) {
        const member = ir.members[index];
        if (member.k !== "lit" || member.v !== null && (typeof member.v === "object" || typeof member.v === "function")) {
          return false;
        }
        for (let previous = 0; previous < index; previous++) {
          const candidate = ir.members[previous];
          if (candidate.k === "lit" && candidate.v === member.v) return false;
        }
      }
      return true;
    case "array":
      return scanSimpleIR(ir.el);
    case "tuple":
      for (const item of ir.prefix) {
        if (item.hasDefault || !scanSimpleIR(item.val)) return false;
      }
      if (ir.variadic !== void 0 && !scanSimpleIR(ir.variadic)) return false;
      for (const item of ir.postfix) if (!scanSimpleIR(item)) return false;
      return true;
    case "object":
      if (ir.extras === "delete") return false;
      for (const prop of ir.props) {
        if (prop.hasDefault || !scanSimpleIR(prop.val)) return false;
      }
      if (ir.index !== void 0 && !scanSimpleIR(ir.index)) return false;
      if (ir.symbolIndex !== void 0 && !scanSimpleIR(ir.symbolIndex)) return false;
      if (ir.patternIndexes !== void 0) {
        for (const pattern2 of ir.patternIndexes) {
          if (!scanSimpleIR(pattern2.key) || !scanSimpleIR(pattern2.val)) return false;
        }
      }
      return true;
    default:
      return true;
  }
}
function hasMorph(ir) {
  const cached = ir[kMorphOwner] === ir ? ir[kMorph] : void 0;
  if (cached !== void 0) return cached;
  const result = scanMorph(ir);
  ir[kMorph] = result;
  ir[kMorphOwner] = ir;
  return result;
}
function scanMorph(ir, activeAliases) {
  const cached = ir[kMorphOwner] === ir ? ir[kMorph] : void 0;
  if (cached !== void 0) return cached;
  let result = false;
  switch (ir.k) {
    case "sub":
    case "morph":
      result = true;
      break;
    case "alias": {
      if (activeAliases?.has(ir)) return false;
      const aliases = activeAliases ?? /* @__PURE__ */ new Set();
      aliases.add(ir);
      result = scanMorph(ir.resolve(), aliases);
      aliases.delete(ir);
      return result;
    }
    case "object":
      result = ir.extras === "delete";
      for (let index = 0; !result && index < ir.props.length; index++) {
        const prop = ir.props[index];
        result = prop.hasDefault === true || scanMorph(prop.val, activeAliases);
      }
      if (!result && ir.index !== void 0) result = scanMorph(ir.index, activeAliases);
      if (!result && ir.symbolIndex !== void 0) result = scanMorph(ir.symbolIndex, activeAliases);
      if (!result && ir.patternIndexes !== void 0) {
        for (const pattern2 of ir.patternIndexes) {
          if (scanMorph(pattern2.val, activeAliases)) {
            result = true;
            break;
          }
        }
      }
      break;
    case "array":
      result = scanMorph(ir.el, activeAliases);
      break;
    case "union":
    case "intersection":
      for (const member of ir.members) {
        if (scanMorph(member, activeAliases)) {
          result = true;
          break;
        }
      }
      break;
    case "refine":
      result = scanMorph(ir.base, activeAliases);
      break;
    case "tuple":
      for (const item of ir.prefix) {
        if (item.hasDefault === true || scanMorph(item.val, activeAliases)) {
          result = true;
          break;
        }
      }
      if (!result && ir.variadic !== void 0) result = scanMorph(ir.variadic, activeAliases);
      if (!result) {
        for (const item of ir.postfix) {
          if (scanMorph(item, activeAliases)) {
            result = true;
            break;
          }
        }
      }
      break;
  }
  return result;
}
function hasAlias(ir) {
  const cached = ir[kAliasOwner] === ir ? ir[kAlias] : void 0;
  if (cached !== void 0) return cached;
  const result = scanAlias(ir);
  ir[kAlias] = result;
  ir[kAliasOwner] = ir;
  return result;
}
function scanAlias(ir) {
  const cached = ir[kAliasOwner] === ir ? ir[kAlias] : void 0;
  if (cached !== void 0) return cached;
  switch (ir.k) {
    case "alias":
      return true;
    case "object":
      for (const prop of ir.props) if (scanAlias(prop.val)) return true;
      if (ir.index !== void 0 && scanAlias(ir.index)) return true;
      if (ir.symbolIndex !== void 0 && scanAlias(ir.symbolIndex)) return true;
      if (ir.patternIndexes !== void 0) {
        for (const pattern2 of ir.patternIndexes) {
          if (scanAlias(pattern2.key) || scanAlias(pattern2.val)) return true;
        }
      }
      return false;
    case "array":
      return scanAlias(ir.el);
    case "tuple":
      for (const item of ir.prefix) if (scanAlias(item.val)) return true;
      if (ir.variadic !== void 0 && scanAlias(ir.variadic)) return true;
      for (const item of ir.postfix) if (scanAlias(item)) return true;
      return false;
    case "union":
    case "intersection":
      for (const member of ir.members) if (scanAlias(member)) return true;
      return false;
    case "refine":
      return scanAlias(ir.base);
    case "morph":
      return scanAlias(ir.input) || ir.out !== void 0 && scanAlias(ir.out);
    default:
      return false;
  }
}
function expectedOf(ir) {
  if (ir.desc !== void 0) return ir.desc;
  switch (ir.k) {
    case "unknown":
      return "unknown";
    case "null":
      return "null";
    case "undefined":
      return "undefined";
    case "boolean":
      return "boolean";
    case "bigint":
      return "a bigint";
    case "symbol":
      return "a symbol";
    case "never":
      return "never";
    case "anyobject":
      return "an object";
    case "string": {
      let out = ir.url ? "a URL string" : "a string";
      if (ir.min !== void 0 && ir.max !== void 0) out += ` (length ${ir.min} to ${ir.max})`;
      else if (ir.min !== void 0) out += ` (length at least ${ir.min})`;
      else if (ir.max !== void 0) out += ` (length at most ${ir.max})`;
      return out;
    }
    case "number": {
      let out = ir.int ? "an integer" : "a number";
      if (ir.min !== void 0) out += ` ${ir.xmin ? "more than" : "at least"} ${ir.min}`;
      if (ir.max !== void 0)
        out += `${ir.min !== void 0 ? " and" : ""} ${ir.xmax ? "less than" : "at most"} ${ir.max}`;
      if (ir.divisor !== void 0) out += ` divisible by ${ir.divisor}`;
      return out;
    }
    case "lit":
      return ir.v instanceof Date ? `the date ${ir.v.toISOString()}` : typeof ir.v === "string" ? JSON.stringify(ir.v) : String(ir.v);
    case "union": {
      if (ir.members.length === 0) return "";
      const first = expectedOf(ir.members[0]);
      if (ir.members.length === 1) return first;
      const second = expectedOf(ir.members[1]);
      if (ir.members.length === 2) return first === second ? first : `${first} or ${second}`;
      const expectations = first === second ? [first] : [first, second];
      for (let i = 2; i < ir.members.length; i++) {
        const expected = expectedOf(ir.members[i]);
        if (!expectations.includes(expected)) expectations.push(expected);
      }
      return expectations.join(" or ");
    }
    case "intersection":
      return ir.members.map(expectedOf).join(" and ");
    case "array":
      return "an array";
    case "tuple":
      return "a tuple";
    case "object":
      return "an object";
    case "instance":
      return ir.expected;
    case "refine":
      return ir.expected;
    case "morph":
      return expectedOf(ir.input);
    case "alias":
      return ir.name === "this" ? expectedOf(ir.resolve()) : ir.name;
    case "sub":
      return ir.desc ?? ir.schema.description ?? expectedOf(ir.schema.ir);
  }
}

// ../../../omp/packages/omptype/src/interp.ts
var own = Object.prototype.hasOwnProperty;
function materializeDefault(payload) {
  if (payload === null || typeof payload !== "object") return payload;
  if (payload instanceof Date) return new Date(payload);
  return structuredClone(payload);
}
var activeVisits;
var activeChecks;
function walk(ir, value, path = []) {
  const previousVisits = activeVisits;
  const previousChecks = activeChecks;
  activeVisits = void 0;
  activeChecks = void 0;
  try {
    return visit(ir, value, path);
  } finally {
    activeVisits = previousVisits;
    activeChecks = previousChecks;
  }
}
function fail(path, expected, data) {
  const storedPath = path.length === 0 ? void 0 : path.length === 1 ? path[0] : [...path];
  return new OmpErrors(storedPath, expected, data);
}
function checks(ir, v) {
  if (typeof v !== "object" || v === null || !hasAlias(ir)) return checkNode(ir, v);
  activeChecks ??= /* @__PURE__ */ new WeakMap();
  const visits = activeChecks;
  let visited = visits.get(v);
  if (visited?.has(ir)) return true;
  if (visited === void 0) {
    visited = /* @__PURE__ */ new Set();
    visits.set(v, visited);
  }
  visited.add(ir);
  try {
    return checkNode(ir, v);
  } finally {
    visited.delete(ir);
  }
}
function checkNode(ir, v) {
  switch (ir.k) {
    case "unknown":
      return true;
    case "null":
      return v === null;
    case "undefined":
      return v === void 0;
    case "boolean":
      return typeof v === "boolean";
    case "bigint":
      return typeof v === "bigint";
    case "symbol":
      return typeof v === "symbol";
    case "never":
      return false;
    case "anyobject":
      return typeof v === "object" && v !== null;
    case "string":
      return typeof v === "string" && (ir.min === void 0 || v.length >= ir.min) && (ir.max === void 0 || v.length <= ir.max) && (!ir.url || URL.canParse(v));
    case "number":
      if (typeof v !== "number") return false;
      return (ir.int ? Number.isInteger(v) : Number.isFinite(v)) && (ir.divisor === void 0 || v % ir.divisor === 0) && (ir.min === void 0 || (ir.xmin ? v > ir.min : v >= ir.min)) && (ir.max === void 0 || (ir.xmax ? v < ir.max : v <= ir.max));
    case "lit":
      return ir.v instanceof Date ? v instanceof Date && v.valueOf() === ir.v.valueOf() : v === ir.v;
    case "union":
      return ir.members.some((m) => checks(m, v));
    case "intersection":
      return ir.members.every((member) => checks(member, v));
    case "array": {
      if (!Array.isArray(v)) return false;
      if (ir.min !== void 0 && v.length < ir.min) return false;
      if (ir.max !== void 0 && v.length > ir.max) return false;
      for (const element of v) if (!checks(ir.el, element)) return false;
      return true;
    }
    case "tuple": {
      if (!Array.isArray(v)) return false;
      let required = ir.postfix.length;
      for (const item of ir.prefix) if (!item.opt && !item.hasDefault) required++;
      if (v.length < required) return false;
      if (ir.variadic === void 0 && v.length > ir.prefix.length + ir.postfix.length) return false;
      const postfixStart = v.length - ir.postfix.length;
      const prefixCount = Math.min(ir.prefix.length, postfixStart);
      for (let index = 0; index < prefixCount; index++) {
        if (!checks(ir.prefix[index].val, v[index])) return false;
      }
      for (let index = prefixCount; index < ir.prefix.length; index++) {
        const item = ir.prefix[index];
        if (!item.opt && !item.hasDefault) return false;
      }
      if (ir.variadic !== void 0) {
        for (let index = prefixCount; index < postfixStart; index++) {
          if (!checks(ir.variadic, v[index])) return false;
        }
      }
      for (let index = 0; index < ir.postfix.length; index++) {
        if (!checks(ir.postfix[index], v[postfixStart + index])) return false;
      }
      return true;
    }
    case "object": {
      if (typeof v !== "object" || v === null) return false;
      const rec = v;
      for (const p of ir.props) {
        const present = p.key in rec;
        if (!present) {
          if (!p.opt && !p.hasDefault) return false;
          continue;
        }
        if (!checks(p.val, rec[p.key])) return false;
      }
      for (const key in rec) {
        if (!own.call(rec, key)) continue;
        if (ir.index !== void 0 && !checks(ir.index, rec[key])) return false;
        let patternMatched = false;
        if (ir.patternIndexes !== void 0) {
          for (const pattern2 of ir.patternIndexes) {
            if (!checks(pattern2.key, key)) continue;
            patternMatched = true;
            if (!checks(pattern2.val, rec[key])) return false;
          }
        }
        if (ir.extras === "reject" && ir.index === void 0 && !patternMatched && !ir.props.some((prop) => prop.key === key)) {
          return false;
        }
      }
      for (const key of Object.getOwnPropertySymbols(rec)) {
        if (!Object.prototype.propertyIsEnumerable.call(rec, key)) continue;
        if (ir.symbolIndex !== void 0 && !checks(ir.symbolIndex, rec[key])) return false;
        if (ir.extras === "reject" && ir.symbolIndex === void 0 && !ir.props.some((prop) => prop.key === key)) {
          return false;
        }
      }
      return true;
    }
    case "instance":
      return v instanceof ir.ctor;
    case "refine":
      if (!checks(ir.base, v)) return false;
      try {
        return ir.pred(v) === true;
      } catch {
        return false;
      }
    case "alias":
      return checks(ir.resolve(), v);
    case "morph":
      return checks(ir.input, v);
    case "sub":
      return !(ir.schema.run(v) instanceof OmpErrors);
  }
}
function visit(ir, v, path) {
  if (typeof v !== "object" || v === null || !hasAlias(ir)) return visitFinish(ir, v, path);
  activeVisits ??= /* @__PURE__ */ new WeakMap();
  const visits = activeVisits;
  let visited = visits.get(v);
  if (visited?.has(ir)) return v;
  if (visited === void 0) {
    visited = /* @__PURE__ */ new Set();
    visits.set(v, visited);
  }
  visited.add(ir);
  try {
    return visitFinish(ir, v, path);
  } finally {
    visited.delete(ir);
  }
}
function visitFinish(ir, v, path) {
  const out = visitNode(ir, v, path);
  if (!(out instanceof OmpErrors) || ir.cfg === void 0) return out;
  for (const error of out) {
    if (error.path.length !== path.length) return out;
  }
  return out.configure(ir.cfg);
}
function visitNode(ir, v, path) {
  switch (ir.k) {
    case "alias":
      return visit(ir.resolve(), v, path);
    case "refine": {
      const base = visit(ir.base, v, path);
      if (base instanceof OmpErrors) return base;
      try {
        const result = ir.pred(base);
        if (result instanceof OmpErrors) return path.length === 0 ? result : prefixAll(result, path);
        return result ? base : fail(path, ir.expected, base);
      } catch {
        return fail(path, ir.expected, base);
      }
    }
    case "morph": {
      const input = visit(ir.input, v, path);
      if (input instanceof OmpErrors) return input;
      const context = {
        error: (expected, data = input) => fail(path, expected, data),
        reject: (problem, data = input) => fail(path, problem, data)
      };
      const output = ir.fn(input, context);
      if (output instanceof OmpErrors) return output;
      return ir.out === void 0 ? output : visit(ir.out, output, path);
    }
    case "intersection": {
      let output = v;
      for (const member of ir.members) {
        output = visit(member, output, path);
        if (output instanceof OmpErrors) return output;
      }
      return output;
    }
    case "sub": {
      const out = ir.schema.run(v, path);
      if (out instanceof OmpErrors) {
        return path.length === 0 ? out : prefixAll(out, path);
      }
      return out;
    }
    case "union": {
      for (const m of ir.members) {
        if (m.k !== "sub" && checks(m, v)) {
          if (hasMorph(m)) break;
          return v;
        }
      }
      let targeted;
      let targetCount = 0;
      for (const member of ir.members) {
        if (member.k === "sub" || hasMorph(member)) {
          const out = visit(member, v, path);
          if (!(out instanceof OmpErrors)) return out;
          if (kindMatches(unwrapBase(member), v)) {
            targetCount++;
            targeted ??= out;
          }
        }
      }
      if (targetCount === 1 && targeted !== void 0) return targeted;
      return ir.members.some(canRefineUnionFailure) ? unionFail(ir, v, path) : fail(path, expectedOf(ir), v);
    }
    case "array": {
      if (!Array.isArray(v)) return fail(path, "an array", v);
      if (ir.min !== void 0 && v.length < ir.min) return fail(path, `at least length ${ir.min}`, v.length);
      if (ir.max !== void 0 && v.length > ir.max) return fail(path, `at most length ${ir.max}`, v.length);
      const morph2 = hasMorph(ir.el);
      const out = morph2 ? new Array(v.length) : v;
      let errors;
      for (let index = 0; index < v.length; index++) {
        path.push(index);
        const element = visit(ir.el, v[index], path);
        path.pop();
        if (element instanceof OmpErrors) {
          if (errors) errors.append(element);
          else errors = element;
        } else if (morph2) {
          out[index] = element;
        }
      }
      return errors ?? out;
    }
    case "tuple": {
      if (!Array.isArray(v)) return fail(path, "an array", v);
      let required = ir.postfix.length;
      for (const item of ir.prefix) if (!item.opt && !item.hasDefault) required++;
      if (v.length < required) return fail(path, `an array of at least length ${required}`, v);
      const maximum = ir.prefix.length + ir.postfix.length;
      if (ir.variadic === void 0 && v.length > maximum) {
        return fail(path, `an array of at most length ${maximum}`, v);
      }
      const postfixStart = v.length - ir.postfix.length;
      const prefixCount = Math.min(ir.prefix.length, postfixStart);
      const morph2 = hasMorph(ir);
      const output = morph2 ? [...v] : v;
      let errors;
      for (let index = 0; index < prefixCount; index++) {
        path.push(index);
        const item = visit(ir.prefix[index].val, v[index], path);
        path.pop();
        if (item instanceof OmpErrors) {
          if (errors) errors.append(item);
          else errors = item;
        } else if (morph2) {
          output[index] = item;
        }
      }
      for (let index = prefixCount; index < ir.prefix.length; index++) {
        const item = ir.prefix[index];
        if (item.hasDefault && morph2) {
          const payload = item.def;
          if (item.defFactory && typeof payload === "function") {
            path.push(index);
            const resolved = visit(item.val, payload(), path);
            path.pop();
            if (resolved instanceof OmpErrors) {
              if (errors) errors.append(resolved);
              else errors = resolved;
            } else {
              output[index] = resolved;
            }
          } else {
            output[index] = materializeDefault(payload);
          }
        } else if (!item.opt) {
          path.push(index);
          const error = fail(path, expectedOf(item.val), MISSING);
          path.pop();
          if (errors) errors.append(error);
          else errors = error;
        }
      }
      if (ir.variadic !== void 0) {
        for (let index = prefixCount; index < postfixStart; index++) {
          path.push(index);
          const item = visit(ir.variadic, v[index], path);
          path.pop();
          if (item instanceof OmpErrors) {
            if (errors) errors.append(item);
            else errors = item;
          } else if (morph2) {
            output[index] = item;
          }
        }
      }
      for (let index = 0; index < ir.postfix.length; index++) {
        const inputIndex = postfixStart + index;
        path.push(inputIndex);
        const item = visit(ir.postfix[index], v[inputIndex], path);
        path.pop();
        if (item instanceof OmpErrors) {
          if (errors) errors.append(item);
          else errors = item;
        } else if (morph2) {
          output[inputIndex] = item;
        }
      }
      return errors ?? output;
    }
    case "object": {
      if (typeof v !== "object" || v === null) return fail(path, "an object", v);
      const rec = v;
      const morph2 = hasMorph(ir);
      let out;
      let errors;
      if (morph2) {
        if (ir.extras === "delete" && ir.index === void 0 && ir.symbolIndex === void 0 && ir.patternIndexes === void 0) {
          out = {};
        } else {
          out = { ...rec };
        }
      }
      for (const p of ir.props) {
        if (!(p.key in rec)) {
          if (p.hasDefault && out) {
            const payload = p.def;
            if (p.defFactory && typeof payload === "function") {
              path.push(p.key);
              const resolved = visit(p.val, payload(), path);
              path.pop();
              if (resolved instanceof OmpErrors) {
                if (errors) errors.append(resolved);
                else errors = resolved;
              } else {
                out[p.key] = resolved;
              }
            } else {
              out[p.key] = materializeDefault(payload);
            }
            continue;
          }
          if (p.opt || p.hasDefault) continue;
          path.push(p.key);
          const error = fail(path, expectedOf(p.val), MISSING);
          path.pop();
          if (errors) errors.append(error);
          else errors = error;
          continue;
        }
        path.push(p.key);
        const result = visit(p.val, rec[p.key], path);
        path.pop();
        if (result instanceof OmpErrors) {
          if (errors) errors.append(result);
          else errors = result;
        } else if (out) {
          out[p.key] = result;
        }
      }
      for (const key in rec) {
        if (!own.call(rec, key)) continue;
        let indexed = false;
        if (ir.index !== void 0) {
          indexed = true;
          path.push(key);
          const result = visit(ir.index, rec[key], path);
          path.pop();
          if (result instanceof OmpErrors) {
            if (errors) errors.append(result);
            else errors = result;
          } else if (out) {
            out[key] = result;
          }
        }
        if (ir.patternIndexes !== void 0) {
          for (const pattern2 of ir.patternIndexes) {
            if (!checks(pattern2.key, key)) continue;
            indexed = true;
            path.push(key);
            const result = visit(pattern2.val, rec[key], path);
            path.pop();
            if (result instanceof OmpErrors) {
              if (errors) errors.append(result);
              else errors = result;
            } else if (out) {
              out[key] = result;
            }
          }
        }
        if (ir.extras === "reject" && !indexed && !ir.props.some((prop) => prop.key === key)) {
          path.push(key);
          const error = fail(path, "removed", rec[key]);
          path.pop();
          if (errors) errors.append(error);
          else errors = error;
        }
      }
      for (const key of Object.getOwnPropertySymbols(rec)) {
        if (!Object.prototype.propertyIsEnumerable.call(rec, key)) continue;
        if (ir.symbolIndex !== void 0) {
          path.push(key);
          const result = visit(ir.symbolIndex, rec[key], path);
          path.pop();
          if (result instanceof OmpErrors) {
            if (errors) errors.append(result);
            else errors = result;
          } else if (out) {
            out[key] = result;
          }
        } else if (ir.extras === "reject" && !ir.props.some((prop) => prop.key === key)) {
          path.push(key);
          const error = fail(path, "removed", rec[key]);
          path.pop();
          if (errors) errors.append(error);
          else errors = error;
        }
      }
      return errors ?? out ?? v;
    }
    case "string": {
      if (typeof v !== "string") return fail(path, "a string", v);
      if (ir.min !== void 0 && v.length < ir.min) return fail(path, `at least length ${ir.min}`, v.length);
      if (ir.max !== void 0 && v.length > ir.max) return fail(path, `at most length ${ir.max}`, v.length);
      if (ir.url && !URL.canParse(v)) return fail(path, "a URL string", v);
      return v;
    }
    case "number": {
      if (typeof v !== "number" || !Number.isFinite(v)) return fail(path, ir.int ? "an integer" : "a number", v);
      let errors;
      const add = (expected) => {
        const error = fail(path, expected, v);
        if (errors) errors.append(error);
        else errors = error;
      };
      if (ir.int && !Number.isInteger(v)) add("an integer");
      if (ir.divisor !== void 0 && v % ir.divisor !== 0) add(`a number divisible by ${ir.divisor}`);
      if (ir.min !== void 0 && (ir.xmin ? v <= ir.min : v < ir.min)) {
        add(
          ir.min === 0 ? ir.xmin ? "positive" : "non-negative" : `a number ${ir.xmin ? "more than" : "at least"} ${ir.min}`
        );
      }
      if (ir.max !== void 0 && (ir.xmax ? v >= ir.max : v > ir.max)) {
        add(
          ir.max === 0 ? ir.xmax ? "negative" : "non-positive" : `a number ${ir.xmax ? "less than" : "at most"} ${ir.max}`
        );
      }
      return errors ?? v;
    }
    case "lit": {
      if (checks(ir, v)) return v;
      if (typeof ir.v === "object" && ir.v !== null || typeof ir.v === "function") {
        let expected = "the specified reference";
        try {
          const serialized = JSON.stringify(ir.v);
          if (serialized !== void 0) {
            expected = `reference equal to ${serialized}`;
            if (typeof v === "object" && v !== null && JSON.stringify(v) === serialized) {
              expected += " (serialized to the same value)";
            }
          }
        } catch {
        }
        return fail(path, expected, v);
      }
      return fail(path, expectedOf(ir), v);
    }
    default:
      return checks(ir, v) ? v : fail(path, expectedOf(ir), v);
  }
}
function prefixAll(errs, path) {
  for (let i = path.length - 1; i >= 0; i--) errs.prefix(path[i]);
  return errs;
}
function canRefineUnionFailure(member) {
  const base = unwrapBase(member);
  if (base.k === "array" || base.k === "object") return true;
  if (base.k === "string") return base.min !== void 0 || base.max !== void 0 || base.url === true;
  return base.k === "number" && (base.int === true || base.min !== void 0 || base.max !== void 0);
}
function unionFail(ir, v, path, expected) {
  let best;
  for (const member of ir.members) {
    const base = unwrapBase(member);
    if (!kindMatches(base, v)) continue;
    if (best !== void 0) {
      best = void 0;
      break;
    }
    best = member;
  }
  if (best === void 0) {
    const discriminated = discriminateFailure(ir.members, v, path);
    if (discriminated !== void 0) return discriminated;
  }
  if (best !== void 0) {
    const out = visit(best, v, path);
    if (out instanceof OmpErrors) return out;
  }
  if (ir.members.every((member) => unwrapBase(member).k === "object")) {
    const branches = ir.members.flatMap((member) => {
      const result = visit(member, v, path);
      return result instanceof OmpErrors ? [[...result]] : [];
    });
    if (branches.length !== 0) {
      const common = branches[0].filter(
        (entry2, index, first) => first.findIndex((candidate) => pathsEqual(candidate.path, entry2.path)) === index && branches.every((branch) => branch.some((candidate) => pathsEqual(candidate.path, entry2.path)))
      );
      const alternatives = [];
      if (common.length !== 0) {
        for (const entry2 of common) {
          const expectations = /* @__PURE__ */ new Set();
          for (const branch of branches) {
            for (const candidate of branch) {
              if (pathsEqual(candidate.path, entry2.path)) {
                expectations.add(candidate.expected.endsWith(" instance") ? "an object" : candidate.expected);
              }
            }
          }
          alternatives.push(
            new OmpErrors(entry2.path, [...expectations].join(" or "), entry2.data, { preserveActual: true })
          );
        }
      } else {
        for (const branch of branches) {
          for (const entry2 of branch) {
            alternatives.push(
              new OmpErrors(
                entry2.path,
                entry2.expected.endsWith(" instance") ? "an object" : entry2.expected,
                entry2.data,
                { preserveActual: true }
              )
            );
          }
        }
      }
      const combined = alternatives[0];
      for (let index = 1; index < alternatives.length; index++) combined.append(alternatives[index]);
      return alternatives.length === 1 ? combined : combined.asAlternatives();
    }
  }
  return fail(path, expected ?? expectedOf(ir), v);
}
function unwrapBase(member, seen = /* @__PURE__ */ new Set()) {
  if (seen.has(member)) return member;
  seen.add(member);
  if (member.k === "sub") return unwrapBase(member.schema.ir, seen);
  if (member.k === "alias") return unwrapBase(member.resolve(), seen);
  if (member.k === "refine") return unwrapBase(member.base, seen);
  return member;
}
function collectDiscriminants(member, prefix = [], seen = /* @__PURE__ */ new Set()) {
  if (seen.has(member)) return [];
  seen.add(member);
  if (member.k === "alias") return collectDiscriminants(member.resolve(), prefix, seen);
  if (member.k === "sub") return collectDiscriminants(member.schema.ir, prefix, seen);
  if (member.k === "refine") return collectDiscriminants(member.base, prefix, seen);
  if (member.k !== "object") return [];
  const result = [];
  for (const property of member.props) {
    const propertyPath = [...prefix, property.key];
    const value = unwrapBase(property.val);
    if (value.k === "lit") result.push({ path: propertyPath, value: value.v });
    else result.push(...collectDiscriminants(property.val, propertyPath, new Set(seen)));
  }
  return result;
}
function pathsEqual(left, right) {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}
function valueAtPath(value, path) {
  let cursor = value;
  for (const key of path) {
    if (typeof cursor !== "object" && typeof cursor !== "function" || cursor === null || !(key in cursor)) {
      return { present: false };
    }
    cursor = cursor[key];
  }
  return { present: true, value: cursor };
}
function discriminateFailure(members, value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
  const byMember = members.map((member) => collectDiscriminants(member));
  const candidates = [];
  for (const discriminants of byMember) {
    for (const discriminant of discriminants) {
      if (candidates.some((candidate) => pathsEqual(candidate.path, discriminant.path))) continue;
      const values = [];
      let declared = 0;
      for (const branch of byMember) {
        const match = branch.find((candidate) => pathsEqual(candidate.path, discriminant.path));
        if (match === void 0) continue;
        declared++;
        if (!values.some((candidate) => Object.is(candidate, match.value))) values.push(match.value);
      }
      if (values.length > 1) candidates.push({ path: discriminant.path, distinct: values.length, declared });
    }
  }
  candidates.sort((left, right) => right.distinct - left.distinct || right.declared - left.declared);
  for (const candidate of candidates) {
    const actual = valueAtPath(value, candidate.path);
    const exact = [];
    const defaults = [];
    const expectedMembers = [];
    for (let index = 0; index < members.length; index++) {
      const discriminant = byMember[index].find((item) => pathsEqual(item.path, candidate.path));
      if (discriminant === void 0) {
        defaults.push(members[index]);
        continue;
      }
      expectedMembers.push({ k: "lit", v: discriminant.value });
      if (actual.present && Object.is(actual.value, discriminant.value)) exact.push(members[index]);
    }
    if (!actual.present) {
      if (defaults.length !== 0 && defaults.length < members.length) {
        return discriminateFailure(defaults, value, path);
      }
      return fail([...path, ...candidate.path], expectedOf({ k: "union", members: expectedMembers }), void 0);
    }
    if (exact.length === 0) {
      if (defaults.length !== 0) return discriminateFailure(defaults, value, path);
      return fail([...path, ...candidate.path], expectedOf({ k: "union", members: expectedMembers }), actual.value);
    }
    if (exact.length === 1) {
      const result = visit(exact[0], value, path);
      return result instanceof OmpErrors ? result : void 0;
    }
    const nested = discriminateFailure(exact, value, path);
    if (nested !== void 0) return nested;
  }
  return void 0;
}
function kindMatches(base, v) {
  switch (base.k) {
    case "array":
      return Array.isArray(v);
    case "object":
    case "anyobject":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number";
    default:
      return false;
  }
}

// ../../../omp/packages/omptype/src/compile.ts
var own2 = Object.prototype.hasOwnProperty;
var IDENT = /^[A-Za-z_$][\w$]*$/;
function litSource(v) {
  if (v === null) return "null";
  if (v === void 0) return "undefined";
  switch (typeof v) {
    case "string":
    case "boolean":
      return JSON.stringify(v);
    case "number":
      return Number.isFinite(v) ? String(v) : void 0;
    default:
      return void 0;
  }
}
function isPrimitiveLiteral(node) {
  return node.k === "lit" && (node.v === null || typeof node.v !== "object" && typeof node.v !== "function");
}
function rejectsUndefined(node) {
  switch (node.k) {
    case "unknown":
    case "undefined":
    case "alias":
    case "sub":
      return false;
    case "lit":
      return node.v !== void 0;
    case "union":
      return node.members.every(rejectsUndefined);
    case "intersection":
      return node.members.some(rejectsUndefined);
    case "refine":
      return rejectsUndefined(node.base);
    case "morph":
      return rejectsUndefined(node.input);
    default:
      return true;
  }
}
var CompiledMorphContext = class {
  #path;
  #data;
  constructor(path, data) {
    this.#path = path;
    this.#data = data;
  }
  error(expectation) {
    return new OmpErrors(this.#path, expectation, this.#data);
  }
  reject(expectation) {
    return this.error(expectation);
  }
};
var Builder = class {
  #lines = [];
  #refs = [];
  #activeAliases;
  #id = 0;
  next(prefix) {
    return `${prefix}${this.#id++}`;
  }
  push(line) {
    this.#lines.push(line);
  }
  ref(value) {
    const idx = this.#refs.indexOf(value);
    if (idx >= 0) return `R[${idx}]`;
    this.#refs.push(value);
    return `R[${this.#refs.length - 1}]`;
  }
  lit(v) {
    return litSource(v) ?? this.ref(v);
  }
  access(base, key) {
    return typeof key === "string" && IDENT.test(key) ? `${base}.${key}` : `${base}[${this.lit(key)}]`;
  }
  pathExpr(segs) {
    const parts = segs.map((seg) => "s" in seg ? this.lit(seg.s) : seg.d);
    return `[${parts.join(",")}]`;
  }
  storedPathExpr(segs) {
    if (segs.length === 0) return "undefined";
    if (segs.length === 1) {
      const seg = segs[0];
      return "s" in seg ? this.lit(seg.s) : seg.d;
    }
    const staticParts = [];
    for (const seg of segs) {
      if ("d" in seg) return this.pathExpr(segs);
      staticParts.push(seg.s);
    }
    return this.ref(staticParts);
  }
  error(segs, expected, dataExpr) {
    return `new AE(${this.storedPathExpr(segs)},${JSON.stringify(expected)},${dataExpr})`;
  }
  fail(segs, expected, dataExpr) {
    return `return ${this.error(segs, expected, dataExpr)}`;
  }
  appendError(errors, error) {
    return `if(${errors}===undefined)${errors}=${error};else ${errors}.append(${error});`;
  }
  /** Pure boolean predicate for a morph-free subtree. */
  predicate(node, v) {
    switch (node.k) {
      case "unknown":
        return "true";
      case "null":
        return `${v}===null`;
      case "undefined":
        return `${v}===undefined`;
      case "boolean":
        return `typeof ${v}==="boolean"`;
      case "bigint":
        return `typeof ${v}==="bigint"`;
      case "symbol":
        return `typeof ${v}==="symbol"`;
      case "never":
        return "false";
      case "anyobject":
        return `(typeof ${v}==="object"&&${v}!==null)`;
      case "lit":
        return node.v instanceof Date ? `(${v} instanceof Date&&${v}.valueOf()===${node.v.valueOf()})` : `${v}===${this.lit(node.v)}`;
      case "instance":
        return `${v} instanceof ${this.ref(node.ctor)}`;
      case "string": {
        let out = `typeof ${v}==="string"`;
        if (node.min !== void 0) out += `&&${v}.length>=${node.min}`;
        if (node.max !== void 0) out += `&&${v}.length<=${node.max}`;
        if (node.url) out += `&&URL.canParse(${v})`;
        return out;
      }
      case "number": {
        let out = node.int ? `Number.isInteger(${v})` : `Number.isFinite(${v})`;
        if (node.divisor !== void 0) out += `&&${v}%${node.divisor}===0`;
        if (node.min !== void 0) out += `&&${v}${node.xmin ? ">" : ">="}${node.min}`;
        if (node.max !== void 0) out += `&&${v}${node.xmax ? "<" : "<="}${node.max}`;
        return out;
      }
      case "union": {
        const lits = node.members.filter(isPrimitiveLiteral);
        if (lits.length > 8) {
          const values = this.ref(new Set(lits.map((member) => member.v)));
          const literalNodes = new Set(lits);
          const rest = node.members.filter((member) => !literalNodes.has(member));
          let out = `${values}.has(${v})`;
          for (const m of rest) out += `||(${this.predicate(m, v)})`;
          return `(${out})`;
        }
        return `(${node.members.map((m) => `(${this.predicate(m, v)})`).join("||")})`;
      }
      case "intersection":
        return `(${node.members.map((member) => `(${this.predicate(member, v)})`).join("&&")})`;
      case "array": {
        const array = this.next("a");
        const index = this.next("i");
        let out = `Array.isArray(${v})`;
        if (node.min !== void 0) out += `&&${v}.length>=${node.min}`;
        if (node.max !== void 0) out += `&&${v}.length<=${node.max}`;
        const item = `${array}[${index}]`;
        out += `&&((${array})=>{for(let ${index}=0;${index}<${array}.length;${index}++)if(!(${this.predicate(node.el, item)}))return false;return true})(${v})`;
        return out;
      }
      case "object": {
        const checks2 = [`typeof ${v}==="object"`, `${v}!==null`];
        for (const p of node.props) {
          const av = this.access(v, p.key);
          const present = `${this.lit(p.key)} in ${v}`;
          const predicate = this.predicate(p.val, av);
          checks2.push(
            p.opt || p.hasDefault ? rejectsUndefined(p.val) ? `((${av}!==undefined&&(${predicate}))||!(${present}))` : `(!(${present})||(${predicate}))` : rejectsUndefined(p.val) ? predicate : `((${present})&&(${predicate}))`
          );
        }
        const stringKey = this.next("k");
        if (node.index !== void 0) {
          checks2.push(
            `(()=>{for(const ${stringKey} in ${v})if(own.call(${v},${stringKey})&&!(${this.predicate(node.index, `${v}[${stringKey}]`)}))return false;return true})()`
          );
        }
        if (node.patternIndexes !== void 0) {
          for (const pattern2 of node.patternIndexes) {
            checks2.push(
              `(()=>{for(const ${stringKey} in ${v})if(own.call(${v},${stringKey})&&(${this.predicate(pattern2.key, stringKey)})&&!(${this.predicate(pattern2.val, `${v}[${stringKey}]`)}))return false;return true})()`
            );
          }
        }
        if (node.symbolIndex !== void 0) {
          const symbol = this.next("s");
          checks2.push(
            `(()=>{for(const ${symbol} of Object.getOwnPropertySymbols(${v}))if(Object.prototype.propertyIsEnumerable.call(${v},${symbol})&&!(${this.predicate(node.symbolIndex, `${v}[${symbol}]`)}))return false;return true})()`
          );
        }
        if (node.extras === "reject") {
          const patternMatch = node.patternIndexes?.map((pattern2) => `(${this.predicate(pattern2.key, stringKey)})`).join("||") ?? "false";
          if (node.index === void 0) {
            checks2.push(
              `(()=>{for(const ${stringKey} in ${v})if(own.call(${v},${stringKey})&&!(${this.declaredCheck(node.props, stringKey)})&&!(${patternMatch}))return false;return true})()`
            );
          }
          if (node.symbolIndex === void 0) {
            const symbol = this.next("s");
            checks2.push(
              `(()=>{for(const ${symbol} of Object.getOwnPropertySymbols(${v}))if(Object.prototype.propertyIsEnumerable.call(${v},${symbol})&&!(${this.declaredCheck(node.props, symbol)}))return false;return true})()`
            );
          }
        }
        return `(${checks2.join("&&")})`;
      }
      case "sub":
        return `!(${this.ref(node.schema.run)}(${v}) instanceof AE)`;
      default:
        return `!(${this.ref(boundWalk(node))}(${v}) instanceof AE)`;
    }
  }
  declaredCheck(props, keyVar) {
    if (props.length === 0) return "false";
    if (props.length > 6) {
      const set = this.ref(new Set(props.map((p) => p.key)));
      return `${set}.has(${keyVar})`;
    }
    return `(${props.map((p) => `${keyVar}===${this.lit(p.key)}`).join("||")})`;
  }
  /**
   * Run a node through its interpreter/sub-schema runner, appending any
   * failure to `errors`. `brk` (when given) exits the enclosing block on
   * failure so dependent statements (output assignment, morph fns) are
   * skipped. Both runner kinds receive the absolute path so nested step
   * callbacks observe ctx.path; walk-produced errors are already absolute,
   * while sub runners return schema-relative errors that need prefixing.
   */
  emitCollectDelegate(node, v, segs, errors, brk, out) {
    const sub = node.k === "sub";
    const runner = sub ? node.schema.run : boundWalk(node);
    const result = this.next("r");
    const args = segs.length > 0 ? `${v},${this.pathExpr(segs)}` : v;
    this.push(`const ${result}=${this.ref(runner)}(${args});`);
    const failure = sub && segs.length > 0 ? `PF(${result},${this.pathExpr(segs)})` : result;
    this.push(
      `if(${result} instanceof AE){${this.appendError(errors, failure)}${brk === void 0 ? "" : `break ${brk};`}}`
    );
    if (out !== void 0) this.push(`${out}=${result};`);
  }
  /** Snapshot the error count so sequencing sites can detect soft failures. */
  markErrors(errors) {
    const mark = this.next("n");
    this.push(`const ${mark}=${errors}===void 0?0:${errors}.length;`);
    return mark;
  }
  /** Exit `brk` when errors were appended since `mark` (interp's return-on-error). */
  guardGrowth(errors, mark, brk) {
    this.push(`if((${errors}===void 0?0:${errors}.length)!==${mark})break ${brk};`);
  }
  /** Aggregate every independent failure in a morph-free subtree. */
  emitCollectCheck(node, v, segs, errors, failureData = v) {
    if (node.cfg !== void 0 || node.k === "refine") {
      this.emitCollectDelegate(node, v, segs, errors);
      return;
    }
    switch (node.k) {
      case "unknown":
        return;
      case "array": {
        this.push(
          `if(!Array.isArray(${v})){${this.appendError(errors, this.error(segs, "an array", failureData))}}`
        );
        if (node.min !== void 0) {
          this.push(
            `else if(${v}.length<${node.min}){${this.appendError(
              errors,
              this.error(segs, `at least length ${node.min}`, `${v}.length`)
            )}}`
          );
        }
        if (node.max !== void 0) {
          this.push(
            `else if(${v}.length>${node.max}){${this.appendError(
              errors,
              this.error(segs, `at most length ${node.max}`, `${v}.length`)
            )}}`
          );
        }
        this.push("else{");
        const index = this.next("i");
        this.push(`for(let ${index}=0;${index}<${v}.length;${index}++){`);
        this.emitCollectCheck(node.el, `${v}[${index}]`, [...segs, { d: index }], errors);
        this.push("}}");
        return;
      }
      case "tuple": {
        this.push(
          `if(!Array.isArray(${v})){${this.appendError(errors, this.error(segs, "an array", failureData))}}else{`
        );
        const requiredPrefix = node.prefix.filter((item) => !item.opt && !item.hasDefault).length;
        const minimum = requiredPrefix + node.postfix.length;
        const maximum = node.prefix.length + node.postfix.length;
        if (minimum > 0) {
          this.push(
            `if(${v}.length<${minimum}){${this.appendError(
              errors,
              this.error(segs, `an array of at least length ${minimum}`, failureData)
            )}}else{`
          );
        }
        if (node.variadic === void 0) {
          this.push(
            `if(${v}.length>${maximum}){${this.appendError(
              errors,
              this.error(segs, `an array of at most length ${maximum}`, failureData)
            )}}else{`
          );
        }
        let postfixStart = `${v}.length`;
        if (node.postfix.length > 0) {
          postfixStart = this.next("p");
          this.push(`const ${postfixStart}=${v}.length-${node.postfix.length};`);
        }
        let prefixCount = String(node.prefix.length);
        if (requiredPrefix !== node.prefix.length) {
          prefixCount = this.next("n");
          this.push(`const ${prefixCount}=Math.min(${node.prefix.length},${postfixStart});`);
        }
        for (let index = 0; index < node.prefix.length; index++) {
          if (index >= requiredPrefix) this.push(`if(${index}<${prefixCount}){`);
          this.emitCollectCheck(node.prefix[index].val, `${v}[${index}]`, [...segs, { d: String(index) }], errors);
          if (index >= requiredPrefix) this.push("}");
        }
        if (node.variadic !== void 0) {
          const index = this.next("i");
          this.push(`for(let ${index}=${prefixCount};${index}<${postfixStart};${index}++){`);
          this.emitCollectCheck(node.variadic, `${v}[${index}]`, [...segs, { d: index }], errors);
          this.push("}");
        }
        for (let index = 0; index < node.postfix.length; index++) {
          const inputIndex = index === 0 ? postfixStart : `${postfixStart}+${index}`;
          this.emitCollectCheck(node.postfix[index], `${v}[${inputIndex}]`, [...segs, { d: inputIndex }], errors);
        }
        if (node.variadic === void 0) this.push("}");
        if (minimum > 0) this.push("}");
        this.push("}");
        return;
      }
      case "object": {
        if (node.patternIndexes !== void 0 || node.symbolIndex !== void 0 || node.props.some((prop) => typeof prop.key === "symbol")) {
          this.emitCollectDelegate(node, v, segs, errors);
          return;
        }
        this.push(
          `if(typeof ${v}!=="object"||${v}===null){${this.appendError(
            errors,
            this.error(segs, "an object", failureData)
          )}}else{`
        );
        for (const prop of node.props) {
          const present = `${this.lit(prop.key)} in ${v}`;
          const propSegs = [...segs, { s: prop.key }];
          if (prop.opt || prop.hasDefault) {
            this.push(`if(${present}){`);
            this.emitCollectCheck(prop.val, this.access(v, prop.key), propSegs, errors);
            this.push("}");
          } else {
            this.push(
              `if(!(${present})){${this.appendError(
                errors,
                this.error(propSegs, expectedOf(prop.val), "M")
              )}}else{`
            );
            this.emitCollectCheck(prop.val, this.access(v, prop.key), propSegs, errors);
            this.push("}");
          }
        }
        if (node.index !== void 0) {
          const key = this.next("k");
          this.push(`for(const ${key} in ${v})if(own.call(${v},${key})){`);
          this.emitCollectCheck(node.index, `${v}[${key}]`, [...segs, { d: key }], errors);
          this.push("}");
        } else if (node.extras === "reject") {
          const key = this.next("k");
          this.push(
            `for(const ${key} in ${v})if(own.call(${v},${key})&&!(${this.declaredCheck(node.props, key)})){`
          );
          this.push(this.appendError(errors, this.error([...segs, { d: key }], "removed", `${v}[${key}]`)));
          this.push("}");
        }
        if (node.extras === "reject") {
          const symbol = this.next("s");
          this.push(
            `for(const ${symbol} of Object.getOwnPropertySymbols(${v}))if(Object.prototype.propertyIsEnumerable.call(${v},${symbol})&&!(${this.declaredCheck(node.props, symbol)})){${this.appendError(errors, this.error([...segs, { d: symbol }], "removed", `${v}[${symbol}]`))}}`
          );
        }
        this.push("}");
        return;
      }
      case "union": {
        const failure = node.members.some(canRefineUnionFailure) ? `UF(${this.ref(node)},${failureData},${this.pathExpr(segs)},${JSON.stringify(expectedOf(node))})` : this.error(segs, expectedOf(node), failureData);
        this.push(`if(!(${this.predicate(node, v)})){${this.appendError(errors, failure)}}`);
        return;
      }
      case "string": {
        this.push(
          `if(typeof ${v}!=="string"){${this.appendError(errors, this.error(segs, "a string", failureData))}}`
        );
        if (node.min !== void 0) {
          this.push(
            `else if(${v}.length<${node.min}){${this.appendError(
              errors,
              this.error(segs, `at least length ${node.min}`, `${v}.length`)
            )}}`
          );
        }
        if (node.max !== void 0) {
          this.push(
            `else if(${v}.length>${node.max}){${this.appendError(
              errors,
              this.error(segs, `at most length ${node.max}`, `${v}.length`)
            )}}`
          );
        }
        if (node.url) {
          this.push(
            `else if(!URL.canParse(${v})){${this.appendError(
              errors,
              this.error(segs, "a URL string", failureData)
            )}}`
          );
        }
        return;
      }
      case "number": {
        this.push(
          `if(typeof ${v}!=="number"||!Number.isFinite(${v})){${this.appendError(
            errors,
            this.error(segs, node.int ? "an integer" : "a number", failureData)
          )}}else{`
        );
        if (node.int) {
          this.push(
            `if(!Number.isInteger(${v})){${this.appendError(errors, this.error(segs, "an integer", failureData))}}`
          );
        }
        if (node.divisor !== void 0) {
          this.push(
            `if(${v}%${node.divisor}!==0){${this.appendError(
              errors,
              this.error(segs, `a number divisible by ${node.divisor}`, failureData)
            )}}`
          );
        }
        if (node.min !== void 0) {
          const expected = node.min === 0 ? node.xmin ? "positive" : "non-negative" : `a number ${node.xmin ? "more than" : "at least"} ${node.min}`;
          this.push(
            `if(${v}${node.xmin ? "<=" : "<"}${node.min}){${this.appendError(
              errors,
              this.error(segs, expected, failureData)
            )}}`
          );
        }
        if (node.max !== void 0) {
          const expected = node.max === 0 ? node.xmax ? "negative" : "non-positive" : `a number ${node.xmax ? "less than" : "at most"} ${node.max}`;
          this.push(
            `if(${v}${node.xmax ? ">=" : ">"}${node.max}){${this.appendError(
              errors,
              this.error(segs, expected, failureData)
            )}}`
          );
        }
        this.push("}");
        return;
      }
      case "lit":
        if (node.v !== null && typeof node.v === "object" && !(node.v instanceof Date) || typeof node.v === "function") {
          this.emitCollectDelegate(node, v, segs, errors);
        } else {
          this.push(
            `if(!(${this.predicate(node, v)})){${this.appendError(
              errors,
              this.error(segs, expectedOf(node), failureData)
            )}}`
          );
        }
        return;
      case "intersection":
      case "sub":
        this.emitCollectDelegate(node, v, segs, errors);
        return;
      case "null":
      case "undefined":
      case "boolean":
      case "bigint":
      case "symbol":
      case "never":
      case "anyobject":
      case "instance":
        this.push(
          `if(!(${this.predicate(node, v)})){${this.appendError(
            errors,
            this.error(segs, expectedOf(node), failureData)
          )}}`
        );
        return;
      default:
        this.emitCollectDelegate(node, v, segs, errors);
    }
  }
  emitTupleShape(node, v, segs, errors, brk, failureData) {
    this.push(
      `if(!Array.isArray(${v})){${this.appendError(errors, this.error(segs, "an array", failureData))}break ${brk};}`
    );
    const requiredPrefix = node.prefix.filter((item) => !item.opt && !item.hasDefault).length;
    const minimum = requiredPrefix + node.postfix.length;
    if (minimum > 0) {
      this.push(
        `if(${v}.length<${minimum}){${this.appendError(
          errors,
          this.error(segs, `an array of at least length ${minimum}`, failureData)
        )}break ${brk};}`
      );
    }
    if (node.variadic === void 0) {
      const maximum = node.prefix.length + node.postfix.length;
      this.push(
        `if(${v}.length>${maximum}){${this.appendError(
          errors,
          this.error(segs, `an array of at most length ${maximum}`, failureData)
        )}break ${brk};}`
      );
    }
    let postfixStart = `${v}.length`;
    if (node.postfix.length > 0) {
      postfixStart = this.next("p");
      this.push(`const ${postfixStart}=${v}.length-${node.postfix.length};`);
    }
    let prefixCount = String(node.prefix.length);
    if (requiredPrefix !== node.prefix.length) {
      prefixCount = this.next("n");
      this.push(`const ${prefixCount}=Math.min(${node.prefix.length},${postfixStart});`);
    }
    return { postfixStart, prefixCount, requiredPrefix };
  }
  /** Fill `target` with a validated default (factory output revalidated per call). */
  emitDefaultFill(val, def, isFactory, target, segs, errors) {
    if (isFactory && typeof def === "function") {
      const candidate = this.next("d");
      const resolved = this.next("t");
      const label = this.next("L");
      this.push(`const ${candidate}=${this.ref(def)}();let ${resolved};${label}:{`);
      this.emitCollectProduce(val, candidate, segs, resolved, errors, label);
      this.push(`${target}=${resolved};}`);
    } else {
      this.push(`${target}=${litSource(def) ?? `MD(${this.ref(def)})`};`);
    }
  }
  /**
   * Validate `v` against a morphing subtree and assign the produced output
   * to `out` (an already-declared `let`). Failures append to `errors` and
   * `break ${brk}` (skipping the output assignment), mirroring interp: an
   * error in one child never suppresses sibling validation or morphs.
   */
  emitCollectProduce(node, v, segs, out, errors, brk, failureData = v) {
    if (node.cfg !== void 0 || node.k === "refine") {
      this.emitCollectDelegate(node, v, segs, errors, brk, out);
      return;
    }
    if (!hasMorph(node)) {
      this.emitCollectCheck(node, v, segs, errors, failureData);
      this.push(`${out}=${v};`);
      return;
    }
    switch (node.k) {
      case "sub":
        this.emitCollectDelegate(node, v, segs, errors, brk, out);
        return;
      case "morph": {
        const input = this.next("t");
        this.push(`let ${input};`);
        const mark = this.markErrors(errors);
        this.emitCollectProduce(node.input, v, segs, input, errors, brk, failureData);
        this.guardGrowth(errors, mark, brk);
        const context = this.next("c");
        const result = this.next("r");
        this.push(`const ${context}=new MC(${this.storedPathExpr(segs)},${input});`);
        this.push(`const ${result}=${this.ref(node.fn)}(${input},${context});`);
        this.push(`if(${result} instanceof AE){${this.appendError(errors, result)}break ${brk};}`);
        if (node.out === void 0) this.push(`${out}=${result};`);
        else this.emitCollectProduce(node.out, result, segs, out, errors, brk);
        return;
      }
      case "alias": {
        let active = this.#activeAliases;
        if (active === void 0) {
          active = /* @__PURE__ */ new Set();
          this.#activeAliases = active;
        }
        if (active.has(node)) {
          this.emitCollectDelegate(node, v, segs, errors, brk, out);
          return;
        }
        active.add(node);
        try {
          this.emitCollectProduce(node.resolve(), v, segs, out, errors, brk, failureData);
        } finally {
          active.delete(node);
        }
        return;
      }
      case "union": {
        const ok = this.next("u");
        this.push(`let ${ok}=false;`);
        const label = this.next("b");
        this.push(`${label}:{`);
        for (const m of node.members) {
          if (m.k !== "sub" && !hasMorph(m)) {
            this.push(`if(${this.predicate(m, v)}){${out}=${v};${ok}=true;break ${label};}`);
          }
        }
        for (const m of node.members) {
          if (m.k === "sub" || hasMorph(m)) {
            const runner = m.k === "sub" ? m.schema.run : m.k === "alias" ? boundWalk(m) : compile(m);
            const r = this.next("r");
            this.push(`const ${r}=${this.ref(runner)}(${v});`);
            this.push(`if(!(${r} instanceof AE)){${out}=${r};${ok}=true;break ${label};}`);
          }
        }
        this.push("}");
        const failure = `UF(${this.ref(node)},${failureData},${this.pathExpr(segs)},${JSON.stringify(expectedOf(node))})`;
        this.push(`if(!${ok}){${this.appendError(errors, failure)}break ${brk};}`);
        return;
      }
      case "array": {
        this.push(
          `if(!Array.isArray(${v})){${this.appendError(errors, this.error(segs, "an array", failureData))}break ${brk};}`
        );
        if (node.min !== void 0) {
          this.push(
            `if(${v}.length<${node.min}){${this.appendError(
              errors,
              this.error(segs, `at least length ${node.min}`, `${v}.length`)
            )}break ${brk};}`
          );
        }
        if (node.max !== void 0) {
          this.push(
            `if(${v}.length>${node.max}){${this.appendError(
              errors,
              this.error(segs, `at most length ${node.max}`, `${v}.length`)
            )}break ${brk};}`
          );
        }
        const array = this.next("a");
        const index = this.next("i");
        const input = this.next("x");
        const element = this.next("t");
        const label = this.next("L");
        this.push(`const ${array}=new Array(${v}.length);`);
        this.push(
          `for(let ${index}=0;${index}<${v}.length;${index}++){const ${input}=${v}[${index}];let ${element};${label}:{`
        );
        this.emitCollectProduce(node.el, input, [...segs, { d: index }], element, errors, label);
        this.push(`${array}[${index}]=${element};}}`);
        this.push(`${out}=${array};`);
        return;
      }
      case "tuple": {
        const { postfixStart, prefixCount, requiredPrefix } = this.emitTupleShape(
          node,
          v,
          segs,
          errors,
          brk,
          failureData
        );
        const tuple = this.next("a");
        this.push(`const ${tuple}=[...${v}];`);
        for (let index = 0; index < node.prefix.length; index++) {
          const item = node.prefix[index];
          const itemSegs = [...segs, { s: index }];
          const input = `${v}[${index}]`;
          const output = `${tuple}[${index}]`;
          const label = this.next("L");
          if (index >= requiredPrefix) this.push(`if(${index}<${prefixCount}){`);
          this.push(`${label}:{`);
          if (hasMorph(item.val)) {
            const temporary = this.next("t");
            this.push(`let ${temporary};`);
            this.emitCollectProduce(item.val, input, itemSegs, temporary, errors, label);
            this.push(`${output}=${temporary};`);
          } else {
            this.emitCollectCheck(item.val, input, itemSegs, errors);
          }
          this.push("}");
          if (index >= requiredPrefix) {
            if (item.hasDefault) {
              this.push("}else{");
              this.emitDefaultFill(item.val, item.def, item.defFactory === true, output, itemSegs, errors);
              this.push("}");
            } else {
              this.push("}");
            }
          }
        }
        if (node.variadic !== void 0) {
          const index = this.next("i");
          const input = this.next("x");
          const label = this.next("L");
          this.push(
            `for(let ${index}=${prefixCount};${index}<${postfixStart};${index}++){const ${input}=${v}[${index}];${label}:{`
          );
          if (hasMorph(node.variadic)) {
            const temporary = this.next("t");
            this.push(`let ${temporary};`);
            this.emitCollectProduce(node.variadic, input, [...segs, { d: index }], temporary, errors, label);
            this.push(`${tuple}[${index}]=${temporary};`);
          } else {
            this.emitCollectCheck(node.variadic, input, [...segs, { d: index }], errors);
          }
          this.push("}}");
        }
        for (let index = 0; index < node.postfix.length; index++) {
          const inputIndex = index === 0 ? postfixStart : `${postfixStart}+${index}`;
          const input = `${v}[${inputIndex}]`;
          const item = node.postfix[index];
          const label = this.next("L");
          this.push(`${label}:{`);
          if (hasMorph(item)) {
            const temporary = this.next("t");
            this.push(`let ${temporary};`);
            this.emitCollectProduce(item, input, [...segs, { d: inputIndex }], temporary, errors, label);
            this.push(`${tuple}[${inputIndex}]=${temporary};`);
          } else {
            this.emitCollectCheck(item, input, [...segs, { d: inputIndex }], errors);
          }
          this.push("}");
        }
        this.push(`${out}=${tuple};`);
        return;
      }
      case "object": {
        if (node.patternIndexes !== void 0 || node.symbolIndex !== void 0 || node.props.some((prop) => typeof prop.key === "symbol")) {
          this.emitCollectDelegate(node, v, segs, errors, brk, out);
          return;
        }
        this.push(
          `if(typeof ${v}!=="object"||${v}===null){${this.appendError(
            errors,
            this.error(segs, "an object", failureData)
          )}break ${brk};}`
        );
        const object = this.next("o");
        const fresh = node.extras === "delete" && node.index === void 0;
        this.push(fresh ? `const ${object}={};` : `const ${object}={...${v}};`);
        for (const prop of node.props) {
          const present = `${this.lit(prop.key)} in ${v}`;
          const propSegs = [...segs, { s: prop.key }];
          const input = this.access(v, prop.key);
          const output = this.access(object, prop.key);
          const label = this.next("L");
          this.push(`if(!(${present})){`);
          if (prop.hasDefault) {
            this.emitDefaultFill(prop.val, prop.def, prop.defFactory === true, output, propSegs, errors);
          } else if (!prop.opt) {
            this.push(this.appendError(errors, this.error(propSegs, expectedOf(prop.val), "M")));
          }
          this.push(`}else{${label}:{`);
          if (hasMorph(prop.val)) {
            const temporary = this.next("t");
            this.push(`let ${temporary};`);
            this.emitCollectProduce(prop.val, input, propSegs, temporary, errors, label);
            this.push(`${output}=${temporary};`);
          } else {
            this.emitCollectCheck(prop.val, input, propSegs, errors);
            if (fresh) this.push(`${output}=${input};`);
          }
          this.push("}}");
        }
        if (node.index !== void 0) {
          const key = this.next("k");
          const label = this.next("L");
          this.push(`for(const ${key} in ${v})if(own.call(${v},${key})){${label}:{`);
          if (hasMorph(node.index)) {
            const temporary = this.next("t");
            this.push(`let ${temporary};`);
            this.emitCollectProduce(node.index, `${v}[${key}]`, [...segs, { d: key }], temporary, errors, label);
            this.push(`${object}[${key}]=${temporary};`);
          } else {
            this.emitCollectCheck(node.index, `${v}[${key}]`, [...segs, { d: key }], errors);
          }
          this.push("}}");
        } else if (node.extras === "reject") {
          const key = this.next("k");
          this.push(
            `for(const ${key} in ${v})if(own.call(${v},${key})&&!(${this.declaredCheck(node.props, key)})){${this.appendError(
              errors,
              this.error([...segs, { d: key }], "removed", `${v}[${key}]`)
            )}}`
          );
        }
        if (node.extras === "reject") {
          const symbol = this.next("s");
          this.push(
            `for(const ${symbol} of Object.getOwnPropertySymbols(${v}))if(Object.prototype.propertyIsEnumerable.call(${v},${symbol})&&!(${this.declaredCheck(node.props, symbol)})){${this.appendError(errors, this.error([...segs, { d: symbol }], "removed", `${v}[${symbol}]`))}}`
          );
        }
        this.push(`${out}=${object};`);
        return;
      }
      case "intersection": {
        const current = this.next("t");
        this.push(`let ${current}=${v};`);
        const mark = this.markErrors(errors);
        for (let index = 0; index < node.members.length; index++) {
          if (index > 0) this.guardGrowth(errors, mark, brk);
          const member = node.members[index];
          if (hasMorph(member)) this.emitCollectProduce(member, current, segs, current, errors, brk);
          else this.emitCollectCheck(member, current, segs, errors);
        }
        this.push(`${out}=${current};`);
        return;
      }
      default:
        this.emitCollectDelegate(node, v, segs, errors, brk, out);
    }
  }
  build(ir) {
    const errors = this.next("e");
    let ret;
    if (hasMorph(ir)) {
      const label = this.next("L");
      this.push(`let ${errors};let o;${label}:{`);
      this.emitCollectProduce(ir, "v", [], "o", errors, label);
      this.push("}");
      ret = "o";
    } else {
      this.push(`let ${errors};`);
      this.emitCollectCheck(ir, "v", [], errors);
      ret = "v";
    }
    this.push(`if(${errors}!==undefined)return ${errors};`);
    const src = `return function(v){${this.#lines.join("")}return ${ret}}`;
    const make = new Function("R", "AE", "M", "PF", "UF", "MC", "own", "MD", src);
    return make(
      this.#refs,
      OmpErrors,
      MISSING,
      prefixErrors,
      unionFail,
      CompiledMorphContext,
      own2,
      materializeDefault
    );
  }
  emitAllows(node, v) {
    switch (node.k) {
      case "array": {
        const array = this.next("a");
        const index = this.next("i");
        this.push(`const ${array}=${v};if(!Array.isArray(${array}))return false;`);
        if (node.min !== void 0) this.push(`if(${array}.length<${node.min})return false;`);
        if (node.max !== void 0) this.push(`if(${array}.length>${node.max})return false;`);
        this.push(`for(let ${index}=0;${index}<${array}.length;${index}++){`);
        this.emitAllows(node.el, `${array}[${index}]`);
        this.push("}");
        return;
      }
      case "object": {
        const object = this.next("o");
        this.push(`const ${object}=${v};if(typeof ${object}!=="object"||${object}===null)return false;`);
        for (const prop of node.props) {
          const value = this.next("p");
          const present = `${this.lit(prop.key)} in ${object}`;
          this.push(`const ${value}=${this.access(object, prop.key)};`);
          if (prop.opt || prop.hasDefault) {
            if (rejectsUndefined(prop.val)) {
              this.push(`if(${value}!==undefined){`);
              this.emitAllows(prop.val, value);
              this.push(`}else if(${present})return false;`);
            } else {
              this.push(`if(${present}){`);
              this.emitAllows(prop.val, value);
              this.push("}");
            }
          } else {
            if (!rejectsUndefined(prop.val)) this.push(`if(!(${present}))return false;`);
            this.emitAllows(prop.val, value);
          }
        }
        const stringKey = this.next("k");
        if (node.index !== void 0) {
          this.push(`for(const ${stringKey} in ${object}){if(!own.call(${object},${stringKey}))continue;`);
          this.emitAllows(node.index, `${object}[${stringKey}]`);
          this.push("}");
        }
        if (node.patternIndexes !== void 0) {
          for (const pattern2 of node.patternIndexes) {
            this.push(
              `for(const ${stringKey} in ${object})if(own.call(${object},${stringKey})&&(${this.predicate(pattern2.key, stringKey)})&&!(${this.predicate(pattern2.val, `${object}[${stringKey}]`)}))return false;`
            );
          }
        }
        if (node.symbolIndex !== void 0) {
          const symbol = this.next("s");
          this.push(
            `for(const ${symbol} of Object.getOwnPropertySymbols(${object})){if(!Object.prototype.propertyIsEnumerable.call(${object},${symbol}))continue;`
          );
          this.emitAllows(node.symbolIndex, `${object}[${symbol}]`);
          this.push("}");
        }
        if (node.extras === "reject") {
          const patternMatch = node.patternIndexes?.map((pattern2) => `(${this.predicate(pattern2.key, stringKey)})`).join("||") ?? "false";
          if (node.index === void 0) {
            this.push(
              `for(const ${stringKey} in ${object})if(own.call(${object},${stringKey})&&!(${this.declaredCheck(node.props, stringKey)})&&!(${patternMatch}))return false;`
            );
          }
          if (node.symbolIndex === void 0) {
            const symbol = this.next("s");
            this.push(
              `for(const ${symbol} of Object.getOwnPropertySymbols(${object}))if(Object.prototype.propertyIsEnumerable.call(${object},${symbol})&&!(${this.declaredCheck(node.props, symbol)}))return false;`
            );
          }
        }
        return;
      }
      case "union": {
        const sources = [];
        for (const member of node.members) {
          if (!isPrimitiveLiteral(member)) break;
          const source = litSource(member.v);
          if (source === void 0) break;
          sources.push(source);
        }
        if (sources.length === node.members.length && sources.length >= 4) {
          this.push(
            `switch(${v}){${sources.map((source) => `case ${source}:`).join("")}break;default:return false;}`
          );
          return;
        }
        this.push(`if(!(${this.predicate(node, v)}))return false;`);
        return;
      }
      default:
        this.push(`if(!(${this.predicate(node, v)}))return false;`);
    }
  }
  buildAllows(ir) {
    this.emitAllows(ir, "v");
    const src = `return function(v){${this.#lines.join("")}return true}`;
    const make = new Function("R", "AE", "own", src);
    return make(this.#refs, OmpErrors, own2);
  }
};
function prefixErrors(errs, parts) {
  for (let i = parts.length - 1; i >= 0; i--) errs.prefix(parts[i]);
  return errs;
}
var kWalk = Symbol("omptype.boundWalk");
function boundWalk(node) {
  const tagged = node;
  let fn = tagged[kWalk];
  if (!fn) {
    fn = (value, path) => walk(node, value, path);
    tagged[kWalk] = fn;
  }
  return fn;
}
function resolvedRoot(ir) {
  return ir.k === "alias" ? ir.resolve() : ir;
}
var compiledCache = /* @__PURE__ */ new WeakMap();
var allowsCache = /* @__PURE__ */ new WeakMap();
function compile(ir) {
  const root = resolvedRoot(ir);
  const validator = compiledCache.get(root);
  if (validator === void 0) {
    const built = {};
    compiledCache.set(root, (value) => built.value === void 0 ? walk(root, value) : built.value(value));
    const compiled = new Builder().build(root);
    built.value = compiled;
    compiledCache.set(root, compiled);
    return compiled;
  }
  return validator;
}
function compileAllows(ir) {
  const root = resolvedRoot(ir);
  const validator = allowsCache.get(root);
  if (validator === void 0) {
    const built = {};
    allowsCache.set(root, (value) => built.value === void 0 ? !(walk(root, value) instanceof OmpErrors) : built.value(value));
    const compiled = new Builder().buildAllows(root);
    built.value = compiled;
    allowsCache.set(root, compiled);
    return compiled;
  }
  return validator;
}

// ../../../omp/packages/omptype/src/json-schema.ts
function irToJsonSchema(ir, options) {
  const ctx = { options, defs: /* @__PURE__ */ new Map(), refs: /* @__PURE__ */ new Map() };
  let schema = emit(ir, ctx);
  if (ctx.defs.size > 0) schema.$defs = Object.fromEntries(ctx.defs);
  if (options?.target === "draft-07") schema = toDraft7(schema);
  const dialect = options?.dialect === null ? void 0 : options?.dialect ?? dialectFor(options?.target);
  if (dialect !== void 0) schema.$schema = dialect;
  if (options?.description !== void 0) schema.description = options.description;
  return schema;
}
function dialectFor(target) {
  if (target === "draft-2020-12") return "https://json-schema.org/draft/2020-12/schema";
  if (target === "draft-07") return "http://json-schema.org/draft-07/schema#";
  return target !== void 0 && (target.startsWith("http://") || target.startsWith("https://")) ? target : void 0;
}
function fallback(schema, ctx) {
  const replacement = ctx.options?.fallback?.({ base: schema });
  if (replacement === true) return {};
  if (replacement === false) return { not: {} };
  return typeof replacement === "object" && replacement !== null ? replacement : schema;
}
function toDraft7(schema) {
  const converted = {};
  for (const key in schema) {
    const value = schema[key];
    if (key === "$ref" && typeof value === "string") {
      converted.$ref = value.replace("#/$defs/", "#/definitions/");
    } else if (key === "$defs") {
      converted.definitions = toDraft7(value);
    } else if (key === "prefixItems" && Array.isArray(value)) {
      converted.items = value.map(
        (item) => typeof item === "object" && item !== null ? toDraft7(item) : item
      );
    } else if (key === "items" && "prefixItems" in schema) {
      converted.additionalItems = typeof value === "object" && value !== null ? toDraft7(value) : value;
    } else if (Array.isArray(value)) {
      converted[key] = value.map(
        (item) => typeof item === "object" && item !== null ? toDraft7(item) : item
      );
    } else if (typeof value === "object" && value !== null) {
      converted[key] = toDraft7(value);
    } else {
      converted[key] = value;
    }
  }
  return converted;
}
function emit(ir, ctx) {
  let schema;
  switch (ir.k) {
    case "unknown":
      schema = {};
      break;
    case "undefined":
      schema = fallback({}, ctx);
      break;
    case "null":
      schema = { type: "null" };
      break;
    case "boolean":
      schema = { type: "boolean" };
      break;
    case "bigint":
      schema = { type: "integer" };
      break;
    case "symbol":
      schema = fallback({}, ctx);
      break;
    case "never":
      schema = { not: {} };
      break;
    case "anyobject":
      schema = { type: "object" };
      break;
    case "string":
      schema = emitString(ir);
      break;
    case "number":
      schema = emitNumber(ir);
      break;
    case "lit":
      schema = emitLiteral(ir.v);
      break;
    case "union":
      schema = emitUnion(ir.members, ctx);
      break;
    case "intersection":
      schema = { allOf: ir.members.map((member) => emit(member, ctx)) };
      break;
    case "array":
      schema = { type: "array", items: emit(ir.el, ctx) };
      if (ir.min !== void 0) schema.minItems = ir.min;
      if (ir.max !== void 0) schema.maxItems = ir.max;
      break;
    case "tuple": {
      const prefixItems = ir.prefix.map((item) => {
        const itemSchema = emit(item.val, ctx);
        if (item.hasDefault) {
          itemSchema.default = item.defFactory && typeof item.def === "function" ? item.def() : item.def;
        }
        return itemSchema;
      });
      const required = ir.prefix.reduce(
        (count, item) => count + (item.opt || item.hasDefault ? 0 : 1),
        ir.postfix.length
      );
      schema = { type: "array", prefixItems, minItems: required };
      if (ir.variadic === void 0) {
        schema.items = false;
      } else {
        schema.items = emit(ir.variadic, ctx);
      }
      break;
    }
    case "object":
      schema = emitObject(ir.props, ir.index, ir.extras, ctx);
      break;
    case "instance":
      schema = ir.ctor === Date ? { type: "string", format: "date-time" } : fallback({ type: "object" }, ctx);
      break;
    case "refine":
      schema = emit(ir.base, ctx);
      if (ir.json !== void 0) Object.assign(schema, ir.json);
      break;
    case "morph":
      schema = ctx.options?.io === "input" ? emit(ir.input, ctx) : fallback(emit(ir.out ?? ir.input, ctx), ctx);
      break;
    case "alias": {
      const known = ctx.refs.get(ir.resolve);
      if (known !== void 0) {
        schema = { $ref: `#/$defs/${known}` };
        break;
      }
      let name = ir.name.replace(/[^\w.-]/g, "_");
      while ([...ctx.refs.values()].includes(name)) name = `${name}_`;
      ctx.refs.set(ir.resolve, name);
      ctx.defs.set(name, emit(ir.resolve(), ctx));
      schema = { $ref: `#/$defs/${name}` };
      break;
    }
    case "sub":
      if (ctx.options?.io === "output" && ir.schema.opaqueOutput) {
        schema = {};
      } else if (ctx.options?.io === "output" && ir.schema.stepOut !== void 0) {
        schema = emit(ir.schema.stepOut, ctx);
      } else if (ctx.options?.io === "input") {
        schema = emit(ir.schema.ir, ctx);
      } else {
        schema = ir.schema.hasSteps ? fallback(emit(ir.schema.ir, ctx), ctx) : emit(ir.schema.ir, ctx);
      }
      if (ir.schema.ir.desc !== void 0) schema.description = ir.schema.ir.desc;
      else if (ir.schema.description !== void 0 && ir.descAuto !== true) {
        schema.description = ir.schema.description;
      }
      break;
  }
  if (ir.desc !== void 0 && ir.descAuto !== true) schema.description = ir.desc;
  return schema;
}
function emitString(ir) {
  const schema = { type: "string" };
  if (ir.min !== void 0) schema.minLength = ir.min;
  if (ir.max !== void 0) schema.maxLength = ir.max;
  if (ir.url) schema.format = "uri";
  return schema;
}
function emitNumber(ir) {
  const schema = { type: ir.int ? "integer" : "number" };
  if (ir.min !== void 0) schema[ir.xmin ? "exclusiveMinimum" : "minimum"] = ir.min;
  if (ir.max !== void 0) schema[ir.xmax ? "exclusiveMaximum" : "maximum"] = ir.max;
  if (ir.divisor !== void 0) schema.multipleOf = ir.divisor;
  return schema;
}
function emitLiteral(value) {
  if (value instanceof Date) return { type: "string", format: "date-time", const: value.toISOString() };
  if (isJsonValue(value)) return { const: value };
  switch (typeof value) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "bigint":
      return { type: "integer" };
    case "object":
      return { type: "object" };
    default:
      return {};
  }
}
function emitUnion(members, ctx) {
  const defined = members.filter((member) => member.k !== "undefined");
  if (defined.length === 0) return {};
  if (defined.length === 1) return emit(defined[0], ctx);
  if (defined.every((member) => member.k === "lit" && isJsonValue(member.v))) {
    const values = defined.map((member) => member.v);
    const schema = { enum: values };
    const scalarType = homogeneousScalarType(values);
    if (scalarType !== void 0) schema.type = scalarType;
    return schema;
  }
  return { anyOf: defined.map((member) => emit(member, ctx)) };
}
function homogeneousScalarType(values) {
  const first = jsonScalarType(values[0]);
  if (first === void 0) return void 0;
  for (let i = 1; i < values.length; i++) {
    if (jsonScalarType(values[i]) !== first) return void 0;
  }
  return first;
}
function jsonScalarType(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return typeof value;
    default:
      return void 0;
  }
}
function emitObject(props, index, extras, ctx) {
  const properties = {};
  const required = [];
  const filled = (prop) => !prop.opt && (ctx.options?.io === "output" || !prop.hasDefault);
  const ordered = [...props.filter(filled), ...props.filter((prop) => !filled(prop))];
  for (const prop of ordered) {
    if (typeof prop.key === "symbol") throw new TypeError("Cannot convert a symbol to a string");
    const key = String(prop.key);
    const propertySchema = emit(prop.val, ctx);
    if (prop.hasDefault) {
      propertySchema.default = prop.defFactory ? prop.def() : prop.def;
    }
    properties[key] = propertySchema;
    if (filled(prop)) required.push(key);
  }
  const schema = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  if (index !== void 0) schema.additionalProperties = emit(index, ctx);
  else if (extras === "reject") schema.additionalProperties = false;
  return schema;
}
function isJsonValue(value, seen = /* @__PURE__ */ new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isJsonValue(item, seen)) return false;
    }
    seen.delete(value);
    return true;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const key in value) {
    if (Object.hasOwn(value, key) && !isJsonValue(value[key], seen)) return false;
  }
  seen.delete(value);
  return true;
}

// ../../../omp/packages/omptype/src/type.ts
useAssignability(isSubtype);
var Type = Object.defineProperty(function Type2() {
}, Symbol.hasInstance, {
  value: (value) => (typeof value === "function" || typeof value === "object" && value !== null) && IR_BRAND in value
});
function descriptionOf(ir, seen = /* @__PURE__ */ new Set()) {
  if (ir.desc !== void 0) return ir.desc;
  if (seen.has(ir)) return ir.k === "alias" ? ir.name : expectedOf(ir);
  seen.add(ir);
  if (ir.k === "alias") return descriptionOf(ir.resolve(), seen);
  if (ir.k === "object") {
    return `{ ${ir.props.map((prop) => `${String(prop.key)}${prop.opt ? "?" : ""}: ${descriptionOf(prop.val, seen)}`).join(", ")} }`;
  }
  return expectedOf(ir);
}
function errorConfigOf(config) {
  return {
    ...config.description === void 0 || config.expected !== void 0 ? {} : { expected: config.description },
    ...config.expected === void 0 ? {} : { expected: config.expected },
    ...config.actual === void 0 ? {} : { actual: config.actual },
    ...config.problem === void 0 ? {} : { problem: config.problem },
    ...config.message === void 0 ? {} : { message: config.message }
  };
}
function configureNode(ir, config) {
  return {
    ...ir,
    cfg: { ...ir.cfg, ...errorConfigOf(config) },
    ...config.description === void 0 ? {} : { desc: config.description }
  };
}
function configureSelected(ir, config, selector) {
  const domain = ir.k === "string" || ir.k === "number" || ir.k === "boolean" || ir.k === "bigint" || ir.k === "symbol" ? ir.k : ir.k === "object" || ir.k === "array" || ir.k === "tuple" || ir.k === "instance" || ir.k === "anyobject" ? "object" : void 0;
  const kind = ir.k === "number" && ir.divisor !== void 0 ? "divisor" : "domain";
  if ((selector.kind === void 0 || selector.kind === kind) && (selector.where === void 0 || selector.where({ kind, domain }))) {
    return configureNode(ir, config);
  }
  switch (ir.k) {
    case "array":
      return { ...ir, el: configureSelected(ir.el, config, selector) };
    case "tuple":
      return {
        ...ir,
        prefix: ir.prefix.map((item) => ({ ...item, val: configureSelected(item.val, config, selector) })),
        ...ir.variadic === void 0 ? {} : { variadic: configureSelected(ir.variadic, config, selector) },
        postfix: ir.postfix.map((item) => configureSelected(item, config, selector))
      };
    case "object":
      return {
        ...ir,
        props: ir.props.map((prop) => ({ ...prop, val: configureSelected(prop.val, config, selector) })),
        ...ir.index === void 0 ? {} : { index: configureSelected(ir.index, config, selector) },
        symbolIndex: ir.symbolIndex === void 0 ? void 0 : configureSelected(ir.symbolIndex, config, selector),
        patternIndexes: ir.patternIndexes?.map((index) => ({
          key: configureSelected(index.key, config, selector),
          val: configureSelected(index.val, config, selector)
        }))
      };
    case "union":
    case "intersection":
      return { ...ir, members: ir.members.map((member) => configureSelected(member, config, selector)) };
    case "refine":
      return { ...ir, base: configureSelected(ir.base, config, selector) };
    case "morph":
      return {
        ...ir,
        input: configureSelected(ir.input, config, selector),
        ...ir.out === void 0 ? {} : { out: configureSelected(ir.out, config, selector) }
      };
    default:
      return ir;
  }
}
var Ctx = class {
  expectation;
  errors;
  path;
  #data;
  constructor(data, path = []) {
    this.#data = data;
    this.path = path.map((key) => typeof key === "symbol" ? String(key) : key);
  }
  error(input) {
    const detail = typeof input === "string" ? { expected: input } : input;
    const error = OmpErrors.single([...detail.path ?? detail.relativePath ?? []], detail.expected, this.#data, {
      preserveActual: true,
      ...Object.hasOwn(detail, "actual") ? { actual: String(detail.actual) } : {}
    });
    if (this.errors) this.errors.append(error);
    else this.errors = error;
    return error;
  }
  mustBe(expectation) {
    this.expectation = expectation;
    return false;
  }
  reject(input) {
    if (typeof input === "string") {
      this.expectation = input;
      return false;
    }
    this.error(input);
    return false;
  }
};
var kBase = Symbol("omptype.base");
var kSteps = Symbol("omptype.steps");
var EMPTY_STEPS = [];
var EMPTY_META = {};
var ARK_COMPAT_SCOPE = Object.freeze({ internal: Object.freeze({ name: "ark" }) });
var JIT_THRESHOLD = 3;
function metaOf(schema) {
  return {
    description: schema.description,
    defaultValue: schema.defaultValue,
    hasDefault: schema.hasDefault,
    defaultOutput: schema.defaultOutput,
    hasDefaultOutput: schema.hasDefaultOutput,
    errorConfig: schema.errorConfig,
    clone: schema.clone
  };
}
function inheritScope(source, target) {
  if (source.resolver === void 0) return target;
  target.resolver = source.resolver;
  Reflect.set(target, "$", source.$);
  return target;
}
function invalidDefault(label, errors) {
  const error = errors[0];
  let heading = label;
  for (let index = 0; index < error.path.length; index++) {
    const segment = error.path[index];
    if (typeof segment === "number") {
      if (label === "Default" && index === 0) heading = "Default value";
      heading += ` at [${segment}]`;
    } else if (label === "Default" && index === 0) {
      heading += ` ${String(segment)}`;
    } else {
      heading += `.${String(segment)}`;
    }
  }
  throw new OmpTypeError(`ParseError: ${heading} ${error.problem}`);
}
function rejectMutableStaticDefault(value) {
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    throw new OmpTypeError("ParseError: A mutable default value must be specified as a factory");
  }
}
function normalizeDefaults(ir, seen = /* @__PURE__ */ new WeakSet()) {
  if (seen.has(ir)) return;
  seen.add(ir);
  switch (ir.k) {
    case "object":
      for (const prop of ir.props) {
        normalizeDefaults(prop.val, seen);
        if (!prop.hasDefault || prop.defValidated) continue;
        let candidate;
        let factory = false;
        if (prop.defFactory && typeof prop.def === "function") {
          candidate = prop.def();
          factory = true;
        } else {
          rejectMutableStaticDefault(prop.def);
          candidate = prop.def;
        }
        const output = walk(prop.val, candidate);
        if (output instanceof OmpErrors) invalidDefault(`Default for ${String(prop.key)}`, output);
        if (!factory) prop.def = output;
        prop.defValidated = true;
      }
      if (ir.index) normalizeDefaults(ir.index, seen);
      if (ir.symbolIndex) normalizeDefaults(ir.symbolIndex, seen);
      if (ir.patternIndexes) {
        for (const index of ir.patternIndexes) {
          normalizeDefaults(index.key, seen);
          normalizeDefaults(index.val, seen);
        }
      }
      return;
    case "tuple":
      for (let index = 0; index < ir.prefix.length; index++) {
        const item = ir.prefix[index];
        normalizeDefaults(item.val, seen);
        if (!item.hasDefault || item.defValidated) continue;
        let candidate;
        let factory = false;
        if (item.defFactory && typeof item.def === "function") {
          candidate = item.def();
          factory = true;
        } else {
          rejectMutableStaticDefault(item.def);
          candidate = item.def;
        }
        const output = walk(item.val, candidate);
        if (output instanceof OmpErrors) invalidDefault(`Default for [${index}]`, output);
        if (!factory) item.def = output;
        item.defValidated = true;
      }
      if (ir.variadic) normalizeDefaults(ir.variadic, seen);
      for (const item of ir.postfix) normalizeDefaults(item, seen);
      return;
    case "array":
      normalizeDefaults(ir.el, seen);
      return;
    case "union":
    case "intersection":
      for (const member of ir.members) normalizeDefaults(member, seen);
      return;
    case "refine":
      normalizeDefaults(ir.base, seen);
      return;
    case "morph":
      normalizeDefaults(ir.input, seen);
      if (ir.out) normalizeDefaults(ir.out, seen);
      return;
    default:
      return;
  }
}
var OPAQUE_OUTPUT_IR = { k: "unknown" };
var typeMethods = {
  describe(description) {
    const ir = { ...this.ir, desc: description, cfg: { ...this.ir.cfg, expected: description } };
    return makeType(ir, this[kSteps], { ...metaOf(this), description });
  },
  configure(config, selector = "self") {
    const selected = selector === "self" ? configureNode(this.ir, config) : configureSelected(this.ir, config, selector);
    return makeType(selected, this[kSteps], {
      ...metaOf(this),
      errorConfig: { ...this.errorConfig, ...errorConfigOf(config) },
      ...config.description === void 0 ? {} : { description: config.description }
    });
  },
  default(value) {
    const factory = typeof value === "function";
    if (!factory) rejectMutableStaticDefault(value);
    const candidate = factory ? value() : value;
    const output = this.run(candidate);
    if (output instanceof OmpErrors) invalidDefault("Default", output);
    return makeType(this.ir, this[kSteps], {
      ...metaOf(this),
      defaultValue: value,
      hasDefault: true,
      ...factory ? {} : { defaultOutput: output, hasDefaultOutput: true }
    });
  },
  optional() {
    return [this, "?"];
  },
  or(def) {
    const other = parseDef(def, this.resolver);
    const a = embed(this);
    const members = [...a.k === "union" ? a.members : [a], ...other.k === "union" ? other.members : [other]];
    return inheritScope(this, makeType({ k: "union", members }, [], {}));
  },
  equals(def) {
    return irEquals(embed(this), parseDef(def, this.resolver));
  },
  ifEquals(def) {
    return irEquals(embed(this), parseDef(def, this.resolver)) ? this : void 0;
  },
  ifExtends(def) {
    return isSubtype(embed(this), parseDef(def, this.resolver)) ? this : void 0;
  },
  extends(def) {
    return isSubtype(embed(this), parseDef(def, this.resolver));
  },
  overlaps(def) {
    try {
      intersect(embed(this), parseDef(def, this.resolver));
      return true;
    } catch (error) {
      if (error instanceof OmpTypeError) return false;
      throw error;
    }
  },
  distribute(mapper, reducer) {
    const branches = this.ir.k === "union" ? this.ir.members : [embed(this)];
    const mapped = branches.map((branch) => mapper(makeType(branch, [], {})));
    if (reducer !== void 0) return reducer(mapped);
    const members = mapped.map((branch) => embed(branch));
    return makeType(members.length === 1 ? members[0] : { k: "union", members }, [], {});
  },
  select(kind) {
    return selectNodes(this.ir, kind);
  },
  and(def) {
    return inheritScope(this, makeType(intersect(embed(this), parseDef(def, this.resolver)), [], {}));
  },
  array() {
    return inheritScope(this, makeType({ k: "array", el: embed(this) }, [], {}));
  },
  atLeastLength(bound) {
    return makeType(withLengthBound(this.ir, "min", bound), this[kSteps], metaOf(this));
  },
  atMostLength(bound) {
    return makeType(withLengthBound(this.ir, "max", bound), this[kSteps], metaOf(this));
  },
  moreThanLength(bound) {
    return makeType(withLengthBound(this.ir, "min", bound + 1), this[kSteps], metaOf(this));
  },
  lessThanLength(bound) {
    return makeType(withLengthBound(this.ir, "max", bound - 1), this[kSteps], metaOf(this));
  },
  exactlyLength(bound) {
    const bounded = withLengthBound(withLengthBound(this.ir, "min", bound), "max", bound);
    return makeType(bounded, this[kSteps], metaOf(this));
  },
  atLeast(bound) {
    return makeType(withNumericBound(this.ir, "min", bound), this[kSteps], metaOf(this));
  },
  atMost(bound) {
    return makeType(withNumericBound(this.ir, "max", bound), this[kSteps], metaOf(this));
  },
  moreThan(bound) {
    return makeType(withNumericBound(this.ir, "min", bound, true), this[kSteps], metaOf(this));
  },
  lessThan(bound) {
    return makeType(withNumericBound(this.ir, "max", bound, true), this[kSteps], metaOf(this));
  },
  divisibleBy(divisor) {
    if (this.ir.k !== "number") throw new OmpTypeError(`cannot apply divisibility to ${this.ir.k}`);
    if (!Number.isFinite(divisor) || divisor === 0) throw new OmpTypeError("divisor must be non-zero");
    return makeType({ ...this.ir, divisor }, this[kSteps], metaOf(this));
  },
  positive() {
    return makeType(withNumericBound(this.ir, "min", 0, true), this[kSteps], metaOf(this));
  },
  negative() {
    return makeType(withNumericBound(this.ir, "max", 0, true), this[kSteps], metaOf(this));
  },
  nonNegative() {
    return makeType(withNumericBound(this.ir, "min", 0), this[kSteps], metaOf(this));
  },
  nonPositive() {
    return makeType(withNumericBound(this.ir, "max", 0), this[kSteps], metaOf(this));
  },
  matching(pattern2) {
    return makeType(intersect(this.ir, patternIR(pattern2)), this[kSteps], metaOf(this));
  },
  atOrAfter(bound) {
    const timestamp = bound instanceof Date ? bound.valueOf() : bound;
    return dateRefinement(this, timestamp, "at or after", (value) => value >= timestamp);
  },
  atOrBefore(bound) {
    const timestamp = bound instanceof Date ? bound.valueOf() : bound;
    return dateRefinement(this, timestamp, "at or before", (value) => value <= timestamp);
  },
  laterThan(bound) {
    const timestamp = bound instanceof Date ? bound.valueOf() : bound;
    return dateRefinement(this, timestamp, "later than", (value) => value > timestamp);
  },
  earlierThan(bound) {
    const timestamp = bound instanceof Date ? bound.valueOf() : bound;
    return dateRefinement(this, timestamp, "earlier than", (value) => value < timestamp);
  },
  pipe(...pipes) {
    return appendPipes(this, pipes, false);
  },
  to(def) {
    return appendPipes(this, [makeType(parseDef(def, this.resolver), [], {})], false, true);
  },
  filter(fn) {
    return makeType(this.ir, [{ kind: "filter", fn }, ...this[kSteps]], metaOf(this));
  },
  narrow(fn) {
    return makeType(this.ir, [...this[kSteps], { kind: "narrow", fn }], metaOf(this));
  },
  brand() {
    return this;
  },
  as() {
    return this;
  },
  readonly() {
    return this;
  },
  keyof() {
    return makeType(keyOf(this.ir), [], {});
  },
  get(...path) {
    if (path.length === 0) return this;
    let result = this.ir;
    for (const key of path) result = getPathIR(result, key);
    return makeType(result, [], {});
  },
  pick(...keys) {
    return makeType(selectObjectProps(this.ir, keys, true, "pick"), [], {});
  },
  omit(...keys) {
    return makeType(selectObjectProps(this.ir, keys, false, "omit"), [], {});
  },
  partial() {
    return makeType(setObjectOptionality(this.ir, true, "partial"), [], {});
  },
  required() {
    return makeType(setObjectOptionality(this.ir, false, "required"), [], {});
  },
  map(mapper) {
    const object = requireObject(this.ir, "map");
    const props = object.props.flatMap((prop) => {
      const original = propertyFromIR(prop);
      const mapped = mapper(original);
      return (Array.isArray(mapped) ? mapped : [mapped]).map(
        (property) => propertyToIR(
          property.kind === "required" || property.kind === "optional" ? property : { ...property, kind: original.kind }
        )
      );
    });
    return makeType({ ...object, props }, [], {});
  },
  merge(def) {
    const merged = mergeObjectDefinition(this.ir, def, this.resolver);
    return inheritScope(this, makeType(merged, [], {}));
  },
  extract(def) {
    return inheritScope(this, makeType(distributeFilter(this.ir, parseDef(def, this.resolver), true), [], {}));
  },
  exclude(def) {
    return inheritScope(this, makeType(distributeFilter(this.ir, parseDef(def, this.resolver), false), [], {}));
  },
  onUndeclaredKey(behavior) {
    const extras = behavior === "ignore" ? "keep" : behavior;
    const ir = withShallowExtras(this.ir, extras);
    if (extras === "delete" && ir.k === "union") {
      const objects = ir.members.filter((member) => member.k === "object");
      for (let left = 0; left < objects.length; left++) {
        for (let right = left + 1; right < objects.length; right++) {
          const sharedRequired = objects[left].props.some(
            (leftProp) => !leftProp.opt && objects[right].props.some((rightProp) => !rightProp.opt && rightProp.key === leftProp.key)
          );
          if (!sharedRequired) {
            const leftExpression = expressionOf(objects[left]).replace(/ }$/, ", + (undeclared): delete }");
            const rightExpression = expressionOf(objects[right]).replace(/ }$/, ", + (undeclared): delete }");
            throw new OmpTypeError(
              `ParseError: An unordered union of a type including a morph and a type with overlapping input is indeterminate:
Left: ${leftExpression}
Right: ${rightExpression}`
            );
          }
        }
      }
    }
    return makeType(ir, this[kSteps], metaOf(this));
  },
  onDeepUndeclaredKey(behavior) {
    return makeType(withDeepExtras(this.ir, behavior === "ignore" ? "keep" : behavior), this[kSteps], metaOf(this));
  },
  allows(data) {
    const steps = this[kSteps];
    let needsPredicates = false;
    for (const step of steps) {
      if (step.kind !== "pipe") {
        needsPredicates = true;
        break;
      }
    }
    if (!needsPredicates) {
      const allows = compileAllows(this.ir);
      this.allows = allows;
      return allows(data);
    }
    for (const step of steps) {
      if (step.kind === "filter" && !step.fn(data, new Ctx(data))) return false;
    }
    const out = this[kBase](data);
    if (out instanceof OmpErrors) return false;
    for (const step of steps) {
      if (step.kind === "narrow" && !step.fn(out, new Ctx(out))) return false;
    }
    return true;
  },
  assert(data) {
    const out = this.run(data);
    if (out instanceof OmpErrors) throw new TraversalError(out);
    return out;
  },
  from(data) {
    const out = this.run(data);
    if (out instanceof OmpErrors) throw new TraversalError(out);
    return out;
  },
  toJsonSchema(options) {
    const ir = options?.io === "output" ? this.opaqueOutput ? OPAQUE_OUTPUT_IR : this.stepOut ?? this.ir : this.ir;
    const description = options?.description ?? this.ir.desc;
    if (description === void 0) return irToJsonSchema(ir, options);
    return irToJsonSchema(ir, { ...options, description });
  }
};
Object.defineProperty(typeMethods, "expression", {
  get() {
    const input = expressionOf(this.ir);
    if (!this.hasSteps) return input;
    if (this.opaqueOutput) return `(In: ${input}) => Out<unknown>`;
    return `(In: ${input}) => To<${expressionOf(this.stepOut ?? this.ir)}>`;
  }
});
Object.defineProperty(typeMethods, "json", {
  get() {
    return arkJsonOf(this.ir);
  }
});
Object.defineProperty(typeMethods, "props", {
  get() {
    const object = requireObject(this.ir, "props");
    return object.props.map((prop) => propertyFromIR(prop));
  }
});
Object.defineProperty(typeMethods, "~standard", {
  get() {
    const jsonSchema = (io, options) => {
      if (options.target !== "draft-2020-12" && options.target !== "draft-07") {
        throw new OmpTypeError(
          `JSONSchema target '${options.target}' is not supported (must be "draft-2020-12" or "draft-07")`
        );
      }
      return this.toJsonSchema({ ...options.libraryOptions, target: options.target, io });
    };
    return {
      version: 1,
      vendor: "omptype",
      validate: (value) => {
        const out = this.run(value);
        return out instanceof OmpErrors ? { issues: out } : { value: out };
      },
      jsonSchema: {
        input: (options) => jsonSchema("input", options),
        output: (options) => jsonSchema("output", options)
      }
    };
  }
});
Object.defineProperty(typeMethods, "in", {
  get() {
    return makeType(projectIO(this.ir, "in"), [], {});
  }
});
Object.defineProperty(typeMethods, "out", {
  get() {
    if (this.opaqueOutput) return makeType({ k: "unknown" }, [], {});
    return makeType(projectIO(this.stepOut ?? this.ir, "out"), [], {});
  }
});
var allowsMethod = typeMethods.allows;
var assertMethod = typeMethods.assert;
var fromMethod = typeMethods.from;
Object.defineProperties(typeMethods, {
  description: {
    get() {
      return descriptionOf(this.ir);
    }
  },
  allows: {
    get() {
      const allows = (data) => allowsMethod.call(this, data);
      Object.defineProperty(this, "allows", { value: allows, writable: true });
      return allows;
    }
  },
  assert: {
    get() {
      const assert = assertMethod.bind(this);
      Object.defineProperty(this, "assert", { value: assert });
      return assert;
    }
  },
  from: {
    get() {
      const from = fromMethod.bind(this);
      Object.defineProperty(this, "from", { value: from });
      return from;
    }
  },
  pipe: {
    get() {
      const pipe = Object.assign((...pipes) => appendPipes(this, pipes, false), {
        try: (...pipes) => appendPipes(this, pipes, true)
      });
      Object.defineProperty(this, "pipe", { value: pipe });
      return pipe;
    }
  }
});
Object.setPrototypeOf(typeMethods, Function.prototype);
Object.defineProperty(typeMethods, "bind", { value: void 0 });
function makeType(ir, steps, meta) {
  let morph2 = false;
  if (!isSimpleIR(ir)) {
    ir = normalizeIR(ir);
    morph2 = hasMorph(ir);
    if (morph2) {
      normalizeDefaults(ir);
      assertDeterminateMorphUnions(ir);
    }
  }
  let calls = 0;
  let impl = (data) => {
    if (++calls >= JIT_THRESHOLD) {
      impl = compile(ir);
      return impl(data);
    }
    return walk(ir, data);
  };
  const base = (data) => impl(data);
  const errorConfig = meta.errorConfig ?? ir.cfg;
  const filterInput = steps.some((step) => step.kind === "filter") ? projectIO(ir, "in") : void 0;
  const validate = steps.length === 0 ? base : (data, contextPath = []) => {
    if (filterInput !== void 0) {
      const inputResult = walk(filterInput, data);
      if (inputResult instanceof OmpErrors) return inputResult;
    }
    for (const step of steps) {
      if (step.kind !== "filter") continue;
      const ctx = new Ctx(data, contextPath);
      const result = step.fn(data, ctx);
      if (result instanceof OmpErrors)
        return errorConfig === void 0 ? result : result.configure(errorConfig);
      if (ctx.errors) return errorConfig === void 0 ? ctx.errors : ctx.errors.configure(errorConfig);
      if (!result) {
        return OmpErrors.single(
          [],
          ctx.expectation ?? (step.fn.name ? `valid according to ${step.fn.name}` : "valid (input predicate failed)"),
          data,
          errorConfig
        );
      }
    }
    let out = base(data);
    if (out instanceof OmpErrors) return out;
    for (const step of steps) {
      if (step.kind === "filter") continue;
      const ctx = new Ctx(out, contextPath);
      if (step.kind === "narrow") {
        const result = step.fn(out, ctx);
        if (result instanceof OmpErrors) {
          return errorConfig === void 0 ? result : result.configure(errorConfig);
        }
        if (ctx.errors) return errorConfig === void 0 ? ctx.errors : ctx.errors.configure(errorConfig);
        if (!result) {
          return OmpErrors.single(
            [],
            ctx.expectation ?? (step.fn.name ? `valid according to ${step.fn.name}` : "valid (narrow predicate failed)"),
            out,
            errorConfig
          );
        }
      } else {
        try {
          out = step.fn(out, ctx);
        } catch (error) {
          if (!step.try) throw error;
          const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          return OmpErrors.single([], `valid (morph threw ${detail})`, out, errorConfig);
        }
        if (out instanceof OmpErrors) {
          return errorConfig === void 0 ? out : out.configure(errorConfig);
        }
      }
    }
    return out;
  };
  const needsClone = morph2 || steps.some((step) => step.kind === "pipe");
  const clone = meta.clone;
  let callable = validate;
  if (needsClone && clone !== void 0) {
    if (clone === false) {
      callable = (data, path) => {
        const out = validate(data, path);
        if (out instanceof OmpErrors || out === data || typeof data !== "object" || data === null || typeof out !== "object" || out === null) {
          return out;
        }
        if (Array.isArray(data) && Array.isArray(out)) {
          data.splice(0, data.length, ...out);
        } else {
          const target = data;
          const source = out;
          for (const key of Reflect.ownKeys(target)) {
            if (!Object.hasOwn(source, key)) Reflect.deleteProperty(target, key);
          }
          for (const key of Reflect.ownKeys(source)) target[key] = source[key];
        }
        return data;
      };
    } else {
      callable = (data, path) => validate(clone(data), path);
    }
  }
  if (meta.hasDefault === true) {
    const inner = callable;
    const value = meta.defaultValue;
    callable = (data, path) => {
      if (data !== void 0) return inner(data, path);
      if (meta.hasDefaultOutput === true) return meta.defaultOutput;
      return inner(typeof value === "function" ? value() : value, path);
    };
  }
  const self = callable;
  self[IR_BRAND] = true;
  self[kBase] = base;
  self[kSteps] = steps;
  self.ir = ir;
  self.hasSteps = steps.length > 0;
  self.hasDefault = meta.hasDefault === true;
  self.defaultValue = meta.defaultValue;
  self.defaultOutput = meta.defaultOutput;
  self.hasDefaultOutput = meta.hasDefaultOutput === true;
  self.errorConfig = meta.errorConfig ?? ir.cfg;
  self.clone = meta.clone;
  self.run = callable;
  self.$ = ARK_COMPAT_SCOPE;
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.kind !== "pipe") continue;
    self.stepOut = step.out;
    self.opaqueOutput = step.out === void 0;
    break;
  }
  Object.setPrototypeOf(self, typeMethods);
  return self;
}
function appendPipes(source, pipes, catchErrors, forcePipeline = false) {
  let schema = source;
  for (const candidate of pipes) {
    const isSchema = (typeof candidate === "function" || typeof candidate === "object" && candidate !== null) && IR_BRAND in candidate;
    if (isSchema) {
      const target = candidate;
      if (!forcePipeline && schema[kSteps].length === 0 && !target.hasSteps && !hasMorph(schema.ir) && !hasMorph(target.ir)) {
        schema = makeType(intersect(schema.ir, target.ir), [], metaOf(schema));
        continue;
      }
      const out = target.opaqueOutput ? void 0 : target.stepOut ?? target.ir;
      schema = makeType(
        schema.ir,
        [...schema[kSteps], { kind: "pipe", fn: (value) => target.run(value), out, try: catchErrors }],
        metaOf(schema)
      );
      continue;
    }
    if (typeof candidate !== "function") throw new OmpTypeError("pipe operands must be functions or Types");
    schema = makeType(
      schema.ir,
      [...schema[kSteps], { kind: "pipe", fn: candidate, try: catchErrors }],
      metaOf(schema)
    );
  }
  return inheritScope(source, schema);
}
function projectIO(ir, io) {
  switch (ir.k) {
    case "morph":
      return projectIO(io === "in" || ir.out === void 0 ? ir.input : ir.out, io);
    case "sub":
      if (io === "out" && ir.schema.opaqueOutput) return { k: "unknown" };
      return projectIO(io === "out" ? ir.schema.stepOut ?? ir.schema.ir : ir.schema.ir, io);
    case "array":
      return { ...ir, el: projectIO(ir.el, io) };
    case "tuple":
      return {
        ...ir,
        prefix: ir.prefix.map((item) => ({
          ...item,
          opt: io === "in" ? item.opt || item.hasDefault === true : item.opt && !item.hasDefault,
          val: projectIO(item.val, io),
          hasDefault: false,
          def: void 0,
          defFactory: false,
          defValidated: false
        })),
        variadic: ir.variadic === void 0 ? void 0 : projectIO(ir.variadic, io),
        postfix: ir.postfix.map((item) => projectIO(item, io))
      };
    case "object":
      return {
        ...ir,
        props: ir.props.map((prop) => ({
          ...prop,
          opt: io === "in" ? prop.opt || prop.hasDefault === true : prop.opt && !prop.hasDefault,
          val: projectIO(prop.val, io),
          hasDefault: false,
          def: void 0,
          defFactory: false,
          defValidated: false
        })),
        index: ir.index === void 0 ? void 0 : projectIO(ir.index, io),
        symbolIndex: ir.symbolIndex === void 0 ? void 0 : projectIO(ir.symbolIndex, io),
        patternIndexes: ir.patternIndexes?.map((index) => ({
          key: projectIO(index.key, io),
          val: projectIO(index.val, io)
        })),
        extras: ir.extras === "delete" ? io === "in" ? "keep" : "reject" : ir.extras
      };
    case "union":
    case "intersection":
      return { ...ir, members: ir.members.map((member) => projectIO(member, io)) };
    case "refine":
      return { ...ir, base: projectIO(ir.base, io) };
    case "alias":
      return { ...ir, resolve: () => projectIO(ir.resolve(), io) };
    default:
      return ir;
  }
}
function morphIdentities(ir, identities = [], seen = /* @__PURE__ */ new Set()) {
  if (seen.has(ir)) return identities;
  seen.add(ir);
  switch (ir.k) {
    case "morph":
      identities.push(
        ir.out === void 0 ? ir.fn : `declared:${expressionOf(projectIO(ir.input, "in"))}=>${expressionOf(projectIO(ir.out, "out"))}`
      );
      morphIdentities(ir.input, identities, seen);
      if (ir.out !== void 0) morphIdentities(ir.out, identities, seen);
      break;
    case "sub": {
      const schema = ir.schema;
      for (const step of schema[kSteps]) if (step.kind === "pipe") identities.push(step.fn);
      morphIdentities(schema.ir, identities, seen);
      break;
    }
    case "array":
      morphIdentities(ir.el, identities, seen);
      break;
    case "tuple":
      for (const item of ir.prefix) morphIdentities(item.val, identities, seen);
      if (ir.variadic !== void 0) morphIdentities(ir.variadic, identities, seen);
      for (const item of ir.postfix) morphIdentities(item, identities, seen);
      break;
    case "object":
      if (ir.extras === "delete") identities.push(ir);
      for (const prop of ir.props) morphIdentities(prop.val, identities, seen);
      if (ir.index !== void 0) morphIdentities(ir.index, identities, seen);
      if (ir.symbolIndex !== void 0) morphIdentities(ir.symbolIndex, identities, seen);
      for (const index of ir.patternIndexes ?? []) morphIdentities(index.val, identities, seen);
      break;
    case "union":
    case "intersection":
      for (const member of ir.members) morphIdentities(member, identities, seen);
      break;
    case "refine":
      morphIdentities(ir.base, identities, seen);
      break;
    case "alias":
      morphIdentities(ir.resolve(), identities, seen);
      break;
  }
  return identities;
}
function assertDeterminateMorphUnions(ir, seen = /* @__PURE__ */ new Set()) {
  if (seen.has(ir)) return;
  seen.add(ir);
  if (ir.k === "union") {
    for (let leftIndex = 0; leftIndex < ir.members.length; leftIndex++) {
      const left = ir.members[leftIndex];
      const leftMorphs = morphIdentities(left);
      for (let rightIndex = leftIndex + 1; rightIndex < ir.members.length; rightIndex++) {
        const right = ir.members[rightIndex];
        const rightMorphs = morphIdentities(right);
        if (leftMorphs.length === 0 && rightMorphs.length === 0) continue;
        if (leftMorphs.length === rightMorphs.length && leftMorphs.every((identity, index) => identity === rightMorphs[index])) {
          continue;
        }
        let leftInput = projectIO(left, "in");
        let rightInput = projectIO(right, "in");
        if (leftInput.k === "alias") leftInput = leftInput.resolve();
        if (rightInput.k === "alias") rightInput = rightInput.resolve();
        if (leftInput.k === "object" && rightInput.k === "object") {
          const leftKeys = new Set(leftInput.props.map((prop) => prop.key));
          const rightKeys = new Set(rightInput.props.map((prop) => prop.key));
          const leftRejectsRequiredRight = leftInput.extras === "reject" && rightInput.props.some((prop) => !prop.opt && !prop.hasDefault && !leftKeys.has(prop.key));
          const rightRejectsRequiredLeft = rightInput.extras === "reject" && leftInput.props.some((prop) => !prop.opt && !prop.hasDefault && !rightKeys.has(prop.key));
          if (leftRejectsRequiredRight || rightRejectsRequiredLeft) continue;
        }
        try {
          intersect(leftInput, rightInput);
        } catch (error) {
          if (error instanceof OmpTypeError) continue;
          throw error;
        }
        throw new OmpTypeError("an unordered union with overlapping morph inputs is indeterminate");
      }
    }
  }
  switch (ir.k) {
    case "alias":
      assertDeterminateMorphUnions(ir.resolve(), seen);
      break;
    case "morph":
      assertDeterminateMorphUnions(ir.input, seen);
      if (ir.out !== void 0) assertDeterminateMorphUnions(ir.out, seen);
      break;
    case "sub":
      assertDeterminateMorphUnions(ir.schema.ir, seen);
      break;
    case "array":
      assertDeterminateMorphUnions(ir.el, seen);
      break;
    case "tuple":
      for (const item of ir.prefix) assertDeterminateMorphUnions(item.val, seen);
      if (ir.variadic !== void 0) assertDeterminateMorphUnions(ir.variadic, seen);
      for (const item of ir.postfix) assertDeterminateMorphUnions(item, seen);
      break;
    case "object":
      for (const prop of ir.props) assertDeterminateMorphUnions(prop.val, seen);
      if (ir.index !== void 0) assertDeterminateMorphUnions(ir.index, seen);
      if (ir.symbolIndex !== void 0) assertDeterminateMorphUnions(ir.symbolIndex, seen);
      for (const index of ir.patternIndexes ?? []) assertDeterminateMorphUnions(index.val, seen);
      break;
    case "union":
    case "intersection":
      for (const member of ir.members) assertDeterminateMorphUnions(member, seen);
      break;
    case "refine":
      assertDeterminateMorphUnions(ir.base, seen);
      break;
  }
}
function getPathIR(ir, requestedKey) {
  let key = requestedKey;
  if ((typeof key === "function" || typeof key === "object" && key !== null) && IR_BRAND in key) {
    const keySchema = key;
    if (keySchema.ir.k === "symbol") key = Symbol.for("omptype.index");
    else {
      const arrayIndex = type.arrayIndex;
      if (keySchema === arrayIndex) key = 0;
      else {
        throw new OmpTypeError(
          `${keySchema.expression} is not allowed as an array or object index; use a concrete property key`
        );
      }
    }
  }
  if (typeof key !== "string" && typeof key !== "number" && typeof key !== "symbol") {
    throw new OmpTypeError(`get keys must be strings, numbers, or symbols`);
  }
  if (ir.k === "alias") return getPathIR(ir.resolve(), key);
  if (ir.k === "sub") return getPathIR(ir.schema.ir, key);
  if (ir.k === "union") {
    return unionOf(ir.members.map((member) => getPathIR(member, key)));
  }
  if (ir.k === "array") {
    const index = typeof key === "number" ? key : typeof key === "string" && /^\d+$/.test(key) ? Number(key) : -1;
    if (!Number.isSafeInteger(index) || index < 0) throw new OmpTypeError(`key ${String(key)} is not declared`);
    return unionOf([ir.el, { k: "undefined" }]);
  }
  if (ir.k === "tuple") {
    const index = typeof key === "number" ? key : typeof key === "string" && /^\d+$/.test(key) ? Number(key) : -1;
    if (!Number.isSafeInteger(index) || index < 0) throw new OmpTypeError(`key ${String(key)} is not declared`);
    if (index < ir.prefix.length) {
      const item = ir.prefix[index];
      return item.opt ? unionOf([{ k: "undefined" }, item.val]) : item.val;
    }
    if (ir.variadic === void 0) throw new OmpTypeError(`key ${String(key)} is not declared`);
    return unionOf([{ k: "undefined" }, ir.variadic, ...ir.postfix]);
  }
  if (ir.k === "undefined") return ir;
  if (ir.k !== "object") throw new OmpTypeError("get requires an object schema");
  const matches = [];
  const prop = ir.props.find((candidate) => candidate.key === String(key));
  if (prop !== void 0) matches.push(prop.val);
  if (typeof key === "string") {
    if (ir.index !== void 0) matches.push(ir.index);
    for (const index of ir.patternIndexes ?? []) {
      if (!(walk(index.key, key) instanceof OmpErrors)) matches.push(index.val);
    }
  } else if (typeof key === "symbol" && ir.symbolIndex !== void 0) {
    matches.push(ir.symbolIndex);
  }
  if (matches.length === 0) throw new OmpTypeError(`key ${String(key)} is not declared`);
  const value = matches.reduce((left, right) => intersect(left, right));
  return prop !== void 0 && !prop.opt ? value : unionOf([value, { k: "undefined" }]);
}
function unionOf(members) {
  const flattened = members.flatMap((member) => member.k === "union" ? member.members : [member]);
  return flattened.length === 1 ? flattened[0] : { k: "union", members: flattened };
}
function expressionOf(ir, ancestors = /* @__PURE__ */ new Set()) {
  if (ancestors.has(ir)) return ir.k === "alias" ? ir.name : ir.k;
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(ir);
  const child = (node) => expressionOf(node, nextAncestors);
  switch (ir.k) {
    case "alias":
      return child(ir.resolve());
    case "sub":
      return child(ir.schema.ir);
    case "unknown":
    case "null":
    case "undefined":
    case "boolean":
    case "bigint":
    case "symbol":
    case "never":
      return ir.k;
    case "anyobject":
      return "object";
    case "string":
      return "string";
    case "number":
      return ir.divisor !== void 0 ? `number % ${ir.divisor}` : ir.int ? "number % 1" : "number";
    case "lit":
      return typeof ir.v === "string" ? JSON.stringify(ir.v) : String(ir.v);
    case "array": {
      const element = child(ir.el);
      return `${ir.el.k === "union" || ir.el.k === "intersection" ? `(${element})` : element}[]`;
    }
    case "tuple": {
      const items = ir.prefix.map((item) => {
        const value = child(item.val);
        if (item.hasDefault) return `${value} = ${child({ k: "lit", v: item.def })}`;
        return `${value}${item.opt ? "?" : ""}`;
      });
      if (ir.variadic !== void 0) items.push(`...${child(ir.variadic)}[]`);
      items.push(...ir.postfix.map(child));
      return `[${items.join(", ")}]`;
    }
    case "object": {
      const properties = ir.props.map((prop) => `${String(prop.key)}${prop.opt ? "?" : ""}: ${child(prop.val)}`);
      if (ir.index !== void 0) properties.unshift(`[string]: ${child(ir.index)}`);
      if (ir.symbolIndex !== void 0) properties.unshift(`[symbol]: ${child(ir.symbolIndex)}`);
      return `{ ${properties.join(", ")} }`;
    }
    case "union":
      return [...new Set(ir.members.map(child))].join(" | ");
    case "intersection":
      return ir.members.map(child).join(" & ");
    case "refine":
      return child(ir.base);
    case "morph":
      return `(In: ${child(ir.input)}) => Out<${child(ir.out ?? { k: "unknown" })}>`;
    case "instance":
      return ir.ctor.name || "object";
  }
}
function arkJsonOf(ir, ancestors = /* @__PURE__ */ new Set()) {
  if (ancestors.has(ir)) return ir.k === "alias" ? { alias: ir.name } : { cyclic: ir.k };
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(ir);
  const child = (node) => arkJsonOf(node, nextAncestors);
  switch (ir.k) {
    case "alias":
      return child(ir.resolve());
    case "sub":
      return child(ir.schema.ir);
    case "lit":
      return {
        unit: ir.v === void 0 ? "undefined" : typeof ir.v === "bigint" ? `${ir.v}n` : ir.v
      };
    case "null":
      return { unit: null };
    case "undefined":
      return { unit: "undefined" };
    case "boolean":
      return [{ unit: false }, { unit: true }];
    case "union":
    case "intersection":
      return ir.members.map(child);
    case "array":
      return { proto: "Array", sequence: child(ir.el) };
    case "tuple":
      return {
        proto: "Array",
        sequence: {
          prefix: ir.prefix.map((item) => child(item.val)),
          ...ir.variadic === void 0 ? {} : { variadic: child(ir.variadic) },
          ...ir.postfix.length === 0 ? {} : { postfix: ir.postfix.map(child) }
        }
      };
    case "object":
      return {
        domain: "object",
        required: ir.props.filter((prop) => !prop.opt && !prop.hasDefault).map((prop) => ({ key: prop.key, value: child(prop.val) })),
        optional: ir.props.filter((prop) => prop.opt || prop.hasDefault).map((prop) => ({
          key: prop.key,
          value: child(prop.val),
          ...prop.hasDefault ? {
            default: prop.defFactory && typeof prop.def === "function" ? `$ark.${prop.def.name || "default"}` : prop.def
          } : {}
        }))
      };
    case "refine":
      return child(ir.base);
    case "morph":
      return { in: child(ir.input), ...ir.out === void 0 ? {} : { declaredOut: child(ir.out) } };
    case "instance":
      return { proto: ir.ctor.name };
    case "anyobject":
      return { domain: "object" };
    default:
      return ir.k;
  }
}
function requireObject(ir, operation) {
  if (ir.k !== "object") throw new OmpTypeError(`${operation} requires an object schema`);
  return ir;
}
function selectObjectProps(ir, keys, keepSelected, operation) {
  const object = requireObject(ir, operation);
  const selected = new Set(keys);
  for (const key of selected) {
    if (!object.props.some((prop) => prop.key === key)) throw new OmpTypeError(`key ${String(key)} does not exist`);
  }
  return { ...object, props: object.props.filter((prop) => selected.has(prop.key) === keepSelected) };
}
function setObjectOptionality(ir, optional, operation) {
  const object = requireObject(ir, operation);
  return { ...object, props: object.props.map((prop) => ({ ...prop, opt: optional })) };
}
function mergeObjectDefinition(ir, definition, resolve2) {
  return mergeObjects(requireObject(ir, "merge"), requireObject(parseDef(definition, resolve2), "merge"));
}
function propertyFromIR(prop) {
  return {
    kind: prop.opt ? "optional" : "required",
    key: prop.key,
    value: makeType(prop.val, [], {}),
    ...prop.hasDefault ? { default: prop.def } : {},
    meta: {}
  };
}
function propertyToIR(property) {
  if (property.kind !== "required" && property.kind !== "optional") {
    throw new OmpTypeError(`mapped property ${String(property.key)} has invalid kind`);
  }
  if (!(IR_BRAND in property.value)) {
    throw new OmpTypeError(`mapped property ${String(property.key)} must contain a schema value`);
  }
  const hasDefault = Object.hasOwn(property, "default");
  return {
    key: property.key,
    opt: property.kind === "optional",
    val: embed(property.value),
    ...hasDefault ? { def: property.default, defFactory: typeof property.default === "function", hasDefault: true } : {}
  };
}
function acceptsDateIR(ir) {
  if (ir.k === "instance") return ir.ctor === Date;
  if (ir.k === "refine") return acceptsDateIR(ir.base);
  if (ir.k === "union") return ir.members.every(acceptsDateIR);
  return false;
}
function dateRefinement(schema, timestamp, relation, predicate) {
  if (!Number.isFinite(timestamp)) throw new OmpTypeError("date bound must be valid");
  if (!acceptsDateIR(schema.ir)) throw new OmpTypeError("date bounds require a Date type");
  const bound = new Date(timestamp);
  return makeType(
    {
      k: "refine",
      base: schema.ir,
      pred: (value) => value instanceof Date && predicate(value.valueOf()),
      expected: `a Date ${relation} ${bound.toISOString()}`,
      json: relation.includes("after") ? { minimum: bound.toISOString() } : { maximum: bound.toISOString() }
    },
    schema[kSteps],
    metaOf(schema)
  );
}
function selectNodes(root, kind) {
  const selected = [];
  const seen = /* @__PURE__ */ new Set();
  const visit2 = (node) => {
    if (seen.has(node)) return;
    seen.add(node);
    const nodeKind = node.k === "lit" ? "unit" : node.k;
    if (kind === nodeKind || kind === node.k) {
      selected.push(node.k === "lit" ? { kind: nodeKind, node, unit: node.v } : { kind: nodeKind, node });
    }
    switch (node.k) {
      case "alias":
        visit2(node.resolve());
        break;
      case "array":
        visit2(node.el);
        break;
      case "tuple":
        for (const item of node.prefix) visit2(item.val);
        if (node.variadic !== void 0) visit2(node.variadic);
        for (const item of node.postfix) visit2(item);
        break;
      case "object":
        for (const prop of node.props) visit2(prop.val);
        if (node.index !== void 0) visit2(node.index);
        if (node.symbolIndex !== void 0) visit2(node.symbolIndex);
        for (const index of node.patternIndexes ?? []) {
          visit2(index.key);
          visit2(index.val);
        }
        break;
      case "union":
      case "intersection":
        for (const member of node.members) visit2(member);
        break;
      case "refine":
        visit2(node.base);
        break;
      case "morph":
        visit2(node.input);
        if (node.out !== void 0) visit2(node.out);
        break;
      case "sub":
        visit2(node.schema.ir);
        break;
    }
  };
  visit2(root);
  return selected;
}
function mergeObjects(left, right) {
  const props = [...left.props];
  for (const prop of right.props) {
    const index = props.findIndex((candidate) => candidate.key === prop.key);
    if (index < 0) props.push(prop);
    else props[index] = prop;
  }
  return {
    k: "object",
    props,
    index: right.index ?? left.index,
    symbolIndex: right.symbolIndex ?? left.symbolIndex,
    patternIndexes: left.patternIndexes === void 0 && right.patternIndexes === void 0 ? void 0 : [...left.patternIndexes ?? [], ...right.patternIndexes ?? []],
    extras: right.extras === "keep" ? left.extras : right.extras
  };
}
function withShallowExtras(ir, extras) {
  if (ir.k === "object") return { ...ir, extras };
  if (ir.k === "union") return { ...ir, members: ir.members.map((member) => withShallowExtras(member, extras)) };
  if (ir.k === "alias") return withShallowExtras(ir.resolve(), extras);
  throw new OmpTypeError("onUndeclaredKey requires an object schema");
}
function withDeepExtras(ir, extras) {
  switch (ir.k) {
    case "object":
      return {
        ...ir,
        extras,
        props: ir.props.map((prop) => ({ ...prop, val: withDeepExtras(prop.val, extras) })),
        index: ir.index === void 0 ? void 0 : withDeepExtras(ir.index, extras),
        symbolIndex: ir.symbolIndex === void 0 ? void 0 : withDeepExtras(ir.symbolIndex, extras),
        patternIndexes: ir.patternIndexes?.map((index) => ({
          key: withDeepExtras(index.key, extras),
          val: withDeepExtras(index.val, extras)
        }))
      };
    case "array":
      return { ...ir, el: withDeepExtras(ir.el, extras) };
    case "tuple":
      return {
        ...ir,
        prefix: ir.prefix.map((item) => ({ ...item, val: withDeepExtras(item.val, extras) })),
        variadic: ir.variadic === void 0 ? void 0 : withDeepExtras(ir.variadic, extras),
        postfix: ir.postfix.map((item) => withDeepExtras(item, extras))
      };
    case "union":
    case "intersection":
      return { ...ir, members: ir.members.map((member) => withDeepExtras(member, extras)) };
    case "refine":
      return { ...ir, base: withDeepExtras(ir.base, extras) };
    case "morph":
      return {
        ...ir,
        input: withDeepExtras(ir.input, extras),
        out: ir.out === void 0 ? void 0 : withDeepExtras(ir.out, extras)
      };
    default:
      return ir;
  }
}
function intersectTupleWithArray(tuple, array) {
  if (array.min !== void 0 || array.max !== void 0) {
    return { k: "intersection", members: [tuple, array] };
  }
  return {
    ...tuple,
    prefix: tuple.prefix.map((item) => ({ ...item, val: intersect(item.val, array.el) })),
    variadic: tuple.variadic === void 0 ? void 0 : intersect(tuple.variadic, array.el),
    postfix: tuple.postfix.map((item) => intersect(item, array.el))
  };
}
function intersectTuples(left, right) {
  if (left.postfix.length !== 0 || right.postfix.length !== 0 || left.prefix.some((item) => item.hasDefault) || right.prefix.some((item) => item.hasDefault)) {
    return { k: "intersection", members: [left, right] };
  }
  const leftRequired = left.prefix.filter((item) => !item.opt).length;
  const rightRequired = right.prefix.filter((item) => !item.opt).length;
  const minimum = Math.max(leftRequired, rightRequired);
  const leftMaximum = left.variadic === void 0 ? left.prefix.length : Number.POSITIVE_INFINITY;
  const rightMaximum = right.variadic === void 0 ? right.prefix.length : Number.POSITIVE_INFINITY;
  const maximum = Math.min(leftMaximum, rightMaximum);
  if (minimum > maximum) throw new OmpTypeError("tuple length intersection is unsatisfiable");
  const prefixLength = Number.isFinite(maximum) ? maximum : Math.max(left.prefix.length, right.prefix.length);
  const prefix = [];
  for (let index = 0; index < prefixLength; index++) {
    const leftItem = left.prefix[index];
    const rightItem = right.prefix[index];
    const leftNode = leftItem?.val ?? left.variadic;
    const rightNode = rightItem?.val ?? right.variadic;
    if (leftNode === void 0 || rightNode === void 0) break;
    const required = leftItem !== void 0 && !leftItem.opt || rightItem !== void 0 && !rightItem.opt;
    try {
      prefix.push({ val: intersect(leftNode, rightNode), opt: !required });
    } catch (error) {
      if (required || !(error instanceof OmpTypeError)) throw error;
      break;
    }
  }
  const variadic = leftMaximum === Number.POSITIVE_INFINITY && rightMaximum === Number.POSITIVE_INFINITY ? intersect(left.variadic, right.variadic) : void 0;
  return { k: "tuple", prefix, variadic, postfix: [] };
}
var kIntersections = Symbol("omptype.intersections");
function intersect(a, b) {
  if (a.k === "alias" || b.k === "alias") {
    const target = a;
    target[kIntersections] ??= /* @__PURE__ */ new WeakMap();
    const cache = target[kIntersections];
    const existing = cache.get(b);
    if (existing !== void 0) return existing;
    let resolved;
    const reference = {
      k: "alias",
      name: a.k === "alias" ? a.name : b.k === "alias" ? b.name : "intersection",
      resolve: () => resolved ??= intersectResolved(a.k === "alias" ? a.resolve() : a, b.k === "alias" ? b.resolve() : b)
    };
    cache.set(b, reference);
    return reference;
  }
  return intersectResolved(a, b);
}
function intersectResolved(a, b) {
  if (a.k === "never" || b.k === "never") throw new OmpTypeError("intersection with never is unsatisfiable");
  if (a.k === "unknown") return b;
  if (b.k === "unknown") return a;
  if (a === b) return a;
  if (a.k === "morph" && b.k === "morph") {
    if (a.fn !== b.fn || a.out !== b.out) {
      throw new OmpTypeError("intersection of distinct morphs is indeterminate");
    }
    return { ...a, input: intersect(a.input, b.input) };
  }
  if (a.k === "morph") return { ...a, input: intersect(a.input, b) };
  if (b.k === "morph") return { ...b, input: intersect(a, b.input) };
  if (a.k === "sub" && a.schema.hasSteps) {
    if (b.k === "sub" && b.schema.hasSteps) {
      if (a.schema === b.schema) return a;
      throw new OmpTypeError("intersection of distinct morphs is indeterminate");
    }
    const schema = a.schema;
    return embed(makeType(intersect(schema.ir, b), schema[kSteps], metaOf(schema)));
  }
  if (b.k === "sub" && b.schema.hasSteps) return intersect(b, a);
  if (a.k === "union" || b.k === "union") {
    const union = a.k === "union" ? a : b.k === "union" ? b : void 0;
    if (union === void 0) throw new OmpTypeError("union intersection invariant failed");
    const branches = union.members;
    const other = a.k === "union" ? b : a;
    const members2 = [];
    for (const branch of branches) {
      try {
        members2.push(intersect(branch, other));
      } catch (error) {
        if (!(error instanceof OmpTypeError)) throw error;
      }
    }
    if (members2.length === 0) throw new OmpTypeError("intersection has no satisfiable branches");
    return members2.length === 1 ? members2[0] : { k: "union", members: members2 };
  }
  if (a.k === "lit") {
    if (walk(b, a.v) instanceof OmpErrors) throw new OmpTypeError("literal is excluded by the intersection");
    return a;
  }
  if (b.k === "lit") return intersect(b, a);
  if (a.k === "object" && b.k === "object") {
    const props = [...a.props];
    for (const bp of b.props) {
      const index2 = props.findIndex((prop) => prop.key === bp.key);
      if (index2 < 0) props.push(bp);
      else {
        const ap = props[index2];
        const required = !ap.opt && !ap.hasDefault || !bp.opt && !bp.hasDefault;
        if (ap.hasDefault && bp.hasDefault && !Object.is(ap.def, bp.def)) {
          throw new OmpTypeError(
            `ParseError: Invalid intersection of default values ${String(ap.def)} & ${String(bp.def)}`
          );
        }
        const defaulted = required ? void 0 : ap.hasDefault ? ap : bp.hasDefault ? bp : void 0;
        props[index2] = {
          key: ap.key,
          opt: ap.opt && bp.opt,
          val: intersect(ap.val, bp.val),
          ...defaulted ? {
            def: defaulted.def,
            defFactory: defaulted.defFactory,
            hasDefault: true,
            defValidated: defaulted.defValidated
          } : {}
        };
      }
    }
    const extras = a.extras === "reject" || b.extras === "reject" ? "reject" : a.extras === "delete" || b.extras === "delete" ? "delete" : "keep";
    const index = a.index && b.index ? intersect(a.index, b.index) : a.index ?? b.index;
    return { k: "object", props, index, extras };
  }
  if (a.k === "string" && b.k === "string") {
    const min = maxOf(a.min, b.min);
    const max = minOf(a.max, b.max);
    if (min !== void 0 && max !== void 0 && min > max) {
      throw new OmpTypeError("string length intersection is unsatisfiable");
    }
    return { k: "string", min, max, url: a.url || b.url };
  }
  if (a.k === "number" && b.k === "number") {
    const min = maxOf(a.min, b.min);
    const max = minOf(a.max, b.max);
    const xmin = min !== void 0 && (a.min === min && a.xmin === true || b.min === min && b.xmin === true);
    const xmax = max !== void 0 && (a.max === max && a.xmax === true || b.max === max && b.xmax === true);
    if (min !== void 0 && max !== void 0 && (min > max || min === max && (xmin || xmax))) {
      throw new OmpTypeError("numeric range intersection is unsatisfiable");
    }
    if (a.divisor !== void 0 && b.divisor !== void 0 && a.divisor !== b.divisor) {
      return { k: "intersection", members: [a, b] };
    }
    return {
      k: "number",
      int: a.int || b.int,
      divisor: a.divisor ?? b.divisor,
      min,
      max,
      xmin,
      xmax
    };
  }
  if (a.k === "array" && b.k === "array") {
    const min = maxOf(a.min, b.min);
    const max = minOf(a.max, b.max);
    if (min !== void 0 && max !== void 0 && min > max) {
      throw new OmpTypeError("array length intersection is unsatisfiable");
    }
    return { k: "array", el: intersect(a.el, b.el), min, max };
  }
  if (a.k === "tuple" && b.k === "tuple") return intersectTuples(a, b);
  if (a.k === "tuple" && b.k === "array") return intersectTupleWithArray(a, b);
  if (a.k === "array" && b.k === "tuple") return intersectTupleWithArray(b, a);
  if (a.k === "instance" && b.k === "instance") {
    if (a.ctor === b.ctor || a.ctor.prototype instanceof b.ctor) return a;
    if (b.ctor.prototype instanceof a.ctor) return b;
    throw new OmpTypeError(`intersection of ${a.expected} and ${b.expected} is unsatisfiable`);
  }
  if (a.k === b.k && ["null", "undefined", "boolean", "bigint", "symbol", "anyobject"].includes(a.k)) return a;
  if (a.k === "object" && (b.k === "array" || b.k === "tuple") || b.k === "object" && (a.k === "array" || a.k === "tuple")) {
    return { k: "intersection", members: [a, b] };
  }
  const leftDomain = domainOf(a);
  const rightDomain = domainOf(b);
  if (leftDomain !== void 0 && rightDomain !== void 0 && leftDomain !== rightDomain) {
    throw new OmpTypeError(`intersection of ${leftDomain} and ${rightDomain} is unsatisfiable`);
  }
  if (a.k === "anyobject" && rightDomain === "object") return b;
  if (b.k === "anyobject" && leftDomain === "object") return a;
  const members = [...a.k === "intersection" ? a.members : [a], ...b.k === "intersection" ? b.members : [b]];
  return { k: "intersection", members };
}
function normalizeIR(ir) {
  switch (ir.k) {
    case "intersection": {
      const members = ir.members.map(normalizeIR);
      if (members.length === 0) return { k: "unknown" };
      return members.slice(1).reduce(intersect, members[0]);
    }
    case "union": {
      const members = [];
      let changed = false;
      for (let index = 0; index < ir.members.length; index++) {
        const original = ir.members[index];
        const member = normalizeIR(original);
        changed ||= member !== original;
        if (member.k === "union") {
          members.push(...member.members);
          changed = true;
        } else if (member.k === "never") {
          changed = true;
        } else if (member.k === "unknown") {
          return { k: "unknown" };
        } else {
          members.push(member);
        }
      }
      if (members.every(
        (member) => member.k === "lit" && (member.v === null || typeof member.v !== "object" && typeof member.v !== "function")
      )) {
        const pruned2 = [];
        for (const member of members) {
          if (member.k === "lit" && pruned2.some((candidate) => candidate.k === "lit" && candidate.v === member.v)) {
            changed = true;
          } else {
            pruned2.push(member);
          }
        }
        if (pruned2.length === 0) return { k: "never" };
        if (pruned2.length === 1) return pruned2[0];
        if (pruned2.length === 2 && pruned2.every((member) => member.k === "lit" && typeof member.v === "boolean")) {
          return { k: "boolean" };
        }
        return changed ? { ...ir, members: pruned2 } : ir;
      }
      const pruned = members.filter(
        (member, index) => !members.some(
          (candidate, candidateIndex) => candidateIndex !== index && !hasMorph(member) && !hasMorph(candidate) && isSubtype(member, candidate) && (!isSubtype(candidate, member) || candidateIndex < index)
        )
      );
      if (pruned.length === 0) return { k: "never" };
      if (pruned.length === 1) return pruned[0];
      if (pruned.length === 2 && pruned.every((member) => member.k === "lit" && typeof member.v === "boolean")) {
        return { k: "boolean" };
      }
      if (!changed && !pruned.some((member) => member.k === "alias") && pruned.length === ir.members.length && pruned.every((member, index) => member === ir.members[index])) {
        return ir;
      }
      return { ...ir, members: pruned };
    }
    case "array": {
      const element = normalizeIR(ir.el);
      return element === ir.el && ir.el.k !== "alias" ? ir : { ...ir, el: element };
    }
    case "tuple": {
      const prefix = ir.prefix.map((item) => {
        const value = normalizeIR(item.val);
        return value === item.val ? item : { ...item, val: value };
      });
      const variadic = ir.variadic === void 0 ? void 0 : normalizeIR(ir.variadic);
      const postfix = ir.postfix.map(normalizeIR);
      if (!ir.prefix.some((item) => item.val.k === "alias") && ir.variadic?.k !== "alias" && !ir.postfix.some((item) => item.k === "alias") && prefix.every((item, index) => item === ir.prefix[index]) && variadic === ir.variadic && postfix.every((item, index) => item === ir.postfix[index])) {
        return ir;
      }
      return { ...ir, prefix, variadic, postfix };
    }
    case "object": {
      let props;
      for (let index2 = 0; index2 < ir.props.length; index2++) {
        const prop = ir.props[index2];
        const value = normalizeIR(prop.val);
        if (value === prop.val) continue;
        props ??= [...ir.props];
        props[index2] = { ...prop, val: value };
      }
      const index = ir.index === void 0 ? void 0 : normalizeIR(ir.index);
      const symbolIndex = ir.symbolIndex === void 0 ? void 0 : normalizeIR(ir.symbolIndex);
      const patternIndexes = ir.patternIndexes?.map((pattern2) => {
        const key = normalizeIR(pattern2.key);
        const val = normalizeIR(pattern2.val);
        return key === pattern2.key && val === pattern2.val ? pattern2 : { key, val };
      });
      if (props === void 0 && !ir.props.some((prop) => prop.val.k === "alias") && ir.index?.k !== "alias" && ir.symbolIndex?.k !== "alias" && !ir.patternIndexes?.some((pattern2) => pattern2.key.k === "alias" || pattern2.val.k === "alias") && index === ir.index && symbolIndex === ir.symbolIndex && patternIndexes?.every((pattern2, patternIndex) => pattern2 === ir.patternIndexes?.[patternIndex]) !== false) {
        return ir;
      }
      return { ...ir, props: props ?? ir.props, index, symbolIndex, patternIndexes };
    }
    case "refine": {
      const base = normalizeIR(ir.base);
      return base === ir.base && ir.base.k !== "alias" ? ir : { ...ir, base };
    }
    case "morph": {
      const input = normalizeIR(ir.input);
      const out = ir.out === void 0 ? void 0 : normalizeIR(ir.out);
      return input === ir.input && out === ir.out && ir.input.k !== "alias" && ir.out?.k !== "alias" ? ir : { ...ir, input, out };
    }
    case "alias":
      return ir;
    default:
      return ir;
  }
}
function domainOf(ir) {
  switch (ir.k) {
    case "null":
      return "null";
    case "undefined":
    case "boolean":
    case "bigint":
    case "symbol":
    case "string":
    case "number":
      return ir.k;
    case "array":
    case "tuple":
      return "array";
    case "object":
    case "anyobject":
    case "instance":
      return "object";
    case "lit":
      return ir.v === null ? "null" : Array.isArray(ir.v) ? "array" : typeof ir.v;
    case "refine":
      return domainOf(ir.base);
    case "morph":
      return domainOf(ir.input);
    case "sub":
      return domainOf(ir.schema.ir);
    case "alias":
      return domainOf(ir.resolve());
    case "union":
    case "intersection": {
      const first = domainOf(ir.members[0] ?? { k: "never" });
      return ir.members.every((member) => domainOf(member) === first) ? first : void 0;
    }
    default:
      return void 0;
  }
}
function lowerBoundWithin(source, target) {
  if (target.min === void 0) return true;
  if (source.min === void 0 || source.min < target.min) return false;
  return source.min !== target.min || target.xmin !== true || source.xmin === true;
}
function upperBoundWithin(source, target) {
  if (target.max === void 0) return true;
  if (source.max === void 0 || source.max > target.max) return false;
  return source.max !== target.max || target.xmax !== true || source.xmax === true;
}
function lengthWithin(source, target) {
  return (target.min === void 0 || source.min !== void 0 && source.min >= target.min) && (target.max === void 0 || source.max !== void 0 && source.max <= target.max);
}
function isSubtype(source, target, seen = /* @__PURE__ */ new WeakMap()) {
  if (source === target || target.k === "unknown" || source.k === "never") return true;
  let targets = seen.get(source);
  if (targets?.has(target)) return true;
  if (targets === void 0) {
    targets = /* @__PURE__ */ new Set();
    seen.set(source, targets);
  }
  targets.add(target);
  if (source.k === "alias") return isSubtype(source.resolve(), target, seen);
  if (target.k === "alias") return isSubtype(source, target.resolve(), seen);
  if (source.k === "union") return source.members.every((member) => isSubtype(member, target, seen));
  if (target.k === "union") return target.members.some((member) => isSubtype(source, member, seen));
  if (target.k === "intersection") return target.members.every((member) => isSubtype(source, member, seen));
  if (source.k === "intersection") return source.members.some((member) => isSubtype(member, target, seen));
  if (source.k === "lit") return !(walk(target, source.v) instanceof OmpErrors);
  if (source.k === "refine") return isSubtype(source.base, target, seen);
  if (source.k === "morph") return isSubtype(source.out ?? source.input, target, seen);
  if (source.k === "sub") return isSubtype(source.schema.ir, target, seen);
  if (target.k === "refine" || target.k === "morph" || target.k === "sub") return false;
  if (source.k === "string" && target.k === "string") {
    return lengthWithin(source, target) && (!target.url || source.url === true);
  }
  if (source.k === "number" && target.k === "number") {
    return lowerBoundWithin(source, target) && upperBoundWithin(source, target) && (!target.int || source.int === true) && (target.divisor === void 0 || source.divisor !== void 0 && source.divisor % target.divisor === 0);
  }
  if (source.k === "array" && target.k === "array") {
    return lengthWithin(source, target) && isSubtype(source.el, target.el, seen);
  }
  if (source.k === "object" && target.k === "object") {
    for (const targetProp of target.props) {
      const sourceProp = source.props.find((prop) => prop.key === targetProp.key);
      if (sourceProp === void 0) {
        if (!targetProp.opt) return false;
        continue;
      }
      if (!targetProp.opt && sourceProp.opt) return false;
      if (!isSubtype(sourceProp.val, targetProp.val, seen)) return false;
    }
    if (target.extras === "reject") {
      if (source.extras !== "reject") return false;
      if (target.index === void 0 && source.props.some((sourceProp) => !target.props.some((targetProp) => targetProp.key === sourceProp.key))) {
        return false;
      }
    }
    return true;
  }
  if (source.k === "instance" && target.k === "instance") {
    return source.ctor === target.ctor || source.ctor.prototype instanceof target.ctor;
  }
  if (source.k === "object" && target.k === "anyobject") return true;
  if (source.k === "instance" && target.k === "anyobject") return true;
  if (source.k === "tuple" && target.k === "array") {
    return source.prefix.every((item) => isSubtype(item.val, target.el, seen)) && source.postfix.every((item) => isSubtype(item, target.el, seen)) && (source.variadic === void 0 || isSubtype(source.variadic, target.el, seen));
  }
  if (source.k !== target.k) return false;
  switch (source.k) {
    case "null":
    case "undefined":
    case "boolean":
    case "bigint":
    case "symbol":
    case "anyobject":
      return true;
    case "tuple":
      return target.k === "tuple" && expectedTuple(source) === expectedTuple(target);
    case "instance":
      return target.k === "instance" && source.ctor === target.ctor;
    default:
      return false;
  }
}
function expectedTuple(tuple) {
  return JSON.stringify({
    prefix: tuple.prefix.map((item) => [item.opt, item.hasDefault, expectedOf(item.val)]),
    variadic: tuple.variadic === void 0 ? void 0 : expectedOf(tuple.variadic),
    postfix: tuple.postfix.map(expectedOf)
  });
}
function irEquals(left, right) {
  return isSubtype(left, right) && isSubtype(right, left);
}
function maxOf(a, b) {
  if (a === void 0) return b;
  if (b === void 0) return a;
  return Math.max(a, b);
}
function minOf(a, b) {
  if (a === void 0) return b;
  if (b === void 0) return a;
  return Math.min(a, b);
}
function withLengthBound(ir, side, bound) {
  if (ir.k === "array" || ir.k === "string") {
    return side === "min" ? { ...ir, min: bound } : { ...ir, max: bound };
  }
  throw new OmpTypeError(`cannot apply length bound to ${ir.k}`);
}
function withNumericBound(ir, side, bound, exclusive = false) {
  if (!Number.isFinite(bound)) throw new OmpTypeError("numeric bound must be finite");
  if (ir.k === "number") {
    return side === "min" ? { ...ir, min: bound, xmin: exclusive } : { ...ir, max: bound, xmax: exclusive };
  }
  if (ir.k === "union") {
    return { ...ir, members: ir.members.map((member) => withNumericBound(member, side, bound, exclusive)) };
  }
  throw new OmpTypeError(`cannot apply numeric bound to ${ir.k}`);
}
var GENERIC_META = Symbol("omptype.generic");
function validateGenericParameters(parameters) {
  const names2 = /* @__PURE__ */ new Set();
  for (const parameter of parameters) {
    if (!/^[A-Za-z_$]\w*$/.test(parameter.name)) {
      throw new OmpTypeError(`invalid generic parameter "${parameter.name}"`);
    }
    if (names2.has(parameter.name)) throw new OmpTypeError(`duplicate generic parameter "${parameter.name}"`);
    names2.add(parameter.name);
  }
  if (parameters.length === 0) throw new OmpTypeError("generic declarations require at least one parameter");
}
function parseGenericParameters(source) {
  const trimmed = source.trim();
  const body = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (quote !== "") {
      if (char === quote && body[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "<" || char === "(" || char === "[") depth++;
    else if (char === ">" || char === ")" || char === "]") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      parts.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(body.slice(start).trim());
  const parameters = parts.map((part) => {
    const constrained = part.match(/^([A-Za-z_$]\w*)\s+extends\s+(.+)$/s);
    return constrained === null ? { name: part } : { name: constrained[1], constraintDef: constrained[2].trim() };
  });
  validateGenericParameters(parameters);
  return parameters;
}
function parseGenericDeclaration(source) {
  const match = source.trim().match(/^([A-Za-z_$]\w*)\s*(<.*>)$/s);
  if (match === null) return void 0;
  return { name: match[1], parameters: parseGenericParameters(match[2]) };
}
function isRuntimeGeneric(value) {
  return typeof value === "function" && GENERIC_META in value;
}
function genericResolver(parameters, arguments_, outer) {
  const byName = /* @__PURE__ */ new Map();
  for (let index = 0; index < parameters.length; index++) byName.set(parameters[index].name, arguments_[index]);
  const resolve2 = (name) => byName.get(name) ?? outer?.(name);
  resolve2.hasGeneric = outer?.hasGeneric;
  resolve2.generic = outer?.generic;
  return resolve2;
}
function parseGenericArgument(definition, outer) {
  if (outer === void 0) {
    try {
      return parseDef(definition);
    } catch (error) {
      if (!(error instanceof OmpTypeError) || !error.message.includes('unknown keyword "this"')) throw error;
    }
  }
  const root = {};
  const self = {
    k: "alias",
    name: "this",
    resolve: () => {
      if (root.current === void 0 || root.current === self)
        throw new OmpTypeError('"this" cannot be used as a root definition');
      return root.current;
    }
  };
  const resolve2 = (name) => name === "this" ? self : outer?.(name);
  if (outer !== void 0) {
    resolve2.hasGeneric = outer.hasGeneric;
    resolve2.generic = outer.generic;
  } else {
    markThisOnlyResolver(resolve2);
  }
  root.current = parseDef(definition, resolve2);
  if (root.current === self) throw new OmpTypeError('"this" cannot be used as a root definition');
  return root.current;
}
function genericBodyIR(parameters, definition, arguments_, outer) {
  const resolve2 = genericResolver(parameters, arguments_, outer);
  const body = typeof definition === "function" && !(IR_BRAND in definition) ? definition(
    Object.fromEntries(
      parameters.map((parameter, index) => [
        parameter.name,
        makeType(arguments_[index], EMPTY_STEPS, EMPTY_META)
      ])
    )
  ) : definition;
  return parseDef(body, resolve2);
}
function createRuntimeGeneric(parameters, definition, outer, validateBody = true) {
  const constraintResolve = (name) => outer?.(name);
  constraintResolve.hasGeneric = outer?.hasGeneric;
  constraintResolve.generic = outer?.generic;
  validateGenericParameters(parameters);
  const placeholders = parameters.map(
    (parameter) => parameter.constraintDef === void 0 ? { k: "unknown" } : parseDef(parameter.constraintDef, constraintResolve)
  );
  if (validateBody) genericBodyIR(parameters, definition, placeholders, outer);
  const meta = {
    parameters,
    instantiateIR(arguments_) {
      if (arguments_.length !== parameters.length) {
        throw new OmpTypeError(`generic expects ${parameters.length} arguments (received ${arguments_.length})`);
      }
      for (let index = 0; index < parameters.length; index++) {
        const parameter = parameters[index];
        if (parameter.constraintDef === void 0) continue;
        const constraint = parseDef(parameter.constraintDef, constraintResolve);
        if (!isSubtype(arguments_[index], constraint)) {
          throw new OmpTypeError(`${parameter.name} must be assignable to its constraint`);
        }
      }
      return genericBodyIR(parameters, definition, arguments_, outer);
    }
  };
  const generic = Object.assign(
    (...arguments_) => makeType(
      meta.instantiateIR(arguments_.map((argument) => parseGenericArgument(argument, outer))),
      EMPTY_STEPS,
      EMPTY_META
    ),
    { [GENERIC_META]: meta }
  );
  Object.defineProperty(generic, GENERIC_META, { value: meta });
  return generic;
}
function type(first) {
  const count = arguments.length;
  if (count === 2 && typeof first === "string" && first.trimStart().startsWith("<")) {
    return createRuntimeGeneric(parseGenericParameters(first), arguments[1]);
  }
  let definition = first;
  if (count !== 1) {
    const expression = new Array(count);
    for (let index = 0; index < count; index++) {
      expression[index] = arguments[index];
    }
    definition = expression;
  }
  return makeType(parseGenericArgument(definition), EMPTY_STEPS, EMPTY_META);
}
function keywordSchema(name) {
  const ir = keywordIR(name);
  if (ir === void 0) throw new OmpTypeError(`missing built-in keyword ${name}`);
  return makeType(ir, [], {});
}
function parsedKeyword(name) {
  return Object.assign(keywordSchema(name), {
    parse: keywordSchema(`${name}.parse`)
  });
}
function preformattedKeyword(name) {
  return Object.assign(keywordSchema(name), {
    preformatted: keywordSchema(`${name}.preformatted`)
  });
}
function caseResolver(value) {
  if (typeof value !== "function") throw new OmpTypeError("match case values must be functions");
  return (input, ...args) => Reflect.apply(value, void 0, [input, ...args]);
}
function unionIR(branches) {
  const members = branches.map((branch) => branch.schema.ir);
  if (members.length === 0) return { k: "never" };
  if (members.length === 1) return members[0];
  return { k: "union", members };
}
function publicMatcher(state, fallback2) {
  const fallbackResolver = typeof fallback2 === "function" ? caseResolver(fallback2) : void 0;
  const casesIR = unionIR(state.branches);
  let casesSchema;
  if (state.key === void 0 || state.branches.length === 0) {
    casesSchema = state.key === void 0 ? makeType(casesIR, EMPTY_STEPS, EMPTY_META) : state.parse({ [state.key]: "never" });
  } else {
    const first = state.branches[0].schema.ir;
    if (first.k !== "object") throw new OmpTypeError("match.at cases must define object schemas");
    const propertyKey = String(state.key);
    const values = [];
    for (const branch of state.branches) {
      if (branch.schema.ir.k !== "object") throw new OmpTypeError("match.at cases must define object schemas");
      const property = branch.schema.ir.props.find((candidate) => candidate.key === propertyKey);
      if (property === void 0) throw new OmpTypeError(`match.at case is missing ${propertyKey}`);
      values.push(property.val);
    }
    const value = values.length === 1 ? values[0] : { k: "union", members: values };
    casesSchema = makeType(
      {
        ...first,
        props: first.props.map((property) => property.key === propertyKey ? { ...property, val: value } : property)
      },
      EMPTY_STEPS,
      EMPTY_META
    );
  }
  const execute = (input, args) => {
    let matchedInput = input;
    if (state.input !== void 0) {
      const validated = state.input.run(input);
      if (validated instanceof OmpErrors) return validated;
      matchedInput = validated;
    }
    for (const branch of state.branches) {
      const matched = branch.schema.run(matchedInput);
      if (!(matched instanceof OmpErrors)) return branch.resolve(matched, ...args);
    }
    if (fallbackResolver !== void 0) return fallbackResolver(matchedInput, ...args);
    return casesSchema.run(matchedInput);
  };
  const schema = makeType({ k: "unknown" }, [{ kind: "pipe", fn: (input) => execute(input, []) }], EMPTY_META);
  const callable = (value, ...args) => {
    const result = execute(value, args);
    if ((fallback2 === "assert" || fallback2 === "never") && result instanceof OmpErrors) {
      throw new TraversalError(result);
    }
    return result;
  };
  Object.assign(callable, schema);
  Object.setPrototypeOf(callable, typeMethods);
  return callable;
}
function addMatchCases(state, cases) {
  const branches = [...state.branches];
  let fallback2;
  for (const rawDefinition of Reflect.ownKeys(cases)) {
    const value = Reflect.get(cases, rawDefinition);
    if (rawDefinition === "default") {
      if (value !== "assert" && value !== "never" && value !== "reject" && typeof value !== "function") {
        throw new OmpTypeError('match default must be "assert", "never", "reject" or a function');
      }
      fallback2 = value;
      continue;
    }
    const definition = typeof rawDefinition === "symbol" ? rawDefinition : String(rawDefinition);
    const caseDefinition = state.key === void 0 ? definition : { [state.key]: definition };
    branches.push({
      definition,
      schema: state.parse(caseDefinition),
      resolve: caseResolver(value)
    });
  }
  const next = { ...state, branches };
  return fallback2 === void 0 ? createMatchParser(next) : publicMatcher(next, fallback2);
}
function createMatchParser(state) {
  const parser = (cases) => addMatchCases(state, cases);
  parser.case = (definition, resolver) => {
    const caseDefinition = state.key === void 0 ? definition : { [state.key]: definition };
    return createMatchParser({
      ...state,
      branches: [
        ...state.branches,
        {
          definition,
          schema: state.parse(caseDefinition),
          resolve: caseResolver(resolver)
        }
      ]
    });
  };
  parser.match = (cases) => addMatchCases(state, cases);
  parser.default = (fallback2) => publicMatcher(state, fallback2);
  function at(key, cases) {
    if (state.key !== void 0) throw new OmpTypeError("match.at may only be specified once");
    const next = createMatchParser({ ...state, key });
    return cases === void 0 ? next : next.match(cases);
  }
  parser.at = at;
  parser.strings = (cases) => {
    if (state.key === void 0) throw new OmpTypeError("match.strings requires match.at(key)");
    const definitions = {};
    for (const key of Reflect.ownKeys(cases)) {
      definitions[key === "default" ? key : JSON.stringify(String(key))] = Reflect.get(cases, key);
    }
    return addMatchCases(state, definitions);
  };
  parser.in = (...args) => {
    if (state.input !== void 0) throw new OmpTypeError("match.in may only be specified once");
    return createMatchParser({
      ...state,
      ...args.length === 0 ? {} : { input: state.parse(args[0]) }
    });
  };
  return parser;
}
var matchBuilder = createMatchParser({
  parse: (definition) => type.raw(definition),
  branches: []
});
function fnExpression(ir) {
  switch (ir.k) {
    case "unknown":
    case "null":
    case "undefined":
    case "boolean":
    case "bigint":
    case "symbol":
    case "never":
    case "string":
    case "number":
      return ir.k;
    case "anyobject":
      return "object";
    case "lit":
      return typeof ir.v === "string" ? JSON.stringify(ir.v) : String(ir.v);
    case "union":
      return ir.members.map(fnExpression).join(" | ");
    case "intersection":
      return ir.members.map(fnExpression).join(" & ");
    case "array": {
      const element = fnExpression(ir.el);
      return ir.el.k === "unknown" ? "Array" : `${element.includes(" | ") ? `(${element})` : element}[]`;
    }
    case "tuple": {
      const elements = ir.prefix.map((item) => {
        const expression = fnExpression(item.val);
        if (item.hasDefault) return `${expression} = ${String(item.def)}`;
        return item.opt ? `${expression}?` : expression;
      });
      if (ir.variadic !== void 0) elements.push(`...${fnExpression({ k: "array", el: ir.variadic })}`);
      elements.push(...ir.postfix.map(fnExpression));
      return `[${elements.join(", ")}]`;
    }
    case "object":
      return `{ ${ir.props.map((property) => `${String(property.key)}${property.opt ? "?" : ""}: ${fnExpression(property.val)}`).join(", ")} }`;
    case "refine":
      return fnExpression(ir.base);
    case "morph":
      return `(In: ${fnExpression(ir.input)}) => To<${fnExpression(ir.out ?? { k: "unknown" })}>`;
    case "instance":
      return ir.ctor.name || "object";
    case "alias":
      return fnExpression(ir.resolve());
    case "sub": {
      const schema = ir.schema;
      if (!schema.hasSteps) return fnExpression(schema.ir);
      return `(In: ${fnExpression(schema.ir)}) => To<${fnExpression(schema.stepOut ?? { k: "unknown" })}>`;
    }
  }
}
function normalizeFnParameter(definition) {
  if (typeof definition !== "string") return definition;
  const optional = definition.match(/^(.*[^\s])\?$/);
  if (optional) return [optional[1], "?"];
  const defaulted = definition.match(/^(.*?)\s*=\s*(.+)$/);
  if (defaulted) {
    const source = defaulted[2];
    const value = source === "true" ? true : source === "false" ? false : source === "null" ? null : Number.isNaN(Number(source)) ? source : Number(source);
    return [defaulted[1], "=", value];
  }
  return definition;
}
function makeFn(resolve2) {
  function parser(...definitions) {
    const marker = definitions.indexOf(":");
    if (marker !== -1 && (marker !== definitions.length - 2 || definitions.lastIndexOf(":") !== marker)) {
      throw new OmpTypeError(
        '":" must be followed by exactly one return type e.g:\nfn("string", ":", "number")(s => s.length)'
      );
    }
    const spreadIndexes = [];
    for (let index = 0; index < definitions.length; index++) {
      if (definitions[index] === "...") spreadIndexes.push(index);
    }
    if (spreadIndexes.length > 1) {
      const secondSpread = definitions[spreadIndexes[1] + 1];
      if (Array.isArray(secondSpread) && secondSpread.some(
        (element) => typeof element === "string" && (element.endsWith("?") || element.includes("="))
      )) {
        throw new OmpTypeError("An optional element may not follow a variadic element");
      }
      throw new OmpTypeError("A tuple may have at most one variadic element");
    }
    if (spreadIndexes.length === 1 && spreadIndexes[0] + 2 < (marker === -1 ? definitions.length : marker)) {
      const preceding = definitions.slice(0, spreadIndexes[0]);
      if (preceding.some((element) => typeof element === "string" && (element.endsWith("?") || /\s=\s/.test(element)))) {
        throw new OmpTypeError("A postfix required element cannot follow an optional or defaultable element");
      }
    }
    const parameterDefinitions = (marker === -1 ? definitions : definitions.slice(0, marker)).map(
      normalizeFnParameter
    );
    const params = makeType(parseDef(parameterDefinitions, resolve2), [], {});
    const returns = marker === -1 ? makeType({ k: "unknown" }, [], {}) : makeType(parseDef(definitions[marker + 1], resolve2), [], {});
    const parameterExpression = fnExpression(params.ir);
    const returnsExpression = fnExpression(returns.ir);
    return (implementation) => {
      if (typeof implementation !== "function") throw new OmpTypeError("type.fn requires a function implementation");
      const raw = (...arguments_) => {
        const validatedArguments = params.assert(arguments_);
        const result = Reflect.apply(implementation, void 0, validatedArguments);
        return returns.assert(result);
      };
      const typed = raw.bind(void 0);
      Object.defineProperties(typed, {
        name: { value: `bound typed ${implementation.name}`, configurable: true },
        raw: { value: implementation, enumerable: true },
        params: { value: params, enumerable: true },
        returns: { value: returns, enumerable: true },
        expression: {
          value: `(${parameterExpression.slice(1, -1)}) => ${returnsExpression}`,
          enumerable: true
        }
      });
      return typed;
    };
  }
  return Object.assign(parser, { raw: parser });
}
function isTypeValue(value) {
  return (typeof value === "function" || typeof value === "object" && value !== null) && IR_BRAND in value;
}
function resolveAlias(ir) {
  const seen = /* @__PURE__ */ new Set();
  let current = ir;
  while (current.k === "alias" && !seen.has(current)) {
    seen.add(current);
    current = current.resolve();
  }
  return current;
}
function sameUnionMember(left, right) {
  const a = resolveAlias(left);
  const b = resolveAlias(right);
  if (a.k === "lit" && b.k === "lit") return Object.is(a.v, b.v);
  if (a.k !== b.k) return false;
  switch (a.k) {
    case "unknown":
    case "never":
    case "null":
    case "undefined":
    case "boolean":
    case "bigint":
    case "symbol":
    case "anyobject":
      return true;
    default:
      return false;
  }
}
function buildOr(definitions, resolve2) {
  const members = [];
  const add = (candidate) => {
    const resolved = resolveAlias(candidate);
    if (resolved.k === "unknown") {
      members.length = 0;
      members.push(resolved);
      return false;
    }
    if (resolved.k === "never") return true;
    if (resolved.k === "union") {
      for (const member of resolved.members) {
        if (!add(member)) return false;
      }
      return true;
    }
    if (!members.some((member) => sameUnionMember(member, candidate))) members.push(candidate);
    return true;
  };
  for (const definition of definitions) {
    if (!add(parseDef(definition, resolve2))) break;
  }
  const ir = members.length === 0 ? { k: "never" } : members.length === 1 ? members[0] : { k: "union", members };
  return makeType(ir, [], {});
}
function buildAnd(definitions, resolve2) {
  if (definitions.length === 0) return makeType({ k: "unknown" }, [], {});
  let ir = parseDef(definitions[0], resolve2);
  for (let index = 1; index < definitions.length; index++) {
    ir = intersect(ir, parseDef(definitions[index], resolve2));
  }
  return makeType(ir, [], {});
}
function requireNaryObject(ir) {
  const resolved = resolveAlias(ir);
  if (resolved.k !== "object") throw new OmpTypeError("merge requires an object schema");
  return resolved;
}
function buildMerge(definitions, resolve2) {
  if (definitions.length === 0) return makeType({ k: "anyobject" }, [], {});
  let object = requireNaryObject(parseDef(definitions[0], resolve2));
  for (let index = 1; index < definitions.length; index++) {
    object = mergeObjects(object, requireNaryObject(parseDef(definitions[index], resolve2)));
  }
  return makeType(object, [], {});
}
function buildPipe(definitions, resolve2) {
  if (definitions.length === 0) return makeType({ k: "unknown" }, [], {});
  const first = definitions[0];
  let schema = typeof first === "function" && !isTypeValue(first) ? appendPipes(makeType({ k: "unknown" }, [], {}), [first], false, true) : isTypeValue(first) ? first : makeType(parseDef(first, resolve2), [], {});
  for (let index = 1; index < definitions.length; index++) {
    const definition = definitions[index];
    const pipe = typeof definition === "function" && !isTypeValue(definition) ? definition : isTypeValue(definition) ? definition : makeType(parseDef(definition, resolve2), [], {});
    schema = appendPipes(schema, [pipe], false, true);
  }
  return schema;
}
function naryStatics(resolve2) {
  return {
    or: (...definitions) => buildOr(definitions, resolve2),
    and: (...definitions) => buildAnd(definitions, resolve2),
    merge: (...definitions) => buildMerge(definitions, resolve2),
    pipe: (...definitions) => buildPipe(definitions, resolve2)
  };
}
((type2) => {
  type2.errors = OmpErrors;
  function or(...definitions) {
    return buildOr(definitions);
  }
  type2.or = or;
  function array(definition) {
    return type2(definition).array();
  }
  type2.array = array;
  function union(definitions) {
    return buildOr(definitions);
  }
  type2.union = union;
  function tuple(definitions) {
    return type2(definitions);
  }
  type2.tuple = tuple;
  function record(key, value) {
    return type2.keywords.Record(key, value);
  }
  type2.record = record;
  function and(...definitions) {
    return buildAnd(definitions);
  }
  type2.and = and;
  function merge(...definitions) {
    return buildMerge(definitions);
  }
  type2.merge = merge;
  function pipe(...definitions) {
    return buildPipe(definitions);
  }
  type2.pipe = pipe;
  const normalize2 = Object.assign(keywordSchema("string.normalize"), {
    preformatted: keywordSchema("string.normalize.NFC.preformatted"),
    NFC: preformattedKeyword("string.normalize.NFC"),
    NFD: preformattedKeyword("string.normalize.NFD"),
    NFKC: preformattedKeyword("string.normalize.NFKC"),
    NFKD: preformattedKeyword("string.normalize.NFKD")
  });
  const base64 = Object.assign(keywordSchema("string.base64"), {
    url: keywordSchema("string.base64.url")
  });
  const date = Object.assign(parsedKeyword("string.date"), {
    iso: parsedKeyword("string.date.iso"),
    epoch: parsedKeyword("string.date.epoch")
  });
  const ip = Object.assign(keywordSchema("string.ip"), {
    v4: keywordSchema("string.ip.v4"),
    v6: keywordSchema("string.ip.v6")
  });
  const uuid = Object.assign(keywordSchema("string.uuid"), {
    v1: keywordSchema("string.uuid.v1"),
    v2: keywordSchema("string.uuid.v2"),
    v3: keywordSchema("string.uuid.v3"),
    v4: keywordSchema("string.uuid.v4"),
    v5: keywordSchema("string.uuid.v5"),
    v6: keywordSchema("string.uuid.v6"),
    v7: keywordSchema("string.uuid.v7"),
    v8: keywordSchema("string.uuid.v8")
  });
  type2.string = Object.defineProperties(
    makeType({ k: "string" }, [], {}),
    Object.getOwnPropertyDescriptors({
      alpha: keywordSchema("string.alpha"),
      alphanumeric: keywordSchema("string.alphanumeric"),
      base64,
      capitalize: preformattedKeyword("string.capitalize"),
      creditCard: keywordSchema("string.creditCard"),
      date,
      digits: keywordSchema("string.digits"),
      email: keywordSchema("string.email"),
      hex: keywordSchema("string.hex"),
      integer: parsedKeyword("string.integer"),
      ip,
      json: parsedKeyword("string.json"),
      lower: preformattedKeyword("string.lower"),
      normalize: normalize2,
      numeric: parsedKeyword("string.numeric"),
      regex: keywordSchema("string.regex"),
      semver: keywordSchema("string.semver"),
      trim: preformattedKeyword("string.trim"),
      upper: preformattedKeyword("string.upper"),
      url: parsedKeyword("string.url"),
      uuid
    })
  );
  type2.parse = {
    number: keywordSchema("parse.number"),
    integer: keywordSchema("parse.integer"),
    json: keywordSchema("parse.json"),
    date: keywordSchema("parse.date"),
    url: keywordSchema("parse.url"),
    boolean: keywordSchema("parse.boolean"),
    bigint: keywordSchema("parse.bigint")
  };
  type2.number = Object.assign(makeType({ k: "number" }, [], {}), {
    integer: makeType({ k: "number", int: true }, [], {})
  });
  type2.arrayIndex = makeType(
    {
      k: "refine",
      base: { k: "string" },
      pred: (value) => typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value),
      expected: "a non-negative integer string"
    },
    [],
    {}
  );
  type2.boolean = makeType({ k: "boolean" }, [], {});
  type2.bigint = makeType({ k: "bigint" }, [], {});
  type2.symbol = makeType({ k: "symbol" }, [], {});
  type2.object = makeType({ k: "anyobject" }, [], {});
  type2.unknown = makeType({ k: "unknown" }, [], {});
  type2.any = type2.unknown;
  type2.never = makeType({ k: "never" }, [], {});
  type2.keywords = {
    number: { integer: type2.number.integer },
    Map: keywordSchema("Map"),
    Set: keywordSchema("Set"),
    RegExp: keywordSchema("RegExp"),
    File: keywordSchema("File"),
    Error: keywordSchema("Error"),
    Function: keywordSchema("Function"),
    Array: {
      liftFrom(definition) {
        const element = parseDef(definition);
        const array2 = { k: "array", el: element, desc: "an object" };
        return makeType(
          {
            k: "morph",
            input: { k: "union", members: [element, array2] },
            fn: (value) => globalThis.Array.isArray(value) ? value : [value],
            out: array2
          },
          [],
          {}
        );
      }
    },
    Record(key, value) {
      const keyIR = parseDef(key);
      if (keyIR.k !== "string" && keyIR.k !== "symbol") {
        throw new OmpTypeError("Record key must be assignable to string or symbol");
      }
      const valueIR = parseDef(value);
      const ir = keyIR.k === "symbol" ? { k: "object", props: [], symbolIndex: valueIR, extras: "keep" } : { k: "object", props: [], index: valueIR, extras: "keep" };
      return makeType(ir, [], {});
    },
    Partial(definition) {
      return makeType(
        setObjectOptionality(parseDef(definition), true, "partial"),
        [],
        {}
      );
    },
    Required(definition) {
      return makeType(
        setObjectOptionality(parseDef(definition), false, "required"),
        [],
        {}
      );
    },
    Pick(definition, ...keys) {
      return makeType(selectObjectProps(parseDef(definition), keys, true, "pick"), [], {});
    },
    Omit(definition, ...keys) {
      return makeType(selectObjectProps(parseDef(definition), keys, false, "omit"), [], {});
    },
    Merge(left, right) {
      return makeType(
        mergeObjectDefinition(parseDef(left), right),
        [],
        {}
      );
    },
    object: {
      json: Object.defineProperties(keywordSchema("object.json"), {
        stringify: {
          value: keywordSchema("object.json.stringify"),
          enumerable: true
        }
      })
    },
    unknown: { any: keywordSchema("unknown.any") }
  };
  type2.Date = makeType({ k: "instance", ctor: globalThis.Date, expected: "a Date" }, [], {});
  function instanceOf(ctor) {
    if (typeof ctor !== "function" || ctor.prototype === void 0) {
      throw new OmpTypeError("instanceof operands must be constructors");
    }
    const name = Reflect.get(ctor, "name");
    const expected = ctor.prototype === Error.prototype ? "an Error" : typeof name === "string" && name.length > 0 ? `an instance of ${name}` : "an instance";
    return makeType({ k: "instance", ctor, expected }, [], {});
  }
  type2.instanceOf = instanceOf;
  function unit(value) {
    return makeType({ k: "lit", v: value }, [], {});
  }
  type2.unit = unit;
  function enumerated(...values) {
    const members = values.map((value) => ({ k: "lit", v: value }));
    const ir = members.length === 0 ? { k: "never" } : members.length === 1 ? members[0] : { k: "union", members };
    return makeType(ir, [], {});
  }
  type2.enumerated = enumerated;
  function enumeration(values) {
    return enumerated(...values);
  }
  type2.enumeration = enumeration;
  function valueOf(values) {
    const members = [];
    for (const key in values) {
      if (/^(?:0|[1-9]\d*)$/.test(key)) continue;
      members.push({ k: "lit", v: values[key] });
    }
    const ir = members.length === 0 ? { k: "never" } : members.length === 1 ? members[0] : { k: "union", members };
    return makeType(ir, [], {});
  }
  type2.valueOf = valueOf;
  type2.match = matchBuilder;
  function define(definition) {
    return definition;
  }
  type2.define = define;
  type2.fn = makeFn();
  type2.declare = () => ({
    type: (definition) => type2(definition)
  });
  function scope2(aliases, options) {
    return buildScope(aliases, options);
  }
  type2.scope = scope2;
  function module(definitions, options) {
    return scope2(definitions, options).export();
  }
  type2.module = module;
  function generic(...arguments_) {
    if (arguments_.length === 2 && typeof arguments_[0] === "string" && arguments_[0].trimStart().startsWith("<")) {
      return createRuntimeGeneric(parseGenericParameters(arguments_[0]), arguments_[1]);
    }
    const parameters = arguments_.map((parameter) => {
      if (typeof parameter === "string") return { name: parameter.trim() };
      if (Array.isArray(parameter) && typeof parameter[0] === "string") {
        return { name: parameter[0].trim(), constraintDef: parameter[1] };
      }
      throw new OmpTypeError("generic parameters must be names or [name, constraint] pairs");
    });
    validateGenericParameters(parameters);
    return (definition) => createRuntimeGeneric(parameters, definition);
  }
  type2.generic = generic;
  function raw(def) {
    return makeType(parseDef(def), [], {});
  }
  type2.raw = raw;
  function withJsonSchema(schema, json2) {
    const internal = schema;
    if (internal.hasDefault || hasMorph(internal.ir) || internal[kSteps].some((step) => step.kind === "pipe")) {
      throw new OmpTypeError("type.withJsonSchema cannot wrap schemas with defaults or output-changing morphs");
    }
    return makeType(
      {
        k: "refine",
        base: { k: "unknown" },
        pred: (value) => {
          const result = schema(value);
          return result instanceof OmpErrors ? result : true;
        },
        expected: schema.expression,
        json: { ...json2 }
      },
      [],
      {}
    );
  }
  type2.withJsonSchema = withJsonSchema;
})(type || (type = {}));
Object.assign(type, {
  null: makeType({ k: "null" }, [], {}),
  undefined: makeType({ k: "undefined" }, [], {}),
  true: makeType({ k: "lit", v: true }, [], {}),
  false: makeType({ k: "lit", v: false }, [], {})
});
var MODULE_SCOPE = Symbol("omptype.moduleScope");
function scope(aliases, options) {
  return buildScope(aliases, options);
}
((scope2) => {
  function define(definitions) {
    return definitions;
  }
  scope2.define = define;
})(scope || (scope = {}));
function isRuntimeModule(value) {
  return typeof value === "object" && value !== null && MODULE_SCOPE in value;
}
function buildScope(aliases, options) {
  const scopeMeta = options?.clone === void 0 ? EMPTY_META : { clone: options.clone };
  const withScopeConfig = (ir) => options?.divisor === void 0 ? ir : configureSelected(ir, options.divisor, { kind: "divisor" });
  const entries = /* @__PURE__ */ new Map();
  for (const sourceName in aliases) {
    const isPrivate = sourceName.startsWith("#");
    const visibleName = isPrivate ? sourceName.slice(1) : sourceName;
    const declaration = parseGenericDeclaration(visibleName);
    const external = isRuntimeGeneric(aliases[sourceName]) ? aliases[sourceName] : void 0;
    const name = declaration?.name ?? visibleName;
    if (entries.has(name)) throw new OmpTypeError(`alias "${name}" is declared as both public and private`);
    entries.set(name, {
      name,
      sourceName,
      private: isPrivate,
      genericParameters: declaration?.parameters ?? external?.[GENERIC_META].parameters,
      definition: aliases[sourceName],
      generic: external,
      materialized: false
    });
  }
  const references = /* @__PURE__ */ new Map();
  const targets = /* @__PURE__ */ new Map();
  const scopeValue = {};
  const materialize = (entry2) => {
    if (entry2.materialized) return entry2.definition;
    entry2.materialized = true;
    if (entry2.genericParameters === void 0 && typeof entry2.definition === "function" && !(IR_BRAND in entry2.definition)) {
      entry2.definition = Reflect.apply(entry2.definition, void 0, []);
    }
    return entry2.definition;
  };
  const moduleSchema = (module, parts) => {
    let current = module;
    for (const part of parts) {
      if (!isRuntimeModule(current)) return void 0;
      const next = current[part];
      if (next === void 0) return void 0;
      current = next;
    }
    if (isRuntimeModule(current)) {
      const root = current.root;
      return root !== void 0 && !isRuntimeModule(root) ? root : void 0;
    }
    return current;
  };
  const resolve2 = (path) => {
    const [name, ...parts] = path.split(".");
    const entry2 = entries.get(name);
    if (entry2 === void 0 || entry2.genericParameters !== void 0) return void 0;
    const definition = materialize(entry2);
    if (isRuntimeModule(definition)) {
      const schema = moduleSchema(definition, parts);
      return schema === void 0 ? void 0 : embed(schema);
    }
    if (parts.length !== 0) return void 0;
    const existing = references.get(name);
    if (existing !== void 0) return existing;
    const reference = {
      k: "alias",
      name,
      resolve: () => {
        const target = targets.get(name);
        if (target !== void 0) return target;
        const parsed = parseDef(definition, resolve2);
        targets.set(name, parsed);
        return parsed;
      }
    };
    references.set(name, reference);
    return reference;
  };
  const genericFor = (entry2) => {
    if (entry2.generic !== void 0) return entry2.generic;
    const parameters = entry2.genericParameters;
    if (parameters === void 0) throw new OmpTypeError(`alias "${entry2.name}" is not generic`);
    entry2.generic = createRuntimeGeneric(parameters, entry2.definition, resolve2, false);
    return entry2.generic;
  };
  const genericInstantiations = /* @__PURE__ */ new Map();
  resolve2.hasGeneric = (name) => entries.get(name)?.genericParameters !== void 0;
  resolve2.generic = (name, arguments_) => {
    const entry2 = entries.get(name);
    if (entry2 === void 0 || entry2.genericParameters === void 0) return void 0;
    const key = `${name}<${arguments_.map(expectedOf).join(",")}>`;
    const existing = genericInstantiations.get(key);
    if (existing !== void 0) return existing;
    let target;
    const reference = {
      k: "alias",
      name: key,
      resolve: () => {
        target ??= genericFor(entry2)[GENERIC_META].instantiateIR(arguments_);
        return target;
      }
    };
    genericInstantiations.set(key, reference);
    target = genericFor(entry2)[GENERIC_META].instantiateIR(arguments_);
    return target;
  };
  const bind = (schema) => {
    Reflect.set(schema, "$", scopeValue.current);
    Reflect.set(schema, "resolver", resolve2);
    return schema;
  };
  const parseScoped = (definition) => bind(makeType(withScopeConfig(parseDef(definition, resolve2)), EMPTY_STEPS, scopeMeta));
  const scopedMatch = createMatchParser({
    parse: (definition) => parseScoped(definition),
    branches: []
  });
  const scoped = Object.assign((definition) => parseScoped(definition), type, {
    fn: makeFn(resolve2),
    match: scopedMatch,
    ...naryStatics(resolve2)
  });
  const targetFor = (name) => {
    const resolved = resolve2(name);
    if (resolved === void 0) throw new OmpTypeError(`unknown alias "${name}"`);
    return resolved.k === "alias" ? resolved.resolve() : resolved;
  };
  const schemaFor = (name) => bind(makeType(withScopeConfig(targetFor(name)), EMPTY_STEPS, scopeMeta));
  const bindModule = (names2) => {
    const module = {};
    Object.defineProperty(module, MODULE_SCOPE, { value: scopeValue.current });
    for (const name of names2) {
      const entry2 = entries.get(name);
      if (entry2 === void 0) continue;
      if (entry2.genericParameters !== void 0) {
        module[name] = genericFor(entry2);
        continue;
      }
      const definition = materialize(entry2);
      module[name] = isRuntimeModule(definition) ? definition : schemaFor(name);
    }
    return module;
  };
  scopeValue.current = {
    type: scoped,
    match: scopedMatch,
    define(definition) {
      return definition;
    },
    resolve(name) {
      return schemaFor(name);
    },
    import(...names2) {
      const selected = names2.length === 0 ? [...entries.values()].filter((entry2) => !entry2.private) : names2.map((name) => {
        const entry2 = entries.get(name);
        if (entry2 === void 0) throw new OmpTypeError(`unknown alias "${name}"`);
        return entry2;
      });
      const imported = {};
      for (const entry2 of selected) {
        imported[`#${entry2.sourceName.startsWith("#") ? entry2.sourceName.slice(1) : entry2.sourceName}`] = entry2.genericParameters === void 0 ? schemaFor(entry2.name) : genericFor(entry2);
      }
      return imported;
    },
    export(...names2) {
      const selected = names2.length === 0 ? [...entries.values()].filter((entry2) => !entry2.private).map((entry2) => entry2.name) : names2;
      for (const entry2 of entries.values()) {
        if (entry2.genericParameters !== void 0) genericFor(entry2);
        else if (!isRuntimeModule(materialize(entry2))) targetFor(entry2.name);
      }
      return bindModule(selected);
    },
    get json() {
      const json2 = {};
      const add = (prefix, module) => {
        for (const name of Object.keys(module)) {
          const value = module[name];
          const path = prefix === "" ? name : `${prefix}.${name}`;
          if (isRuntimeModule(value)) add(path, value);
          else json2[path] = Reflect.get(value, "json");
        }
      };
      add("", bindModule([...entries.values()].filter((entry2) => !entry2.private).map((entry2) => entry2.name)));
      return json2;
    }
  };
  return scopeValue.current;
}

// ../../../omp/packages/coding-agent/src/config/agent-manifest.ts
var CONTROL_LANE_NAMES = [
  "observe",
  "create",
  "steer",
  "end",
  "command",
  "rooms",
  "agents"
];
var AgentManifestError = class extends Error {
  constructor(filePath, detail) {
    super(`Invalid agent manifest: ${filePath}
${detail}`);
    this.filePath = filePath;
    this.name = "AgentManifestError";
  }
};
var SECTION_KEYS = [
  "identity",
  "engine",
  "capabilities",
  "gate",
  "memory",
  "workspace",
  "loop",
  "subagents",
  "routing"
];
var FLAT_ALIASES2 = [
  { flat: ["tools"], section: "capabilities", nested: "tools" },
  { flat: ["autoloadSkills"], section: "capabilities", nested: "autoloadSkills" },
  { flat: ["model"], section: "engine", nested: "model" },
  { flat: ["thinkingLevel", "thinking"], section: "engine", nested: "thinkingLevel" },
  { flat: ["spawns"], section: "subagents", nested: "allowed" },
  { flat: ["blocking"], section: "subagents", nested: "blocking" },
  { flat: ["readSummarize"], section: "subagents", nested: "readSummarize" }
];
var stringList = "string | string[]";
var identitySchema = type({
  "personality?": "'default' | 'friendly' | 'pragmatic' | 'none'",
  "prompt?": "'replace' | 'append'",
  "+": "reject"
});
var engineSchema = type({
  "model?": stringList,
  "thinkingLevel?": "string",
  // Record value-types are narrowed manually below (deterministic across arktype versions).
  "roles?": "object",
  "profile?": "string",
  "+": "reject"
});
var ignoreSchema = type({
  "tools?": stringList,
  "skills?": stringList,
  "mcp?": stringList,
  "plugins?": stringList,
  "slashCommands?": stringList,
  "+": "reject"
});
var capabilitiesSchema = type({
  "tools?": `'*' | ${stringList}`,
  "mcp?": `'*' | ${stringList}`,
  "plugins?": `'*' | ${stringList}`,
  "skills?": `'*' | ${stringList}`,
  "autoloadSkills?": `'*' | ${stringList}`,
  "slashCommands?": `'*' | ${stringList}`,
  "optIn?": stringList,
  "ignore?": ignoreSchema,
  "control?": "unknown",
  "+": "reject"
});
var gateSchema = type({
  "approval?": "'always-ask' | 'write' | 'yolo'",
  "policy?": "string",
  "+": "reject"
});
var memorySchema = type({
  "backend?": "string",
  // Removed field: accepted with ANY value so a leftover key loads the agent
  // and reports itself (a diagnostic) rather than being a hard parse error.
  // The value is never read.
  "vault?": "unknown",
  "namespace?": "string",
  "+": "reject"
});
var workspaceSchema = type({
  policy: "'bound' | 'home' | 'pinned' | 'ephemeral'",
  "id?": "string",
  // `none`/`all` are the two grant WORDS; anything else is a workspace-id list
  // (CSV or YAML), coerced like every other list-valued manifest field.
  "reach?": stringList,
  "+": "reject"
});
var eagerSchema = type({
  "task?": "'default' | 'preferred' | 'always'",
  "todo?": "'default' | 'preferred' | 'always'",
  "+": "reject"
});
var loopSchema = type({
  "eager?": eagerSchema,
  "maxTurns?": "number > 0",
  "+": "reject"
});
var routingTriggersSchema = type({
  mode: "'mentions' | 'keywords' | 'all'",
  "keywords?": stringList,
  "patterns?": stringList,
  "+": "reject"
});
var routingSchema = type({
  "triggers?": routingTriggersSchema,
  "card?": "string",
  "+": "reject"
});
var subagentsSchema = type({
  "allowed?": "'*' | string | string[]",
  "maxDepth?": "number > 0",
  "concurrency?": "number > 0",
  "blocking?": "boolean",
  "readSummarize?": "boolean",
  "+": "reject"
});
var SECTION_SCHEMAS = {
  identity: identitySchema,
  engine: engineSchema,
  capabilities: capabilitiesSchema,
  gate: gateSchema,
  memory: memorySchema,
  workspace: workspaceSchema,
  loop: loopSchema,
  subagents: subagentsSchema,
  routing: routingSchema
};
function toStringList(value) {
  if (value === void 0) return void 0;
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  if (typeof value === "string") {
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return void 0;
}
function narrowRoleRecord(value, filePath, where) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentManifestError(filePath, `${where} must be a map of role \u2192 model (string or ordered list)`);
  }
  for (const [key, entry2] of Object.entries(value)) {
    const ok = typeof entry2 === "string" || Array.isArray(entry2) && entry2.every((e) => typeof e === "string");
    if (!ok) {
      throw new AgentManifestError(filePath, `${where}.${key} must be a string or string[] (got ${typeof entry2})`);
    }
  }
  return value;
}
function assertInteger(value, filePath, where) {
  if (value !== void 0 && !Number.isInteger(value)) {
    throw new AgentManifestError(filePath, `${where} must be an integer (got ${value})`);
  }
}
var APPROVAL_LEVELS = ["always-ask", "write", "yolo"];
function narrowControlCapability(raw, filePath) {
  const objectForm = typeof raw === "object" && raw !== null && !Array.isArray(raw);
  const record = objectForm ? raw : void 0;
  if (record !== void 0) {
    for (const key of Object.keys(record)) {
      if (key !== "lanes" && key !== "approval") {
        throw new AgentManifestError(filePath, `capabilities.control: unknown key '${key}' (lanes, approval)`);
      }
    }
    if (record.lanes === void 0) {
      throw new AgentManifestError(filePath, `capabilities.control: the object form requires 'lanes'`);
    }
  }
  const list2 = toStringList(record !== void 0 ? record.lanes : raw);
  if (list2 === void 0) {
    throw new AgentManifestError(
      filePath,
      `capabilities.control must be a lane list (${CONTROL_LANE_NAMES.join(", ")}) or { lanes, approval }`
    );
  }
  const lanes = [];
  for (const entry2 of list2) {
    if (!CONTROL_LANE_NAMES.includes(entry2)) {
      throw new AgentManifestError(
        filePath,
        `capabilities.control: '${entry2}' is not a control lane (one of ${CONTROL_LANE_NAMES.join(", ")})`
      );
    }
    if (!lanes.includes(entry2)) lanes.push(entry2);
  }
  const resolved = { lanes };
  const approval = record?.approval;
  if (approval !== void 0) {
    if (typeof approval !== "object" || approval === null || Array.isArray(approval)) {
      throw new AgentManifestError(filePath, `capabilities.control.approval must be a map of lane \u2192 approval level`);
    }
    const narrowed = {};
    for (const [lane, level] of Object.entries(approval)) {
      if (!lanes.includes(lane)) {
        throw new AgentManifestError(
          filePath,
          `capabilities.control.approval names lane '${lane}', which is not in capabilities.control.lanes`
        );
      }
      if (!APPROVAL_LEVELS.includes(level)) {
        throw new AgentManifestError(
          filePath,
          `capabilities.control.approval.${lane} must be one of ${APPROVAL_LEVELS.join(", ")} (got ${JSON.stringify(level)})`
        );
      }
      narrowed[lane] = level;
    }
    resolved.approval = narrowed;
  }
  return resolved;
}
function narrowWorkspacePolicy(section, filePath) {
  const policy = section.policy;
  const namesWorkspace = policy === "home" || policy === "pinned";
  const id = typeof section.id === "string" ? section.id.trim() : void 0;
  if (namesWorkspace && !id) {
    throw new AgentManifestError(
      filePath,
      `workspace.id is required when policy is '${policy}' (the workspace id its sessions run in)`
    );
  }
  if (!namesWorkspace && section.id !== void 0) {
    throw new AgentManifestError(
      filePath,
      `workspace.id is only valid with policy 'home' or 'pinned' (got '${policy}')`
    );
  }
  const rawReach = section.reach;
  const reachList = rawReach === "none" || rawReach === "all" ? void 0 : toStringList(rawReach);
  let reach;
  if (rawReach === "none" || rawReach === "all") reach = rawReach;
  else if (reachList && reachList.length === 1 && (reachList[0] === "none" || reachList[0] === "all")) {
    reach = reachList[0];
  } else if (reachList?.some((entry2) => entry2 === "none" || entry2 === "all")) {
    throw new AgentManifestError(
      filePath,
      `workspace.reach mixes the grant word '${reachList.find((entry2) => entry2 === "none" || entry2 === "all")}' with workspace ids \u2014 write the word alone, or list only ids`
    );
  } else reach = reachList;
  const resolved = { policy };
  if (id !== void 0) resolved.id = id;
  if (reach !== void 0) resolved.reach = reach;
  return resolved;
}
function narrowOptIn(raw, filePath) {
  const names2 = [];
  for (const entry2 of toStringList(raw) ?? []) {
    const name = entry2.trim();
    if (name === "" || name === "*") {
      throw new AgentManifestError(
        filePath,
        `capabilities.optIn: ${JSON.stringify(entry2)} is not a plugin name \u2014 list the opt-in plugins this agent carries`
      );
    }
    if (!names2.includes(name)) names2.push(name);
  }
  return names2;
}
function narrowRouting(section, filePath) {
  const routing = {};
  const card = section.card;
  if (typeof card === "string") {
    if (card.trim() === "") throw new AgentManifestError(filePath, "routing.card must not be empty");
    routing.card = card.trim();
  }
  const triggers = section.triggers;
  if (typeof triggers === "object" && triggers !== null && "mode" in triggers) {
    const { mode } = triggers;
    if (mode !== "mentions" && mode !== "keywords" && mode !== "all") return routing;
    const narrowed = { mode };
    for (const field of ["keywords", "patterns"]) {
      const raw = field in triggers ? triggers[field] : void 0;
      const list2 = typeof raw === "string" ? field === "patterns" ? [raw] : raw.split(",") : toStringList(raw);
      if (list2 === void 0) continue;
      if (list2.some((entry2) => entry2.trim() === "")) {
        throw new AgentManifestError(filePath, `routing.triggers.${field} must not contain an empty entry`);
      }
      narrowed[field] = list2.map((entry2) => entry2.trim());
    }
    if (mode === "keywords" && !narrowed.keywords?.length && !narrowed.patterns?.length) {
      throw new AgentManifestError(filePath, "routing.triggers mode 'keywords' needs keywords or patterns");
    }
    routing.triggers = narrowed;
  }
  return routing;
}
var MEMORY_VAULT_REMOVED = {
  key: "memory.vault",
  message: "`memory.vault` was removed: the agent's `workspace.reach` decides which rooms it recalls from; delete the key"
};
function parseAgentManifest(frontmatter, filePath) {
  const present = SECTION_KEYS.filter((key) => frontmatter[key] !== void 0);
  const rawVersion = frontmatter.specVersion;
  const rawExtends = frontmatter.extends;
  const rawHarness = frontmatter.harness;
  const rawAllowedHarnesses = frontmatter.allowedHarnesses;
  if (present.length === 0 && rawVersion === void 0 && rawExtends === void 0 && rawHarness === void 0 && rawAllowedHarnesses === void 0) {
    return void 0;
  }
  if (rawVersion !== void 0 && rawVersion !== 1) {
    throw new AgentManifestError(
      filePath,
      `unsupported specVersion ${JSON.stringify(rawVersion)} \u2014 this parser supports 1`
    );
  }
  const extendsList = toStringList(rawExtends);
  if (rawExtends !== void 0 && (extendsList === void 0 || extendsList.some((name) => name.trim() === ""))) {
    throw new AgentManifestError(filePath, `'extends' must be an agent name or a list of agent names`);
  }
  if (rawHarness !== void 0 && (typeof rawHarness !== "string" || rawHarness.trim() === "")) {
    throw new AgentManifestError(filePath, `'harness' must be a harness id (a non-empty string)`);
  }
  const allowedHarnesses = toStringList(rawAllowedHarnesses);
  if (rawAllowedHarnesses !== void 0 && (allowedHarnesses === void 0 || allowedHarnesses.some((name) => name.trim() === ""))) {
    throw new AgentManifestError(filePath, `'allowedHarnesses' must be a harness id or a list of harness ids`);
  }
  const sections = {};
  for (const key of present) {
    const raw = frontmatter[key];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new AgentManifestError(filePath, `section '${key}' must be a YAML mapping`);
    }
    const validated = SECTION_SCHEMAS[key](raw);
    if (validated instanceof type.errors) {
      throw new AgentManifestError(filePath, `section '${key}': ${validated.summary}`);
    }
    sections[key] = validated;
  }
  for (const alias of FLAT_ALIASES2) {
    const flatKey = alias.flat.find((key) => frontmatter[key] !== void 0);
    const nestedValue = sections[alias.section]?.[alias.nested];
    if (flatKey !== void 0 && nestedValue !== void 0) {
      throw new AgentManifestError(
        filePath,
        `both '${flatKey}' and '${alias.section}.${alias.nested}' set \u2014 use one`
      );
    }
  }
  const enrichedFrontmatter = { ...frontmatter };
  for (const alias of FLAT_ALIASES2) {
    const nestedValue = sections[alias.section]?.[alias.nested];
    if (nestedValue === void 0) continue;
    if (nestedValue === "*" && alias.section === "capabilities") continue;
    enrichedFrontmatter[alias.flat[0]] = nestedValue;
  }
  for (const alias of FLAT_ALIASES2) {
    const flatKey = alias.flat.find((key) => frontmatter[key] !== void 0);
    if (flatKey === void 0) continue;
    sections[alias.section] = { ...sections[alias.section], [alias.nested]: frontmatter[flatKey] };
  }
  const manifest = rawVersion !== void 0 ? { specVersion: 1 } : {};
  if (extendsList !== void 0) manifest.extends = extendsList;
  if (typeof rawHarness === "string") manifest.harness = rawHarness.trim();
  if (allowedHarnesses !== void 0) manifest.allowedHarnesses = allowedHarnesses;
  if (sections.identity) manifest.identity = sections.identity;
  if (sections.engine) {
    const roles = sections.engine.roles;
    manifest.engine = {
      model: toStringList(sections.engine.model),
      // Raw string here; parseAgentFields owns ThinkingLevel parsing — synced back later.
      thinkingLevel: void 0,
      roles: roles !== void 0 ? narrowRoleRecord(roles, filePath, "engine.roles") : void 0,
      profile: typeof sections.engine.profile === "string" && sections.engine.profile.length > 0 ? sections.engine.profile : void 0
    };
  }
  if (sections.capabilities) {
    const rawIgnore = sections.capabilities.ignore;
    const starOrList = (value) => value === "*" ? "*" : toStringList(value);
    manifest.capabilities = {
      tools: starOrList(sections.capabilities.tools),
      mcp: starOrList(sections.capabilities.mcp),
      plugins: starOrList(sections.capabilities.plugins),
      skills: starOrList(sections.capabilities.skills),
      autoloadSkills: starOrList(sections.capabilities.autoloadSkills),
      slashCommands: starOrList(sections.capabilities.slashCommands)
    };
    if (sections.capabilities.optIn !== void 0) {
      manifest.capabilities.optIn = narrowOptIn(sections.capabilities.optIn, filePath);
    }
    if (rawIgnore !== void 0 && typeof rawIgnore === "object" && rawIgnore !== null) {
      manifest.capabilities.ignore = {
        tools: toStringList("tools" in rawIgnore ? rawIgnore.tools : void 0),
        skills: toStringList("skills" in rawIgnore ? rawIgnore.skills : void 0),
        mcp: toStringList("mcp" in rawIgnore ? rawIgnore.mcp : void 0),
        plugins: toStringList("plugins" in rawIgnore ? rawIgnore.plugins : void 0),
        slashCommands: toStringList("slashCommands" in rawIgnore ? rawIgnore.slashCommands : void 0)
      };
    }
    if (sections.capabilities.control !== void 0) {
      manifest.capabilities.control = narrowControlCapability(sections.capabilities.control, filePath);
    }
  }
  if (sections.gate) manifest.gate = sections.gate;
  const diagnostics = [];
  if (sections.memory) {
    const { backend, namespace } = sections.memory;
    manifest.memory = {
      ...backend !== void 0 ? { backend } : {},
      ...namespace !== void 0 ? { namespace } : {}
    };
    if ("vault" in sections.memory) diagnostics.push(MEMORY_VAULT_REMOVED);
  }
  if (sections.workspace) manifest.workspace = narrowWorkspacePolicy(sections.workspace, filePath);
  if (sections.loop) {
    const loop = sections.loop;
    assertInteger(loop.maxTurns, filePath, "loop.maxTurns");
    manifest.loop = loop;
  }
  if (sections.subagents) {
    const subagents = sections.subagents;
    assertInteger(subagents.maxDepth, filePath, "subagents.maxDepth");
    assertInteger(subagents.concurrency, filePath, "subagents.concurrency");
    manifest.subagents = {
      allowed: subagents.allowed === "*" ? "*" : toStringList(subagents.allowed),
      maxDepth: subagents.maxDepth,
      concurrency: subagents.concurrency,
      blocking: subagents.blocking,
      readSummarize: subagents.readSummarize
    };
  }
  if (sections.routing) manifest.routing = narrowRouting(sections.routing, filePath);
  return { manifest, enrichedFrontmatter, diagnostics };
}

// ../../../packages/sdk/src/general-agent/index.ts
import { parse as parseYaml } from "yaml";

// ../../../packages/sdk/src/assembly/assembly-contracts.ts
var AVATAR_ID_PART = /^[a-z0-9-]+$/;

// ../../../packages/sdk/src/frontmatter.ts
function splitFrontmatter(content) {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return null;
  const frontmatter = content.slice(content.indexOf("\n") + 1, end);
  const body = content.slice(content.indexOf("\n", end + 1) + 1);
  return { frontmatter, body };
}

// ../../../packages/sdk/src/general-agent/index.ts
var GENERAL_AGENTS_DIR = "general-agents";
var GENERAL_AGENT_FILE = "agent.md";
function agentHomeWorkspaceId(agent) {
  return `home-${agent}`;
}
function derivesAgentHome(agent, workspaceId) {
  return workspaceId === void 0 || workspaceId === agentHomeWorkspaceId(agent);
}
function isAvatarId(id) {
  if (!id.startsWith("plugin:")) return AVATAR_ID_PART.test(id);
  const halves = id.slice("plugin:".length).split("/");
  return halves.length === 2 && halves.every((half) => AVATAR_ID_PART.test(half));
}
function parseAvatar(value, errors) {
  if (value === void 0) return void 0;
  const spec = typeof value === "string" ? { id: value } : value;
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    errors.push("avatar must be an avatar id or { id, skin?, accent? }");
    return void 0;
  }
  const { id, skin, accent, ...rest } = spec;
  const extra = Object.keys(rest);
  if (extra.length > 0) errors.push(`avatar has unknown key(s) ${extra.join(", ")} \u2014 expected id, skin, accent`);
  if (typeof id !== "string" || !isAvatarId(id)) {
    errors.push(
      `avatar.id must be a first-party avatar name (e.g. "mochi") or "plugin:<plugin>/<id>", got ${JSON.stringify(id)}`
    );
  }
  for (const [key, tone] of [
    ["skin", skin],
    ["accent", accent]
  ]) {
    if (tone !== void 0 && (typeof tone !== "string" || !AVATAR_ID_PART.test(tone))) {
      errors.push(`avatar.${key} must be a lowercase slug, got ${JSON.stringify(tone)}`);
    }
  }
  if (typeof id !== "string") return void 0;
  return {
    id,
    ...typeof skin === "string" ? { skin } : {},
    ...typeof accent === "string" ? { accent } : {}
  };
}
function generalAgentRouting(manifest, description) {
  const card = manifest.routing?.card ?? (description.trim() || void 0);
  const triggers = manifest.routing?.triggers;
  if (!card && !triggers) return void 0;
  return { ...triggers ? { triggers } : {}, ...card ? { card } : {} };
}
function rejected(reason, ...errors) {
  return { ok: false, reason, errors };
}
function parseGeneralAgent(content, filePath, dirName) {
  const parts = splitFrontmatter(content);
  if (parts === null) return rejected("not-a-manifest", "missing YAML frontmatter (--- ... ---)");
  let parsedYaml;
  try {
    parsedYaml = parseYaml(parts.frontmatter);
  } catch (error) {
    return rejected("invalid", `frontmatter YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsedYaml !== "object" || parsedYaml === null || Array.isArray(parsedYaml)) {
    return rejected("not-a-manifest", "frontmatter is not a YAML mapping");
  }
  const raw = parsedYaml;
  const autonomy = raw.autonomy;
  if (typeof autonomy === "object" && autonomy !== null && "trigger" in autonomy && autonomy.trigger !== void 0) {
    return rejected("loop", "declares autonomy.trigger \u2014 a retired Loop manifest (doc 78), not a General Agent");
  }
  let manifest;
  try {
    const parsed = parseAgentManifest(raw, filePath);
    if (parsed === void 0) {
      return rejected("not-a-manifest", "declares no agent manifest (specVersion or a manifest section)");
    }
    manifest = parsed.manifest;
  } catch (error) {
    return rejected("invalid", error instanceof Error ? error.message : String(error));
  }
  const errors = [];
  if (raw.name !== void 0 && typeof raw.name !== "string") errors.push("name must be a string");
  const name = typeof raw.name === "string" ? raw.name : dirName;
  if (name !== dirName)
    errors.push(`name ${JSON.stringify(name)} must equal its directory ${JSON.stringify(dirName)}`);
  if (raw.description !== void 0 && typeof raw.description !== "string") {
    errors.push("description must be a string");
  }
  if (raw.defaultEnabled !== void 0 && typeof raw.defaultEnabled !== "boolean") {
    errors.push("defaultEnabled must be a boolean");
  }
  if (raw.defaultListed !== void 0 && typeof raw.defaultListed !== "boolean") {
    errors.push("defaultListed must be a boolean");
  }
  if (raw.title !== void 0 && (typeof raw.title !== "string" || raw.title.trim() === "")) {
    errors.push("title must be a non-empty string");
  }
  const avatar = parseAvatar(raw.avatar, errors);
  if (errors.length > 0) return rejected("invalid", ...errors);
  const description = typeof raw.description === "string" ? raw.description : "";
  const routing = generalAgentRouting(manifest, description);
  return {
    ok: true,
    decl: {
      name,
      description,
      defaultEnabled: typeof raw.defaultEnabled === "boolean" ? raw.defaultEnabled : true,
      defaultListed: typeof raw.defaultListed === "boolean" ? raw.defaultListed : true,
      // One line on every surface that shows it (a chip, a menu row).
      ...typeof raw.title === "string" ? { title: raw.title.trim().replace(/\s+/g, " ") } : {},
      ...avatar ? { avatar } : {},
      ...routing ? { routing } : {},
      manifest,
      body: parts.body.trim()
    }
  };
}

// src/store.ts
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { parse as parseYaml2, stringify as stringifyYaml } from "yaml";
var WRITE_DIR = process.env.PI_CONFIG_DIR?.trim() || ".inso";
var LEGACY_DIR = ".omp";
function pathsOf(home) {
  if (home === null) return null;
  return {
    plugins: join(home, "plugins"),
    /** The agent dir: skills, settings — and `agents/`, the user tier. */
    agent: join(home, "agent"),
    userAgents: join(home, "agent", "agents"),
    /** `<home>/workspaces`: every agent home (`home-<name>`) — the engine pins `PI_AGENT_HOMES_DIR` here. */
    homes: join(home, "workspaces")
  };
}
async function installedPluginRoots(pluginsDir) {
  const roots = /* @__PURE__ */ new Map();
  const modules = join(pluginsDir, "node_modules");
  for (const entry2 of await listDirs(modules)) {
    if (entry2.startsWith("@")) {
      for (const scoped of await listDirs(join(modules, entry2))) roots.set(`${entry2}/${scoped}`, join(modules, entry2, scoped));
    } else if (!entry2.startsWith(".")) roots.set(entry2, join(modules, entry2));
  }
  try {
    const installed = JSON.parse(await readFile(join(pluginsDir, "installed_plugins.json"), "utf8"));
    for (const [id, entries] of Object.entries(installed.plugins ?? {})) {
      const installPath = entries.find((entry2) => typeof entry2.installPath === "string")?.installPath;
      if (typeof installPath === "string" && !roots.has(id)) roots.set(id, installPath);
    }
  } catch {
  }
  return roots;
}
async function listDirs(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry2) => entry2.isDirectory() || entry2.isSymbolicLink()).map((entry2) => entry2.name);
}
var RETIRED_PATHS = { "memory.vault": true };
function frontmatterOf(content) {
  if (!content.startsWith("---")) return "";
  const end = content.indexOf("\n---", 3);
  return end < 0 ? "" : content.slice(content.indexOf("\n") + 1, end);
}
function isPlainAvatar(avatar) {
  return avatar.skin === void 0 && avatar.accent === void 0;
}
function heldPaths(decl, raw, blocks) {
  const held = /* @__PURE__ */ new Set();
  const { manifest, avatar } = decl;
  if (avatar !== void 0 && !isPlainAvatar(avatar)) held.add("avatar");
  if (raw.voice !== void 0 && !(typeof raw.voice === "string" && VOICE_NAME_RE.test(raw.voice))) held.add("voice");
  const level = raw.thinkingLevel;
  if (level !== void 0 && (level === "inherit" || !THINKING_STEPS.includes(String(level)))) held.add("engine.thinkingLevel");
  const backend = manifest.memory?.backend;
  if (backend !== void 0 && (backend === "inherit" || !MEMORY_BACKENDS.includes(backend))) held.add("memory.backend");
  const model = manifest.engine?.model;
  if (model !== void 0 && (!Array.isArray(model) || model.length === 0)) held.add("engine.model");
  for (const key of ["tools", "skills", "mcp"]) {
    const value = manifest.capabilities?.[key];
    if (value === "*" || Array.isArray(value) && value.length === 0) held.add(`capabilities.${key}`);
  }
  const workspace = manifest.workspace;
  if (workspace !== void 0) {
    const ownHome = workspace.policy === "home" && (workspace.id === agentHomeWorkspaceId(decl.name) || workspace.id === `agent-${decl.name}`);
    const policyDrawn = workspace.policy === void 0 || HABITATS.includes(workspace.policy);
    if (!policyDrawn || workspace.id !== void 0 && !ownHome) {
      held.add("workspace.policy");
      held.add("workspace.id");
    }
    const reach = workspace.reach;
    if (reach !== void 0 && reach !== "none" && !(reach === "all" && backend !== "off")) held.add("workspace.reach");
  }
  for (const block of blocks) {
    const canonical = FLAT_ALIASES[block.key];
    if (canonical !== void 0) held.add(canonical);
  }
  return held;
}
function rawSettings(frontmatter) {
  const parsed = parseYaml2(frontmatter);
  if (!isRecord(parsed)) return { thinkingLevel: void 0, voice: void 0 };
  const engine = parsed.engine;
  return { thinkingLevel: isRecord(engine) ? engine.thinkingLevel : void 0, voice: parsed.voice };
}
function sectionChildren(block) {
  if (block.children !== null) return block.children.map((child) => ({ key: child.key, lines: reindent(child.lines, block.childIndent, 2) }));
  if (block.inline === "") return [];
  const value = parseYaml2(block.inline);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.entries(value).map(([key, setting]) => ({
    key,
    lines: stringifyYaml({ [key]: setting }).trimEnd().split("\n").map((text) => `  ${text}`)
  }));
}
function draftFromFile(decl, content, key) {
  const manifest = decl.manifest;
  const frontmatter = frontmatterOf(content);
  const blocks = parseExtra(frontmatter).blocks;
  const raw = rawSettings(frontmatter);
  const held = heldPaths(decl, raw, blocks);
  const pieces = [];
  for (const block of blocks) {
    const drawn = DRAWN_CHILDREN[block.key];
    if (block.key === "avatar") {
      if (held.has("avatar")) pieces.push(...block.lines);
    } else if (block.key === "voice") {
      if (held.has("voice")) pieces.push(...block.lines);
    } else if (drawn !== void 0) {
      const kept = sectionChildren(block).filter((child) => {
        const path = `${block.key}.${child.key}`;
        return RETIRED_PATHS[path] === void 0 && (!drawn.includes(child.key) || held.has(path));
      });
      if (kept.length > 0) pieces.push(`${block.key}:`, ...kept.flatMap((child) => child.lines));
    } else if (!["name", "description", "specVersion", "extends"].includes(block.key)) pieces.push(...block.lines);
  }
  const drawnOr = (path, value, fallback2) => held.has(path) || value === void 0 ? fallback2 : value;
  const backend = manifest.memory?.backend;
  const memory = drawnOr("memory.backend", backend, "inherit");
  const reach = manifest.workspace?.reach;
  const memoryScope = !held.has("workspace.reach") && reach === "all" && memory !== "off" ? "global" : "project";
  const policy = manifest.workspace?.policy;
  const habitat = drawnOr("workspace.policy", policy, "bound");
  return {
    key,
    name: decl.name,
    description: decl.description,
    vibr: decl.avatar !== void 0 && isPlainAvatar(decl.avatar) ? decl.avatar.id : "",
    voice: typeof raw.voice === "string" && !held.has("voice") ? raw.voice : "",
    personality: manifest.identity?.personality ?? "default",
    promptMode: manifest.identity?.prompt ?? "replace",
    thinking: drawnOr("engine.thinkingLevel", raw.thinkingLevel, "inherit"),
    models: held.has("engine.model") ? [] : allowlist(manifest.engine?.model),
    tools: held.has("capabilities.tools") ? [] : allowlist(manifest.capabilities?.tools),
    skills: held.has("capabilities.skills") ? [] : allowlist(manifest.capabilities?.skills),
    mcp: held.has("capabilities.mcp") ? [] : allowlist(manifest.capabilities?.mcp),
    memory,
    memoryScope,
    // An absent approval INHERITS the host's; it stays absent until a human picks one.
    approval: manifest.gate?.approval ?? "inherit",
    habitat,
    lineage: [...manifest.extends ?? []],
    charter: decl.body,
    extra: pieces.join("\n")
  };
}
function allowlist(value) {
  return Array.isArray(value) ? [...value] : [];
}
function revisionOf(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
async function scanAgents(dir, notices) {
  const found = [];
  for (const name of await listDirs(dir)) {
    const path = join(dir, name, GENERAL_AGENT_FILE);
    let content;
    try {
      content = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const parsed = parseGeneralAgent(content, path, name);
    if (parsed.ok) found.push({ name, path, content, decl: parsed.decl });
    else if (parsed.reason === "invalid") notices.push(`${path} is not a valid General Agent: ${parsed.errors.join("; ")}`);
  }
  return found;
}
async function listAgents(roots) {
  const notices = [];
  const agents = [];
  const claimed = /* @__PURE__ */ new Map();
  const claim = (found) => {
    const winner = claimed.get(found.name);
    if (winner !== void 0) {
      notices.push(`${found.path} is shadowed by ${winner} (same name "${found.name}").`);
      return false;
    }
    claimed.set(found.name, found.path);
    return true;
  };
  const paths = pathsOf(roots.home);
  if (paths === null) notices.push("Pack and user agents are not listed: the engine did not tell this server where its home is (INSO_HOME is unset).");
  else {
    for (const [pack, root] of await installedPluginRoots(paths.plugins)) {
      for (const found of await scanAgents(join(root, GENERAL_AGENTS_DIR), notices)) {
        if (!claim(found)) continue;
        agents.push({
          name: found.name,
          description: found.decl.description,
          source: "pack",
          pack,
          path: found.path,
          editable: false,
          readOnlyReason: `It ships in the ${pack} pack. Extend it to make your own.`,
          ...found.decl.manifest.workspace?.id !== void 0 ? { workspaceId: found.decl.manifest.workspace.id } : {},
          draft: draftFromFile(found.decl, found.content, `pack:${pack}:${found.name}`)
        });
      }
    }
  }
  if (roots.workspace === null) {
    notices.push(roots.workspaceMissing ?? "No workspace is bound, so project agents are not listed. Pack agents and yours are.");
  } else {
    for (const dirName of [WRITE_DIR, LEGACY_DIR]) {
      for (const found of await scanAgents(join(roots.workspace, dirName, "agents"), notices)) {
        if (!claim(found)) continue;
        const legacy = dirName === LEGACY_DIR;
        agents.push({
          name: found.name,
          description: found.decl.description,
          source: "workspace",
          path: found.path,
          editable: !legacy,
          ...legacy ? { readOnlyReason: `It lives in the legacy ${LEGACY_DIR}/agents; new agents are written only to ${WRITE_DIR}/agents.` } : {},
          revision: revisionOf(found.content),
          ...found.decl.manifest.workspace?.id !== void 0 ? { workspaceId: found.decl.manifest.workspace.id } : {},
          draft: draftFromFile(found.decl, found.content, `workspace::${found.name}`)
        });
      }
    }
  }
  if (paths !== null) {
    for (const found of await scanAgents(paths.userAgents, notices)) {
      if (!claim(found)) continue;
      agents.push({
        name: found.name,
        description: found.decl.description,
        source: "user",
        path: found.path,
        editable: true,
        revision: revisionOf(found.content),
        ...found.decl.manifest.workspace?.id !== void 0 ? { workspaceId: found.decl.manifest.workspace.id } : {},
        draft: draftFromFile(found.decl, found.content, `user::${found.name}`)
      });
    }
  }
  return { workspace: roots.workspace, configDir: WRITE_DIR, userAgentsDir: paths?.userAgents ?? null, agents, notices };
}
var SaveRefused = class extends Error {
  name = "SaveRefused";
};
function renderDraft(draft, path) {
  const problems = draftProblems(draft);
  if (problems.length > 0) return { problems };
  const content = toAgentMd(draft, agentHomeWorkspaceId(draft.name));
  const parsed = parseGeneralAgent(content, path, draft.name);
  if (!parsed.ok) return { problems: [`The agent.md would not load as a General Agent (${parsed.reason}): ${parsed.errors.join("; ")}`] };
  return { content };
}
var slash = (path) => path.replaceAll("\\", "/");
async function saveAgent(options) {
  const { roots, draft, target } = options;
  const paths = pathsOf(roots.home);
  const tier = target.create ? "user" : target.tier;
  const tierRoot = tier === "user" ? roots.home : roots.workspace;
  const agentsDir = tier === "user" ? paths?.userAgents : roots.workspace === null ? void 0 : join(roots.workspace, WRITE_DIR, "agents");
  if (tierRoot === null || agentsDir === void 0) {
    throw new SaveRefused(
      tier === "user" ? "The user tier cannot be reached: the engine did not tell this server where its home is (INSO_HOME is unset)." : "No workspace is bound, so its project agents cannot be rewritten."
    );
  }
  const dir = join(agentsDir, draft.name);
  const path = join(dir, GENERAL_AGENT_FILE);
  const rendered = renderDraft(draft, path);
  if ("problems" in rendered) throw new SaveRefused(rendered.problems.join(" "));
  const { content } = rendered;
  if (target.create) {
    const taken = (await listAgents(roots)).agents.find((agent) => agent.name === draft.name);
    if (taken !== void 0) {
      throw new SaveRefused(`An agent named "${draft.name}" already exists (${taken.source === "pack" ? `the ${taken.pack} pack ships it` : `${taken.source} agent at ${taken.path}`}). Pick another name.`);
    }
    await mkdir(agentsDir, { recursive: true });
    try {
      await mkdir(dir);
    } catch (error) {
      if (error.code === "EEXIST") throw new SaveRefused(`${slash(relative(tierRoot, dir))} already exists. Pick another name.`);
      throw error;
    }
  } else {
    let existing;
    try {
      existing = await readFile(path, "utf8");
    } catch {
      throw new SaveRefused(`There is no ${slash(relative(tierRoot, path))} to update. Create it as a new agent.`);
    }
    const current = parseGeneralAgent(existing, path, draft.name);
    if (!current.ok) {
      throw new SaveRefused(
        current.reason === "loop" ? `${draft.name} is a Loop, not a General Agent, and a Loop is never rewritten here.` : `${draft.name}'s agent.md does not parse (${current.errors.join("; ")}); fix it by hand first.`
      );
    }
    if (revisionOf(existing) !== target.revision) {
      throw new SaveRefused(`${draft.name}'s agent.md changed on disk since it was opened here; reopen it so nothing written since is lost.`);
    }
  }
  const temp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    if (target.create) await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return { path, relativePath: slash(relative(tierRoot, path)), created: target.create, tier };
}

// src/home.ts
var AGENTS_MD = "AGENTS.md";
var INSTRUCTIONS_MAX_BYTES = 2e5;
async function statFile(path) {
  try {
    const info = await stat(path);
    return { exists: info.isFile(), bytes: info.isFile() ? info.size : 0 };
  } catch {
    return { exists: false, bytes: 0 };
  }
}
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
async function contentOf(path) {
  try {
    return await readFile2(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}
function candidatesFor(roots, source, name, agentFile) {
  const sibling = { kind: source === "pack" ? "pack" : "agent-dir", path: join2(dirname(agentFile), AGENTS_MD) };
  if (source === "workspace") return [sibling];
  const homes = pathsOf(roots.home)?.homes;
  const home = homes === void 0 ? [] : [{ kind: "home", path: join2(homes, agentHomeWorkspaceId(name), AGENTS_MD) }];
  if (source === "user") return [...home, sibling];
  const projectDirs = roots.workspace === null ? [] : [.../* @__PURE__ */ new Set([WRITE_DIR, LEGACY_DIR])].map((dir) => join2(roots.workspace, dir, "agents"));
  return [...projectDirs.map((dir) => ({ kind: "workspace-copy", path: join2(dir, name, AGENTS_MD) })), ...home, sibling];
}
async function resolveInstructions(roots, source, name, agentFile) {
  const candidates = candidatesFor(roots, source, name, agentFile);
  const stats = await Promise.all(candidates.map((candidate) => statFile(candidate.path)));
  let winner = -1;
  for (const [index, candidate] of candidates.entries()) {
    const { exists, bytes } = stats[index] ?? { exists: false, bytes: 0 };
    const isSibling = index === candidates.length - 1;
    const holds = candidate.kind === "workspace-copy" ? exists : candidate.kind === "home" ? exists && bytes > 0 : isSibling && exists;
    if (holds) {
      winner = index;
      break;
    }
  }
  const files = candidates.map((candidate, index) => ({ ...candidate, ...stats[index] ?? { exists: false, bytes: 0 }, wins: index === winner }));
  const text = winner < 0 ? "" : await readFile2(candidates[winner]?.path ?? "", "utf8");
  return { files, text };
}
var TIER_RULES = {
  pack: "A pack agent runs by the first of these that applies: a project's own copy (any file there counts), then its home AGENTS.md when it is not empty, then the AGENTS.md its pack ships.",
  user: "Your agent runs by its home AGENTS.md when that is not empty (it follows the agent into every project), else by the AGENTS.md beside its agent.md.",
  workspace: "A project agent has no home: it runs by the AGENTS.md beside its agent.md, in this project."
};
async function describeHome(roots, name) {
  const listed = (await listAgents(roots)).agents.find((agent) => agent.name === name);
  const source = listed?.source ?? "user";
  const paths = pathsOf(roots.home);
  const homeId = agentHomeWorkspaceId(name);
  const canStandAtHome = source !== "workspace";
  const foreign = !derivesAgentHome(name, listed?.workspaceId);
  const hasHome = canStandAtHome && !foreign;
  const folder = canStandAtHome && paths !== null ? join2(paths.homes, homeId) : null;
  const agentFile = listed?.path ?? join2(paths?.userAgents ?? "", name, GENERAL_AGENT_FILE);
  const { files, text } = await resolveInstructions(roots, source, name, agentFile);
  const folderExists = folder !== null && await isDirectory(folder);
  let homeNote;
  if (!canStandAtHome) homeNote = "A project agent belongs to one project, so it has no home of its own.";
  else if (listed?.workspaceId === `agent-${name}`) {
    homeNote = `Its file names "${listed.workspaceId}" as its workspace, an id no registry knows (an older version of this page wrote it). Save it with Where it runs set to Its own home and it stands in ${homeId}.`;
  } else if (foreign) homeNote = `It names its own workspace, "${listed?.workspaceId}", so it runs there and has no home of its own.`;
  else if (paths === null) homeNote = `Its home is ${homeId}; where that lives is unknown, as the engine did not say where its home is.`;
  else homeNote = folderExists ? `Its home is ${homeId}; the folder exists.` : `Its home is ${homeId}; the engine creates the folder the first time the agent is opened, seeding it from the AGENTS.md beside agent.md.`;
  const editable = listed === void 0 ? false : listed.editable;
  const targetFile = listed === void 0 || !listed.editable ? null : source === "user" && folderExists ? { path: join2(folder ?? "", AGENTS_MD), kind: "home" } : { path: join2(dirname(listed.path), AGENTS_MD), kind: "agent-dir" };
  let target = null;
  if (targetFile !== null) {
    const current = targetFile.path === files.find((file) => file.wins)?.path ? text : await contentOf(targetFile.path);
    target = { ...targetFile, revision: revisionOf(`${targetFile.path}\0${current}`) };
  }
  const note = listed === void 0 ? `${TIER_RULES.user} Save the agent first; its standing instructions can be written once it exists.` : listed.editable ? `${TIER_RULES[source]} A save writes ${target?.kind === "home" ? "the home AGENTS.md" : "the AGENTS.md beside agent.md, which seeds the home on its first provisioning"}.` : `${TIER_RULES[source]} ${listed.readOnlyReason ?? "It is read-only here."}`;
  return {
    name,
    exists: listed !== void 0,
    source,
    homeId,
    canStandAtHome,
    hasHome,
    homeNote,
    folder: hasHome ? folder : null,
    folderExists: hasHome && folderExists,
    memoryRoom: foreign && listed?.workspaceId !== void 0 ? listed.workspaceId : homeId,
    instructions: { files, text, editable, note, target }
  };
}
async function saveInstructions(roots, name, text, revision) {
  if (Buffer.byteLength(text) > INSTRUCTIONS_MAX_BYTES) throw new SaveRefused(`The instructions are over ${INSTRUCTIONS_MAX_BYTES / 1e3} KB; a standing prompt should be far shorter.`);
  const { instructions } = await describeHome(roots, name);
  const { target } = instructions;
  if (target === null) throw new SaveRefused(instructions.editable ? `No agent named "${name}".` : instructions.note);
  if (target.revision !== revision) {
    throw new SaveRefused(`${name}'s standing instructions changed since they were opened here: the file was edited elsewhere, or its home was set up since, so a save would land somewhere else. Reopen them so nothing written since is lost.`);
  }
  const temp = join2(dirname(target.path), `.${basename2(target.path)}.${process.pid}.${randomBytes2(6).toString("hex")}.tmp`);
  try {
    await mkdir2(dirname(target.path), { recursive: true });
    await writeFile2(temp, text === "" || text.endsWith("\n") ? text : `${text}
`, { encoding: "utf8", flag: "wx" });
    await rename2(temp, target.path);
  } catch (error) {
    await rm2(temp, { force: true });
    throw error;
  }
  return { path: target.path, kind: target.kind };
}

// src/parts.ts
import { readdir as readdir2, readFile as readFile3 } from "node:fs/promises";
import { join as join3 } from "node:path";
import { parse as parseYaml3 } from "yaml";
var PACK_MCP_FILES = ["mcp.json", "ai.insodimension.dimension/mcp.json", ".mcp.json"];
async function skillsIn(dir) {
  let names2;
  try {
    names2 = (await readdir2(dir, { withFileTypes: true })).filter((entry2) => entry2.isDirectory() || entry2.isSymbolicLink()).map((entry2) => entry2.name);
  } catch {
    return [];
  }
  const skills = [];
  for (const name of names2) {
    let text;
    try {
      text = await readFile3(join3(dir, name, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    let front = {};
    try {
      const parsed = match ? parseYaml3(match[1] ?? "") : null;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) front = parsed;
    } catch {
    }
    skills.push({
      id: typeof front.name === "string" && front.name.trim() !== "" ? front.name : name,
      description: typeof front.description === "string" ? front.description : ""
    });
  }
  return skills;
}
async function mcpServersIn(file) {
  try {
    const parsed = JSON.parse(await readFile3(file, "utf8"));
    return typeof parsed.mcpServers === "object" && parsed.mcpServers !== null ? Object.keys(parsed.mcpServers) : [];
  } catch {
    return [];
  }
}
function hintOf(text, from) {
  const line = text.split("\n")[0]?.trim() ?? "";
  const short = line.length > 90 ? `${line.slice(0, 89)}\u2026` : line;
  return short === "" ? from : `${short} (${from})`;
}
async function listParts(options) {
  const parts = [];
  const sources = [];
  const omitted = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (part) => {
    const key = `${part.kind}:${part.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(part);
  };
  const skillRoots = [];
  const mcpFiles = [];
  if (options.workspace !== null) {
    for (const dir of [".inso", ".omp"]) skillRoots.push({ label: `workspace ${dir}/skills`, dir: join3(options.workspace, dir, "skills") });
    for (const file of [".inso/mcp.json", ".omp/mcp.json", ".mcp.json"]) mcpFiles.push({ label: `workspace ${file}`, dir: join3(options.workspace, file) });
  } else omitted.push("Workspace skills and MCP servers: no workspace is known.");
  if (options.agentDir !== null) {
    skillRoots.push({ label: "your skills", dir: join3(options.agentDir, "skills") });
    mcpFiles.push({ label: "your mcp.json", dir: join3(options.agentDir, "mcp.json") });
  }
  if (options.pluginsDir !== null) {
    for (const [pack, root] of await installedPluginRoots(options.pluginsDir)) {
      skillRoots.push({ label: `the ${pack} pack`, dir: join3(root, "skills") });
      for (const file of PACK_MCP_FILES) mcpFiles.push({ label: `the ${pack} pack`, dir: join3(root, file) });
    }
  }
  if (options.agentDir === null || options.pluginsDir === null) {
    omitted.push("Your own and installed packs' skills and MCP servers: the engine did not pass INSO_HOME.");
  }
  for (const root of skillRoots) {
    const skills = await skillsIn(root.dir);
    if (skills.length > 0) sources.push(`skills: ${root.dir}`);
    for (const skill of skills) add({ kind: "skill", id: skill.id, label: skill.id, hint: hintOf(skill.description, root.label) });
  }
  for (const file of mcpFiles) {
    const servers = await mcpServersIn(file.dir);
    if (servers.length > 0) sources.push(`mcp: ${file.dir}`);
    for (const server2 of servers) add({ kind: "mcp", id: server2, label: server2, hint: file.label });
  }
  const users = /* @__PURE__ */ new Map();
  for (const agent of options.agents) for (const tool of agent.draft.tools) users.set(tool, [...users.get(tool) ?? [], agent.name]);
  for (const [tool, names2] of users) add({ kind: "tool", id: tool, label: tool, hint: `Used by ${names2.join(", ")}` });
  if (users.size > 0) sources.push("tools: the capabilities.tools of the agents listed");
  omitted.push("The full tool list: the host exposes no tool registry to Apps, so only tools an existing agent already names are offered.");
  for (const backend of MEMORY_BACKENDS) {
    if (backend !== "inherit") add({ kind: "memory", id: backend, label: backend === "off" ? "No memory" : backend, hint: `memory.backend: ${backend}` });
  }
  sources.push("memory: the backends the agent.md serializer writes");
  return { parts, sources, omitted };
}

// src/server.ts
var SESSION_META_KEY = "ai.insodimension/session";
var APP_ONLY = { ui: { visibility: ["app"] } };
var MODEL_ONLY = { ui: { visibility: ["model"] } };
var READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
var MAX_PROPOSALS = 32;
var entry = z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/, "one line");
var names = z.array(entry).max(64);
var agentName = z.string().regex(NAME_RE, "2\u201364 lowercase letters, digits or dashes");
var draftSchema = z.object({
  key: z.string().min(1).max(200),
  name: z.string().max(64),
  description: z.string().max(400),
  vibr: z.string().max(120),
  voice: z.string().max(120).default(""),
  personality: z.enum(PERSONALITIES),
  promptMode: z.enum(PROMPT_MODES),
  thinking: z.enum(THINKING_STEPS),
  models: names,
  tools: names,
  skills: names,
  mcp: names,
  memory: z.enum(MEMORY_BACKENDS),
  memoryScope: z.enum(MEMORY_SCOPES),
  approval: z.enum(APPROVAL_SETTINGS),
  habitat: z.enum(HABITATS),
  lineage: z.array(agentName).max(16),
  charter: z.string().max(4e4),
  extra: z.string().max(4e4)
});
var workspaceArg = z.string().min(1).max(1024).optional().describe("absolute path of the workspace whose project agents to include");
var proposalShape = {
  name: agentName.describe("the agent's name: lowercase letters, digits, dashes"),
  description: z.string().max(400).optional().describe("one line: what it is for"),
  charter: z.string().max(4e4).optional().describe("the instructions it runs by (the agent.md body), markdown"),
  vibr: z.string().max(120).optional().describe("the avatar id it wears \u2014 a vibr such as orb, nebula or mochi"),
  voice: z.string().max(120).optional().describe("the voice profile it speaks with, by name (lowercase letters, digits, dashes); the user's own choice for it outranks this"),
  skills: names.optional().describe("skill allowlist; omit to keep every skill"),
  memory: z.enum(MEMORY_BACKENDS).optional(),
  thinking: z.enum(THINKING_STEPS).optional(),
  personality: z.enum(PERSONALITIES).optional(),
  extra: z.string().max(2e4).optional().describe(
    "YAML for manifest keys the profile does not draw \u2014 title, defaultListed, engine.model/profile/roles, routing, loop, memory.namespace, capabilities.autoloadSkills/slashCommands/ignore, subagents.maxDepth, \u2026 One `key: value` per line, sections indented two spaces. It is laid over the draft's own, key by key (a key it names that the profile also draws, like engine.model, is then held as written). Keys that GRANT \u2014 capabilities.tools/mcp/plugins/control/optIn, subagents.allowed, gate.*, workspace.*, harness, allowedHarnesses \u2014 are refused: only the user sets those."
  )
};
function json(structuredContent, text) {
  return { content: [{ type: "text", text }], structuredContent };
}
function fail2(text) {
  return { content: [{ type: "text", text }], isError: true };
}
function isDirectory2(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
function canonicalDir(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}
function sameWorkspace(a, b) {
  if (a === null || b === null) return a === b;
  return canonicalDir(a) === canonicalDir(b);
}
function sessionOf(extra) {
  const meta = extra._meta?.[SESSION_META_KEY];
  if (typeof meta !== "object" || meta === null || !("sessionId" in meta)) return "";
  return typeof meta.sessionId === "string" ? meta.sessionId : "";
}
function createForgeServer(options = {}) {
  const env = options.env ?? process.env;
  const home = env.INSO_HOME !== void 0 && env.INSO_HOME !== "" ? env.INSO_HOME : null;
  const paths = pathsOf(home);
  const fallback2 = env.DIMENSION_FORGE_WORKSPACE !== void 0 && isDirectory2(env.DIMENSION_FORGE_WORKSPACE) ? resolve(env.DIMENSION_FORGE_WORKSPACE) : null;
  const workspaces = /* @__PURE__ */ new Map();
  const proposals = [];
  const boundWorkspace = (extra) => workspaces.get(sessionOf(extra)) ?? fallback2;
  const rootsOf = (extra, workspace) => {
    if (workspace !== void 0) {
      if (!isAbsolute(workspace) || !isDirectory2(workspace)) return `${workspace} is not an existing absolute directory.`;
      return { workspace: resolve(workspace), home };
    }
    return { workspace: boundWorkspace(extra), home };
  };
  const server2 = new McpServer({ name: "dimension-community-general-agent", version: "0.4.0" });
  server2.registerTool(
    "forge_open",
    {
      title: "General Agents",
      description: `Read the General Agents the user sees on the General Agents page (the rail's General Agents entry): every General Agent the installed packs ship, the user's own, and the workspace's, or one agent by name. \`workspace\` is optional: the absolute path of the directory you are working in, which adds that project's agents (\`<workspace>/${WRITE_DIR}/agents/<name>/agent.md\`) for the rest of this session. It writes nothing; to shape an agent, call forge_propose and the user decides on the page.`,
      inputSchema: {
        agent: agentName.optional().describe("read this agent"),
        workspace: z.string().min(1).max(1024).optional().describe("absolute path of your working directory")
      },
      annotations: READ_ONLY,
      _meta: MODEL_ONLY
    },
    async ({ agent, workspace }, extra) => {
      if (workspace !== void 0) {
        if (!isAbsolute(workspace) || !isDirectory2(workspace)) return fail2(`${workspace} is not an existing absolute directory.`);
        workspaces.set(sessionOf(extra), resolve(workspace));
      }
      const roots = rootsOf(extra);
      if (typeof roots === "string") return fail2(roots);
      const listing = await listAgents(roots);
      const found = agent === void 0 ? void 0 : listing.agents.find((candidate) => candidate.name === agent);
      const opened = { agent: found?.name ?? null, workspace: roots.workspace };
      const where = roots.workspace === null ? "no workspace (pack and user agents)" : roots.workspace;
      const text = agent !== void 0 && found === void 0 ? `No General Agent named "${agent}" in ${where}. There are ${listing.agents.length}: ${listing.agents.map((listed) => listed.name).join(", ")}.` : found !== void 0 ? `${found.name} (${found.source}, ${found.editable ? "editable" : "read-only"}) in ${where}: ${found.description}` : `${listing.agents.length} General Agents in ${where}: ${listing.agents.map((listed) => `${listed.name} (${listed.source})`).join(", ")}.`;
      return json(opened, text);
    }
  );
  server2.registerTool(
    "forge_propose",
    {
      title: "General Agent proposal",
      description: "Propose a General Agent draft to the user on the General Agents page, talk-to-build. Name it and give any of: description, charter, vibr, voice, skills, memory, thinking, personality, extra (YAML for the manifest keys the profile does not draw). The page of the workspace you bound with forge_open shows it on that agent's profile as proposed by the Machinist; the user accepts it, changes it, and saves it. Nothing is written by this call. A newer proposal for the same agent in the same workspace replaces the earlier one. A proposal cannot set anything that grants (the agent's tools, approval gate, workspace or where it works, the agents it extends, control lanes, plugins, MCP servers, delegation or harness): only the user sets those, on the profile.",
      inputSchema: proposalShape,
      _meta: MODEL_ONLY
    },
    async (proposal, extra) => {
      if (proposal.extra !== void 0) {
        const textual = grantPathsIn(proposal.extra);
        if (textual.length > 0) {
          return fail2(`A proposal cannot set ${textual.join(", ")}: those grant the agent something, so only the user sets them, on the General Agents page. Propose the rest.`);
        }
        let parsed;
        try {
          parsed = parseYaml4(proposal.extra);
        } catch (error) {
          return fail2(`extra is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) return fail2("extra must be a YAML mapping: one `key: value` per line.");
        const resolved = grantPathsInDocument(parsed);
        if (resolved.length > 0) {
          return fail2(`A proposal cannot set ${resolved.join(", ")}: those grant the agent something, so only the user sets them, on the General Agents page. Propose the rest.`);
        }
      }
      const workspace = boundWorkspace(extra);
      const stored = { id: randomUUID(), proposal, at: Date.now(), workspace };
      const earlier = proposals.findIndex((candidate) => candidate.proposal.name === proposal.name && sameWorkspace(candidate.workspace, workspace));
      if (earlier >= 0) proposals.splice(earlier, 1);
      proposals.push(stored);
      if (proposals.length > MAX_PROPOSALS) proposals.splice(0, proposals.length - MAX_PROPOSALS);
      const proposed = { id: stored.id, proposal };
      const fields = Object.keys(proposal).filter((field) => field !== "name");
      return json(
        proposed,
        `Proposed ${proposal.name} on the General Agents page${fields.length > 0 ? ` (${fields.join(", ")})` : ""}. The user accepts or discards it there; nothing is written until they save it. Anything that grants (tools, the approval gate, workspace, control lanes) is theirs to set.`
      );
    }
  );
  server2.registerTool(
    "pending_proposals",
    {
      description: "The Machinist's proposals the user has not accepted or discarded yet for the page's workspace (those made in it, and those made with no workspace), oldest first.",
      inputSchema: { workspace: workspaceArg },
      annotations: READ_ONLY,
      _meta: APP_ONLY
    },
    async ({ workspace }, extra) => {
      const roots = rootsOf(extra, workspace);
      if (typeof roots === "string") return fail2(roots);
      const here = roots.workspace;
      const pending = { proposals: proposals.filter((candidate) => candidate.workspace === null || here !== null && sameWorkspace(candidate.workspace, here)) };
      return json(pending, `${pending.proposals.length} pending`);
    }
  );
  server2.registerTool(
    "dismiss_proposal",
    {
      description: "The user decided on a proposal (accepted it into a draft, or discarded it): it is no longer pending.",
      inputSchema: { id: z.string().min(1).max(64) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: APP_ONLY
    },
    async ({ id }) => {
      const at = proposals.findIndex((candidate) => candidate.id === id);
      if (at >= 0) proposals.splice(at, 1);
      const dismissed = { dismissed: at >= 0 };
      return json(dismissed, at >= 0 ? "Dismissed" : "Not pending");
    }
  );
  server2.registerTool(
    "list_agents",
    {
      description: "Every General Agent the page can see (installed packs', the user's own, the workspace's), each with its tier and marked editable or read-only.",
      inputSchema: { workspace: workspaceArg },
      annotations: READ_ONLY,
      _meta: APP_ONLY
    },
    async ({ workspace }, extra) => {
      const roots = rootsOf(extra, workspace);
      if (typeof roots === "string") return fail2(roots);
      const listing = await listAgents(roots);
      return json(listing, `${listing.agents.length} agents`);
    }
  );
  server2.registerTool(
    "list_parts",
    {
      description: "The skills, MCP servers, tool names and memory backends the profile can offer, with where each list was read and what could not be.",
      inputSchema: { workspace: workspaceArg },
      annotations: READ_ONLY,
      _meta: APP_ONLY
    },
    async ({ workspace }, extra) => {
      const roots = rootsOf(extra, workspace);
      if (typeof roots === "string") return fail2(roots);
      const { agents } = await listAgents(roots);
      const listing = await listParts({ workspace: roots.workspace, pluginsDir: paths?.plugins ?? null, agentDir: paths?.agent ?? null, agents });
      return json(listing, `${listing.parts.length} parts`);
    }
  );
  server2.registerTool(
    "validate_agent",
    {
      description: "Whether the draft would save: its own problems, then whether the agent.md it writes loads as a General Agent. Writes nothing.",
      inputSchema: { draft: draftSchema },
      annotations: READ_ONLY,
      _meta: APP_ONLY
    },
    async ({ draft }) => {
      const rendered = renderDraft(draft, join4(draft.name, "agent.md"));
      const check = { problems: "problems" in rendered ? rendered.problems : [] };
      return json(check, check.problems.length === 0 ? "It would save." : check.problems.join(" "));
    }
  );
  server2.registerTool(
    "save_agent",
    {
      description: `Write the draft. \`create: true\` writes a NEW agent into the user's own agents (\`$INSO_HOME/agent/agents/<name>/agent.md\`, where it gets a home) and refuses a name that is taken anywhere. \`create: false\` rewrites the agent of that name in \`tier\` (\`user\`, or \`workspace\`: <workspace>/${WRITE_DIR}/agents), and is refused unless \`revision\` is the one list_agents gave: the file changed since, otherwise. The merged agent.md must load as a General Agent or nothing is written.`,
      inputSchema: { draft: draftSchema, create: z.boolean(), tier: z.enum(["workspace", "user"]).optional(), revision: z.string().max(64).optional(), workspace: workspaceArg },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: APP_ONLY
    },
    async ({ draft, create, tier, revision, workspace }, extra) => {
      let target;
      if (create) target = { create: true };
      else if (tier !== void 0 && revision !== void 0) target = { create: false, tier, revision };
      else return fail2("Rewriting an agent names its tier and its revision; both come from list_agents.");
      const roots = rootsOf(extra, workspace);
      if (typeof roots === "string") return fail2(roots);
      try {
        const outcome = await saveAgent({ roots, draft, target });
        return json(outcome, `Wrote ${outcome.relativePath}`);
      } catch (error) {
        if (error instanceof SaveRefused) return fail2(error.message);
        throw error;
      }
    }
  );
  server2.registerTool(
    "agent_home",
    {
      description: "An agent's home: its id (home-<name>), its folder under the engine's workspaces, whether the engine registers it, the memory room it follows, and its standing instructions (every AGENTS.md OMP looks at, which one wins, what it holds, and the `revision` of the file a save would write, which `save_instructions` needs). Works for a name that does not exist yet (the user tier, where new agents land).",
      inputSchema: { name: agentName, workspace: workspaceArg },
      annotations: READ_ONLY,
      _meta: APP_ONLY
    },
    async ({ name, workspace }, extra) => {
      const roots = rootsOf(extra, workspace);
      if (typeof roots === "string") return fail2(roots);
      const described = await describeHome(roots, name);
      return json(described, `${name}: ${described.homeNote}`);
    }
  );
  server2.registerTool(
    "save_instructions",
    {
      description: "Write an agent's standing instructions: its home AGENTS.md once the home folder exists, otherwise the AGENTS.md beside its agent.md (which seeds the home on its first provisioning). Only for a user or workspace agent the page may edit; the path is derived, never given. `revision` is the target's revision from agent_home: the write is refused unless the file still holds what it held then and the home has not been set up since (a save would land elsewhere), so nothing written meanwhile is lost.",
      inputSchema: { name: agentName, text: z.string().max(INSTRUCTIONS_MAX_BYTES), revision: z.string().max(64), workspace: workspaceArg },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: APP_ONLY
    },
    async ({ name, text, revision, workspace }, extra) => {
      const roots = rootsOf(extra, workspace);
      if (typeof roots === "string") return fail2(roots);
      try {
        const saved = await saveInstructions(roots, name, text, revision);
        return json(saved, `Wrote ${saved.path}`);
      } catch (error) {
        if (error instanceof SaveRefused) return fail2(error.message);
        throw error;
      }
    }
  );
  return server2;
}

// src/stdio.ts
var server = await createForgeServer();
var stopping;
function stop() {
  stopping ??= server.close();
  return stopping;
}
process.once("SIGINT", () => {
  void stop().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
});
process.once("SIGTERM", () => {
  void stop().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
});
await server.connect(new StdioServerTransport());
