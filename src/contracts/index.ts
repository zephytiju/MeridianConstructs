// SPDX-License-Identifier: Apache-2.0

import type * as pulumi from "@pulumi/pulumi";
import type { JsonObject } from "../canonical.js";
import { MeridianConstructError, constructErrorCodes } from "../errors.js";

const identifierPattern = /^[A-Za-z](?:[A-Za-z0-9_.-]{0,253}[A-Za-z0-9])?$/;
const fingerprintPattern = /^sha256:[0-9a-f]{64}$/;
const imageDigestPattern = /^\S+@sha256:[0-9a-f]{64}$/;
const sensitiveKeyPattern =
  /(?:^|[-_.])(?:access[-_.]?key|credential|password|private[-_.]?key|secret|token)(?:$|[-_.])/i;

export const catalogNames = [
  "structured",
  "object",
  "cache",
  "evidence",
  "streaming",
] as const;
export type CatalogName = (typeof catalogNames)[number];
export type DeploymentMode = "managed" | "external";
export type Topology =
  | "single-primary"
  | "cluster"
  | "provider-managed"
  | "test";
export type JobKind =
  | "migration"
  | "projection"
  | "cache-warm"
  | "streaming-bootstrap"
  | "backup"
  | "restore"
  | "validation";

export interface ResourceSelectorV1 {
  readonly catalog: CatalogName;
  readonly namespace: string;
  readonly name: string;
}

export interface SchemaRequirementV1 {
  readonly providerId: string;
  readonly package: string;
  readonly version: string;
  readonly fingerprint: string;
}

export interface OperationRequirementV1 {
  readonly contract: string;
  readonly version: string;
  readonly guarantees?: readonly string[];
  readonly limits?: Readonly<Record<string, number>>;
}

export interface GuaranteeRequirementV1 {
  readonly required: readonly string[];
  readonly availability?: string;
  readonly consistency?: string;
  readonly delivery?: string;
  readonly ordering?: string;
  readonly transaction?: string;
}

export interface LimitRequirementV1 {
  readonly values: Readonly<Record<string, number>>;
}

export interface RetentionReplayRequirementV1 {
  readonly retentionSeconds?: number;
  readonly replayRequired?: boolean;
  readonly rpoSeconds?: number;
  readonly rtoSeconds?: number;
}

export interface MeridianResourceRequirementV1 {
  readonly selector: ResourceSelectorV1;
  readonly schemas: readonly SchemaRequirementV1[];
  readonly operations: readonly OperationRequirementV1[];
  readonly guarantees: GuaranteeRequirementV1;
  readonly limits: LimitRequirementV1;
  readonly retentionReplay?: RetentionReplayRequirementV1;
  readonly dataClass: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface OpaqueIdentityRef {
  readonly provider: string;
  readonly reference: string;
}

export interface OpaqueSecretRef {
  readonly provider: string;
  readonly reference: string;
}

export interface TlsPolicy {
  readonly mode: "disabled" | "server" | "mutual";
  readonly serverName: string | null;
  readonly caRef: OpaqueSecretRef | null;
  readonly clientCertificateRef: OpaqueSecretRef | null;
}

export interface AclPolicyRef {
  readonly provider: string;
  readonly reference: string;
}

export interface RecoveryCapabilityV1 {
  readonly method:
    "backup-restore" | "rebuild" | "replicated-log" | "flush-warm";
  readonly owner: string;
  readonly policyRef: string;
  readonly rpoSeconds: number;
  readonly rtoSeconds: number;
  readonly validationFingerprint: string;
}

export interface MigrationStateV1 {
  readonly contract: string;
  readonly version: string;
  readonly appliedFingerprint: string;
}

export interface ObservabilityBindingV1 {
  readonly enabled: boolean;
  readonly labels: Readonly<Record<string, string>>;
  readonly collectorCapabilityFingerprint?: string;
}

export interface CompatibilityPinsV1 {
  readonly packages: Readonly<Record<string, string>>;
  readonly fingerprints?: Readonly<Record<string, string>>;
}

export interface GuaranteeStatementV1 {
  readonly values: readonly string[];
}

export interface LimitStatementV1 {
  readonly values: Readonly<Record<string, number>>;
}

export interface MeridianCapabilityV1 {
  readonly operationContract: string;
  readonly operationVersion: string;
  readonly guarantees: GuaranteeStatementV1;
  readonly limits: LimitStatementV1;
  readonly fingerprint: string;
}

export interface MeridianBindingOutputV1 {
  readonly resource: ResourceSelectorV1;
  readonly bindingRef: pulumi.Output<string>;
  readonly adapterId: string;
  readonly adapterContract: string;
  readonly engineProfile: string;
  readonly engineVersion: pulumi.Output<string>;
  readonly endpoint: pulumi.Output<string>;
  readonly physicalNamespace: pulumi.Output<string>;
  readonly identity: OpaqueIdentityRef;
  readonly credentials: OpaqueSecretRef;
  readonly tls: TlsPolicy;
  readonly acl: AclPolicyRef;
  readonly capabilities: readonly MeridianCapabilityV1[];
  readonly compatibility: CompatibilityPinsV1;
  readonly migration: MigrationStateV1;
  readonly observability: ObservabilityBindingV1;
  readonly recovery?: RecoveryCapabilityV1;
}

export interface CatalogProviderV1 {
  readonly name: CatalogName;
  readonly package: string;
  readonly contract: string;
  readonly requiredFingerprint: string;
}

export interface SchemaProviderV1 {
  readonly id: string;
  readonly package: string;
  readonly contract: string;
  readonly requiredFingerprint: string;
}

export interface LiveSchemaPolicyV1 {
  readonly enabled: boolean;
  readonly required: boolean;
  readonly providerId: string | null;
}

export interface ClientPolicyV1 {
  readonly minSize: number;
  readonly maxSize: number;
  readonly acquireTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly operationTimeoutMs: number;
  readonly maxResultBytes: number;
  readonly iteratorLifetimeMs: number;
}

export interface EngineConnectionV1 {
  readonly physicalNamespace: string;
  readonly identityRef: OpaqueIdentityRef;
  readonly secretRef: OpaqueSecretRef;
  readonly tls: TlsPolicy;
  readonly endpoint: string | null;
  readonly serviceRef: string | null;
  readonly requiredPhysicalFingerprint: string | null;
  readonly settings: JsonObject;
  readonly extensions: JsonObject;
}

export interface BindingSpecV1 {
  readonly id: string;
  readonly profileId: string;
  readonly requiredCapabilityFingerprint: string;
  readonly connection: EngineConnectionV1;
  readonly mode: DeploymentMode;
  readonly topology: Topology;
  readonly engineVersion: string;
  readonly client: ClientPolicyV1;
  readonly compatibilityPins: Readonly<Record<string, string>>;
  readonly acl: AclPolicyRef;
  readonly migration: MigrationStateV1;
  readonly observability: ObservabilityBindingV1;
  readonly recovery?: RecoveryCapabilityV1;
}

export interface PlacementSelectorV1 {
  readonly resources: readonly ResourceSelectorV1[];
  readonly catalog: CatalogName | null;
  readonly labels: Readonly<Record<string, string>>;
}

export interface PlacementRuleV1 {
  readonly id: string;
  readonly selector: PlacementSelectorV1;
  readonly bindingId: string;
  readonly extensions: JsonObject;
}

export interface RetryPolicyV1 {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

export interface ValidationPolicyV1 {
  readonly strict: true;
  readonly requirePhysicalFingerprints: boolean;
  readonly defaultOperationTimeoutMs: number;
  readonly idempotencyCacheEntries: number;
  readonly retry: RetryPolicyV1;
}

export interface TelemetryCapabilityV1 {
  readonly enabled: boolean;
  readonly serviceName: string | null;
  readonly suppressExporterRecursion: true;
  readonly attributes: Readonly<Record<string, string>>;
  readonly extensions: JsonObject;
}

export interface DeploymentSpecV1 {
  readonly profile: string;
  readonly catalogs: readonly CatalogProviderV1[];
  readonly schemaProviders: readonly SchemaProviderV1[];
  readonly resources: readonly MeridianResourceRequirementV1[];
  readonly bindings: readonly BindingSpecV1[];
  readonly placements: readonly PlacementRuleV1[];
  readonly liveSchemas: LiveSchemaPolicyV1;
  readonly validation: ValidationPolicyV1;
  readonly telemetry: TelemetryCapabilityV1;
  readonly extensions: JsonObject;
}

export const defaultClientPolicy: ClientPolicyV1 = Object.freeze({
  minSize: 0,
  maxSize: 20,
  acquireTimeoutMs: 5_000,
  idleTimeoutMs: 60_000,
  operationTimeoutMs: 30_000,
  maxResultBytes: 16 * 1024 * 1024,
  iteratorLifetimeMs: 300_000,
});

export const defaultValidationPolicy: ValidationPolicyV1 = Object.freeze({
  strict: true,
  requirePhysicalFingerprints: true,
  defaultOperationTimeoutMs: 30_000,
  idempotencyCacheEntries: 10_000,
  retry: Object.freeze({
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 5_000,
    jitterRatio: 0.2,
  }),
});

export const disabledTelemetryCapability: TelemetryCapabilityV1 = Object.freeze(
  {
    enabled: false,
    serviceName: null,
    suppressExporterRecursion: true,
    attributes: Object.freeze({}),
    extensions: Object.freeze({}),
  },
);

export function parseResourceSelector(
  value: string | ResourceSelectorV1,
): ResourceSelectorV1 {
  if (typeof value !== "string") {
    validateResourceSelector(value);
    return Object.freeze({ ...value });
  }
  if (value.length > 1_024) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidReference,
      "Resource selector is invalid",
    );
  }
  const catalogSeparator = value.indexOf(":");
  const resourceSeparator = value.lastIndexOf(".");
  if (
    catalogSeparator <= 0 ||
    resourceSeparator <= catalogSeparator + 1 ||
    resourceSeparator === value.length - 1
  ) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidReference,
      "Resource selector is invalid",
    );
  }
  const selector = {
    catalog: value.slice(0, catalogSeparator) as CatalogName,
    namespace: value.slice(catalogSeparator + 1, resourceSeparator),
    name: value.slice(resourceSeparator + 1),
  };
  try {
    validateResourceSelector(selector);
  } catch {
    throw new MeridianConstructError(
      constructErrorCodes.invalidReference,
      "Resource selector is invalid",
    );
  }
  return Object.freeze(selector);
}

export function resourceSelectorKey(selector: ResourceSelectorV1): string {
  validateResourceSelector(selector);
  return `${selector.catalog}:${selector.namespace}.${selector.name}`;
}

export function validateResourceSelector(selector: ResourceSelectorV1): void {
  if (!catalogNames.includes(selector.catalog)) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidReference,
      "Resource selector uses an unregistered Catalog",
    );
  }
  assertIdentifier(selector.namespace, "resource namespace");
  assertIdentifier(selector.name, "resource name");
}

export function validateResourceRequirement(
  requirement: MeridianResourceRequirementV1,
): void {
  validateResourceSelector(requirement.selector);
  assertBoundedText(requirement.dataClass, "data class", 512);
  if (requirement.schemas.length === 0 || requirement.operations.length === 0) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Resource schemas and operations must be non-empty",
    );
  }
  assertUnique(
    requirement.schemas.map((item) => item.providerId),
    "schema providers",
  );
  for (const schema of requirement.schemas) {
    assertIdentifier(schema.providerId, "schema provider id");
    assertBoundedText(schema.package, "schema package", 256);
    assertBoundedText(schema.version, "schema version", 64);
    assertFingerprint(schema.fingerprint, "schema fingerprint");
  }
  assertUnique(
    requirement.operations.map((item) => item.contract),
    "operation contracts",
  );
  for (const operation of requirement.operations) {
    assertBoundedText(operation.contract, "operation contract", 256);
    assertBoundedText(operation.version, "operation version", 64);
    assertUnique(operation.guarantees ?? [], "operation guarantees");
    validateLimits(operation.limits ?? {});
  }
  assertUnique(requirement.guarantees.required, "resource guarantees");
  for (const guarantee of requirement.guarantees.required) {
    assertBoundedText(guarantee, "resource guarantee", 256);
  }
  for (const [name, value] of Object.entries(requirement.guarantees)) {
    if (name !== "required" && value !== undefined) {
      if (typeof value !== "string") {
        throw new MeridianConstructError(
          constructErrorCodes.invalidInput,
          `Resource guarantee ${name} must be text`,
        );
      }
      assertBoundedText(value, `resource guarantee ${name}`, 256);
    }
  }
  validateLimits(requirement.limits.values);
  if (requirement.retentionReplay !== undefined) {
    for (const [name, value] of Object.entries(requirement.retentionReplay)) {
      if (name === "replayRequired" && typeof value !== "boolean") {
        throw new MeridianConstructError(
          constructErrorCodes.invalidInput,
          "replayRequired must be boolean",
        );
      }
      if (
        typeof value === "number" &&
        (!Number.isSafeInteger(value) || value < 0)
      ) {
        throw new MeridianConstructError(
          constructErrorCodes.invalidInput,
          `${name} must be a non-negative integer`,
        );
      }
    }
  }
  for (const [name, value] of Object.entries(requirement.labels ?? {})) {
    assertBoundedText(name, "resource label name", 128);
    assertBoundedText(value, `resource label ${name}`, 512);
  }
}

export function validateEngineConnection(connection: EngineConnectionV1): void {
  assertBoundedText(connection.physicalNamespace, "physical namespace", 512);
  validateOpaqueReference(connection.identityRef, "identity reference");
  validateOpaqueReference(connection.secretRef, "secret reference");
  validateTlsPolicy(connection.tls);
  if ((connection.endpoint === null) === (connection.serviceRef === null)) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidEndpoint,
      "Engine connection requires exactly one endpoint or service reference",
    );
  }
  if (connection.endpoint !== null) {
    validateEndpoint(connection.endpoint);
  }
  if (connection.serviceRef !== null) {
    assertBoundedText(connection.serviceRef, "service reference", 512);
    if (/^(?:pulumi|stack):\/\//i.test(connection.serviceRef)) {
      throw new MeridianConstructError(
        constructErrorCodes.invalidReference,
        "Cross-plane stack references are not valid Engine service references",
      );
    }
  }
  if (connection.requiredPhysicalFingerprint !== null) {
    assertFingerprint(
      connection.requiredPhysicalFingerprint,
      "physical fingerprint",
    );
  }
  rejectSecretMaterial(connection.settings, "Engine settings");
  rejectSecretMaterial(connection.extensions, "Engine extensions");
}

export function validateTlsPolicy(policy: TlsPolicy): void {
  if (!["disabled", "server", "mutual"].includes(policy.mode)) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "TLS mode must be disabled, server, or mutual",
    );
  }
  if (policy.mode === "disabled") {
    if (
      policy.serverName !== null ||
      policy.caRef !== null ||
      policy.clientCertificateRef !== null
    ) {
      throw new MeridianConstructError(
        constructErrorCodes.invalidInput,
        "Disabled TLS cannot carry TLS references",
      );
    }
    return;
  }
  if (policy.serverName === null || policy.caRef === null) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Authenticated TLS requires a server name and CA reference",
    );
  }
  assertBoundedText(policy.serverName, "TLS server name", 512);
  validateOpaqueReference(policy.caRef, "TLS CA reference");
  if (policy.mode === "server" && policy.clientCertificateRef !== null) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Server TLS cannot carry a client certificate",
    );
  }
  if (policy.mode === "mutual" && policy.clientCertificateRef === null) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Mutual TLS requires a client certificate",
    );
  }
  if (policy.clientCertificateRef !== null) {
    validateOpaqueReference(
      policy.clientCertificateRef,
      "TLS client certificate",
    );
  }
}

export function validateBindingMetadata(binding: {
  readonly acl: AclPolicyRef;
  readonly migration: MigrationStateV1;
  readonly observability: ObservabilityBindingV1;
  readonly recovery?: RecoveryCapabilityV1;
}): void {
  validateOpaqueReference(binding.acl, "ACL policy reference");
  assertBoundedText(binding.migration.contract, "migration contract", 256);
  assertBoundedText(binding.migration.version, "migration version", 64);
  assertFingerprint(
    binding.migration.appliedFingerprint,
    "migration fingerprint",
  );
  if (typeof binding.observability.enabled !== "boolean") {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Observability enabled must be boolean",
    );
  }
  for (const [name, value] of Object.entries(binding.observability.labels)) {
    assertBoundedText(name, "observability label name", 128);
    assertBoundedText(value, `observability label ${name}`, 512);
  }
  if (
    binding.observability.collectorCapabilityFingerprint !== undefined
  ) {
    assertFingerprint(
      binding.observability.collectorCapabilityFingerprint,
      "Collector capability fingerprint",
    );
  }
  if (binding.recovery !== undefined) {
    if (
      !["backup-restore", "rebuild", "replicated-log", "flush-warm"].includes(
        binding.recovery.method,
      )
    ) {
      throw new MeridianConstructError(
        constructErrorCodes.invalidInput,
        "Recovery method is invalid",
      );
    }
    assertBoundedText(binding.recovery.owner, "recovery owner", 512);
    assertBoundedText(
      binding.recovery.policyRef,
      "recovery policy reference",
    );
    for (const [name, value] of [
      ["RPO seconds", binding.recovery.rpoSeconds],
      ["RTO seconds", binding.recovery.rtoSeconds],
    ] as const) {
      if (!Number.isInteger(value) || value < 0 || value > 31_536_000) {
        throw new MeridianConstructError(
          constructErrorCodes.invalidInput,
          `${name} must be a non-negative bounded integer`,
        );
      }
    }
    assertFingerprint(
      binding.recovery.validationFingerprint,
      "recovery validation fingerprint",
    );
  }
}

export function validateClientPolicy(policy: ClientPolicyV1): void {
  const ranges: Readonly<
    Record<keyof ClientPolicyV1, readonly [number, number]>
  > = {
    minSize: [0, 10_000],
    maxSize: [1, 10_000],
    acquireTimeoutMs: [1, 3_600_000],
    idleTimeoutMs: [0, 86_400_000],
    operationTimeoutMs: [1, 3_600_000],
    maxResultBytes: [1, 2_147_483_647],
    iteratorLifetimeMs: [1, 86_400_000],
  };
  for (const [key, [minimum, maximum]] of Object.entries(ranges) as [
    keyof ClientPolicyV1,
    readonly [number, number],
  ][]) {
    const value = policy[key];
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new MeridianConstructError(
        constructErrorCodes.invalidInput,
        `Client policy ${key} is out of range`,
      );
    }
  }
  if (policy.minSize > policy.maxSize) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Client minimum size cannot exceed maximum size",
    );
  }
}

export function validatePlacementSelector(selector: PlacementSelectorV1): void {
  if (
    selector.resources.length === 0 &&
    selector.catalog === null &&
    Object.keys(selector.labels).length === 0
  ) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Placement selector cannot be empty",
    );
  }
  const keys = selector.resources.map(resourceSelectorKey);
  assertUnique(keys, "placement resources");
  for (const [name, value] of Object.entries(selector.labels)) {
    assertBoundedText(name, "placement label name", 128);
    assertBoundedText(value, `placement label ${name}`, 512);
  }
  if (selector.catalog !== null && !catalogNames.includes(selector.catalog)) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Placement selector uses an unregistered Catalog",
    );
  }
}

export function validateValidationPolicy(policy: ValidationPolicyV1): void {
  if (policy.strict !== true) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Meridian V1 validation must be strict",
    );
  }
  if (
    !Number.isInteger(policy.defaultOperationTimeoutMs) ||
    policy.defaultOperationTimeoutMs < 1 ||
    policy.defaultOperationTimeoutMs > 3_600_000
  ) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Default operation timeout is out of range",
    );
  }
  if (
    !Number.isInteger(policy.idempotencyCacheEntries) ||
    policy.idempotencyCacheEntries < 1 ||
    policy.idempotencyCacheEntries > 1_000_000
  ) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Idempotency cache size is out of range",
    );
  }
  const retry = policy.retry;
  if (
    !Number.isInteger(retry.maxAttempts) ||
    retry.maxAttempts < 1 ||
    retry.maxAttempts > 20 ||
    retry.baseDelayMs < 0 ||
    retry.baseDelayMs > 60_000 ||
    retry.maxDelayMs < retry.baseDelayMs ||
    retry.maxDelayMs > 600_000 ||
    retry.jitterRatio < 0 ||
    retry.jitterRatio > 1
  ) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Retry policy is out of range",
    );
  }
}

export function validateTelemetryCapability(
  capability: TelemetryCapabilityV1,
): void {
  if (capability.enabled !== (capability.serviceName !== null)) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Telemetry service name must be set exactly when telemetry is enabled",
    );
  }
  if (capability.serviceName !== null) {
    assertBoundedText(capability.serviceName, "telemetry service name", 512);
  }
  if (capability.suppressExporterRecursion !== true) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Telemetry exporter recursion suppression is mandatory",
    );
  }
  for (const [name, value] of Object.entries(capability.attributes)) {
    assertBoundedText(name, "telemetry attribute name", 128);
    assertBoundedText(value, `telemetry attribute ${name}`, 512);
  }
  rejectSecretMaterial(capability.attributes, "telemetry attributes");
  rejectSecretMaterial(capability.extensions, "telemetry extensions");
}

export function rejectSecretMaterial(value: unknown, path = "settings"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      rejectSecretMaterial(item, `${path}[${index}]`),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (sensitiveKeyPattern.test(key)) {
        throw new MeridianConstructError(
          constructErrorCodes.secretMaterial,
          `${path}.${key} looks like inline secret material; use an opaque reference`,
        );
      }
      rejectSecretMaterial(item, `${path}.${key}`);
    }
  }
}

export function assertDigestPinnedImage(image: string, path = "image"): void {
  if (!imageDigestPattern.test(image)) {
    throw new MeridianConstructError(
      constructErrorCodes.versionNotPinned,
      `${path} must be pinned by sha256 digest`,
    );
  }
}

export function assertFingerprint(value: string, path: string): void {
  if (typeof value !== "string" || !fingerprintPattern.test(value)) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      `${path} must be a sha256 fingerprint`,
    );
  }
}

export function assertIdentifier(value: string, path: string): void {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      `${path} is not a valid identifier`,
    );
  }
}

export function assertBoundedText(
  value: string,
  path: string,
  maximum = 2_048,
): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      `${path} must be bounded non-empty text`,
    );
  }
}

export function validateOpaqueReference(
  reference: OpaqueIdentityRef | OpaqueSecretRef,
  path: string,
): void {
  assertIdentifier(reference.provider, `${path} provider`);
  assertBoundedText(reference.reference, path);
}

function validateEndpoint(endpoint: string): void {
  assertBoundedText(endpoint, "endpoint");
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new MeridianConstructError(
      constructErrorCodes.invalidEndpoint,
      "Endpoint must be an absolute URI",
    );
  }
  if (
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.search.length > 0
  ) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidEndpoint,
      "Endpoint cannot contain credentials, a query, or a fragment",
    );
  }
}

function validateLimits(limits: Readonly<Record<string, number>>): void {
  for (const [name, value] of Object.entries(limits)) {
    assertBoundedText(name, "operation limit", 128);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new MeridianConstructError(
        constructErrorCodes.invalidInput,
        `Operation limit ${name} must be a non-negative integer`,
      );
    }
  }
}

function assertUnique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      `${path} must be unique`,
    );
  }
}

export type { JsonObject, JsonValue } from "../canonical.js";
