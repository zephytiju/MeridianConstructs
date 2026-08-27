# SPDX-License-Identifier: Apache-2.0
"""Deterministic deployment and local cluster-equivalent conformance harnesses."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol

from ._canonical import JsonValue, fingerprint
from .compatibility import compatibility_fingerprint, verify_contract_consistency
from .contracts import Topology
from .planning import DeploymentPlan, DeploymentSpec, plan_deployment
from .profiles import get_profile
from .runtime import validate_runtime_config

_MINIMUM_REPEAT_COUNT = 2


@dataclass(frozen=True, slots=True)
class LocalClusterProfile:
    id: str
    engine_profile_id: str
    topology: Topology
    roles: tuple[str, ...]
    primary_count: int = 1


@dataclass(frozen=True, slots=True)
class ProbeResult:
    engine_profile: str
    engine_version: str
    adapter_id: str
    primary_count: int
    healthy_roles: tuple[str, ...]
    operation_contracts: frozenset[str]


class LocalClusterHarness(Protocol):
    """Implemented by a local Docker, Kubernetes, or provider test fixture."""

    def deploy_and_probe(self, profile: LocalClusterProfile) -> ProbeResult: ...


@dataclass(frozen=True, slots=True)
class ConformanceEvidence:
    deployment_fingerprint: str
    compatibility_fingerprint: str
    repeat_count: int
    local_profiles: tuple[str, ...]
    evidence_fingerprint: str

    def to_dict(self) -> dict[str, JsonValue]:
        return {
            "formatVersion": "meridian-constructs-conformance.v1",
            "deploymentFingerprint": self.deployment_fingerprint,
            "compatibilityFingerprint": self.compatibility_fingerprint,
            "repeatCount": self.repeat_count,
            "localProfiles": list(self.local_profiles),
            "evidenceFingerprint": self.evidence_fingerprint,
        }


LOCAL_CLUSTER_PROFILES: tuple[LocalClusterProfile, ...] = (
    LocalClusterProfile(
        "postgresql-single-primary",
        "postgresql-postgis-local-single-primary",
        Topology.SINGLE_PRIMARY,
        ("primary",),
    ),
    LocalClusterProfile(
        "postgresql-cluster",
        "postgresql-postgis-cluster",
        Topology.CLUSTER,
        ("primary", "standby-1", "standby-2"),
    ),
    LocalClusterProfile("opensearch-single", "opensearch", Topology.SINGLE_PRIMARY, ("node-1",)),
    LocalClusterProfile(
        "opensearch-cluster",
        "opensearch",
        Topology.CLUSTER,
        ("node-1", "node-2", "node-3"),
    ),
    LocalClusterProfile(
        "clickhouse-single", "clickhouse-standalone", Topology.SINGLE_PRIMARY, ("primary",)
    ),
    LocalClusterProfile(
        "clickhouse-cluster",
        "clickhouse-replicated",
        Topology.CLUSTER,
        ("primary", "replica", "keeper-1", "keeper-2", "keeper-3"),
    ),
    LocalClusterProfile(
        "valkey-single", "valkey-standalone", Topology.SINGLE_PRIMARY, ("primary",)
    ),
    LocalClusterProfile(
        "valkey-sentinel",
        "valkey-sentinel",
        Topology.CLUSTER,
        ("primary", "replica-1", "replica-2", "sentinel-1", "sentinel-2", "sentinel-3"),
    ),
    LocalClusterProfile("s3-compatible", "s3-compatible", Topology.SINGLE_PRIMARY, ("primary",)),
    LocalClusterProfile("oci-distribution", "oci-distribution", Topology.EXTERNAL, ("registry",)),
    LocalClusterProfile("kafka-test", "apache-kafka-test", Topology.TEST, ("controller-broker",)),
    LocalClusterProfile(
        "kafka-cluster",
        "apache-kafka",
        Topology.CLUSTER,
        ("controller-1", "controller-2", "controller-3", "broker-1", "broker-2", "broker-3"),
    ),
)


def run_deployment_conformance(spec: DeploymentSpec, *, repeat_count: int = 3) -> DeploymentPlan:
    """Validate schema compatibility and identical output across repeated previews."""

    if repeat_count < _MINIMUM_REPEAT_COUNT:
        raise ValueError("Conformance repeat_count must be at least two")
    verify_contract_consistency()
    plans = tuple(plan_deployment(spec) for _ in range(repeat_count))
    first = plans[0]
    if any(plan.runtime_config_json != first.runtime_config_json for plan in plans[1:]):
        raise AssertionError("Repeated deployment planning was not deterministic")
    validate_runtime_config(first.runtime_config)
    return first


def run_local_cluster_conformance(
    harness: LocalClusterHarness,
    profiles: Sequence[LocalClusterProfile] = LOCAL_CLUSTER_PROFILES,
) -> tuple[ProbeResult, ...]:
    """Run the same topology checks against any local cluster-equivalent fixture."""

    results: list[ProbeResult] = []
    for test_profile in profiles:
        released = get_profile(test_profile.engine_profile_id)
        observed = harness.deploy_and_probe(test_profile)
        if observed.engine_profile != released.engine_profile:
            raise AssertionError(f"{test_profile.id}: Engine profile mismatch")
        if observed.engine_version not in released.supported_engine_versions:
            raise AssertionError(f"{test_profile.id}: unsupported Engine version")
        if observed.adapter_id != released.adapter_id:
            raise AssertionError(f"{test_profile.id}: Adapter identity mismatch")
        if observed.primary_count != test_profile.primary_count or observed.primary_count != 1:
            raise AssertionError(f"{test_profile.id}: expected exactly one primary")
        if set(observed.healthy_roles) != set(test_profile.roles):
            raise AssertionError(f"{test_profile.id}: topology roles are unhealthy or incomplete")
        missing = set(released.operations) - observed.operation_contracts
        if missing:
            raise AssertionError(f"{test_profile.id}: missing operations {sorted(missing)!r}")
        results.append(observed)
    return tuple(results)


def conformance_evidence(
    plan: DeploymentPlan,
    *,
    repeat_count: int,
    local_profiles: Sequence[LocalClusterProfile] = LOCAL_CLUSTER_PROFILES,
) -> ConformanceEvidence:
    body: Mapping[str, JsonValue] = {
        "deploymentFingerprint": plan.fingerprint,
        "compatibilityFingerprint": compatibility_fingerprint(),
        "repeatCount": repeat_count,
        "localProfiles": [item.id for item in local_profiles],
    }
    return ConformanceEvidence(
        plan.fingerprint,
        compatibility_fingerprint(),
        repeat_count,
        tuple(item.id for item in local_profiles),
        fingerprint(body),
    )


__all__ = [
    "LOCAL_CLUSTER_PROFILES",
    "ConformanceEvidence",
    "LocalClusterHarness",
    "LocalClusterProfile",
    "ProbeResult",
    "conformance_evidence",
    "run_deployment_conformance",
    "run_local_cluster_conformance",
]
