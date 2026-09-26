"""Fake task worker speaking the real JSON-lines protocol, scripted by the test.

The request's `task` field is a JSON script:
  {"steps": [{"action", "url", "modelCalls", "inputTokens", "outputTokens"}...],
   "gate": "<path>",          # after the steps, wait for this file (or stdin EOF)
   "hold": true,              # after the steps, wait for stdin EOF only
   "openTab": "<url>",        # before the steps, Target.createTarget over request.cdpUrl
   "background": true,        # ...opening that tab in the background, as jev does
   "crash": {"stderr": "...", "exit": 3},   # write stderr, exit with no result
   "result": {"status", "summary", "steps", "modelCalls", "inputTokens", "outputTokens"},
   "credentialOut": "<path>",  # write the request's `credential` there, never to the protocol
   "holdPipes": 30}           # first spawn a process that inherits stdout/stderr and lives that many seconds,
                              # as a daemon an agent library spawns can; the worker itself then exits
Stdin EOF while waiting => a `cancelled` result, as the protocol requires.
"""

import json
import os
import sys
import threading


def emit(line):
    sys.stdout.write(json.dumps(line) + "\n")
    sys.stdout.flush()


def open_tab(cdp_url, url, background):
    from websockets.sync.client import connect

    with connect(cdp_url, max_size=None) as ws:
        params = {"url": url, "background": bool(background)}
        ws.send(json.dumps({"id": 1, "method": "Target.createTarget", "params": params}))
        while True:
            reply = json.loads(ws.recv())
            if reply.get("id") == 1:
                if "error" in reply:
                    raise RuntimeError(reply["error"])
                return


def main():
    request = json.loads(sys.stdin.readline())
    script = json.loads(request["task"])

    if script.get("credentialOut"):
        with open(script["credentialOut"], "w", encoding="utf-8") as out:
            json.dump(request.get("credential"), out)

    if script.get("holdPipes"):
        import subprocess

        subprocess.Popen([sys.executable, "-c", f"import time; time.sleep({float(script['holdPipes'])})"])

    crash = script.get("crash")
    if crash:
        sys.stderr.write(crash["stderr"] + "\n")
        sys.stderr.flush()
        return int(crash["exit"])

    eof = threading.Event()

    def watch_stdin():
        for _ in sys.stdin:
            pass
        eof.set()

    threading.Thread(target=watch_stdin, daemon=True).start()

    if script.get("openTab"):
        open_tab(request["cdpUrl"], script["openTab"], script.get("background"))

    for n, step in enumerate(script.get("steps", []), start=1):
        emit({"type": "step", "n": n, "elapsedMs": n * 10, "costUsd": None, **step})

    gate = script.get("gate")
    if gate:
        while not os.path.exists(gate):
            if eof.wait(0.02):
                break
    elif script.get("hold"):
        eof.wait()

    if eof.is_set():
        emit({"type": "result", "status": "cancelled", "summary": "stopped on stdin EOF", "steps": len(script.get("steps", []))})
        return 0
    emit({"type": "result", "costUsd": None, **script["result"]})
    return 0


if __name__ == "__main__":
    code = main()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)
