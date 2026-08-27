# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import ast
from pathlib import Path

import pytest

from meridian_constructs import (
    ADAPTER_ENTRY_POINTS,
    PACKAGE_PINS,
    PROFILES,
    CatalogName,
    ConstructError,
    default_profiles,
    get_profile,
    verify_contract_consistency,
)


def test_complete_released_adapter_set_and_pins() -> None:
    assert set(ADAPTER_ENTRY_POINTS) == {
        "postgresql",
        "opensearch",
        "clickhouse",
        "valkey",
        "s3",
        "oci-distribution",
        "kafka",
    }
    assert PACKAGE_PINS["meridian-storage-kafka"] == "1.0.1"
    assert {profile.adapter_package for profile in PROFILES.values()} == set(
        ADAPTER_ENTRY_POINTS.values()
    )
    verify_contract_consistency()


def test_default_profiles_are_one_primary_and_streaming_is_explicit() -> None:
    defaults = default_profiles()
    assert set(defaults) == {
        CatalogName.STRUCTURED,
        CatalogName.OBJECT,
        CatalogName.CACHE,
        CatalogName.EVIDENCE,
    }
    assert all(profile.primary_count == 1 for profile in defaults.values())
    assert default_profiles(include_streaming=True)[CatalogName.STREAMING].id == "apache-kafka-test"


def test_unknown_profile_fails_closed() -> None:
    with pytest.raises(ConstructError, match="Unknown engine profile"):
        get_profile("native-query")


def test_package_never_imports_kafka_or_adapter_modules() -> None:
    package = Path(__file__).parents[1] / "src" / "meridian_constructs"
    imported: set[str] = set()
    for source in package.rglob("*.py"):
        tree = ast.parse(source.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module is not None:
                imported.add(node.module)
    assert not any(name.startswith("meridian_storage.adapters") for name in imported)
    assert not any("kafka" in name.lower() for name in imported)
