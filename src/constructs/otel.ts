// SPDX-License-Identifier: Apache-2.0

import * as pulumi from "@pulumi/pulumi";
import {
  fingerprint,
  normalizeJson,
  type JsonObject,
  type JsonValue,
} from "../canonical.js";
import {
  assertBoundedText,
  assertDigestPinnedImage,
  assertFingerprint,
  assertIdentifier,
  rejectSecretMaterial,
  resourceSelectorKey,
  validateTelemetryCapability,
  validateTlsPolicy,
  type OpaqueSecretRef,
  type ResourceSelectorV1,
  type TelemetryCapabilityV1,
  type TlsPolicy,
} from "../contracts/index.js";
import { MeridianConstructError, constructErrorCodes } from "../errors.js";

const otelCollectorComponentType = "meridian:storage:OtelCollector";

export type CollectorMode = "sidecar" | "gateway";
export type OtelProtocol = "grpc" | "http/protobuf";
export type OtelSignal = "traces" | "metrics" | "logs";

export interface OtelCollectorSpecV1 {
  readonly formatVersion: "meridian-otel-collector.v1";
  readonly mode: CollectorMode;
  readonly image: string;
  readonly config: JsonObject;
  readonly credentialRefs: readonly OpaqueSecretRef[];
  readonly replicas: number;
  readonly ports: {
    readonly grpc: number;
    readonly http: number;
  };
  readonly protocol: OtelProtocol;
  readonly signals: readonly OtelSignal[];
  readonly tls: TlsPolicy;
  readonly batchingSamplingFingerprint: string;
  readonly backendReadPlacement: ResourceSelectorV1;
  readonly extensions: JsonObject;
  readonly specFingerprint: string;
}

export interface OtelCollectorInputV1 {
  readonly mode: CollectorMode;
  readonly image: string;
  readonly config: JsonObject;
  readonly credentialRefs?: readonly OpaqueSecretRef[];
  readonly replicas?: number;
  readonly grpcPort?: number;
  readonly httpPort?: number;
  readonly protocol: OtelProtocol;
  readonly signals: readonly OtelSignal[];
  readonly tls: TlsPolicy;
  readonly batchingSamplingFingerprint: string;
  readonly backendReadPlacement: ResourceSelectorV1;
  readonly extensions?: JsonObject;
}

export interface CollectorProvisionerV1 {
  provision(
    name: string,
    spec: OtelCollectorSpecV1,
    options: {
      readonly parent: pulumi.Resource;
      readonly provider: pulumi.ProviderResource;
    },
  ): {
    readonly endpoint: pulumi.Input<string>;
    readonly healthEndpoint: pulumi.Input<string>;
    readonly outputs?: Readonly<Record<string, pulumi.Input<unknown>>>;
  };
}

export interface MeridianOtelCollectorArgsV1 {
  readonly spec: OtelCollectorSpecV1;
  readonly provider: pulumi.ProviderResource;
  readonly provisioner: CollectorProvisionerV1;
}

export interface TelemetryCapabilityInputV1 {
  readonly serviceName: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly extensions?: JsonObject;
}

export class MeridianOtelCollector extends pulumi.ComponentResource {
  public readonly endpoint: pulumi.Output<string>;
  public readonly healthEndpoint: pulumi.Output<string>;
  public readonly specFingerprint: pulumi.Output<string>;
  public readonly spec: OtelCollectorSpecV1;

  public constructor(
    name: string,
    args: MeridianOtelCollectorArgsV1,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    if (args.provider === undefined) {
      throw new MeridianConstructError(
        constructErrorCodes.providerRequired,
        "OTel Collector provisioning requires an explicit provider",
      );
    }
    super(otelCollectorComponentType, name, { spec: args.spec }, opts);
    this.spec = args.spec;
    const provisioned = args.provisioner.provision(name, args.spec, {
      parent: this,
      provider: args.provider,
    });
    this.endpoint = pulumi.output(provisioned.endpoint);
    this.healthEndpoint = pulumi.output(provisioned.healthEndpoint);
    this.specFingerprint = pulumi.output(args.spec.specFingerprint);
    this.registerOutputs({
      ...(provisioned.outputs ?? {}),
      endpoint: this.endpoint,
      healthEndpoint: this.healthEndpoint,
      specFingerprint: this.specFingerprint,
    });
  }

  /** Render the non-secret runtime capability consumed by one workload. */
  public runtimeCapability(
    input: TelemetryCapabilityInputV1,
  ): pulumi.Output<TelemetryCapabilityV1> {
    return this.endpoint.apply((endpoint) =>
      createTelemetryCapability(this.spec, endpoint, input),
    );
  }
}

export function createOtelCollectorSpec(
  input: OtelCollectorInputV1,
): OtelCollectorSpecV1 {
  assertDigestPinnedImage(input.image, "OTel Collector image");
  const replicas = input.replicas ?? 1;
  if (input.mode === "sidecar" && replicas !== 1) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "A sidecar Collector must have exactly one replica",
    );
  }
  if (!Number.isInteger(replicas) || replicas < 1 || replicas > 1_000) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Collector replicas are out of range",
    );
  }
  const grpc = input.grpcPort ?? 4_317;
  const http = input.httpPort ?? 4_318;
  for (const [name, port] of [
    ["grpc", grpc],
    ["http", http],
  ] as const) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new MeridianConstructError(
        constructErrorCodes.invalidInput,
        `Collector ${name} port is invalid`,
      );
    }
  }
  if (
    input.signals.length === 0 ||
    new Set(input.signals).size !== input.signals.length
  ) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Collector signals must be non-empty and unique",
    );
  }
  assertFingerprint(
    input.batchingSamplingFingerprint,
    "Collector batching/sampling fingerprint",
  );
  validateTlsPolicy(input.tls);
  if (input.backendReadPlacement.catalog !== "evidence") {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Collector backend-read placement must select the evidence Catalog",
    );
  }
  resourceSelectorKey(input.backendReadPlacement);
  const extensions = requireObject(
    normalizeJson(input.extensions ?? {}),
    "Collector extensions",
  );
  rejectSecretMaterial(extensions, "Collector extensions");
  const credentialRefs = [...(input.credentialRefs ?? [])].sort((left, right) =>
    `${left.provider}\u0000${left.reference}`.localeCompare(
      `${right.provider}\u0000${right.reference}`,
    ),
  );
  for (const reference of credentialRefs) {
    assertIdentifier(reference.provider, "Collector credential provider");
    assertBoundedText(reference.reference, "Collector credential reference");
    if (
      reference.provider === "environment" &&
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference.reference)
    ) {
      throw new MeridianConstructError(
        constructErrorCodes.invalidInput,
        "Collector environment credential references must name one environment variable",
      );
    }
  }
  const credentialKeys = credentialRefs.map(
    (reference) => `${reference.provider}\u0000${reference.reference}`,
  );
  if (new Set(credentialKeys).size !== credentialKeys.length) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Collector credential references must be unique",
    );
  }
  validateCollectorSecretReferences(
    input.config,
    new Set(
      credentialRefs
        .filter((reference) => reference.provider === "environment")
        .map((reference) => reference.reference),
    ),
  );
  const config = requireObject(normalizeJson(input.config), "Collector config");
  validateCollectorConfig(config, input.signals);
  const body = {
    formatVersion: "meridian-otel-collector.v1" as const,
    mode: input.mode,
    image: input.image,
    config,
    credentialRefs,
    replicas,
    ports: { grpc, http },
    protocol: input.protocol,
    signals: [...input.signals].sort(),
    tls: input.tls,
    batchingSamplingFingerprint: input.batchingSamplingFingerprint,
    backendReadPlacement: input.backendReadPlacement,
    extensions,
  };
  return Object.freeze({ ...body, specFingerprint: fingerprint(body) });
}

export function createTelemetryCapability(
  spec: OtelCollectorSpecV1,
  endpoint: string,
  input: TelemetryCapabilityInputV1,
): TelemetryCapabilityV1 {
  assertBoundedText(endpoint, "Collector endpoint");
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new MeridianConstructError(
      constructErrorCodes.invalidEndpoint,
      "Collector endpoint must be an absolute URI",
    );
  }
  if (
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidEndpoint,
      "Collector endpoint cannot contain credentials or a fragment",
    );
  }
  const reservedKey = "org.meridian.constructs/otelCollector";
  if (input.extensions?.[reservedKey] !== undefined) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      `Telemetry extensions cannot override ${reservedKey}`,
    );
  }
  const extensions = requireObject(
    normalizeJson({
      ...(input.extensions ?? {}),
      [reservedKey]: {
        endpoint,
        protocol: spec.protocol,
        signals: spec.signals,
        tls: spec.tls,
        batchingSamplingFingerprint: spec.batchingSamplingFingerprint,
        backendReadPlacement: spec.backendReadPlacement,
      },
    }),
    "telemetry extensions",
  );
  const capability: TelemetryCapabilityV1 = Object.freeze({
    enabled: true,
    serviceName: input.serviceName,
    suppressExporterRecursion: true,
    attributes: Object.freeze({ ...(input.attributes ?? {}) }),
    extensions,
  });
  validateTelemetryCapability(capability);
  return capability;
}

export function collectorEnvironment(
  endpoint: string,
  protocol: OtelProtocol,
): Readonly<Record<string, string>> {
  assertBoundedText(endpoint, "OTLP endpoint");
  return Object.freeze({
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_PROTOCOL: protocol,
  });
}

function validateCollectorConfig(
  config: JsonObject,
  signals: readonly OtelSignal[] = [],
): void {
  const required = ["receivers", "processors", "exporters", "service"];
  const missing = required.filter((item) => config[item] === undefined);
  if (missing.length > 0) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      `Collector config is missing ${missing.join(", ")}`,
    );
  }
  const receivers = config.receivers;
  const service = config.service;
  if (!isObject(receivers) || receivers.otlp === undefined) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Collector must configure the OTLP receiver",
    );
  }
  if (!isObject(service) || !isObject(service.pipelines)) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Collector must configure service pipelines",
    );
  }
  const pipelines = service.pipelines;
  const missingSignals = signals.filter(
    (signal) => !isObject(pipelines[signal]),
  );
  if (missingSignals.length > 0) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      `Collector config is missing ${missingSignals.join(", ")} pipelines`,
    );
  }
}

/** Validate references without resolving secrets or relaxing other config guards. */
function validateCollectorSecretReferences(
  value: unknown,
  environment: ReadonlySet<string>,
  path = "Collector config",
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      validateCollectorSecretReferences(item, environment, `${path}[${index}]`),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      // The existing V1 credentialRefs shape declares the environment authority.
      // Only a complete password substitution is an exception to the key guard.
      if (key === "password" && typeof item === "string") {
        const match = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(item);
        if (match !== null && environment.has(match[1]!)) {
          continue;
        }
      }
      rejectSecretMaterial({ [key]: null }, path);
      validateCollectorSecretReferences(item, environment, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string" && value.includes("${")) {
    const match = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    if (match === null || !environment.has(match[1]!)) {
      throw new MeridianConstructError(
        constructErrorCodes.secretMaterial,
        `${path} must use one declared environment reference without a default or interpolation`,
      );
    }
  }
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== undefined &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object"
  );
}

function requireObject(value: JsonValue, path: string): JsonObject {
  if (!isObject(value)) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      `${path} must be an object`,
    );
  }
  return value;
}
