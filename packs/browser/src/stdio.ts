import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { unexitedWorkerThreads } from "./code/host/transport.js";
import { createBrowserServer } from "./server.js";
import { createShutdown, killThisProcess } from "./shutdown.js";

const server = await createBrowserServer();
const shutdown = createShutdown({
  stop: () => server.close(),
  killBrowsers: limitMs => server.killBrowsers(limitMs),
  unexitedThreads: unexitedWorkerThreads,
  exit: code => process.exit(code),
  killSelf: killThisProcess,
});
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
// A host lets a pack go by closing its stdin (Windows has no signal to send), and the SDK's stdio transport does not notice that: stop here, so no browser, worker or View channel outlives the server.
process.stdin.once("end", () => void shutdown());
await server.connect(new StdioServerTransport());
