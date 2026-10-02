import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBrowserServer } from "./server.js";

const server = await createBrowserServer();
let stopping: Promise<void> | undefined;
function stop(): Promise<void> {
  stopping ??= server.close();
  return stopping;
}
process.once("SIGINT", () => { void stop().catch(error => { console.error(error); process.exitCode = 1; }); });
process.once("SIGTERM", () => { void stop().catch(error => { console.error(error); process.exitCode = 1; }); });
// A host lets a pack go by closing its stdin (Windows has no signal to send), and the SDK's stdio transport does not notice that: stop here, so no browser, worker or View channel outlives the server.
process.stdin.once("end", () => {
  void stop()
    .catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => process.exit());
});
await server.connect(new StdioServerTransport());
