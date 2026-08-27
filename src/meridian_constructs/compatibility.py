# SPDX-License-Identifier: Apache-2.0
"""Released-package compatibility evidence without importing Adapter modules."""

from __future__ import annotations

import argparse
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from importlib import metadata, resources
from typing import cast

from ._canonical import JsonValue, canonical_json, fingerprint
from .profiles import ADAPTER_ENTRY_POINTS, PACKAGE_PINS, PROFILES


@dataclass(frozen=True, slots=True)
class CompatibilityReport:
    installed_versions: Mapping[str, str]
    adapter_entry_points: Mapping[str, str]
    fingerprint: str

    def to_dict(self) -> dict[str, JsonValue]:
        return {
            "formatVersion": "meridian-constructs-compatibility-report.v1",
            "installedVersions": dict(self.installed_versions),
            "adapterEntryPoints": dict(self.adapter_entry_points),
            "compatibilityFingerprint": self.fingerprint,
        }


def compatibility_contract() -> Mapping[str, JsonValue]:
    """Load the locked released package/profile matrix shipped in the wheel."""

    source = resources.files("meridian_constructs").joinpath("contracts/compatibility.v1.json")
    return cast(Mapping[str, JsonValue], json.loads(source.read_text(encoding="utf-8")))


def compatibility_fingerprint() -> str:
    return fingerprint(compatibility_contract())


def verify_contract_consistency() -> None:
    """Ensure the executable registry has not drifted from packaged evidence."""

    contract = compatibility_contract()
    packages = contract.get("packages")
    profiles = contract.get("profiles")
    if packages != dict(PACKAGE_PINS):
        raise RuntimeError("Packaged compatibility pins differ from the executable registry")
    if not isinstance(profiles, Mapping) or set(profiles) != set(PROFILES):
        raise RuntimeError("Packaged compatibility profiles differ from the executable registry")
    for profile_id, profile in PROFILES.items():
        item = profiles[profile_id]
        if not isinstance(item, Mapping):
            raise RuntimeError(f"Compatibility profile {profile_id!r} is not an object")
        expected = {
            "adapterId": profile.adapter_id,
            "adapterPackage": profile.adapter_package,
            "adapterVersion": profile.adapter_version,
            "adapterContract": profile.adapter_contract,
            "engineProfile": profile.engine_profile,
            "engineVersions": list(profile.supported_engine_versions),
            "defaultEngineVersion": profile.default_engine_version,
        }
        if any(item.get(key) != value for key, value in expected.items()):
            raise RuntimeError(f"Compatibility profile {profile_id!r} has drifted")


def verify_installed() -> CompatibilityReport:
    """Check installed versions and entry-point metadata without loading Adapter code."""

    verify_contract_consistency()
    observed: dict[str, str] = {}
    failures: list[str] = []
    for package, expected in PACKAGE_PINS.items():
        try:
            actual = metadata.version(package)
        except metadata.PackageNotFoundError:
            failures.append(f"{package} is not installed")
            continue
        observed[package] = actual
        if actual != expected:
            failures.append(f"{package}=={actual} (expected {expected})")

    available = {
        item.name: item for item in metadata.entry_points(group="meridian_storage.adapters")
    }
    entry_points: dict[str, str] = {}
    for name, package in ADAPTER_ENTRY_POINTS.items():
        entry_point = available.get(name)
        if entry_point is None:
            failures.append(f"Adapter entry point {name!r} is missing")
            continue
        distribution_name = "" if entry_point.dist is None else entry_point.dist.name
        entry_points[name] = entry_point.value
        if _canonical_name(distribution_name) != _canonical_name(package):
            failures.append(
                f"Adapter entry point {name!r} belongs to {distribution_name!r}, "
                f"expected {package!r}"
            )

    catalog_names = {item.name for item in metadata.entry_points(group="meridian_storage.catalogs")}
    expected_catalogs = {"structured", "object", "cache", "evidence", "streaming"}
    if catalog_names != expected_catalogs:
        failures.append(
            f"Catalog entry points are {sorted(catalog_names)!r}, "
            f"expected {sorted(expected_catalogs)!r}"
        )
    if failures:
        raise RuntimeError("; ".join(failures))
    return CompatibilityReport(
        dict(sorted(observed.items())),
        dict(sorted(entry_points.items())),
        compatibility_fingerprint(),
    )


def _canonical_name(value: str) -> str:
    return value.lower().replace("_", "-").replace(".", "-")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-installed", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    report: Mapping[str, JsonValue]
    if args.verify_installed:
        report = verify_installed().to_dict()
    else:
        verify_contract_consistency()
        report = compatibility_contract()
    rendered = canonical_json(report) if args.json else json.dumps(report, indent=2, sort_keys=True)
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "CompatibilityReport",
    "compatibility_contract",
    "compatibility_fingerprint",
    "main",
    "verify_contract_consistency",
    "verify_installed",
]
