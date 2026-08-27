# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import pytest

from meridian_constructs import DeploymentSpec, plan_deployment, verify_installed
from tests.support import (
    catalogs,
    complete_bindings,
    complete_placements,
    complete_resources,
    schema_providers,
)

runtime = pytest.importorskip("meridian_storage.runtime", reason="conformance extra not installed")


def test_released_core_parses_construct_output_and_all_pins_are_installed() -> None:
    resources = complete_resources()
    plan = plan_deployment(
        DeploymentSpec(
            "released",
            catalogs(),
            schema_providers(),
            resources,
            complete_bindings(),
            complete_placements(resources),
        )
    )
    parsed = runtime.RuntimeConfig.from_mapping(plan.runtime_config)
    assert parsed.to_dict() == plan.runtime_config
    report = verify_installed()
    assert report.installed_versions["meridian-storage-kafka"] == "1.0.1"
