# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

from dataclasses import dataclass
from importlib import metadata
from typing import Any

import pytest

from meridian_constructs import ADAPTER_ENTRY_POINTS, PACKAGE_PINS, compatibility


@dataclass
class FakeDistribution:
    name: str


@dataclass
class FakeEntryPoint:
    name: str
    value: str
    dist: FakeDistribution | None


def fake_entry_points(group: str) -> list[FakeEntryPoint]:
    if group == "meridian_storage.adapters":
        return [
            FakeEntryPoint(name, f"public.{name}:Factory", FakeDistribution(package))
            for name, package in ADAPTER_ENTRY_POINTS.items()
        ]
    if group == "meridian_storage.catalogs":
        return [
            FakeEntryPoint(name, f"public.{name}:Provider", None)
            for name in ("structured", "object", "cache", "evidence", "streaming")
        ]
    return []


def test_installed_metadata_verification_and_cli(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(compatibility.metadata, "version", lambda package: PACKAGE_PINS[package])
    monkeypatch.setattr(compatibility.metadata, "entry_points", fake_entry_points)
    report = compatibility.verify_installed()
    assert report.to_dict()["installedVersions"] == dict(PACKAGE_PINS)
    assert report.fingerprint == compatibility.compatibility_fingerprint()
    assert compatibility.main(["--verify-installed", "--json"]) == 0
    assert "meridian-storage-kafka" in capsys.readouterr().out
    assert compatibility.main([]) == 0
    assert "designRevisions" in capsys.readouterr().out


def test_installed_metadata_reports_all_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    def versions(package: str) -> str:
        if package == "meridian-storage-core":
            raise metadata.PackageNotFoundError(package)
        if package == "meridian-storage-kafka":
            return "0.0.0"
        return PACKAGE_PINS[package]

    def entry_points(group: str) -> list[FakeEntryPoint]:
        if group == "meridian_storage.adapters":
            return [
                FakeEntryPoint("kafka", "bad:Factory", FakeDistribution("wrong-package")),
                FakeEntryPoint("s3", "public.s3:Factory", None),
            ]
        return [FakeEntryPoint("structured", "public:Provider", None)]

    monkeypatch.setattr(compatibility.metadata, "version", versions)
    monkeypatch.setattr(compatibility.metadata, "entry_points", entry_points)
    with pytest.raises(RuntimeError) as captured:
        compatibility.verify_installed()
    message = str(captured.value)
    assert "not installed" in message
    assert "expected 1.0.1" in message
    assert "entry point" in message
    assert "Catalog entry points" in message


@pytest.mark.parametrize(
    "change",
    [
        lambda value: {**value, "packages": {}},
        lambda value: {**value, "profiles": []},
        lambda value: {**value, "profiles": {**value["profiles"], "extra": {}}},
        lambda value: {
            **value,
            "profiles": {**value["profiles"], "apache-kafka": "bad"},
        },
        lambda value: {
            **value,
            "profiles": {
                **value["profiles"],
                "apache-kafka": {**value["profiles"]["apache-kafka"], "adapterVersion": "0"},
            },
        },
    ],
)
def test_compatibility_contract_drift_fails(monkeypatch: pytest.MonkeyPatch, change: Any) -> None:
    value = dict(compatibility.compatibility_contract())
    monkeypatch.setattr(compatibility, "compatibility_contract", lambda: change(value))
    with pytest.raises(RuntimeError, match=r"compatibility|profile|drifted"):
        compatibility.verify_contract_consistency()
