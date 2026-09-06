# SPDX-License-Identifier: Apache-2.0
"""Real PostgreSQL and actual processes, using only packaged host/runtime files."""

import importlib.util
import inspect
import json
import os
import selectors
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest
from conftest import ctx, intent
from meridian_storage.adapters.postgresql.descriptor import manifest
from meridian_storage.projection import TransactionalOutboxWriter

PINS = {
    "meridian-storage-core": "1.0.1",
    "meridian-storage-semantics": "2.0.0",
    "meridian-storage-query": "1.0.2",
    "meridian-storage-projection": "1.0.2",
    "meridian-storage-postgresql": "2.1.0",
}
HERE = Path(__file__).parent


def write(h, identity="case", number=1, deleted=False):
    payload = {"id": identity, "name": str(number), "deleted": deleted}
    data = intent(
        f"{identity}-v{number}", source_identity=identity, source_version=number, payload=payload
    )
    with h.meridian.context(ctx()):
        TransactionalOutboxWriter(h.meridian, outbox_resource="example.outbox").commit(
            h.meridian.catalog("structured").put(
                resource="example.source",
                data=payload,
                mode="if_absent" if number == 1 else "update",
            ),
            data,
        )
    return data


def rows(h):
    with h.meridian.context(ctx()):
        data, cursor = [], None
        while True:
            page = h.meridian.execute(
                h.meridian.catalog("structured").query(
                    resource="example.target", limit=1, cursor=cursor
                )
            ).data
            data.extend(page["items"])
            cursor = page["cursor"]
            if not cursor:
                return data


def job(h, tmp_path, batch=1, mutate=None):
    config = json.loads(json.dumps(h.child_config["config"]))
    b = config["bindings"][0]
    args = {
        "image": "ghcr.io/example/owned-host@sha256:" + "d" * 64,
        "runtimeConfig": config,
        "packages": dict(PINS),
        "name": h.spec.name,
        "source": {"catalog": "structured", "namespace": "example", "name": "source"},
        "outbox": {"catalog": "structured", "namespace": "example", "name": "outbox"},
        "target": {"catalog": "structured", "namespace": "example", "name": "target"},
        "sourceSchema": h.spec.source_schema,
        "targetSchema": h.spec.target_schema,
        "projectionFingerprint": "sha256:" + "a" * 64,
        "manifests": {b["id"]: manifest(b["engineProfile"], b["engineVersion"]).to_dict()},
        "budgets": {
            "batchSize": batch,
            "poisonThreshold": 2,
            "pollIntervalMs": 10,
            "calls": {
                "claim": 1000,
                "load": 50,
                "project": 500,
                "target": 1000,
                "acknowledge": 50,
                "complete": 1000,
                "release": 1000,
                "lag": 1000,
                "evidence": 50,
            },
            "overheadMs": 250,
            "drainMs": 12000,
            "leaseMs": 14000,
            "leaseMarginMs": 1000,
            "terminationGraceMs": 14000,
        },
        "dependsOn": ["explicit-test-migration"],
    }
    if mutate:
        mutate(args)
    result = subprocess.run(
        ["node", "--import", "tsx", str(HERE / "render-job.ts")],
        input=json.dumps({"args": args, "assets": str(tmp_path / "assets")}),
        text=True,
        capture_output=True,
    )
    if result.returncode:
        raise ValueError(result.stderr)
    result = json.loads(result.stdout)
    path = tmp_path / "job.json"
    path.write_text(json.dumps(result))
    return result, path


def child(h, tmp_path, phase, batch=1):
    spec, path = job(h, tmp_path, batch)
    assets = tmp_path / "assets"
    p = subprocess.Popen(
        [
            sys.executable,
            "-I",
            str(assets / "supervisor.py"),
            str(path),
            "--",
            sys.executable,
            "-I",
            str(HERE / "application.py"),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env={**os.environ, "PROJECTION_ASSETS": str(assets)},
    )
    p.stdin.write(json.dumps({**h.child_config, "job": spec, "phase": phase}))
    p.stdin.close()
    p.stdin = None
    return p


def finish(p, code=0):
    try:
        out, err = p.communicate(timeout=35)
        assert p.returncode == code, (out, err)
        assert "SENSITIVE_PAYLOAD" not in out + err
        return [json.loads(line) for line in out.splitlines()]
    finally:
        if p.poll() is None:
            p.kill()
            p.wait(timeout=5)


def expire(h, event):
    remaining = (
        h.port().get(event.event_id).lease.expires_at
        - __import__("datetime").datetime.now(__import__("datetime").UTC)
    ).total_seconds()
    if remaining > 0:
        time.sleep(remaining + 0.05)


def test_installed_artifacts():
    from importlib.metadata import version
    from meridian_storage.adapters.postgresql import PostgreSQLOutbox
    from meridian_storage.projection import ProjectionRunner

    assert {n: version(n) for n in PINS} == PINS
    for cls in (PostgreSQLOutbox, ProjectionRunner, TransactionalOutboxWriter):
        assert "site-packages" in Path(inspect.getfile(cls)).parts
    assert "node_modules" in Path(os.environ["CONSTRUCTS_MODULE"]).parts


@pytest.mark.parametrize(
    "phase,code,target",
    [("after-claim", 91, False), ("after-target", 92, True), ("before-checkpoint", 93, True)],
)
def test_actual_host_restart_boundaries(durable, tmp_path, phase, code, target):
    data = write(durable)
    finish(child(durable, tmp_path, phase), code)
    assert bool(rows(durable)) is target
    assert durable.port().checkpoint(data.partition_key).revision == 0
    assert durable.port().get(data.event_id).data == data
    expire(durable, data)
    logs = finish(child(durable, tmp_path, "recover"))
    assert any(log.get("completed") == 1 for log in logs)
    assert durable.port().get(data.event_id).attempt_count == 2
    assert durable.port().checkpoint(data.partition_key).source_version == 1


def test_graceful_stop_settles_only_the_admitted_batch(durable, tmp_path):
    data = [write(durable, identity=i) for i in ("a", "b", "c")]
    p = child(durable, tmp_path, "graceful", batch=2)
    # read one line at a time using select and unbuffered fd to avoid TextIO prefetch
    seen = b""
    with selectors.DefaultSelector() as ready:
        ready.register(p.stdout, selectors.EVENT_READ)
        while b'"state": "entered"' not in seen:
            assert ready.select(20), "worker did not enter admitted batch"
            chunk = os.read(p.stdout.fileno(), 4096)
            assert chunk, p.stderr.read()
            seen += chunk
    start = time.monotonic()
    p.send_signal(signal.SIGTERM)
    logs = finish(p)
    assert time.monotonic() - start < 12
    assert any(log.get("completed") == 2 and log.get("claimed") == 2 for log in logs)
    assert any(log.get("graceful") is True for log in logs)
    states = [durable.port().get(d.event_id).state.value for d in data]
    assert states.count("COMPLETED") == 2 and states.count("PENDING") == 1


def test_failed_drain_is_killed_without_fabricated_progress(durable, tmp_path):
    data = write(durable)
    p = child(durable, tmp_path, "stuck")
    seen = b""
    with selectors.DefaultSelector() as ready:
        ready.register(p.stdout, selectors.EVENT_READ)
        while b'"state": "entered"' not in seen:
            assert ready.select(20)
            chunk = os.read(p.stdout.fileno(), 4096)
            assert chunk, p.stderr.read()
            seen += chunk
    p.send_signal(signal.SIGTERM)
    logs = finish(p, 70)
    assert {"state": "failed-drain", "graceful": False, "terminated": True} in logs
    assert not rows(durable)
    assert durable.port().checkpoint(data.partition_key).revision == 0
    assert durable.port().get(data.event_id).state.value == "LEASED"
    expire(durable, data)
    finish(child(durable, tmp_path, "recover"))
    assert durable.port().get(data.event_id).attempt_count == 2


def test_source_rollback_has_no_intent(durable):
    data = intent(
        "mismatched-intent",
        source_identity="case",
        source_version=99,
        payload={"id": "case", "name": "first", "deleted": False},
    )
    with durable.meridian.context(ctx()):
        with pytest.raises(Exception, match="version"):
            TransactionalOutboxWriter(durable.meridian, outbox_resource="example.outbox").commit(
                durable.meridian.catalog("structured").put(
                    resource="example.source",
                    data={"id": "case", "name": "first", "deleted": False},
                    mode="if_absent",
                ),
                data,
            )
    from meridian_storage.errors import NotFoundError

    with pytest.raises(NotFoundError):
        durable.port().get(data.event_id)
    assert durable.port().lag().incomplete_count == 0


def test_redacted_lag_retry_quarantine(durable, tmp_path):
    data = write(durable)
    logs = finish(child(durable, tmp_path, "poison"))
    assert any(log["state"] == "lag" and log["incomplete"] == 1 for log in logs)
    assert any(log["state"] == "QUARANTINED" for log in logs)
    assert durable.port().checkpoint(data.partition_key).revision == 0


def test_retry_budget_persists_and_quarantines(durable, tmp_path):
    data = write(durable)
    logs = finish(child(durable, tmp_path, "retry"))
    assert any(log["state"] == "RETRYABLE" for log in logs)
    assert durable.port().get(data.event_id).attempt_count == 1
    logs = finish(child(durable, tmp_path, "retry"))
    assert any(log["state"] == "QUARANTINED" for log in logs)
    assert durable.port().get(data.event_id).attempt_count == 2
    assert durable.port().checkpoint(data.partition_key).revision == 0


def test_versioned_replay_preserves_newer_rows_and_latest_tombstones(durable, tmp_path):
    from meridian_storage.projection import ProjectionContext

    first = write(durable)
    finish(child(durable, tmp_path, "after-target"), 92)
    module_spec = importlib.util.spec_from_file_location(
        "packaged_example", tmp_path / "assets/versioned_target.py"
    )
    example = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(example)
    project = example.make_projector(
        durable.meridian, target="example.target", scope={"tenant": "a", "workspace": "a"}
    )

    def project_data(data):
        context = ProjectionContext(
            durable.spec.name,
            data.event_id,
            data.source_catalog,
            data.source_resource,
            data.source_schema,
            data.source_identity,
            data.source_version,
            data.mutation_kind,
            data.occurred_at,
            data.operation_context,
        )
        with durable.meridian.context(ctx()):
            return durable.meridian.execute(project(data.payload, context)).data

    second = write(durable, number=2)
    newer = project_data(second)
    expire(durable, first)
    finish(child(durable, tmp_path, "recover"))
    assert durable.port().checkpoint(first.partition_key).source_version == 1
    current = rows(durable)
    assert sorted(row["sourceVersion"] for row in current) == [1, 2]
    assert next(row for row in current if row["sourceVersion"] == 2) == newer
    assert example.latest_visible(current)[0]["sourceVersion"] == 2
    assert example.latest_visible(current, matches=lambda row: row["document"]["name"] == "1") == []
    finish(child(durable, tmp_path, "recover"))
    tombstone = write(durable, number=3, deleted=True)
    finish(child(durable, tmp_path, "recover"))
    assert project_data(first)["sourceVersion"] == 1
    assert len(rows(durable)) == 3
    assert example.latest_visible(rows(durable)) == []
    assert durable.port().checkpoint(tombstone.partition_key).source_version == 3


def test_invalid_placement_and_manifest_fail_before_claim(durable, tmp_path):
    data = write(durable)
    for mutate in [
        lambda a: a["manifests"].clear(),
        lambda a: a["runtimeConfig"]["placements"].clear(),
        lambda a: a["packages"].update({"meridian-storage-postgresql": "1.0.0"}),
    ]:
        with pytest.raises(ValueError):
            job(durable, tmp_path, mutate=mutate)
    assert durable.port().get(data.event_id).attempt_count == 0
