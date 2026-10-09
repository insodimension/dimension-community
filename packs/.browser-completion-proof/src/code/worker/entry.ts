// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/tab-worker-entry.ts @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack: one worker thread per session carries the cell realm and every tab realm, so this entry builds both; the transport is the thread's parent port (serve.ts).

import { createCodeEvaluator } from "../cell/evaluator.js";
import { CmuxRealm } from "../kinds/cmux/cmux-realm.js";
import { createKindRealm } from "../kinds/realm.js";
import { serveOnParentPort } from "./serve.js";
import { resolveScreenshotDir } from "./screenshot.js";
import { createTabRealm } from "./tab-realm.js";

/** The code worker: the second esbuild entry of the pack (app/code-worker.mjs). Everything it does is a reaction to the host's messages on the thread's parent port. */
// A factory, not an evaluator: each tab name gets its own, so a tab's top-level names persist per tab as in OMP. Every realm setting the host sends in `init` (RealmInit) reaches the realms here.
serveOnParentPort(({ env, screenshotDir, cwd, refusePasswordFields, excludeWebP }) => {
  const shots = screenshotDir ?? resolveScreenshotDir(env);
  return createKindRealm({
    tab: createTabRealm({ evaluator: createCodeEvaluator, env, screenshotDir, cwd, refusePasswordFields, excludeWebP }),
    cmux: new CmuxRealm({ evaluator: createCodeEvaluator, settings: () => ({ ...(shots === undefined ? {} : { screenshotDir: shots }), ...(cwd === undefined ? {} : { cwd }), ...(excludeWebP === undefined ? {} : { excludeWebP }) }) }),
  });
});
