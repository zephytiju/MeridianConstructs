// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  fingerprint,
  planDeployment,
  type JsonObject,
} from "../../src/index.js";
import {
  deploymentSpec,
  externalBinding,
  ordersRequirement,
} from "../fixtures.js";

const selected = JSON.parse(
  readFileSync("tests/fixtures/released-capabilities/inventory.json", "utf8"),
) as {
  profiles: Record<string, { manifest: JsonObject; fingerprint: string }>;
};

function ch(settings: JsonObject, minimum: number, manifest?: JsonObject) {
  const binding = externalBinding({
    profileId: "clickhouse-standalone",
    engineVersion: "25.8",
    compatibilityPins: {
      "meridian-storage-core": "1.1.0",
      "meridian-storage-semantics": "2.1.0",
      "meridian-storage-query": "1.0.3",
      "meridian-storage-clickhouse": "1.1.1",
    },
    ...(manifest === undefined
      ? {}
      : {
          capabilityManifest: manifest,
          requiredCapabilityFingerprint: fingerprint(manifest),
          engineVersion: "25.3",
        }),
  });
  return deploymentSpec({
    bindings: [{ ...binding, connection: { ...binding.connection, settings } }],
    resources: [
      {
        ...ordersRequirement,
        operations: [
          {
            contract: "meridian.structured.put",
            version: "1.0.0",
            limits: { maxBatchRows: minimum },
          },
        ],
      },
    ],
  });
}

describe("deployment-selected capability limits", () => {
  it("enforces both resource and operation minimum limits", () => {
    const spec = ch({ maxBatchRows: 100 }, 50);
    const resources = spec.resources.map((resource) => ({
      ...resource,
      limits: { values: { maxBatchRows: 101 } },
    }));
    expect(() => planDeployment({ ...spec, resources })).toThrow(
      /maxBatchRows/,
    );
    const stricterOperation = ch({ maxBatchRows: 100 }, 101);
    expect(() =>
      planDeployment({
        ...stricterOperation,
        resources: stricterOperation.resources.map((resource) => ({
          ...resource,
          limits: { values: { maxBatchRows: 50 } },
        })),
      }),
    ).toThrow(/maxBatchRows/);
  });
  for (const limit of [100, 20000]) {
    it(`accepts the selected ${limit} rows and rejects one above without a new manifest input`, () => {
      const spec = ch({ maxBatchRows: limit }, limit);
      expect(() => planDeployment(spec)).not.toThrow();
      expect(() =>
        planDeployment(ch({ maxBatchRows: limit }, limit + 1)),
      ).toThrow(/maxBatchRows/);
      expect(planDeployment(spec)).toEqual(planDeployment(spec));
      expect(planDeployment(spec).runtimeConfig.bindings).toMatchObject([
        { settings: { maxBatchRows: limit } },
      ]);
    });
  }
  it("does not increase an explicit manifest's bounds or add missing limits", () => {
    const manifest = selected.profiles["clickhouse-standalone"]!.manifest;
    expect(() =>
      planDeployment(ch({ maxBatchRows: 20000 }, 10001, manifest)),
    ).toThrow(/maxBatchRows/);
    expect(() =>
      planDeployment(ch({ maxBatchRows: 100 }, 101, manifest)),
    ).toThrow(/maxBatchRows/);
    const empty = structuredClone(manifest);
    const descriptor = empty.descriptor as JsonObject;
    const caps = descriptor.capabilities as JsonObject[];
    const changed = {
      ...empty,
      descriptor: {
        ...descriptor,
        capabilities: caps.map((c) => ({ ...c, limits: {} })),
      },
    };
    expect(() => planDeployment(ch({ maxBatchRows: 100 }, 1, changed))).toThrow(
      /maxBatchRows/,
    );
  });
  for (const value of [0, -1, 1.1, true, "100", null, 1000001]) {
    it(`rejects invalid selected rows ${String(value)}`, () => {
      expect(() => planDeployment(ch({ maxBatchRows: value }, 1))).toThrow(
        /released configuration contract/,
      );
    });
  }
  for (const container of [null, true, 1, "bad", []]) {
    it(`rejects malformed nested limit settings ${JSON.stringify(container)}`, () => {
      const binding = externalBinding({
        profileId: "opensearch",
        engineVersion: "2.19.1",
        compatibilityPins: {
          "meridian-storage-core": "1.1.0",
          "meridian-storage-semantics": "2.1.0",
          "meridian-storage-query": "1.0.3",
          "meridian-storage-opensearch": "1.1.0",
        },
      });
      expect(() =>
        planDeployment(
          deploymentSpec({
            bindings: [
              {
                ...binding,
                connection: {
                  ...binding.connection,
                  settings: { limits: container },
                },
              },
            ],
          }),
        ),
      ).toThrow(/invalid container/);
    });
  }
});
