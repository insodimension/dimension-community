import os
import sys

FIXTURES_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.basename(sys.argv[0]) if sys.argv else ""
PACK_WORKER = SCRIPT == "worker.py" and "--model" in sys.argv
UV_COMMAND = SCRIPT in ("venv", "pip") and "FAKE_UV_LOG" in os.environ
FIXTURE = "fake_worker.py" if PACK_WORKER else "fake_uv.py" if UV_COMMAND else None

if FIXTURE:
    import runpy
    import traceback

    exit_code = 0
    try:
        runpy.run_path(os.path.join(FIXTURES_DIRECTORY, FIXTURE), init_globals={"ORIGINAL_ARGV": list(sys.argv)}, run_name="__fake__")
    except SystemExit as stop:
        exit_code = stop.code if isinstance(stop.code, int) else 1
    except BaseException:
        traceback.print_exc()
        exit_code = 70
    sys.stderr.flush()
    os._exit(exit_code)
