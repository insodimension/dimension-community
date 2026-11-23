import json
import os
import subprocess
import sys

FAILURE_EXIT_CODE = 2


def main(argv):
    with open(os.environ["FAKE_UV_LOG"], "a", encoding="utf-8") as log:
        log.write(json.dumps(argv) + "\n")
    if os.environ.get("FAKE_UV_FAIL") == argv[0]:
        sys.stderr.write("error: no matching distribution found\n")
        sys.stderr.flush()
        return FAILURE_EXIT_CODE
    if argv[0] == "venv":
        if os.environ.get("FAKE_UV_VENV") == "folder-only":
            os.makedirs(argv[-1], exist_ok=True)
        else:
            subprocess.run([sys.executable, "-m", "venv", "--without-pip", argv[-1]], check=True)
    return 0


sys.exit(main(ORIGINAL_ARGV))
