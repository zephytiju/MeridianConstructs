# SPDX-License-Identifier: Apache-2.0
"""Public-runtime contract validation and independent selected package locks."""

import json
from pathlib import Path

import pytest
from meridian_storage.runtime.config import RuntimeConfig
from test_projection_jobs import job, write
from test_required_evidence import load_worker, start, repin


def test_public_core_golden_typed_config_and_manifests():
    fixtures = json.loads(
        (Path(__file__).parents[2] / "fixtures/core-1.1.0/release-provenance.v1.json").read_text()
    )
    assert (
        RuntimeConfig.from_mapping(fixtures["runtimeConfig"]).fingerprint
        == fixtures["runtimeConfigFingerprint"]
    )


def test_host_preserves_extra_locked_packages_and_rejects_selected_drift(durable, tmp_path):
    from importlib.metadata import version

    spec, _ = job(
        durable,
        tmp_path,
        required_evidence=True,
        mutate=lambda a: a["packages"].update({"packaging": version("packaging")}),
    )
    module = load_worker(tmp_path)
    host = start(module, spec, durable)
    host.close()
    spec["operation"]["packages"]["packaging"] = "0.0.0"
    repin(module, spec)
    with pytest.raises(ValueError, match="differs from deployment lock"):
        start(module, spec, durable)


def test_required_host_api_failure_before_claims(durable, tmp_path, monkeypatch):
    data = write(durable)
    spec, _ = job(durable, tmp_path)
    module = load_worker(tmp_path)
    monkeypatch.setattr(module.ProjectionRunner, "run_until_stopped", None)
    with pytest.raises(ValueError, match="missing required host API"):
        start(module, spec, durable)
    assert durable.port().get(data.event_id).attempt_count == 0


def test_deployment_binding_package_lock_is_enforced(durable, tmp_path):
    spec, _ = job(durable, tmp_path, required_evidence=True)
    module = load_worker(tmp_path)
    binding = spec["extensions"]["runtimeConfig"]["bindings"][0]
    binding["extensions"]["org.meridian.constructs/package-lock.v1"] = {
        "formatVersion": "meridian-deployment-package-lock.v1",
        "packages": dict(spec["operation"]["packages"]),
    }
    repin(module, spec)
    host = start(module, spec, durable)
    host.close()
    binding["extensions"]["org.meridian.constructs/package-lock.v1"]["packages"][
        "meridian-storage-core"
    ] = "99.0.0"
    repin(module, spec)
    with pytest.raises(ValueError, match="package lock differs"):
        start(module, spec, durable)
