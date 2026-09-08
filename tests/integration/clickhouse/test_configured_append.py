# SPDX-License-Identifier: Apache-2.0
"""Planning metadata parity with the normal public ClickHouse 1.1.3 contract."""

import copy
from dataclasses import replace
import json
import subprocess
from pathlib import Path

from meridian_storage.adapters.clickhouse import ClickHouseSettings, capability_manifest
from meridian_storage.adapters.clickhouse.configuration import Endpoint
from meridian_storage.adapters.clickhouse.schema import ResourceLayout, Topology
from meridian_storage.registry import CapabilityRequirement
from meridian_storage.runtime import RuntimeConfig
from meridian_storage.spi import capability_violations

from mapping_layout import render, ROOT, REPO

FP = "sha256:" + "a" * 64


def specification(
    defaults, topology, mode, settings, manifest, contract, version, guarantees, limits, supplied
):
    selector = {"catalog": contract.split(".")[1], "namespace": "inventory", "name": "records"}
    profile = defaults["profiles"][topology.value]
    ref = {"provider": "fixture", "reference": "opaque"}
    spec = {
        "profile": "public-append-contract",
        "catalogs": [
            {
                "name": selector["catalog"],
                "package": "fixture",
                "contract": "1.0.0",
                "requiredFingerprint": FP,
            }
        ],
        "schemaProviders": [
            {
                "id": "inventory",
                "package": "fixture",
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
                        "package": "fixture",
                        "version": "1.0.0",
                        "resourceFingerprint": FP,
                    }
                ],
                "operations": [
                    {
                        "contract": contract,
                        "version": version,
                        "guarantees": list(guarantees),
                        "limits": limits,
                    }
                ],
                "guarantees": {"required": []},
                "limits": {"values": {}},
                "dataClass": "metadata-fixture",
            }
        ],
        "bindings": [
            {
                "id": "inventory",
                "profileId": topology.value,
                "mode": mode,
                "topology": profile["defaultTopology"],
                "engineVersion": "25.8.33.6",
                "requiredCapabilityFingerprint": manifest.fingerprint,
                "compatibilityPins": {
                    name: "1.1.3" if name == "meridian-storage-clickhouse" else "1.0.0"
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
                    "settings": settings,
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
    if supplied:
        spec["bindings"][0]["capabilityManifest"] = manifest.to_dict()
    return spec


def test_configured_append_matches_public_capability_contract():
    defaults = render({"command": "defaults"})
    fixture = json.loads(
        (Path(__file__).parents[2] / "fixtures/collector-clickhouse/input.json").read_text()
    )
    original = [ResourceLayout.from_mapping(x) for x in fixture["layouts"].values()]
    inputs, expected, labels = [], [], []
    for topology in Topology:
        for rows in (100, 20000):
            for variant in ("append", "legacy", "mixed"):
                layouts = [
                    replace(
                        layout,
                        topology=topology,
                        append_only=variant == "append" or (variant == "mixed" and i == 0),
                    )
                    for i, layout in enumerate(original)
                ]
                settings = ClickHouseSettings(
                    "inventory",
                    topology,
                    Endpoint("localhost", 8443, True),
                    {layout.resource.canonical: layout for layout in layouts},
                    rows,
                    8388608,
                    86400,
                    300,
                    900,
                    1,
                    ("count",),
                    30000,
                    4194304,
                )
                manifest = capability_manifest(settings, "25.8.33.6")
                raw = {
                    "layouts": [layout.to_dict() for layout in layouts],
                    "maxBatchRows": rows,
                    "maxBatchBytes": 8388608,
                    "maxTimeRangeSeconds": 86400,
                    "retryWindowSeconds": 300,
                    "insertQuorum": 1,
                }
                for mode in ("managed", "external"):
                    for supplied in (False, True):
                        for capability in manifest.descriptor.capabilities:
                            checks = [
                                ((), {key: value + delta})
                                for key, value in capability.limits.items()
                                for delta in (0, 1)
                            ]
                            if capability.operation_contract == "meridian.evidence.append":
                                checks.extend([(("append-only",), {}), (("atomic-evidence",), {})])
                            for guarantees, limits in checks:
                                contract, version = (
                                    capability.operation_contract,
                                    capability.operation_versions[0],
                                )
                                req = CapabilityRequirement(
                                    contract, version, guarantees=guarantees, minimum_limits=limits
                                )
                                inputs.append(
                                    specification(
                                        defaults,
                                        topology,
                                        mode,
                                        raw,
                                        manifest,
                                        contract,
                                        version,
                                        guarantees,
                                        limits,
                                        supplied,
                                    )
                                )
                                expected.append(not capability_violations(manifest, (req,)))
                                labels.append(
                                    {
                                        "profile": topology.value,
                                        "rows": rows,
                                        "variant": variant,
                                        "mode": mode,
                                        "suppliedManifest": supplied,
                                        "contract": contract,
                                        "guarantees": guarantees,
                                        "limits": limits,
                                    }
                                )
    # Malformed selected layouts must not acquire guarantees, even with a valid manifest.
    for supplied in (False, True):
        for key, value in [
            ("appendOnly", "true"),
            ("appendOnly", False),
            ("extra", True),
            ("queryFinal", "true"),
            ("layoutFingerprint", FP),
            ("columns", []),
        ]:
            spec = copy.deepcopy(
                next(
                    s
                    for s, layout in zip(inputs, labels)
                    if layout["variant"] == "append"
                    and layout["suppliedManifest"] == supplied
                    and layout["guarantees"] == ("append-only",)
                )
            )
            spec["bindings"][0]["connection"]["settings"]["layouts"][0][key] = value
            inputs.append(spec)
            expected.append(False)
            labels.append({"malformed": key, "value": value, "suppliedManifest": supplied})
    process = subprocess.run(
        [
            "node",
            "--import",
            "tsx",
            str(REPO / "tests/integration/runtime-config/render-config.ts"),
        ],
        input=json.dumps({"command": "batch", "specs": inputs}),
        text=True,
        capture_output=True,
        cwd=REPO,
        check=True,
    )
    results = json.loads(process.stdout)
    mismatches = []
    for label, want, result in zip(labels, expected, results, strict=True):
        if want != result["accepted"]:
            mismatches.append({"case": label, "expected": want, "actual": result})
        elif want:
            RuntimeConfig.from_mapping(result["config"])
    (ROOT / "configured-append-parity.json").write_text(
        json.dumps(
            {
                "cases": len(inputs),
                "mismatches": mismatches,
                "scope": "Public capability comparison and Core parsing; not engine execution",
            },
            indent=2,
        )
        + "\n"
    )
    assert not mismatches, mismatches[:10]
