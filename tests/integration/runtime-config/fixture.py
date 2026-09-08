# SPDX-License-Identifier: Apache-2.0
"""Real public-package pins passed through an installed Constructs renderer."""

from __future__ import annotations

import json
import os
import subprocess
from functools import lru_cache
from importlib.metadata import version
from pathlib import Path
from urllib.parse import quote

from meridian_storage.adapters.postgresql.descriptor import manifest
from meridian_storage.semantics import SemanticsSchemaProvider, StructuredCatalogProvider
from psycopg.conninfo import conninfo_to_dict

ROOT = Path(__file__).resolve().parents[3]
PROVIDER = SemanticsSchemaProvider()
BUNDLE = PROVIDER.load()
RESOURCE = next(r for r in BUNDLE.resources if r.ref.canonical == "structured:meridian.registry")
SCHEMA = next(s for s in BUNDLE.schemas if s.ref == RESOURCE.schema)


def render(payload: dict) -> dict:
    result = subprocess.run(
        ["node", "--import", "tsx", str(Path(__file__).with_name("render-config.ts"))],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        cwd=ROOT,
        check=True,
    )
    return json.loads(result.stdout)


@lru_cache
def defaults() -> dict:
    return render({"command": "defaults"})


def deployment_spec(namespace: str = "constructs_metadata") -> dict:
    selected = defaults()
    profile = selected["profile"]
    engine = os.environ.get("MERIDIAN_POSTGRESQL_ENGINE_VERSION", "16-postgis-3.4")
    parsed = conninfo_to_dict(
        os.environ.get(
            "MERIDIAN_POSTGRESQL_TEST_DSN",
            "host=127.0.0.1 port=5432 dbname=meridian user=meridian password=meridian",
        )
    )
    endpoint = (
        f"postgresql://{parsed.get('host', '127.0.0.1')}:{parsed.get('port', '5432')}/"
        + quote(parsed.get("dbname", "meridian"), safe="")
    )
    catalog = StructuredCatalogProvider().manifest()
    layout = {
        "ref": RESOURCE.ref.canonical,
        "profile": "metadata-registry",
        "table": "__meridian_schema_registry",
        "resourceFingerprint": RESOURCE.fingerprint,
        "schemaFingerprint": SCHEMA.fingerprint,
        "fields": [],
        "identity": [],
        "indexes": [],
        "relation": None,
    }
    return {
        "profile": "conformance",
        "catalogs": [
            {
                "name": catalog.catalog_name,
                "package": catalog.package_name,
                "contract": catalog.catalog_contract_version,
                "requiredFingerprint": catalog.fingerprint,
            }
        ],
        "schemaProviders": [
            {
                "id": PROVIDER.provider_id,
                "package": "meridian-storage-semantics",
                "contract": PROVIDER.provider_contract_version,
                "requiredFingerprint": BUNDLE.fingerprint,
            }
        ],
        "resources": [
            {
                "selector": RESOURCE.ref.to_dict(),
                "schemas": [
                    {
                        "providerId": PROVIDER.provider_id,
                        "package": "meridian-storage-semantics",
                        "version": version("meridian-storage-semantics"),
                        "resourceFingerprint": RESOURCE.fingerprint,
                    }
                ],
                "operations": [
                    {"contract": "meridian.structured.publish_schema", "version": "1.0.0"}
                ],
                "guarantees": {"required": []},
                "limits": {"values": {}},
                "dataClass": "internal-operational",
                "labels": {},
            }
        ],
        "bindings": [
            {
                "id": "metadata",
                "profileId": profile["id"],
                "requiredCapabilityFingerprint": manifest(profile["id"], engine).fingerprint,
                "mode": "external",
                "topology": profile["defaultTopology"],
                "engineVersion": engine,
                "client": selected["client"],
                "compatibilityPins": {name: version(name) for name in profile["compatibilityPins"]},
                "runtimeCompatibilityPins": {},
                "connection": {
                    "physicalNamespace": namespace,
                    "identityRef": {"provider": "conformance", "reference": "identity"},
                    "secretRef": {"provider": "conformance", "reference": "credential"},
                    "tls": {
                        "mode": "disabled",
                        "serverName": None,
                        "caRef": None,
                        "clientCertificateRef": None,
                    },
                    "endpoint": endpoint,
                    "serviceRef": None,
                    "requiredPhysicalFingerprint": None,
                    "settings": {
                        "formatVersion": "meridian.postgresql.settings.v1",
                        "applicationName": "constructs-metadata-conformance",
                        "scopeKeys": [],
                        "topology": {"expectedStandbys": 0},
                        "resources": [layout],
                    },
                    "extensions": {},
                },
                "acl": {"provider": "conformance", "reference": "metadata"},
                "migration": {
                    "contract": "meridian.migration.apply",
                    "version": "1.0.0",
                    "appliedFingerprint": "sha256:" + "0" * 64,
                },
                "observability": {"enabled": False, "labels": {}},
            }
        ],
        "placements": [
            {
                "id": "metadata",
                "selector": {"resources": [RESOURCE.ref.to_dict()], "catalog": None, "labels": {}},
                "bindingId": "metadata",
                "extensions": {},
            }
        ],
        "liveSchemas": {"enabled": False, "required": False, "providerId": None},
        "validation": {**selected["validation"], "requirePhysicalFingerprints": False},
        "telemetry": selected["telemetry"],
        "extensions": {},
    }


def plan(spec: dict) -> dict:
    return render({"command": "plan", "spec": spec})
