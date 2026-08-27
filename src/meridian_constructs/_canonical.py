# SPDX-License-Identifier: Apache-2.0
"""Canonical JSON helpers shared by plans, fingerprints, and evidence."""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping, Sequence
from typing import cast

type JsonScalar = bool | int | float | str | None
type JsonValue = JsonScalar | Sequence[JsonValue] | Mapping[str, JsonValue]


def normalize_json(value: object, *, path: str = "$") -> JsonValue:
    """Return a detached, deterministic JSON value or reject non-JSON input."""

    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"{path} must contain only finite JSON numbers")
        return value
    if isinstance(value, Mapping):
        if any(not isinstance(key, str) for key in value):
            raise TypeError(f"{path} object keys must be strings")
        source = cast(Mapping[str, object], value)
        return {key: normalize_json(source[key], path=f"{path}.{key}") for key in sorted(source)}
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [normalize_json(item, path=f"{path}[{index}]") for index, item in enumerate(value)]
    raise TypeError(f"{path} must contain JSON-compatible values, not {type(value).__name__}")


def canonical_json(value: object) -> str:
    """Serialize a JSON-compatible value using Meridian's canonical ordering."""

    return json.dumps(
        normalize_json(value),
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def fingerprint(value: object) -> str:
    """Return the stable sha256 fingerprint used by Meridian contracts."""

    digest = hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


__all__ = ["JsonScalar", "JsonValue", "canonical_json", "fingerprint", "normalize_json"]
