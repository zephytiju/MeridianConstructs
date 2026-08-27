# SPDX-License-Identifier: Apache-2.0
"""Deterministic fail-closed placement and runtime configuration planning."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from types import MappingProxyType

from ._canonical import JsonValue, canonical_json, fingerprint, normalize_json
from .contracts import (
    BindingSpec,
    CatalogName,
    CatalogProvider,
    DeploymentMode,
    LiveSchemaPolicy,
    PlacementRule,
    PlacementSelector,
    ResourceRef,
    ResourceRequirement,
    SchemaProvider,
    TelemetryPolicy,
    Topology,
    ValidationPolicy,
)
from .errors import ConstructError, ErrorCode
from .profiles import EngineProfile, get_profile

CONFIG_FORMAT_VERSION = "meridian-config.v1"
CONFIG_ENVIRONMENT_VARIABLE = "MERIDIAN_CONFIG"
PROFILE_ENVIRONMENT_VARIABLE = "MERIDIAN_PROFILE"


@dataclass(frozen=True, slots=True)
class DeploymentSpec:
    """Complete caller-owned inputs needed to compile one immutable deployment."""

    profile: str
    catalogs: tuple[CatalogProvider, ...]
    schema_providers: tuple[SchemaProvider, ...]
    resources: tuple[ResourceRequirement, ...]
    bindings: tuple[BindingSpec, ...]
    placements: tuple[PlacementRule, ...]
    live_schemas: LiveSchemaPolicy = field(default_factory=LiveSchemaPolicy)
    validation: ValidationPolicy = field(default_factory=ValidationPolicy)
    telemetry: TelemetryPolicy = field(default_factory=TelemetryPolicy)
    extensions: Mapping[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.profile:
            raise ConstructError(ErrorCode.INVALID_INPUT, "Deployment profile cannot be empty")
        for field_name in ("catalogs", "schema_providers", "resources", "bindings", "placements"):
            if not getattr(self, field_name):
                raise ConstructError(
                    ErrorCode.INVALID_INPUT, f"Deployment {field_name} cannot be empty"
                )
        normalized = normalize_json(self.extensions, path="deployment extensions")
        if not isinstance(normalized, dict):
            raise ConstructError(ErrorCode.INVALID_INPUT, "Deployment extensions must be an object")
        object.__setattr__(self, "extensions", MappingProxyType(normalized))


@dataclass(frozen=True, slots=True)
class ResourceBindingCapability:
    """Platform-facing logical capability without Adapter or Engine identity."""

    resource: ResourceRef
    capability_key: str
    schema_fingerprint: str
    config_fingerprint: str

    def to_dict(self) -> dict[str, str]:
        return {
            "resourceRef": self.resource.canonical,
            "capabilityKey": self.capability_key,
            "schemaFingerprint": self.schema_fingerprint,
            "configFingerprint": self.config_fingerprint,
        }


@dataclass(frozen=True, slots=True)
class DeploymentPlan:
    runtime_config: Mapping[str, JsonValue]
    runtime_config_json: str
    fingerprint: str
    resource_bindings: Mapping[str, ResourceBindingCapability]


@dataclass(frozen=True, slots=True)
class PlanDiff:
    added_resources: tuple[str, ...]
    removed_resources: tuple[str, ...]
    changed_resources: tuple[str, ...]
    config_changed: bool

    @property
    def is_empty(self) -> bool:
        return not (
            self.added_resources
            or self.removed_resources
            or self.changed_resources
            or self.config_changed
        )


def catalog_placement_rules(bindings: Mapping[CatalogName, str]) -> tuple[PlacementRule, ...]:
    """Create explicit one-primary catalog rules from a caller-owned binding map."""

    return tuple(
        PlacementRule(
            id=f"primary-{catalog.value}",
            selector=PlacementSelector(catalog=catalog),
            binding_id=binding_id,
            extensions={"selection": "one-primary"},
        )
        for catalog, binding_id in sorted(bindings.items(), key=lambda item: item[0].value)
    )


def plan_deployment(spec: DeploymentSpec) -> DeploymentPlan:
    """Validate all placement/capability requirements and compile canonical V1 config."""

    catalogs = _unique(spec.catalogs, key=lambda item: item.name, code=ErrorCode.INVALID_INPUT)
    schemas = _unique(
        spec.schema_providers,
        key=lambda item: item.id,
        code=ErrorCode.INVALID_INPUT,
    )
    resources = _unique(
        spec.resources,
        key=lambda item: item.ref,
        code=ErrorCode.DUPLICATE_RESOURCE,
    )
    bindings = _unique(
        spec.bindings,
        key=lambda item: item.id,
        code=ErrorCode.DUPLICATE_BINDING,
    )
    placements = _unique(
        spec.placements,
        key=lambda item: item.id,
        code=ErrorCode.DUPLICATE_PLACEMENT,
    )
    catalog_by_name = {item.name: item for item in catalogs}
    schema_by_id = {item.id: item for item in schemas}
    binding_by_id = {item.id: item for item in bindings}
    profile_by_binding = {item.id: _validate_binding(item) for item in bindings}

    if (
        spec.live_schemas.provider_id is not None
        and spec.live_schemas.provider_id not in schema_by_id
    ):
        raise ConstructError(
            ErrorCode.INVALID_REFERENCE,
            "Live schema policy references an unknown schema provider",
        )
    for rule in placements:
        if rule.binding_id not in binding_by_id:
            raise ConstructError(
                ErrorCode.INVALID_REFERENCE,
                f"Placement {rule.id!r} references unknown binding {rule.binding_id!r}",
            )

    selected: dict[ResourceRef, PlacementRule] = {}
    for requirement in resources:
        if requirement.ref.catalog not in catalog_by_name:
            raise ConstructError(
                ErrorCode.INVALID_REFERENCE,
                f"Resource {requirement.ref.canonical!r} belongs to an unconfigured Catalog",
            )
        if requirement.schema_provider_id not in schema_by_id:
            raise ConstructError(
                ErrorCode.INVALID_REFERENCE,
                f"Resource {requirement.ref.canonical!r} references an unknown schema provider",
            )
        matches = [rule for rule in placements if rule.selector.matches(requirement)]
        if not matches:
            raise ConstructError(
                ErrorCode.MISSING_PLACEMENT,
                f"Resource {requirement.ref.canonical!r} has no placement",
            )
        if len(matches) > 1:
            ids = sorted(rule.id for rule in matches)
            raise ConstructError(
                ErrorCode.AMBIGUOUS_PLACEMENT,
                f"Resource {requirement.ref.canonical!r} matches multiple placements {ids!r}",
            )
        rule = matches[0]
        profile = profile_by_binding[rule.binding_id]
        _validate_capabilities(requirement, profile)
        selected[requirement.ref] = rule

    if spec.validation.require_physical_fingerprints:
        missing = sorted(
            binding.id
            for binding in bindings
            if binding.connection.required_physical_fingerprint is None
        )
        if missing:
            raise ConstructError(
                ErrorCode.INVALID_INPUT,
                f"Strict validation requires physical fingerprints for bindings {missing!r}",
            )

    runtime: dict[str, object] = {
        "formatVersion": CONFIG_FORMAT_VERSION,
        "profile": spec.profile,
        "catalogs": {
            "providers": [item.to_dict() for item in sorted(catalogs, key=lambda item: item.name)],
            "extensions": {},
        },
        "resources": {
            "pins": [
                {
                    "ref": item.ref.to_dict(),
                    "providerId": item.schema_provider_id,
                    "requiredFingerprint": item.schema_fingerprint,
                }
                for item in sorted(resources, key=lambda item: item.ref)
            ],
            "extensions": {},
        },
        "schemas": {
            "providers": [item.to_dict() for item in sorted(schemas, key=lambda item: item.id)],
            "live": spec.live_schemas.to_dict(),
            "extensions": {},
        },
        "bindings": [
            _binding_dict(item, profile_by_binding[item.id])
            for item in sorted(bindings, key=lambda item: item.id)
        ],
        "placements": [item.to_dict() for item in sorted(placements, key=lambda item: item.id)],
        "validation": spec.validation.to_dict(),
        "telemetry": spec.telemetry.to_dict(),
        "extensions": dict(spec.extensions),
    }
    normalized = normalize_json(runtime)
    if not isinstance(normalized, dict):
        raise TypeError("Runtime configuration normalization produced a non-object")
    rendered = canonical_json(normalized)
    config_fingerprint = fingerprint(normalized)
    capabilities = {
        requirement.ref.canonical: ResourceBindingCapability(
            resource=requirement.ref,
            capability_key=(
                "juntai.platform.meridian.resource."
                f"{requirement.ref.catalog.value}.{requirement.ref.namespace}."
                f"{requirement.ref.name}@1.0.0"
            ),
            schema_fingerprint=requirement.schema_fingerprint,
            config_fingerprint=config_fingerprint,
        )
        for requirement in resources
    }
    return DeploymentPlan(
        MappingProxyType(normalized),
        rendered,
        config_fingerprint,
        MappingProxyType(dict(sorted(capabilities.items()))),
    )


def runtime_environment(config_path: str, *, profile: str | None = None) -> Mapping[str, str]:
    """Return only the two deployment-owned runtime selectors."""

    if not config_path:
        raise ConstructError(ErrorCode.INVALID_INPUT, "Runtime config path cannot be empty")
    values = {CONFIG_ENVIRONMENT_VARIABLE: config_path}
    if profile is not None:
        if not profile:
            raise ConstructError(ErrorCode.INVALID_INPUT, "Runtime profile cannot be empty")
        values[PROFILE_ENVIRONMENT_VARIABLE] = profile
    return MappingProxyType(values)


def diff_plans(previous: DeploymentPlan, current: DeploymentPlan) -> PlanDiff:
    before = previous.resource_bindings
    after = current.resource_bindings
    common = set(before) & set(after)
    return PlanDiff(
        added_resources=tuple(sorted(set(after) - set(before))),
        removed_resources=tuple(sorted(set(before) - set(after))),
        changed_resources=tuple(
            sorted(key for key in common if before[key].to_dict() != after[key].to_dict())
        ),
        config_changed=previous.fingerprint != current.fingerprint,
    )


def _unique[T, K](
    values: Sequence[T],
    *,
    key: Callable[[T], K],
    code: ErrorCode,
) -> tuple[T, ...]:
    seen: set[K] = set()
    result: list[T] = []
    for value in values:
        selected = key(value)
        if selected in seen:
            raise ConstructError(code, f"Duplicate deployment identifier {selected!r}")
        seen.add(selected)
        result.append(value)
    return tuple(result)


def _validate_binding(binding: BindingSpec) -> EngineProfile:
    profile = get_profile(binding.profile_id)
    version = binding.engine_version or profile.default_engine_version
    if version not in profile.supported_engine_versions:
        raise ConstructError(
            ErrorCode.VERSION_NOT_PINNED,
            f"Binding {binding.id!r} selects unsupported Engine version {version!r}",
        )
    if binding.mode not in profile.allowed_modes:
        raise ConstructError(
            ErrorCode.INVALID_INPUT,
            f"Binding {binding.id!r} mode {binding.mode.value!r} is unsupported",
        )
    topology = binding.topology
    if topology is None:
        topology = (
            Topology.EXTERNAL
            if binding.mode is DeploymentMode.EXTERNAL
            else profile.default_topology
        )
    if topology not in profile.allowed_topologies:
        raise ConstructError(
            ErrorCode.INVALID_INPUT,
            f"Binding {binding.id!r} topology {topology.value!r} is unsupported",
        )
    for package, observed in binding.compatibility_pins.items():
        expected = profile.compatibility_pins.get(package)
        if expected is not None and observed != expected:
            raise ConstructError(
                ErrorCode.VERSION_NOT_PINNED,
                f"Binding {binding.id!r} pin for {package!r} must be {expected!r}",
            )
    return profile


def _validate_capabilities(requirement: ResourceRequirement, profile: EngineProfile) -> None:
    if requirement.ref.catalog not in profile.catalogs:
        raise ConstructError(
            ErrorCode.INCOMPATIBLE_CATALOG,
            f"Profile {profile.id!r} does not serve {requirement.ref.catalog.value!r}",
        )
    for required in requirement.operations:
        provided = profile.operations.get(required.contract)
        if provided is None or required.version not in provided.versions:
            raise ConstructError(
                ErrorCode.INCOMPATIBLE_OPERATION,
                f"Profile {profile.id!r} does not provide {required.contract}@{required.version}",
            )
        missing_guarantees = sorted(set(required.guarantees) - provided.guarantees)
        if missing_guarantees:
            raise ConstructError(
                ErrorCode.INCOMPATIBLE_GUARANTEE,
                f"Profile {profile.id!r} lacks guarantees {missing_guarantees!r}",
            )
        for name, required_limit in required.limits.items():
            provided_limit = provided.limits.get(name)
            if provided_limit is None or required_limit > provided_limit:
                raise ConstructError(
                    ErrorCode.LIMIT_EXCEEDED,
                    f"Profile {profile.id!r} cannot satisfy limit {name!r}={required_limit}",
                )


def _binding_dict(binding: BindingSpec, profile: EngineProfile) -> dict[str, object]:
    pins = dict(profile.compatibility_pins)
    pins.update(binding.compatibility_pins)
    connection = binding.connection
    version = binding.engine_version or profile.default_engine_version
    return {
        "id": binding.id,
        "adapterId": profile.adapter_id,
        "adapterContract": profile.adapter_contract,
        "engineProfile": profile.engine_profile,
        "engineVersion": version,
        "endpoint": connection.endpoint,
        "serviceRef": connection.service_ref,
        "physicalNamespace": connection.physical_namespace,
        "tls": connection.tls.to_dict(),
        "identityRef": connection.identity_ref.to_dict(),
        "secretRef": connection.secret_ref.to_dict(),
        "client": binding.client.to_dict(),
        "requiredCapabilityFingerprint": binding.required_capability_fingerprint,
        "requiredPhysicalFingerprint": connection.required_physical_fingerprint,
        "compatibilityPins": pins,
        "settings": dict(connection.settings),
        "extensions": {
            **dict(connection.extensions),
            "org.meridian.constructs/deploymentMode": binding.mode.value,
        },
    }


__all__ = [
    "CONFIG_ENVIRONMENT_VARIABLE",
    "CONFIG_FORMAT_VERSION",
    "PROFILE_ENVIRONMENT_VARIABLE",
    "DeploymentPlan",
    "DeploymentSpec",
    "PlanDiff",
    "ResourceBindingCapability",
    "catalog_placement_rules",
    "diff_plans",
    "plan_deployment",
    "runtime_environment",
]
