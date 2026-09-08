# SPDX-License-Identifier: Apache-2.0
"""Faults and public read negatives for the same generated ingestion chain."""

import copy
import json
from datetime import datetime, timedelta, timezone

from meridian_storage import Meridian, OperationContext
from meridian_storage.plugins.observability import EvidenceResources, TelemetryQueries
from meridian_storage.runtime import RuntimeConfig
from meridian_storage.spi import SecretValue

from fixtures import PAYLOADS, attr
from mapping_layout import inspect_records, render


def identities(client, state, settings):
    return {
        c.layout.record_profile.value: client.query(
            "SELECT _meridian_scope_fingerprint,_meridian_batch_id,_meridian_row_fingerprint "
            "FROM "
            + c.layout.qualified_table(settings.database)
            + " FINAL ORDER BY _meridian_row_fingerprint"
        ).result_rows
        for c in state[0]
    }


def reorder(value):
    if isinstance(value, dict):
        return {k: reorder(v) for k, v in reversed(list(value.items()))}
    if isinstance(value, list):
        result = [reorder(v) for v in value]
        return (
            list(reversed(result))
            if all(isinstance(v, dict) and "key" in v for v in value)
            else result
        )
    return value


def invalid_payloads():
    cases = []

    def add(name, signal, source, mutate):
        body = copy.deepcopy(PAYLOADS[source])
        mutate(body)
        cases.append((name, signal, body))

    def log(p):
        return p["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]

    def span(p):
        return p["resourceSpans"][0]["scopeSpans"][0]["spans"][0]

    def metric(p):
        return p["resourceMetrics"][0]["scopeMetrics"][0]["metrics"][0]

    add(
        "nested-link-scope",
        "traces",
        "traces",
        lambda p: span(p)["links"][0]["attributes"].append(
            attr("meridian.scope.service", "stringValue", "spoof")
        ),
    )
    add(
        "histogram-nonfinite",
        "metrics",
        "histograms",
        lambda p: metric(p)["histogram"]["dataPoints"][0].update(min="NaN"),
    )
    add("missing-span-name", "traces", "traces", lambda p: span(p).pop("name"))
    add("span-reversed-time", "traces", "traces", lambda p: span(p).update(endTimeUnixNano="1"))
    add(
        "missing-number-value",
        "metrics",
        "metrics",
        lambda p: metric(p)["gauge"]["dataPoints"][0].pop("asInt"),
    )
    add(
        "attributes-over-limit",
        "logs",
        "logs",
        lambda p: log(p).update(
            attributes=[attr("k" + str(i), "intValue", str(i)) for i in range(129)]
        ),
    )
    add(
        "attribute-control-key",
        "logs",
        "logs",
        lambda p: log(p)["attributes"].append(attr("bad\nkey", "stringValue", "value")),
    )
    add("span-name-over-v1-limit", "traces", "traces", lambda p: span(p).update(name="x" * 257))
    add(
        "metric-unit-over-v1-limit",
        "metrics",
        "metrics",
        lambda p: metric(p).update(unit="x" * 257),
    )
    add("severity-over-v1-limit", "logs", "logs", lambda p: log(p).update(severityText="x" * 33))
    nested = {"stringValue": "too-deep"}
    for _ in range(13):
        nested = {"arrayValue": {"values": [nested]}}
    add("any-value-depth", "logs", "logs", lambda p: log(p).update(body=nested))
    add(
        "envelope-over-budget",
        "logs",
        "logs",
        lambda p: log(p).update(body={"stringValue": "x" * 40000}),
    )
    add(
        "unsupported-summary",
        "metrics",
        "metrics",
        lambda p: metric(p).update(
            gauge=None,
            summary={
                "dataPoints": [{"timeUnixNano": "1788886500123456789", "count": "1", "sum": 1.0}]
            },
        ),
    )
    cases.extend([("unknown-signal", "invalid", PAYLOADS["logs"])])
    return cases


def retry_and_negatives(send, client, states, runtimes, settings, root, wait):
    report = []
    for i, mode in enumerate(states):
        before = identities(client, states[mode], settings[mode])
        retry_time = client.command("SELECT toUnixTimestamp64Nano(now64(9))")
        for source in ("logs", "traces", "metrics", "histograms", "additional"):
            signal = "metrics" if source in ("histograms", "additional") else source

            def resend():
                response = send(mode, signal, reorder(PAYLOADS[source]))
                assert response["status"] in (200, 503), response
                return response if response["status"] == 200 else None

            wait("canonical resend " + mode + " " + source, resend, 90)
        # Force a synchronous backend query after queue drain and verify the
        # public query identity, including typed source metadata, is unchanged.
        wait(
            "canonical retry drain " + mode,
            lambda: all(
                client.command(
                    "SELECT min(toUnixTimestamp64Nano(_meridian_ingested_at)) FROM "
                    + c.layout.qualified_table(settings[mode].database)
                    + " FINAL"
                )
                >= retry_time
                for c in states[mode][0]
            ),
            90,
        )
        assert identities(client, states[mode], settings[mode]) == before
        reads = inspect_records(client, mode, states[mode], runtimes[i], settings[mode])
        negatives = []
        malformed = send(mode, "logs", "{invalid-json", raw=True)
        assert malformed["status"] == 400, malformed
        negatives.append({"case": "malformed-json", "response": malformed})
        # The OTLP receiver treats an empty valid ExportRequest as a no-op.
        assert send(mode, "logs", {})["status"] == 200
        for name, signal, body in invalid_payloads():
            response = send(mode, signal, body)
            assert response["status"] >= 400 and response["status"] != 503, (name, response)
            negatives.append({"case": name, "response": response})
        assert identities(client, states[mode], settings[mode]) == before
        report.append(
            {
                "mode": mode,
                "canonicalRetryUnchanged": True,
                "publicReadsAfterRetry": reads,
                "rejectedBeforeAcknowledgement": negatives,
            }
        )
    return report


def no_change_and_pins(client, states, runtimes, settings, root, ca):
    report = []
    for i, mode in enumerate(states):
        state = states[mode]
        bundle = state[1]
        original = state[2]
        assert (
            render({"input": json.loads((root / (mode + "-input.json")).read_text())}) == original
        )
        before = identities(client, state, settings[mode])

        def ddl():
            return client.query(
                "SELECT name,create_table_query FROM system.tables WHERE database='native_"
                + mode
                + "' ORDER BY name"
            ).result_rows

        definitions = ddl()
        for statement in original["migration"]["statements"]:
            client.command(
                statement,
                settings={"allow_simdjson": 0, "short_circuit_function_evaluation": "force_enable"},
            )
        assert ddl() == definitions and identities(client, state, settings[mode]) == before

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

        failures = []
        for target in ("provider", "resource", "capability", "physical", "schema"):
            config = json.loads((root / (mode + "-runtime-config.json")).read_text())
            bad = "sha256:" + "0" * 64
            if target == "provider":
                config["schemas"]["providers"][0]["requiredFingerprint"] = bad
            elif target == "resource":
                config["resources"]["pins"][0]["requiredFingerprint"] = bad
            elif target == "schema":
                layout = config["bindings"][0]["settings"]["layouts"][0]
                layout["schemaFingerprint"] = bad
                # Correct content identity with the wrong registered Schema pin.
                import hashlib
                from meridian_storage.semantics import canonical_json_bytes

                layout.pop("layoutFingerprint")
                layout["layoutFingerprint"] = (
                    "sha256:" + hashlib.sha256(canonical_json_bytes(layout)).hexdigest()
                )
            else:
                config["bindings"][0]["required" + target.capitalize() + "Fingerprint"] = bad
            runtime = None
            try:
                runtime = Meridian(
                    RuntimeConfig.from_mapping(config),
                    schema_providers=[Provider()],
                    secret_resolver=Secrets(),
                )
                runtime.start()
            except Exception as exc:
                failures.append({"pin": target, "failure": type(exc).__name__})
            else:
                raise AssertionError("invalid " + target + " pin accepted")
            finally:
                if runtime:
                    runtime.close()
        resources = EvidenceResources(*(c.layout.resource for c in state[0]))
        queries = TelemetryQueries(runtimes[i], resources)
        start = datetime(2026, 9, 8, 16, 55, tzinfo=timezone.utc)
        end = start + timedelta(seconds=1)
        for tenant, scope in [
            ("tenant-b", {"service": "collector-feasibility"}),
            ("tenant-a", {"service": "other"}),
        ]:
            with runtimes[i].context(
                OperationContext("test:scope-negative", tenant=tenant, scope=scope)
            ):
                assert not queries.logs(start=start, end=end).execute().items
                assert not queries.spans(start=start, end=end).execute().items
                assert not queries.metric_series("numbers", start=start, end=end).execute().items
        assert ddl() == definitions
        report.append(
            {
                "mode": mode,
                "renderAndExplicitMigrationUnchanged": True,
                "startupDidNotRunDdl": True,
                "rejectedPins": failures,
                "crossScopeReadsEmpty": True,
            }
        )
    return report


def durability(send, client, states, runtimes, settings, command, run, ready, wait):
    report = []
    for index, mode in enumerate(states):
        run(command + ["stop", "-t", "2", "backend"])
        accepted = []
        rejected = []
        responses = []
        for i in range(12):
            body = copy.deepcopy(PAYLOADS["traces"])
            name = f"durability-{mode}-{i}"
            body["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["name"] = name
            response = send(mode, "traces", body)
            responses.append(response)
            assert response["status"] in (200, 503), response
            (accepted if response["status"] == 200 else rejected).append(name)
        assert accepted and rejected
        run(command + ["kill", "-s", "SIGKILL", mode])
        run(command + ["start", "backend"])
        wait("backend recovery", ready)
        run(command + ["start", mode])
        resources = EvidenceResources(*(c.layout.resource for c in states[mode][0]))
        queries = TelemetryQueries(runtimes[index], resources)
        start = datetime(2026, 9, 8, 16, 55, tzinfo=timezone.utc)
        end = start + timedelta(seconds=1)

        def read():
            with runtimes[index].context(
                OperationContext(
                    "test:durability", tenant="tenant-a", scope={"service": "collector-feasibility"}
                )
            ):
                rows = queries.spans(start=start, end=end).page(limit=100).execute().items
            names = [r["name"] for r in rows if r["name"].startswith("durability-")]
            return names if set(accepted).issubset(names) else None

        names = wait("public durable recovery " + mode, read, 90)
        assert not set(rejected).intersection(names)
        report.append(
            {
                "mode": mode,
                "acknowledged": accepted,
                "rejected503": rejected,
                "recoveredPublicNames": names,
                "responses": responses,
                "allAcknowledgedSurvivedSIGKILL": True,
            }
        )
    return report


def canonical_float_contract(client, state):
    """Compare stock SQL's shortest float form to the public Python contract."""
    import math
    import random
    import struct
    from meridian_storage.semantics import canonical_json_bytes

    randomizer = random.Random(656)
    values = [
        0.0,
        -0.0,
        5e-324,
        -5e-324,
        1.0,
        1e-4,
        1e-5,
        1e15,
        1e16,
        1e20,
        1.7976931348623157e308,
        -1.7976931348623157e308,
    ]
    while len(values) < 10012:
        value = struct.unpack(">d", randomizer.getrandbits(64).to_bytes(8, "big"))[0]
        if math.isfinite(value):
            values.append(value)
    helper = state[2]["migration"]["stagingTable"].removesuffix("_ingress") + "_float"
    for start in range(0, len(values), 200):
        group = values[start : start + 200]
        bits = [str(int.from_bytes(struct.pack(">d", v), "big")) for v in group]
        sql = (
            "SELECT "
            + helper
            + "(reinterpretAsFloat64(bit)) FROM (SELECT arrayJoin(["
            + ",".join("toUInt64(" + v + ")" for v in bits)
            + "]) AS bit)"
        )
        actual = [row[0] for row in client.query(sql).result_rows]
        assert actual == [canonical_json_bytes(v).decode() for v in group]
    return {"finiteFloat64Values": len(values), "publicCanonicalBytesEqual": True}
