# SPDX-License-Identifier: Apache-2.0
"""Core V1 parsing of packed Constructs output using public Semantics 2.1 pins."""

import copy
import subprocess

import pytest
from fixture import BUNDLE, RESOURCE, SCHEMA, deployment_spec, plan, render
from meridian_storage import ConfigurationError
from meridian_storage.runtime.config import RuntimeConfig
from meridian_storage.semantics import CacheCatalogProvider


def test_public_core_accepts_real_independent_pins():
    assert (
        len(
            {
                BUNDLE.fingerprint,
                RESOURCE.fingerprint,
                SCHEMA.fingerprint,
                SCHEMA.definition["fingerprint"],
            }
        )
        == 4
    )
    rendered = plan(deployment_spec())
    config = RuntimeConfig.from_mapping(rendered["runtimeConfig"])
    assert config.schemas.providers[0].required_fingerprint == BUNDLE.fingerprint
    assert config.resources.pins[0].required_fingerprint == RESOURCE.fingerprint
    assert config.bindings[0].settings["resources"][0]["schemaFingerprint"] == SCHEMA.fingerprint
    assert len(config.catalogs.providers) == 1
    assert config.catalogs.providers[0].name == "structured"
    assert rendered == plan(deployment_spec())


def test_alias_preserves_exact_v1_output():
    explicit = deployment_spec()
    legacy = copy.deepcopy(explicit)
    resource = legacy["resources"][0]["schemas"][0]
    resource["fingerprint"] = resource.pop("resourceFingerprint")
    assert plan(legacy) == plan(explicit)
    resource["resourceFingerprint"] = resource["fingerprint"]
    assert plan(legacy) == plan(explicit)


def test_public_core_accepts_a_larger_supported_subset():
    spec = deployment_spec()
    catalog = CacheCatalogProvider().manifest()
    spec["catalogs"].append(
        {
            "name": catalog.catalog_name,
            "package": catalog.package_name,
            "contract": catalog.catalog_contract_version,
            "requiredFingerprint": catalog.fingerprint,
        }
    )
    config = RuntimeConfig.from_mapping(plan(spec)["runtimeConfig"])
    assert {p.name for p in config.catalogs.providers} == {"structured", "cache"}


@pytest.mark.parametrize("case", ["empty", "duplicate", "unknown", "missing-required"])
def test_catalog_errors_fail_in_renderer_and_core(case):
    spec = deployment_spec()
    config = plan(spec)["runtimeConfig"]
    catalog = spec["catalogs"][0]
    selected = {
        "empty": [],
        "duplicate": [catalog, catalog],
        "unknown": [{**catalog, "name": "audit"}],
        "missing-required": [{**catalog, "name": "evidence"}],
    }[case]
    spec["catalogs"] = selected
    with pytest.raises(subprocess.CalledProcessError):
        plan(spec)
    config["catalogs"]["providers"] = selected
    with pytest.raises(ConfigurationError):
        RuntimeConfig.from_mapping(config)
    with pytest.raises(subprocess.CalledProcessError):
        render({"command": "validate", "config": config})


@pytest.mark.parametrize("kind", ["bundle", "resource"])
@pytest.mark.parametrize("value", [None, "missing", "not-a-fingerprint"])
def test_missing_and_malformed_pins_fail_at_configuration_boundary(kind, value):
    spec = deployment_spec()
    config = plan(spec)["runtimeConfig"]
    item, key, wire = (
        (spec["schemaProviders"][0], "requiredFingerprint", config["schemas"]["providers"][0])
        if kind == "bundle"
        else (
            spec["resources"][0]["schemas"][0],
            "resourceFingerprint",
            config["resources"]["pins"][0],
        )
    )
    if value == "missing":
        del item[key]
        del wire["requiredFingerprint"]
    else:
        item[key] = value
        wire["requiredFingerprint"] = value
    with pytest.raises(subprocess.CalledProcessError):
        plan(spec)
    with pytest.raises(ConfigurationError):
        RuntimeConfig.from_mapping(config)
