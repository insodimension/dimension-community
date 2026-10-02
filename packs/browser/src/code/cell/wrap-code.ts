// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/eval/js/shared/rewrite-imports.ts @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack: TypeScript stripping (Bun.Transpiler), the LocalModuleLoader helpers and the module-specifier rewriters are not ported
// (doc 77 §7.4.4); the parser reads plain JavaScript; a cell is always wrapped in an async function whose `this` is the evaluator's own binding store, and
// every top-level binding is published to it at its declaration AND again when the cell ends, so a `let` changed after its declaration is not lost.

import type * as BabelParser from "@babel/parser";

// Static ESM `import` declarations are not valid in an indirect eval (script-mode parsing), and dynamic `import(...)` would otherwise resolve specifiers
// against the worker module's URL. We rewrite both forms so they route through the evaluator-injected `__omp_import__` helper. A real parser keeps
// imports embedded in string literals, template literals, or comments intact.

type BabelImportDeclaration = {
  type: "ImportDeclaration";
  start: number;
  end: number;
  source: { value: string };
  specifiers: ReadonlyArray<{
    type: "ImportDefaultSpecifier" | "ImportNamespaceSpecifier" | "ImportSpecifier";
    local: { name: string };
    imported?: { type: "Identifier"; name: string } | { type: "StringLiteral"; value: string };
  }>;
  attributes?: ReadonlyArray<{
    key: { type: "Identifier"; name: string } | { type: "StringLiteral"; value: string };
    value: { value: string };
  }>;
};

type BabelBindingPattern = {
  type: string;
  name?: string;
  properties?: ReadonlyArray<unknown>;
  elements?: ReadonlyArray<unknown | null>;
  argument?: unknown;
  left?: unknown;
  value?: unknown;
};

type BabelVariableDeclaration = {
  type: "VariableDeclaration";
  kind: "const" | "let" | "var";
  start: number;
  end: number;
  declarations?: ReadonlyArray<{ id: BabelBindingPattern }>;
};

type BabelClassDeclaration = {
  type: "ClassDeclaration";
  start: number;
  end: number;
  id: { start: number; end: number; name: string } | null;
};

type BabelLexicalDecl = BabelVariableDeclaration | BabelClassDeclaration;
type BabelFunctionDeclaration = {
  type: "FunctionDeclaration";
  start: number;
  end: number;
  id: { start: number; end: number; name: string } | null;
};

/** Top-level declarations whose bindings must survive the cell (demoted and/or published). */
type BabelPublishableDecl = BabelLexicalDecl | BabelFunctionDeclaration;

type BabelExpressionStatement = {
  type: "ExpressionStatement";
  start: number;
  end: number;
  expression?: { type?: string };
};

type BabelProgramNode = BabelImportDeclaration | BabelLexicalDecl | BabelExpressionStatement | { type: string };

type BabelNode = { type: string; start: number; end: number; [key: string]: unknown };

// @babel/parser is only needed when a cell runs, so it is loaded lazily and memoized.
let babelParser: typeof BabelParser | undefined;

async function loadBabelParser(): Promise<typeof BabelParser> {
  if (!babelParser) {
    babelParser = await import("@babel/parser");
  }
  return babelParser;
}

async function parseProgram(code: string): Promise<{ program: { body: ReadonlyArray<BabelProgramNode> } } | null> {
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
      errorRecovery: true,
    }) as unknown as { program: { body: ReadonlyArray<BabelProgramNode> } };
  } catch {
    return null;
  }
}

// Callee substituted for dynamic `import(...)` calls. Functions handed to puppeteer (`tab.evaluate`, `page.evaluate`, `waitForFunction`, ...) are
// serialized with `Function.prototype.toString()` and re-evaluated inside the browser page, where the evaluator-injected `__omp_import__` does not exist.
// The swap therefore guards on the helper's presence and falls back to native dynamic import, so serialized code keeps working in foreign realms.
const DYNAMIC_IMPORT_CALLEE = '(typeof __omp_import__ === "function" ? __omp_import__ : (s, o) => import(s, o))';

function buildOmpImportCall(sourceLiteral: string, optionsLiteral: string | undefined): string {
  return optionsLiteral ? `__omp_import__(${sourceLiteral}, ${optionsLiteral})` : `__omp_import__(${sourceLiteral})`;
}

// Walks every node in `root`, depth-first, invoking `visit` on each one. Skips Babel's non-AST bookkeeping fields so we don't recurse into source
// locations or comment arrays.
function walkNodes(root: unknown, visit: (node: BabelNode) => void): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i--) stack.push(current[i]);
      continue;
    }
    const node = current as Record<string, unknown>;
    if (typeof node.type === "string") visit(node as unknown as BabelNode);
    for (const key in node) {
      if (key === "loc" || key === "extra" || key === "range") continue;
      if (key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
      const value = node[key];
      if (value && typeof value === "object") stack.push(value);
    }
  }
}

function buildOptionsLiteral(node: BabelImportDeclaration): string | undefined {
  const attrs = node.attributes;
  if (!attrs || attrs.length === 0) return undefined;
  const pairs = attrs.map(attr => {
    const key = attr.key.type === "Identifier" ? attr.key.name : JSON.stringify(attr.key.value);
    return `${key}: ${JSON.stringify(attr.value.value)}`;
  });
  // Native dynamic import takes options as `{ with: { ... } }`. `__omp_import__` forwards the options bag verbatim, so we wrap the attribute pairs accordingly.
  return `{ with: { ${pairs.join(", ")} } }`;
}

function rewriteImportNode(node: BabelImportDeclaration): string {
  const sourceLiteral = JSON.stringify(node.source.value);
  const optionsLiteral = buildOptionsLiteral(node);
  const importCall = buildOmpImportCall(sourceLiteral, optionsLiteral);

  let defaultName: string | undefined;
  let namespaceName: string | undefined;
  const namedPairs: Array<[string, string]> = [];
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
    const inner = namedPairs.map(([imp, loc]) => (imp === loc ? imp : `${imp}: ${loc}`)).join(", ");
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

export async function rewriteImports(code: string): Promise<string> {
  if (!code.includes("import")) return code;

  const ast = await parseProgram(code);
  if (!ast) {
    // Parser bailed entirely: let the evaluator surface the real syntax error.
    return code;
  }

  type Edit = { start: number; end: number; text: string };
  const edits: Edit[] = [];

  // Top-level static `import` declarations become `await __omp_import__(...)` calls.
  for (const node of ast.program.body) {
    if (node.type !== "ImportDeclaration") continue;
    const decl = node as unknown as BabelImportDeclaration;
    edits.push({ start: decl.start, end: decl.end, text: rewriteImportNode(decl) });
  }

  // Dynamic `import(...)` expressions (anywhere) get their callee swapped for `__omp_import__`.
  walkNodes(ast, node => {
    if (node.type !== "CallExpression") return;
    const call = node as unknown as { callee?: { type?: string; start?: number; end?: number } };
    const callee = call.callee;
    if (callee?.type !== "Import" || typeof callee.start !== "number" || typeof callee.end !== "number") return;
    edits.push({ start: callee.start, end: callee.end, text: DYNAMIC_IMPORT_CALLEE });
  });

  if (edits.length === 0) return code;

  // Splice from the back so earlier offsets stay valid.
  edits.sort((a, b) => b.start - a.start);
  let result = code;
  for (const edit of edits) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

function collectBindingNames(pattern: unknown, names: string[]): void {
  if (!pattern || typeof pattern !== "object") return;
  const node = pattern as BabelBindingPattern & { parameter?: unknown };
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

function getLexicalBindingNames(node: BabelPublishableDecl): string[] {
  const names: string[] = [];
  if (node.type === "VariableDeclaration") {
    for (const declaration of node.declarations ?? []) collectBindingNames(declaration.id, names);
  } else if (node.id) {
    names.push(node.id.name);
  }
  return names;
}

function appendBindingPublish(source: string, names: readonly string[]): string {
  if (names.length === 0) return source;
  const assignments = names.map(name => `this[${JSON.stringify(name)}] = ${name};`).join("\n");
  return `${source};\n${assignments}`;
}

/**
 * Demote top-level `const`/`let`/`class` declarations to `var` and publish every top-level binding (the user's own `var` and `function` declarations
 * too) to the wrapper's `this`, which is the evaluator's binding store. Without it the bindings would die with the wrapper function.
 *
 *   const x = 1;             -> var x = 1; this["x"] = x;
 *   let { a, b } = obj;      -> var { a, b } = obj; this["a"] = a; this["b"] = b;
 *   class Foo extends Bar {} -> var Foo = class extends Bar {}; this["Foo"] = Foo;
 *
 * Nested declarations (inside functions, blocks, classes) are left alone: they are scoped to their enclosing function/block regardless of `var` vs `let`/`const`.
 * Returns the rewritten source and every published name, so the caller can publish them once more when the cell ends.
 */
async function demoteTopLevelLexicals(code: string): Promise<{ source: string; names: string[] }> {
  if (!/\b(?:const|let|class|var|function)\b/.test(code)) return { source: code, names: [] };

  const ast = await parseProgram(code);
  if (!ast) return { source: code, names: [] };

  const targets: Array<{ node: BabelPublishableDecl; demote: boolean }> = [];
  for (const node of ast.program.body) {
    if (node.type === "VariableDeclaration") {
      const decl = node as unknown as BabelVariableDeclaration;
      targets.push({ node: decl, demote: decl.kind === "const" || decl.kind === "let" });
    } else if (node.type === "ClassDeclaration") {
      const decl = node as unknown as BabelClassDeclaration;
      if (decl.id) targets.push({ node: decl, demote: true });
    } else if (node.type === "FunctionDeclaration") {
      const decl = node as unknown as BabelFunctionDeclaration;
      if (decl.id) targets.push({ node: decl, demote: false });
    }
  }
  if (targets.length === 0) return { source: code, names: [] };

  targets.sort((a, b) => b.node.start - a.node.start);
  const names = new Set<string>();
  let result = code;
  for (const { node, demote } of targets) {
    const segment = result.slice(node.start, node.end);
    const bindingNames = getLexicalBindingNames(node);
    for (const name of bindingNames) names.add(name);
    let replacement: string;
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

async function returnFinalExpression(code: string): Promise<{ source: string; returned: boolean }> {
  const ast = await parseProgram(code);
  const body = ast?.program.body;
  if (!body) return { source: code, returned: false };
  let lastIndex = body.length - 1;
  while (lastIndex >= 0 && body[lastIndex]?.type === "EmptyStatement") lastIndex--;
  const last = lastIndex >= 0 ? body[lastIndex] : undefined;
  if (last?.type === "ExpressionStatement") {
    const expression = last as BabelExpressionStatement;
    const prefix = code.slice(0, expression.start);
    const statement = code.slice(expression.start, expression.end);
    const suffix = code.slice(expression.end);
    const semicolonMatch = statement.match(/;\s*$/);
    const trimmedStatement = semicolonMatch ? statement.slice(0, semicolonMatch.index) : statement;
    return { source: `${prefix}__omp_set_final_expr__((${trimmedStatement}));${suffix}`, returned: true };
  }
  if (last?.type === "ReturnStatement") {
    // Top-level `return value;` is otherwise swallowed: rewrite into `__omp_set_final_expr__((expr))` so the evaluator can surface the value to the
    // caller just like a trailing expression.
    const ret = last as unknown as { start: number; end: number; argument?: { start: number; end: number } | null };
    if (!ret.argument) return { source: code, returned: false };
    const prefix = code.slice(0, ret.start);
    const suffix = code.slice(ret.end);
    const expr = code.slice(ret.argument.start, ret.argument.end);
    return { source: `${prefix}__omp_set_final_expr__((${expr}));${suffix}`, returned: true };
  }
  return { source: code, returned: false };
}

export interface WrappedCode {
  /** An async function call expression: `(async () => { ... })()`. Its `this` is the evaluator's binding store. */
  source: string;
  finalExpressionReturned: boolean;
}

export async function wrapCode(code: string): Promise<WrappedCode> {
  const finalExpression = await returnFinalExpression(code);
  const importsRewritten = await rewriteImports(finalExpression.source);
  const { source, names } = await demoteTopLevelLexicals(importsRewritten);
  // The end-of-cell publish skips a name still `undefined`: it was declared later than where the cell stopped, and an earlier cell's value must stay.
  const republish = names.map(name => `if (${name} !== undefined) this[${JSON.stringify(name)}] = ${name};`).join("\n");
  const body = republish ? `try {\n${source}\n} finally {\n${republish}\n}` : source;
  return {
    source: `(async () => {\n${body}\n})()`,
    finalExpressionReturned: finalExpression.returned,
  };
}
