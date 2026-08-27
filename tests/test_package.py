# SPDX-License-Identifier: Apache-2.0

from meridian_constructs import __version__, compatibility_contract, runtime_config_contract


def test_package_version() -> None:
    assert __version__ == "0.1.0"


def test_packaged_contracts_are_available() -> None:
    assert runtime_config_contract()["title"] == "Meridian V1 runtime configuration"
    assert compatibility_contract()["formatVersion"] == ("meridian-constructs-compatibility.v1")
