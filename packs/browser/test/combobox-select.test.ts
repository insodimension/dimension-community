/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: an agent filling a sign-up form (Outlook's birth month, any Fluent, Radix, MUI
 *  or Slack dropdown) cannot pick an option: `tab.select` and browser_act's `select` only knew the native <select>, so they
 *  failed on a custom combobox, or the agent fell back to guessing clicks. Or a pick of an option the list does not have
 *  leaves the list open and says nothing useful.
 *
 *  Real Chrome. Four dropdowns built the ways those libraries build them, each answering only trusted input: a Fluent-style
 *  button that opens on click and portals its listbox (aria-controls), a Radix-style trigger that opens on pointerdown and
 *  picks on pointerup, an MUI-style div that opens on mousedown, and Slack's own Workspace picker (aria-haspopup, no role).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrowserServer } from "../src/server";
import { newRig, type Rig } from "./code-host-fixture";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, createRuntime, describeWithChrome, teardown } from "./fixture";

const SESSION = "ai.insodimension/session";
const CALLER = "ai.insodimension/caller";

const PAGE = `<!doctype html><meta charset="utf-8"><title>dropdowns</title>
<style>
body{margin:0;font:16px sans-serif}
.trigger{position:absolute;left:40px;width:220px;height:32px;border:1px solid #888;background:#fff;text-align:left}
[role=listbox]{position:fixed;background:#fff;border:1px solid #888;margin:0;padding:4px 0;list-style:none;max-height:150px;overflow:auto;z-index:10}
[role=option]{padding:4px 8px;cursor:pointer}
</style>
<label id="month-label">Birth month</label>
<button id="birth-month" class="trigger" style="top:40px" type="button" role="combobox" aria-expanded="false" aria-labelledby="month-label">Month</button>
<button id="radix" class="trigger" style="top:120px" type="button" role="combobox" aria-expanded="false"><span>Pick a month</span></button>
<div id="mui" class="trigger" style="top:200px" role="combobox" aria-haspopup="listbox" aria-expanded="false" tabindex="0">&#8203;</div>
<button id="workspace" class="trigger" style="top:280px" type="button" aria-haspopup="listbox" aria-expanded="false"><span>Select a workspace</span></button>
<script>
window.log = [];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function portal(trigger, items, id) {
  const list = document.createElement(id === "ws" ? "ul" : "div");
  list.setAttribute("role", "listbox");
  list.id = id + "-list";
  const box = trigger.getBoundingClientRect();
  list.style.top = box.bottom + 4 + "px";
  list.style.left = box.left + "px";
  list.style.width = box.width + "px";
  for (const [label, value] of items) {
    const option = document.createElement(id === "ws" ? "li" : "div");
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    if (value !== undefined) option.setAttribute("data-value", value);
    option.textContent = label;
    list.append(option);
  }
  document.body.append(list);
  trigger.setAttribute("aria-expanded", "true");
  trigger.setAttribute("aria-controls", list.id);
  return list;
}
function close(trigger, list) {
  list.remove();
  trigger.setAttribute("aria-expanded", "false");
  trigger.removeAttribute("aria-controls");
}

const fluent = document.getElementById("birth-month");
let fluentList = null;
fluent.addEventListener("click", (event) => {
  if (!event.isTrusted) return;
  if (fluentList) { close(fluent, fluentList); fluentList = null; return; }
  fluentList = portal(fluent, MONTHS.map((m) => [m]), "fluent");
  fluentList.addEventListener("click", (pick) => {
    const option = pick.target.closest("[role=option]");
    if (!pick.isTrusted || !option) return;
    fluent.textContent = option.textContent;
    window.log.push("fluent:" + option.textContent);
    close(fluent, fluentList); fluentList = null;
  });
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && fluentList) { close(fluent, fluentList); fluentList = null; }
});

const radix = document.getElementById("radix");
let radixList = null;
radix.addEventListener("pointerdown", (event) => {
  if (!event.isTrusted || event.pointerType !== "mouse" || event.button !== 0 || radixList) return;
  event.preventDefault();
  radixList = portal(radix, MONTHS.map((m) => [m, m.slice(0, 3).toLowerCase()]), "radix");
  radixList.addEventListener("pointerup", (pick) => {
    const option = pick.target.closest("[role=option]");
    if (!pick.isTrusted || !option) return;
    radix.firstElementChild.textContent = option.textContent;
    window.log.push("radix:" + option.dataset.value);
    close(radix, radixList); radixList = null;
  });
});

const mui = document.getElementById("mui");
let muiList = null;
mui.addEventListener("mousedown", (event) => {
  if (!event.isTrusted || event.button !== 0 || muiList) return;
  muiList = portal(mui, MONTHS.map((m, i) => [m, String(i + 1)]), "mui");
  muiList.addEventListener("click", (pick) => {
    const option = pick.target.closest("[role=option]");
    if (!pick.isTrusted || !option) return;
    mui.textContent = option.textContent;
    window.log.push("mui:" + option.dataset.value);
    close(mui, muiList); muiList = null;
  });
});

const workspace = document.getElementById("workspace");
let wsList = null;
workspace.addEventListener("click", (event) => {
  if (wsList) { close(workspace, wsList); wsList = null; return; }
  wsList = portal(workspace, [["Tower360", "T0123"], ["Add new workspace"]], "ws");
  workspace.removeAttribute("aria-controls");
  for (const option of wsList.children) option.tabIndex = 0;
  wsList.firstElementChild.focus();
  wsList.addEventListener("click", (pick) => {
    const option = pick.target.closest("[role=option]");
    if (!option || !option.dataset.value) return;
    workspace.firstElementChild.textContent = option.textContent;
    window.log.push("workspace:" + option.dataset.value);
    close(workspace, wsList); wsList = null;
  });
});
</script>`;

const rigs: Rig[] = [];
const clients: Client[] = [];
const servers: Array<{ stop(force?: boolean): unknown }> = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	for (const rig of rigs.splice(0)) await rig.host.dispose();
	for (const server of servers.splice(0)) await server.stop(true);
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

function servePage(): string {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }) });
	servers.push(server);
	return `http://127.0.0.1:${server.port}/`;
}

async function connect(): Promise<(code: string) => Promise<{ text: string; isError: boolean }>> {
	const rootDir = await createRoot();
	const rig = newRig(rootDir);
	rigs.push(rig);
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const server = await createBrowserServer({ runtime: rig.runtime, codeHost: rig.host, viewDir, presets: [], modelTools: "code" });
	const client = new Client({ name: "combobox-select-test", version: "0.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	return async (code) => {
		const answer = await client.callTool({ name: "browser_run", arguments: { code, timeout: 60 }, _meta: { [CALLER]: "model", [SESSION]: { sessionId: "chat" } } }, undefined, { timeout: 120_000 });
		const content = (answer.content ?? []) as { text?: string }[];
		return { text: content.map((block) => block.text ?? "").join(""), isError: answer.isError === true };
	};
}

describeWithChrome("tab.select on a custom dropdown", () => {
	test(
		"picks by name, value or any letter case in Fluent-, Radix-, MUI- and Slack-style dropdowns, with real clicks, and each shows its choice",
		async () => {
			const run = await connect();
			const url = servePage();
			const outcome = await run(`const tab = await browser.open({ name: "form", url: ${JSON.stringify(url)} });
const picked = [
  await tab.select("#birth-month", "May"),
  await tab.select("#radix", "mar"),
  await tab.select("#mui", "april"),
  await tab.select("#workspace", "Tower360"),
];
JSON.stringify({ picked, shown: await tab.evaluate(() => ["birth-month", "radix", "mui", "workspace"].map((id) => document.getElementById(id).textContent.trim())), log: await tab.evaluate(() => window.log), lists: await tab.evaluate(() => document.querySelectorAll("[role=listbox]").length) })`);
			expect(outcome.isError).toBe(false);
			const result = JSON.parse(outcome.text.slice(outcome.text.indexOf("{"), outcome.text.lastIndexOf("}") + 1));
			expect(result).toEqual({
				picked: [["May"], ["March"], ["April"], ["Tower360"]],
				shown: ["May", "March", "April", "Tower360"],
				log: ["fluent:May", "radix:mar", "mui:4", "workspace:T0123"],
				lists: 0,
			});
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"an option the list does not have is a named error listing what it offers, and the list it opened is closed again",
		async () => {
			const run = await connect();
			const url = servePage();
			const outcome = await run(`const tab = await browser.open({ name: "form", url: ${JSON.stringify(url)} });
let message = "no error";
try { await tab.select("#birth-month", "Smarch"); } catch (error) { message = error.message; }
JSON.stringify({ message, expanded: await tab.evaluate(() => document.getElementById("birth-month").getAttribute("aria-expanded")), shown: await tab.evaluate(() => document.getElementById("birth-month").textContent) })`);
			const result = JSON.parse(outcome.text.slice(outcome.text.indexOf("{"), outcome.text.lastIndexOf("}") + 1));
			expect(result.message).toBe(`tab.select("#birth-month") has no option named or valued "Smarch". It offers: "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December".`);
			expect(result.expanded).toBe("false");
			expect(result.shown).toBe("Month");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

describeWithChrome("browser_act's select step on a custom dropdown", () => {
	test(
		"picks the option in a combobox, with and without an effect guard, and refuses an option the list does not have",
		async () => {
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ viewport: { width: 800, height: 600 } });
			expect((await runtime.act(browserId, { kind: "navigate", url: servePage() })).status).toBe("completed");
			const guard = Object.assign(() => undefined, { assertCurrent: () => undefined });
			expect((await runtime.act(browserId, { kind: "select", selector: "#birth-month", value: "October" })).status).toBe("completed");
			expect((await runtime.act(browserId, { kind: "select", selector: "#radix", value: "jun" }, undefined, undefined, guard)).status).toBe("completed");
			const missing = await runtime.act(browserId, { kind: "select", selector: "#mui", value: "Smarch" });
			expect(missing.status).toBe("unknown");
			expect(missing.error).toContain(`has no option named or valued "Smarch"`);
			const shown = await runtime.actMany(browserId, [{ kind: "eval", expression: `["birth-month", "radix", "mui"].map((id) => document.getElementById(id).textContent.trim()).join("|")` }]);
			expect(JSON.parse(shown.steps[0]?.value ?? "null")).toBe("October|June|\u200b");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
