// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  clusterAcceptanceStages,
  conformanceEvidence,
  getEngineProfile,
  localClusterProfiles,
  runDeploymentConformance,
  runLocalClusterConformance,
  type ClusterAcceptanceStage,
  type ClusterProbeResultV1,
  type LocalClusterHarnessV1,
  type LocalClusterProfileV1,
} from "../../src/index.js";
import { deploymentSpec } from "../fixtures.js";

class DeterministicClusterEquivalentHarness implements LocalClusterHarnessV1 {
  public async deployAndProbe(
    profile: LocalClusterProfileV1,
  ): Promise<ClusterProbeResultV1> {
    const released = getEngineProfile(profile.engineProfileId);
    return await Promise.resolve({
      engineProfile: released.engineProfile,
      engineVersion: released.defaultEngineVersion,
      adapterId: released.adapterId,
      primaryCount: profile.expectedPrimaryCount,
      healthyRoles: profile.roles,
      operationContracts: Object.keys(released.operations),
      stages: Object.fromEntries(
        clusterAcceptanceStages.map((stage) => [stage, "passed"]),
      ) as Record<ClusterAcceptanceStage, "passed">,
    });
  }
}

describe("local cluster-equivalent conformance", () => {
  it("covers every GA single, cluster, external, and Kafka profile sequence", async () => {
    const results = await runLocalClusterConformance(
      new DeterministicClusterEquivalentHarness(),
    );
    expect(results).toHaveLength(12);
    expect(
      new Set(localClusterProfiles.map((item) => item.engineProfileId)),
    ).toEqual(
      new Set([
        "postgresql-postgis-local-single-primary",
        "postgresql-postgis-cluster",
        "opensearch",
        "clickhouse-standalone",
        "clickhouse-replicated",
        "valkey-standalone",
        "valkey-sentinel",
        "s3-compatible",
        "oci-distribution",
        "apache-kafka-test",
        "apache-kafka",
      ]),
    );
    expect(
      localClusterProfiles
        .filter((item) => item.expectedPrimaryCount !== null)
        .every((item) => item.expectedPrimaryCount === 1),
    ).toBe(true);
    expect(
      results
        .filter(
          (_result, index) =>
            localClusterProfiles[index]?.expectedPrimaryCount === null,
        )
        .every((item) => item.primaryCount === null),
    ).toBe(true);
  });

  it("fails closed when a topology or acceptance stage is incomplete", async () => {
    const harness: LocalClusterHarnessV1 = {
      async deployAndProbe(profile) {
        const released = getEngineProfile(profile.engineProfileId);
        return await Promise.resolve({
          engineProfile: released.engineProfile,
          engineVersion: released.defaultEngineVersion,
          adapterId: released.adapterId,
          primaryCount: 2,
          healthyRoles: profile.roles,
          operationContracts: Object.keys(released.operations),
          stages: Object.fromEntries(
            clusterAcceptanceStages.map((stage) => [stage, "passed"]),
          ) as Record<ClusterAcceptanceStage, "passed">,
        });
      },
    };
    await expect(
      runLocalClusterConformance(harness, [localClusterProfiles[0]!]),
    ).rejects.toThrow(/exactly one primary/);
  });

  it.each([
    ["Engine profile mismatch", { engineProfile: "unexpected" }],
    ["unsupported Engine version", { engineVersion: "0" }],
    ["Adapter identity mismatch", { adapterId: "unexpected" }],
    ["topology roles are unhealthy", { healthyRoles: [] }],
    ["missing operations", { operationContracts: [] }],
    [
      "stage failover did not pass",
      {
        stages: {
          ...Object.fromEntries(
            clusterAcceptanceStages.map((stage) => [stage, "passed"]),
          ),
          failover: "failed",
        },
      },
    ],
  ] as const)("fails closed on %s", async (message, override) => {
    const harness: LocalClusterHarnessV1 = {
      async deployAndProbe(profile) {
        const released = getEngineProfile(profile.engineProfileId);
        return await Promise.resolve({
          engineProfile: released.engineProfile,
          engineVersion: released.defaultEngineVersion,
          adapterId: released.adapterId,
          primaryCount: 1,
          healthyRoles: profile.roles,
          operationContracts: Object.keys(released.operations),
          stages: Object.fromEntries(
            clusterAcceptanceStages.map((stage) => [stage, "passed"]),
          ) as Record<ClusterAcceptanceStage, "passed">,
          ...override,
        } as ClusterProbeResultV1);
      },
    };
    await expect(
      runLocalClusterConformance(harness, [localClusterProfiles[0]!]),
    ).rejects.toThrow(message);
  });

  it("produces deterministic deployment and evidence fingerprints", () => {
    const plan = runDeploymentConformance(deploymentSpec(), 3);
    const first = conformanceEvidence(plan, 3);
    const second = conformanceEvidence(plan, 3);
    expect(second).toEqual(first);
    expect(first.formatVersion).toBe(
      "meridian-storage-constructs-conformance.v1",
    );
    expect(first.localProfiles).toHaveLength(12);
    expect(first.evidenceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => runDeploymentConformance(deploymentSpec(), 1)).toThrow(
      /at least two/,
    );
  });
});
