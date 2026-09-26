/**
 * A fake social site for the publish tests, on 127.0.0.1 (and `localhost`, a
 * different origin on the same server).
 *
 * `/compose?v=<variant>` holds a textarea `#text`, a contenteditable `#rich`, a
 * password input `#secret` and a `#post` button. `#me` (the signed-in marker)
 * is served only when the `/login` cookie is present. The page counts what
 * reaches it in its own title — `writes:<n> clicks:<n> secret:<n>` — so the
 * test can prove "nothing was typed" and "submit was clicked once" from the
 * live document. `?text=&rich=` prefill the fields as page content (no write
 * counted, no human input). `#post` POSTs both fields to `/submit` (the
 * server-side write count), then, per variant:
 *  - `nav`      navigates to `/alice/status/<n>` (the receipt is the tab URL);
 *  - `offsite`  navigates to the same path on the OTHER origin (`localhost`);
 *  - `toast`    adds `<a class="toast" href="/alice/status/<n>">` to the page;
 *  - `stale`    nothing — but a matching toast link was on the page before submit;
 *  - `stale-new` like `stale`, then adds the new toast link after it;
 *  - `stay`     nothing at all;
 *  - `rewrite`  like `nav`, but `#text`'s input handler upper-cases what is typed;
 *  - `steal`    `#text`'s focus handler moves focus to another input, `#other`,
 *               whose input events count as writes too;
 *  - `shadow`   like `nav`, plus `<compose-box id="box">` whose OPEN shadow root
 *               holds a textarea `#inner`; its input events count as writes and
 *               `#post` submits its value as `text`;
 *  - `shadow-steal` like `shadow`, but `#inner`'s focus handler moves focus to
 *               `#decoy` in the same shadow root, whose input events count too;
 *  - `shadow-toast` like `toast`, but the link goes inside the OPEN shadow root
 *               of `<toast-host id="toasthost">`, out of reach of plain CSS.
 */
import { randomBytes } from "node:crypto";

export type ComposeVariant = "nav" | "offsite" | "toast" | "stale" | "stale-new" | "stay" | "rewrite" | "steal" | "shadow" | "shadow-steal" | "shadow-toast";

export interface PublishFixture {
	url(path: string, host?: "127.0.0.1" | "localhost"): string;
	readonly origin: string;
	/** Requests for `path` on either host. */
	hits(path: string): number;
	/** Resolves once `path` has been requested on either host (at once if it already was). */
	reached(path: string): Promise<void>;
	/** Every POST /submit body, in order. The real write count. */
	submissions(): ReadonlyArray<{ text: string; rich: string }>;
	stop(): Promise<void>;
}

const COOKIE = "pubsid";

function composePage(variant: ComposeVariant, signedIn: boolean, offsiteOrigin: string): string {
	const stale = variant === "stale" || variant === "stale-new" ? `<a class="toast" href="/alice/status/0">your earlier post</a>` : "";
	return `<!doctype html><html><head><meta charset="utf-8"><title>writes:0 clicks:0 secret:0</title></head><body>
${signedIn ? `<p id="me">@alice</p>` : `<p>sign in to post</p>`}
<textarea id="text"></textarea>
<div id="rich" contenteditable="true" style="min-height:40px;border:1px solid #999"></div>
<input id="secret" type="password" />
<button id="post" type="button">Post</button>
${variant === "steal" ? `<input id="other" />` : ""}
${variant === "shadow" || variant === "shadow-steal" ? `<compose-box id="box"></compose-box>` : ""}
<div id="toasts">${stale}</div>
${variant === "shadow-toast" ? `<toast-host id="toasthost"></toast-host>` : ""}
<script>
  var variant = ${JSON.stringify(variant)};
  var offsite = ${JSON.stringify(offsiteOrigin)};
  var writes = 0, clicks = 0, secret = 0;
  var text = document.getElementById("text"), rich = document.getElementById("rich");
  function show() { document.title = "writes:" + writes + " clicks:" + clicks + " secret:" + secret; }
  // ?text=&rich= prefill the fields as the page's own content, not input: no write is counted.
  var query = new URLSearchParams(location.search);
  if (query.has("text")) text.value = query.get("text");
  if (query.has("rich")) rich.innerText = query.get("rich");
  text.addEventListener("input", function () {
    writes++; show();
    if (variant === "rewrite") text.value = text.value.toUpperCase();
  });
  rich.addEventListener("input", function () { writes++; show(); });
  if (variant === "steal") {
    var other = document.getElementById("other");
    text.addEventListener("focus", function () { other.focus(); });
    other.addEventListener("input", function () { writes++; show(); });
  }
  var inner = null;
  if (variant === "shadow" || variant === "shadow-steal") {
    var root = document.getElementById("box").attachShadow({ mode: "open" });
    root.innerHTML = '<textarea id="inner"></textarea><textarea id="decoy"></textarea>';
    inner = root.getElementById("inner");
    inner.addEventListener("input", function () { writes++; show(); });
    var decoy = root.getElementById("decoy");
    decoy.addEventListener("input", function () { writes++; show(); });
    if (variant === "shadow-steal") inner.addEventListener("focus", function () { decoy.focus(); });
  }
  var toastRoot = variant === "shadow-toast" ? document.getElementById("toasthost").attachShadow({ mode: "open" }) : null;
  ["focus", "keydown", "input", "beforeinput"].forEach(function (type) {
    document.getElementById("secret").addEventListener(type, function () { secret++; show(); });
  });
  document.getElementById("post").addEventListener("click", async function () {
    clicks++; show();
    var response = await fetch("/submit", { method: "POST", body: JSON.stringify({ text: (inner || text).value, rich: rich.innerText }) });
    var n = (await response.json()).n;
    var path = "/alice/status/" + n;
    if (variant === "nav" || variant === "rewrite" || variant === "shadow") location.href = path;
    else if (variant === "offsite") location.href = offsite + path;
    else if (variant === "toast" || variant === "stale-new" || variant === "shadow-toast") {
      var link = document.createElement("a");
      link.className = "toast"; link.href = path; link.textContent = "view your post";
      (toastRoot || document.getElementById("toasts")).appendChild(link);
    }
  });
</script></body></html>`;
}

function html(markup: string, headers: Record<string, string> = {}): Response {
	return new Response(markup, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers } });
}

const VARIANTS: readonly ComposeVariant[] = ["nav", "offsite", "toast", "stale", "stale-new", "stay", "rewrite", "steal", "shadow", "shadow-steal", "shadow-toast"];

export function startPublishFixture(): PublishFixture {
	const hits = new Map<string, number>();
	const submissions: { text: string; rich: string }[] = [];
	const awaited = new Map<string, Array<() => void>>();
	const session = randomBytes(8).toString("hex");
	const origin = (host: string): string => `http://${host}:${server.port}`;

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const { pathname } = url;
			hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
			for (const resolve of awaited.get(pathname)?.splice(0) ?? []) resolve();
			if (pathname === "/login") {
				return html("<!doctype html><title>signed in</title><p>signed in</p>", { "set-cookie": `${COOKIE}=${session}; Path=/; SameSite=Lax` });
			}
			if (pathname === "/compose") {
				const variant = VARIANTS.find((candidate) => candidate === url.searchParams.get("v")) ?? "nav";
				const signedIn = (request.headers.get("cookie") ?? "").includes(`${COOKIE}=${session}`);
				return html(composePage(variant, signedIn, origin(url.hostname === "localhost" ? "127.0.0.1" : "localhost")));
			}
			if (pathname === "/submit" && request.method === "POST") {
				submissions.push(JSON.parse(await request.text()));
				return Response.json({ n: submissions.length });
			}
			// `/landed` is hit once a receipt page has loaded: the tab's URL has committed.
			if (/^\/alice\/status\/\d+$/.test(pathname)) return html(`<!doctype html><title>post</title><p>posted</p><script>fetch("/landed")</script>`);
			if (pathname === "/landed") return new Response("ok");
			return new Response("not found", { status: 404 });
		},
	});

	return {
		url: (path, host = "127.0.0.1") => `${origin(host)}${path}`,
		origin: origin("127.0.0.1"),
		hits: (path) => hits.get(path) ?? 0,
		reached: (path) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			if (hits.has(path)) resolve();
			else awaited.set(path, [...(awaited.get(path) ?? []), resolve]);
			return promise;
		},
		submissions: () => submissions,
		stop: async () => {
			await server.stop(true);
		},
	};
}
