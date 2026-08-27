# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import json

import pulumi

from meridian_constructs import (
    CollectorMode,
    EngineBindingArgs,
    EngineConnectionInputs,
    ExternalEngine,
    ExternalEngineArgs,
    ManagedEngine,
    ManagedEngineArgs,
    MeridianDeployment,
    MeridianDeploymentArgs,
    MeridianLifecycleJob,
    MeridianOtelCollector,
    OtelCollectorSpec,
    ResourceRef,
    SecretReferenceInputs,
    TLSInputs,
    backup_job,
)
from tests.support import catalogs, complete_placements, complete_resources, fp, schema_providers

_ADAPTER_COUNT = 7
_IMAGE = f"registry.example/job@{fp('job')}"
_COLLECTOR_IMAGE = f"registry.example/otel@{fp('otel')}"


class Mocks(pulumi.runtime.Mocks):
    def new_resource(
        self, args: pulumi.runtime.MockResourceArgs
    ) -> tuple[str | None, dict[str, object]]:
        return f"{args.name}-id", args.inputs

    def call(
        self, args: pulumi.runtime.MockCallArgs
    ) -> tuple[dict[str, object], list[tuple[str, str]] | None]:
        return {}, None


class ManagedProvider:
    def provision(
        self, name: str, profile: object, request: object, parent: pulumi.Resource
    ) -> EngineConnectionInputs:
        return EngineConnectionInputs(
            physical_namespace=f"managed_{name}",
            identity_ref=SecretReferenceInputs("identity", f"workloads/{name}"),
            secret_ref=SecretReferenceInputs("vault", f"engines/{name}"),
            tls=TLSInputs("server", "engine.internal", SecretReferenceInputs("vault", "pki/ca")),
            service_ref=f"platform/services/{name}",
            required_physical_fingerprint=fp(f"physical:{name}"),
        )


class WorkloadProvisioner:
    def provision(
        self, name: str, spec: object, parent: pulumi.Resource
    ) -> dict[str, pulumi.Input[object]]:
        return {"workloadRef": f"platform/workloads/{name}"}


pulumi.runtime.set_mocks(Mocks(), project="meridian-constructs", stack="test")


@pulumi.runtime.test
def test_external_engine_and_deployment_component_outputs() -> pulumi.Output[None]:
    resources = complete_resources()
    cases = (
        ("postgresql", "postgresql-postgis-local-single-primary", "postgresql://db:5432"),
        ("opensearch", "opensearch", "https://search:9200"),
        ("clickhouse", "clickhouse-standalone", "https://analytics:8443"),
        ("valkey", "valkey-standalone", "rediss://cache:6379"),
        ("s3", "s3-compatible", "https://objects"),
        ("oci", "oci-distribution", "https://registry"),
        ("kafka", "apache-kafka", "kafka://broker:9093"),
    )
    engines = []
    for binding_id, profile_id, endpoint in cases:
        inputs = EngineConnectionInputs(
            physical_namespace=f"meridian_{binding_id}",
            identity_ref=SecretReferenceInputs("identity", f"workloads/{binding_id}"),
            secret_ref=SecretReferenceInputs("vault", f"engines/{binding_id}"),
            tls=TLSInputs(
                "server",
                "engine.internal",
                SecretReferenceInputs("vault", "pki/ca"),
            ),
            endpoint=endpoint,
            required_physical_fingerprint=fp(f"physical:{binding_id}"),
            settings={"deploymentLabel": binding_id},
        )
        engines.append(
            ExternalEngine(
                binding_id,
                ExternalEngineArgs(
                    EngineBindingArgs(binding_id, profile_id, fp(f"capability:{binding_id}")),
                    inputs,
                ),
            )
        )
    deployment = MeridianDeployment(
        "complete",
        MeridianDeploymentArgs(
            "pulumi",
            catalogs(),
            schema_providers(),
            resources,
            engines,
            complete_placements(resources),
        ),
    )

    def check(value: str) -> None:
        decoded = json.loads(value)
        assert decoded["formatVersion"] == "meridian-config.v1"
        assert len(decoded["bindings"]) == _ADAPTER_COUNT

    return deployment.runtime_config_json.apply(check)


@pulumi.runtime.test
def test_managed_engine_and_injected_workload_provisioners() -> pulumi.Output[None]:
    managed = ManagedEngine(
        "managed-postgresql",
        ManagedEngineArgs(
            EngineBindingArgs(
                "managed-postgresql",
                "postgresql-postgis-local-single-primary",
                fp("managed-capability"),
            ),
            ManagedProvider(),
        ),
    )
    resource = ResourceRef.parse("structured:app.records")
    job = MeridianLifecycleJob(
        "backup",
        backup_job(image=_IMAGE, resources=(resource,), policy_ref="daily"),
        WorkloadProvisioner(),
    )
    collector = MeridianOtelCollector(
        "collector",
        OtelCollectorSpec(
            CollectorMode.SIDECAR,
            _COLLECTOR_IMAGE,
            {
                "receivers": {"otlp": {}},
                "processors": {"batch": {}},
                "exporters": {"otlp": {"endpoint": "telemetry:4317"}},
                "service": {"pipelines": {}},
            },
        ),
        WorkloadProvisioner(),
    )

    def check(binding: object) -> None:
        assert binding.mode == "managed"  # type: ignore[attr-defined]
        assert binding.connection.service_ref == "platform/services/managed-postgresql"  # type: ignore[attr-defined]

    return pulumi.Output.all(managed.binding, job.urn, collector.urn).apply(
        lambda values: check(values[0])
    )
