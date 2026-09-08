# SPDX-License-Identifier: Apache-2.0
"""Record observed Engine/package provenance and reject skipped acceptance."""

import json
import os
import xml.etree.ElementTree as ET
from importlib.metadata import distributions
from pathlib import Path

import psycopg

root = ET.parse("evidence/projection-jobs.xml").getroot()
assert not root.findall(".//skipped"), "required Engine acceptance cannot be skipped"
assert not root.findall(".//failure") and not root.findall(".//error")
with psycopg.connect(os.environ["MERIDIAN_POSTGRESQL_TEST_DSN"]) as connection:
    observed = connection.execute(
        "SELECT current_setting('server_version'), postgis_lib_version()"
    ).fetchone()
Path("evidence/observed-runtime.json").write_text(
    json.dumps(
        {
            "selectedEngineProfileVersion": os.environ["MERIDIAN_POSTGRESQL_ENGINE_VERSION"],
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
