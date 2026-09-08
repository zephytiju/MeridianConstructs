# SPDX-License-Identifier: Apache-2.0
"""Caller-owned deployment fixture using the real public Observability plugin."""

import json
import os
import sys
from pathlib import Path
from importlib.metadata import version
from meridian_storage import Meridian, ResourceRef, OperationContext
from meridian_storage.runtime import RuntimeConfig
from meridian_storage.registry import (
    ResourceBundle,
    ResourceDefinition,
    SchemaDefinition,
    SchemaRef,
    NamespaceDefinition,
)
from meridian_storage.spi import SecretValue
from meridian_storage.plugins.observability import (
    Observability,
    DeploymentTelemetryConfig,
    EvidenceResources,
)
from meridian_storage.plugins.observability.config import OTLPProtocol, BatchPolicy

payload = json.load(sys.stdin)
config = payload["runtimeConfig"]
b = payload["bundle"]
if payload.get("sidecar"):
    config["bindings"][0]["endpoint"] = "https://backend:8443"
bundle = ResourceBundle(
    provider_id=b["providerId"],
    provider_version=b["providerVersion"],
    provider_contract_version=b["providerContractVersion"],
    namespaces=tuple(NamespaceDefinition(**v) for v in b["namespaces"]),
    schemas=tuple(
        SchemaDefinition(
            SchemaRef.parse(v["ref"]),
            v["definition"],
            tuple(SchemaRef.parse(r) for r in v["dependencies"]),
            v["extensions"],
        )
        for v in b["schemas"]
    ),
    resources=tuple(
        ResourceDefinition(
            ResourceRef.parse(v["ref"]),
            v["profile"],
            SchemaRef.parse(v["schema"]),
            labels=v["labels"],
            required_scope=tuple(v["requiredScope"]),
            extensions=v["extensions"],
        )
        for v in b["resources"]
    ),
    extensions=b["extensions"],
)


class Provider:
    provider_id = bundle.provider_id
    provider_contract_version = bundle.provider_contract_version

    def load(self):
        return bundle


class Secrets:
    def resolve(self, ref):
        return SecretValue(
            Path(payload["ca"]).read_bytes()
            if ref.reference == "ca"
            else b"meridian"
            if ref.reference == "username"
            else b"meridian-test"
        )


for key in ("CERTIFICATE", "CLIENT_CERTIFICATE", "CLIENT_KEY"):
    os.environ["OTEL_EXPORTER_OTLP_" + key] = (
        payload["key"] if key == "CLIENT_KEY" else payload["ca"]
    )
runtime = Meridian(
    RuntimeConfig.from_mapping(config), schema_providers=[Provider()], secret_resolver=Secrets()
)
plugin = None
try:
    report = runtime.start()
    by_profile = {v["profile"]: ResourceRef.parse(v["ref"]) for v in b["resources"]}
    resources = EvidenceResources(by_profile["log"], by_profile["span"], by_profile["metric"])
    plugin = Observability(
        runtime,
        service_name="collector-plugin-" + payload["mode"],
        service_version="1.0.0",
        deployment_environment="conformance",
        resource_attributes={
            "integer": 1,
            "text": "1",
            "boolean": True,
            "boolean_text": "true",
            "large": 9007199254740993,
        },
        deployment=DeploymentTelemetryConfig(
            endpoint=payload["endpoint"],
            protocol=OTLPProtocol.HTTP_PROTOBUF,
            batch=BatchPolicy(
                max_queue_size=16,
                max_export_batch_size=8,
                schedule_delay_millis=100,
                export_timeout_millis=30000,
            ),
        ),
        evidence_resources=resources,
    )
    attributes = {
        "integer": 1,
        "text": "1",
        "boolean": True,
        "boolean_text": "true",
        "large": 9007199254740993,
    }
    with runtime.context(
        OperationContext(
            "test:plugin", tenant="tenant-a", scope={"service": "collector-feasibility"}
        )
    ):
        with plugin.tracer("acceptance").start_as_current_span(
            "plugin-span-" + payload["mode"], attributes=attributes
        ) as span:
            span.add_event("plugin-event", attributes)
            plugin.logger("acceptance").info(
                {"event": "plugin-log-" + payload["mode"], "integer": 1, "text": "1"}, attributes
            )
            gauge = plugin.meter("acceptance").create_gauge(
                "plugin.gauge", allowed_attributes=("case",)
            )
            gauge.set(9007199254740992, {"case": "lower"})
            gauge.set(9007199254740993, {"case": "upper"})
            plugin.meter("acceptance").create_histogram("plugin.histogram", unit="ms").record(0.25)
            plugin.meter("acceptance").create_counter("plugin.counter").add(2)
        flushed = plugin.force_flush()
        assert all(flushed), flushed
    result = {
        "mode": payload["mode"],
        "startup": report.to_dict(),
        "flush": flushed,
        "versions": {
            p: version(p)
            for p in (
                "meridian-storage-core",
                "meridian-storage-semantics",
                "meridian-storage-evidence",
                "meridian-storage-clickhouse",
                "meridian-plugin-observability",
            )
        },
    }
finally:
    if plugin is not None:
        plugin.close(require_clean=True)
    runtime.close()
print(json.dumps(result))
