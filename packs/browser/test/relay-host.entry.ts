/** The relay's own command, as `node app/server.mjs --relay ...` runs it, bundled for the tests that must see the relay on the runtime it ships on (Node, not Bun). */
import { runRelayCliIfAsked } from "../src/code/kinds/relay/cli.js";

if (!(await runRelayCliIfAsked(process.argv.slice(2)))) throw new Error("no relay command in argv");
