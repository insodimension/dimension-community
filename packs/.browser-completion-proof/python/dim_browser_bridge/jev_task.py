"""Runs jev_ultrafast.Agent tick by tick so a cancel request is honoured between actions.

jev reaches Chrome through a browser-harness daemon named by BU_NAME and pointed at the CDP
websocket by BU_CDP_WS; the daemon is stopped on exit. jev's own background tab stays open.
"""

import json
import os
import uuid

TOKEN_KEYS = {
    "inputTokens": ("input_tokens", "prompt_tokens", "inputTokens", "promptTokens"),
    "outputTokens": ("output_tokens", "completion_tokens", "outputTokens", "completionTokens"),
}


def _tally(state):
    """Cumulative usage over every model call jev made (choices + field text)."""
    calls = state["decisions"] + state["text_calls"]
    usage = {"modelCalls": len(calls), "inputTokens": 0, "outputTokens": 0, "costUsd": None}
    for call in calls:
        raw = call.get("usage") or {}
        for field, keys in TOKEN_KEYS.items():
            usage[field] += next((int(raw[k]) for k in keys if isinstance(raw.get(k), (int, float))), 0)
        if isinstance(raw.get("cost"), (int, float)):
            usage["costUsd"] = (usage["costUsd"] or 0) + raw["cost"]
    return usage


def _label(entry):
    label = f"{entry['kind']} '{entry['action']}'"
    return f"{label} = {entry['text']!r}" if entry.get("text") is not None else label


def run(request, cancel, report):
    missing = [k for k in ("TYPESAFE_API_KEY", "TEXT_MODEL_API_KEY") if not os.environ.get(k)]
    if missing:
        return "failed", f"jev needs {' and '.join(missing)} in the browser server's environment."
    name = f"dim-{uuid.uuid4().hex[:12]}"
    # browser_harness reads both at import time, so they are set before jev is imported.
    os.environ["BU_CDP_WS"] = request["cdpUrl"]
    os.environ["BU_NAME"] = name
    try:
        from jev_ultrafast import Agent

        if cancel.is_set():
            return "cancelled", "Cancelled before start."
        credential = request.get("credential")
        goal = _jev_goal(request["task"], credential)
        try:
            agent = Agent(request.get("startUrl") or "about:blank", goal)
        except RuntimeError as exc:
            # The harness daemon's first CDP calls sometimes miss its 5 s IPC
            # budget while Chrome is busy adopting the new tab. Starting is
            # read-only (a blank tab, then navigation), so one retry is safe.
            if "timed out" not in str(exc):
                raise
            print(f"jev start retried after: {exc}", flush=True)
            agent = Agent(request.get("startUrl") or "about:blank", goal)
        state = agent.state
        try:
            while state["status"] not in ("done", "blocked"):
                if cancel.is_set():
                    return "cancelled", f"Cancelled after {len(state['history'])} actions."
                if len(state["history"]) >= request["maxSteps"]:
                    return "blocked", f"Stopped at the {request['maxSteps']}-action limit."
                seen = len(state["history"])
                if credential and _fill_passwords(agent.browser, credential):
                    report.step(f"fill password fields on {credential['origin']} (by the browser, never shown to jev)", state["page"]["url"])
                agent.command("tick")
                report.usage = _tally(state)
                for entry in state["history"][seen:]:
                    report.step(_label(entry), entry["url"])
        finally:
            report.usage = _tally(state)
        url = state["page"]["url"]
        if state["status"] == "done":
            return "done", f"Done after {len(state['history'])} actions at {url}."
        return "blocked", f"jev could not make progress at {url}."
    finally:
        _stop_daemon(name)


def _jev_goal(task, credential):
    """jev cannot see password fields, so a goal that asks it to enter a
    password makes it keep refilling the field before them. When the browser
    fills passwords, jev is told so. The goal never carries the value: the
    caller never had it to put there."""
    if not credential:
        return task
    return (
        task
        + f"\nPassword fields on {credential['origin']} are filled automatically by the browser and are not shown to you."
        " Never try to enter a password: after the other fields, continue to the next step or submit."
    )


# jev's page scanner excludes password inputs by design, so it can never type a
# password. The browser fills empty password fields itself: the value goes
# straight into the page and never into a model call. Fixed script; value and
# origin are passed as JSON literals, never interpolated as code.
#  - Origin: checked INSIDE the page, atomically with the fill, so a redirect or
#    a link to another site between ticks can never receive the password
#    (`location` is unforgeable by page script). It runs in EVERY frame of the
#    page (fill_frames), cross-origin and out-of-process ones included, and
#    each frame checks its own origin: one origin's password never goes into
#    another origin's frame, whichever frame is on top.
#  - Visibility: the same predicate jev's scanner uses, so a field a person
#    cannot see (honeypot, opacity 0, aria-hidden, inert) is never filled.
#  - A "show password" toggle puts the value where jev WOULD read it (and where
#    its screenshot shows it): the field's own type flips to text, or the page
#    swaps in / mirrors into a separate text input. One document-wide observer
#    empties any non-password input or textarea holding the value, on the same
#    microtask as the change, so it is gone before jev's post-action observe.
#    A page may also copy the value by PROPERTY alone (no mutation to observe),
#    from its own input/change handler: the fill therefore scrubs before it
#    fills (a copy left over from the last tick), right after (a handler that
#    ran synchronously inside our events) and once more on a later task (a
#    framework that re-renders asynchronously; best effort: a timer is not
#    ordered against jev's next CDP read). A page that echoes the value into
#    its own visible text is outside what an input scrub can reach.
_FILL_PASSWORDS = """((value, origin) => {
  if (location.origin !== origin) return 0;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  const guard = window[Symbol.for("dimension.browser.password-guard")] ||= (() => {
    const g = { value: "" };
    g.scrub = () => {
      if (!g.value) return;
      for (const el of document.querySelectorAll("input, textarea")) {
        if (el.type !== "password" && el.value === g.value) el.value = "";
      }
    };
    new MutationObserver(g.scrub).observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["type", "value"],
    });
    return g;
  })();
  guard.value = value;
  guard.scrub();
  const visible = (el) => !el.closest('[aria-hidden="true"],[inert]') &&
    el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  let filled = 0;
  for (const el of document.querySelectorAll('input[type="password"]')) {
    if (el.value || el.disabled || el.readOnly || !visible(el)) continue;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
    filled += 1;
  }
  guard.scrub();
  setTimeout(guard.scrub, 0);
  return filled;
})(%s, %s)"""


def fill_script(credential):
    return _FILL_PASSWORDS % (json.dumps(credential["password"]), json.dumps(credential["origin"]))


# Child frames run the fill in this isolated world: the page's DOM, not its globals.
_FILL_WORLD = "dimension-password-fill"


def _fill_passwords(browser, credential):
    from browser_harness.helpers import cdp

    try:
        return fill_frames(cdp, browser.target, browser.session, credential) > 0
    except Exception as exc:  # a navigation mid-fill: the next tick tries again
        # The type only: an evaluate error must never be able to echo the script.
        print(f"password fill skipped: {type(exc).__name__}", flush=True)
        return False


def fill_frames(cdp, page_target, page_session, credential):
    """Run the fill in every frame of the page and return how many fields it
    filled. `cdp(method, session_id=None, **params)` is raw CDP (the harness's
    own, or any client). The page's own target first; then every out-of-process
    iframe target whose parent chain (Target.getTargets' parentId) reaches the
    page, attached for the fill and detached after."""
    script = fill_script(credential)
    filled = _fill_target(cdp, page_session, script)
    iframes = [t for t in cdp("Target.getTargets").get("targetInfos", []) if t.get("type") == "iframe"]
    ours, grew = {page_target}, True
    while grew:
        grew = False
        for info in iframes:
            if info["targetId"] not in ours and info.get("parentId") in ours:
                ours.add(info["targetId"])
                grew = True
    for info in iframes:
        if info["targetId"] not in ours:
            continue
        try:
            session = cdp("Target.attachToTarget", targetId=info["targetId"], flatten=True)["sessionId"]
        except RuntimeError:  # the frame went away since the listing
            continue
        try:
            filled += _fill_target(cdp, session, script)
        finally:
            cdp("Target.detachFromTarget", sessionId=session)
    return filled


def _fill_target(cdp, session, script):
    """One target's frames: its main frame in the page's own world, then each
    same-process child frame in an isolated world. A child frame that lives in
    another process is its own target (filled by fill_frames) and is skipped
    here, as is one that went away mid-fill."""
    filled = _filled(cdp("Runtime.evaluate", session_id=session, expression=script, returnByValue=True))
    stack = list(cdp("Page.getFrameTree", session_id=session)["frameTree"].get("childFrames", []))
    while stack:
        node = stack.pop()
        stack.extend(node.get("childFrames", []))
        try:
            context = cdp("Page.createIsolatedWorld", session_id=session, frameId=node["frame"]["id"], worldName=_FILL_WORLD)["executionContextId"]
            filled += _filled(cdp("Runtime.evaluate", session_id=session, expression=script, contextId=context, returnByValue=True))
        except RuntimeError:
            continue
    return filled


def _filled(response):
    """The fill count a Runtime.evaluate returned; 0 when the frame threw (it was changing)."""
    value = response.get("result", {}).get("value")
    return value if not response.get("exceptionDetails") and isinstance(value, int) else 0


def _stop_daemon(name):
    from browser_harness import admin

    try:
        admin.restart_daemon(name=name)
        stopped = not admin.daemon_alive(name)
    except Exception as exc:
        print(f"harness daemon {name} stop failed: {exc!r}", flush=True)
        return
    if not stopped:
        print(f"harness daemon {name} still alive after stop", flush=True)
