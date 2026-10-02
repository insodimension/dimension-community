// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/eval/js/shared/runtime.ts (JsRuntime.run, setRunScope, the final-expression slot) and shared/indirect-eval.ts @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack: OMP installs its helper names and each run's scope as properties of `globalThis`; this evaluator resolves them lexically instead (a `with` over a proxy that
// looks the name up in the run it is called from), so two overlapping runs never clobber each other and `browser` can be Puppeteer's inside `tab.run` while the cell's `browser` is the facade.
// The persistent top-level bindings live in a store of the evaluator's own, not on the global object. TypeScript stripping, the tool bridge, handles and local-module imports are not ported.

import { AsyncLocalStorage } from "node:async_hooks";
import type { CodeEvaluator, EvaluatorHooks } from "../contracts.js";
import { createConsoleBridge, displayValue } from "./display.js";
import { wrapCode } from "./wrap-code.js";

interface RunContext {
  hooks: EvaluatorHooks;
  scope: Record<string, unknown>;
  finished: boolean;
  finalExpressionSet: boolean;
  finalExpressionValue: unknown;
}

type EvalInScope = (this: unknown, scope: object, source: string) => unknown;

/**
 * Direct `eval` inside a `with`: the code sees the proxy's names first and the global object after, `this` is whatever the caller binds. The function is created from source so its body
 * is sloppy-mode (a `with` is a syntax error in a module or a strict function); `arguments` is read by index so no name of the code's own can be shadowed by a parameter.
 */
// oxlint-disable-next-line no-new-func -- this is the executor.
const evalInScope = new Function("return function () { with (arguments[0]) { return eval(arguments[1]); } }")() as EvalInScope;

function toKey(key: string | symbol): string | undefined {
  return typeof key === "string" ? key : undefined;
}

/**
 * One evaluator is one cell's worth of persistent state: the top-level `const`, `let`, `class`, `var` and `function` names a run declares are kept for the next run of the SAME evaluator
 * (OMP keeps them on the worker's global object). `scope` names are per run and win over the store, as OMP's run scope overwrote the globals before each run.
 */
export function createCodeEvaluator(): CodeEvaluator {
  const store: Record<string, unknown> = Object.create(null);
  const runs = new AsyncLocalStorage<RunContext>();
  // A callback the page or the browser calls later (a Puppeteer event handler, a timer set before the run was entered) runs outside any run's async context: it sees the newest run, as OMP's globals did.
  let latest: RunContext | undefined;
  const current = (): RunContext | undefined => runs.getStore() ?? latest;
  const liveHooks = (): EvaluatorHooks | undefined => {
    const run = runs.getStore() ?? (latest?.finished === false ? latest : undefined);
    return run?.hooks;
  };

  const routed: EvaluatorHooks = {
    onText: chunk => liveHooks()?.onText(chunk),
    onDisplay: output => liveHooks()?.onDisplay(output),
  };
  const consoleBridge = createConsoleBridge(routed);
  const builtins: Record<string, unknown> = {
    console: consoleBridge,
    print: consoleBridge.log,
    display: (value: unknown) => displayValue(value, routed),
    __omp_set_final_expr__: (value: unknown) => {
      const run = runs.getStore();
      if (!run) return;
      run.finalExpressionSet = true;
      run.finalExpressionValue = value;
    },
    __omp_import__: async (source: string, options?: ImportCallOptions) => (options !== undefined ? await import(source, options) : await import(source)),
  };

  const owner = (key: string): "scope" | "store" | "builtin" | undefined => {
    const scope = current()?.scope;
    if (scope !== undefined && key in scope) return "scope";
    if (key in store) return "store";
    if (key in builtins) return "builtin";
    return undefined;
  };
  const env = new Proxy(Object.create(null) as object, {
    has: (_target, key) => {
      const name = toKey(key);
      return name !== undefined && owner(name) !== undefined;
    },
    get: (_target, key) => {
      const name = toKey(key);
      if (name === undefined) return undefined; // Symbol.unscopables included: nothing is hidden from the code
      switch (owner(name)) {
        case "scope": return current()?.scope[name];
        case "store": return store[name];
        case "builtin": return builtins[name];
        default: return undefined;
      }
    },
    set: (_target, key, value) => {
      const name = toKey(key);
      if (name === undefined) return false;
      const scope = current()?.scope;
      if (scope !== undefined && name in scope) scope[name] = value;
      else store[name] = value;
      return true;
    },
    deleteProperty: (_target, key) => {
      const name = toKey(key);
      if (name !== undefined) delete store[name];
      return true;
    },
  });

  return {
    async evaluate(code, options) {
      const run: RunContext = { hooks: options.hooks, scope: options.scope, finished: false, finalExpressionSet: false, finalExpressionValue: undefined };
      latest = run;
      try {
        return await runs.run(run, async () => {
          const wrapped = await wrapCode(code);
          const withPragma = `${wrapped.source}\n//# sourceURL=${options.filename}`;
          const returned = await (evalInScope.call(store, env, withPragma) as Promise<unknown>);
          if (!run.finalExpressionSet) return returned;
          const final = run.finalExpressionValue;
          run.finalExpressionSet = false;
          run.finalExpressionValue = undefined;
          return await final;
        });
      } finally {
        run.finished = true;
      }
    },
  };
}
