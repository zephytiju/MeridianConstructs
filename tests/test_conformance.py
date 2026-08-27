# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import pytest

from meridian_constructs import (
    LOCAL_CLUSTER_PROFILES,
    DeploymentSpec,
    ProbeResult,
    conformance_evidence,
    get_profile,
    run_deployment_conformance,
    run_local_cluster_conformance,
)

from .support import (
    catalogs,
    complete_bindings,
    complete_placements,
    complete_resources,
    schema_providers,
)

_REPEAT_COUNT = 3


class FakeLocalClusters:
    def deploy_and_probe(self, test_profile: object) -> ProbeResult:
        profile_id = test_profile.engine_profile_id  # type: ignore[attr-defined]
        released = get_profile(profile_id)
        return ProbeResult(
            released.engine_profile,
            released.default_engine_version,
            released.adapter_id,
            1,
            test_profile.roles,  # type: ignore[attr-defined]
            frozenset(released.operations),
        )


def test_deterministic_and_local_cluster_equivalent_conformance() -> None:
    resources = complete_resources()
    spec = DeploymentSpec(
        "conformance",
        catalogs(),
        schema_providers(),
        resources,
        complete_bindings(),
        complete_placements(resources),
    )
    plan = run_deployment_conformance(spec)
    results = run_local_cluster_conformance(FakeLocalClusters())
    evidence = conformance_evidence(plan, repeat_count=_REPEAT_COUNT)
    assert len(results) == len(LOCAL_CLUSTER_PROFILES)
    assert evidence.deployment_fingerprint == plan.fingerprint
    assert evidence.evidence_fingerprint.startswith("sha256:")
    assert evidence.to_dict()["repeatCount"] == _REPEAT_COUNT


def test_conformance_rejects_single_preview() -> None:
    resources = complete_resources()
    spec = DeploymentSpec(
        "conformance",
        catalogs(),
        schema_providers(),
        resources,
        complete_bindings(),
        complete_placements(resources),
    )
    with pytest.raises(ValueError, match="at least two"):
        run_deployment_conformance(spec, repeat_count=1)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("engine_profile", "wrong", "profile mismatch"),
        ("engine_version", "0", "unsupported Engine version"),
        ("adapter_id", "wrong", "Adapter identity"),
        ("primary_count", 2, "exactly one primary"),
        ("healthy_roles", (), "topology roles"),
        ("operation_contracts", frozenset(), "missing operations"),
    ],
)
def test_local_cluster_probe_mismatches_fail(field: str, value: object, message: str) -> None:
    profile = LOCAL_CLUSTER_PROFILES[0]
    released = get_profile(profile.engine_profile_id)

    class BrokenHarness:
        def deploy_and_probe(self, test_profile: object) -> ProbeResult:
            values = {
                "engine_profile": released.engine_profile,
                "engine_version": released.default_engine_version,
                "adapter_id": released.adapter_id,
                "primary_count": 1,
                "healthy_roles": profile.roles,
                "operation_contracts": frozenset(released.operations),
            }
            values[field] = value
            return ProbeResult(**values)  # type: ignore[arg-type]

    with pytest.raises(AssertionError, match=message):
        run_local_cluster_conformance(BrokenHarness(), (profile,))
