# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

from dataclasses import FrozenInstanceError

import pytest

from meridian_constructs import (
    CatalogName,
    ConstructError,
    EngineConnection,
    ResourceRef,
    SecretReference,
    TelemetryPolicy,
    TLSPolicy,
    reject_secret_material,
)

from .support import fp, tls


def test_catalog_registry_and_resource_reference_are_closed() -> None:
    assert [item.value for item in CatalogName] == [
        "structured",
        "object",
        "cache",
        "evidence",
        "streaming",
    ]
    ref = ResourceRef.parse("structured:example.people")
    assert ref.canonical == "structured:example.people"
    assert ResourceRef.parse(ref.to_dict()) == ref
    with pytest.raises((ConstructError, ValueError)):
        ResourceRef.parse("ontology:example.people")


def test_contracts_are_immutable_and_references_hide_values() -> None:
    reference = SecretReference("vault", "engines/postgresql")
    assert "engines/postgresql" not in repr(reference)
    with pytest.raises(FrozenInstanceError):
        reference.provider = "other"  # type: ignore[misc]


def test_tls_policy_is_fail_closed() -> None:
    assert TLSPolicy.disabled().to_dict()["mode"] == "disabled"
    with pytest.raises(ConstructError, match="Authenticated TLS"):
        TLSPolicy(mode="server")
    with pytest.raises(ConstructError, match="Mutual TLS"):
        TLSPolicy(
            mode="mutual",
            server_name="db.internal",
            ca_ref=SecretReference("vault", "pki/ca"),
        )


def test_connection_requires_one_credential_free_endpoint_reference() -> None:
    common = {
        "physical_namespace": "app",
        "identity_ref": SecretReference("identity", "workloads/api"),
        "secret_ref": SecretReference("vault", "engines/db"),
        "tls": tls(),
        "required_physical_fingerprint": fp("physical"),
    }
    with pytest.raises(ConstructError, match="exactly one"):
        EngineConnection(**common)
    with pytest.raises(ConstructError, match="without credentials"):
        EngineConnection(**common, endpoint="postgresql://user:password@db.internal")
    resolved = EngineConnection(**common, service_ref="platform/service/db")
    assert resolved.endpoint is None


@pytest.mark.parametrize(
    "value",
    [
        {"password": "inline"},
        {"nested": {"api_token": "inline"}},
        {"items": [{"private-key": "inline"}]},
    ],
)
def test_secret_material_is_rejected(value: object) -> None:
    with pytest.raises(ConstructError, match="secretRef"):
        reject_secret_material(value)


def test_telemetry_requires_service_name_and_suppresses_recursion() -> None:
    with pytest.raises(ConstructError):
        TelemetryPolicy(enabled=True)
    policy = TelemetryPolicy(enabled=True, service_name="api", attributes={"environment": "test"})
    assert policy.to_dict()["suppressExporterRecursion"] is True
