// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import {
  canonicalJson,
  fingerprint,
  normalizeJson,
  type JsonObject,
} from "../canonical.js";
import {
  assertBoundedText,
  assertFingerprint,
  assertIdentifier,
  catalogNames,
  resourceSelectorKey,
  validateBindingMetadata,
  validateClientPolicy,
  validateEngineConnection,
  validatePlacementSelector,
  validateResourceRequirement,
  validateTelemetryCapability,
  validateValidationPolicy,
  type BindingSpecV1,
  type CatalogName,
  type DeploymentSpecV1,
  type MeridianResourceRequirementV1,
  type PlacementRuleV1,
} from "../contracts/index.js";
import { MeridianConstructError, constructErrorCodes } from "../errors.js";
import { getEngineProfile, type EngineProfileV1 } from "../profiles/index.js";

export const configFormatVersion = "meridian-config.v1" as const;
export const configEnvironmentVariable = "MERIDIAN_CONFIG" as const;
export const profileEnvironmentVariable = "MERIDIAN_PROFILE" as const;

export interface ResourceBindingCapabilityV1 {
  readonly resourceRef: string;
  readonly capabilityKey: string;
  readonly schemaFingerprint: string;
  readonly configFingerprint: string;
}

export interface DeploymentPlanV1 {
  readonly runtimeConfig: JsonObject;
  readonly runtimeConfigJson: string;
  readonly fingerprint: string;
  readonly resourceBindings: Readonly<
    Record<string, ResourceBindingCapabilityV1>
  >;
  readonly placementBindings: Readonly<Record<string, string>>;
}

export interface PlanDiffV1 {
  readonly addedResources: readonly string[];
  readonly removedResources: readonly string[];
  readonly changedResources: readonly string[];
  readonly configChanged: boolean;
  readonly isEmpty: boolean;
}

const schemaUrl = new URL(
  "../../contracts/meridian-config.v1.schema.json",
  import.meta.url,
);
const runtimeSchema = JSON.parse(readFileSync(schemaUrl, "utf8")) as object;
// The released Core schema narrows parent-typed properties inside `anyOf` branches.
// Keep every other strict-mode check while allowing that valid Draft 2020-12 pattern.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
const validateSchema = ajv.compile<JsonObject>(runtimeSchema);

export function runtimeConfigContract(): object {
  return structuredClone(runtimeSchema);
}

export function validateRuntimeConfig(
  value: unknown,
): asserts value is JsonObject {
  if (!validateSchema(value)) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      `Runtime configuration is invalid: ${formatSchemaErrors(validateSchema.errors ?? [])}`,
    );
  }
}

export function catalogPlacementRules(
  bindings: Readonly<Partial<Record<CatalogName, string>>>,
): readonly PlacementRuleV1[] {
  return Object.entries(bindings)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([catalog, bindingId]) => {
      if (bindingId === undefined) {
        throw new MeridianConstructError(
          constructErrorCodes.invalidReference,
          `Catalog ${catalog} has no binding identifier`,
        );
      }
      return {
        id: `primary-${catalog}`,
        selector: {
          resources: [],
          catalog: catalog as CatalogName,
          labels: {},
        },
        bindingId,
        extensions: { selection: "one-primary" },
      };
    });
}

export function planDeployment(spec: DeploymentSpecV1): DeploymentPlanV1 {
  assertBoundedText(spec.profile, "deployment profile", 512);
  if (
    spec.catalogs.length === 0 ||
    spec.schemaProviders.length === 0 ||
    spec.resources.length === 0 ||
    spec.bindings.length === 0 ||
    spec.placements.length === 0
  ) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Catalogs, schemas, resources, bindings, and placements must be non-empty",
    );
  }

  const catalogs = uniqueBy(
    spec.catalogs,
    (item) => item.name,
    constructErrorCodes.invalidInput,
  );
  const configuredCatalogs = catalogs.map((item) => item.name).sort();
  if (
    configuredCatalogs.length !== catalogNames.length ||
    configuredCatalogs.some(
      (item, index) => item !== [...catalogNames].sort()[index],
    )
  ) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      `Catalog registry must be exactly ${catalogNames.join(", ")}`,
    );
  }
  for (const catalog of catalogs) {
    assertBoundedText(catalog.package, "Catalog package", 256);
    assertBoundedText(catalog.contract, "Catalog contract", 64);
    assertFingerprint(catalog.requiredFingerprint, "Catalog fingerprint");
  }

  const schemaProviders = uniqueBy(
    spec.schemaProviders,
    (item) => item.id,
    constructErrorCodes.invalidInput,
  );
  const schemasById = new Map(schemaProviders.map((item) => [item.id, item]));
  for (const schema of schemaProviders) {
    assertIdentifier(schema.id, "schema provider id");
    assertBoundedText(schema.package, "schema package", 256);
    assertBoundedText(schema.contract, "schema contract", 64);
    assertFingerprint(
      schema.requiredFingerprint,
      "schema provider fingerprint",
    );
  }

  const resources = uniqueBy(
    spec.resources,
    (item) => resourceSelectorKey(item.selector),
    constructErrorCodes.duplicateResource,
  );
  resources.forEach(validateResourceRequirement);
  for (const resource of resources) {
    for (const schema of resource.schemas) {
      const provider = schemasById.get(schema.providerId);
      if (provider === undefined) {
        throw new MeridianConstructError(
          constructErrorCodes.invalidReference,
          `${resourceSelectorKey(resource.selector)} references an unknown schema provider`,
        );
      }
      if (provider.requiredFingerprint !== schema.fingerprint) {
        throw new MeridianConstructError(
          constructErrorCodes.invalidReference,
          `${resourceSelectorKey(resource.selector)} schema fingerprint differs from its provider`,
        );
      }
    }
  }

  const bindings = uniqueBy(
    spec.bindings,
    (item) => item.id,
    constructErrorCodes.duplicateBinding,
  );
  const bindingsById = new Map(bindings.map((item) => [item.id, item]));
  const profilesByBinding = new Map<string, EngineProfileV1>();
  for (const binding of bindings) {
    profilesByBinding.set(binding.id, validateBinding(binding));
  }

  const placements = uniqueBy(
    spec.placements,
    (item) => item.id,
    constructErrorCodes.duplicatePlacement,
  );
  for (const placement of placements) {
    assertIdentifier(placement.id, "placement id");
    assertIdentifier(placement.bindingId, "placement binding id");
    validatePlacementSelector(placement.selector);
    if (!bindingsById.has(placement.bindingId)) {
      throw new MeridianConstructError(
        constructErrorCodes.invalidReference,
        `Placement ${placement.id} references an unknown binding`,
      );
    }
  }

  if (spec.liveSchemas.required && !spec.liveSchemas.enabled) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Required live schemas must be enabled",
    );
  }
  if (spec.liveSchemas.enabled !== (spec.liveSchemas.providerId !== null)) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Live schema provider must be set exactly when live schemas are enabled",
    );
  }
  if (
    spec.liveSchemas.providerId !== null &&
    !schemasById.has(spec.liveSchemas.providerId)
  ) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidReference,
      "Live schema policy references an unknown provider",
    );
  }
  validateValidationPolicy(spec.validation);
  validateTelemetryCapability(spec.telemetry);

  const placementBindings = resolvePlacementBindings(resources, placements);
  for (const requirement of resources) {
    const resourceKey = resourceSelectorKey(requirement.selector);
    const bindingId = placementBindings[resourceKey];
    if (bindingId === undefined) {
      throw new MeridianConstructError(
        constructErrorCodes.missingPlacement,
        `Resource ${resourceKey} has no placement`,
      );
    }
    const profile = profilesByBinding.get(bindingId);
    if (profile === undefined) {
      throw new MeridianConstructError(
        constructErrorCodes.invalidReference,
        `Resource ${resourceKey} resolves to an unknown Engine profile`,
      );
    }
    validateCapabilities(requirement, profile);
    validateLifecycleRequirements(requirement, bindingsById.get(bindingId)!);
  }

  if (spec.validation.requirePhysicalFingerprints) {
    const missing = bindings
      .filter((item) => item.connection.requiredPhysicalFingerprint === null)
      .map((item) => item.id)
      .sort();
    if (missing.length > 0) {
      throw new MeridianConstructError(
        constructErrorCodes.invalidInput,
        `Strict validation requires physical fingerprints for ${missing.join(", ")}`,
      );
    }
  }

  const runtime = normalizeJson({
    formatVersion: configFormatVersion,
    profile: spec.profile,
    catalogs: {
      providers: [...catalogs].sort((a, b) => a.name.localeCompare(b.name)),
      extensions: {},
    },
    resources: {
      pins: resources
        .flatMap((resource) =>
          resource.schemas.map((schema) => ({
            ref: resource.selector,
            providerId: schema.providerId,
            requiredFingerprint: schema.fingerprint,
          })),
        )
        .sort((a, b) => {
          const resourceOrder = resourceSelectorKey(a.ref).localeCompare(
            resourceSelectorKey(b.ref),
          );
          return resourceOrder === 0
            ? a.providerId.localeCompare(b.providerId)
            : resourceOrder;
        }),
      extensions: {},
    },
    schemas: {
      providers: [...schemaProviders].sort((a, b) => a.id.localeCompare(b.id)),
      live: spec.liveSchemas,
      extensions: {},
    },
    bindings: [...bindings]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((binding) =>
        renderBinding(binding, profilesByBinding.get(binding.id)!),
      ),
    placements: [...placements]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((placement) => ({
        id: placement.id,
        selector: {
          resources: [...placement.selector.resources].sort((a, b) =>
            resourceSelectorKey(a).localeCompare(resourceSelectorKey(b)),
          ),
          catalog: placement.selector.catalog,
          labels: placement.selector.labels,
        },
        bindingId: placement.bindingId,
        extensions: placement.extensions,
      })),
    validation: spec.validation,
    telemetry: spec.telemetry,
    extensions: spec.extensions,
  });
  if (
    runtime === null ||
    Array.isArray(runtime) ||
    typeof runtime !== "object"
  ) {
    throw new TypeError(
      "Runtime configuration normalization produced a non-object",
    );
  }
  validateRuntimeConfig(runtime);
  const runtimeConfigJson = canonicalJson(runtime);
  const configFingerprint = fingerprint(runtime);
  const resourceBindings: Record<string, ResourceBindingCapabilityV1> = {};
  for (const resource of resources) {
    const key = resourceSelectorKey(resource.selector);
    const schemaFingerprint =
      resource.schemas.length === 1
        ? resource.schemas[0]!.fingerprint
        : fingerprint(resource.schemas.map((item) => item.fingerprint).sort());
    resourceBindings[key] = Object.freeze({
      resourceRef: key,
      capabilityKey: `juntai.platform.meridian.resource.${resource.selector.catalog}.${resource.selector.namespace}.${resource.selector.name}@1.0.0`,
      schemaFingerprint,
      configFingerprint,
    });
  }
  return Object.freeze({
    runtimeConfig: runtime,
    runtimeConfigJson,
    fingerprint: configFingerprint,
    resourceBindings: Object.freeze(
      Object.fromEntries(
        Object.entries(resourceBindings).sort(([a], [b]) => a.localeCompare(b)),
      ),
    ),
    placementBindings: Object.freeze(placementBindings),
  });
}

export function resolvePlacementBindings(
  resources: readonly MeridianResourceRequirementV1[],
  placements: readonly PlacementRuleV1[],
): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  for (const requirement of resources) {
    const key = resourceSelectorKey(requirement.selector);
    const matches = placements.filter((placement) =>
      placementMatches(placement, requirement),
    );
    if (matches.length === 0) {
      throw new MeridianConstructError(
        constructErrorCodes.missingPlacement,
        `Resource ${key} has no placement`,
      );
    }
    if (matches.length > 1) {
      throw new MeridianConstructError(
        constructErrorCodes.ambiguousPlacement,
        `Resource ${key} matches ${matches
          .map((item) => item.id)
          .sort()
          .join(", ")}`,
      );
    }
    selected[key] = matches[0]!.bindingId;
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(selected).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

export function runtimeEnvironment(
  configPath: string,
  profile?: string,
): Readonly<Record<string, string>> {
  assertBoundedText(configPath, "runtime config path");
  const values: Record<string, string> = {
    [configEnvironmentVariable]: configPath,
  };
  if (profile !== undefined) {
    assertBoundedText(profile, "runtime profile", 512);
    values[profileEnvironmentVariable] = profile;
  }
  return Object.freeze(values);
}

export function diffPlans(
  previous: DeploymentPlanV1,
  current: DeploymentPlanV1,
): PlanDiffV1 {
  const before = new Set(Object.keys(previous.resourceBindings));
  const after = new Set(Object.keys(current.resourceBindings));
  const addedResources = [...after].filter((item) => !before.has(item)).sort();
  const removedResources = [...before]
    .filter((item) => !after.has(item))
    .sort();
  const changedResources = [...before]
    .filter(
      (item) =>
        after.has(item) &&
        canonicalJson(previous.resourceBindings[item]) !==
          canonicalJson(current.resourceBindings[item]),
    )
    .sort();
  const configChanged = previous.fingerprint !== current.fingerprint;
  return Object.freeze({
    addedResources,
    removedResources,
    changedResources,
    configChanged,
    isEmpty:
      addedResources.length === 0 &&
      removedResources.length === 0 &&
      changedResources.length === 0 &&
      !configChanged,
  });
}

function validateBinding(binding: BindingSpecV1): EngineProfileV1 {
  assertIdentifier(binding.id, "binding id");
  assertFingerprint(
    binding.requiredCapabilityFingerprint,
    "required capability fingerprint",
  );
  validateEngineConnection(binding.connection);
  validateClientPolicy(binding.client);
  validateBindingMetadata(binding);
  const profile = getEngineProfile(binding.profileId);
  if (
    profile.minimumTlsMode === "server" &&
    binding.connection.tls.mode === "disabled"
  ) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      `Profile ${profile.id} requires authenticated TLS`,
    );
  }
  if (!profile.supportedEngineVersions.includes(binding.engineVersion)) {
    throw new MeridianConstructError(
      constructErrorCodes.versionNotPinned,
      `Binding ${binding.id} selects unsupported Engine version ${binding.engineVersion}`,
    );
  }
  if (!profile.allowedModes.includes(binding.mode)) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      `Binding ${binding.id} selects unsupported mode ${binding.mode}`,
    );
  }
  if (!profile.allowedTopologies.includes(binding.topology)) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      `Binding ${binding.id} selects unsupported topology ${binding.topology}`,
    );
  }
  for (const [packageName, observed] of Object.entries(
    binding.compatibilityPins,
  )) {
    assertBoundedText(packageName, "compatibility package", 256);
    assertBoundedText(observed, `compatibility pin ${packageName}`, 512);
    const expected = profile.compatibilityPins[packageName];
    if (expected !== undefined && observed !== expected) {
      throw new MeridianConstructError(
        constructErrorCodes.versionNotPinned,
        `Binding ${binding.id} must pin ${packageName}=${expected}`,
      );
    }
  }
  return profile;
}

function validateCapabilities(
  requirement: MeridianResourceRequirementV1,
  profile: EngineProfileV1,
): void {
  if (!profile.catalogs.includes(requirement.selector.catalog)) {
    throw new MeridianConstructError(
      constructErrorCodes.incompatibleCatalog,
      `Profile ${profile.id} does not serve ${requirement.selector.catalog}`,
    );
  }
  for (const operation of requirement.operations) {
    const provided = profile.operations[operation.contract];
    if (!provided?.versions.includes(operation.version)) {
      throw new MeridianConstructError(
        constructErrorCodes.incompatibleOperation,
        `Profile ${profile.id} does not provide ${operation.contract}@${operation.version}`,
      );
    }
    const requiredGuarantees = new Set([
      ...requirement.guarantees.required,
      ...Object.entries(requirement.guarantees)
        .filter(([name, value]) => name !== "required" && value !== undefined)
        .map(([, value]) => value as string),
      ...(operation.guarantees ?? []),
    ]);
    const missing = [...requiredGuarantees]
      .filter((item) => !provided.guarantees.includes(item))
      .sort();
    if (missing.length > 0) {
      throw new MeridianConstructError(
        constructErrorCodes.incompatibleGuarantee,
        `Profile ${profile.id} lacks ${missing.join(", ")}`,
      );
    }
    const limits = {
      ...requirement.limits.values,
      ...(operation.limits ?? {}),
    };
    for (const [name, required] of Object.entries(limits)) {
      const available = provided.limits[name];
      if (available === undefined || required > available) {
        throw new MeridianConstructError(
          constructErrorCodes.limitExceeded,
          `Profile ${profile.id} cannot satisfy ${name}=${required}`,
        );
      }
    }
  }
}

function validateLifecycleRequirements(
  requirement: MeridianResourceRequirementV1,
  binding: BindingSpecV1,
): void {
  const lifecycle = requirement.retentionReplay;
  if (lifecycle === undefined) {
    return;
  }
  if (
    lifecycle.replayRequired === true &&
    !requirement.operations.some(
      (operation) => operation.contract === "meridian.streaming.replay",
    )
  ) {
    throw new MeridianConstructError(
      constructErrorCodes.incompatibleOperation,
      `${resourceSelectorKey(requirement.selector)} requires the explicit meridian.streaming.replay Operation`,
    );
  }
  for (const [name, required, provided] of [
    ["RPO", lifecycle.rpoSeconds, binding.recovery?.rpoSeconds],
    ["RTO", lifecycle.rtoSeconds, binding.recovery?.rtoSeconds],
  ] as const) {
    if (
      required !== undefined &&
      (provided === undefined || provided > required)
    ) {
      throw new MeridianConstructError(
        constructErrorCodes.incompatibleGuarantee,
        `Binding ${binding.id} cannot satisfy ${name} ${required} seconds`,
      );
    }
  }
}

function renderBinding(
  binding: BindingSpecV1,
  profile: EngineProfileV1,
): Record<string, unknown> {
  const compatibilityPins = Object.fromEntries(
    Object.entries({
      ...profile.compatibilityPins,
      ...binding.compatibilityPins,
    }).sort(([a], [b]) => a.localeCompare(b)),
  );
  const extensions: Record<string, unknown> = {
    ...binding.connection.extensions,
    "org.meridian.constructs/aclRef": binding.acl,
    "org.meridian.constructs/deploymentMode": binding.mode,
    "org.meridian.constructs/migration": binding.migration,
    "org.meridian.constructs/observability": binding.observability,
    "org.meridian.constructs/topology": binding.topology,
  };
  if (binding.recovery !== undefined) {
    extensions["org.meridian.constructs/recovery"] = binding.recovery;
  }
  return {
    id: binding.id,
    adapterId: profile.adapterId,
    adapterContract: profile.adapterContract,
    engineProfile: profile.engineProfile,
    engineVersion: binding.engineVersion,
    endpoint: binding.connection.endpoint,
    serviceRef: binding.connection.serviceRef,
    physicalNamespace: binding.connection.physicalNamespace,
    tls: binding.connection.tls,
    identityRef: binding.connection.identityRef,
    secretRef: binding.connection.secretRef,
    client: binding.client,
    requiredCapabilityFingerprint: binding.requiredCapabilityFingerprint,
    requiredPhysicalFingerprint: binding.connection.requiredPhysicalFingerprint,
    compatibilityPins,
    settings: binding.connection.settings,
    extensions,
  };
}

function placementMatches(
  placement: PlacementRuleV1,
  requirement: MeridianResourceRequirementV1,
): boolean {
  const selector = placement.selector;
  const resourceKey = resourceSelectorKey(requirement.selector);
  const exact =
    selector.resources.length === 0 ||
    selector.resources.some(
      (item) => resourceSelectorKey(item) === resourceKey,
    );
  const catalog =
    selector.catalog === null ||
    selector.catalog === requirement.selector.catalog;
  const labels = Object.entries(selector.labels).every(
    ([key, value]) => requirement.labels?.[key] === value,
  );
  return exact && catalog && labels;
}

function uniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
  code: (typeof constructErrorCodes)[keyof typeof constructErrorCodes],
): readonly T[] {
  const seen = new Set<string>();
  for (const value of values) {
    const selected = key(value);
    if (seen.has(selected)) {
      throw new MeridianConstructError(
        code,
        `Duplicate deployment identifier ${selected}`,
      );
    }
    seen.add(selected);
  }
  return values;
}

function formatSchemaErrors(errors: readonly ErrorObject[]): string {
  return errors
    .map(
      (error) =>
        `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
    )
    .join("; ");
}

export type { JsonObject, JsonValue } from "../canonical.js";
export type { ResourceSelectorV1 } from "../contracts/index.js";
