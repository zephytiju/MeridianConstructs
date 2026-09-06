# SPDX-License-Identifier: Apache-2.0
"""Caller-owned POSIX host template over exact released Meridian packages.

Copy beside the application entrypoint in its digest-pinned image. The application
supplies schema providers, a secret resolver, logical context and a pure projector.
Run the entrypoint under supervisor.py. No migration or driver SQL is executed here.
"""

from __future__ import annotations

import hashlib
import json
import signal
from dataclasses import asdict
from importlib.metadata import version
from threading import Event
from uuid import uuid4

from meridian_storage import Meridian, ResourceRef
from meridian_storage.adapters.postgresql import PostgreSQLAdapterFactory, PostgreSQLOutbox
from meridian_storage.projection import ProjectionRunner, ProjectionSpec
from meridian_storage.runtime.config import RuntimeConfig
from meridian_storage.spi.adapters import AdapterCreateContext

EXPECTED_PACKAGES = {
    "meridian-storage-core": "1.0.1",
    "meridian-storage-semantics": "2.0.0",
    "meridian-storage-query": "1.0.2",
    "meridian-storage-projection": "1.0.2",
    "meridian-storage-postgresql": "2.1.0",
}


def fingerprint(value):
    return (
        "sha256:"
        + hashlib.sha256(
            json.dumps(
                value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False
            ).encode()
        ).hexdigest()
    )


def cycle_budget(b):
    required = {
        "claim",
        "load",
        "project",
        "target",
        "acknowledge",
        "complete",
        "release",
        "lag",
        "evidence",
    }
    if set(b["calls"]) != required:
        raise ValueError("incomplete call budgets")
    numbers = [
        b[k]
        for k in (
            "batchSize",
            "poisonThreshold",
            "overheadMs",
            "drainMs",
            "leaseMs",
            "leaseMarginMs",
            "terminationGraceMs",
        )
    ]
    if any(type(n) is not int or n < 1 for n in [*numbers, *b["calls"].values()]):
        raise ValueError("finite positive integer budgets required")
    if (
        b["batchSize"] > 1000
        or b["poisonThreshold"] > 100
        or type(b["pollIntervalMs"]) is not int
        or b["pollIntervalMs"] < 0
    ):
        raise ValueError("unbounded batch, retry or polling policy")
    c = b["calls"]
    result = (
        c["claim"]
        + b["batchSize"]
        * (
            sum(c[k] for k in ("load", "project", "target", "acknowledge", "complete", "release"))
            + 2 * c["evidence"]
        )
        + c["lag"]
        + c["evidence"]
        + b["overheadMs"]
    )
    if (
        result != b["cycleBudgetMs"]
        or result > b["drainMs"]
        or result + b["leaseMarginMs"] > b["leaseMs"]
        or b["terminationGraceMs"] < b["drainMs"] + 1000
    ):
        raise ValueError("full cycle exceeds drain or lease allowance")
    return result


def validate_job(job):
    body = {k: v for k, v in job.items() if k != "specFingerprint"}
    if fingerprint(body) != job["specFingerprint"]:
        raise ValueError("job fingerprint mismatch")
    op = job["operation"]
    config = job["extensions"]["runtimeConfig"]
    if (
        op["contract"] != "meridian.projection.worker"
        or op["targetProfile"] != "version-addressed-integer-v1"
        or op["readPolicy"] != "latest-before-tombstone-and-business-filters"
        or op["retentionPolicy"] != "retain-versions-including-latest-tombstones"
        or fingerprint(config) != op["configFingerprint"]
        or not job["dependsOn"]
    ):
        raise ValueError("projection configuration mismatch")
    cycle_budget(op["budgets"])
    if op["packages"] != EXPECTED_PACKAGES:
        raise ValueError("unsupported released projection package set")
    for name, expected in EXPECTED_PACKAGES.items():
        if version(name) != expected:
            raise ValueError("installed projection package mismatch")
    return op, config


class ProjectionWorker:
    """Deployment host, not a new OutboxPort factory or library worker service."""

    def __init__(self, job, *, schema_providers, secret_resolver, context):
        self.op, config = validate_job(job)
        self.budgets = self.op["budgets"]
        self.context = context
        self.stop = Event()
        self.config = RuntimeConfig.from_mapping(config)
        self.meridian = Meridian(
            self.config, schema_providers=schema_providers, secret_resolver=secret_resolver
        )
        self.runtime = None
        try:
            self.meridian.start()  # authenticated, fingerprint-checked, read-only startup
            snapshot = self.meridian._snapshot_for_handle()
            refs = {
                role: ResourceRef.parse(self.op[role]) for role in ("source", "outbox", "target")
            }
            selected = {role: snapshot.binding_for(ref) for role, ref in refs.items()}
            if (
                selected["source"].binding_id != selected["outbox"].binding_id
                or selected["source"].binding_id != self.op["sourceBindingId"]
                or selected["target"].binding_id != self.op["targetBindingId"]
                or any(binding.adapter_id != "postgresql" for binding in selected.values())
            ):
                raise ValueError("projection placement mismatch")
            target_resource = snapshot.resource(refs["target"])
            target_schema = snapshot.schema(
                target_resource.schema.catalog,
                target_resource.schema.namespace,
                target_resource.schema.name,
                target_resource.schema.version,
            )
            fields = {f["name"]: f["logicalType"] for f in target_schema.definition["fields"]}
            if tuple(target_schema.definition["identity"]) != ("id",) or any(
                fields.get(k) != v
                for k, v in {
                    "id": "string",
                    "sourceKey": "string",
                    "sourceVersion": "int64",
                    "deleted": "boolean",
                    "document": "json",
                }.items()
            ):
                raise ValueError("version-addressed target Schema required")
            binding = next(b for b in self.config.bindings if b.id == selected["source"].binding_id)
            self.runtime = PostgreSQLAdapterFactory().create(
                AdapterCreateContext(
                    binding=binding,
                    identity=secret_resolver.resolve(binding.identity_ref),
                    credential=secret_resolver.resolve(binding.secret_ref),
                )
            )
            self.runtime.open()
            self.spec = ProjectionSpec(
                name=self.op["name"],
                source_catalog="structured",
                target_catalog="structured",
                source=refs["source"].logical_name,
                target=refs["target"].logical_name,
                source_schema=self.op["sourceSchema"],
                target_schema=self.op["targetSchema"],
            )
            self.port = PostgreSQLOutbox(
                self.runtime,
                resource=refs["outbox"].logical_name,
                spec=self.spec,
                context=context,
                poison_threshold=self.budgets["poisonThreshold"],
                max_batch_size=self.budgets["batchSize"],
            )
        except BaseException:
            self.close()
            raise

    def call(self, category, function, *args, **kwargs):
        # Fail the process on a broken admission bound; do not turn timeout into
        # an acknowledgement, checkpoint, or deterministic poison classification.
        def expired(signum, frame):
            raise SystemExit(71)

        previous = signal.signal(signal.SIGALRM, expired)
        signal.setitimer(signal.ITIMER_REAL, self.budgets["calls"][category] / 1000)
        try:
            return function(*args, **kwargs)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous)

    def emit(self, state, **numbers):
        # All fields are host-defined numeric observations; no payload, IDs,
        # exception messages, principals, endpoints or secret values are logged.
        self.call("evidence", print, json.dumps({"state": state, **numbers}), flush=True)

    def run(self, project, *, source_loader=None):
        host = self
        previous_stop = {
            sig: signal.signal(sig, lambda *_: host.stop.set())
            for sig in (signal.SIGTERM, signal.SIGINT)
        }

        class Outbox:
            def atomic_claim(self, **kw):
                lag = host.call("lag", host.port.lag)
                host.emit("lag", incomplete=lag.incomplete_count, seconds=lag.lag_seconds)
                return host.call("claim", host.port.atomic_claim, **kw)

            def complete(self, *args, **kw):
                return host.call("complete", host.port.complete, *args, **kw)

            def release(self, *args, **kw):
                return host.call("release", host.port.release, *args, **kw)

            def lag(self, **kw):
                return host.call("lag", host.port.lag, **kw)

        class Facade:
            def __getattr__(self, name):
                return getattr(host.meridian, name)

            def execute(self, expression):
                return host.call("target", host.meridian.execute, expression)

        class Evidence:
            def record(self, event):
                host.emit(event.state)

        def acknowledge(result, source):
            acknowledged = result.data.get("sourceVersion")
            if type(acknowledged) is not int or acknowledged != source.source_version:
                raise ValueError("exact integer source acknowledgement required")
            return acknowledged, result.operation_fingerprint

        def guarded_project(source, context):
            expression = host.call("project", project, source, context)
            data = expression.arguments.get("data", {})
            if (
                expression.method != "put"
                or expression.arguments.get("mode") != "upsert"
                or type(context.source_version) is not int
                or data.get("sourceVersion") != context.source_version
                or type(data.get("deleted")) is not bool
            ):
                raise ValueError("version-addressed upsert required")
            scope = {"tenant": host.context.tenant, **dict(host.context.scope)}
            # The sample's identity is deployment scoped and version addressed.
            source_key = fingerprint(
                [
                    context.projection,
                    scope,
                    context.source_catalog,
                    context.source_resource,
                    context.source_identity,
                ]
            )[7:]
            if (
                data.get("sourceKey") != source_key
                or data.get("id") != fingerprint([source_key, context.source_version])[7:]
            ):
                raise ValueError("version-addressed target identity mismatch")
            if context.mutation_kind == "delete" and not data["deleted"]:
                raise ValueError("deletion must retain a versioned tombstone")
            return expression

        try:
            runner = ProjectionRunner(
                meridian=Facade(),
                spec=self.spec,
                project=guarded_project,
                acknowledgement=lambda *args: host.call("acknowledge", acknowledge, *args),
                source_loader=(lambda *args: host.call("load", source_loader, *args))
                if source_loader
                else None,
                outbox=Outbox(),
                evidence=Evidence(),
                batch_size=self.budgets["batchSize"],
                lease_seconds=self.budgets["leaseMs"] / 1000,
                worker_id="host-" + uuid4().hex,
            )
            with self.meridian.context(self.context):
                result = runner.run_until_stopped(
                    self.stop, poll_interval_seconds=self.budgets["pollIntervalMs"] / 1000
                )
            self.emit("drained", **asdict(result))
            return result
        finally:
            for sig, handler in previous_stop.items():
                signal.signal(sig, handler)

    def close(self):
        if self.runtime is not None:
            self.runtime.close()
        self.meridian.close()
