# SPDX-License-Identifier: Apache-2.0
"""Caller-owned lifecycle, recovery, and validation job declarations."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from types import MappingProxyType

from ._canonical import JsonValue, fingerprint, normalize_json
from .contracts import JobKind, ResourceRef, SecretReference, reject_secret_material
from .errors import ConstructError, ErrorCode

_IMAGE_DIGEST = re.compile(r"^[^\s@]+@sha256:[0-9a-f]{64}$")
_MAX_JOB_TIMEOUT_SECONDS = 86_400
_MAX_JOB_ATTEMPTS = 20


@dataclass(frozen=True, slots=True)
class JobSpec:
    """A declarative job; execution, scheduling, and retries stay with Platform/Vangu."""

    kind: JobKind
    image: str
    resources: tuple[ResourceRef, ...]
    operation: Mapping[str, JsonValue]
    secret_refs: tuple[SecretReference, ...] = ()
    depends_on: tuple[str, ...] = ()
    timeout_seconds: int = 3_600
    max_attempts: int = 1
    extensions: Mapping[str, JsonValue] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "kind", JobKind(self.kind))
        if _IMAGE_DIGEST.fullmatch(self.image) is None:
            raise ConstructError(
                ErrorCode.VERSION_NOT_PINNED,
                "Lifecycle job image must be pinned by sha256 digest",
            )
        if not self.resources or len(self.resources) != len(set(self.resources)):
            raise ConstructError(
                ErrorCode.INVALID_INPUT,
                "Lifecycle job resources must be non-empty and unique",
            )
        object.__setattr__(self, "resources", tuple(sorted(self.resources)))
        reject_secret_material(self.operation, path="job operation")
        operation = normalize_json(self.operation, path="job operation")
        extensions = normalize_json(self.extensions, path="job extensions")
        if not isinstance(operation, dict) or not operation:
            raise ConstructError(ErrorCode.INVALID_INPUT, "Lifecycle job operation cannot be empty")
        if not isinstance(extensions, dict):
            raise ConstructError(
                ErrorCode.INVALID_INPUT, "Lifecycle job extensions must be an object"
            )
        object.__setattr__(self, "operation", MappingProxyType(operation))
        object.__setattr__(self, "extensions", MappingProxyType(extensions))
        dependencies = tuple(sorted(self.depends_on))
        if any(not item for item in dependencies) or len(dependencies) != len(set(dependencies)):
            raise ConstructError(ErrorCode.INVALID_INPUT, "Job dependencies must be unique names")
        object.__setattr__(self, "depends_on", dependencies)
        if not 1 <= self.timeout_seconds <= _MAX_JOB_TIMEOUT_SECONDS:
            raise ConstructError(ErrorCode.INVALID_INPUT, "Job timeout is out of range")
        if not 1 <= self.max_attempts <= _MAX_JOB_ATTEMPTS:
            raise ConstructError(ErrorCode.INVALID_INPUT, "Job max_attempts is out of range")

    @property
    def spec_fingerprint(self) -> str:
        return fingerprint(self.to_dict())

    def to_dict(self) -> dict[str, JsonValue]:
        return {
            "formatVersion": "meridian-constructs-job.v1",
            "kind": self.kind.value,
            "image": self.image,
            "resources": [item.canonical for item in self.resources],
            "operation": self.operation,
            "secretRefs": [item.to_dict() for item in self.secret_refs],
            "dependsOn": list(self.depends_on),
            "timeoutSeconds": self.timeout_seconds,
            "maxAttempts": self.max_attempts,
            "extensions": self.extensions,
        }


def migration_job(
    *,
    image: str,
    resources: Sequence[ResourceRef],
    from_fingerprint: str,
    to_fingerprint: str,
    secret_refs: Sequence[SecretReference] = (),
) -> JobSpec:
    return JobSpec(
        JobKind.MIGRATION,
        image,
        tuple(resources),
        {
            "contract": "meridian.migration.apply",
            "version": "1.0.0",
            "fromFingerprint": from_fingerprint,
            "toFingerprint": to_fingerprint,
        },
        tuple(secret_refs),
    )


def projection_job(
    *, image: str, source: ResourceRef, target: ResourceRef, projection_fingerprint: str
) -> JobSpec:
    return JobSpec(
        JobKind.PROJECTION,
        image,
        (source, target),
        {
            "contract": "meridian.projection.rebuild",
            "version": "1.0.0",
            "projectionFingerprint": projection_fingerprint,
        },
    )


def cache_warm_job(
    *, image: str, source: ResourceRef, cache: ResourceRef, generation: str
) -> JobSpec:
    return JobSpec(
        JobKind.CACHE_WARM,
        image,
        (source, cache),
        {
            "contract": "meridian.cache.warm",
            "version": "1.0.0",
            "namespaceGeneration": generation,
        },
    )


def streaming_bootstrap_job(
    *, image: str, resources: Sequence[ResourceRef], mapping_fingerprint: str
) -> JobSpec:
    return JobSpec(
        JobKind.STREAMING_BOOTSTRAP,
        image,
        tuple(resources),
        {
            "contract": "meridian.streaming.bootstrap",
            "version": "1.0.0",
            "mappingFingerprint": mapping_fingerprint,
        },
    )


def backup_job(*, image: str, resources: Sequence[ResourceRef], policy_ref: str) -> JobSpec:
    return JobSpec(
        JobKind.BACKUP,
        image,
        tuple(resources),
        {"contract": "meridian.recovery.backup", "version": "1.0.0", "policyRef": policy_ref},
    )


def restore_job(
    *, image: str, resources: Sequence[ResourceRef], recovery_point_ref: str
) -> JobSpec:
    return JobSpec(
        JobKind.RESTORE,
        image,
        tuple(resources),
        {
            "contract": "meridian.recovery.restore",
            "version": "1.0.0",
            "recoveryPointRef": recovery_point_ref,
        },
    )


def validation_job(
    *, image: str, resources: Sequence[ResourceRef], expected_config_fingerprint: str
) -> JobSpec:
    return JobSpec(
        JobKind.VALIDATION,
        image,
        tuple(resources),
        {
            "contract": "meridian.deployment.validate",
            "version": "1.0.0",
            "expectedConfigFingerprint": expected_config_fingerprint,
        },
    )


__all__ = [
    "JobSpec",
    "backup_job",
    "cache_warm_job",
    "migration_job",
    "projection_job",
    "restore_job",
    "streaming_bootstrap_job",
    "validation_job",
]
