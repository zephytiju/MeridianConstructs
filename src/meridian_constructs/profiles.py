# SPDX-License-Identifier: Apache-2.0
"""Released adapter compatibility matrix and engine profiles."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType

from .contracts import CatalogName, DeploymentMode, Topology
from .errors import ConstructError, ErrorCode


@dataclass(frozen=True, slots=True)
class OperationCapability:
    contract: str
    versions: tuple[str, ...] = ("1.0.0",)
    guarantees: frozenset[str] = frozenset()
    limits: Mapping[str, int] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class EngineProfile:
    """A released adapter profile selectable only by deployment IaC."""

    id: str
    adapter_id: str
    adapter_package: str
    adapter_version: str
    adapter_contract: str
    engine_profile: str
    supported_engine_versions: tuple[str, ...]
    default_engine_version: str
    catalogs: frozenset[CatalogName]
    operations: Mapping[str, OperationCapability]
    allowed_topologies: frozenset[Topology]
    default_topology: Topology
    allowed_modes: frozenset[DeploymentMode] = frozenset(DeploymentMode)
    primary_count: int = 1

    def __post_init__(self) -> None:
        if self.default_engine_version not in self.supported_engine_versions:
            raise ValueError(f"Profile {self.id!r} default version is not supported")
        if self.default_topology not in self.allowed_topologies:
            raise ValueError(f"Profile {self.id!r} default topology is not supported")
        if self.primary_count != 1:
            raise ValueError(f"Profile {self.id!r} must have exactly one primary")
        object.__setattr__(
            self, "operations", MappingProxyType(dict(sorted(self.operations.items())))
        )

    @property
    def compatibility_pins(self) -> Mapping[str, str]:
        pins = {
            self.adapter_package: self.adapter_version,
            "meridian-storage-core": "1.0.0",
        }
        if self.adapter_package in {
            "meridian-storage-clickhouse",
            "meridian-storage-opensearch",
            "meridian-storage-postgresql",
        }:
            pins.update(
                {
                    "meridian-storage-query": "1.0.0",
                    "meridian-storage-semantics": "1.0.0",
                }
            )
        elif self.adapter_package == "meridian-storage-valkey":
            pins["meridian-storage-semantics"] = "1.0.0"
        elif self.adapter_package in {"meridian-storage-s3", "meridian-storage-oci"}:
            pins["meridian-storage-object-common"] = "1.0.0"
        elif self.adapter_package == "meridian-storage-kafka":
            pins.update(
                {
                    "meridian-storage-semantics": "1.0.0",
                    "meridian-storage-streaming": "1.0.0",
                }
            )
        return MappingProxyType(dict(sorted(pins.items())))


def _cap(
    contract: str,
    *guarantees: str,
    limits: Mapping[str, int] | None = None,
) -> OperationCapability:
    return OperationCapability(contract, guarantees=frozenset(guarantees), limits=limits or {})


_POSTGRES_COMMON = ("bound-parameters", "scope-injected", "single-binding", "strong-consistency")
_POSTGRES_MUTATION = (*_POSTGRES_COMMON, "conditional-mutation", "read-committed")
_POSTGRES_OPERATIONS = {
    f"meridian.structured.{method}": _cap(
        f"meridian.structured.{method}",
        *(
            _POSTGRES_MUTATION
            if method in {"delete", "patch", "put"}
            else (*_POSTGRES_COMMON, "external-migration")
            if method in {"create_resource", "publish_schema"}
            else _POSTGRES_COMMON
        ),
        limits={"maxPageSize": 500, "maxTraversalDepth": 8},
    )
    for method in (
        "aggregate",
        "create_resource",
        "delete",
        "get",
        "patch",
        "publish_schema",
        "put",
        "query",
        "search",
        "traverse",
    )
}
_POSTGRES_OPERATIONS.update(
    {
        "meridian.evidence.append": _cap(
            "meridian.evidence.append",
            "append-only",
            "bound-parameters",
            "read-committed",
            "scope-injected",
            "transactional-with-structured",
            limits={"maxPageSize": 500},
        ),
        "meridian.evidence.query": _cap(
            "meridian.evidence.query",
            "bound-parameters",
            "scope-injected",
            "strong-consistency",
            limits={"maxPageSize": 500},
        ),
        "meridian.transaction": _cap(
            "meridian.transaction",
            "atomic",
            "no-dirty-reads",
            "read-committed",
            limits={"maxOperations": 10_000},
        ),
    }
)

_OBJECT_BASE = {
    "meridian.object.put": _cap(
        "meridian.object.put",
        "object.conditional-create",
        "object.digest-sha256",
        "object.immutability-intent",
        "object.metadata-after-commit",
        "object.multipart",
        "object.retention-intent",
        "object.streaming",
    ),
    "meridian.object.get": _cap(
        "meridian.object.get", "object.digest-verification", "object.streaming"
    ),
    "meridian.object.stat": _cap("meridian.object.stat", "object.digest-verification"),
    "meridian.object.read_range": _cap(
        "meridian.object.read_range", "object.digest-verification", "object.range-read"
    ),
    "meridian.object.list": _cap(
        "meridian.object.list",
        "object.bounded-prefix-list",
        limits={"object.max-list-page-size": 1_000},
    ),
    "meridian.object.delete": _cap(
        "meridian.object.delete", "object.exact-version-delete", "object.retention-intent"
    ),
}
_S3_OPERATIONS = {
    **_OBJECT_BASE,
    "meridian.object.publish_schema": _cap("meridian.object.publish_schema"),
    "meridian.object.create_resource": _cap("meridian.object.create_resource"),
}

_KAFKA_OPERATIONS = {
    "meridian.streaming.acknowledge": _cap(
        "meridian.streaming.acknowledge",
        "at-least-once",
        "consumer-groups",
        "monotonic-safe-position",
    ),
    "meridian.streaming.create-resource": _cap(
        "meridian.streaming.create-resource", "streaming-resource-lifecycle"
    ),
    "meridian.streaming.group-position": _cap(
        "meridian.streaming.group-position",
        "compare-and-set",
        "consumer-groups",
        "explicit-group-position",
        "opaque-cursors",
    ),
    "meridian.streaming.negative-acknowledge": _cap(
        "meridian.streaming.negative-acknowledge",
        "at-least-once",
        "consumer-groups",
        "dead-letter",
        "redelivery",
    ),
    "meridian.streaming.poll": _cap(
        "meridian.streaming.poll",
        "at-least-once",
        "consumer-groups",
        "per-logical-partition-ordering",
        limits={"maxPollSize": 10_000, "maxWaitTimeoutMs": 300_000},
    ),
    "meridian.streaming.publish": _cap(
        "meridian.streaming.publish",
        "at-least-once",
        "idempotent-producer",
        "per-logical-partition-ordering",
        "schema-fingerprint",
    ),
    "meridian.streaming.publish-batch": _cap(
        "meridian.streaming.publish-batch",
        "at-least-once",
        "idempotent-producer",
        "per-logical-partition-ordering",
        "schema-fingerprint",
        limits={"maxBatchSize": 10_000},
    ),
    "meridian.streaming.publish-schema": _cap(
        "meridian.streaming.publish-schema", "streaming-schema-publication"
    ),
    "meridian.streaming.read-range": _cap(
        "meridian.streaming.read-range",
        "finite-retained-range",
        "opaque-cursors",
        "retention-boundary-validation",
        limits={"maxRangeSize": 10_000},
    ),
    "meridian.streaming.replay": _cap(
        "meridian.streaming.replay",
        "explicit-replay",
        "finite-retained-range",
        "opaque-cursors",
        "retention-boundary-validation",
        limits={"maxRangeSize": 10_000},
    ),
    "meridian.streaming.subscribe": _cap("meridian.streaming.subscribe", "subscriptions"),
    "meridian.streaming.transactional-consume-publish": _cap(
        "meridian.streaming.transactional-consume-publish",
        "atomic-consumed-offset",
        "atomic-publish",
        "committed-reads",
        "idempotent-producer",
        "single-binding",
        limits={"maxBatchSize": 10_000},
    ),
    "meridian.transaction": _cap(
        "meridian.transaction", "atomic", "no-dirty-reads", "single-binding"
    ),
}

_CLICKHOUSE_OPERATIONS = {
    name: _cap(name, *guarantees)
    for name, guarantees in {
        "meridian.evidence.append": (
            "eventual-visibility",
            "retry-window-dedup",
            "scope-isolation",
        ),
        "meridian.evidence.query": (
            "bounded-time-range",
            "scope-isolation",
            "single-binding",
        ),
        "meridian.structured.aggregate": (
            "bounded-time-range",
            "scope-isolation",
            "single-binding",
        ),
        "meridian.structured.get": (
            "eventual-visibility",
            "scope-isolation",
            "single-binding",
        ),
        "meridian.structured.put": (
            "eventual-visibility",
            "retry-window-dedup",
            "scope-isolation",
        ),
        "meridian.structured.query": (
            "bounded-time-range",
            "scope-isolation",
            "single-binding",
        ),
    }.items()
}
_VALKEY_OPERATIONS = {
    f"meridian.cache.{method}": _cap(
        f"meridian.cache.{method}",
        "disposable-cache",
        "scope-isolation",
        *("ttl-bounded",) if method not in {"delete", "invalidate"} else (),
    )
    for method in ("get", "put", "put_if_absent", "compare_and_set", "delete", "invalidate")
}

_PROFILES = (
    EngineProfile(
        id="postgresql-postgis-local-single-primary",
        adapter_id="postgresql",
        adapter_package="meridian-storage-postgresql",
        adapter_version="1.0.0",
        adapter_contract="1.0.0",
        engine_profile="postgresql-postgis-local-single-primary",
        supported_engine_versions=("16-postgis-3.4", "17-postgis-3.5"),
        default_engine_version="17-postgis-3.5",
        catalogs=frozenset({CatalogName.STRUCTURED, CatalogName.EVIDENCE}),
        operations=_POSTGRES_OPERATIONS,
        allowed_topologies=frozenset({Topology.SINGLE_PRIMARY, Topology.EXTERNAL}),
        default_topology=Topology.SINGLE_PRIMARY,
    ),
    EngineProfile(
        id="postgresql-postgis-cluster",
        adapter_id="postgresql",
        adapter_package="meridian-storage-postgresql",
        adapter_version="1.0.0",
        adapter_contract="1.0.0",
        engine_profile="postgresql-postgis-cluster",
        supported_engine_versions=("16-postgis-3.4", "17-postgis-3.5"),
        default_engine_version="17-postgis-3.5",
        catalogs=frozenset({CatalogName.STRUCTURED, CatalogName.EVIDENCE}),
        operations=_POSTGRES_OPERATIONS,
        allowed_topologies=frozenset({Topology.CLUSTER, Topology.EXTERNAL}),
        default_topology=Topology.CLUSTER,
    ),
    EngineProfile(
        id="opensearch",
        adapter_id="org.meridian.storage.opensearch",
        adapter_package="meridian-storage-opensearch",
        adapter_version="1.0.0",
        adapter_contract="1.0.0",
        engine_profile="opensearch",
        supported_engine_versions=(
            "2.17.0",
            "2.18.0",
            "2.19.0",
            "2.19.1",
            "2.19.2",
            "3.0.0",
            "3.1.0",
            "3.2.0",
        ),
        default_engine_version="2.19.1",
        catalogs=frozenset({CatalogName.STRUCTURED}),
        operations={
            "meridian.structured.search": _cap(
                "meridian.structured.search",
                "eventual-consistency",
                "logical-record-references",
                "scope-isolation",
                "single-binding",
                "stable-keyset",
            )
        },
        allowed_topologies=frozenset(
            {Topology.SINGLE_PRIMARY, Topology.CLUSTER, Topology.EXTERNAL}
        ),
        default_topology=Topology.SINGLE_PRIMARY,
    ),
    EngineProfile(
        id="clickhouse-standalone",
        adapter_id="meridian.storage.clickhouse",
        adapter_package="meridian-storage-clickhouse",
        adapter_version="1.0.0",
        adapter_contract="1.0.0",
        engine_profile="clickhouse-standalone",
        supported_engine_versions=("25.3",),
        default_engine_version="25.3",
        catalogs=frozenset({CatalogName.STRUCTURED, CatalogName.EVIDENCE}),
        operations=_CLICKHOUSE_OPERATIONS,
        allowed_topologies=frozenset({Topology.SINGLE_PRIMARY, Topology.EXTERNAL}),
        default_topology=Topology.SINGLE_PRIMARY,
    ),
    EngineProfile(
        id="clickhouse-replicated",
        adapter_id="meridian.storage.clickhouse",
        adapter_package="meridian-storage-clickhouse",
        adapter_version="1.0.0",
        adapter_contract="1.0.0",
        engine_profile="clickhouse-replicated",
        supported_engine_versions=("25.3",),
        default_engine_version="25.3",
        catalogs=frozenset({CatalogName.STRUCTURED, CatalogName.EVIDENCE}),
        operations=_CLICKHOUSE_OPERATIONS,
        allowed_topologies=frozenset({Topology.CLUSTER, Topology.EXTERNAL}),
        default_topology=Topology.CLUSTER,
    ),
    EngineProfile(
        id="valkey-standalone",
        adapter_id="org.meridian.storage.valkey",
        adapter_package="meridian-storage-valkey",
        adapter_version="1.0.0",
        adapter_contract="1.0.0",
        engine_profile="valkey-standalone",
        supported_engine_versions=("8.1.9",),
        default_engine_version="8.1.9",
        catalogs=frozenset({CatalogName.CACHE}),
        operations=_VALKEY_OPERATIONS,
        allowed_topologies=frozenset({Topology.SINGLE_PRIMARY, Topology.EXTERNAL}),
        default_topology=Topology.SINGLE_PRIMARY,
    ),
    EngineProfile(
        id="valkey-sentinel",
        adapter_id="org.meridian.storage.valkey",
        adapter_package="meridian-storage-valkey",
        adapter_version="1.0.0",
        adapter_contract="1.0.0",
        engine_profile="valkey-sentinel",
        supported_engine_versions=("8.1.9",),
        default_engine_version="8.1.9",
        catalogs=frozenset({CatalogName.CACHE}),
        operations=_VALKEY_OPERATIONS,
        allowed_topologies=frozenset({Topology.CLUSTER, Topology.EXTERNAL}),
        default_topology=Topology.CLUSTER,
    ),
    EngineProfile(
        id="aws-s3",
        adapter_id="s3",
        adapter_package="meridian-storage-s3",
        adapter_version="1.0.0",
        adapter_contract="1.0.0",
        engine_profile="aws-s3",
        supported_engine_versions=("2006-03-01",),
        default_engine_version="2006-03-01",
        catalogs=frozenset({CatalogName.OBJECT}),
        operations=_S3_OPERATIONS,
        allowed_topologies=frozenset({Topology.EXTERNAL}),
        default_topology=Topology.EXTERNAL,
    ),
    EngineProfile(
        id="s3-compatible",
        adapter_id="s3",
        adapter_package="meridian-storage-s3",
        adapter_version="1.0.0",
        adapter_contract="1.0.0",
        engine_profile="s3-compatible",
        supported_engine_versions=("2006-03-01",),
        default_engine_version="2006-03-01",
        catalogs=frozenset({CatalogName.OBJECT}),
        operations=_S3_OPERATIONS,
        allowed_topologies=frozenset(
            {Topology.SINGLE_PRIMARY, Topology.CLUSTER, Topology.EXTERNAL}
        ),
        default_topology=Topology.SINGLE_PRIMARY,
    ),
    EngineProfile(
        id="oci-distribution",
        adapter_id="oci-distribution",
        adapter_package="meridian-storage-oci",
        adapter_version="1.0.0",
        adapter_contract="1.0.0",
        engine_profile="oci-distribution",
        supported_engine_versions=("1.1.1",),
        default_engine_version="1.1.1",
        catalogs=frozenset({CatalogName.OBJECT}),
        operations=_OBJECT_BASE,
        allowed_topologies=frozenset({Topology.EXTERNAL}),
        default_topology=Topology.EXTERNAL,
    ),
    EngineProfile(
        id="apache-kafka",
        adapter_id="meridian.kafka",
        adapter_package="meridian-storage-kafka",
        adapter_version="1.0.1",
        adapter_contract="1.0.0",
        engine_profile="apache-kafka",
        supported_engine_versions=("4.1.2", "4.2.1", "4.3.1"),
        default_engine_version="4.3.1",
        catalogs=frozenset({CatalogName.STREAMING}),
        operations=_KAFKA_OPERATIONS,
        allowed_topologies=frozenset({Topology.CLUSTER, Topology.EXTERNAL}),
        default_topology=Topology.CLUSTER,
    ),
    EngineProfile(
        id="apache-kafka-test",
        adapter_id="meridian.kafka",
        adapter_package="meridian-storage-kafka",
        adapter_version="1.0.1",
        adapter_contract="1.0.0",
        engine_profile="apache-kafka-test",
        supported_engine_versions=("4.1.2", "4.2.1", "4.3.1"),
        default_engine_version="4.3.1",
        catalogs=frozenset({CatalogName.STREAMING}),
        operations=_KAFKA_OPERATIONS,
        allowed_topologies=frozenset({Topology.TEST, Topology.EXTERNAL}),
        default_topology=Topology.TEST,
    ),
)

_profile_by_id = {profile.id: profile for profile in _PROFILES}
PROFILES: Mapping[str, EngineProfile] = MappingProxyType(dict(sorted(_profile_by_id.items())))

PACKAGE_PINS: Mapping[str, str] = MappingProxyType(
    {
        "meridian-plugin-observability": "1.0.0",
        "meridian-storage-clickhouse": "1.0.0",
        "meridian-storage-core": "1.0.0",
        "meridian-storage-evidence": "1.0.0",
        "meridian-storage-kafka": "1.0.1",
        "meridian-storage-object-common": "1.0.0",
        "meridian-storage-oci": "1.0.0",
        "meridian-storage-opensearch": "1.0.0",
        "meridian-storage-postgresql": "1.0.0",
        "meridian-storage-query": "1.0.0",
        "meridian-storage-s3": "1.0.0",
        "meridian-storage-semantics": "1.0.0",
        "meridian-storage-streaming": "1.0.0",
        "meridian-storage-valkey": "1.0.0",
    }
)

ADAPTER_ENTRY_POINTS: Mapping[str, str] = MappingProxyType(
    {
        "clickhouse": "meridian-storage-clickhouse",
        "kafka": "meridian-storage-kafka",
        "oci-distribution": "meridian-storage-oci",
        "opensearch": "meridian-storage-opensearch",
        "postgresql": "meridian-storage-postgresql",
        "s3": "meridian-storage-s3",
        "valkey": "meridian-storage-valkey",
    }
)

ONE_PRIMARY_DEFAULTS: Mapping[CatalogName, str] = MappingProxyType(
    {
        CatalogName.STRUCTURED: "postgresql-postgis-local-single-primary",
        CatalogName.OBJECT: "s3-compatible",
        CatalogName.CACHE: "valkey-standalone",
        CatalogName.EVIDENCE: "clickhouse-standalone",
    }
)


def get_profile(profile_id: str) -> EngineProfile:
    try:
        return PROFILES[profile_id]
    except KeyError as exc:
        raise ConstructError(
            ErrorCode.PROFILE_NOT_FOUND, f"Unknown engine profile {profile_id!r}"
        ) from exc


def default_profiles(*, include_streaming: bool = False) -> Mapping[CatalogName, EngineProfile]:
    """Return conservative one-primary defaults; streaming remains explicit by default."""

    selected = {
        catalog: get_profile(profile_id) for catalog, profile_id in ONE_PRIMARY_DEFAULTS.items()
    }
    if include_streaming:
        selected[CatalogName.STREAMING] = get_profile("apache-kafka-test")
    return MappingProxyType(selected)


__all__ = [
    "ADAPTER_ENTRY_POINTS",
    "ONE_PRIMARY_DEFAULTS",
    "PACKAGE_PINS",
    "PROFILES",
    "EngineProfile",
    "OperationCapability",
    "default_profiles",
    "get_profile",
]
