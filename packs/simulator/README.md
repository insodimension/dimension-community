# Simulator

An Android emulator in a View beside your conversation. You watch it as live
video and tap and type on it; your agent drives the **same device** through
typed tools. Built as a community plugin on standard MCP and MCP Apps: one
artifactory (the MCP server and its View), a connector and a skill. No new
primitive, no host internals.

**It has no rail entry and no dock tab.** An emulator only matters when the work
involves an Android app, so the pane is not something to keep a button for. Your
agent opens it with `device_open` when you ask, or when it is building or running
an Android app and a look at the screen helps; the skill says so. You can always
ask: "open the simulator".

Desktop only: it needs `adb` and the Android emulator on the machine Dimension runs on.

## What it does

- **Live for you, cheap for the agent.** The View decodes H.264 from the
  emulator with WebCodecs onto a canvas (30 fps by default). The agent gets
  `device_screenshot` (a PNG scaled to a token budget) and `device_ui_tree`
  (labelled views with pixel centres), and taps by *label* before coordinates.
- **Two lanes, never mixed.** *Control* is MCP: JSON request/response, one short
  text per call. *Frames* is a dedicated binary WebSocket on loopback that only
  the View uses. A burst of video never makes a tool call wait.
- **One shared encoder per device.** The encoder (scrcpy-server) runs only while
  a viewer is attached and stops a second after the last one leaves. A second
  viewer is handed the cached config and the key frame with the deltas since, so
  it shows a picture at once and nothing restarts.
- **Boots only what it owns, and owns a process, not a serial.** The pack records
  the emulator *process* it spawned (`pid` and when it started, plus the serial it
  answers to, for display). It stops only that process tree, after checking the pid
  still started when the pack spawned it; a serial alone never stops anything (serials
  are reused, and an emulator you started yourself once got stopped through one). It
  caps what it booted (`simulator.maxDevices`, default 2), stops an idle one after
  `simulator.idleMinutes` (default 15), and stops them all on exit. An emulator you
  started yourself is never stopped, and an AVD you already run is returned by
  `device_boot`, not started a second time.
- **Honest when something is missing.** No adb, no emulator, no AVD, no scrcpy:
  each is its own state in the pane (and a line in `device_list`) with the fix.
  Without scrcpy or WebCodecs the pane says **Shot fallback** and shows still
  pictures a few times a second. It is never labelled Live.

## The toolbar and annotation

The pane has one bar across the top, the shared annotation kit's
`AnnotationToolbar` (`@dimension/mcp-app-kit/annotate`, the same bar the Viewer
and the Browser wear), mounted as a React island over the vanilla pane
(`src/view/chrome.tsx`; the canvas and the stream never go through a render).

- **Device group.** The device button names the device on screen with a state
  dot (green running, amber starting, hollow not running; amber glyph for your
  own phone) and opens the device menu. Then **Boot** (the AVD picked in the
  menu), **Stop** (only a device this pack booted), **Refresh**, and **Show
  physical devices**. A disabled control says why in its tooltip and accessible
  name; the pure rules are `deviceControls` in `view-model.ts`.
- **Drawing group.** Pin, Box, Circle, Arrow, Draw, then Undo, Redo, Clear
  (`markupToolGroups`). The armed tool wears the accent ring.
- **Status.** The bar's trailing slot carries ONE status: `Live H.264 · fps · ms`,
  `Shot fallback` (amber, the reason in its tooltip), `Reconnecting`, `Stopped`,
  or, while marking, `Frozen at HH:MM:SS`.
- **One row at every width.** Under 600 px the device button drops its name to its
  icon; narrower than the tools themselves, the bar scrolls sideways rather than wrap.

**Marking up the screen.** With no tool in hand the pane drives the device as
always. Picking a tool up freezes the frame on the canvas into a picture
(`canvas.toDataURL`, the synchronous encoder) and lays the kit's
`MarkupOverlay` over it; the screen and the Back/Home/Recents buttons are made
`inert`, so a stroke never becomes a tap. Escape, or pressing the armed tool
again, puts it down and returns to live. Put down with no marks, the frame (and
its undo history) is let go and the next tool freezes a fresh one; with marks, the
frame and marks are kept (picking a tool up shows them again) until Clear, undo or
removal takes the last mark, or another device is chosen. The overall message is
kept across freezes. **Request edits** (`AnnotationFooter`,
under the stage while a device is shown) stages the frame with the marks burned
in, each mark's frame-space position, one line naming the device (name, serial,
Android version, display size, the time it was frozen) and each mark's position
in the device's own pixels, the ones `device_tap` and `device_swipe` take. It is
staged in the chat's composer, never sent: you press Enter.

**Keys.** The drawing keys (`1`–`5`, `Ctrl+Z`, `Ctrl+Shift+Z`, `Escape`) are the
markup's only while a tool is in hand or the focus is in the toolbar. While the
screen has the keyboard they are the device's: a `1` typed into the emulator
reaches it.

## Tools

| Tool | Does |
| --- | --- |
| `device_list {allowPhysical?}` | Running devices (each with `kind`: `emulator` or `physical`), bootable AVDs, missing prerequisites with fixes and every path tried. A phone is described by adb's own listing only unless both keys are on (see **Physical phones**). |
| `device_boot {avd?, headless?, cold?, readOnly?, waitSeconds?}` | Boot an emulator. Returns within 25 s; call again with the same `avd` to wait. An AVD that already runs (even one you started) is returned as `online`/`booting`, not duplicated and not owned. `readOnly: true` starts a second, throwaway instance (`-read-only`; the result says so). If the emulator process was suspended by the system, it is resumed and the result says so. If the host GPU never answers, the boot is stopped and relaunched once with software graphics, and the result says so. A failed boot's error ends with the last 15 lines of the emulator's log. |
| `device_stop {serial}` | Stop an emulator this pack booted (refused for any other), by the process the pack spawned. |
| `device_screenshot {serial?, maxEdge?}` | PNG, at most `maxEdge` px on the long edge (default 1024); the text gives the scale to device pixels. |
| `device_tap {label}` or `{x, y}` | Tap. `label` re-reads UI Automator right before tapping; ambiguous labels are refused with the numbered choices (`occurrence`). |
| `device_swipe`, `device_type`, `device_key` | Swipe/scroll, type printable ASCII, press home/back/recents/power/volume/enter/delete/tab/escape/menu. |
| `device_open_url {url}` | Open a URL in whatever handles it. |
| `device_install {apk}` / `device_launch {package}` | Install (`-r -g -t`) an `.apk` given by an absolute path on a local drive (relative paths and, on Windows, UNC, `\\?\` and `//host` paths are refused before any file is touched); launch by package or component. |
| `device_ui_tree {maxNodes?, all?}` | One line per labelled or interactive view: `#12 Button "Sign in" id=login @540,1630 clickable`. |
| `device_open {serial?, avd?, boot?}` | Show the pane beside the conversation. |
| `device_stream` (app only) | The View's door to the frames lane: a loopback WebSocket address with a single-use token (valid for one socket; ask again to reconnect). |

Every tool that acts on a device takes `allowPhysical` (see **Physical phones**).
`serial` may be left out only when exactly one *emulator* runs (or the pane holds
one in this session). With several, name it.

## Physical phones

A phone attached over USB or Wi-Fi is the person's own device, not a test
fixture. An agent once asked to use an emulator drove the owner's real phone
because it was the only device listed. So:

- `device_list` tags each device `emulator` or `physical`
  (`classifyDevice`: an `emulator-*` serial, or a device reporting qemu).
  Anything that cannot be shown to be an emulator is physical.
- Leaving `serial` out selects only an *emulator*, never a phone, even when it is
  the only device (the tool then says no emulator is running and to call
  `device_boot`).
- Every tool that acts on a device (tap, swipe, type, key, open_url, install,
  launch, ui_tree, screenshot, open, stop) and the pane's frames lane refuse a
  physical device unless the call passes `allowPhysical: true` **and** the user's
  `simulator.allowPhysical` setting is on. The refusal names both and says to ask
  the user. The skill tells the agent to pass the flag only for a phone the user
  named in the conversation, and never to unlock it or enter a PIN.
- What `device_list` shows of a phone is gated by the same two keys. Without both
  (`allowPhysical: true` on the call and `simulator.allowPhysical` on), the pack
  runs no shell on a device whose serial does not start `emulator-`: it is listed
  from adb's own `devices -l` fields (state, model), classed `physical`, and its
  serial is masked to `****` plus its last four characters in everything the
  model reads. With both keys on, the pack reads its details and shows the full
  serial. The pane reads the structured listing, which keeps the full serial (the
  model never receives it) but is gathered under the same two keys, so a phone in
  the picker shows adb's model and state only. A network-attached emulator whose
  serial is not `emulator-*` therefore also needs both keys to be recognised.
- Turning `simulator.allowPhysical` off ends a pane that is already streaming a
  phone: within about two seconds, with no input needed, the socket closes with
  the reason and the encoder stops. While no physical viewer is attached nothing
  polls the setting.
- The pane lists emulators only. **Show physical devices** (off by default,
  disabled while the setting is off) adds phones to the device menu, each marked "physical";
  it never picks one for you, and an agent's `device_open` on a phone does not
  switch the pane to it.
- **What this gate is, and is not.** It stops an agent reaching your phone by
  mistake, which is the failure that happened. It is not a sandbox against an
  agent that can write your files or run a shell: `simulator.allowPhysical` lives
  in your agent config and the pack's ownership record (`owned.json`, which says
  which emulators it may stop) lives in your Dimension data folder, both ordinary
  files. Give an agent file-write or shell permission only as you would give it to
  a person at your keyboard, and keep `simulator.allowPhysical` off unless you are
  using a phone on purpose.

## Prerequisites

| Tool | Needed for | Where it is looked for |
| --- | --- | --- |
| **adb** (Android SDK platform-tools) | everything | `simulator.sdkPath` → `$ANDROID_HOME` → `$ANDROID_SDK_ROOT` → the default Android Studio SDK location under each home → `PATH` → `<home>/.inso/tools/mobile-sim/**` |
| **emulator** (Android Emulator + an AVD) | booting a device (a running emulator or a USB phone works without it) | the same SDK roots, then `PATH`, then `<home>/.inso/tools/mobile-sim/**` |
| **scrcpy-server** | live H.264 video (Shot fallback without it) | `$SCRCPY_SERVER_PATH` → `<home>/.inso/tools/mobile-sim/scrcpy/**` (recursive: the unzipped release is a nested folder) → the rest of `mobile-sim/**` (and `$INSO_HOME`'s) → next to a `scrcpy` on `PATH` → the package manager's share directory |

Nothing is hard-coded: `src/toolchain.ts` resolves the above at run time, and a
missing tool is reported with the command to get it and **every path that was
tried**. `<home>` is every distinct home: `os.homedir()` (which follows
`HOME`/`USERPROFILE`), the OS account's own home (`os.userInfo().homedir`) and the
environment's `HOME`/`USERPROFILE`. The Dimension dev desktop repoints
`HOME`/`USERPROFILE` at a worktree-local folder, so the tools the user installed
under their real home are only found through the account's home. The SDK's adb is
preferred over a scrcpy bundle's own (a second adb binary against the user's
server is how "adb server version doesn't match" restarts happen).

**Pinned versions this pack was built and measured against** (installed outside
the repo, under `~/.inso/tools/mobile-sim/`):

| Tool | Version | License | SHA-256 |
| --- | --- | --- | --- |
| scrcpy (`scrcpy-win64-v5.0.zip`) | 5.0 | Apache-2.0 | `44c10d9e82f20ea67227d14d37bf9fbe3603117c5736df3f514544a02ba20a73` |
| `scrcpy-server` (inside it) | 5.0 | Apache-2.0 | `26cbc9ad0aced6c2282455bef4fb43462605c1f8758c74b4ab1dbf818c229daa` |
| avdslim (`avdslim_v1.0.15_windows_amd64.zip`), optional | 1.0.15 | MIT | `8d32d97e4ca65ae08d976d30d0b15a73d06cede36ebf2250cf731323ba02f72a` |
| `avdslim.exe` (inside it) | 1.0.15 | MIT | `df2868d453053159c1174de5e2e56c26b8bbd323c603fa7b4ddbbe1c4d758d00` |

The scrcpy-server wire format (`src/android/scrcpy-wire.ts`) is version 5.0's,
measured against a live emulator: the server refuses to run unless the client
names its exact version, so the pack asks the jar its version once (it prints it
when told a wrong one) instead of trusting a folder name. A different scrcpy
release may change the protocol: pin it, and the first Live attach tells you
loudly if it does (the stream is rejected, the pane falls to Shot).

**avdslim** is optional. The pack boots with avdslim's slimming flags itself
(`-memory 1536 -gpu <simulator.gpu> -no-audio -no-boot-anim -camera-* none -lowram`, and
`-no-snapshot-save`; `-lowram` is an emulator flag, not a `-qemu` passthrough, which
Android Emulator 37 rejects). It passes **no `-port`**: a forced console port collides
with an emulator you already run on it, so the emulator takes the first free pair and the
pack learns which serial is its own (below). A cold boot adds `-no-snapshot-load`. If
`avdslim bake <avd>` has made the `avdslim_clean` golden snapshot, the pack boots from
it (about 1.5 s) unless you ask for `cold: true`.

## How a boot is supervised

Everything in `src/android/emulator-boot.ts` and `src/android/process-table.ts` is a
pure function of plain rows; `src/android/backend.ts` does the I/O.

- **Which serial is ours.** The emulator is a process *tree* (on Windows `emulator.exe`
  launches `qemu-system-x86_64.exe`, which holds the console port and burns the CPU). The
  pack lists the TCP listeners of the spawned tree and takes the `emulator-<port>` whose
  console port the tree owns (`pickSerial`); an emulator you started has a different
  tree. Where the host cannot list listeners, the single emulator that appeared since the
  spawn is taken only after its console confirms it is the AVD that was asked for.
- **A hung boot is not a slow one (`bootStalled`).** With `-gpu auto` on a busy host GPU
  the qemu process sat at about 0.6 s of CPU for 80+ s with no adb device, while a
  healthy boot is past 10 s of CPU by then. A process that is alive after 75 s, with no
  adb device and under 3 s of CPU across its whole tree, is stopped (that tree only,
  verified) and relaunched once with `-gpu swiftshader_indirect`; the tool result and the
  pane say it fell back and why. A CPU reading that cannot be taken is never a reason to
  kill. Set `simulator.gpu` to `swiftshader_indirect` to skip the wait.
- **A frozen emulator is resumed, not relaunched (`suspendedVerdict`).** The same picture
  as a hung GPU has another cause. On a Windows PC all 18 threads of the qemu process sat
  in `Wait, Suspended` at about 0.3 s of CPU, and a relaunch was frozen the same way;
  `NtResumeProcess` made the very same process run at once. Security software, a game's
  anti-cheat or Game Mode can suspend a process; the pack cannot tell which did. So 8 s
  after the spawn, then every 10 s, the pack counts the threads of the emulator process
  (the biggest process under the launcher; Windows: PowerShell `Get-Process`, hidden and
  `-EncodedCommand`; Linux: `ps -L`). With at least two threads and every one suspended it
  resumes that process (`NtResumeProcess`; `SIGCONT`), at most 3 times per boot, 5 s
  apart, and only after a second table read shows the pid still started when the first
  read said, under the launcher the pack spawned. The 75 s stall clock starts again at a
  resume. The tool result then says *"the emulator process had been suspended by the
  system (…); the pack resumed it"*: something outside the pack had paused the emulator,
  the pack let it run, and nothing was killed, relaunched or switched to software
  graphics. If it is suspended again once the 3 resumes are spent, the boot fails with
  that reason instead of a futile software relaunch. A thread reading that cannot be
  taken is never a reason to act; macOS and BSD `ps` give one line for the whole process,
  too little to call it frozen, so nothing is resumed there.
- **A relaunch waits for the last emulator to let go (`avdLockHolder`,
  `isLockRaceExit`).** Killing a stalled tree returns before its processes are gone, and
  an emulator launched into that gap exited with code 253 after a second and no log line:
  the AVD's lock (`<avd>.avd/hardware-qemu.ini.lock/pid`) still named the process just
  killed. Before relaunching, the pack waits up to 10 s until every pid of the killed tree
  (same pid and start time) is gone and the pid in that lock file names nothing running.
  A launch that still exits with code 253 within 5 s and no `FATAL` line in its own
  output is that race: the pack waits for the same thing and starts it once more, once.
- **A failed boot cleans up its own process and nothing else.** The launcher exiting
  by itself leaves nothing to kill; a timeout or a stall stops the verified tree. A
  failure that arrives after the `device_boot` call that waited for it returned is told
  to the next call for that AVD, once, instead of silently starting another boot.
- **The ownership file** (`<data>/simulator/owned.json`) holds `{serial, avd, pid,
  startedAt, bootedAt, ownerPid, ownerStartedAt}`. It is a claim to be checked, never an
  instruction. The reader drops a record whose pid is not a safe integer above 1, or is
  this process or its parent. A crashed pack's emulator is adopted at the next start
  only when its previous owner is gone (proved by pid **and** start time, so an unrelated
  process that took the dead pack's pid does not shield its orphan) and its pid still
  started when the record says **and** its command line is an `emulator` or `qemu-system-*`
  launch with `-avd <that AVD>`. A process the host gives no command line for is not
  touched. A record from before ownership was by process cannot be verified and is
  ignored. Nothing signals pid 0 or 1, a negative pid, or the pack or its parent.
- **Two `device_boot` calls for one AVD at the same time join one boot.** The second
  waits for the first to decide (reuse a running one, or spawn), then joins it.
- **The idle clock runs only for a device that is up.** It is armed when a boot succeeds
  and ignored while one is in progress, so a cold boot is not stopped by
  `simulator.idleMinutes`.
- **Exit stops what the pack booted.** Each emulator is asked to close for at most 3 s;
  when the 10 s budget ends, the processes still running are killed (verified by pid and
  start time first) and the pack waits up to 3 s more for them to go.
- **A resume names the process it opened.** On Windows the script opens the process,
  reads its creation time from that same handle and calls `NtResumeProcess` only if it
  equals the time the pack recorded; otherwise it exits with a distinct code and the
  pack logs that it did not resume. A launch the pack watched exit is never "ours"
  again, whatever later takes its pid.

## How a picture gets from the emulator to the pane

```
emulator ── adb ── scrcpy-server (H.264 encoder, control socket)
                        │ adb forward (loopback)
         ┌──────────────┴───────────────┐
   video socket                     control socket
         │                               ▲
   packet parser ─► frame cache (config + key + deltas)    pointer / key / text
         │                               │
   frame relay: ws://127.0.0.1:<port>/f/<token>  ◄──── View (sandboxed iframe, Origin: null)
        binary frames ─►  WebCodecs VideoDecoder ─► canvas
```

- The View asks `device_stream` for `{url, mode}` and connects. The token is 24
  random bytes, **one-use**: it is deleted by the first successful upgrade, so the
  one socket it opened is the only one it can ever open, and a reconnect asks
  `device_stream` for a new one (the View does that on every attempt). A token
  nobody connects with expires after a minute, and the listener exists only while
  a token or viewer does. A request must carry `Host: 127.0.0.1:<port>` (DNS
  rebinding), `Origin` absent or `null` and a live token. A wrong token, an
  unknown path and a malformed request target are all refused before the token is
  looked at, and none of them can throw in the server.
- Two deliberate looseness in that door, because the View cannot be made
  stricter. `Origin: null` is accepted because the View is a sandboxed iframe
  and a sandboxed iframe's Origin *is* `null`; it also means a web page can
  produce that Origin, so the unguessable one-use token, not the Origin, is the
  barrier (any real web origin is refused). The View's
  `_meta.ui.csp.connectDomains` is `["ws://127.0.0.1:*"]` with a wildcard port
  because the relay's port is ephemeral and is not known when the View resource
  is registered; that lets the View open a WebSocket to any loopback port, not
  only the relay's.
- **Frame gate** (shared by the server, per viewer, and the View, per decoder):
  `awaiting-config → awaiting-keyframe → streaming`. A delta is never decoded
  without its key frame, a key frame never without its config.
- **Backpressure:** when a viewer's socket backlog passes 1 MiB, pictures are
  *dropped*, never queued; the viewer waits at the gate for the next key frame.
  Key-frame requests restart the encoder for everyone, so they are throttled to
  one per second with one trailing request.
- **Input:** the View sends pointer positions normalized to the canvas (0..1).
  The server maps them to the video size and injects them on the scrcpy control
  socket (real press/move/release). In Shot fallback there is no control socket:
  a press-and-release becomes an `adb shell input tap`, a drag a `swipe`.
- **Shot** (the agent's picture, and the pane's fallback): `adb exec-out screencap`
  *raw*, box-scaled and PNG-encoded in this process with `zlib` alone (no image
  library), yielding to the event loop between bands so video and tool calls are
  never held by a screenshot.

## Settings

`simulator.maxDevices` (2), `simulator.idleMinutes` (15), `simulator.sdkPath`
(empty), `simulator.allowPhysical` (false: the user's key to a physical phone),
`simulator.gpu` (`auto`; `host`, `swiftshader_indirect` or `angle_indirect`: the
emulator's `-gpu` mode). The engine does not hand a pack's MCP server its settings, so
the server reads the same user config the engine does (`$PI_CODING_AGENT_DIR` or
`~/<$PI_CONFIG_DIR | .omp>/agent/config.yml`) when it needs a value; the environment
variables `SIMULATOR_MAX_DEVICES`, `SIMULATOR_IDLE_MINUTES`, `SIMULATOR_SDK_PATH`,
`SIMULATOR_ALLOW_PHYSICAL`, `SIMULATOR_GPU` override it. Anything but an unambiguous
`true`/`on`/`yes`/`1` reads as off for `allowPhysical`; an unknown `gpu` reads as `auto`.

`mcp.json` sets an `env` block on purpose: a server entry with an `env` is
launched with the engine's full environment (so `ANDROID_HOME` and `PATH` are
visible), one without gets only the SDK's minimal default.

## Honest limits

- **Android only.** There is no iOS backend, and no iOS entry in the pane.
  `src/backend.ts` is the seam: an iOS simulator is a **macOS-host backend** that
  implements `DeviceBackend` with `xcrun simctl` (lifecycle: `list`, `boot`,
  `shutdown`; pictures: `io screenshot`, which the existing Shot lane carries;
  input and install: `simctl` verbs such as `openurl`, `launch`, `install`). Live
  video would need a capture helper feeding the same relay; that is not designed
  here. Synara's route (loading CoreSimulator's private frameworks from a native
  addon for frames and HID) is **rejected**: private APIs break on Xcode releases
  and cannot be shipped to customers. None of it can be built or tested without
  Xcode on a Mac (the only Mac available has none), so none of it is here.
- `device_type` sends printable ASCII; other characters need the pane open (the
  View types them through the live control socket) or an app-side paste.
  `adb`'s `input text` reads a literal `%s` as a space.
- A device's *display rotation* changes the video size mid-stream; the pane
  follows (a new session + config + key frame), but `adb`-path coordinates are in
  the current rotation: re-read `device_ui_tree` after rotating.
- `device_ui_tree` needs UI Automator: secure screens and an app mid-transition
  can refuse a dump (the tool retries once and then says so).
- Mouse-wheel scrolling is not mapped; drag. Modifier shortcuts (Ctrl/Cmd/Alt)
  are not forwarded to the device. Clipboard sync is not implemented.
- One scrcpy session per device. A user running their own `scrcpy` window on the
  same device uses a different server file path and abstract socket (this pack's
  are `inso-sim-scrcpy.jar` and `scrcpy_<random>`), so they do not collide, but
  both encode.
- `device_install` of a very large APK can outlast the host's tool timeout
  (30 s on the desktop); `device_list` shows whether it landed.
- `adb forward` carries scrcpy's video and control sockets on a loopback port that
  any local process can connect to while the pack connects (up to 10 s), bypassing
  the token and the physical gate; adb's own port 5037 has the same boundary. A
  reverse tunnel (the device connects to a listener the pack owns and accepts exactly
  two connections) would remove it and is not done. The pushed `inso-sim-scrcpy.jar`
  stays in `/data/local/tmp` on the device.
- On Unix a resume is a `SIGCONT` sent right after the table read that verified the
  pid; the start-time check inside the call exists on Windows only. A Windows kill
  reads the table again just before it, then ends each member of the verified tree by
  its own pid (no `taskkill /T`), the root last; the few milliseconds between that
  read and each kill are not closed.
- The connector's `requires.commands` is checked against `PATH` by the engine,
  which does not know `ANDROID_HOME`: on a machine whose SDK is not on `PATH`, the
  connect state reads "adb is not installed" although the pack finds it itself.
  Add the SDK's `platform-tools` and `emulator` folders to `PATH` to clear it.

## Develop

```sh
bun run build      # esbuild only: app/server.mjs, app/view.html (self-contained)
```

`bun`, not `node`: the SDK's `@dimension/sdk/artifactory` is TypeScript source.
The built artifacts are committed (a pack installs with no build step). The View
is plain TypeScript and DOM, not React: the part that matters (pictures, 30 per
second) never goes through a render. It imports the kit's `--fr-*` tokens from
`@fraym/ui/theme.css`; Tailwind's own import in that file resolves to an empty
sheet at build time, because the View needs the tokens, not the utilities.
