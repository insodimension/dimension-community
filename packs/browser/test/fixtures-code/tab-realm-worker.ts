// A real worker thread for the tests that need the pack's own worker core AND the real tab realm (the Chrome-free fake is fake-realm-worker.ts).
import { createCodeEvaluator } from "../../src/code/cell/evaluator.js";
import { serveOnParentPort } from "../../src/code/worker/serve.js";
import { createTabRealm } from "../../src/code/worker/tab-realm.js";

serveOnParentPort(({ env, screenshotDir }) => createTabRealm({ evaluator: createCodeEvaluator, env, ...(screenshotDir === undefined ? {} : { screenshotDir }) }));
