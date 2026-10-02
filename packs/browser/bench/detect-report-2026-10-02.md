# Headless detection: what the pack's browsers show a bot check (2026-10-02, revision 4)

Measured, not argued. Every number below comes from a run on this machine (Windows 11, Ryzen 9 9950X3D, an NVIDIA RTX 4080 SUPER, Google Chrome 154.0.8037.59),
produced by `bench/detect-columns.mjs` (one column per process; commands below). `bench/sites/detect.mjs` is a local page with no network need: it
reads 51 signals a public bot check reads and says for each whether a detector would flag it. It is OUR page, written for this work, so it shows which
signals a change closes; it does not rank the browsers against a detector we did not write. It measures **property tells** and the two CDP side effects
below; it does not measure what commercial bot walls measure beyond that (see "Not measured").

Revision 4 follows a third independent review of this change. It changes four things. (1) **`browser_read`'s reader is stock puppeteer again**: OMP has no reader, so
the owner's parity ruling of 2026-10-02 does not reach it, and shaping it waits on his yes (`READER_PRESENTS_AS_CHROME`, `src/engines/agent-browser.ts`, `false`). Nothing in the
tables below is about the reader; "The reader" below says what it shows. (2) **The cross-realm `toString` hub of revision 3 is removed.** Each frame called the topmost window's
`Function.prototype.toString` with a per-process secret; a page that wrapped that function before making a frame was handed the secret and every masked name (a reviewer reproduced it,
and the new row `tostring-wrapper-heard` does: red on revision 3's code, ok now). `native-source-cross-realm` therefore flags again for the throwaway on a host with no GPU
(1 flag, listed below as a known gap), as it does for OMP's browser. (3) **Two rows are new**: `tostring-wrapper-heard` (above) and `worker-answered` (information only). A worker
that gives no answer in time is no longer a `worker-ua-headless` tell: revision 3's lone unexplained flag was that timeout counted as a tell on a loaded machine. (4) **The status of
the throwaway's shaping is the lead's reading of the owner's parity ruling** (doc 77 §12 decision 8), awaiting his signature; he did not sign the automation-hiding switch, the patched
library or the GPU mask. The page has 53 rows now: the 51 signals the counts below refer to (unchanged, and every column re-run on this code, 2 runs each, the same Chrome) and
these two, neither of which flags in any column.

Revision 3 re-ran every column on the 51-signal page (revision 2 had 49; the two new rows, `native-source-cross-realm` and `iframe-webgl-renderer`, ask a
same-origin frame about this window's functions and this window about the frame's). It corrects revision 2's account of the page log (below: Chrome's own
console errors still arrive, through the Log domain), names the `browser_task` exception and measures it, and gives the cost of the change again with more
processes behind each cold number.

Revision 2 corrected revision 1, which said "neither OMP nor this change addresses CDP Runtime.enable detection". OMP's `puppeteer-core` patch does
remove `Runtime.enable` (`omp/patches/puppeteer-core@25.3.0.patch:357-368`, `:562-595`, `:600-624`), and its `cdp-runtime-enabled` row here was inert (it read
`ok` for stock puppeteer, which sends it). The row is now a probe that is **true under stock puppeteer 25.11.0** (page and worker), proved by the saved-profile
test (`test/agent-browser.test.ts`), and this change removes `Runtime.enable` for throwaway agent browsers the way OMP's patch does.

## How each column was driven

```
bun bench/detect-columns.mjs --column stock       --runs 16            # puppeteer-core 25.11.0 launch({ headless: true }), nothing else
bun bench/detect-columns.mjs --column throwaway   --runs 16            # BrowserRuntime.open({}) from this checkout's src: AFTER
bun bench/detect-columns.mjs --column throwaway   --runs 16 --src <git archive of 188ca45 packs/browser/src, with recipes/>   # BEFORE
bun bench/detect-columns.mjs --column profile     --runs 16            # BrowserRuntime.open({ profile }): the View and every saved profile
HOME=<an empty directory> bun bench/detect-columns.mjs --column omp --runs 16 --omp omp/packages/coding-agent/src/tools/browser/launch.ts --omp-puppeteer <OMP's patched puppeteer-core 25.3.0, bundled as ESM>
bun bench/detect-columns.mjs --column reader      --runs 6  (x4 processes; with and without --src)   # browser_read: each BrowserRuntime.read of a 1 KB page (stock reader since revision 4)
```

Add `--no-gpu` for a host with no GPU (`--use-angle=swiftshader --enable-unsafe-swiftshader`, what a CI box or VPS has). Every run went through
`D:/tmp/release-0.11.1/tools/guarded.ts` (whole-tree memory cap 3072 MB, 120 s wall); the largest tree peaked at 1112 MB. For the OMP column override `HOME` only:
with `USERPROFILE` overridden too, Chrome on Windows refuses to start on the profile directory it is given (and the guard's PowerShell monitor writes a stray
`Microsoft/` folder into the working directory).

- **OMP browser (14 scripts)**: OMP's own `buildHeadlessLaunchArgs`, `stealthIgnoreDefaultArgs`, `applyStealthPatches` (the 14 scripts, the UA override on every
  page-type target) and `applyViewport`, as `tab-worker.ts` calls them, on OMP's own patched `puppeteer-core` 25.3.0 (the patched copy in the bun cache,
  bundled; its `FrameManager` sends no `Runtime.enable`, checked in the CDP log by the `cdp-runtime-enabled` row). OMP's `launchHeadlessBrowser` itself was not
  called: in revision 2 it launched the same Chrome and never connected under this harness (30 s timeout), so the `puppeteer.launch` call it makes is repeated with the
  options it passes. **OMP's own launch function was therefore not run, and its column re-creates what it passes to the launcher.** The same Chrome (`BROWSER_TEST_CHROME`) for every column.
- **pack throwaway AFTER / BEFORE**: BEFORE is `188ca45` (the base of this branch) `packs/browser/src`; AFTER is this change. The driver acts with
  `runtime.snapshot` (stock and OMP: a `querySelectorAll` evaluate). BEFORE has no `launchArgs` hook, so it has no no-GPU column.
- **pack View / saved profile**: unchanged path; BEFORE and AFTER identical.

## The signals, one by one

`FLAG` = the page saw a signal a bot check flags.

| signal | OMP browser (14 scripts, patched puppeteer) | stock puppeteer | pack throwaway BEFORE | pack throwaway AFTER | pack View / saved profile (unchanged path) |
|---|---|---|---|---|---|
| `webdriver` | ok | **FLAG** | **FLAG** | ok | **FLAG** |
| `navigator-own-properties` | ok | ok | ok | ok | ok |
| `ua-headless` | ok | **FLAG** | ok | ok | ok |
| `ua-data-headless` | ok | ok | ok | ok | ok |
| `platform-consistent` | ok | ok | ok | ok | ok |
| `chrome-object` | ok | ok | ok | ok | ok |
| `chrome-parts` | ok | ok | ok | ok | ok |
| `chrome-runtime` | ok | ok | ok | ok | ok |
| `plugins-count` | ok | ok | ok | ok | ok |
| `mimetypes-count` | ok | ok | ok | ok | ok |
| `plugins-integrity` | ok | ok | ok | ok | ok |
| `languages-empty` | ok | ok | ok | ok | ok |
| `language-first` | ok | ok | ok | ok | ok |
| `locale-intl` | ok | ok | ok | ok | ok |
| `notification-permission` | **FLAG** | ok | ok | ok | ok |
| `webgl-precision` | ok | ok | ok | ok | ok |
| `webgl-renderer` | ok | ok | ok | ok | ok |
| `hardware-concurrency` | ok | ok | ok | ok | ok |
| `device-memory` | ok | ok | ok | ok | ok |
| `outer-window` | ok | ok | ok | ok | ok |
| `outer-equals-inner` | ok | ok | ok | ok | ok |
| `outer-smaller-than-inner` | ok | **FLAG** | **FLAG** | ok | **FLAG** |
| `viewport-larger-than-screen` | ok | ok | **FLAG** | ok | **FLAG** |
| `screen-orientation` | **FLAG** | **FLAG** | **FLAG** | ok | **FLAG** |
| `window-fits-screen` | ok | ok | ok | ok | ok |
| `screen-default` | ok | **FLAG** | **FLAG** | ok | **FLAG** |
| `color-depth` | ok | ok | ok | ok | ok |
| `page-visible` | ok | ok | ok | ok | ok |
| `page-focus` | ok | ok | ok | ok | ok |
| `hairline` | ok | ok | ok | ok | ok |
| `iframe-chrome` | ok | ok | ok | ok | ok |
| `iframe-webdriver` | ok | **FLAG** | **FLAG** | ok | **FLAG** |
| `iframe-ua` | ok | **FLAG** | ok | ok | ok |
| `iframe-window-proxy` | ok | ok | ok | ok | ok |
| `native-source-cross-realm` | **FLAG** | ok | ok | ok | ok |
| `iframe-webgl-renderer` | ok | ok | ok | ok | ok |
| `tostring-wrapper-heard` (new in revision 4) | ok | ok | ok | ok | ok |
| `codec-h264` | ok | ok | ok | ok | ok |
| `codec-aac` | ok | ok | ok | ok | ok |
| `audio-context` | ok | ok | ok | ok | ok |
| `fonts-installed` | ok | ok | ok | ok | ok |
| `accessor-receiver` | ok | ok | ok | ok | ok |
| `native-source` | ok | ok | ok | ok | ok |
| `ch-ua-header-headless` | ok | ok | ok | ok | ok |
| `accept-language` | ok | ok | ok | ok | ok |
| `worker-answered` (new in revision 4; information only, never a tell) | info | info | info | info | info |
| `worker-ua-headless` | ok | **FLAG** | ok | ok | ok |
| `worker-webdriver` | ok | ok | ok | ok | ok |
| `webgl-worker-renderer` | ok | ok | ok | ok | ok |
| `worker-matches-page` | **FLAG** | ok | ok | ok | ok |
| `worker-runtime-enabled` | ok | **FLAG** | **FLAG** | ok | **FLAG** |
| `cdp-runtime-enabled` | ok | **FLAG** | **FLAG** | ok | **FLAG** |
| `driver-main-world` | ok | **FLAG** | **FLAG** | ok | **FLAG** |
| **flagged of the 51 signals** | **4** | **11** | **9** | **0** | **9** |

`worker-runtime-enabled`, `cdp-runtime-enabled` and `driver-main-world` are the three CDP-side rows. `cdp-runtime-enabled` is true while a DevTools client has Runtime
enabled in the page (V8 formats a logged Error's stack, calling `Error.prepareStackTrace`, only then; raw CDP on Chrome 154 reads false before `Runtime.enable` and true after).
`driver-main-world` is true when a hook a site put on `document.getElementById` / `querySelector*` / `getBoundingClientRect` heard a call from outside the page's own
scripts (a driver name, or a frame with no script URL, which is what an evaluated string is). `native-source-cross-realm` is the standard iframe "lies" test: a function a
script replaced, read through another realm's own `Function.prototype.toString`, must still read `function <name>() { [native code] }`. `iframe-webgl-renderer` reads a
same-origin frame's WebGL renderer (the page's own may be masked; a frame's is a third place to look). `tostring-wrapper-heard` (revision 4) replaces
`Function.prototype.toString` with a recording wrapper, makes an empty frame and a `srcdoc` frame, lets them load, touches their WebGL, restores the original, and flags anything the
wrapper heard that the page did not ask: a script of the browser calling through a function the page can replace. Red on revision 3's code (the frames called it with the secret
symbol and each masked name), ok on every column now, including OMP's. `worker-answered` says whether the dedicated worker reported back inside 1.5 s; a worker that did not is reported
as "no answer", and every worker row reads ok without one (as `ch-ua-header-headless` already did).

### A cross-origin iframe (an out-of-process frame: its own renderer, CDP session and document start)

| browser | `navigator.webdriver` | HeadlessChrome in its User-Agent | Runtime enabled | WebGL renderer it reports |
|---|---|---|---|---|
| OMP browser | false | **true** | false | the host's |
| stock puppeteer | **true** | **true** | **true** | the host's |
| pack throwaway AFTER | false | false | false | the host's |
| pack View / saved profile | **true** | false | **true** | the host's |

OMP applies its User-Agent override to page-type targets only (`launch.ts:820-826`), so a cross-origin frame of an OMP page still says HeadlessChrome.

### A host with no GPU

Flagged signals with `--use-angle=swiftshader --enable-unsafe-swiftshader`:

| browser | flagged |
|---|---|
| OMP browser (6) | notification-permission, screen-orientation, native-source-cross-realm, worker-matches-page, **webgl-worker-renderer**, **webgl-precision** (its fake GPU is in the page; its worker's OffscreenCanvas still names SwiftShader; its precision formats still differ across float types) |
| stock puppeteer (14) | webdriver, ua-headless, **webgl-renderer**, outer-smaller-than-inner, screen-orientation, screen-default, iframe-webdriver, iframe-ua, **iframe-webgl-renderer**, worker-ua-headless, webgl-worker-renderer, worker-runtime-enabled, cdp-runtime-enabled, driver-main-world |
| pack View / saved profile, unchanged (12) | webdriver, **webgl-renderer**, outer-smaller-than-inner, viewport-larger-than-screen, screen-orientation, screen-default, iframe-webdriver, **iframe-webgl-renderer**, webgl-worker-renderer, worker-runtime-enabled, cdp-runtime-enabled, driver-main-world |
| pack throwaway AFTER (1) | `native-source-cross-realm` (the known gap: a same-origin frame's own `toString` reads this window's replaced functions without a name, and this window's reads the frame's; revision 3 closed it with the hub that leaked and revision 4 removed the hub). The cross-origin frame, a same-origin frame and each worker report the masked Intel GPU |

### What the OMP column flags, and why

- `worker-matches-page`: OMP pins `navigator.hardwareConcurrency` to 8 in the page and not in its workers, which report the real 32.
- `notification-permission`: on a plain-`http` origin (this page is `http://127.0.0.1`) OMP answers `permissions.query` "denied" while `Notification.permission` is "default". Not tested on `https`.
- `screen-orientation`: OMP's `setViewport` leaves a 1365x768 page reporting `portrait-primary`.
- `native-source-cross-realm` (new in revision 3): a frame's own `Function.prototype.toString` and this window's disagree about a function OMP replaced. The row says only that they disagree; that OMP's `00_stealth_tampering` keeps its registry in one realm is [INFERENCE from its design], not read off the row.
- with no GPU, `webgl-worker-renderer` and `webgl-precision` (above), and a HeadlessChrome User-Agent in cross-origin frames.

### The reader (`browser_read`)

OMP has no reader, so the owner's parity ruling of 2026-10-02 ("no request or feature loss or performance or optimization loss from the OMP version") cannot reach it, and nobody has
signed shaping it. Revision 3 shaped it like a throwaway; **revision 4 launches it as stock puppeteer, as on main**, behind one constant (`READER_PRESENTS_AS_CHROME = false`,
`agent-browser.ts`). `test/agent-browser.test.ts` reads the detect page through `browser_read` and sees what stock puppeteer shows: `webdriver` flagged, `ua-headless` flagged,
`webgl-renderer` naming SwiftShader (with `--no-gpu`), `RUNTIME|on`. The same file launches the reader with the shaping turned on (`launchReader({ presentAsChrome: true })`) and sees the
throwaway's result: none of nine controlled rows flagged, `RUNTIME|off`, no SwiftShader, no hook heard the driver. The reader is not a column of the table above (its page cannot POST rows).

### While a `browser_task` agent is attached

`browser_task` hands the throwaway's CDP endpoint to a task agent (`runtime.ts`, `cdpUrl: entry.driver.cdpEndpoint()`; `python/dim_browser_bridge/browser_use_task.py`, `jev_task.py`).
Those agents run their own CDP clients, not the patched library, so for the length of a task the protections that live in the pack's own library (no `Runtime.enable`,
reads in the utility world) do not bind them. Measured with stock puppeteer-core attached to the throwaway's DevTools port as a stand-in for a task agent's client (it
enables Runtime on the page; the agents themselves, browser-use and jev, were not run), on this host's GPU and with `--no-gpu`:

| | flagged of 51 (both with and without a GPU) |
|---|---|
| throwaway alone | none |
| throwaway with a second client attached | `worker-runtime-enabled`, `cdp-runtime-enabled` (2) |

`driver-main-world` stays ok in that run only because the stand-in read nothing in the page's world; a task agent's `Runtime.evaluate` in the main world would flag it [INFERENCE].
The launch switches, the screen and window fit and the GPU mask hold (no other row flags, with and without a GPU): they are sent by the pack's own session, which stays attached.
Measured: the Runtime rows. Not measured: browser-use and jev driving a page.

## Coverage of OMP: its 14 scripts, launch flags and patch, against this change

"Closed" names the place; a gap says what is left. Rows say `native` where the unpatched Chrome already answers as a person's.

| OMP | here |
|---|---|
| `00_stealth_tampering` (a native-source registry over `Function.prototype.toString`, every document) | Nothing replaced on a host with a GPU. With a software renderer: the mask's replaced `getParameter`, `getShaderPrecisionFormat` and `toString` read as native, named functions to **their own realm's** `Function.prototype.toString` (`SOFTWARE_GRAPHICS_MASK` in `agent-browser.ts`; row `native-source` ok). **Gap, measured and open:** another same-origin realm's own `toString` reads them as `function () { [native code] }` with no name (row `native-source-cross-realm` flags with no GPU, for OMP's column too). Revision 3 closed it by having each frame call the topmost window's `toString` with a secret; a page that wrapped that function first was handed the secret and every masked name, so it was removed (row `tostring-wrapper-heard`). A cross-origin frame's or a popup's `toString` on this window's functions cannot be asked by any script of ours. **Gap (same as OMP's):** a TypeError thrown through a wrapper shows an `Object.apply` frame (measured, no-GPU host). |
| `01_stealth_activity` (`hidden`, `hasFocus`) | `Emulation.setFocusEmulationEnabled` on every tab (`puppeteer.ts`, where a tab is adopted); rows `page-visible`, `page-focus` ok. **Not tested:** a background tab's `visibilityState` (doc 77 §7.4.8 item 4). |
| `02_stealth_hairline` | native; row `hairline` ok. |
| `03_stealth_botd` | `navigator.webdriver`: the `AutomationControlled` Blink switch (`AGENT_LAUNCH_ARGS`, `agent-browser.ts`), **headless only** (a window gets an "unsupported command-line flag" bar from it). `chrome.app/csi/loadTimes`, `chrome.runtime`: native; `chrome.runtime` is not faked (row `chrome-runtime` reports `undefined`, ok). `Notification`/`permissions`: native, ok **on http only; https not tested**. `cdc_`: chromedriver only, n/a. |
| `04_stealth_iframe` (iframe `contentWindow`) | native; rows `iframe-chrome`, `iframe-webdriver`, `iframe-ua`, `iframe-window-proxy` ok; a cross-origin frame measured (table above). The GPU mask in a same-origin `srcdoc` frame and in an empty frame a script makes and reads at once: **measured** (`iframe-webgl-renderer` ok with and without a GPU; `native-source-cross-realm` ok with a GPU, **flags with none**, see the row above). |
| `05_stealth_webgl` | Unmasked vendor/renderer in the page, each frame and each dedicated/shared worker (**not a service worker**), sent before the target runs by `shapeTargetEarly`, called from `presentAsHeadful` (`puppeteer.ts`). Float precision formats: closed (`getShaderPrecisionFormat` answers the highest float's for the lower two, as ANGLE does; row `webgl-precision`). `getParameter(VENDOR/RENDERER)` is `WebKit` / `WebKit WebGL` natively, with or without a GPU (measured), as OMP's rewrite makes it. **Gap:** texture and uniform limits, the extension list and the render hash stay SwiftShader's (measured: `MAX_TEXTURE_SIZE` 8192 against 16384 on the host GPU; 36 extensions against 35). OMP changes none of these either. |
| `06_stealth_screen` | A device-metrics override and the window bounds (`deviceMetrics`, `fitAgentScreen` in `agent-browser.ts`), again on every resize; for a popup or new tab the metrics go out before its first document (`shapeTargetEarly`), the window bounds when the tab is adopted (so a popup's `outerWidth` at its very first script is not covered). |
| `07_stealth_fonts`, `08_stealth_audio`, `11_stealth_hardware`, `12_stealth_codecs` | Deliberately not invented; host-native. **Not closed on a bare VPS or container** (few fonts, no audio device, 1-2 cores). OMP pins `hardwareConcurrency` in the page and not in its workers, which is its own `worker-matches-page` flag. |
| `09_stealth_locale`, `10_stealth_plugins` | native (headless Chrome 154 has the PDF viewer plugins); rows ok. |
| `13_stealth_worker` (a wrapper that patches UA and platform in same-origin http(s) workers) | UA, client hints and platform on **every** target (blob and cross-origin workers, shared and service workers, frames): `presentAsHeadful`, `puppeteer.ts`. The worker's GPU: `shapeTargetEarly`, sent on the worker's own session before it runs, a `Runtime.evaluate` into the paused worker, which needs no `Runtime.enable`. |
| Launch flags: `--enable-automation` | Dropped for every browser (`viewLaunchOptions`, `launch.ts`; the View's too, as before). **Edge exception not adopted:** OMP keeps it for Edge because Edge "can exit before CDP opens"; the pack drops it always and has not run Edge in this revision. |
| `--disable-popup-blocking`, `--disable-ipc-flooding-protection`, `--allow-pre-commit-input` | Dropped for a throwaway agent browser (`AGENT_IGNORED_DEFAULT_ARGS`). A page that opens a window with no click gets `null` as in a person's Chrome in the throwaway and in the reader (the stock reader has always kept the popup blocker on), and a window in a saved profile (`test/agent-browser.test.ts`, popup blocker). |
| `--disable-default-apps`, `--disable-component-extensions-with-background-pages`, `--disable-client-side-phishing-detection`, `--metrics-recording-only` | **Kept on purpose** (`puppeteer.ts` `CHROMIUM_ARGS`): they stop Chrome phoning home and a page cannot see them. OMP strips them as flag fingerprints (only `chrome://version` shows it). `--disable-extensions`: not stripped; a page cannot see it. |
| patch: `Runtime.enable` removal (`FrameManager`, `IsolatedWorld`, `WebWorker`) | `patches/puppeteer-core-25.11.0-agent.patch`, applied while bundling `app/puppeteer-agent.mjs` (`scripts/agent-puppeteer.mjs`); loaded only for agent browsers (`launchChromium` in `puppeteer.ts`; `launchReader` loads it only with `READER_PRESENTS_AS_CHROME` on, which it is not). The View and saved profiles keep the stock library (relay test and profile test hold it). The bundle's head carries oh-my-pi's MIT notice. |
| patch: DOM work in the utility world, `//!world=main` opt-in | same patch (`api/Frame.js`, `api/ElementHandle.js`, `common/QueryHandler.js`). The model's own `eval` goes by raw `Runtime.evaluate` in the page's world, unchanged. A page's own override of a DOM method no longer reaches the pack's reads on a throwaway (`test/act-batch.test.ts`). |
| patch: no `__puppeteer_evaluation_script__` / `pptr:` sourceURL | same patch (`cdp/ExecutionContext.js`); replaces the pack's earlier `_rawSend` strip. |
| patch: default `--disable-features` list dropped | **Not ported**: a throwaway keeps puppeteer's own list. The detection page flags nothing (0 of 53) with the list as well as without it, so no row proves it leaks automation. Dropping it left six features on that the pack's own `CHROMIUM_ARGS` does not disable, and Chrome then started one more renderer process in every browser (4 throwaways idle: 12 renderers and 921 MB private against 8 and 738 MB with the list, one sample each). Re-enabling the six one at a time with `--enable-features` (one sample each): `WebUIOmniboxPopup` and `WebUIOmniboxAimPopup` each bring the extra renderer; `AcceptCHFrame`, `WebUIReloadButton`, `ProcessPerSiteUpToMainFrameThreshold` and `IsolateSandboxedIframes` change nothing. **Not read by the page:** `AcceptCHFrame` (a local HTTP/1.1 server sends no Accept-CH frame), so that entry stays on the memory ruling and not on a measurement of client-hint negotiation. A test launches both libraries and compares Chrome's real argv (`test/agent-puppeteer.test.ts`, `test/agent-browser.test.ts`). |
| patch: exposeFunction bindings in the main world | ported (`cdp/Frame.js`); the pack exposes no bindings. |
| OMP's main-world bootstrap (14 scripts in one `evaluateOnNewDocument`, a hidden iframe appended in every document) | Not done: the pack's only document-start page scripts are the GPU mask (software renderer hosts) and the loopback-only error reporter. |

**What the Runtime patch costs the pack, and what replaces it.** Without Runtime events puppeteer's `pageerror` is dead for an agent browser, and so is the `console` event it
builds from Runtime (the page's own `console.*` calls). Revision 2 said `page.on("console")` was dead outright; that was wrong. Puppeteer 25.11.0 still turns the **Log** domain on for
every page and emits `console` for each `Log.entryAdded`, and Chrome's own messages (a Content-Security-Policy refusal, a request blocked by CORS, mixed content, a deprecation)
come that way; the patch does not touch it and a page cannot tell it is on. So an agent browser keeps that handler: Chrome's own errors and warnings from the Log domain, the page's
own `console.*` from the Console domain (measured: `Console.enable` does not make the Runtime probe true), on localhost and on every other site
(`test/agent-page-log.test.ts`: CSP, a CORS refusal and the page's own `console.error`, on `127.0.0.1` and on a non-loopback name). What is lost is an uncaught exception or
unhandled rejection on a page **not served from this machine**: it needs a listener in the page, installed **only for loopback pages** (`LOOPBACK_EXCEPTIONS`, `page-log.ts`; the same test
shows nothing is installed on a `site.test` name). That is a real loss against the earlier behaviour on the public web, made on purpose; the alternative was a script on every page.

## Public pages

- `https://bot.sannysoft.com` was measured on revision 1 of this change and **not re-run** on revisions 2 or 3 (no change since touches what it reads except the Runtime probe).
- `https://arh.antoinevastel.com/bots/areyouheadless` was down on revision 1 (502) and not retried.

## Cost of the change

The open and first-navigation table below is **revision 3's** (quiet machine, 16 runs); it was not re-measured in revision 4. Revision 4 changes the throwaway's launch path in nothing
but the GPU mask on a host with no GPU (no cross-realm calls any more); the reader's cost is re-measured below.

Same machine, other work running on it, the columns run one after another in separate processes; "cold" is the first open in a process (it includes the once-per-binary
identity probe both versions pay). Open = `runtime.open({})` / `launch` + `newPage`; first navigation = to a 1 KB local page. Later runs: median (IQR), n = 15.

| | open, cold (first of 16) | open, later | first navigation, later |
|---|---|---|---|
| stock puppeteer | 243 ms | 261 ms (253-278) | 16 ms (15-18) |
| OMP browser | 406 ms | 467 ms (452-489) | 34 ms (31-35) |
| pack throwaway BEFORE | 684 ms | 361 ms (293-424) | 27 ms (21-43) |
| pack throwaway AFTER | 802 ms | 280 ms (268-305) | 22 ms (18-34) |
| pack View / saved profile | 646 ms | 256 ms (248-275) | 17 ms (16-19) |

A cold number is one process, so the first open of a throwaway was repeated in separate processes, alternating the two versions: AFTER 802, 821, 823, 858, 1081 ms (median 823);
BEFORE 624, 684, 696, 705, 728, 732, 778, 838 ms (median 716). **The first throwaway open of a process is about 100 ms slower after this change.** Loading the patched library alone
takes 40-42 ms in isolation (three runs); the rest is not attributed [INFERENCE: the patched copy is a second module instance, so its launch path is cold where BEFORE's was warmed by the
identity probe, which uses the same copy]. Overlapping the library load with the identity probe was tried and moved the median by nothing measurable (818 ms, five processes), so it was not kept.
Later opens and first navigations show no loss: AFTER's later open is not slower than BEFORE's (280 against 361 ms; BEFORE's IQR is wide), and the saved-profile control, whose code did not change,
moved from 316 ms in revision 2 to 256 ms here, so differences under about 100 ms are not told apart on this machine.

browser_read, `BrowserRuntime.read` of the 1 KB page, four processes each (cold = the first read in the process, which launches the reader; warm = median of the next five).

**Revision 4 (the reader is stock again; BEFORE and AFTER alternated, four process pairs, on a machine busy with other work, so everything is slower than revision 3's quiet-machine run):**

| | cold first read | warm read, medians |
|---|---|---|
| BEFORE (188ca45's `src`) | 696, 773, 916, 1090 ms | 235, 258, 260, 283 ms |
| AFTER (this change, reader stock) | 767, 872, 928, 1087 ms | 271, 275, 290, 318 ms |

The reader launches the same way as on main, so no cost is intended and none is claimed. The cold reads are not told apart. The warm medians of AFTER are above BEFORE's in each pair by 15-36 ms
(means 288 against 259 ms); with four pairs on a loaded machine that is within what the machine did to the two versions, and the cause, if it is real, is **not attributed**.

**Revision 3 (the reader shaped; applies if `READER_PRESENTS_AS_CHROME` is turned on; not re-measured in revision 4, quiet machine):**

| | cold first read | warm read, medians |
|---|---|---|
| BEFORE | 426, 468, 509, 514 ms | 153, 157, 158, 168 ms |
| AFTER, reader shaped | 644, 677, 705, 754 ms | 162, 189, 194, 218 ms |

A shaped reader's first read is about 200 ms slower, once per process (the median of four: BEFORE 489 ms, AFTER 691 ms): the patched library loads (about 40 ms) and the reader reads its identity
from its own browser (a blank page, two evaluates) instead of a probe Chrome launched in front of it, which revision 1 did (it cost 600-1000 ms). A warm read is slower too, by about 30 ms
(the mean of the four process medians, 191 ms against 159 ms; three of the four AFTER medians are above every BEFORE median). The cause is not attributed [INFERENCE: each read now
sends a device-metrics override and a document script to a new page and reads in the utility world]. Revision 2 called the warm read "within the noise"; with these four processes it is not.

## Not measured

- A real headful Chrome (no visible window was opened on a machine that may have a game in front); "what a person's Chrome reports" is the browser's own values for the signals left alone. **The headful throwaway path** (the patched library, no `AutomationControlled` switch, window bounds when a tab is adopted) is therefore not run at all in this revision, and no test covers it.
- One GPU (this host's NVIDIA) and a simulated GPU-less Chrome; no real GPU-less machine, no Linux or macOS run, no Edge or Chrome for Testing in revisions 2 or 3.
- Commercial bot walls (Cloudflare, DataDome, Akamai). The page covers property tells, `Runtime.enable`, hooked page APIs, a worker, a cross-origin frame and two same-origin frames. It does **not** cover
  canvas 2D / audio render hashes and their noise, timing (`rAF` cadence, `performance.now` granularity), input behaviour (a `mouse.click` teleports to an exact centre with no
  prior `mousemove`; keystrokes have no timing variance), `speechSynthesis` voices, `mediaDevices.enumerateDevices`, `Notification` on an `https` origin, or a background tab.
- **The cross-realm `toString` gap**: on a host with no GPU, a same-origin frame's own `Function.prototype.toString` and this window's disagree about the mask's replaced functions (row `native-source-cross-realm`, measured and flagged, as for OMP). Not closed; closing it needs a channel between realms that a page cannot intercept, and the revision-3 hub was not one.
- A service worker's GPU (the mask goes to the page, frames, dedicated and shared workers only).
- The shaped reader (`READER_PRESENTS_AS_CHROME` on) against the detect page in a full column: it is covered by one test (nine controlled rows, Runtime, GPU), not by a 51-row column.
- `browser_task`'s agents themselves (browser-use, jev): only a stand-in second CDP client.
- `webgl-precision` and the limits above judge SwiftShader against this host's GPU, not against a table of real GPUs.
- BEFORE with no GPU: BEFORE has no `launchArgs` hook to start a no-GPU Chrome with.
