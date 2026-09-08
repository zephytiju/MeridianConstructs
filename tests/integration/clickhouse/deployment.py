# SPDX-License-Identifier: Apache-2.0
"""Caller-owned public locks rendered by the installed Constructs distribution."""

from importlib.metadata import version
import json

from mapping_layout import render, ROOT


def generated_config(mode, config, manifest, migration_fingerprint):
    defaults = render({"command": "defaults"})
    profile = defaults["profile"]
    raw = config["bindings"][0]
    provider = config["schemas"]["providers"][0]
    spec = {
        "profile": config["profile"],
        "catalogs": config["catalogs"]["providers"],
        "schemaProviders": [provider],
        "resources": [
            {
                "selector": pin["ref"],
                "schemas": [
                    {
                        "providerId": provider["id"],
                        "package": provider["package"],
                        "version": "1.0.0",
                        "resourceFingerprint": pin["requiredFingerprint"],
                    }
                ],
                "operations": [
                    {
                        "contract": "meridian.evidence.append",
                        "version": "1.0.0",
                        "guarantees": ["append-only"],
                    },
                    {"contract": "meridian.evidence.query", "version": "1.0.0"},
                ],
                "guarantees": {"required": []},
                "limits": {"values": {}},
                "dataClass": "internal-operational",
                "labels": {},
            }
            for pin in config["resources"]["pins"]
        ],
        "bindings": [
            {
                "id": raw["id"],
                "profileId": profile["id"],
                "mode": "external",
                "topology": profile["defaultTopology"],
                "engineVersion": raw["engineVersion"],
                "client": raw["client"],
                "requiredCapabilityFingerprint": manifest.fingerprint,
                "capabilityManifest": manifest.to_dict(),
                "compatibilityPins": {name: version(name) for name in profile["compatibilityPins"]},
                "runtimeCompatibilityPins": {},
                "connection": {
                    key: raw[key]
                    for key in (
                        "endpoint",
                        "serviceRef",
                        "physicalNamespace",
                        "identityRef",
                        "secretRef",
                        "tls",
                        "requiredPhysicalFingerprint",
                        "settings",
                        "extensions",
                    )
                },
                "acl": {"provider": "test", "reference": "telemetry"},
                "migration": {
                    "contract": "meridian.migration.apply",
                    "version": "1.0.0",
                    "appliedFingerprint": migration_fingerprint,
                },
                "observability": {"enabled": False, "labels": {}},
            }
        ],
        "placements": config["placements"],
        "liveSchemas": config["schemas"]["live"],
        "validation": config["validation"],
        "telemetry": defaults["telemetry"],
        "extensions": {},
    }
    plan = render({"command": "deployment", "spec": spec})
    assert render({"command": "deployment", "spec": spec}) == plan
    # The manifest remains optional: actual selected layouts supply the same
    # configured guarantee, while all runtime and physical pins stay explicit.
    spec["bindings"][0].pop("capabilityManifest")
    assert render({"command": "deployment", "spec": spec}) == plan
    generated = plan["runtimeConfig"]
    assert generated["bindings"][0]["settings"]["layouts"] == raw["settings"]["layouts"]
    assert (
        generated["bindings"][0]["requiredPhysicalFingerprint"]
        == raw["requiredPhysicalFingerprint"]
    )
    assert generated["bindings"][0]["requiredCapabilityFingerprint"] == manifest.fingerprint
    (ROOT / (mode + "-deployment-spec.json")).write_text(json.dumps(spec, indent=2) + "\n")
    (ROOT / (mode + "-deployment-plan.json")).write_text(json.dumps(plan, indent=2) + "\n")
    return generated
