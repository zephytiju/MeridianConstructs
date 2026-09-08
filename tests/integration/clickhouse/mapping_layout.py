# SPDX-License-Identifier: Apache-2.0
import json
import subprocess
import os
from pathlib import Path
from dataclasses import replace
from meridian_storage import ResourceRef
from meridian_storage.registry import (
    ResourceDefinition,
    SchemaDefinition,
    ResourceBundle,
    NamespaceDefinition,
)
from meridian_storage.semantics import (
    CatalogName,
    SchemaReference,
    SchemaDocument,
    SemanticKind,
    FieldDefinition,
    LogicalType,
    LogicalKind,
)
from meridian_storage.adapters.clickhouse import ClickHouseSchemaCompiler
from meridian_storage.adapters.clickhouse.schema import SchemaCompilation

SCRIPTS = Path(__file__).resolve().parent
ROOT = Path(os.environ["MERIDIAN_ACCEPTANCE_EVIDENCE_DIR"]).resolve()
ROOT.mkdir(parents=True, exist_ok=True)
REPO = SCRIPTS.parents[2]


def render(payload):
    p = subprocess.run(
        ["node", "--import", "tsx", str(SCRIPTS / "render.ts")],
        cwd=REPO,
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(p.stdout)


FIELDS = render({"command": "fields"})


def build(mode):
    compiled = []
    schemas = []
    resources = []
    for profile in ("log", "span", "metric"):
        resource = ResourceRef("evidence", "telemetry", mode + "_" + profile)
        schema = SchemaDocument(
            ref=SchemaReference(
                CatalogName("evidence"), "telemetry", mode + "_" + profile, "1.0.0"
            ),
            semantic_kind=SemanticKind.DOCUMENT,
            fields=tuple(
                FieldDefinition(
                    x["name"], LogicalType(LogicalKind(x["kind"])), nullable=x["nullable"]
                )
                for x in FIELDS[profile]
            ),
            identity=("evidenceId",),
            consistency="eventual",
        )
        registered = SchemaDefinition(ref=schema.ref.to_core(), definition=schema.to_dict())
        definition = ResourceDefinition(
            resource, profile, schema.ref.to_core(), required_scope=("service",)
        )
        original = ClickHouseSchemaCompiler().compile(
            database="native_" + mode,
            resource=resource,
            resource_fingerprint=definition.fingerprint,
            schema=schema,
            record_profile=profile,
            timestamp_field="observedTime",
        )
        # A registered Core SchemaDefinition is the physical schema pin. Construct a
        # public ResourceLayout/SchemaCompilation with that explicit deployment pin;
        # both content fingerprints are retained and startup verification stays on.
        selected = SchemaCompilation(
            replace(original.layout, schema_fingerprint=registered.fingerprint),
            original.metadata_table_sql,
            original.create_table_sql,
        )
        compiled.append(selected)
        schemas.append(registered)
        resources.append(definition)
    bundle = ResourceBundle(
        "collector.telemetry",
        "1.0.0",
        "1.0.0",
        namespaces=(NamespaceDefinition("evidence", "telemetry"),),
        schemas=tuple(schemas),
        resources=tuple(resources),
    )
    inputs = {
        "mode": mode,
        "image": "ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6",
        "database": "native_" + mode,
        "bindingId": "telemetry",
        "layouts": {x.layout.record_profile.value: x.layout.to_dict() for x in compiled},
        "tenant": "tenant-a",
        "scope": {"service": "collector-feasibility"},
        "ingestionIdentity": "collector:" + mode,
        "receiverTls": {
            "mode": "mutual",
            "serverName": "localhost",
            "caRef": {"provider": "test", "reference": "ca"},
            "clientCertificateRef": {"provider": "test", "reference": "client"},
        },
        "tlsFiles": {
            "certificate": "/tls/cert.pem",
            "key": "/tls/key.pem",
            "clientCa": "/tls/cert.pem",
            "receiverCa": "/tls/cert.pem",
            "backendCa": "/tls/cert.pem",
        },
        "backendEndpoint": "https://backend:8443",
        "backendIdentityEnvironment": "CLICKHOUSE_USER",
        "backendCredentialEnvironment": "CLICKHOUSE_PASSWORD",
        "relayCredentialEnvironment": "COLLECTOR_RELAY",
        "queueDirectory": "/queue",
        "queueRequests": 2,
        "maxEnvelopeBytes": 32768,
        "maxBatchBytes": 1048576,
        "maxBatchRows": 100,
        "insertQuorum": 1,
    }
    plan = render({"command": "plan", "input": inputs})
    (ROOT / (mode + "-input.json")).write_text(json.dumps(inputs, indent=2) + "\n")
    (ROOT / (mode + "-plan.json")).write_text(json.dumps(plan, indent=2) + "\n")
    return compiled, bundle, plan


if __name__ == "__main__":
    for mode in ("gateway", "sidecar"):
        c, b, p = build(mode)
        print(
            mode,
            "statements",
            len(p["migration"]["statements"]),
            "bytes",
            sum(len(x) for x in p["migration"]["statements"]),
        )


def apply(client, mode, state, port, ca):
    from meridian_storage import Meridian
    from meridian_storage.runtime import BindingConfig, RuntimeConfig
    from meridian_storage.spi import AdapterCreateContext, SecretValue, PhysicalResource
    from meridian_storage.adapters.clickhouse import (
        ClickHouseAdapterFactory,
        ClickHouseSettings,
        ClickHouseMigrator,
        plan_initial_migration,
        capability_manifest,
    )
    from meridian_storage.evidence import EvidenceCatalogProvider

    compiled, bundle, plan = state
    client.command("CREATE DATABASE IF NOT EXISTS native_" + mode)
    raw = {
        "id": "telemetry",
        "adapterId": "meridian.storage.clickhouse",
        "adapterContract": "1.0.0",
        "engineProfile": "clickhouse-standalone",
        "engineVersion": client.command("SELECT version()"),
        "endpoint": f"https://localhost:{port}",
        "serviceRef": None,
        "physicalNamespace": "native_" + mode,
        "tls": {
            "mode": "server",
            "serverName": "localhost",
            "caRef": {"provider": "test", "reference": "ca"},
            "clientCertificateRef": None,
        },
        "identityRef": {"provider": "test", "reference": "username"},
        "secretRef": {"provider": "test", "reference": "password"},
        "client": {
            "minSize": 0,
            "maxSize": 4,
            "acquireTimeoutMs": 5000,
            "idleTimeoutMs": 60000,
            "operationTimeoutMs": 30000,
            "maxResultBytes": 4194304,
            "iteratorLifetimeMs": 30000,
        },
        "requiredCapabilityFingerprint": "sha256:" + "0" * 64,
        "requiredPhysicalFingerprint": None,
        "compatibilityPins": {},
        "extensions": {},
        "settings": {
            "layouts": [c.layout.to_dict() for c in compiled],
            "maxBatchRows": 100,
            "maxBatchBytes": 1048576,
            "maxTimeRangeSeconds": 86400,
            "retryWindowSeconds": 86400,
            "cursorTtlSeconds": 900,
            "insertQuorum": 1,
            "requiredFunctions": ["count", "quantile", "sum"],
        },
    }
    provisional = BindingConfig.from_mapping(raw, "bindings[0]")
    raw["requiredCapabilityFingerprint"] = capability_manifest(
        ClickHouseSettings.from_binding(provisional), provisional.engine_version
    ).fingerprint
    binding = BindingConfig.from_mapping(raw, "bindings[0]")
    settings = ClickHouseSettings.from_binding(binding)
    ClickHouseMigrator(client, settings).apply(
        plan_initial_migration("telemetry-" + mode, tuple(compiled))
    )
    for index, sql in enumerate(plan["migration"]["statements"]):
        (ROOT / (mode + "-current-migration.sql")).write_text(
            ";\n".join(plan["migration"]["statements"]) + ";\n"
        )
        client.command(
            sql, settings={"allow_simdjson": 0, "short_circuit_function_evaluation": "force_enable"}
        )
    adapter = ClickHouseAdapterFactory().create(
        AdapterCreateContext(
            binding,
            SecretValue(b"meridian"),
            SecretValue(b"meridian-test"),
            tls_ca=SecretValue(Path(ca).read_bytes()),
        )
    )
    adapter.open()
    try:
        verification = adapter.verify_physical(
            tuple(
                PhysicalResource(r.ref, r.fingerprint, sch.fingerprint, r.profile)
                for r, sch in zip(bundle.resources, bundle.schemas)
            )
        )
    finally:
        adapter.close()
    raw["requiredPhysicalFingerprint"] = verification.fingerprint

    class Provider:
        provider_id = bundle.provider_id
        provider_contract_version = bundle.provider_contract_version

        def load(self):
            return bundle

    class Secrets:
        def resolve(self, ref):
            return SecretValue(
                Path(ca).read_bytes()
                if ref.reference == "ca"
                else b"meridian"
                if ref.reference == "username"
                else b"meridian-test"
            )

    catalog = EvidenceCatalogProvider().manifest()
    config = {
        "formatVersion": "meridian-config.v1",
        "profile": "conformance",
        "catalogs": {
            "providers": [
                {
                    "name": "evidence",
                    "package": "meridian-storage-evidence",
                    "contract": catalog.catalog_contract_version,
                    "requiredFingerprint": catalog.fingerprint,
                }
            ],
            "extensions": {},
        },
        "schemas": {
            "providers": [
                {
                    "id": bundle.provider_id,
                    "package": "collector-deployment",
                    "contract": bundle.provider_contract_version,
                    "requiredFingerprint": bundle.fingerprint,
                }
            ],
            "live": {"enabled": False, "required": False, "providerId": None},
            "extensions": {},
        },
        "resources": {
            "pins": [
                {
                    "ref": r.ref.to_dict(),
                    "providerId": bundle.provider_id,
                    "requiredFingerprint": r.fingerprint,
                }
                for r in bundle.resources
            ],
            "extensions": {},
        },
        "bindings": [raw],
        "placements": [
            {
                "id": "telemetry",
                "selector": {
                    "resources": [r.ref.to_dict() for r in bundle.resources],
                    "catalog": None,
                    "labels": {},
                },
                "bindingId": "telemetry",
                "extensions": {},
            }
        ],
        "validation": {
            "strict": True,
            "requirePhysicalFingerprints": True,
            "defaultOperationTimeoutMs": 30000,
            "idempotencyCacheEntries": 1024,
            "retry": {"maxAttempts": 1, "baseDelayMs": 1, "maxDelayMs": 1, "jitterRatio": 0},
        },
    }
    (ROOT / (mode + "-runtime-config.json")).write_text(json.dumps(config, indent=2) + "\n")
    runtime = Meridian(
        RuntimeConfig.from_mapping(config), schema_providers=[Provider()], secret_resolver=Secrets()
    )
    try:
        report = runtime.start()
    except Exception:
        runtime.close()
        raise
    return runtime, settings, report


def inspect_records(client, mode, state, runtime, settings):
    import hashlib
    from datetime import datetime, timezone, timedelta
    from meridian_storage import Operation, OperationContext
    from meridian_storage.spi import ExecutionRequest
    from meridian_storage.plugins.observability import EvidenceResources, TelemetryQueries
    from meridian_storage.adapters.clickhouse.ingestion import prepare_batch
    from meridian_storage.semantics import canonical_json_bytes
    from meridian_storage.evidence import evidence_schema
    from jsonschema import Draft202012Validator, FormatChecker
    from referencing import Registry, Resource

    compiled, bundle, plan = state
    resources = EvidenceResources(*(c.layout.resource for c in compiled))
    context = OperationContext(
        "test:collector", tenant="tenant-a", scope={"service": "collector-feasibility"}
    )
    queries = TelemetryQueries(runtime, resources)
    start = datetime(2026, 9, 8, 16, 55, tzinfo=timezone.utc)
    end = start + timedelta(seconds=1)
    results = {}
    with runtime.context(context):
        results["log"] = [
            dict(x) for x in queries.logs(start=start, end=end).page(limit=100).execute().items
        ]
        results["span"] = [
            dict(x) for x in queries.spans(start=start, end=end).page(limit=100).execute().items
        ]
        results["metric"] = [
            dict(x)
            for name in ("numbers", "histogram", "exponential", "float.edges")
            for x in queries.metric_series(name, start=start, end=end)
            .page(limit=100)
            .execute()
            .items
        ]
    assert {k: len(v) for k, v in results.items()} == {"log": 1, "span": 1, "metric": 9}, {
        k: len(v) for k, v in results.items()
    }
    (ROOT / (mode + "-public-records.json")).write_text(
        json.dumps(results, indent=2, ensure_ascii=False) + "\n"
    )
    common = evidence_schema("common")
    registry = Registry().with_resource(common["$id"], Resource.from_contents(common))
    checks = []
    for compilation in compiled:
        layout = compilation.layout
        profile = layout.record_profile.value
        schema = evidence_schema("metric_point" if profile == "metric" else profile)
        validator = Draft202012Validator(schema, registry=registry, format_checker=FormatChecker())
        actual = {
            str(row[0]): row[1:]
            for row in client.query(
                "SELECT `"
                + layout.physical_column("evidenceId")
                + "`,_meridian_scope_fingerprint,_meridian_batch_id,_meridian_row_fingerprint,toUnixTimestamp64Nano(`"
                + layout.physical_column("observedTime")
                + "`) FROM "
                + layout.qualified_table(settings.database)
                + " FINAL"
            ).result_rows
        }
        for row in results[profile]:
            record = {
                k: v
                for k, v in row.items()
                if not (k in ("traceId", "spanId", "parentSpanId") and v is None)
            }
            validator.validate(record)
            evidence_id = record["evidenceId"]
            base = {k: v for k, v in record.items() if k != "evidenceId"}
            assert evidence_id == "sha256:" + hashlib.sha256(canonical_json_bytes(base)).hexdigest()
            ctx = OperationContext(
                "test:collector",
                tenant="tenant-a",
                scope={"service": "collector-feasibility"},
                idempotency_key=evidence_id,
            )
            operation = Operation(
                "evidence",
                "meridian.evidence.append",
                "1.0.0",
                (layout.resource,),
                {"records": [record]},
                read_only=False,
                idempotent=True,
            )
            request = ExecutionRequest(
                operation,
                ctx,
                evidence_id,
                evidence_id,
                "telemetry",
                1,
                runtime.startup_report.registry_fingerprint,
                1,
            )
            batch = prepare_batch(request, layout, [record], settings)
            values = actual[evidence_id]

            def text(v):
                return v.decode() if isinstance(v, bytes) else v

            assert text(values[0]) == batch.rows[0][0]
            assert text(values[1]) == batch.batch_id
            assert text(values[2]) == batch.rows[0][3]
            timestamp_index = layout.insert_columns.index(layout.physical_column("observedTime"))
            assert values[3] == batch.rows[0][timestamp_index]
            checks.append(
                {
                    "profile": profile,
                    "evidenceId": evidence_id,
                    "scopeBatchRowEqualPublicPreparation": True,
                    "storedObservedNanoseconds": values[3],
                    "readObservedTime": row["observedTime"],
                }
            )
    log = results["log"][0]
    span = results["span"][0]
    for attributes in [
        log["attributes"],
        log["body"],
        span["attributes"],
        span["events"][0]["attributes"],
        span["links"][0]["attributes"],
    ]:
        assert type(attributes["integer"]) is int and attributes["integer"] == 1
        assert type(attributes["double"]) is float and attributes["double"] == 1.0
        assert (
            attributes["text"] == "1"
            and attributes["boolean"] is True
            and attributes["boolean_text"] == "true"
        )
        assert attributes["large"] == 9007199254740993 and type(attributes["large"]) is int
        assert (
            attributes["bytes"] == {"base64": "AQI=", "type": "bytes"}
            and attributes["bytes_text"] == "AQI="
        )
        assert attributes["array"] == [1, "1", True]
    assert log["eventTime"] == "2026-09-08T16:55:00.123456789Z"
    assert log["observedTime"] == "2026-09-08T16:55:00.123456790Z"
    assert span["startTime"] == "2026-09-08T16:55:00.123456789Z"
    assert span["endTime"] == "2026-09-08T16:55:00.123456796Z"
    gauges = {r["dimensions"]["case"]: r for r in results["metric"] if r["name"] == "numbers"}
    (ROOT / (mode + "-gauge-cases.json")).write_text(json.dumps(gauges, indent=2) + "\n")
    assert sorted(r["value"] for r in gauges.values()) == [
        0,
        0.0,
        9007199254740992,
        9007199254740993,
    ]
    assert (
        type(gauges["int_zero"]["value"]) is int and type(gauges["double_zero"]["value"]) is float
    )
    hist = next(r for r in results["metric"] if r["name"] == "histogram")
    assert hist["value"]["min"] == 0.25 and hist["value"]["max"] == 3.0
    assert hist["exemplars"][0]["value"] == 9007199254740993
    exponential = next(r for r in results["metric"] if r["name"] == "exponential")
    assert exponential["metricType"] == "exponential-histogram"
    assert exponential["value"] == {
        "count": 4,
        "sum": 1.0,
        "min": -0.25,
        "max": 0.5,
        "scale": 2,
        "zeroCount": 1,
        "zeroThreshold": 0.01,
        "positive": {"offset": -1, "bucketCounts": [1, 1]},
        "negative": {"offset": 0, "bucketCounts": [1]},
    }
    import math

    edges = {
        r["dimensions"]["case"]: r["value"] for r in results["metric"] if r["name"] == "float.edges"
    }
    assert math.copysign(1, edges["negative-zero"]) == -1
    assert edges["subnormal"] == 5e-324 and edges["large-float"] == 1e20
    pages = []
    cursor = None
    with runtime.context(context):
        for _ in range(5):
            page = (
                queries.metric_series("numbers", start=start, end=end)
                .page(limit=1, cursor=cursor)
                .execute()
            )
            pages.extend(x["evidenceId"] for x in page.items)
            if page.cursor is None:
                break
            cursor = page.cursor
    assert len(pages) == len(set(pages)) == 4, pages
    return {
        "mode": mode,
        "publicReadCounts": {k: len(v) for k, v in results.items()},
        "v1SchemaValidated": True,
        "canonicalChecks": checks,
        "nanosecondPaginationUniqueRows": len(pages),
        "typedSignalFidelity": True,
    }
