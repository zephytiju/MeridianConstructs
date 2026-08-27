# SPDX-License-Identifier: Apache-2.0
"""Packaged runtime-config contract access and validation."""

from __future__ import annotations

import json
from collections.abc import Mapping
from importlib import resources
from typing import cast

from ._canonical import JsonValue, normalize_json


def runtime_config_contract() -> Mapping[str, object]:
    """Load the released closed ``meridian-config.v1`` JSON Schema."""

    source = resources.files("meridian_constructs").joinpath(
        "contracts/meridian-config.v1.schema.json"
    )
    return cast(Mapping[str, object], json.loads(source.read_text(encoding="utf-8")))


def validate_runtime_config(value: Mapping[str, JsonValue]) -> None:
    """Validate with jsonschema when the conformance/test extra is installed."""

    try:
        import jsonschema  # type: ignore[import-untyped] # noqa: PLC0415
    except ImportError as exc:
        raise RuntimeError(
            "Runtime schema validation requires meridian-constructs[test] or [conformance]"
        ) from exc
    jsonschema.Draft202012Validator(runtime_config_contract()).validate(normalize_json(value))


__all__ = ["runtime_config_contract", "validate_runtime_config"]
