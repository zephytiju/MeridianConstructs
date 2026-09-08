# SPDX-License-Identifier: Apache-2.0
"""Required composition over installed host templates and real PostgreSQL sessions."""

import importlib.util
import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
import subprocess
from uuid import uuid4

import pytest
from conftest import ctx, intent
from test_projection_jobs import EVIDENCE_VERSION, job, write

from meridian_storage.errors import NotFoundError
from meridian_storage import MeridianError
from meridian_storage.projection import TransactionalOutboxWriter


def load_worker(tmp_path):
    spec = importlib.util.spec_from_file_location("installed_worker", tmp_path / "assets/worker.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def repin(module, spec):
    spec["operation"]["configFingerprint"] = module.fingerprint(spec["extensions"]["runtimeConfig"])
    spec["specFingerprint"] = module.fingerprint(
        {k: v for k, v in spec.items() if k != "specFingerprint"}
    )


def start(module, spec, h):
    return module.ProjectionWorker(
        spec, schema_providers=[h.Schemas()], secret_resolver=h.Secrets(), context=ctx()
    )


def audit(runtime, *, valid=True):
    return runtime.execute(
        runtime.catalog("evidence").append(
            resource="example.audit",
            data={"id": str(uuid4()), "kind": "audit", "payload": {"action": "created"}}
            if valid
            else {"kind": "missing-fields"},
            require_atomic=True,
        )
    )


def observed(h):
    with h.meridian.context(ctx()):
        return [
            len(
                h.meridian.execute(h.meridian.catalog(catalog).query(resource=resource)).data[
                    "items"
                ]
            )
            for catalog, resource in [
                ("structured", "example.source"),
                ("evidence", "example.audit"),
                ("structured", "example.outbox"),
            ]
        ]


@pytest.mark.parametrize(
    "failure",
    [
        None,
        "evidence-validation",
        "after-all-results",
        "rollback-only",
        "intent-mismatch",
        "source-conflict",
    ],
)
def test_three_participants_commit_or_rollback(durable, tmp_path, failure):
    spec, _ = job(durable, tmp_path, required_evidence=True)
    module = load_worker(tmp_path)
    host = start(module, spec, durable)
    writer = TransactionalOutboxWriter(host.meridian, outbox_resource="example.outbox")
    try:

        def compose():
            with (
                host.meridian.context(ctx()),
                host.meridian.transaction("structured:example.source") as transaction,
            ):
                if failure in ("intent-mismatch", "source-conflict"):
                    audit(host.meridian)
                writer.commit(
                    host.meridian.catalog("structured").put(
                        resource="example.source",
                        data={"id": "case", "name": "first", "deleted": False},
                        mode="update" if failure == "source-conflict" else "if_absent",
                    ),
                    intent(
                        "case-event",
                        source_identity="case",
                        source_version=99 if failure == "intent-mismatch" else 1,
                        payload={"id": "case", "name": "first", "deleted": False},
                    ),
                )
                audit(host.meridian, valid=failure != "evidence-validation")
                # The independently connected public facade sees none of the provisional writes.
                with ThreadPoolExecutor(max_workers=1) as observer:
                    assert observer.submit(observed, durable).result(timeout=10) == [0, 0, 0]
                if failure == "after-all-results":
                    raise RuntimeError("caller aborts all provisional results")
                if failure == "rollback-only":
                    transaction.set_rollback_only()

        if failure in (None, "rollback-only"):
            compose()
        else:
            with pytest.raises(Exception) as rejected:
                compose()
            assert isinstance(
                rejected.value, RuntimeError if failure == "after-all-results" else MeridianError
            )
        assert observed(durable) == ([1, 1, 1] if failure is None else [0, 0, 0])
        if failure is None:
            assert durable.port().get("case-event").attempt_count == 0
        else:
            with pytest.raises(NotFoundError):
                durable.port().get("case-event")
    finally:
        host.close()


@pytest.mark.parametrize(
    "fault",
    [
        "legacy-required",
        "future-version",
        "empty-new-version",
        "duplicate",
        "unordered",
        "wrong-catalog",
        "noncanonical",
        "missing-resource",
        "missing-package",
        "wrong-package",
        "installed-package",
    ],
)
def test_host_rejects_incompatible_serialized_spec_before_start(
    durable, tmp_path, monkeypatch, fault
):
    spec, _ = job(durable, tmp_path, required_evidence=True)
    module = load_worker(tmp_path)
    op = spec["operation"]
    if fault == "legacy-required":
        op["version"] = "1.0.0"
    if fault == "future-version":
        op["version"] = "9.0.0"
    if fault == "empty-new-version":
        op["requiredEvidence"] = []
    if fault == "duplicate":
        op["requiredEvidence"] *= 2
    if fault == "unordered":
        op["requiredEvidence"] = ["evidence:example.z", "evidence:example.audit"]
    if fault == "wrong-catalog":
        op["requiredEvidence"] = ["structured:example.source"]
    if fault == "noncanonical":
        op["requiredEvidence"] = ["example.audit"]
    if fault == "missing-resource":
        spec["resources"] = [r for r in spec["resources"] if r["catalog"] != "evidence"]
    if fault == "missing-package":
        del op["packages"]["meridian-storage-evidence"]
    if fault == "wrong-package":
        op["packages"]["meridian-storage-evidence"] = "0.0.0"
    if fault == "installed-package":
        real = module.version
        monkeypatch.setattr(
            module,
            "version",
            lambda name: "0.0.0" if name == "meridian-storage-evidence" else real(name),
        )
    repin(module, spec)
    started = []
    monkeypatch.setattr(module.Meridian, "start", lambda *_: started.append(True))
    with pytest.raises((ValueError, KeyError)):
        start(module, spec, durable)
    assert started == []


def test_legacy_host_rejects_new_required_spec(durable, tmp_path):
    spec, _ = job(durable, tmp_path, required_evidence=True)
    # The previous public npm package is an independent installed test dependency.
    legacy = os.environ["LEGACY_CONSTRUCTS_MODULE"]
    assert "node_modules" in Path(legacy).parts
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            "const p = await import(process.env.LEGACY_CONSTRUCTS_MODULE); process.stdout.write(p.projectionHostFiles()['worker.py']);",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    path = tmp_path / "legacy_worker.py"
    path.write_text(result.stdout)
    module_spec = importlib.util.spec_from_file_location("legacy_worker", path)
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    with pytest.raises(ValueError, match="package set"):
        module.validate_job(spec)


@pytest.mark.parametrize("durable", ["separate-evidence"], indirect=True)
def test_optional_evidence_can_start_separately_but_required_cannot(durable, tmp_path, monkeypatch):
    spec, _ = job(durable, tmp_path)
    module = load_worker(tmp_path)
    host = start(module, spec, durable)
    host.close()
    with pytest.raises(ValueError, match="share the source"):
        job(durable, tmp_path, required_evidence=True)

    # Simulate a spec/config placement change after preview, with coherent fingerprints.
    spec["operation"].update(version="1.1.0", requiredEvidence=["evidence:example.audit"])
    spec["operation"]["packages"]["meridian-storage-evidence"] = EVIDENCE_VERSION
    spec["resources"].append({"catalog": "evidence", "namespace": "example", "name": "audit"})
    repin(module, spec)
    data = write(durable)
    created = []
    monkeypatch.setattr(module, "PostgreSQLOutbox", lambda *args, **kwargs: created.append(True))
    with pytest.raises(ValueError, match="Evidence placement mismatch"):
        start(module, spec, durable)
    assert created == []
    assert durable.port().get(data.event_id).attempt_count == 0


@pytest.mark.parametrize(
    "fault", ["atomic-evidence", "transaction-atomic", "fingerprint-drift", "missing-resource"]
)
def test_started_runtime_rejects_capability_or_resource_drift(
    durable, tmp_path, monkeypatch, fault
):
    import meridian_storage.adapters.postgresql._runtime as adapter_runtime
    import meridian_storage.adapters.postgresql.probe as adapter_probe

    spec, _ = job(durable, tmp_path, required_evidence=True)
    module = load_worker(tmp_path)
    data = write(durable)
    config = spec["extensions"]["runtimeConfig"]
    if fault == "missing-resource":
        config["resources"]["pins"] = [
            p
            for p in config["resources"]["pins"]
            if p["ref"] != {"catalog": "evidence", "namespace": "example", "name": "audit"}
        ]
    else:
        original = adapter_runtime.manifest
        contract = (
            "meridian.transaction" if fault == "transaction-atomic" else "meridian.evidence.append"
        )
        guarantee = "atomic" if fault == "transaction-atomic" else "atomic-evidence"

        def reduced(profile, engine):
            value = original(profile, engine)
            return replace(
                value,
                descriptor=replace(
                    value.descriptor,
                    capabilities=tuple(
                        replace(cap, guarantees=tuple(g for g in cap.guarantees if g != guarantee))
                        if cap.operation_contract == contract
                        else cap
                        for cap in value.descriptor.capabilities
                    ),
                ),
            )

        monkeypatch.setattr(adapter_probe, "manifest", reduced)
        if fault != "fingerprint-drift":
            monkeypatch.setattr(adapter_runtime, "manifest", reduced)
            binding = config["bindings"][0]
            binding["requiredCapabilityFingerprint"] = reduced(
                binding["engineProfile"], binding["engineVersion"]
            ).fingerprint
    repin(module, spec)
    started = []
    original_start = module.Meridian.start

    def record_start(self):
        result = original_start(self)
        started.append(self)
        return result

    monkeypatch.setattr(module.Meridian, "start", record_start)
    created = []
    monkeypatch.setattr(module, "PostgreSQLOutbox", lambda *args, **kw: created.append(True))
    with pytest.raises(Exception) as caught:
        start(module, spec, durable)
    if fault in ("atomic-evidence", "transaction-atomic"):
        assert started, "negative capability must reach the real host post-start check"
        assert "required Operations or guarantees" in str(caught.value)
    assert created == []
    assert durable.port().get(data.event_id).attempt_count == 0


def test_empty_declaration_and_optional_evidence_pin_start(durable, tmp_path):
    spec, _ = job(
        durable,
        tmp_path,
        mutate=lambda args: args["packages"].update(
            {"meridian-storage-evidence": EVIDENCE_VERSION}
        ),
    )
    module = load_worker(tmp_path)
    assert spec["operation"]["version"] == "1.0.0"
    host = start(module, spec, durable)
    host.close()
