// A real worker thread for the tests of the worker core: the pack's own serveOnParentPort with a tab realm that holds nothing (lane L3's realm needs a Chrome).
import type { TabHandle, TabRealm } from "../../src/code/contracts.js";
import { serveOnParentPort } from "../../src/code/worker/serve.js";

serveOnParentPort(() => {
  const held = new Map<string, TabHandle>();
  const realm: TabRealm = {
    adopt: async (name, handle) => void held.set(name, handle),
    release: async name => void held.delete(name),
    run: async () => ({ displays: [], screenshots: [] }),
    call: async () => ({ displays: [], screenshots: [] }),
    names: () => [...held.keys()],
    end: async () => {},
    dispose: async () => {},
  };
  return realm;
});
