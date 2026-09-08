# SPDX-License-Identifier: Apache-2.0
"""Record installed public packages and observed Engines; reject skipped gates."""

import json
import os
import xml.etree.ElementTree as ET
from importlib.metadata import distributions
from pathlib import Path

import psycopg

target = Path(os.environ["MERIDIAN_ACCEPTANCE_EVIDENCE_DIR"])
root = ET.parse(target / "metadata-config.xml").getroot()
assert root.findall(".//testcase"), "required acceptance did not run"
assert not root.findall(".//skipped"), "required acceptance must not skip"
assert not root.findall(".//failure") and not root.findall(".//error")
with psycopg.connect(os.environ["MERIDIAN_POSTGRESQL_TEST_DSN"]) as connection:
    observed = connection.execute(
        "SELECT current_setting('server_version'), postgis_lib_version()"
    ).fetchone()
(target / "observed-runtime.json").write_text(
    json.dumps(
        {
            "selectedEngineVersion": os.environ["MERIDIAN_POSTGRESQL_ENGINE_VERSION"],
            "selectedImage": os.environ["ENGINE_IMAGE"],
            "observedPostgreSQL": observed[0],
            "observedPostGIS": observed[1],
            "installedPackages": {d.metadata["Name"]: d.version for d in distributions()},
            "passedTests": len(root.findall(".//testcase")),
            "skippedTests": 0,
        },
        sort_keys=True,
        indent=2,
    )
    + "\n"
)
