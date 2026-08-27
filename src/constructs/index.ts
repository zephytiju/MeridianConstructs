// SPDX-License-Identifier: Apache-2.0

import * as pulumi from "@pulumi/pulumi";
import { canonicalJson, normalizeJson, type JsonObject } from "../canonical.js";
import {
  assertBoundedText,
  assertFingerprint,
  assertIdentifier,
  defaultClientPolicy,
  defaultValidationPolicy,
  disabledTelemetryCapability,
  rejectSecretMaterial,
  resourceSelectorKey,
  validateBindingMetadata,
  validateClientPolicy,
  validateEngineConnection,
  validateOpaqueReference,
  validateTlsPolicy,
  type AclPolicyRef,
  type BindingSpecV1,
  type CatalogProviderV1,
  type ClientPolicyV1,
  type DeploymentMode,
  type LiveSchemaPolicyV1,
  type MeridianBindingOutputV1,
  type MeridianCapabilityV1,
  type MeridianResourceRequirementV1,
  type MigrationStateV1,
  type ObservabilityBindingV1,
  type OpaqueIdentityRef,
  type OpaqueSecretRef,
  type PlacementRuleV1,
  type RecoveryCapabilityV1,
  type SchemaProviderV1,
  type TelemetryCapabilityV1,
  type TlsPolicy,
  type Topology,
  type ValidationPolicyV1,
} from "../contracts/index.js";
import { MeridianConstructError, constructErrorCodes } from "../errors.js";
import { getEngineProfile, type EngineProfileV1 } from "../profiles/index.js";
import {
  planDeployment,
  resolvePlacementBindings,
  type DeploymentPlanV1,
  type ResourceBindingCapabilityV1,
} from "../runtime-config/index.js";

const componentType = Object.freeze({
  deployment: "meridian:storage:Deployment",
  externalEngine: "meridian:storage:ExternalEngine",
  managedEngine: "meridian:storage:ManagedEngine",
});

export {
  MeridianOtelCollector,
  collectorEnvironment,
  createOtelCollectorSpec,
  createTelemetryCapability,
} from "./otel.js";
export type {
  CollectorMode,
  CollectorProvisionerV1,
  MeridianOtelCollectorArgsV1,
  OtelCollectorInputV1,
  OtelCollectorSpecV1,
  OtelProtocol,
  OtelSignal,
  TelemetryCapabilityInputV1,
} from "./otel.js";

export interface OpaqueReferenceInputsV1 {
  readonly provider: string;
  readonly reference: string;
}

export interface TlsInputsV1 {
  readonly mode: TlsPolicy["mode"];
  readonly serverName?: string;
  readonly caRef?: OpaqueReferenceInputsV1;
  readonly clientCertificateRef?: OpaqueReferenceInputsV1;
}

export interface EngineConnectionInputsV1 {
  readonly physicalNamespace: pulumi.Input<string>;
  readonly identityRef: OpaqueReferenceInputsV1;
  readonly secretRef: OpaqueReferenceInputsV1;
  readonly tls: TlsInputsV1;
  readonly endpoint?: pulumi.Input<string>;
  readonly serviceRef?: pulumi.Input<string>;
  readonly requiredPhysicalFingerprint?: pulumi.Input<string>;
  readonly settings?: pulumi.Input<JsonObject>;
  readonly extensions?: pulumi.Input<JsonObject>;
}

export interface EngineBindingArgsV1 {
  readonly bindingId: string;
  readonly profileId: string;
  readonly requiredCapabilityFingerprint: string;
  readonly topology?: Topology;
  readonly engineVersion?: string;
  readonly client?: ClientPolicyV1;
  readonly compatibilityPins?: Readonly<Record<string, string>>;
  readonly acl: AclPolicyRef;
  readonly migration: MigrationStateV1;
  readonly observability: ObservabilityBindingV1;
  readonly recovery?: RecoveryCapabilityV1;
}

export interface ExternalEngineArgsV1 {
  readonly binding: EngineBindingArgsV1;
  readonly connection: EngineConnectionInputsV1;
}

export interface ManagedEngineRequestV1 {
  readonly mode: "managed";
  readonly target: string;
  readonly topology: Topology;
  readonly engineVersion: string;
  readonly compute?: JsonObject;
  readonly storage?: JsonObject;
  readonly failureDomains?: readonly string[];
  readonly networkPolicy: JsonObject;
  readonly workloadIdentity: OpaqueIdentityRef;
  readonly acl: AclPolicyRef;
  readonly tls: TlsPolicy;
  readonly retentionReplay?: JsonObject;
  readonly backupDestination?: OpaqueSecretRef;
  readonly rpoSeconds?: number;
  readonly rtoSeconds?: number;
  readonly observability: ObservabilityBindingV1;
  readonly settings?: JsonObject;
  readonly extensions?: JsonObject;
}

export interface ManagedEngineProvisionerV1 {
  provision(
    name: string,
    profile: EngineProfileV1,
    request: ManagedEngineRequestV1,
    options: {
      readonly parent: pulumi.Resource;
      readonly provider: pulumi.ProviderResource;
    },
  ): EngineConnectionInputsV1;
}

export interface ManagedEngineArgsV1 {
  readonly binding: EngineBindingArgsV1;
  readonly provider: pulumi.ProviderResource;
  readonly provisioner: ManagedEngineProvisionerV1;
  readonly request: Omit<
    ManagedEngineRequestV1,
    "mode" | "topology" | "engineVersion"
  >;
}

interface ResolvedBindingInputsV1 {
  readonly physicalNamespace: string;
  readonly endpoint: string | null;
  readonly serviceRef: string | null;
  readonly requiredPhysicalFingerprint: string | null;
  readonly settings: unknown;
  readonly extensions: unknown;
}

type EngineConnectionFactoryV1 = (
  parent: pulumi.Resource,
) => EngineConnectionInputsV1;

export abstract class EngineBinding extends pulumi.ComponentResource {
  public readonly bindingId: string;
  public readonly profile: EngineProfileV1;
  public readonly binding: pulumi.Output<BindingSpecV1>;
  public readonly bindingRef: pulumi.Output<string>;
  public readonly endpoint: pulumi.Output<string>;
  public readonly engineVersion: pulumi.Output<string>;
  public readonly physicalNamespace: pulumi.Output<string>;
  public readonly identity: OpaqueIdentityRef;
  public readonly credentials: OpaqueSecretRef;
  public readonly tls: TlsPolicy;
  public readonly acl: AclPolicyRef;
  public readonly migration: MigrationStateV1;
  public readonly observability: ObservabilityBindingV1;
  public readonly recovery?: RecoveryCapabilityV1;
  public readonly compatibilityPins: Readonly<Record<string, string>>;

  protected constructor(
    type: string,
    name: string,
    args: EngineBindingArgsV1,
    connectionInput: EngineConnectionInputsV1 | EngineConnectionFactoryV1,
    mode: DeploymentMode,
    topology: Topology,
    engineVersion: string,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super(
      type,
      name,
      {
        bindingId: args.bindingId,
        profileId: args.profileId,
        mode,
        topology,
        engineVersion,
      },
      opts,
    );
    this.bindingId = args.bindingId;
    assertIdentifier(args.bindingId, "binding id");
    assertFingerprint(
      args.requiredCapabilityFingerprint,
      "required capability fingerprint",
    );
    validateClientPolicy(args.client ?? defaultClientPolicy);
    validateBindingMetadata(args);
    this.profile = getEngineProfile(args.profileId);
    validateStaticSelection(this.profile, mode, topology, engineVersion);
    const connection =
      typeof connectionInput === "function"
        ? connectionInput(this)
        : connectionInput;
    this.compatibilityPins = Object.freeze({
      ...this.profile.compatibilityPins,
      ...(args.compatibilityPins ?? {}),
    });
    this.bindingRef = pulumi.output(args.bindingId);
    this.identity = Object.freeze({ ...connection.identityRef });
    this.credentials = Object.freeze({ ...connection.secretRef });
    validateOpaqueReference(this.identity, "identity reference");
    validateOpaqueReference(this.credentials, "secret reference");
    this.tls = Object.freeze(resolveTlsInput(connection.tls));
    validateTlsPolicy(this.tls);
    if (
      this.profile.minimumTlsMode === "server" &&
      this.tls.mode === "disabled"
    ) {
      throw new MeridianConstructError(
        constructErrorCodes.invalidInput,
        `Profile ${this.profile.id} requires authenticated TLS`,
      );
    }
    this.acl = Object.freeze({ ...args.acl });
    this.migration = Object.freeze({ ...args.migration });
    this.observability = Object.freeze({
      ...args.observability,
      labels: Object.freeze({ ...args.observability.labels }),
    });
    if (args.recovery !== undefined) {
      this.recovery = Object.freeze({ ...args.recovery });
    }

    const inputValues: Record<string, pulumi.Input<unknown>> = {
      physicalNamespace: connection.physicalNamespace,
      endpoint: connection.endpoint ?? null,
      serviceRef: connection.serviceRef ?? null,
      requiredPhysicalFingerprint:
        connection.requiredPhysicalFingerprint ?? null,
      settings: connection.settings ?? {},
      extensions: connection.extensions ?? {},
    };
    const resolved = pulumi.all(inputValues);
    this.binding = resolved.apply((untypedValue) => {
      const value = untypedValue as unknown as ResolvedBindingInputsV1;
      const engineConnection: BindingSpecV1["connection"] = {
        physicalNamespace: value.physicalNamespace,
        identityRef: this.identity,
        secretRef: this.credentials,
        tls: this.tls,
        endpoint: value.endpoint,
        serviceRef: value.serviceRef,
        requiredPhysicalFingerprint: value.requiredPhysicalFingerprint,
        settings: requireJsonObject(value.settings, "Engine settings"),
        extensions: requireJsonObject(value.extensions, "Engine extensions"),
      };
      validateEngineConnection(engineConnection);
      const binding: BindingSpecV1 = {
        id: args.bindingId,
        profileId: args.profileId,
        requiredCapabilityFingerprint: args.requiredCapabilityFingerprint,
        connection: engineConnection,
        mode,
        topology,
        engineVersion,
        client: args.client ?? defaultClientPolicy,
        compatibilityPins: args.compatibilityPins ?? {},
        acl: this.acl,
        migration: this.migration,
        observability: this.observability,
        ...(this.recovery === undefined ? {} : { recovery: this.recovery }),
      };
      return binding;
    });
    this.endpoint = this.binding.apply(
      (binding) =>
        binding.connection.endpoint ?? binding.connection.serviceRef!,
    );
    this.engineVersion = this.binding.apply((binding) => binding.engineVersion);
    this.physicalNamespace = this.binding.apply(
      (binding) => binding.connection.physicalNamespace,
    );
    this.registerOutputs({
      bindingId: this.bindingRef,
      endpoint: this.endpoint,
      engineVersion: this.engineVersion,
      physicalNamespace: this.physicalNamespace,
      profileId: args.profileId,
    });
  }
}

export class ExternalEngine extends EngineBinding {
  public constructor(
    name: string,
    args: ExternalEngineArgsV1,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    const profile = getEngineProfile(args.binding.profileId);
    super(
      componentType.externalEngine,
      name,
      args.binding,
      args.connection,
      "external",
      args.binding.topology ?? profile.defaultTopology,
      args.binding.engineVersion ?? profile.defaultEngineVersion,
      opts,
    );
  }
}

export class ManagedEngine extends EngineBinding {
  public constructor(
    name: string,
    args: ManagedEngineArgsV1,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    if (args.provider === undefined) {
      throw new MeridianConstructError(
        constructErrorCodes.providerRequired,
        "Managed Engine provisioning requires an explicit provider",
      );
    }
    const profile = getEngineProfile(args.binding.profileId);
    const topology = args.binding.topology ?? profile.defaultTopology;
    const engineVersion =
      args.binding.engineVersion ?? profile.defaultEngineVersion;
    validateStaticSelection(profile, "managed", topology, engineVersion);
    rejectSecretMaterial(
      args.request.settings ?? {},
      "managed Engine settings",
    );
    rejectSecretMaterial(
      args.request.extensions ?? {},
      "managed Engine extensions",
    );
    const request: ManagedEngineRequestV1 = {
      ...args.request,
      mode: "managed",
      topology,
      engineVersion,
    };
    validateManagedRequest(profile, args.binding, request);
    super(
      componentType.managedEngine,
      name,
      args.binding,
      (parent) => {
        const connection = args.provisioner.provision(name, profile, request, {
          parent,
          provider: args.provider,
        });
        if (
          canonicalJson(connection.identityRef) !==
            canonicalJson(request.workloadIdentity) ||
          canonicalJson(resolveTlsInput(connection.tls)) !==
            canonicalJson(request.tls)
        ) {
          throw new MeridianConstructError(
            constructErrorCodes.invalidInput,
            "Managed provisioner returned identity or TLS inputs that differ from the request",
          );
        }
        return connection;
      },
      "managed",
      topology,
      engineVersion,
      opts,
    );
  }
}

function validateManagedRequest(
  profile: EngineProfileV1,
  binding: EngineBindingArgsV1,
  request: ManagedEngineRequestV1,
): void {
  assertBoundedText(request.target, "managed Engine target", 512);
  validateOpaqueReference(request.workloadIdentity, "workload identity");
  validateOpaqueReference(request.acl, "managed ACL policy reference");
  validateTlsPolicy(request.tls);
  if (profile.managedStorage === "required" && request.storage === undefined) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      `Profile ${profile.id} requires an explicit storage policy`,
    );
  }
  if (canonicalJson(request.acl) !== canonicalJson(binding.acl)) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Managed Engine request ACL must match the Binding ACL",
    );
  }
  if (
    canonicalJson(request.observability) !==
    canonicalJson(binding.observability)
  ) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Managed Engine request observability must match the Binding observability policy",
    );
  }
  for (const [path, value] of [
    ["managed Engine compute", request.compute],
    ["managed Engine storage", request.storage],
    ["managed Engine network policy", request.networkPolicy],
    ["managed Engine retention/replay", request.retentionReplay],
    ["managed Engine settings", request.settings],
    ["managed Engine extensions", request.extensions],
  ] as const) {
    if (value !== undefined) {
      requireJsonObject(value, path);
      rejectSecretMaterial(value, path);
    }
  }
  const domains = request.failureDomains ?? [];
  domains.forEach((domain) => assertBoundedText(domain, "failure domain", 512));
  if (new Set(domains).size !== domains.length) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Failure domains must be unique",
    );
  }
  if (request.backupDestination !== undefined) {
    validateOpaqueReference(request.backupDestination, "backup destination");
  }
  for (const [name, value] of [
    ["RPO seconds", request.rpoSeconds],
    ["RTO seconds", request.rtoSeconds],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isInteger(value) || value < 0 || value > 31_536_000)
    ) {
      throw new MeridianConstructError(
        constructErrorCodes.invalidInput,
        `${name} must be a non-negative bounded integer`,
      );
    }
  }
}

export interface MeridianDeploymentArgsV1 {
  readonly profile: string;
  readonly catalogs: readonly CatalogProviderV1[];
  readonly schemaProviders: readonly SchemaProviderV1[];
  readonly resources: readonly MeridianResourceRequirementV1[];
  readonly engines: readonly EngineBinding[];
  readonly placements: readonly PlacementRuleV1[];
  readonly liveSchemas?: LiveSchemaPolicyV1;
  readonly validation?: ValidationPolicyV1;
  readonly telemetry?:
    TelemetryCapabilityV1 | pulumi.Output<TelemetryCapabilityV1>;
  readonly extensions?: JsonObject;
}

export class MeridianDeployment extends pulumi.ComponentResource {
  public readonly plan: pulumi.Output<DeploymentPlanV1>;
  public readonly runtimeConfig: pulumi.Output<JsonObject>;
  public readonly runtimeConfigJson: pulumi.Output<string>;
  public readonly configFingerprint: pulumi.Output<string>;
  public readonly resourceBindings: pulumi.Output<
    Readonly<Record<string, ResourceBindingCapabilityV1>>
  >;
  public readonly bindingOutputs: Readonly<
    Record<string, MeridianBindingOutputV1>
  >;

  public constructor(
    name: string,
    args: MeridianDeploymentArgsV1,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super(componentType.deployment, name, { profile: args.profile }, opts);
    const liveSchemas = args.liveSchemas ?? {
      enabled: false,
      required: false,
      providerId: null,
    };
    const validation = args.validation ?? defaultValidationPolicy;
    const telemetryInput = args.telemetry ?? disabledTelemetryCapability;
    const extensions = args.extensions ?? {};
    const resolvedBindings = pulumi.all(
      args.engines.map((engine) => engine.binding),
    );
    const applyBindings = resolvedBindings.apply.bind(
      resolvedBindings,
    ) as unknown as (
      callback: (bindings: readonly BindingSpecV1[]) => unknown,
    ) => pulumi.Output<unknown>;
    const compile = (
      bindings: readonly BindingSpecV1[],
      telemetry: TelemetryCapabilityV1,
    ): DeploymentPlanV1 =>
      planDeployment({
        profile: args.profile,
        catalogs: args.catalogs,
        schemaProviders: args.schemaProviders,
        resources: args.resources,
        bindings,
        placements: args.placements,
        liveSchemas,
        validation,
        telemetry,
        extensions,
      });
    if (pulumi.Output.isInstance(telemetryInput)) {
      const telemetryOutput = telemetryInput as pulumi.Output<unknown>;
      // Pulumi's recursive Input/Unwrap conditional types exceed TypeScript's
      // instantiation limit for this closed runtime-config object. The runtime
      // value remains validated by planDeployment before it is rendered.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- narrows Pulumi's recursive apply overload to a shallow runtime boundary.
      const applyTelemetry = telemetryOutput.apply.bind(
        telemetryOutput,
      ) as unknown as (
        callback: (value: unknown) => unknown,
      ) => pulumi.Output<unknown>;
      const unresolvedPlan = applyBindings((bindings) =>
        applyTelemetry((value) =>
          compile(bindings, value as TelemetryCapabilityV1),
        ),
      );
      this.plan = unresolvedPlan as pulumi.Output<DeploymentPlanV1>;
    } else {
      this.plan = applyBindings((bindings) =>
        compile(bindings, telemetryInput),
      ) as pulumi.Output<DeploymentPlanV1>;
    }
    this.runtimeConfig = this.plan.apply((plan) => plan.runtimeConfig);
    this.runtimeConfigJson = this.plan.apply((plan) => plan.runtimeConfigJson);
    this.configFingerprint = this.plan.apply((plan) => plan.fingerprint);
    this.resourceBindings = this.plan.apply((plan) => plan.resourceBindings);

    const engineById = new Map<string, EngineBinding>();
    for (const engine of args.engines) {
      if (engineById.has(engine.bindingId)) {
        throw new MeridianConstructError(
          constructErrorCodes.duplicateBinding,
          `Duplicate Engine binding ${engine.bindingId}`,
        );
      }
      engineById.set(engine.bindingId, engine);
    }
    const placementBindings = resolvePlacementBindings(
      args.resources,
      args.placements,
    );
    const bindingOutputs: Record<string, MeridianBindingOutputV1> = {};
    for (const requirement of args.resources) {
      const key = resourceSelectorKey(requirement.selector);
      const bindingId = placementBindings[key];
      const engine =
        bindingId === undefined ? undefined : engineById.get(bindingId);
      if (engine === undefined) {
        throw new MeridianConstructError(
          constructErrorCodes.invalidReference,
          `Resource ${key} resolves to an unknown Engine binding`,
        );
      }
      bindingOutputs[key] = createBindingOutput(requirement, engine);
    }
    this.bindingOutputs = Object.freeze(bindingOutputs);
    this.registerOutputs({
      runtimeConfig: this.runtimeConfig,
      runtimeConfigJson: this.runtimeConfigJson,
      configFingerprint: this.configFingerprint,
      resourceBindings: this.resourceBindings,
    });
  }
}

function createBindingOutput(
  requirement: MeridianResourceRequirementV1,
  engine: EngineBinding,
): MeridianBindingOutputV1 {
  const capabilities: MeridianCapabilityV1[] = requirement.operations.map(
    (operation) => {
      const provided = engine.profile.operations[operation.contract];
      if (provided === undefined) {
        throw new MeridianConstructError(
          constructErrorCodes.incompatibleOperation,
          `Profile ${engine.profile.id} does not provide ${operation.contract}`,
        );
      }
      return Object.freeze({
        operationContract: operation.contract,
        operationVersion: operation.version,
        guarantees: { values: provided.guarantees },
        limits: { values: provided.limits },
        fingerprint: provided.fingerprint,
      });
    },
  );
  const output: MeridianBindingOutputV1 = {
    resource: requirement.selector,
    bindingRef: engine.bindingRef,
    adapterId: engine.profile.adapterId,
    adapterContract: engine.profile.adapterContract,
    engineProfile: engine.profile.engineProfile,
    engineVersion: engine.engineVersion,
    endpoint: engine.endpoint,
    physicalNamespace: engine.physicalNamespace,
    identity: engine.identity,
    credentials: engine.credentials,
    tls: engine.tls,
    acl: engine.acl,
    capabilities: Object.freeze(capabilities),
    compatibility: { packages: engine.compatibilityPins },
    migration: engine.migration,
    observability: engine.observability,
    ...(engine.recovery === undefined ? {} : { recovery: engine.recovery }),
  };
  return Object.freeze(output);
}

function resolveTlsInput(input: TlsInputsV1): TlsPolicy {
  return {
    mode: input.mode,
    serverName: input.serverName ?? null,
    caRef: input.caRef === undefined ? null : Object.freeze({ ...input.caRef }),
    clientCertificateRef:
      input.clientCertificateRef === undefined
        ? null
        : Object.freeze({ ...input.clientCertificateRef }),
  };
}

function requireJsonObject(value: unknown, path: string): JsonObject {
  const normalized = normalizeJson(value, path);
  if (
    normalized === null ||
    Array.isArray(normalized) ||
    typeof normalized !== "object"
  ) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      `${path} must be an object`,
    );
  }
  return normalized as JsonObject;
}

function validateStaticSelection(
  profile: EngineProfileV1,
  mode: DeploymentMode,
  topology: Topology,
  engineVersion: string,
): void {
  if (!profile.supportedEngineVersions.includes(engineVersion)) {
    throw new MeridianConstructError(
      constructErrorCodes.versionNotPinned,
      `Profile ${profile.id} does not support Engine ${engineVersion}`,
    );
  }
  if (
    !profile.allowedModes.includes(mode) ||
    !profile.allowedTopologies.includes(topology)
  ) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      `Profile ${profile.id} does not support ${mode}/${topology}`,
    );
  }
}

export type { JsonObject, JsonValue } from "../canonical.js";
