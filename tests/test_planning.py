# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

from dataclasses import replace

import pytest

from meridian_constructs import (
    BindingSpec,
    CatalogName,
    ConstructError,
    DeploymentSpec,
    OperationRequirement,
    PlacementRule,
    PlacementSelector,
    ResourceRef,
    ResourceRequirement,
    ValidationPolicy,
    catalog_placement_rules,
    diff_plans,
    plan_deployment,
    runtime_environment,
    validate_runtime_config,
)

from .support import (
    catalogs,
    complete_bindings,
    complete_placements,
    complete_resources,
    connection,
    fp,
    schema_providers,
)


def spec() -> DeploymentSpec:
    resources = complete_resources()
    return DeploymentSpec(
        profile="integration",
        catalogs=catalogs(),
        schema_providers=schema_providers(),
        resources=resources,
        bindings=complete_bindings(),
        placements=complete_placements(resources),
    )


def test_complete_adapter_plan_is_canonical_and_schema_valid() -> None:
    first = plan_deployment(spec())
    second = plan_deployment(spec())
    assert first.runtime_config_json == second.runtime_config_json
    assert first.fingerprint == second.fingerprint
    validate_runtime_config(first.runtime_config)
    assert [item["id"] for item in first.runtime_config["bindings"]] == [
        "clickhouse",
        "kafka",
        "oci",
        "opensearch",
        "postgresql",
        "s3",
        "valkey",
    ]
    kafka = next(item for item in first.runtime_config["bindings"] if item["id"] == "kafka")
    assert kafka["compatibilityPins"]["meridian-storage-kafka"] == "1.0.1"
    assert "password" not in first.runtime_config_json.lower()


def test_public_capabilities_are_logical_and_engine_agnostic() -> None:
    plan = plan_deployment(spec())
    for capability in plan.resource_bindings.values():
        assert capability.capability_key.startswith("juntai.platform.meridian.resource.")
        assert "kafka" not in capability.capability_key
        assert "adapter" not in capability.capability_key
        assert "engine" not in capability.capability_key


def test_catalog_rule_helper_is_explicit_one_primary_selection() -> None:
    rules = catalog_placement_rules(
        {
            CatalogName.STRUCTURED: "postgresql",
            CatalogName.OBJECT: "s3",
        }
    )
    assert [item.id for item in rules] == ["primary-object", "primary-structured"]


def test_missing_and_ambiguous_placements_fail_before_provisioning() -> None:
    value = spec()
    with pytest.raises(ConstructError, match="has no placement"):
        plan_deployment(replace(value, placements=value.placements[:-1]))
    duplicate = PlacementRule(
        "duplicate",
        PlacementSelector(catalog=CatalogName.STRUCTURED),
        "postgresql",
    )
    with pytest.raises(ConstructError, match="multiple placements"):
        plan_deployment(replace(value, placements=(*value.placements, duplicate)))


@pytest.mark.parametrize(
    ("profile", "operation", "message"),
    [
        ("valkey-standalone", "meridian.structured.get", "does not serve"),
        ("opensearch", "meridian.structured.put", "does not provide"),
    ],
)
def test_incompatible_catalog_or_operation_fails_closed(
    profile: str, operation: str, message: str
) -> None:
    requirement = ResourceRequirement(
        ResourceRef.parse("structured:test.records"),
        "semantics",
        fp("schema"),
        (OperationRequirement(operation),),
    )
    binding = BindingSpec(
        "selected", profile, fp("capability"), connection("selected", "https://engine.internal")
    )
    value = DeploymentSpec(
        "failure",
        catalogs(),
        schema_providers(),
        (requirement,),
        (binding,),
        (PlacementRule("selected", PlacementSelector(resources=(requirement.ref,)), "selected"),),
    )
    with pytest.raises(ConstructError, match=message):
        plan_deployment(value)


def test_guarantees_limits_versions_and_pins_fail_closed() -> None:
    value = spec()
    first = value.resources[0]
    impossible = replace(
        first,
        operations=(
            OperationRequirement(
                "meridian.structured.put",
                guarantees=("linearizable",),
                limits={"maxPageSize": 501},
            ),
        ),
    )
    with pytest.raises(ConstructError, match="lacks guarantees"):
        plan_deployment(replace(value, resources=(impossible, *value.resources[1:])))
    bad_version = replace(value.bindings[0], engine_version="99")
    with pytest.raises(ConstructError, match="unsupported Engine version"):
        plan_deployment(replace(value, bindings=(bad_version, *value.bindings[1:])))
    bad_pin = replace(
        value.bindings[0], compatibility_pins={"meridian-storage-postgresql": "0.9.0"}
    )
    with pytest.raises(ConstructError, match=r"must be '1\.0\.0'"):
        plan_deployment(replace(value, bindings=(bad_pin, *value.bindings[1:])))


def test_strict_physical_fingerprint_and_preview_diff() -> None:
    value = spec()
    relaxed = replace(value, validation=ValidationPolicy(require_physical_fingerprints=False))
    missing = replace(
        value.bindings[0],
        connection=replace(value.bindings[0].connection, required_physical_fingerprint=None),
    )
    with pytest.raises(ConstructError, match="physical fingerprints"):
        plan_deployment(replace(value, bindings=(missing, *value.bindings[1:])))
    before = plan_deployment(relaxed)
    after = plan_deployment(replace(relaxed, profile="changed"))
    difference = diff_plans(before, after)
    assert difference.config_changed
    assert not difference.is_empty


def test_runtime_environment_is_closed() -> None:
    assert dict(runtime_environment("/etc/meridian/config.json", profile="prod")) == {
        "MERIDIAN_CONFIG": "/etc/meridian/config.json",
        "MERIDIAN_PROFILE": "prod",
    }
