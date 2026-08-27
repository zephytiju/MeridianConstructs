# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import math
from dataclasses import replace

import pytest

from meridian_constructs import (
    CatalogName,
    ConstructError,
    DeploymentSpec,
    LiveSchemaPolicy,
    OperationRequirement,
    PlacementRule,
    PlacementSelector,
    ResourceRef,
    ResourceRequirement,
    RetryPolicy,
    ValidationPolicy,
    plan_deployment,
    runtime_environment,
)
from meridian_constructs._canonical import canonical_json, normalize_json

from .support import (
    catalogs,
    complete_bindings,
    complete_placements,
    complete_resources,
    fp,
    schema_providers,
)


@pytest.mark.parametrize("value", [math.inf, {1: "bad"}, object()])
def test_canonical_json_rejects_non_json_values(value: object) -> None:
    with pytest.raises((TypeError, ValueError)):
        normalize_json(value)
    with pytest.raises((TypeError, ValueError)):
        canonical_json(value)


def test_resource_and_operation_validation_edges() -> None:
    with pytest.raises(ConstructError, match="identifier"):
        ResourceRef(CatalogName.STRUCTURED, "bad namespace", "records")
    with pytest.raises(ConstructError, match="cannot be empty"):
        ResourceRequirement(ResourceRef.parse("structured:a.b"), "semantics", fp("x"), ())
    operation = OperationRequirement("meridian.structured.get")
    with pytest.raises(ConstructError, match="must be unique"):
        ResourceRequirement(
            ResourceRef.parse("structured:a.b"),
            "semantics",
            fp("x"),
            (operation, operation),
        )
    with pytest.raises(ConstructError, match="limit"):
        OperationRequirement("meridian.structured.get", limits={"pageSize": -1})


def test_policy_and_selector_validation_edges() -> None:
    with pytest.raises(ConstructError, match="cannot be empty"):
        PlacementSelector()
    ref = ResourceRef.parse("structured:a.b")
    with pytest.raises(ConstructError, match="unique"):
        PlacementSelector(resources=(ref, ref))
    with pytest.raises(ConstructError, match="must be enabled"):
        LiveSchemaPolicy(required=True)
    with pytest.raises(ConstructError, match="exactly when"):
        LiveSchemaPolicy(enabled=True)
    with pytest.raises(ConstructError, match="max_attempts"):
        RetryPolicy(max_attempts=0)
    with pytest.raises(ConstructError, match="base delay"):
        RetryPolicy(base_delay_ms=100, max_delay_ms=10)
    with pytest.raises(ConstructError, match="jitter"):
        RetryPolicy(jitter_ratio=2)
    with pytest.raises(ConstructError, match="timeout"):
        ValidationPolicy(default_operation_timeout_ms=0)
    with pytest.raises(ConstructError, match="cache"):
        ValidationPolicy(idempotency_cache_entries=0)
    with pytest.raises(ConstructError, match="cannot be empty"):
        runtime_environment("")
    with pytest.raises(ConstructError, match="profile"):
        runtime_environment("config.json", profile="")


def test_deployment_reference_and_duplicate_edges() -> None:
    resources = complete_resources()
    value = DeploymentSpec(
        "edges",
        catalogs(),
        schema_providers(),
        resources,
        complete_bindings(),
        complete_placements(resources),
    )
    with pytest.raises(ConstructError, match="Duplicate"):
        plan_deployment(replace(value, resources=(*resources, resources[0])))
    unknown_schema = replace(resources[0], schema_provider_id="missing")
    with pytest.raises(ConstructError, match="unknown schema provider"):
        plan_deployment(replace(value, resources=(unknown_schema, *resources[1:])))
    unknown_catalog = replace(value, catalogs=value.catalogs[1:])
    with pytest.raises(ConstructError, match="unconfigured Catalog"):
        plan_deployment(unknown_catalog)
    bad_placement = PlacementRule(
        "bad",
        PlacementSelector(resources=(resources[0].ref,)),
        "missing",
    )
    placements = (bad_placement, *value.placements[1:])
    with pytest.raises(ConstructError, match="unknown binding"):
        plan_deployment(replace(value, placements=placements))
    with pytest.raises(ConstructError, match="Live schema"):
        plan_deployment(replace(value, live_schemas=LiveSchemaPolicy(True, False, "missing")))
