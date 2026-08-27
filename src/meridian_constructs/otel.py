# SPDX-License-Identifier: Apache-2.0
"""OpenTelemetry Collector sidecar and gateway specifications."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from types import MappingProxyType

from ._canonical import JsonValue, fingerprint, normalize_json
from .contracts import SecretReference, reject_secret_material
from .errors import ConstructError, ErrorCode

_IMAGE_DIGEST = re.compile(r"^[^\s@]+@sha256:[0-9a-f]{64}$")
_MAX_COLLECTOR_REPLICAS = 1_000
_MAX_PORT = 65_535


class CollectorMode(StrEnum):
    SIDECAR = "sidecar"
    GATEWAY = "gateway"


@dataclass(frozen=True, slots=True)
class OtelCollectorSpec:
    """A provider-neutral, digest-pinned Collector workload contract."""

    mode: CollectorMode
    image: str
    config: Mapping[str, JsonValue]
    credential_refs: tuple[SecretReference, ...] = ()
    replicas: int = 1
    grpc_port: int = 4317
    http_port: int = 4318
    extensions: Mapping[str, JsonValue] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "mode", CollectorMode(self.mode))
        if _IMAGE_DIGEST.fullmatch(self.image) is None:
            raise ConstructError(
                ErrorCode.VERSION_NOT_PINNED,
                "OTel Collector image must be pinned by sha256 digest",
            )
        expected_replicas = 1 if self.mode is CollectorMode.SIDECAR else None
        if expected_replicas is not None and self.replicas != expected_replicas:
            raise ConstructError(ErrorCode.INVALID_INPUT, "Sidecar Collector must have one replica")
        if not 1 <= self.replicas <= _MAX_COLLECTOR_REPLICAS:
            raise ConstructError(ErrorCode.INVALID_INPUT, "Collector replicas are out of range")
        for name, port in (("grpc", self.grpc_port), ("http", self.http_port)):
            if not 1 <= port <= _MAX_PORT:
                raise ConstructError(ErrorCode.INVALID_INPUT, f"Collector {name} port is invalid")
        reject_secret_material(self.config, path="collector config")
        config = normalize_json(self.config, path="collector config")
        extensions = normalize_json(self.extensions, path="collector extensions")
        if not isinstance(config, dict) or not config:
            raise ConstructError(ErrorCode.INVALID_INPUT, "Collector config cannot be empty")
        if not isinstance(extensions, dict):
            raise ConstructError(ErrorCode.INVALID_INPUT, "Collector extensions must be an object")
        _validate_collector_config(config)
        object.__setattr__(self, "config", MappingProxyType(config))
        object.__setattr__(self, "extensions", MappingProxyType(extensions))

    @property
    def spec_fingerprint(self) -> str:
        return fingerprint(self.to_dict())

    def to_dict(self) -> dict[str, JsonValue]:
        return {
            "formatVersion": "meridian-otel-collector.v1",
            "mode": self.mode.value,
            "image": self.image,
            "replicas": self.replicas,
            "ports": {"grpc": self.grpc_port, "http": self.http_port},
            "config": self.config,
            "credentialRefs": [item.to_dict() for item in self.credential_refs],
            "extensions": self.extensions,
        }


def collector_environment(endpoint: str, *, protocol: str = "grpc") -> Mapping[str, str]:
    if protocol not in {"grpc", "http/protobuf"}:
        raise ConstructError(ErrorCode.INVALID_INPUT, "OTLP protocol is unsupported")
    if not endpoint:
        raise ConstructError(ErrorCode.INVALID_ENDPOINT, "OTLP endpoint cannot be empty")
    return MappingProxyType(
        {"OTEL_EXPORTER_OTLP_ENDPOINT": endpoint, "OTEL_EXPORTER_OTLP_PROTOCOL": protocol}
    )


def _validate_collector_config(config: Mapping[str, JsonValue]) -> None:
    required = {"receivers", "processors", "exporters", "service"}
    missing = required - set(config)
    if missing:
        raise ConstructError(
            ErrorCode.INVALID_INPUT,
            f"Collector config is missing sections {sorted(missing)!r}",
        )
    receivers = config["receivers"]
    service = config["service"]
    if not isinstance(receivers, Mapping) or "otlp" not in receivers:
        raise ConstructError(ErrorCode.INVALID_INPUT, "Collector must configure the OTLP receiver")
    if not isinstance(service, Mapping) or "pipelines" not in service:
        raise ConstructError(ErrorCode.INVALID_INPUT, "Collector must configure service pipelines")


__all__ = ["CollectorMode", "OtelCollectorSpec", "collector_environment"]
