/**
 * A stand-in for an application a cell spawns (`app.path`): a REAL process that opens the debugging port it is told with `--remote-debugging-port=<n>`
 * and answers `/json/version` with 200, as Chrome does, and then runs until it is killed. It speaks no more of the protocol than that, so a connection
 * to it fails the way a connection to a broken application fails; what the tests that start it defend is the process (it is gone by pid, or it is not),
 * and no Chrome is needed for that. `--exit-after-ms=<n>` makes it exit by itself once its port has been up that long (the app a person quits).
 */
import { createServer } from "node:http";

const port = Number(process.argv.find((arg) => arg.startsWith("--remote-debugging-port="))?.split("=")[1]);
const exitAfter = Number(process.argv.find((arg) => arg.startsWith("--exit-after-ms="))?.split("=")[1] ?? 0);
if (!Number.isInteger(port) || port <= 0) throw new Error("fake-cdp-app needs --remote-debugging-port=<n>");

const server = createServer((request, response) => {
  if (request.url?.startsWith("/json/version")) {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ Browser: "FakeApp/1.0", "Protocol-Version": "1.3", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` }));
    return;
  }
  response.statusCode = 404;
  response.end();
});
// It speaks no websocket: a client that connects is refused at once, as by an application whose protocol is broken.
server.on("upgrade", (_request, socket) => socket.destroy());
server.listen(port, "127.0.0.1", () => {
  if (exitAfter > 0) setTimeout(() => process.exit(0), exitAfter);
});
