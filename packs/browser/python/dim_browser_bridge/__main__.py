"""Task worker entry point: `python -m dim_browser_bridge`.

stdin:  one JSON request line {"agent","cdpUrl","task","maxSteps","startUrl"[,"credential":{"origin","password"}]};
        stdin then stays open, and EOF on it is a cancel request. `credential` is jev-only and
        is never echoed: not to stdout, stderr, a step or the result.
stdout: JSON lines only — `step` lines with cumulative usage, then exactly one `result` line.
stderr: logs.
"""

import json
import os
import sys
import threading
import time

AGENTS = ("jev", "browser-use")


class Report:
    """Writes protocol lines; the agent module keeps `usage` current (cumulative)."""

    def __init__(self, out):
        self.out = out
        self.started = time.monotonic()
        self.steps = 0
        self.usage = {"modelCalls": 0, "inputTokens": 0, "outputTokens": 0, "costUsd": None}

    def _write(self, line):
        line["elapsedMs"] = round((time.monotonic() - self.started) * 1000)
        self.out.write(json.dumps({**line, **self.usage}) + "\n")
        self.out.flush()

    def step(self, action, url):
        self.steps += 1
        self._write({"type": "step", "n": self.steps, "action": action, "url": url or ""})

    def result(self, status, summary):
        self._write({"type": "result", "status": status, "summary": summary, "steps": self.steps})


def parse(line):
    request = json.loads(line)
    if not isinstance(request, dict):
        raise ValueError("expected one JSON object line")
    if request.get("agent") not in AGENTS:
        raise ValueError(f"agent must be one of {', '.join(AGENTS)}")
    for key in ("cdpUrl", "task"):
        if not isinstance(request.get(key), str) or not request[key].strip():
            raise ValueError(f"{key} must be a non-empty string")
    steps = request.get("maxSteps", 40)
    if not isinstance(steps, int) or isinstance(steps, bool) or steps < 1:
        raise ValueError("maxSteps must be a positive integer")
    request["maxSteps"] = steps
    return request


def main():
    # fd 1 is the protocol channel. Upstream loggers, print() and child processes that inherit
    # fd 1 would corrupt it, so the protocol gets a private (non-inheritable) duplicate and
    # fd 1 itself is pointed at stderr.
    out = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    # fd 0 is the cancel channel. Children (browser-harness spawns a daemon) inherit fd 0 as
    # their stdin; on Windows a child touching a pipe our watcher thread is blocked reading
    # hangs at startup. The watcher gets a private duplicate and fd 0 becomes devnull.
    control = os.fdopen(os.dup(0), "rb")
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)
    # The runtime keeps one worker pre-spawned (src/task.ts). Import both agent loops while it
    # waits for its job, so their import time (browser-use: ~4 s) is never on a task's clock.
    # A failed import is left for the task that needs it to report.
    try:
        from . import browser_use_task, jev_task  # noqa: F401

        browser_use_task.preload()
    except Exception:
        pass
    line = control.readline()
    if not line:
        return 0  # an idle spare let go before it was given a job
    report = Report(out)
    cancel = threading.Event()
    try:
        request = parse(line)
    except ValueError as exc:  # JSONDecodeError is a ValueError
        report.result("failed", f"invalid request: {exc}")
        return 0

    def watch_stdin():
        for _ in control:
            pass
        cancel.set()

    threading.Thread(target=watch_stdin, daemon=True).start()
    try:
        if request["agent"] == "jev":
            from . import jev_task as task
        else:
            from . import browser_use_task as task
        status, summary = task.run(request, cancel, report)
    except Exception as exc:
        print(f"task failed: {exc!r}", file=sys.stderr)
        status = "cancelled" if cancel.is_set() else "failed"
        summary = "Cancelled." if cancel.is_set() else str(exc) or type(exc).__name__
    report.result(status, summary)
    return 0


if __name__ == "__main__":
    code = main()
    sys.stderr.flush()
    # Upstream libraries can leave non-daemon threads and sockets behind; the result is
    # written, so leave without waiting on them.
    os._exit(code)
