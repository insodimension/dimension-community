// A real worker thread for the tests that need the pack's own worker core AND the real tab realm (the Chrome-free fake is fake-realm-worker.ts): the production entry itself, not a copy of its wiring.
import "../../src/code/worker/entry.js";
