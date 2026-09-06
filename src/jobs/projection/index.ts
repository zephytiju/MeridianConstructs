// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import {
  fingerprint,
  type JsonObject,
  type JsonValue,
} from "../../canonical.js";
import {
  assertFingerprint,
  assertIdentifier,
  resourceSelectorKey,
  validateEngineConnection,
  type EngineConnectionV1,
  type OpaqueSecretRef,
  type ResourceSelectorV1,
} from "../../contracts/index.js";
import { validateRuntimeConfig } from "../../runtime-config/index.js";
import { createLifecycleJobSpec, type LifecycleJobSpecV1 } from "../index.js";

/** Exact, independently released durable integration. No workspace dependencies. */
export const projectionPackagePins = Object.freeze({
  "meridian-storage-core": "1.0.1",
  "meridian-storage-semantics": "2.0.0",
  "meridian-storage-query": "1.0.2",
  "meridian-storage-projection": "1.0.2",
  "meridian-storage-postgresql": "2.1.0",
});

export interface ProjectionBudgetsV1 {
  readonly batchSize: number;
  readonly poisonThreshold: number;
  readonly pollIntervalMs: number;
  /** Whole calls, including internal pool waits and retries, in milliseconds. */
  readonly calls: Readonly<
    Record<
      | "claim"
      | "load"
      | "project"
      | "target"
      | "acknowledge"
      | "complete"
      | "release"
      | "lag"
      | "evidence",
      number
    >
  >;
  readonly overheadMs: number;
  readonly drainMs: number;
  readonly leaseMs: number;
  readonly leaseMarginMs: number;
  readonly terminationGraceMs: number;
}

export interface DurableProjectionJobInputV1 {
  readonly image: string;
  /** Closed config rendered by the owning IaC package, using released descriptors. */
  readonly runtimeConfig: JsonObject;
  readonly packages: Readonly<Record<string, string>>;
  readonly source: ResourceSelectorV1;
  readonly outbox: ResourceSelectorV1;
  readonly target: ResourceSelectorV1;
  /** Required atomic Evidence participants; unlisted Evidence remains independent. */
  readonly requiredEvidence?: readonly ResourceSelectorV1[];
  readonly sourceSchema: string;
  readonly targetSchema: string;
  readonly name: string;
  readonly projectionFingerprint: string;
  /** Complete released CapabilityManifest.to_dict() per selected Binding. */
  readonly manifests: Readonly<Record<string, JsonObject>>;
  readonly budgets: ProjectionBudgetsV1;
  /** Explicit migration/validation job names; never runtime startup DDL. */
  readonly dependsOn: readonly string[];
}

export function projectionCycleBudgetMs(b: ProjectionBudgetsV1): number {
  const numbers = [
    b.batchSize,
    b.poisonThreshold,
    b.overheadMs,
    b.drainMs,
    b.leaseMs,
    b.leaseMarginMs,
    b.terminationGraceMs,
    ...Object.values(b.calls),
  ];
  if (
    numbers.some((n) => !Number.isSafeInteger(n) || n < 1) ||
    !Number.isSafeInteger(b.pollIntervalMs) ||
    b.pollIntervalMs < 0 ||
    b.batchSize > 1000 ||
    b.poisonThreshold > 100
  ) {
    throw new Error("Projection budgets must be finite bounded integers");
  }
  const c = b.calls;
  // Include success followed by evidence failure/release and a second evidence call.
  const cycle =
    c.claim +
    b.batchSize *
      (c.load +
        c.project +
        c.target +
        c.acknowledge +
        c.complete +
        c.release +
        2 * c.evidence) +
    c.lag +
    c.evidence +
    b.overheadMs;
  if (
    !Number.isSafeInteger(cycle) ||
    cycle > b.drainMs ||
    cycle + b.leaseMarginMs > b.leaseMs ||
    b.terminationGraceMs < b.drainMs + 1000
  ) {
    throw new Error(
      "Full projection cycle must fit drain and lease with termination margin",
    );
  }
  return cycle;
}

function object(value: JsonValue | undefined): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Projection configuration requires an object");
  }
  return value as JsonObject;
}

function array(value: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(value))
    throw new Error("Projection configuration requires an array");
  return value as JsonValue[];
}

function key(value: JsonValue): string {
  return resourceSelectorKey(object(value) as unknown as ResourceSelectorV1);
}

/** Validated ordinary workload template; the caller retains provider and lifecycle authority. */
export function durableProjectionJob(
  input: DurableProjectionJobInputV1,
): LifecycleJobSpecV1 {
  validateRuntimeConfig(input.runtimeConfig);
  assertIdentifier(input.name, "projection name");
  assertFingerprint(input.projectionFingerprint, "projection fingerprint");
  const cycleBudgetMs = projectionCycleBudgetMs(input.budgets);
  const config = structuredClone(input.runtimeConfig);
  if (input.dependsOn.length === 0)
    throw new Error("Projection requires explicit migration dependencies");
  const roles = [input.source, input.outbox, input.target];
  const keys = roles.map(resourceSelectorKey);
  if (
    new Set(keys).size !== 3 ||
    roles.some((r) => r.catalog !== "structured")
  ) {
    throw new Error(
      "Initial projection profile requires three distinct Structured Resources",
    );
  }
  const declaration: unknown = input.requiredEvidence;
  if (declaration !== undefined && !Array.isArray(declaration)) {
    throw new Error("Required Evidence must be an array of Resource selectors");
  }
  const requiredEvidence = [...(input.requiredEvidence ?? [])].sort((a, b) => {
    const left = resourceSelectorKey(a);
    const right = resourceSelectorKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const evidenceKeys = requiredEvidence.map(resourceSelectorKey);
  if (
    requiredEvidence.some((r) => r.catalog !== "evidence") ||
    new Set(evidenceKeys).size !== evidenceKeys.length
  ) {
    throw new Error("Required Evidence must name distinct Evidence Resources");
  }
  if (
    requiredEvidence.length > 0 &&
    array(object(config.catalogs).providers).filter(
      (p) => object(p).name === "evidence",
    ).length !== 1
  ) {
    throw new Error("Required Evidence needs a registered Evidence Catalog");
  }
  const packages: Record<string, string> = { ...projectionPackagePins };
  for (const [name, version] of Object.entries(projectionPackagePins)) {
    if (input.packages[name] !== version)
      throw new Error("Projection requires exact released package pins");
  }
  const evidencePackage = "meridian-storage-evidence";
  if (
    requiredEvidence.length > 0 ||
    Object.hasOwn(input.packages, evidencePackage)
  ) {
    if (input.packages[evidencePackage] !== "1.0.1")
      throw new Error(
        "Projection requires the compatible Evidence package pin",
      );
    packages[evidencePackage] = "1.0.1";
  }
  for (const [schema, resource] of [
    [input.sourceSchema, input.source],
    [input.targetSchema, input.target],
  ] as const) {
    if (
      !schema.startsWith(`${resource.namespace}.${resource.name}@`) ||
      !/^.+@\d+\.\d+\.\d+$/.test(schema)
    ) {
      throw new Error(
        "Projection Schema must pin the logical Resource and exact version",
      );
    }
  }
  const pins = array(object(config.resources).pins);
  const bindings = array(config.bindings).map(object);
  const placements = array(config.placements).map(object);
  const resolved = [...roles, ...requiredEvidence].map((role) => {
    const ref = resourceSelectorKey(role);
    if (pins.filter((p) => key(object(p).ref!) === ref).length !== 1) {
      throw new Error(
        "Projection requires one released Resource fingerprint pin per role",
      );
    }
    const matches = placements.filter((p) => {
      const selector = object(p.selector);
      const resources = array(selector.resources);
      return (
        (resources.length === 0 || resources.some((r) => key(r) === ref)) &&
        (selector.catalog === null || selector.catalog === role.catalog) &&
        Object.keys(object(selector.labels)).length === 0
      );
    });
    if (matches.length !== 1)
      throw new Error("Projection requires exact-one Resource placement");
    const selected = bindings.filter((b) => b.id === matches[0]!.bindingId);
    if (selected.length !== 1)
      throw new Error("Projection references an unresolved Binding");
    return selected[0]!;
  });
  if (resolved[0]!.id !== resolved[1]!.id) {
    throw new Error(
      "Source and required intent must resolve to the same Binding",
    );
  }
  if (resolved.slice(3).some((binding) => binding.id !== resolved[0]!.id)) {
    throw new Error(
      "Required Evidence must share the source and intent Binding",
    );
  }
  const secretRefs = new Map<string, OpaqueSecretRef>();
  for (const binding of resolved) {
    validateEngineConnection(binding as unknown as EngineConnectionV1);
    if (
      binding.adapterId !== "postgresql" ||
      typeof binding.id !== "string" ||
      typeof binding.requiredPhysicalFingerprint !== "string"
    ) {
      throw new Error(
        "Initial durable projection requires migrated PostgreSQL Bindings",
      );
    }
    const manifest = input.manifests[binding.id];
    if (
      !manifest ||
      fingerprint(manifest) !== binding.requiredCapabilityFingerprint ||
      manifest.engineProfile !== binding.engineProfile ||
      manifest.engineVersion !== binding.engineVersion ||
      object(manifest.descriptor).adapterId !== binding.adapterId
    ) {
      throw new Error(
        "Projection Capability manifest does not match its Binding",
      );
    }
    const operations = array(object(manifest.descriptor).capabilities).map(
      object,
    );
    const requirements = [
      ["meridian.structured.put", "2.0.0", "single-binding"],
      ["meridian.structured.query", "1.0.0", "strong-consistency"],
      ["meridian.transaction", "1.0.0", "atomic"],
    ];
    if (requiredEvidence.length > 0 && binding.id === resolved[0]!.id) {
      requirements.push([
        "meridian.evidence.append",
        "1.0.0",
        "atomic-evidence",
      ]);
    }
    for (const [contract, version, guarantee] of requirements) {
      if (
        !array(manifest.availableOperationContracts).includes(contract!) ||
        !operations.some(
          (op) =>
            op.operationContract === contract &&
            array(op.operationVersions).includes(version!) &&
            array(op.guarantees).includes(guarantee!),
        )
      ) {
        throw new Error(
          "Projection Binding lacks required released Operations or guarantees",
        );
      }
    }
    for (const ref of [
      binding.identityRef,
      binding.secretRef,
      object(binding.tls).caRef,
      object(binding.tls).clientCertificateRef,
    ]) {
      if (ref) {
        const opaque = object(ref) as unknown as OpaqueSecretRef;
        secretRefs.set(`${opaque.provider}\0${opaque.reference}`, opaque);
      }
    }
  }
  return createLifecycleJobSpec({
    kind: "projection",
    image: input.image,
    resources: [...roles, ...requiredEvidence],
    secretRefs: [...secretRefs.values()],
    dependsOn: input.dependsOn,
    operation: {
      contract: "meridian.projection.worker",
      version: requiredEvidence.length > 0 ? "1.1.0" : "1.0.0",
      ...(requiredEvidence.length > 0
        ? { requiredEvidence: evidenceKeys }
        : {}),
      name: input.name,
      source: keys[0]!,
      outbox: keys[1]!,
      target: keys[2]!,
      sourceSchema: input.sourceSchema,
      targetSchema: input.targetSchema,
      projectionFingerprint: input.projectionFingerprint,
      targetProfile: "version-addressed-integer-v1",
      readPolicy: "latest-before-tombstone-and-business-filters",
      retentionPolicy: "retain-versions-including-latest-tombstones",
      sourceBindingId: resolved[0]!.id!,
      targetBindingId: resolved[2]!.id!,
      configFingerprint: fingerprint(config),
      packages,
      budgets: {
        ...input.budgets,
        calls: { ...input.budgets.calls },
        cycleBudgetMs,
      },
    },
    extensions: { runtimeConfig: config },
  });
}

/** Copy these ordinary host templates into the caller-owned digest-pinned image. */
export function projectionHostFiles(): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      [
        "worker.py",
        "supervisor.py",
        "versioned_target.py",
        "requirements.txt",
      ].map((name) => [
        name,
        readFileSync(new URL(`./assets/${name}`, import.meta.url), "utf8"),
      ]),
    ),
  );
}
