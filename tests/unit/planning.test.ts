// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  MeridianConstructError,
  catalogPlacementRules,
  diffPlans,
  planDeployment,
  runtimeEnvironment,
  validateRuntimeConfig,
} from "../../src/index.js";
import {
  catalogs,
  deploymentSpec,
  externalBinding,
  fingerprintA,
  fingerprintB,
  ordersRequirement,
  placement,
} from "../fixtures.js";

describe("deterministic deployment planning", () => {
  it("renders a closed canonical runtime configuration", () => {
    const first = planDeployment(deploymentSpec());
    const second = planDeployment(deploymentSpec());
    expect(second.runtimeConfigJson).toBe(first.runtimeConfigJson);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(() => validateRuntimeConfig(first.runtimeConfig)).not.toThrow();
    expect(first.runtimeConfig.formatVersion).toBe("meridian-config.v1");
    const runtime = JSON.parse(first.runtimeConfigJson) as Record<
      string,
      unknown
    >;
    const runtimeCatalogs = runtime.catalogs as {
      providers: { name: string }[];
    };
    expect(runtimeCatalogs.providers.map((item) => item.name)).toEqual([
      "cache",
      "evidence",
      "object",
      "streaming",
      "structured",
    ]);
    expect(first.resourceBindings["structured:orders.records"]).toMatchObject({
      capabilityKey:
        "juntai.platform.meridian.resource.structured.orders.records@1.0.0",
      schemaFingerprint: fingerprintB,
    });
    expect(first.runtimeConfigJson).not.toContain("password");
    expect(first.runtimeConfigJson).not.toContain("privateKey");
  });

  it("requires the exact Catalog registry", () => {
    expect(() =>
      planDeployment(deploymentSpec({ catalogs: catalogs.slice(0, 4) })),
    ).toThrow(/Catalog registry must be exactly/);
    expect(() =>
      planDeployment(
        deploymentSpec({
          catalogs: [
            ...catalogs.slice(0, 4),
            { ...catalogs[4]!, name: "audit" as never },
          ],
        }),
      ),
    ).toThrow(/Catalog registry must be exactly/);
  });

  it("fails closed on missing or ambiguous placement", () => {
    expect(() => planDeployment(deploymentSpec({ placements: [] }))).toThrow(
      /must be non-empty/,
    );
    expect(() =>
      planDeployment(
        deploymentSpec({
          placements: [placement, { ...placement, id: "orders-also" }],
        }),
      ),
    ).toThrow(/AMBIGUOUS_PLACEMENT/);
  });

  it("rejects unsupported Operations, guarantees, and limits", () => {
    expect(() =>
      planDeployment(
        deploymentSpec({
          resources: [
            {
              ...ordersRequirement,
              operations: [
                { contract: "meridian.structured.native", version: "1.0.0" },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/INCOMPATIBLE_OPERATION/);
    expect(() =>
      planDeployment(
        deploymentSpec({
          resources: [
            {
              ...ordersRequirement,
              operations: [
                {
                  contract: "meridian.structured.get",
                  version: "1.0.0",
                  guarantees: ["serializable"],
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/INCOMPATIBLE_GUARANTEE/);
    expect(() =>
      planDeployment(
        deploymentSpec({
          resources: [
            {
              ...ordersRequirement,
              operations: [
                {
                  contract: "meridian.structured.get",
                  version: "1.0.0",
                  limits: { maxPageSize: 501 },
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/LIMIT_EXCEEDED/);
    expect(() =>
      planDeployment(
        deploymentSpec({
          resources: [
            {
              ...ordersRequirement,
              guarantees: {
                required: [],
                consistency: "serializable",
              },
            },
          ],
        }),
      ),
    ).toThrow(/INCOMPATIBLE_GUARANTEE/);
  });

  it("checks replay and recovery objectives as deployment requirements", () => {
    expect(() =>
      planDeployment(
        deploymentSpec({
          resources: [
            {
              ...ordersRequirement,
              retentionReplay: { rpoSeconds: 100 },
            },
          ],
        }),
      ),
    ).toThrow(/cannot satisfy RPO 100 seconds/);
    expect(() =>
      planDeployment(
        deploymentSpec({
          resources: [
            {
              ...ordersRequirement,
              retentionReplay: { replayRequired: true },
            },
          ],
        }),
      ),
    ).toThrow(/requires the explicit meridian.streaming.replay Operation/);
  });

  it("rejects incompatible versions, pins, modes, and topologies", () => {
    expect(() =>
      planDeployment(
        deploymentSpec({
          bindings: [externalBinding({ engineVersion: "99.0" })],
        }),
      ),
    ).toThrow(/VERSION_NOT_PINNED/);
    expect(() =>
      planDeployment(
        deploymentSpec({
          bindings: [
            externalBinding({
              compatibilityPins: { "meridian-storage-postgresql": "0.1.0" },
            }),
          ],
        }),
      ),
    ).toThrow(/must pin meridian-storage-postgresql=1.0.0/);
    expect(() =>
      planDeployment(
        deploymentSpec({
          bindings: [externalBinding({ topology: "cluster" })],
        }),
      ),
    ).toThrow(/unsupported topology/);
    expect(() =>
      planDeployment(
        deploymentSpec({
          bindings: [externalBinding({ mode: "both" as never })],
        }),
      ),
    ).toThrow(/unsupported mode/);
  });

  it("requires physical fingerprints under strict validation", () => {
    expect(() =>
      planDeployment(
        deploymentSpec({
          bindings: [
            externalBinding({
              connection: {
                ...externalBinding().connection,
                requiredPhysicalFingerprint: null,
              },
            }),
          ],
        }),
      ),
    ).toThrow(/requires physical fingerprints/);
  });

  it("publishes deterministic plan diffs and runtime selectors", () => {
    const before = planDeployment(deploymentSpec());
    const after = planDeployment(
      deploymentSpec({
        profile: "production",
        extensions: { release: "2026.08" },
      }),
    );
    expect(diffPlans(before, before).isEmpty).toBe(true);
    expect(diffPlans(before, after)).toMatchObject({
      addedResources: [],
      removedResources: [],
      changedResources: ["structured:orders.records"],
      configChanged: true,
      isEmpty: false,
    });
    expect(
      runtimeEnvironment("/etc/meridian/config.json", "production"),
    ).toEqual({
      MERIDIAN_CONFIG: "/etc/meridian/config.json",
      MERIDIAN_PROFILE: "production",
    });
    expect(catalogPlacementRules({ structured: "orders-db" })).toEqual([
      {
        id: "primary-structured",
        selector: { resources: [], catalog: "structured", labels: {} },
        bindingId: "orders-db",
        extensions: { selection: "one-primary" },
      },
    ]);
  });

  it("reports schema validation failures without exposing values", () => {
    expect(() => validateRuntimeConfig({ formatVersion: "wrong" })).toThrow(
      MeridianConstructError,
    );
    expect(() => runtimeEnvironment("")).toThrow(/bounded non-empty text/);
    expect(fingerprintA).toHaveLength(71);
  });
});
