// SPDX-License-Identifier: Apache-2.0

import { fingerprint } from "../canonical.js";
import type { DeploymentSpecV1, Topology } from "../contracts/index.js";
import {
  compatibilityFingerprint,
  getEngineProfile,
} from "../profiles/index.js";
import {
  planDeployment,
  validateRuntimeConfig,
  type DeploymentPlanV1,
} from "../runtime-config/index.js";

export const clusterAcceptanceStages = [
  "fresh-apply",
  "no-change-apply",
  "workload-connection",
  "topology-expansion",
  "member-restart",
  "failover",
  "rebalance",
  "backup-or-replicated-log-check",
  "isolated-target-recreation",
  "restore-or-position-recovery",
  "runtime-startup-validation",
  "semantic-conformance",
] as const;
export type ClusterAcceptanceStage = (typeof clusterAcceptanceStages)[number];

export interface LocalClusterProfileV1 {
  readonly id: string;
  readonly engineProfileId: string;
  readonly topology: Topology;
  readonly roles: readonly string[];
  readonly expectedPrimaryCount: 1 | null;
}

export interface ClusterProbeResultV1 {
  readonly engineProfile: string;
  readonly engineVersion: string;
  readonly adapterId: string;
  readonly primaryCount: number | null;
  readonly healthyRoles: readonly string[];
  readonly operationContracts: readonly string[];
  readonly stages: Readonly<Record<ClusterAcceptanceStage, "passed">>;
}

export interface LocalClusterHarnessV1 {
  deployAndProbe(profile: LocalClusterProfileV1): Promise<ClusterProbeResultV1>;
}

export interface ConformanceEvidenceV1 {
  readonly formatVersion: "meridian-storage-constructs-conformance.v1";
  readonly deploymentFingerprint: string;
  readonly compatibilityFingerprint: string;
  readonly repeatCount: number;
  readonly localProfiles: readonly string[];
  readonly evidenceFingerprint: string;
}

export const localClusterProfiles: readonly LocalClusterProfileV1[] =
  Object.freeze([
    {
      id: "postgresql-single-primary",
      engineProfileId: "postgresql-postgis-local-single-primary",
      topology: "single-primary",
      roles: ["primary"],
      expectedPrimaryCount: 1,
    },
    {
      id: "postgresql-cluster",
      engineProfileId: "postgresql-postgis-cluster",
      topology: "cluster",
      roles: ["primary", "standby-1", "standby-2"],
      expectedPrimaryCount: 1,
    },
    {
      id: "opensearch-single",
      engineProfileId: "opensearch",
      topology: "single-primary",
      roles: ["node-1"],
      expectedPrimaryCount: null,
    },
    {
      id: "opensearch-cluster",
      engineProfileId: "opensearch",
      topology: "cluster",
      roles: ["node-1", "node-2", "node-3"],
      expectedPrimaryCount: null,
    },
    {
      id: "clickhouse-single",
      engineProfileId: "clickhouse-standalone",
      topology: "single-primary",
      roles: ["primary"],
      expectedPrimaryCount: null,
    },
    {
      id: "clickhouse-cluster",
      engineProfileId: "clickhouse-replicated",
      topology: "cluster",
      roles: ["primary", "replica", "keeper-1", "keeper-2", "keeper-3"],
      expectedPrimaryCount: null,
    },
    {
      id: "valkey-single",
      engineProfileId: "valkey-standalone",
      topology: "single-primary",
      roles: ["primary"],
      expectedPrimaryCount: 1,
    },
    {
      id: "valkey-sentinel",
      engineProfileId: "valkey-sentinel",
      topology: "cluster",
      roles: [
        "primary",
        "replica-1",
        "replica-2",
        "sentinel-1",
        "sentinel-2",
        "sentinel-3",
      ],
      expectedPrimaryCount: 1,
    },
    {
      id: "s3-compatible",
      engineProfileId: "s3-compatible",
      topology: "single-primary",
      roles: ["primary"],
      expectedPrimaryCount: null,
    },
    {
      id: "oci-distribution",
      engineProfileId: "oci-distribution",
      topology: "provider-managed",
      roles: ["registry"],
      expectedPrimaryCount: null,
    },
    {
      id: "kafka-test",
      engineProfileId: "apache-kafka-test",
      topology: "test",
      roles: ["controller-broker"],
      expectedPrimaryCount: null,
    },
    {
      id: "kafka-cluster",
      engineProfileId: "apache-kafka",
      topology: "cluster",
      roles: [
        "controller-1",
        "controller-2",
        "controller-3",
        "broker-1",
        "broker-2",
        "broker-3",
      ],
      expectedPrimaryCount: null,
    },
  ]);

export function runDeploymentConformance(
  spec: DeploymentSpecV1,
  repeatCount = 3,
): DeploymentPlanV1 {
  if (!Number.isInteger(repeatCount) || repeatCount < 2) {
    throw new RangeError("Conformance repeat count must be at least two");
  }
  const plans = Array.from({ length: repeatCount }, () => planDeployment(spec));
  const first = plans[0]!;
  if (
    plans.some((plan) => plan.runtimeConfigJson !== first.runtimeConfigJson)
  ) {
    throw new Error("Repeated deployment planning was not deterministic");
  }
  validateRuntimeConfig(first.runtimeConfig);
  return first;
}

export async function runLocalClusterConformance(
  harness: LocalClusterHarnessV1,
  profiles: readonly LocalClusterProfileV1[] = localClusterProfiles,
): Promise<readonly ClusterProbeResultV1[]> {
  const results: ClusterProbeResultV1[] = [];
  for (const testProfile of profiles) {
    const released = getEngineProfile(testProfile.engineProfileId);
    const observed = await harness.deployAndProbe(testProfile);
    if (observed.engineProfile !== released.engineProfile) {
      throw new Error(`${testProfile.id}: Engine profile mismatch`);
    }
    if (!released.supportedEngineVersions.includes(observed.engineVersion)) {
      throw new Error(`${testProfile.id}: unsupported Engine version`);
    }
    if (observed.adapterId !== released.adapterId) {
      throw new Error(`${testProfile.id}: Adapter identity mismatch`);
    }
    if (
      testProfile.expectedPrimaryCount !== null &&
      observed.primaryCount !== testProfile.expectedPrimaryCount
    ) {
      throw new Error(`${testProfile.id}: expected exactly one primary`);
    }
    if (!sameSet(observed.healthyRoles, testProfile.roles)) {
      throw new Error(
        `${testProfile.id}: topology roles are unhealthy or incomplete`,
      );
    }
    const missingOperations = Object.keys(released.operations).filter(
      (operation) => !observed.operationContracts.includes(operation),
    );
    if (missingOperations.length > 0) {
      throw new Error(
        `${testProfile.id}: missing operations ${missingOperations.sort().join(", ")}`,
      );
    }
    for (const stage of clusterAcceptanceStages) {
      if (observed.stages[stage] !== "passed") {
        throw new Error(`${testProfile.id}: stage ${stage} did not pass`);
      }
    }
    results.push(observed);
  }
  return Object.freeze(results);
}

export function conformanceEvidence(
  plan: DeploymentPlanV1,
  repeatCount: number,
  profiles: readonly LocalClusterProfileV1[] = localClusterProfiles,
): ConformanceEvidenceV1 {
  const body = {
    deploymentFingerprint: plan.fingerprint,
    compatibilityFingerprint: compatibilityFingerprint(),
    repeatCount,
    localProfiles: profiles.map((item) => item.id),
  };
  return Object.freeze({
    formatVersion: "meridian-storage-constructs-conformance.v1",
    ...body,
    evidenceFingerprint: fingerprint(body),
  });
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((item) => right.includes(item))
  );
}
