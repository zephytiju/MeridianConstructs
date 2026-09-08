# SPDX-License-Identifier: Apache-2.0
"""Metadata inventory from installed public artifacts; no Engine probe is claimed."""

import json
import sys
from importlib.metadata import version
from pathlib import Path

from meridian_storage.adapters.clickhouse.configuration import ClickHouseSettings, Endpoint
from meridian_storage.adapters.clickhouse.descriptor import capability_manifest as clickhouse
from meridian_storage.adapters.clickhouse.schema import Topology
from meridian_storage.adapters.kafka.descriptor import adapter_descriptor as kafka_descriptor
from meridian_storage.adapters.oci.descriptor import (
    OciDistributionBinding,
    configured_capability_manifest,
)
from meridian_storage.adapters.opensearch.descriptor import capability_manifest as opensearch
from meridian_storage.adapters.postgresql.descriptor import manifest as postgresql
from meridian_storage.adapters.s3.config import S3Config
from meridian_storage.adapters.s3.descriptor import s3_capability_manifest
from meridian_storage.adapters.valkey.configuration import ValkeySettings
from meridian_storage.adapters.valkey.descriptor import capability_manifest as valkey
from meridian_storage.spi import CapabilityManifest, adapter_capability_contract


def manifests():
    result = {}

    def add(package, manifest):
        result[manifest.engine_profile] = {
            "package": package,
            "version": version(package),
            "manifest": manifest.to_dict(),
            "fingerprint": manifest.fingerprint,
        }

    for profile in ("postgresql-postgis-local-single-primary", "postgresql-postgis-cluster"):
        add("meridian-storage-postgresql", postgresql(profile, "17-postgis-3.5"))
    add("meridian-storage-opensearch", opensearch("2.19.1", pit_enabled=False))
    for topology in Topology:
        settings = ClickHouseSettings(
            database="metadata_inventory",
            topology=topology,
            endpoint=Endpoint("localhost", 8443, True),
            layouts={},
            max_batch_rows=10000,
            max_batch_bytes=16 * 1024 * 1024,
            max_time_range_seconds=31 * 24 * 60 * 60,
            retry_window_seconds=24 * 60 * 60,
            cursor_ttl_seconds=900,
            insert_quorum=1,
            required_functions=(),
            operation_timeout_ms=30000,
            max_result_bytes=16 * 1024 * 1024,
        )
        add("meridian-storage-clickhouse", clickhouse(settings, "25.3"))
    # Both topology profiles share the public descriptor; selection is metadata.
    vk = valkey("8.1.9", ValkeySettings(namespace_generation=1, resources={}))
    for profile in vk.descriptor.supported_engine_versions:
        add("meridian-storage-valkey", CapabilityManifest(vk.descriptor, profile, "8.1.9"))
    for profile in ("aws-s3", "s3-compatible"):
        add(
            "meridian-storage-s3",
            s3_capability_manifest(S3Config(bucket="metadata-inventory", engine_profile=profile)),
        )
    add(
        "meridian-storage-oci",
        configured_capability_manifest(
            OciDistributionBinding(
                resource="object:inventory.objects",
                endpoint="https://registry.example",
                repository="inventory/objects",
            )
        ),
    )
    kd = kafka_descriptor()
    for profile in kd.supported_engine_versions:
        add("meridian-storage-kafka", CapabilityManifest(kd, profile, "4.3.1"))
    return result


def main():
    record = {
        "classification": "Public released contract metadata; no authenticated Engine evidence",
        "coreVersion": version("meridian-storage-core"),
        "profiles": manifests(),
        "capabilitySchema": adapter_capability_contract(),
    }
    Path(sys.argv[1]).write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
