# SPDX-License-Identifier: Apache-2.0
"""Public append layout selection and generated Core append/read conformance."""

import copy
import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone

from meridian_storage import Meridian, OperationContext
from meridian_storage.adapters.clickhouse import (
    ClickHouseMigrator,
    plan_initial_migration,
)
from meridian_storage.adapters.clickhouse.schema import ResourceLayout, SchemaCompilation
from meridian_storage.adapters.clickhouse.schema.compiler import (
    create_table_ddl,
    metadata_table_ddl,
)
from meridian_storage.plugins.observability import EvidenceResources, TelemetryQueries
from meridian_storage.runtime import RuntimeConfig
from meridian_storage.spi import SecretValue

from mapping_layout import ROOT, render


def legacy_migration_negative(client, mode, state, settings):
    database = "legacy_" + mode
    client.command("CREATE DATABASE " + database)
    legacy = tuple(
        SchemaCompilation(
            replace(c.layout, append_only=False),
            metadata_table_ddl(database, c.layout.topology),
            create_table_ddl(database, replace(c.layout, append_only=False)),
        )
        for c in state[0]
    )
    old_settings = replace(
        settings, database=database, layouts={c.layout.resource.canonical: c.layout for c in legacy}
    )
    ClickHouseMigrator(client, old_settings).apply(plan_initial_migration("legacy-" + mode, legacy))
    selected = json.loads((ROOT / (mode + "-input.json")).read_text())
    selected["database"] = database
    selected["layouts"] = {c.layout.record_profile.value: c.layout.to_dict() for c in legacy}
    plan = render({"input": selected})
    assert plan["layouts"] == selected["layouts"]
    assert all("appendOnly" not in c.layout.to_dict() for c in legacy)
    assert all(ResourceLayout.from_mapping(x).to_dict() == x for x in plan["layouts"].values())
    old_rows = client.query(
        "SELECT resource_ref,layout_fingerprint FROM "
        + database
        + "._meridian_resources FINAL ORDER BY resource_ref"
    ).result_rows
    upgraded = tuple(
        SchemaCompilation(
            c.layout,
            metadata_table_ddl(database, c.layout.topology),
            create_table_ddl(database, c.layout),
        )
        for c in state[0]
    )
    try:
        ClickHouseMigrator(client, replace(settings, database=database)).apply(
            plan_initial_migration("invalid-upgrade-" + mode, upgraded)
        )
    except Exception as error:
        assert "sorting key" in str(error).lower(), str(error)
        failure = type(error).__name__
    else:
        raise AssertionError("an old sorting key was relabeled append-only")
    assert (
        client.query(
            "SELECT resource_ref,layout_fingerprint FROM "
            + database
            + "._meridian_resources FINAL ORDER BY resource_ref"
        ).result_rows
        == old_rows
    )
    return {
        "mode": mode,
        "legacyPlanPreservesFullLayouts": True,
        "legacyFingerprintsUnchanged": True,
        "inPlaceRelabelRejected": failure,
    }


def core_append(client, mode, state, runtime, settings, ca, wait):
    source = json.loads((ROOT / (mode + "-public-records.json")).read_text())["log"][0]
    records = []
    for number in (9007199254740992, 9007199254740993):
        record = {
            k: v
            for k, v in copy.deepcopy(source).items()
            if not (k in ("traceId", "spanId", "parentSpanId") and v is None)
        }
        record.update(
            evidenceId="core-append-" + mode,
            eventTime="2026-09-08T16:56:00.123456789Z",
            observedTime="2026-09-08T16:56:00.123456790Z",
            body={"large": number, "boolean": True, "string": "true"},
            attributes={"integer": number, "text": str(number)},
            extensions={},
        )
        records.append(record)
    resource = state[0][0].layout.resource
    context = OperationContext(
        "test:core-append", tenant="tenant-a", scope={"service": "collector-feasibility"}
    )
    with runtime.context(context):
        for i, record in enumerate(records):
            runtime.execute(
                runtime.catalog("evidence").append(
                    resource=resource, data=record, idempotency_key=f"core-{mode}-{i}"
                )
            )
    # Retry in a newly started public runtime to exclude in-memory result caching.
    bundle = state[1]

    class Provider:
        provider_id = bundle.provider_id
        provider_contract_version = bundle.provider_contract_version

        def load(self):
            return bundle

    class Secrets:
        def resolve(self, ref):
            return SecretValue(
                ca.read_bytes()
                if ref.reference == "ca"
                else b"meridian"
                if ref.reference == "username"
                else b"meridian-test"
            )

    retry = Meridian(
        RuntimeConfig.from_mapping(
            json.loads((ROOT / (mode + "-runtime-config.json")).read_text())
        ),
        schema_providers=[Provider()],
        secret_resolver=Secrets(),
    )
    try:
        retry.start()
        with retry.context(context):
            for i, record in enumerate(records):
                retry.execute(
                    retry.catalog("evidence").append(
                        resource=resource, data=record, idempotency_key=f"core-{mode}-{i}"
                    )
                )
        client.command(
            "OPTIMIZE TABLE " + state[0][0].layout.qualified_table(settings.database) + " FINAL"
        )
        verify_core_append(mode, state, retry)
    finally:
        retry.close()
    return {
        "mode": mode,
        "generatedConfigCoreAppend": True,
        "sameIdentityDistinctContent": 2,
        "freshRuntimeRetryDeduplicated": True,
        "typedNanosecondsPreserved": True,
    }


def verify_core_append(mode, state, runtime):
    query = TelemetryQueries(runtime, EvidenceResources(*(c.layout.resource for c in state[0])))
    start = datetime(2026, 9, 8, 16, 56, tzinfo=timezone.utc)
    with runtime.context(
        OperationContext(
            "test:core-read", tenant="tenant-a", scope={"service": "collector-feasibility"}
        )
    ):
        records = (
            query.logs(start=start, end=start + timedelta(seconds=1))
            .page(limit=100)
            .execute()
            .items
        )
    assert len(records) == 2
    assert {r["body"]["large"] for r in records} == {9007199254740992, 9007199254740993}
    assert all(
        r["evidenceId"] == "core-append-" + mode
        and r["observedTime"] == "2026-09-08T16:56:00.123456790Z"
        and r["body"]["boolean"] is True
        and r["body"]["string"] == "true"
        for r in records
    )
