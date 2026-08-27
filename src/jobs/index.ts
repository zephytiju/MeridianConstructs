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
  type JobKind,
  type OpaqueSecretRef,
  type ResourceSelectorV1,
} from "../contracts/index.js";
import { MeridianConstructError, constructErrorCodes } from "../errors.js";

const lifecycleJobComponentType = "meridian:storage:LifecycleJob";

export interface LifecycleJobSpecV1 {
  readonly formatVersion: "meridian-storage-iac-job.v1";
  readonly kind: JobKind;
  readonly image: string;
  readonly resources: readonly ResourceSelectorV1[];
  readonly operation: JsonObject;
  readonly secretRefs: readonly OpaqueSecretRef[];
  readonly dependsOn: readonly string[];
  readonly timeoutSeconds: number;
  readonly maxAttempts: number;
  readonly extensions: JsonObject;
  readonly specFingerprint: string;
}

export interface LifecycleJobInputV1 {
  readonly kind: JobKind;
  readonly image: string;
  readonly resources: readonly ResourceSelectorV1[];
  readonly operation: JsonObject;
  readonly secretRefs?: readonly OpaqueSecretRef[];
  readonly dependsOn?: readonly string[];
  readonly timeoutSeconds?: number;
  readonly maxAttempts?: number;
  readonly extensions?: JsonObject;
}

export interface LifecycleJobProvisionerV1 {
  provision(
    name: string,
    spec: LifecycleJobSpecV1,
    options: {
      readonly parent: pulumi.Resource;
      readonly provider: pulumi.ProviderResource;
    },
  ): Readonly<Record<string, pulumi.Input<unknown>>>;
}

export interface MeridianLifecycleJobArgsV1 {
  readonly spec: LifecycleJobSpecV1;
  readonly provider: pulumi.ProviderResource;
  readonly provisioner: LifecycleJobProvisionerV1;
}

export class MeridianLifecycleJob extends pulumi.ComponentResource {
  public readonly specFingerprint: pulumi.Output<string>;

  public constructor(
    name: string,
    args: MeridianLifecycleJobArgsV1,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    if (args.provider === undefined) {
      throw new MeridianConstructError(
        constructErrorCodes.providerRequired,
        "Lifecycle jobs require an explicit provider",
      );
    }
    super(lifecycleJobComponentType, name, { spec: args.spec }, opts);
    const outputs = args.provisioner.provision(name, args.spec, {
      parent: this,
      provider: args.provider,
    });
    this.specFingerprint = pulumi.output(args.spec.specFingerprint);
    this.registerOutputs({ ...outputs, specFingerprint: this.specFingerprint });
  }
}

export function createLifecycleJobSpec(
  input: LifecycleJobInputV1,
): LifecycleJobSpecV1 {
  if (
    ![
      "migration",
      "projection",
      "cache-warm",
      "streaming-bootstrap",
      "backup",
      "restore",
      "validation",
    ].includes(input.kind)
  ) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Lifecycle job kind is invalid",
    );
  }
  assertDigestPinnedImage(input.image, "Lifecycle job image");
  if (input.resources.length === 0) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Lifecycle job resources must be non-empty",
    );
  }
  const resourceKeys = input.resources.map(resourceSelectorKey);
  if (new Set(resourceKeys).size !== resourceKeys.length) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Lifecycle job resources must be unique",
    );
  }
  rejectSecretMaterial(input.operation, "job operation");
  const operation = requireObject(
    normalizeJson(input.operation),
    "job operation",
  );
  if (Object.keys(operation).length === 0) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Lifecycle job operation cannot be empty",
    );
  }
  const extensions = requireObject(
    normalizeJson(input.extensions ?? {}),
    "job extensions",
  );
  rejectSecretMaterial(extensions, "job extensions");
  const dependsOn = [...(input.dependsOn ?? [])].sort();
  if (
    dependsOn.some((item) => item.length === 0) ||
    new Set(dependsOn).size !== dependsOn.length
  ) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Lifecycle job dependencies must be unique names",
    );
  }
  dependsOn.forEach((item) => assertIdentifier(item, "job dependency"));
  const timeoutSeconds = input.timeoutSeconds ?? 3_600;
  const maxAttempts = input.maxAttempts ?? 1;
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 86_400
  ) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Lifecycle job timeout is out of range",
    );
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Lifecycle job max attempts is out of range",
    );
  }
  const secretRefs = [...(input.secretRefs ?? [])].sort((left, right) =>
    `${left.provider}\u0000${left.reference}`.localeCompare(
      `${right.provider}\u0000${right.reference}`,
    ),
  );
  for (const secretRef of secretRefs) {
    assertIdentifier(secretRef.provider, "job secret provider");
    assertBoundedText(secretRef.reference, "job secret reference");
  }
  const secretKeys = secretRefs.map(
    (reference) => `${reference.provider}\u0000${reference.reference}`,
  );
  if (new Set(secretKeys).size !== secretKeys.length) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      "Lifecycle job secret references must be unique",
    );
  }
  const body = {
    formatVersion: "meridian-storage-iac-job.v1" as const,
    kind: input.kind,
    image: input.image,
    resources: [...input.resources].sort((a, b) =>
      resourceSelectorKey(a).localeCompare(resourceSelectorKey(b)),
    ),
    operation,
    secretRefs,
    dependsOn,
    timeoutSeconds,
    maxAttempts,
    extensions,
  };
  return Object.freeze({ ...body, specFingerprint: fingerprint(body) });
}

export function migrationJob(args: {
  readonly image: string;
  readonly resources: readonly ResourceSelectorV1[];
  readonly fromFingerprint: string;
  readonly toFingerprint: string;
  readonly secretRefs?: readonly OpaqueSecretRef[];
}): LifecycleJobSpecV1 {
  assertFingerprint(args.fromFingerprint, "migration source fingerprint");
  assertFingerprint(args.toFingerprint, "migration target fingerprint");
  return createLifecycleJobSpec({
    kind: "migration",
    image: args.image,
    resources: args.resources,
    operation: {
      contract: "meridian.migration.apply",
      version: "1.0.0",
      fromFingerprint: args.fromFingerprint,
      toFingerprint: args.toFingerprint,
    },
    secretRefs: args.secretRefs ?? [],
  });
}

export function projectionJob(args: {
  readonly image: string;
  readonly source: ResourceSelectorV1;
  readonly target: ResourceSelectorV1;
  readonly projectionFingerprint: string;
}): LifecycleJobSpecV1 {
  assertFingerprint(args.projectionFingerprint, "projection fingerprint");
  return createLifecycleJobSpec({
    kind: "projection",
    image: args.image,
    resources: [args.source, args.target],
    operation: {
      contract: "meridian.projection.rebuild",
      version: "1.0.0",
      projectionFingerprint: args.projectionFingerprint,
    },
  });
}

export function cacheWarmJob(args: {
  readonly image: string;
  readonly source: ResourceSelectorV1;
  readonly cache: ResourceSelectorV1;
  readonly generation: string;
}): LifecycleJobSpecV1 {
  assertBoundedText(args.generation, "cache generation", 512);
  return createLifecycleJobSpec({
    kind: "cache-warm",
    image: args.image,
    resources: [args.source, args.cache],
    operation: {
      contract: "meridian.cache.warm",
      version: "1.0.0",
      namespaceGeneration: args.generation,
    },
  });
}

export function streamingBootstrapJob(args: {
  readonly image: string;
  readonly resources: readonly ResourceSelectorV1[];
  readonly mappingFingerprint: string;
}): LifecycleJobSpecV1 {
  assertFingerprint(args.mappingFingerprint, "streaming mapping fingerprint");
  return createLifecycleJobSpec({
    kind: "streaming-bootstrap",
    image: args.image,
    resources: args.resources,
    operation: {
      contract: "meridian.streaming.bootstrap",
      version: "1.0.0",
      mappingFingerprint: args.mappingFingerprint,
    },
  });
}

export function backupJob(args: {
  readonly image: string;
  readonly resources: readonly ResourceSelectorV1[];
  readonly policyRef: string;
}): LifecycleJobSpecV1 {
  assertBoundedText(args.policyRef, "backup policy reference");
  return createLifecycleJobSpec({
    kind: "backup",
    image: args.image,
    resources: args.resources,
    operation: {
      contract: "meridian.recovery.backup",
      version: "1.0.0",
      policyRef: args.policyRef,
    },
  });
}

export function restoreJob(args: {
  readonly image: string;
  readonly resources: readonly ResourceSelectorV1[];
  readonly recoveryPointRef: string;
}): LifecycleJobSpecV1 {
  assertBoundedText(args.recoveryPointRef, "recovery point reference");
  return createLifecycleJobSpec({
    kind: "restore",
    image: args.image,
    resources: args.resources,
    operation: {
      contract: "meridian.recovery.restore",
      version: "1.0.0",
      recoveryPointRef: args.recoveryPointRef,
    },
  });
}

export function validationJob(args: {
  readonly image: string;
  readonly resources: readonly ResourceSelectorV1[];
  readonly expectedConfigFingerprint: string;
}): LifecycleJobSpecV1 {
  assertFingerprint(
    args.expectedConfigFingerprint,
    "expected config fingerprint",
  );
  return createLifecycleJobSpec({
    kind: "validation",
    image: args.image,
    resources: args.resources,
    operation: {
      contract: "meridian.deployment.validate",
      version: "1.0.0",
      expectedConfigFingerprint: args.expectedConfigFingerprint,
    },
  });
}

function requireObject(value: JsonValue, path: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      `${path} must be an object`,
    );
  }
  return value as JsonObject;
}
