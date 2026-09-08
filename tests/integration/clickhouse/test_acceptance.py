# SPDX-License-Identifier: Apache-2.0
"""Required integration gate: failures and absent environment are never skipped."""

import os
from pathlib import Path
import subprocess
import sys


def test_authenticated_collector_public_meridian():
    assert os.environ.get("CONSTRUCTS_MODULE"), "install the npm artifact first"
    assert os.environ.get("MERIDIAN_ACCEPTANCE_EVIDENCE_DIR")
    subprocess.run(
        [sys.executable, str(Path(__file__).with_name("acceptance.py"))], check=True, timeout=1200
    )
