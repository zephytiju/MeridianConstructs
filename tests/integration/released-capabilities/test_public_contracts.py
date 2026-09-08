# SPDX-License-Identifier: Apache-2.0
"""Compare packed/public npm planning against installed public Core and Adapters."""

import copy
import json
import os
import subprocess
from pathlib import Path

from export_contracts import manifests, configured_manifests
from meridian_storage.registry import CapabilityRequirement
from meridian_storage.runtime.config import RuntimeConfig
from meridian_storage.spi import (
    AdapterDescriptor,
    CapabilityManifest,
    OperationCapability,
    adapter_capability_contract,
    capability_violations,
)

ROOT = Path(__file__).resolve().parents[3]
FP = "sha256:" + "a" * 64


def render(payload):
    result = subprocess.run(
        [
            "node",
            "--import",
            "tsx",
            str(ROOT / "tests/integration/runtime-config/render-config.ts"),
        ],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        check=True,
        cwd=ROOT,
    )
    return json.loads(result.stdout)


def core_manifest(data):
    d = data["descriptor"]
    descriptor = AdapterDescriptor(
        d["adapterId"],
        d["adapterContractVersion"],
        d["driver"],
        d["supportedEngineVersions"],
        tuple(
            OperationCapability(
                c["operationContract"],
                tuple(c["operationVersions"]),
                guarantees=tuple(c["guarantees"]),
                limits=c["limits"],
                cursor_behavior=c["cursorBehavior"],
                migration_behavior=c["migrationBehavior"],
                health_probes=tuple(c["healthProbes"]),
                extensions=c["extensions"],
            )
            for c in d["capabilities"]
        ),
    )
    return CapabilityManifest(
        descriptor,
        data["engineProfile"],
        data["engineVersion"],
        tuple(data["availableOperationContracts"]),
        extensions=data["extensions"],
    )


def spec(profile, selected, mode, topology, contract, version, guarantees=(), limits=None):
    catalog = contract.split(".")[1]
    if catalog == "transaction":
        catalog = profile["catalogs"][0]
    selector = {"catalog": catalog, "namespace": "inventory", "name": "records"}
    ref = {"provider": "metadata-fixture", "reference": "opaque"}
    defaults = DEFAULTS
    return {
        "profile": "released-contract-metadata",
        "catalogs": [
            {
                "name": catalog,
                "package": "metadata-fixture",
                "contract": "1.0.0",
                "requiredFingerprint": FP,
            }
        ],
        "schemaProviders": [
            {
                "id": "inventory",
                "package": "metadata-fixture",
                "contract": "1.0.0",
                "requiredFingerprint": FP,
            }
        ],
        "resources": [
            {
                "selector": selector,
                "schemas": [
                    {
                        "providerId": "inventory",
                        "package": "metadata-fixture",
                        "version": "1.0.0",
                        "resourceFingerprint": FP,
                    }
                ],
                "operations": [
                    {
                        "contract": contract,
                        "version": version,
                        "guarantees": list(guarantees),
                        "limits": limits or {},
                    }
                ],
                "guarantees": {"required": []},
                "limits": {"values": {}},
                "labels": {},
                "dataClass": "metadata-fixture",
            }
        ],
        "bindings": [
            {
                "id": "inventory",
                "profileId": profile["id"],
                "mode": mode,
                "topology": topology,
                "engineVersion": selected["manifest"]["engineVersion"],
                "requiredCapabilityFingerprint": selected["fingerprint"],
                "capabilityManifest": selected["manifest"],
                "compatibilityPins": {
                    name: (selected["version"] if name == selected["package"] else "1.0.0")
                    for name in profile["compatibilityPins"]
                },
                "client": defaults["client"],
                "acl": ref,
                "connection": {
                    "physicalNamespace": "inventory",
                    "identityRef": ref,
                    "secretRef": ref,
                    "tls": {
                        "mode": "server",
                        "serverName": "localhost",
                        "caRef": ref,
                        "clientCertificateRef": None,
                    },
                    "endpoint": "https://localhost:8443",
                    "serviceRef": None,
                    "requiredPhysicalFingerprint": FP,
                    "settings": {},
                    "extensions": {},
                },
                "migration": {
                    "contract": "meridian.migration.apply",
                    "version": "1.0.0",
                    "appliedFingerprint": FP,
                },
                "observability": {"enabled": False, "labels": {}},
            }
        ],
        "placements": [
            {
                "id": "inventory",
                "bindingId": "inventory",
                "extensions": {},
                "selector": {"resources": [selector], "catalog": None, "labels": {}},
            }
        ],
        "liveSchemas": {"enabled": False, "required": False, "providerId": None},
        "validation": defaults["validation"],
        "telemetry": defaults["telemetry"],
        "extensions": {},
    }


DEFAULTS = render({"command": "defaults"})


def test_nondefault_limits_agree_with_public_adapters_with_and_without_manifest():
    inputs, expected, labels = [], [], []
    profiles = render({"command": "profiles"})
    for selected in configured_manifests():
        manifest = core_manifest(selected["manifest"])
        profile = profiles[manifest.engine_profile]
        for mode in profile["allowedModes"]:
            for topology in profile["allowedTopologies"]:
                for supplied in (False, True):
                    for cap in manifest.descriptor.capabilities:
                        for key, limit in cap.limits.items():
                            for minimum in (limit, limit + 1):
                                op_version = cap.operation_versions[0]
                                value = spec(
                                    profile,
                                    selected,
                                    mode,
                                    topology,
                                    cap.operation_contract,
                                    op_version,
                                    limits={key: minimum},
                                )
                                value["bindings"][0]["connection"]["settings"] = selected[
                                    "settings"
                                ]
                                if not supplied:
                                    del value["bindings"][0]["capabilityManifest"]
                                inputs.append(value)
                                expected.append(
                                    not capability_violations(
                                        manifest,
                                        (
                                            CapabilityRequirement(
                                                cap.operation_contract,
                                                op_version,
                                                minimum_limits={key: minimum},
                                            ),
                                        ),
                                    )
                                )
                                labels.append(
                                    [
                                        manifest.engine_profile,
                                        mode,
                                        topology,
                                        supplied,
                                        cap.operation_contract,
                                        key,
                                        minimum,
                                    ]
                                )
    outputs = render({"command": "batch", "specs": inputs})
    for label, want, result in zip(labels, expected, outputs, strict=True):
        assert result["accepted"] == want, (label, result)
        if want:
            RuntimeConfig.from_mapping(result["config"])
    out = Path(
        os.environ.get("MERIDIAN_ACCEPTANCE_EVIDENCE_DIR", "/tmp/meridian-contract-evidence")
    )
    out.mkdir(parents=True, exist_ok=True)
    (out / "configured-limits.json").write_text(
        json.dumps({"cases": len(labels), "mismatches": 0, "labels": labels}, indent=2) + "\n"
    )


def test_public_artifacts_match_the_recorded_inventory_and_core_schema():
    observed = manifests()
    recorded = json.loads(
        (ROOT / "tests/fixtures/released-capabilities/inventory.json").read_text()
    )
    assert observed == recorded["profiles"]
    assert adapter_capability_contract() == json.loads(
        (ROOT / "contracts/meridian-adapter-capabilities.v1.schema.json").read_text()
    )
    assert set(observed) == set(render({"command": "profiles"}))


def test_every_family_mode_topology_agrees_with_public_core():
    inputs, expected, labels = [], [], []
    profiles = render({"command": "profiles"})
    for profile_id, selected in manifests().items():
        profile = profiles[profile_id]
        manifest = core_manifest(selected["manifest"])
        for mode in profile["allowedModes"]:
            for topology in profile["allowedTopologies"]:
                for cap in manifest.descriptor.capabilities:
                    for version in cap.operation_versions:
                        cases = [
                            (version, cap.guarantees, dict(cap.limits)),
                            ("99.0.0", (), {}),
                            (version, ("not-advertised",), {}),
                            (version, (), {"not-advertised": 1}),
                        ]
                        if cap.limits:
                            key, limit = next(iter(cap.limits.items()))
                            cases.append((version, (), {key: limit + 1}))
                        for required_version, guarantees, limits in cases:
                            requirement = CapabilityRequirement(
                                cap.operation_contract,
                                required_version,
                                guarantees=guarantees,
                                minimum_limits=limits,
                            )
                            expected.append(not capability_violations(manifest, (requirement,)))
                            inputs.append(
                                spec(
                                    profile,
                                    selected,
                                    mode,
                                    topology,
                                    cap.operation_contract,
                                    required_version,
                                    guarantees,
                                    limits,
                                )
                            )
                            labels.append(
                                [
                                    profile_id,
                                    mode,
                                    topology,
                                    cap.operation_contract,
                                    required_version,
                                    list(guarantees),
                                    limits,
                                ]
                            )
    outputs = render({"command": "batch", "specs": inputs})
    for label, want, result in zip(labels, expected, outputs, strict=True):
        assert result["accepted"] == want, (label, result)
        if want:
            parsed = RuntimeConfig.from_mapping(result["config"])
            assert RuntimeConfig.from_mapping(parsed.to_dict()).fingerprint == parsed.fingerprint
            assert "capabilityManifest" not in result["config"]["bindings"][0]
    out = Path(
        os.environ.get("MERIDIAN_ACCEPTANCE_EVIDENCE_DIR", "/tmp/meridian-contract-evidence")
    )
    out.mkdir(parents=True, exist_ok=True)
    (out / "all-family-contracts.json").write_text(
        json.dumps(
            {
                "classification": "contract metadata and Core parsing only",
                "cases": len(outputs),
                "mismatches": 0,
                "labels": labels,
            },
            indent=2,
        )
        + "\n"
    )


def test_original_sixteen_postgresql_cases_without_new_inputs():
    inputs, labels, expected = [], [], []
    profiles = render({"command": "profiles"})
    for profile_id, selected in manifests().items():
        if selected["package"] != "meridian-storage-postgresql":
            continue
        profile = profiles[profile_id]
        manifest = core_manifest(selected["manifest"])
        for mode in profile["allowedModes"]:
            for name, contract, version, guarantees in [
                ("read-control", "meridian.structured.get", "1.0.0", ()),
                ("put-v2", "meridian.structured.put", "2.0.0", ()),
                ("atomic-evidence", "meridian.evidence.append", "1.0.0", ("atomic-evidence",)),
                ("unsupported-version-control", "meridian.structured.put", "99.0.0", ()),
            ]:
                value = copy.deepcopy(
                    spec(
                        profile,
                        selected,
                        mode,
                        profile["defaultTopology"],
                        contract,
                        version,
                        guarantees,
                    )
                )
                del value["bindings"][0]["capabilityManifest"]
                inputs.append(value)
                labels.append([profile_id, mode, name])
                expected.append(
                    not capability_violations(
                        manifest, (CapabilityRequirement(contract, version, guarantees=guarantees),)
                    )
                )
    outputs = render({"command": "batch", "specs": inputs})
    assert len(outputs) == 16
    for label, want, result in zip(labels, expected, outputs, strict=True):
        assert result["accepted"] == want, (label, result)
        if want:
            RuntimeConfig.from_mapping(result["config"])
    out = Path(
        os.environ.get("MERIDIAN_ACCEPTANCE_EVIDENCE_DIR", "/tmp/meridian-contract-evidence")
    )
    out.mkdir(parents=True, exist_ok=True)
    (out / "original-sixteen.json").write_text(
        json.dumps(
            {
                "cases": labels,
                "core": expected,
                "constructs": [r["accepted"] for r in outputs],
                "mismatches": 0,
            },
            indent=2,
        )
        + "\n"
    )
