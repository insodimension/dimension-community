import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConnectorDecl } from "@dimension/sdk/connector";
import { connect, dimension, packRoot, registeredNames, run, stubFetch, useTempHome } from "./support";

useTempHome();

const { decl, issues } = parseConnectorDecl(dimension.connect);
const methods = decl?.methods ?? [];

test("the connect block parses with the SDK's parser into one form method per provider, nothing dropped", () => {
	expect(issues).toEqual([]);
	expect(methods.map(method => ({ id: method.id, kind: method.decl.kind }))).toEqual([
		{ id: "beehiiv", kind: ["form"] },
		{ id: "kit", kind: ["form"] },
		{ id: "buttondown", kind: ["form"] },
		{ id: "ghost", kind: ["form"] },
	]);
	expect(decl?.gate).toBeUndefined();
});

test("each provider keeps its own key file, so connecting one never disconnects another", () => {
	expect(methods.map(method => method.decl.configTarget)).toEqual([
		"~/.config/dimension-newsletter/beehiiv.json",
		"~/.config/dimension-newsletter/kit.json",
		"~/.config/dimension-newsletter/buttondown.json",
		"~/.config/dimension-newsletter/ghost.json",
	]);
});

test("every template placeholder is a form field, and every required field reaches the file", () => {
	for (const method of methods) {
		const templatePath = join(packRoot, method.decl.configTemplate ?? "missing");
		expect(existsSync(templatePath)).toBe(true);
		const placeholders = [...readFileSync(templatePath, "utf8").matchAll(/\$\{(\w+)\}/g)].map(match => match[1]);
		const fields = (method.decl.form ?? []).map(field => field.id);
		expect(placeholders.sort()).toEqual([...fields].sort());
	}
});

test("the manifest lists exactly the tools the extension registers", () => {
	expect(dimension.tools.map((entry: { name: string }) => entry.name).sort()).toEqual([...registeredNames].sort());
});

test("a key written by each connect form is the key the tools read", async () => {
	await connect("beehiiv", { apiKey: " bh-key ", publicationId: "" });
	await connect("kit", { apiKey: "kit-key" });
	await connect("buttondown", { apiKey: "bd-key" });
	await connect("ghost", { siteUrl: "https://example.ghost.io/", adminKey: "abc123:00ff" });
	const sent = stubFetch(request => {
		if (request.url.includes("beehiiv.com/v2/publications?")) return Response.json({ data: [{ id: "pub_1", name: "Field Notes" }] });
		if (request.url.includes("beehiiv.com/v2/publications/pub_1")) return Response.json({ data: { name: "Field Notes" } });
		if (request.url.endsWith("kit.com/v4/account")) return Response.json({ account: { name: "Field Notes", plan_type: "creator" } });
		if (request.url.endsWith("buttondown.com/v1/newsletters")) return Response.json({ results: [{ name: "Field Notes", username: "fieldnotes" }] });
		if (request.url.includes("/ghost/api/admin/newsletters/")) return Response.json({ newsletters: [{ name: "Weekly", status: "active" }] });
		throw new Error(`unexpected ${request.url}`);
	});
	const out = await run("newsletter_provider", {});
	expect(out).toContain("beehiiv (beehiiv): Field Notes (pub_1)");
	expect(out).toContain("Kit (kit): Field Notes (creator plan)");
	expect(out).toContain("Buttondown (buttondown): Field Notes (fieldnotes)");
	expect(out).toContain("Ghost (ghost): https://example.ghost.io (newsletters: Weekly)");
	expect(sent.find(request => request.url.includes("beehiiv"))?.headers.authorization).toBe("Bearer bh-key");
	expect(sent.find(request => request.url.includes("kit.com"))?.headers["x-kit-api-key"]).toBe("kit-key");
	expect(sent.find(request => request.url.includes("buttondown"))?.headers.authorization).toBe("Token bd-key");
	expect(sent.find(request => request.url.includes("ghost"))?.headers.authorization).toStartWith("Ghost ");
});

test("with nothing connected the provider check names the Connect path and Substack's paste hand-off, calling nobody", async () => {
	const sent = stubFetch(() => {
		throw new Error("no request expected");
	});
	const out = await run("newsletter_provider", {});
	expect(out).toContain("Plugins, Newsletter, Connect");
	expect(out).toContain("Substack has no API");
	expect(sent).toEqual([]);
});

test("a provider whose key is rejected is reported, and the others still answer", async () => {
	await connect("kit", { apiKey: "stale" });
	await connect("buttondown", { apiKey: "bd-key" });
	stubFetch(request => {
		if (request.url.includes("kit.com")) return Response.json({ errors: ["The access token is invalid"] }, { status: 401 });
		return Response.json({ results: [{ name: "Field Notes" }] });
	});
	const out = await run("newsletter_provider", {});
	expect(out).toContain("Kit (kit): connected, but the check failed: Kit rejected the saved key (The access token is invalid). The person reconnects under Plugins, Newsletter, Connect, Kit.");
	expect(out).toContain("Buttondown (buttondown): Field Notes");
	expect(out).toContain("Not connected: beehiiv, Ghost.");
});
