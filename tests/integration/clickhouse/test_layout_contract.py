# SPDX-License-Identifier: Apache-2.0
"""Real public layout parsing agrees with the installed Collector renderer."""

import copy
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import subprocess

import pytest
from meridian_storage.adapters.clickhouse.schema import ResourceLayout
from meridian_storage.semantics import canonical_json_bytes

from mapping_layout import render


def selection(mode):
    value = json.loads(
        (Path(__file__).parents[2] / "fixtures/collector-clickhouse/input.json").read_text()
    )
    value["mode"] = mode
    return value


@pytest.mark.parametrize("mode", ["gateway", "sidecar"])
def test_supported_public_variants(mode):
    legacy = selection(mode)
    selected = copy.deepcopy(legacy)
    for profile, document in legacy["layouts"].items():
        old = ResourceLayout.from_mapping(document)
        assert old.to_dict() == document and not old.append_only
        new = replace(old, append_only=True)
        selected["layouts"][profile] = new.to_dict()
        assert new.order_fields == (*old.order_fields, "_meridian_row_fingerprint")
        assert new.layout_fingerprint != old.layout_fingerprint
    old_plan = render({"input": legacy})
    new_plan = render({"input": selected})
    assert old_plan["layouts"] == legacy["layouts"]
    assert new_plan["layouts"] == selected["layouts"]
    assert old_plan["migration"]["fingerprint"] != new_plan["migration"]["fingerprint"]
    assert new_plan["migration"]["requiredLayouts"] == sorted(
        d["layoutFingerprint"] for d in selected["layouts"].values()
    )
    assert old_plan["migration"]["statements"] == new_plan["migration"]["statements"]


@pytest.mark.parametrize("value", [False, None, 0, 1, "true", {}, []])
def test_noncanonical_append_flag_rejected_by_both(value):
    selected = selection("gateway")
    layout = selected["layouts"]["log"]
    layout["appendOnly"] = value
    layout.pop("layoutFingerprint")
    layout["layoutFingerprint"] = (
        "sha256:" + hashlib.sha256(canonical_json_bytes(layout)).hexdigest()
    )
    with pytest.raises((TypeError, ValueError)):
        ResourceLayout.from_mapping(layout)
    with pytest.raises(subprocess.CalledProcessError) as error:
        render({"input": selected})
    assert "appendOnly" in error.value.stderr
