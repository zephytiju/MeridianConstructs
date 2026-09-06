# SPDX-License-Identifier: Apache-2.0
"""POSIX deployment entrypoint: supervisor.py JOB.json -- application command.

Forwards stop once, allows one bounded admitted cycle to drain, then SIGKILLs
the child process group on deadline failure. Forced recovery is never graceful.
The owning provisioner must set terminationGracePeriod >= terminationGraceMs.
"""

import json
import os
from pathlib import Path
import runpy
import signal
import subprocess
import sys
import time


def supervise(job, command):
    # Validate the serialized admission contract before launching any child.
    runpy.run_path(str(Path(__file__).with_name("worker.py")))["validate_job"](job)
    budgets = job["operation"]["budgets"]
    drain_seconds = budgets["drainMs"] / 1000
    child = None
    stopped_at = None

    def stop(signum, frame):
        nonlocal stopped_at
        if stopped_at is None:
            stopped_at = time.monotonic()
            if child is not None and child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass

    previous = {sig: signal.signal(sig, stop) for sig in (signal.SIGTERM, signal.SIGINT)}
    started = time.monotonic()
    try:
        child = subprocess.Popen(command, start_new_session=True)
        if stopped_at is not None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        while child.poll() is None:
            now = time.monotonic()
            if now - started >= job["timeoutSeconds"]:
                stop(signal.SIGTERM, None)
            if stopped_at is not None and now - stopped_at >= drain_seconds:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait(timeout=1)
                print(
                    json.dumps(
                        {
                            "state": "failed-drain",
                            "graceful": False,
                            "terminated": child.returncode < 0,
                        }
                    ),
                    flush=True,
                )
                return 70
            time.sleep(0.01)
        result = child.returncode
        # Child exit alone is not proof of graceful drain unless it handled stop
        # and returned success; the worker emits admitted-batch completion counts.
        print(
            json.dumps(
                {
                    "state": "host-exit",
                    "graceful": stopped_at is not None and result == 0,
                    "exitCode": result,
                }
            ),
            flush=True,
        )
        return result if result >= 0 else 128 - result
    finally:
        if child is not None and child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=1)
        for sig, handler in previous.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf8") as stream:
        job = json.load(stream)
    if len(sys.argv) < 4 or sys.argv[2] != "--":
        raise SystemExit("expected JOB.json -- application command")
    raise SystemExit(supervise(job, sys.argv[3:]))
