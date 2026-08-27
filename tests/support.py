# SPDX-License-Identifier: Apache-2.0
"""Shared deterministic conformance fixtures."""

from __future__ import annotations

from meridian_constructs import (
    BindingSpec,
    CatalogName,
    CatalogProvider,
    EngineConnection,
    OperationRequirement,
    PlacementRule,
    PlacementSelector,
    ResourceRef,
    ResourceRequirement,
    SchemaProvider,
    SecretReference,
    TLSPolicy,
)
from meridian_constructs._canonical import fingerprint


def fp(label: str) -> str:
    return fingerprint(label)


def tls() -> TLSPolicy:
    return TLSPolicy(
        mode="server",
        server_name="engine.internal",
        ca_ref=SecretReference("vault", "pki/meridian/ca"),
    )


def connection(label: str, endpoint: str) -> EngineConnection:
    return EngineConnection(
        physical_namespace=f"meridian_{label.replace('-', '_')}",
        identity_ref=SecretReference("workload-identity", f"identities/{label}"),
        secret_ref=SecretReference("vault", f"engines/{label}"),
        tls=tls(),
        endpoint=endpoint,
        required_physical_fingerprint=fp(f"physical:{label}"),
        settings={"deploymentLabel": label},
    )


def catalogs() -> tuple[CatalogProvider, ...]:
    packages = {
        CatalogName.STRUCTURED: "meridian-storage-semantics",
        CatalogName.OBJECT: "meridian-storage-object-common",
        CatalogName.CACHE: "meridian-storage-semantics",
        CatalogName.EVIDENCE: "meridian-storage-evidence",
        CatalogName.STREAMING: "meridian-storage-streaming",
    }
    return tuple(
        CatalogProvider(name, packages[name], "1.0.0", fp(f"catalog:{name.value}"))
        for name in CatalogName
    )


def schema_providers() -> tuple[SchemaProvider, ...]:
    return (
        SchemaProvider(
            "semantics",
            "meridian-storage-semantics",
            "1.0.0",
            fp("schema-provider:semantics"),
        ),
    )


def complete_resources() -> tuple[ResourceRequirement, ...]:
    cases = (
        ("structured:app.records", "meridian.structured.put", ("strong-consistency",)),
        ("structured:app.search", "meridian.structured.search", ("eventual-consistency",)),
        ("evidence:app.metrics", "meridian.evidence.append", ("retry-window-dedup",)),
        ("cache:app.entries", "meridian.cache.get", ("disposable-cache",)),
        ("object:app.assets", "meridian.object.put", ("object.digest-sha256",)),
        ("object:app.images", "meridian.object.get", ("object.digest-verification",)),
        ("streaming:app.events", "meridian.streaming.publish", ("idempotent-producer",)),
    )
    return tuple(
        ResourceRequirement(
            ResourceRef.parse(ref),
            "semantics",
            fp(f"schema:{ref}"),
            (OperationRequirement(operation, guarantees=guarantees),),
            {"component": "api"},
        )
        for ref, operation, guarantees in cases
    )


def complete_bindings() -> tuple[BindingSpec, ...]:
    cases = (
        (
            "postgresql",
            "postgresql-postgis-local-single-primary",
            "postgresql://postgres.internal:5432",
        ),
        ("opensearch", "opensearch", "https://opensearch.internal:9200"),
        ("clickhouse", "clickhouse-standalone", "https://clickhouse.internal:8443"),
        ("valkey", "valkey-standalone", "rediss://valkey.internal:6379"),
        ("s3", "s3-compatible", "https://s3.internal"),
        ("oci", "oci-distribution", "https://registry.internal"),
        ("kafka", "apache-kafka", "kafka://kafka.internal:9093"),
    )
    return tuple(
        BindingSpec(
            binding_id, profile, fp(f"capability:{binding_id}"), connection(binding_id, endpoint)
        )
        for binding_id, profile, endpoint in cases
    )


def complete_placements(
    resources: tuple[ResourceRequirement, ...] | None = None,
) -> tuple[PlacementRule, ...]:
    selected = complete_resources() if resources is None else resources
    binding_ids = ("postgresql", "opensearch", "clickhouse", "valkey", "s3", "oci", "kafka")
    return tuple(
        PlacementRule(
            f"place-{binding_id}",
            PlacementSelector(resources=(resource.ref,)),
            binding_id,
        )
        for resource, binding_id in zip(selected, binding_ids, strict=True)
    )
