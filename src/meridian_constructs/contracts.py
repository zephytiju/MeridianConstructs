# SPDX-License-Identifier: Apache-2.0
"""Public immutable contracts for Meridian deployment planning."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from types import MappingProxyType
from typing import cast
from urllib.parse import urlsplit

from ._canonical import JsonValue, normalize_json
from .errors import ConstructError, ErrorCode

_NAME = re.compile(r"^[A-Za-z](?:[A-Za-z0-9_.-]{0,253}[A-Za-z0-9])?$")
_FINGERPRINT = re.compile(r"^sha256:[0-9a-f]{64}$")
_SENSITIVE_KEY = re.compile(
    r"(?:^|[-_.])(?:access[-_.]?key|credential|password|private[-_.]?key|secret|token)(?:$|[-_.])",
    re.IGNORECASE,
)
_CONTROL_CHARACTER_BOUNDARY = 32
_DELETE_CHARACTER = 127
_MAX_RETRY_ATTEMPTS = 20
_MAX_RETRY_BASE_DELAY_MS = 60_000
_MAX_RETRY_DELAY_MS = 600_000
_MAX_OPERATION_TIMEOUT_MS = 3_600_000
_MAX_IDEMPOTENCY_ENTRIES = 1_000_000


def _name(value: str, path: str, *, maximum: int = 255) -> str:
    if not isinstance(value, str) or len(value) > maximum or _NAME.fullmatch(value) is None:
        raise ConstructError(ErrorCode.INVALID_INPUT, f"{path} is not a valid identifier")
    return value


def _text(value: str, path: str, *, maximum: int = 2048) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value.encode()) > maximum
        or any(
            ord(character) < _CONTROL_CHARACTER_BOUNDARY or ord(character) == _DELETE_CHARACTER
            for character in value
        )
    ):
        raise ConstructError(ErrorCode.INVALID_INPUT, f"{path} must be bounded non-empty text")
    return value


def _fingerprint(value: str, path: str) -> str:
    if _FINGERPRINT.fullmatch(value) is None:
        raise ConstructError(ErrorCode.INVALID_INPUT, f"{path} must be a sha256 fingerprint")
    return value


def _strings(values: Sequence[str], path: str) -> tuple[str, ...]:
    result = tuple(sorted(_text(value, path, maximum=512) for value in values))
    if len(result) != len(set(result)):
        raise ConstructError(ErrorCode.INVALID_INPUT, f"{path} entries must be unique")
    return result


def _string_map(values: Mapping[str, str], path: str) -> Mapping[str, str]:
    normalized = {
        _text(key, f"{path} key", maximum=128): _text(value, f"{path}.{key}", maximum=512)
        for key, value in values.items()
    }
    return MappingProxyType(dict(sorted(normalized.items())))


def _json_map(values: Mapping[str, object], path: str) -> Mapping[str, JsonValue]:
    normalized = normalize_json(values, path=path)
    if not isinstance(normalized, dict):
        raise TypeError(f"{path} must be an object")
    return MappingProxyType(normalized)


def reject_secret_material(value: object, *, path: str = "settings") -> None:
    """Reject likely inline credentials while allowing opaque reference objects."""

    if isinstance(value, Mapping):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ConstructError(ErrorCode.INVALID_INPUT, f"{path} keys must be strings")
            if _SENSITIVE_KEY.search(key):
                raise ConstructError(
                    ErrorCode.SECRET_MATERIAL,
                    f"{path}.{key} looks like inline secret material; use secretRef",
                )
            reject_secret_material(item, path=f"{path}.{key}")
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for index, item in enumerate(value):
            reject_secret_material(item, path=f"{path}[{index}]")


class CatalogName(StrEnum):
    """The exact closed Meridian V1 Catalog registry."""

    STRUCTURED = "structured"
    OBJECT = "object"
    CACHE = "cache"
    EVIDENCE = "evidence"
    STREAMING = "streaming"


class DeploymentMode(StrEnum):
    MANAGED = "managed"
    EXTERNAL = "external"


class Topology(StrEnum):
    SINGLE_PRIMARY = "single-primary"
    CLUSTER = "cluster"
    EXTERNAL = "external"
    TEST = "test"


class JobKind(StrEnum):
    MIGRATION = "migration"
    PROJECTION = "projection"
    CACHE_WARM = "cache-warm"
    STREAMING_BOOTSTRAP = "streaming-bootstrap"
    BACKUP = "backup"
    RESTORE = "restore"
    VALIDATION = "validation"


@dataclass(frozen=True, slots=True, order=True)
class ResourceRef:
    catalog: CatalogName
    namespace: str
    name: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "catalog", CatalogName(self.catalog))
        _name(self.namespace, "resource namespace")
        _name(self.name, "resource name")

    @property
    def canonical(self) -> str:
        return f"{self.catalog.value}:{self.namespace}.{self.name}"

    @classmethod
    def parse(cls, value: str | Mapping[str, object]) -> ResourceRef:
        if isinstance(value, str):
            match = re.fullmatch(
                r"(structured|object|cache|evidence|streaming):([A-Za-z][A-Za-z0-9_.-]*)\."
                r"([A-Za-z][A-Za-z0-9_.-]*)",
                value,
            )
            if match is None:
                raise ConstructError(ErrorCode.INVALID_REFERENCE, "Resource reference is invalid")
            return cls(CatalogName(match.group(1)), match.group(2), match.group(3))
        expected = {"catalog", "namespace", "name"}
        if set(value) != expected or any(not isinstance(value[key], str) for key in expected):
            raise ConstructError(
                ErrorCode.INVALID_REFERENCE, "Resource reference object is invalid"
            )
        return cls(
            CatalogName(cast(str, value["catalog"])),
            cast(str, value["namespace"]),
            cast(str, value["name"]),
        )

    def to_dict(self) -> dict[str, str]:
        return {"catalog": self.catalog.value, "namespace": self.namespace, "name": self.name}


@dataclass(frozen=True, slots=True)
class SecretReference:
    """An opaque deployment-owned identity or secret-manager reference."""

    provider: str
    reference: str = field(repr=False)

    def __post_init__(self) -> None:
        _name(self.provider, "secret provider", maximum=128)
        _text(self.reference, "secret reference")

    def to_dict(self) -> dict[str, str]:
        return {"provider": self.provider, "reference": self.reference}


@dataclass(frozen=True, slots=True)
class TLSPolicy:
    mode: str = "server"
    server_name: str | None = None
    ca_ref: SecretReference | None = None
    client_certificate_ref: SecretReference | None = None

    def __post_init__(self) -> None:
        if self.mode not in {"disabled", "server", "mutual"}:
            raise ConstructError(
                ErrorCode.INVALID_INPUT, "TLS mode must be disabled, server, or mutual"
            )
        if self.mode == "disabled" and any(
            item is not None
            for item in (self.server_name, self.ca_ref, self.client_certificate_ref)
        ):
            raise ConstructError(ErrorCode.INVALID_INPUT, "Disabled TLS cannot carry TLS material")
        if self.mode in {"server", "mutual"} and (self.server_name is None or self.ca_ref is None):
            raise ConstructError(
                ErrorCode.INVALID_INPUT,
                "Authenticated TLS requires server_name and ca_ref",
            )
        if self.mode == "server" and self.client_certificate_ref is not None:
            raise ConstructError(
                ErrorCode.INVALID_INPUT,
                "Server TLS cannot carry a client certificate",
            )
        if self.mode == "mutual" and self.client_certificate_ref is None:
            raise ConstructError(
                ErrorCode.INVALID_INPUT, "Mutual TLS requires a client certificate"
            )
        if self.server_name is not None:
            _text(self.server_name, "TLS server name", maximum=512)

    @classmethod
    def disabled(cls) -> TLSPolicy:
        return cls(mode="disabled")

    def to_dict(self) -> dict[str, JsonValue]:
        return {
            "mode": self.mode,
            "serverName": self.server_name,
            "caRef": None if self.ca_ref is None else self.ca_ref.to_dict(),
            "clientCertificateRef": (
                None
                if self.client_certificate_ref is None
                else self.client_certificate_ref.to_dict()
            ),
        }


@dataclass(frozen=True, slots=True)
class ClientPolicy:
    min_size: int = 0
    max_size: int = 20
    acquire_timeout_ms: int = 5_000
    idle_timeout_ms: int = 60_000
    operation_timeout_ms: int = 30_000
    max_result_bytes: int = 16 * 1024 * 1024
    iterator_lifetime_ms: int = 300_000

    def __post_init__(self) -> None:
        ranges = {
            "min_size": (self.min_size, 0, 10_000),
            "max_size": (self.max_size, 1, 10_000),
            "acquire_timeout_ms": (self.acquire_timeout_ms, 1, 3_600_000),
            "idle_timeout_ms": (self.idle_timeout_ms, 0, 86_400_000),
            "operation_timeout_ms": (self.operation_timeout_ms, 1, 3_600_000),
            "max_result_bytes": (self.max_result_bytes, 1, 2_147_483_647),
            "iterator_lifetime_ms": (self.iterator_lifetime_ms, 1, 86_400_000),
        }
        for name, (value, minimum, maximum) in ranges.items():
            if isinstance(value, bool) or not minimum <= value <= maximum:
                raise ConstructError(ErrorCode.INVALID_INPUT, f"Client {name} is out of range")
        if self.min_size > self.max_size:
            raise ConstructError(ErrorCode.INVALID_INPUT, "Client min_size cannot exceed max_size")

    def to_dict(self) -> dict[str, int]:
        return {
            "minSize": self.min_size,
            "maxSize": self.max_size,
            "acquireTimeoutMs": self.acquire_timeout_ms,
            "idleTimeoutMs": self.idle_timeout_ms,
            "operationTimeoutMs": self.operation_timeout_ms,
            "maxResultBytes": self.max_result_bytes,
            "iteratorLifetimeMs": self.iterator_lifetime_ms,
        }


@dataclass(frozen=True, slots=True)
class OperationRequirement:
    contract: str
    version: str = "1.0.0"
    guarantees: tuple[str, ...] = ()
    limits: Mapping[str, int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _text(self.contract, "operation contract", maximum=256)
        _text(self.version, "operation version", maximum=64)
        object.__setattr__(self, "guarantees", _strings(self.guarantees, "operation guarantee"))
        normalized: dict[str, int] = {}
        for name, value in self.limits.items():
            _text(name, "operation limit", maximum=128)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ConstructError(
                    ErrorCode.INVALID_INPUT, f"Operation limit {name!r} is invalid"
                )
            normalized[name] = value
        object.__setattr__(self, "limits", MappingProxyType(dict(sorted(normalized.items()))))


@dataclass(frozen=True, slots=True)
class ResourceRequirement:
    ref: ResourceRef
    schema_provider_id: str
    schema_fingerprint: str
    operations: tuple[OperationRequirement, ...]
    labels: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _name(self.schema_provider_id, "schema provider id")
        _fingerprint(self.schema_fingerprint, "schema fingerprint")
        if not self.operations:
            raise ConstructError(ErrorCode.INVALID_INPUT, "Resource operations cannot be empty")
        contracts = [item.contract for item in self.operations]
        if len(contracts) != len(set(contracts)):
            raise ConstructError(
                ErrorCode.INVALID_INPUT, "Resource operation contracts must be unique"
            )
        object.__setattr__(
            self, "operations", tuple(sorted(self.operations, key=lambda item: item.contract))
        )
        object.__setattr__(self, "labels", _string_map(self.labels, "resource labels"))


@dataclass(frozen=True, slots=True)
class CatalogProvider:
    name: CatalogName
    package: str
    contract: str
    required_fingerprint: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", CatalogName(self.name))
        _text(self.package, "catalog package", maximum=256)
        _text(self.contract, "catalog contract", maximum=64)
        _fingerprint(self.required_fingerprint, "catalog fingerprint")

    def to_dict(self) -> dict[str, str]:
        return {
            "name": self.name.value,
            "package": self.package,
            "contract": self.contract,
            "requiredFingerprint": self.required_fingerprint,
        }


@dataclass(frozen=True, slots=True)
class SchemaProvider:
    id: str
    package: str
    contract: str
    required_fingerprint: str

    def __post_init__(self) -> None:
        _name(self.id, "schema provider id")
        _text(self.package, "schema package", maximum=256)
        _text(self.contract, "schema contract", maximum=64)
        _fingerprint(self.required_fingerprint, "schema provider fingerprint")

    def to_dict(self) -> dict[str, str]:
        return {
            "id": self.id,
            "package": self.package,
            "contract": self.contract,
            "requiredFingerprint": self.required_fingerprint,
        }


@dataclass(frozen=True, slots=True)
class LiveSchemaPolicy:
    enabled: bool = False
    required: bool = False
    provider_id: str | None = None

    def __post_init__(self) -> None:
        if self.required and not self.enabled:
            raise ConstructError(ErrorCode.INVALID_INPUT, "Required live schemas must be enabled")
        if self.enabled != (self.provider_id is not None):
            raise ConstructError(
                ErrorCode.INVALID_INPUT,
                "Live schema provider_id must be set exactly when live schemas are enabled",
            )
        if self.provider_id is not None:
            _name(self.provider_id, "live schema provider id")

    def to_dict(self) -> dict[str, JsonValue]:
        return {"enabled": self.enabled, "required": self.required, "providerId": self.provider_id}


@dataclass(frozen=True, slots=True)
class EngineConnection:
    """Resolved endpoint references; never raw identity or credential bytes."""

    physical_namespace: str
    identity_ref: SecretReference
    secret_ref: SecretReference
    tls: TLSPolicy
    endpoint: str | None = None
    service_ref: str | None = None
    required_physical_fingerprint: str | None = None
    settings: Mapping[str, object] = field(default_factory=dict)
    extensions: Mapping[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _text(self.physical_namespace, "physical namespace", maximum=512)
        if (self.endpoint is None) == (self.service_ref is None):
            raise ConstructError(
                ErrorCode.INVALID_ENDPOINT,
                "Engine connection requires exactly one of endpoint or service_ref",
            )
        if self.endpoint is not None:
            _validate_endpoint(self.endpoint)
        if self.service_ref is not None:
            _text(self.service_ref, "service reference", maximum=512)
        if self.required_physical_fingerprint is not None:
            _fingerprint(self.required_physical_fingerprint, "physical fingerprint")
        reject_secret_material(self.settings)
        object.__setattr__(self, "settings", _json_map(self.settings, "settings"))
        object.__setattr__(self, "extensions", _json_map(self.extensions, "extensions"))


def _validate_endpoint(value: str) -> None:
    _text(value, "endpoint")
    parsed = urlsplit(value)
    if (
        not parsed.scheme
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise ConstructError(
            ErrorCode.INVALID_ENDPOINT,
            "Endpoint must be an absolute URI without credentials or fragments",
        )


@dataclass(frozen=True, slots=True)
class BindingSpec:
    id: str
    profile_id: str
    required_capability_fingerprint: str
    connection: EngineConnection
    mode: DeploymentMode = DeploymentMode.EXTERNAL
    topology: Topology | None = None
    engine_version: str | None = None
    client: ClientPolicy = field(default_factory=ClientPolicy)
    compatibility_pins: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _name(self.id, "binding id")
        _text(self.profile_id, "profile id", maximum=128)
        _fingerprint(self.required_capability_fingerprint, "capability fingerprint")
        object.__setattr__(self, "mode", DeploymentMode(self.mode))
        if self.topology is not None:
            object.__setattr__(self, "topology", Topology(self.topology))
        if self.engine_version is not None:
            _text(self.engine_version, "engine version", maximum=64)
        object.__setattr__(
            self,
            "compatibility_pins",
            _string_map(self.compatibility_pins, "compatibility pins"),
        )


@dataclass(frozen=True, slots=True)
class PlacementSelector:
    resources: tuple[ResourceRef, ...] = ()
    catalog: CatalogName | None = None
    labels: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.catalog is not None:
            object.__setattr__(self, "catalog", CatalogName(self.catalog))
        if not self.resources and self.catalog is None and not self.labels:
            raise ConstructError(ErrorCode.INVALID_INPUT, "Placement selector cannot be empty")
        if len(self.resources) != len(set(self.resources)):
            raise ConstructError(ErrorCode.INVALID_INPUT, "Placement resources must be unique")
        object.__setattr__(self, "resources", tuple(sorted(self.resources)))
        object.__setattr__(self, "labels", _string_map(self.labels, "placement labels"))

    def matches(self, requirement: ResourceRequirement) -> bool:
        exact = not self.resources or requirement.ref in self.resources
        catalog = self.catalog is None or requirement.ref.catalog is self.catalog
        labels = all(requirement.labels.get(key) == value for key, value in self.labels.items())
        return exact and catalog and labels

    def to_dict(self) -> dict[str, JsonValue]:
        return {
            "resources": [item.to_dict() for item in self.resources],
            "catalog": None if self.catalog is None else self.catalog.value,
            "labels": dict(self.labels),
        }


@dataclass(frozen=True, slots=True)
class PlacementRule:
    id: str
    selector: PlacementSelector
    binding_id: str
    extensions: Mapping[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _name(self.id, "placement id")
        _name(self.binding_id, "placement binding id")
        object.__setattr__(self, "extensions", _json_map(self.extensions, "placement extensions"))

    def to_dict(self) -> dict[str, JsonValue]:
        return {
            "id": self.id,
            "selector": self.selector.to_dict(),
            "bindingId": self.binding_id,
            "extensions": cast(JsonValue, dict(self.extensions)),
        }


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    max_attempts: int = 3
    base_delay_ms: int = 100
    max_delay_ms: int = 5_000
    jitter_ratio: float = 0.2

    def __post_init__(self) -> None:
        if not 1 <= self.max_attempts <= _MAX_RETRY_ATTEMPTS:
            raise ConstructError(ErrorCode.INVALID_INPUT, "Retry max_attempts is out of range")
        if (
            not 0 <= self.base_delay_ms <= _MAX_RETRY_BASE_DELAY_MS
            or not 0 <= self.max_delay_ms <= _MAX_RETRY_DELAY_MS
        ):
            raise ConstructError(ErrorCode.INVALID_INPUT, "Retry delays are out of range")
        if self.base_delay_ms > self.max_delay_ms:
            raise ConstructError(ErrorCode.INVALID_INPUT, "Retry base delay exceeds max delay")
        if not 0 <= self.jitter_ratio <= 1:
            raise ConstructError(ErrorCode.INVALID_INPUT, "Retry jitter_ratio is out of range")

    def to_dict(self) -> dict[str, JsonValue]:
        return {
            "maxAttempts": self.max_attempts,
            "baseDelayMs": self.base_delay_ms,
            "maxDelayMs": self.max_delay_ms,
            "jitterRatio": self.jitter_ratio,
        }


@dataclass(frozen=True, slots=True)
class ValidationPolicy:
    require_physical_fingerprints: bool = True
    default_operation_timeout_ms: int = 30_000
    idempotency_cache_entries: int = 10_000
    retry: RetryPolicy = field(default_factory=RetryPolicy)

    def __post_init__(self) -> None:
        if not 1 <= self.default_operation_timeout_ms <= _MAX_OPERATION_TIMEOUT_MS:
            raise ConstructError(
                ErrorCode.INVALID_INPUT, "Default operation timeout is out of range"
            )
        if not 1 <= self.idempotency_cache_entries <= _MAX_IDEMPOTENCY_ENTRIES:
            raise ConstructError(ErrorCode.INVALID_INPUT, "Idempotency cache size is out of range")

    def to_dict(self) -> dict[str, JsonValue]:
        return {
            "strict": True,
            "requirePhysicalFingerprints": self.require_physical_fingerprints,
            "defaultOperationTimeoutMs": self.default_operation_timeout_ms,
            "idempotencyCacheEntries": self.idempotency_cache_entries,
            "retry": self.retry.to_dict(),
        }


@dataclass(frozen=True, slots=True)
class TelemetryPolicy:
    enabled: bool = False
    service_name: str | None = None
    attributes: Mapping[str, str] = field(default_factory=dict)
    extensions: Mapping[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.enabled != (self.service_name is not None):
            raise ConstructError(
                ErrorCode.INVALID_INPUT,
                "Telemetry service_name must be set exactly when telemetry is enabled",
            )
        if self.service_name is not None:
            _text(self.service_name, "telemetry service name", maximum=512)
        object.__setattr__(self, "attributes", _string_map(self.attributes, "telemetry attributes"))
        object.__setattr__(self, "extensions", _json_map(self.extensions, "telemetry extensions"))

    def to_dict(self) -> dict[str, JsonValue]:
        return {
            "enabled": self.enabled,
            "serviceName": self.service_name,
            "suppressExporterRecursion": True,
            "attributes": dict(self.attributes),
            "extensions": cast(JsonValue, dict(self.extensions)),
        }


__all__ = [
    "BindingSpec",
    "CatalogName",
    "CatalogProvider",
    "ClientPolicy",
    "DeploymentMode",
    "EngineConnection",
    "JobKind",
    "LiveSchemaPolicy",
    "OperationRequirement",
    "PlacementRule",
    "PlacementSelector",
    "ResourceRef",
    "ResourceRequirement",
    "RetryPolicy",
    "SchemaProvider",
    "SecretReference",
    "TLSPolicy",
    "TelemetryPolicy",
    "Topology",
    "ValidationPolicy",
    "reject_secret_material",
]
