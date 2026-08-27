# SPDX-License-Identifier: Apache-2.0

from meridian_constructs import __version__


def test_package_version() -> None:
    assert __version__ == "0.1.0"
