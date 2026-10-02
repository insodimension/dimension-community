// Written for the Browser pack (doc 77 §7.4.6, matrix F6): the one tab realm the code worker's dispatcher drives, over the two kinds of tab there are.

import type { TabHandle, TabRealm } from "../contracts.js";
import type { CmuxRealm } from "./cmux/cmux-realm.js";

/**
 * A tab is a page of a Chrome (the puppeteer realm) or a surface of cmux (the cmux realm). The dispatcher does not care which: a tab name belongs to
 * exactly one realm, chosen when it is adopted, and every later `run`, `call` and `release` of that name goes to it.
 */
export function createKindRealm(parts: { tab: TabRealm; cmux: CmuxRealm }): TabRealm {
	const { tab, cmux } = parts;
	return {
		async adopt(name, handle: TabHandle) {
			// A name is bound to one browser until it is closed, so the host never rebinds across kinds; letting the old tab go first keeps the realms honest if it ever did.
			if (handle.kind === "cmux") {
				await tab.release(name);
				await cmux.adopt(name, handle);
				return;
			}
			if (cmux.has(name)) await cmux.release(name);
			await tab.adopt(name, handle);
		},
		async release(name) {
			if (cmux.has(name)) {
				await cmux.release(name);
				return;
			}
			await tab.release(name);
		},
		async run(request) {
			return cmux.has(request.name) ? await cmux.run(request) : await tab.run(request);
		},
		async call(request) {
			return cmux.has(request.name) ? await cmux.call(request) : await tab.call(request);
		},
		names() {
			return [...tab.names(), ...cmux.names()];
		},
		async end(browserId, reason) {
			await Promise.all([tab.end(browserId, reason), cmux.end(browserId, reason)]);
		},
		async dispose() {
			await Promise.all([tab.dispose(), cmux.dispose()]);
		},
	};
}
