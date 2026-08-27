# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import pytest

from meridian_constructs import (
    CollectorMode,
    ConstructError,
    OtelCollectorSpec,
    ResourceRef,
    backup_job,
    cache_warm_job,
    collector_environment,
    migration_job,
    projection_job,
    restore_job,
    streaming_bootstrap_job,
    validation_job,
)

from .support import fp

IMAGE = f"registry.example/meridian/job@{fp('job-image')}"
COLLECTOR_IMAGE = f"otel/opentelemetry-collector-contrib@{fp('collector-image')}"


def test_lifecycle_jobs_are_explicit_digest_pinned_and_deterministic() -> None:
    resource = ResourceRef.parse("structured:app.records")
    migration = migration_job(
        image=IMAGE,
        resources=(resource,),
        from_fingerprint=fp("before"),
        to_fingerprint=fp("after"),
    )
    assert migration.spec_fingerprint == migration.spec_fingerprint
    assert (
        backup_job(image=IMAGE, resources=(resource,), policy_ref="policy/daily").kind == "backup"
    )
    assert (
        restore_job(
            image=IMAGE, resources=(resource,), recovery_point_ref="recovery/2026-08-26"
        ).kind
        == "restore"
    )
    with pytest.raises(ConstructError, match="pinned"):
        migration_job(
            image="registry.example/job:latest",
            resources=(resource,),
            from_fingerprint=fp("before"),
            to_fingerprint=fp("after"),
        )
    assert (
        projection_job(
            image=IMAGE,
            source=resource,
            target=ResourceRef.parse("structured:app.projection"),
            projection_fingerprint=fp("projection"),
        ).kind
        == "projection"
    )
    assert (
        cache_warm_job(
            image=IMAGE,
            source=resource,
            cache=ResourceRef.parse("cache:app.records"),
            generation="g1",
        ).kind
        == "cache-warm"
    )
    assert (
        streaming_bootstrap_job(
            image=IMAGE,
            resources=(ResourceRef.parse("streaming:app.events"),),
            mapping_fingerprint=fp("mapping"),
        ).kind
        == "streaming-bootstrap"
    )
    assert (
        validation_job(
            image=IMAGE,
            resources=(resource,),
            expected_config_fingerprint=fp("config"),
        ).kind
        == "validation"
    )


def collector_config() -> dict[str, object]:
    return {
        "receivers": {"otlp": {"protocols": {"grpc": {}, "http": {}}}},
        "processors": {"batch": {}},
        "exporters": {"otlp": {"endpoint": "telemetry.internal:4317"}},
        "service": {"pipelines": {"traces": {"receivers": ["otlp"], "exporters": ["otlp"]}}},
    }


def test_collector_supports_sidecar_and_gateway_with_digest_pins() -> None:
    sidecar = OtelCollectorSpec(CollectorMode.SIDECAR, COLLECTOR_IMAGE, collector_config())
    gateway = OtelCollectorSpec(
        CollectorMode.GATEWAY, COLLECTOR_IMAGE, collector_config(), replicas=3
    )
    assert sidecar.spec_fingerprint != gateway.spec_fingerprint
    assert collector_environment("http://collector:4318", protocol="http/protobuf") == {
        "OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector:4318",
        "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    }
    with pytest.raises(ConstructError, match="one replica"):
        OtelCollectorSpec(CollectorMode.SIDECAR, COLLECTOR_IMAGE, collector_config(), replicas=2)
    with pytest.raises(ConstructError, match="secretRef"):
        OtelCollectorSpec(
            CollectorMode.GATEWAY,
            COLLECTOR_IMAGE,
            {**collector_config(), "exporter_token": "inline"},
        )


@pytest.mark.parametrize(
    ("config", "message"),
    [
        ({}, "cannot be empty"),
        ({"receivers": {}, "processors": {}, "exporters": {}}, "missing sections"),
        (
            {"receivers": {}, "processors": {}, "exporters": {}, "service": {"pipelines": {}}},
            "OTLP receiver",
        ),
        (
            {
                "receivers": {"otlp": {}},
                "processors": {},
                "exporters": {},
                "service": {},
            },
            "service pipelines",
        ),
    ],
)
def test_collector_config_fails_closed(config: dict[str, object], message: str) -> None:
    with pytest.raises(ConstructError, match=message):
        OtelCollectorSpec(CollectorMode.GATEWAY, COLLECTOR_IMAGE, config)


def test_collector_endpoints_and_bounds_fail_closed() -> None:
    with pytest.raises(ConstructError, match="pinned"):
        OtelCollectorSpec(CollectorMode.GATEWAY, "collector:latest", collector_config())
    with pytest.raises(ConstructError, match="replicas"):
        OtelCollectorSpec(CollectorMode.GATEWAY, COLLECTOR_IMAGE, collector_config(), replicas=0)
    with pytest.raises(ConstructError, match="port"):
        OtelCollectorSpec(CollectorMode.GATEWAY, COLLECTOR_IMAGE, collector_config(), grpc_port=0)
    with pytest.raises(ConstructError, match="protocol"):
        collector_environment("http://collector", protocol="json")
    with pytest.raises(ConstructError, match="cannot be empty"):
        collector_environment("")
