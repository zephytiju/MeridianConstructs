// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  durableProjectionJob,
  projectionPackagePins,
  projectionCycleBudgetMs,
  projectionHostFiles,
  planDeployment,
  fingerprint,
  type JsonObject,
  type DurableProjectionJobInputV1,
} from "../../src/index.js";
import {
  deploymentSpec,
  ordersRequirement,
  digestImage,
  fingerprintA,
} from "../fixtures.js";

interface FixtureConfig {
  bindings: {
    id: string;
    adapterId: string;
    engineVersion: string;
    engineProfile: string;
    requiredPhysicalFingerprint: string | null;
    requiredCapabilityFingerprint: string;
  }[];
  resources: { pins: unknown[] };
  placements: {
    id: string;
    bindingId: string;
    selector: {
      resources: import("../../src/index.js").ResourceSelectorV1[];
      catalog: string | null;
      labels: Record<string, string>;
    };
    extensions: Record<string, string>;
  }[];
}
interface FixtureManifest {
  descriptor: {
    capabilities: {
      operationContract: string;
      operationVersions: string[];
      guarantees: string[];
    }[];
  };
  availableOperationContracts: string[];
}
const manifest = JSON.parse(
  readFileSync(
    new URL("../fixtures/postgresql-2.1.0-manifest.json", import.meta.url),
    "utf8",
  ),
) as JsonObject;

function input(): DurableProjectionJobInputV1 {
  const source = ordersRequirement.selector;
  const outbox = { ...source, name: "outbox" };
  const target = { ...source, name: "target" };
  const deployment = deploymentSpec({
    resources: [source, outbox, target].map((selector) => ({
      ...ordersRequirement,
      selector,
    })),
    placements: [
      {
        id: "all",
        selector: { catalog: "structured", resources: [], labels: {} },
        bindingId: "orders-db",
        extensions: {},
      },
    ],
  });
  const config = JSON.parse(
    planDeployment(deployment).runtimeConfigJson,
  ) as FixtureConfig;

  config.bindings[0]!.engineVersion = manifest.engineVersion as string;
  config.bindings[0]!.engineProfile = manifest.engineProfile as string;
  config.bindings[0]!.requiredCapabilityFingerprint = fingerprint(manifest);
  return {
    image: digestImage,
    runtimeConfig: config as unknown as JsonObject,
    packages: { ...projectionPackagePins },
    source,
    outbox,
    target,
    sourceSchema: "orders.records@1.0.0",
    targetSchema: "orders.target@1.0.0",
    name: "orders",
    projectionFingerprint: fingerprintA,
    manifests: { "orders-db": manifest },
    budgets: {
      batchSize: 2,
      poisonThreshold: 3,
      pollIntervalMs: 10,
      calls: {
        claim: 1000,
        load: 100,
        project: 100,
        target: 1000,
        acknowledge: 100,
        complete: 1000,
        release: 1000,
        lag: 1000,
        evidence: 100,
      },
      overheadMs: 1000,
      drainMs: 15000,
      leaseMs: 20000,
      leaseMarginMs: 1000,
      terminationGraceMs: 17000,
    },
    dependsOn: ["migrate-orders"],
  };
}

describe("durable projection deployment", () => {
  it("pins the provider, resources, references, whole-cycle budget and read composition", () => {
    const args = input();
    const job = durableProjectionJob(args);
    expect(job).toEqual(durableProjectionJob(args));
    expect(job.operation).toMatchObject({
      contract: "meridian.projection.worker",
      sourceBindingId: "orders-db",
      targetProfile: "version-addressed-integer-v1",
      readPolicy: "latest-before-tombstone-and-business-filters",
      packages: projectionPackagePins,
      budgets: { cycleBudgetMs: 10100 },
    });
    expect(job.secretRefs).toHaveLength(3);
    expect(job.dependsOn).toEqual(["migrate-orders"]);
    expect(projectionHostFiles()["worker.py"]).toContain("PostgreSQLOutbox");
    expect(projectionHostFiles()["supervisor.py"]).toContain("SIGKILL");
    expect(projectionHostFiles()["versioned_target.py"]).toContain(
      "latest_visible",
    );
  });

  it.each([NaN, Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER])(
    "rejects unsafe call bound %s",
    (value) => {
      const args = input();
      expect(() =>
        projectionCycleBudgetMs({
          ...args.budgets,
          calls: { ...args.budgets.calls, target: value },
        }),
      ).toThrow();
    },
  );
  it.each(["drainMs", "leaseMs", "terminationGraceMs"] as const)(
    "rejects insufficient %s",
    (field) => {
      const args = input();
      expect(() =>
        durableProjectionJob({
          ...args,
          budgets: { ...args.budgets, [field]: 1000 },
        }),
      ).toThrow(/cycle/);
    },
  );
  it("rejects invalid role, schema, migration and batch settings", () => {
    const args = input();
    for (const change of [
      { outbox: args.source },
      { target: { ...args.target, catalog: "cache" as const } },
      { sourceSchema: "elsewhere.source@1.0.0" },
      { dependsOn: [] },
    ]) {
      expect(() => durableProjectionJob({ ...args, ...change })).toThrow();
    }
    for (const change of [
      { batchSize: 1001 },
      { poisonThreshold: 101 },
      { pollIntervalMs: -1 },
    ]) {
      expect(() =>
        durableProjectionJob({
          ...args,
          budgets: { ...args.budgets, ...change },
        }),
      ).toThrow();
    }
  });
  it.each([
    "missing-pin",
    "ambiguous",
    "missing-placement",
    "unknown-binding",
    "cross-binding",
    "old-package",
    "wrong-adapter",
    "missing-physical",
    "wrong-manifest",
    "missing-capability",
    "wrong-guarantee",
    "wrong-version",
  ])("fails before processing for %s", (fault) => {
    const args = input();
    const config = structuredClone(
      args.runtimeConfig,
    ) as unknown as FixtureConfig;
    const binding = config.bindings[0]!;
    let selectedManifest = structuredClone(
      manifest,
    ) as unknown as FixtureManifest;
    if (fault === "missing-pin") config.resources.pins.pop();
    if (fault === "ambiguous")
      config.placements.push({ ...config.placements[0]!, id: "duplicate" });
    if (fault === "missing-placement")
      config.placements[0]!.selector.catalog = "cache";
    if (fault === "unknown-binding")
      config.placements[0]!.bindingId = "unknown";
    if (fault === "cross-binding") {
      config.bindings.push({ ...binding, id: "other" });
      config.placements = [args.source, args.outbox, args.target].map(
        (r, i) => ({
          id: `role-${i}`,
          bindingId: i === 1 ? "other" : "orders-db",
          selector: { resources: [r], catalog: null, labels: {} },
          extensions: {},
        }),
      );
    }
    if (fault === "old-package")
      (args.packages as Record<string, string>)["meridian-storage-postgresql"] =
        "1.0.0";
    if (fault === "wrong-adapter") binding.adapterId = "opensearch";
    if (fault === "missing-physical")
      binding.requiredPhysicalFingerprint = null;
    if (fault === "wrong-manifest") selectedManifest = {} as FixtureManifest;
    if (
      ["missing-capability", "wrong-guarantee", "wrong-version"].includes(fault)
    ) {
      const op = selectedManifest.descriptor.capabilities.find(
        (c) => c.operationContract === "meridian.structured.put",
      )!;
      if (fault === "missing-capability")
        selectedManifest.availableOperationContracts = [];
      if (fault === "wrong-guarantee") op.guarantees = [];
      if (fault === "wrong-version") op.operationVersions = ["1.0.0"];
      binding.requiredCapabilityFingerprint = fingerprint(selectedManifest);
    }
    expect(() =>
      durableProjectionJob({
        ...args,
        runtimeConfig: config as unknown as JsonObject,
        manifests: { "orders-db": selectedManifest as unknown as JsonObject },
      }),
    ).toThrow();
  });
});
