import json
import os
import queue
import struct
import sys
import threading
import time

FRAME_JSON = 1
FRAME_AUDIO = 2
HOLD_LIMIT_SECONDS = 20
BIG_AUDIO_BYTES = 300_000
LIFECYCLE_ENV_KEYS = ("HF_HOME", "HF_HUB_OFFLINE", "HF_HUB_DISABLE_TELEMETRY", "PYTHONUTF8", "PYTHONIOENCODING")


def argument(name):
    return sys.argv[sys.argv.index(name) + 1]


def wait_for_gate():
    gate = os.path.join(argument("--data"), "gate")
    deadline = time.monotonic() + HOLD_LIMIT_SECONDS
    while not os.path.exists(gate) and time.monotonic() < deadline:
        time.sleep(0.005)


def run_setup(event, setup_mode):
    event(t="progress", stage="downloading fake/weights", fraction=0.0)
    if setup_mode == "fatal":
        event(t="fatal", message="download failed: 404")
        sys.stderr.write("Traceback: setup fatal\n")
        sys.stderr.flush()
        os._exit(1)
    if setup_mode == "crash":
        sys.stderr.write("disk full\n")
        sys.stderr.flush()
        os._exit(3)
    if setup_mode == "hold":
        event(t="progress", stage="downloading fake/weights", fraction=0.5)
        time.sleep(HOLD_LIMIT_SECONDS)
        return
    event(t="progress", stage="downloading fake/weights", fraction=0.5)
    if setup_mode == "gate":
        wait_for_gate()
    event(t="progress", stage="downloaded fake/weights", fraction=1.0)


def main():
    model = argument("--model")
    data = argument("--data")
    mode = os.environ.get("FAKE_MODE", "ok")

    with open(argument("--models-file"), encoding="utf-8") as registry:
        sample_rate = next(entry["sampleRate"] for entry in json.load(registry)["models"] if entry["id"] == model)

    sink = os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0)
    lock = threading.Lock()

    def write(kind, payload):
        with lock:
            sink.write(struct.pack("<IB", len(payload), kind))
            sink.write(payload)

    def event(**fields):
        write(FRAME_JSON, json.dumps(fields).encode("utf-8"))

    def audio(request_id, pcm):
        write(FRAME_AUDIO, struct.pack("<I", request_id) + pcm)

    os.makedirs(data, exist_ok=True)
    with open(os.path.join(data, "lifecycle.log"), "a", encoding="utf-8") as log:
        started = {
            "model": model,
            "pid": os.getpid(),
            "serve": "--setup" not in sys.argv,
            "env": {key: os.environ.get(key) for key in LIFECYCLE_ENV_KEYS},
        }
        log.write(json.dumps(started) + "\n")

    if "--setup" in sys.argv:
        run_setup(event, os.environ.get("FAKE_SETUP", "ok"))
        return

    if mode == "crash":
        sys.stderr.write("no cuda here\n")
        sys.stderr.flush()
        os._exit(3)
    if mode == "fatal":
        event(t="fatal", message="CUDA is not available")
        sys.stderr.write("Traceback: fatal\n")
        sys.stderr.flush()
        os._exit(1)

    time.sleep(int(os.environ.get("FAKE_LOAD_MS", "0")) / 1000)
    event(t="ready", sampleRate=sample_rate + (1 if mode == "badrate" else 0))

    requests = queue.Queue()
    cancelled = set()

    def read_commands():
        for line in sys.stdin:
            if not line.strip():
                continue
            command = json.loads(line)
            if command["op"] == "cancel":
                cancelled.add(int(command["id"]))
            elif command["op"] == "speak":
                requests.put(command)
        requests.put(None)

    threading.Thread(target=read_commands, daemon=True).start()

    while (request := requests.get()) is not None:
        request_id = int(request["id"])
        text = request["text"]
        if request_id in cancelled:
            event(t="done", id=request_id)
            continue
        if text == "die":
            sys.stderr.write("kaboom\n")
            sys.stderr.flush()
            os._exit(3)
        if "boom" in text:
            event(t="error", id=request_id, message="RuntimeError: boom")
            continue
        if text.startswith("hold"):
            audio(request_id, b"\x01\x00" * 4)
            deadline = time.monotonic() + HOLD_LIMIT_SECONDS
            while request_id not in cancelled and time.monotonic() < deadline:
                time.sleep(0.005)
            event(t="done", id=request_id)
            continue
        if text == "big":
            audio(request_id, bytes(i % 251 for i in range(BIG_AUDIO_BYTES)))
            event(t="done", id=request_id)
            continue
        echo = json.dumps({"text": text, "voice": request["voice"], "options": request["options"]}, ensure_ascii=False).encode("utf-8")
        if len(echo) % 2:
            echo += b" "
        half = len(echo) // 2 // 2 * 2
        audio(request_id, echo[:half])
        audio(request_id, echo[half:])
        event(t="done", id=request_id)


main()
