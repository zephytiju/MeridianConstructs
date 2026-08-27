# SPDX-License-Identifier: Apache-2.0
"""Pulumi components with explicit provider injection and no hidden state authority."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Protocol, cast

import pulumi

from ._canonical import JsonValue
from .contracts import (
    BindingSpec,
    CatalogProvider,
    ClientPolicy,
    DeploymentMode,
    EngineConnection,
    LiveSchemaPolicy,
    PlacementRule,
    ResourceRequirement,
    SchemaProvider,
    SecretReference,
    TelemetryPolicy,
    TLSPolicy,
    Topology,
    ValidationPolicy,
)
from .jobs import JobSpec
from .otel import OtelCollectorSpec
from .planning import DeploymentPlan, DeploymentSpec, plan_deployment
from .profiles import EngineProfile, get_profile


@dataclass(frozen=True, slots=True)
class SecretReferenceInputs:
    provider: pulumi.Input[str]
    reference: pulumi.Input[str]


@dataclass(frozen=True, slots=True)
class TLSInputs:
    mode: str
    server_name: pulumi.Input[str] | None = None
    ca_ref: SecretReferenceInputs | None = None
    client_certificate_ref: SecretReferenceInputs | None = None


@dataclass(frozen=True, slots=True)
class EngineConnectionInputs:
    physical_namespace: pulumi.Input[str]
    identity_ref: SecretReferenceInputs
    secret_ref: SecretReferenceInputs
    tls: TLSInputs
    endpoint: pulumi.Input[str] | None = None
    service_ref: pulumi.Input[str] | None = None
    required_physical_fingerprint: pulumi.Input[str] | None = None
    settings: pulumi.Input[Mapping[str, object]] = field(default_factory=dict)
    extensions: pulumi.Input[Mapping[str, object]] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ManagedEngineRequest:
    mode: DeploymentMode
    topology: Topology
    engine_version: str
    settings: Mapping[str, object] = field(default_factory=dict)


class ManagedEngineProvider(Protocol):
    """Implemented by Platform/Vangu IaC; constructs never create cloud providers."""

    def provision(
        self,
        name: str,
        profile: EngineProfile,
        request: ManagedEngineRequest,
        parent: pulumi.Resource,
    ) -> EngineConnectionInputs: ...


class JobProvisioner(Protocol):
    def provision(
        self, name: str, spec: JobSpec, parent: pulumi.Resource
    ) -> Mapping[str, pulumi.Input[object]]: ...


class CollectorProvisioner(Protocol):
    def provision(
        self, name: str, spec: OtelCollectorSpec, parent: pulumi.Resource
    ) -> Mapping[str, pulumi.Input[object]]: ...


@dataclass(frozen=True, slots=True)
class EngineBindingArgs:
    binding_id: str
    profile_id: str
    required_capability_fingerprint: str
    topology: Topology | None = None
    engine_version: str | None = None
    client: ClientPolicy = field(default_factory=ClientPolicy)
    compatibility_pins: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ExternalEngineArgs:
    binding: EngineBindingArgs
    connection: EngineConnectionInputs


@dataclass(frozen=True, slots=True)
class ManagedEngineArgs:
    binding: EngineBindingArgs
    provider: ManagedEngineProvider
    settings: Mapping[str, object] = field(default_factory=dict)


class EngineBinding(pulumi.ComponentResource):
    binding: pulumi.Output[BindingSpec]

    def _configure_binding(
        self,
        args: EngineBindingArgs,
        connection: EngineConnectionInputs,
        mode: DeploymentMode,
    ) -> None:
        profile = get_profile(args.profile_id)
        selected_version = args.engine_version or profile.default_engine_version
        values: dict[str, pulumi.Input[object]] = {
            "physical_namespace": connection.physical_namespace,
            "identity_provider": connection.identity_ref.provider,
            "identity_reference": connection.identity_ref.reference,
            "secret_provider": connection.secret_ref.provider,
            "secret_reference": connection.secret_ref.reference,
            "endpoint": connection.endpoint,
            "service_ref": connection.service_ref,
            "physical_fingerprint": connection.required_physical_fingerprint,
            "settings": connection.settings,
            "extensions": connection.extensions,
            "tls_server_name": connection.tls.server_name,
            "tls_ca_provider": None
            if connection.tls.ca_ref is None
            else connection.tls.ca_ref.provider,
            "tls_ca_reference": (
                None if connection.tls.ca_ref is None else connection.tls.ca_ref.reference
            ),
            "tls_client_provider": (
                None
                if connection.tls.client_certificate_ref is None
                else connection.tls.client_certificate_ref.provider
            ),
            "tls_client_reference": (
                None
                if connection.tls.client_certificate_ref is None
                else connection.tls.client_certificate_ref.reference
            ),
        }

        def resolve(items: Mapping[str, object]) -> BindingSpec:
            tls = TLSPolicy(
                mode=connection.tls.mode,
                server_name=cast(str | None, items["tls_server_name"]),
                ca_ref=_optional_reference(items, "tls_ca_provider", "tls_ca_reference"),
                client_certificate_ref=_optional_reference(
                    items, "tls_client_provider", "tls_client_reference"
                ),
            )
            resolved_connection = EngineConnection(
                physical_namespace=cast(str, items["physical_namespace"]),
                identity_ref=SecretReference(
                    cast(str, items["identity_provider"]),
                    cast(str, items["identity_reference"]),
                ),
                secret_ref=SecretReference(
                    cast(str, items["secret_provider"]), cast(str, items["secret_reference"])
                ),
                tls=tls,
                endpoint=cast(str | None, items["endpoint"]),
                service_ref=cast(str | None, items["service_ref"]),
                required_physical_fingerprint=cast(str | None, items["physical_fingerprint"]),
                settings=cast(Mapping[str, object], items["settings"]),
                extensions=cast(Mapping[str, object], items["extensions"]),
            )
            return BindingSpec(
                id=args.binding_id,
                profile_id=args.profile_id,
                required_capability_fingerprint=args.required_capability_fingerprint,
                connection=resolved_connection,
                mode=mode,
                topology=args.topology,
                engine_version=selected_version,
                client=args.client,
                compatibility_pins=args.compatibility_pins,
            )

        self.binding = pulumi.Output.all(**values).apply(resolve)
        self.register_outputs({"bindingId": args.binding_id, "profileId": args.profile_id})


class ExternalEngine(EngineBinding):
    """Reference a caller-provisioned Engine without assuming lifecycle authority."""

    def __init__(
        self,
        name: str,
        args: ExternalEngineArgs,
        opts: pulumi.ResourceOptions | None = None,
    ) -> None:
        pulumi.ComponentResource.__init__(
            self, "meridian:constructs:ExternalEngine", name, None, opts
        )
        binding = args.binding
        if binding.topology is None:
            binding = EngineBindingArgs(
                binding.binding_id,
                binding.profile_id,
                binding.required_capability_fingerprint,
                Topology.EXTERNAL,
                binding.engine_version,
                binding.client,
                binding.compatibility_pins,
            )
        self._configure_binding(binding, args.connection, DeploymentMode.EXTERNAL)


class ManagedEngine(EngineBinding):
    """Delegate provisioning to an explicitly supplied Platform/Vangu provider adapter."""

    def __init__(
        self,
        name: str,
        args: ManagedEngineArgs,
        opts: pulumi.ResourceOptions | None = None,
    ) -> None:
        pulumi.ComponentResource.__init__(
            self, "meridian:constructs:ManagedEngine", name, None, opts
        )
        profile = get_profile(args.binding.profile_id)
        selected_topology = args.binding.topology or profile.default_topology
        selected_version = args.binding.engine_version or profile.default_engine_version
        connection = args.provider.provision(
            name,
            profile,
            ManagedEngineRequest(
                DeploymentMode.MANAGED,
                selected_topology,
                selected_version,
                args.settings,
            ),
            self,
        )
        binding = EngineBindingArgs(
            args.binding.binding_id,
            args.binding.profile_id,
            args.binding.required_capability_fingerprint,
            selected_topology,
            selected_version,
            args.binding.client,
            args.binding.compatibility_pins,
        )
        self._configure_binding(binding, connection, DeploymentMode.MANAGED)


@dataclass(frozen=True, slots=True)
class MeridianDeploymentArgs:
    profile: str
    catalogs: Sequence[CatalogProvider]
    schema_providers: Sequence[SchemaProvider]
    resources: Sequence[ResourceRequirement]
    engines: Sequence[EngineBinding]
    placements: Sequence[PlacementRule]
    live_schemas: LiveSchemaPolicy = field(default_factory=LiveSchemaPolicy)
    validation: ValidationPolicy = field(default_factory=ValidationPolicy)
    telemetry: TelemetryPolicy = field(default_factory=TelemetryPolicy)
    extensions: Mapping[str, object] = field(default_factory=dict)


class MeridianDeployment(pulumi.ComponentResource):
    """Compile Engine selections into immutable runtime and logical Platform outputs."""

    plan: pulumi.Output[DeploymentPlan]
    runtime_config: pulumi.Output[Mapping[str, JsonValue]]
    runtime_config_json: pulumi.Output[str]
    config_fingerprint: pulumi.Output[str]
    resource_bindings: pulumi.Output[Mapping[str, Mapping[str, str]]]

    def __init__(
        self,
        name: str,
        args: MeridianDeploymentArgs,
        opts: pulumi.ResourceOptions | None = None,
    ) -> None:
        super().__init__("meridian:constructs:Deployment", name, None, opts)

        def compile_plan(values: Sequence[object]) -> DeploymentPlan:
            return plan_deployment(
                DeploymentSpec(
                    profile=args.profile,
                    catalogs=tuple(args.catalogs),
                    schema_providers=tuple(args.schema_providers),
                    resources=tuple(args.resources),
                    bindings=tuple(cast(BindingSpec, item) for item in values),
                    placements=tuple(args.placements),
                    live_schemas=args.live_schemas,
                    validation=args.validation,
                    telemetry=args.telemetry,
                    extensions=args.extensions,
                )
            )

        self.plan = pulumi.Output.all(*(engine.binding for engine in args.engines)).apply(
            compile_plan
        )
        self.runtime_config = self.plan.apply(lambda plan: plan.runtime_config)
        self.runtime_config_json = self.plan.apply(lambda plan: plan.runtime_config_json)
        self.config_fingerprint = self.plan.apply(lambda plan: plan.fingerprint)
        self.resource_bindings = self.plan.apply(
            lambda plan: {
                key: capability.to_dict() for key, capability in plan.resource_bindings.items()
            }
        )
        self.register_outputs(
            {
                "runtimeConfig": self.runtime_config,
                "runtimeConfigJson": self.runtime_config_json,
                "configFingerprint": self.config_fingerprint,
                "resourceBindings": self.resource_bindings,
            }
        )


class MeridianLifecycleJob(pulumi.ComponentResource):
    def __init__(
        self,
        name: str,
        spec: JobSpec,
        provisioner: JobProvisioner,
        opts: pulumi.ResourceOptions | None = None,
    ) -> None:
        super().__init__("meridian:constructs:LifecycleJob", name, None, opts)
        outputs = provisioner.provision(name, spec, self)
        self.register_outputs({**outputs, "specFingerprint": spec.spec_fingerprint})


class MeridianOtelCollector(pulumi.ComponentResource):
    def __init__(
        self,
        name: str,
        spec: OtelCollectorSpec,
        provisioner: CollectorProvisioner,
        opts: pulumi.ResourceOptions | None = None,
    ) -> None:
        super().__init__("meridian:constructs:OtelCollector", name, None, opts)
        outputs = provisioner.provision(name, spec, self)
        self.register_outputs({**outputs, "specFingerprint": spec.spec_fingerprint})


def _optional_reference(
    values: Mapping[str, object], provider_key: str, reference_key: str
) -> SecretReference | None:
    provider = cast(str | None, values[provider_key])
    reference = cast(str | None, values[reference_key])
    if provider is None and reference is None:
        return None
    if provider is None or reference is None:
        raise ValueError("Opaque reference provider and reference must resolve together")
    return SecretReference(provider, reference)


__all__ = [
    "CollectorProvisioner",
    "EngineBinding",
    "EngineBindingArgs",
    "EngineConnectionInputs",
    "ExternalEngine",
    "ExternalEngineArgs",
    "JobProvisioner",
    "ManagedEngine",
    "ManagedEngineArgs",
    "ManagedEngineProvider",
    "ManagedEngineRequest",
    "MeridianDeployment",
    "MeridianDeploymentArgs",
    "MeridianLifecycleJob",
    "MeridianOtelCollector",
    "SecretReferenceInputs",
    "TLSInputs",
]
