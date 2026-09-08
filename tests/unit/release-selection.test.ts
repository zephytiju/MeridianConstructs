// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  compatibilityContract,
  diffPlans,
  engineProfiles,
  fingerprint,
  planDeployment,
  validateEngineVersion,
  validatePackagePins,
  validateRuntimeConfig,
  type JsonObject,
} from "../../src/index.js";
import {
  deploymentSpec,
  externalBinding,
  ordersRequirement,
} from "../fixtures.js";

describe("deployment-owned release selection (metadata, not Engine support evidence)", () => {
  for (const profile of Object.values(engineProfiles)) {
    for (const mode of profile.allowedModes) {
      for (const topology of profile.allowedTopologies) {
        it(`${profile.id}/${mode}/${topology} varies package and Engine selections independently`, () => {
          const selector = {
            ...ordersRequirement.selector,
            catalog: profile.catalogs[0]!,
          };
          const operation = Object.values(profile.operations)[0]!;
          const packages = Object.fromEntries(
            Object.keys(profile.compatibilityPins).map((name) => [
              name,
              "99.12.4",
            ]),
          );
          const legacyProtocol = ["s3", "oci-distribution"].includes(
            profile.adapterId,
          );
          const binding = externalBinding({
            profileId: profile.id,
            mode,
            topology,
            engineVersion: legacyProtocol
              ? profile.defaultEngineVersion
              : "99.12.4",
            compatibilityPins: packages,
          });
          const spec = deploymentSpec({
            bindings: [binding],
            resources: [
              {
                ...ordersRequirement,
                selector,
                operations: [
                  {
                    contract: operation.contract,
                    version: operation.versions[0]!,
                    guarantees: [],
                    limits: {},
                  },
                ],
              },
            ],
            placements: [
              {
                id: "selected",
                selector: { resources: [selector], catalog: null, labels: {} },
                bindingId: binding.id,
                extensions: {},
              },
            ],
          });
          const first = planDeployment(spec);
          const selected = (first.runtimeConfig.bindings as JsonObject[])[0]!;
          expect(
            (selected.extensions as JsonObject)[
              "org.meridian.constructs/package-lock.v1"
            ],
          ).toEqual({
            formatVersion: "meridian-deployment-package-lock.v1",
            packages,
          });
          expect(selected.compatibilityPins).toEqual({});
          expect(selected.engineVersion).toBe(binding.engineVersion);
          validateRuntimeConfig(first.runtimeConfig);
          expect(planDeployment(spec)).toEqual(first);
          const changed = planDeployment({
            ...spec,
            bindings: [
              {
                ...binding,
                compatibilityPins: {
                  ...packages,
                  [profile.adapterPackage]: "99.12.5",
                },
              },
            ],
          });
          expect(diffPlans(first, changed).configChanged).toBe(true);
          expect(
            (changed.runtimeConfig.bindings as JsonObject[])[0]!.engineVersion,
          ).toBe(binding.engineVersion);
          if (!legacyProtocol) {
            const engineChanged = planDeployment({
              ...spec,
              bindings: [{ ...binding, engineVersion: "100.0.0" }],
            });
            expect(engineChanged.fingerprint).not.toBe(first.fingerprint);
            expect(
              (
                (engineChanged.runtimeConfig.bindings as JsonObject[])[0]!
                  .extensions as JsonObject
              )["org.meridian.constructs/package-lock.v1"],
            ).toEqual({
              formatVersion: "meridian-deployment-package-lock.v1",
              packages,
            });
          }
        });
      }
    }
  }

  it("keeps all exported profiles and explicitly versions generated metadata", () => {
    expect(Object.keys(engineProfiles).sort()).toEqual([
      "apache-kafka",
      "apache-kafka-test",
      "aws-s3",
      "clickhouse-replicated",
      "clickhouse-standalone",
      "oci-distribution",
      "opensearch",
      "postgresql-postgis-cluster",
      "postgresql-postgis-local-single-primary",
      "s3-compatible",
      "valkey-sentinel",
      "valkey-standalone",
    ]);
    expect(compatibilityContract().formatVersion).toBe(
      "meridian-storage-constructs-compatibility.v2",
    );
    expect(
      compatibilityContract().profiles["aws-s3"]?.engineVersionMeaning,
    ).toBe("protocol");
    expect(
      compatibilityContract().profiles.opensearch?.testedEngineVersions,
    ).toBeDefined();
    expect(compatibilityContract()).not.toHaveProperty("packages");
  });

  it("separates runtime contract expectations from distribution locks and prevents extension overrides", () => {
    const binding = externalBinding({
      runtimeCompatibilityPins: {
        coreVersion: "1.0.0",
        driver: "psycopg-3.3.5",
      },
    });
    const plan = planDeployment(deploymentSpec({ bindings: [binding] }));
    expect(
      (plan.runtimeConfig.bindings as JsonObject[])[0]!.compatibilityPins,
    ).toEqual(binding.runtimeCompatibilityPins);
    expect(() =>
      planDeployment(
        deploymentSpec({
          bindings: [{ ...binding, runtimeCompatibilityPins: { driver: "" } }],
        }),
      ),
    ).toThrow();
    expect(() =>
      planDeployment(
        deploymentSpec({
          bindings: [
            {
              ...binding,
              connection: {
                ...binding.connection,
                extensions: { "org.meridian.constructs/package-lock.v1": {} },
              },
            },
          ],
        }),
      ),
    ).toThrow(/cannot override/);
  });
  it.each(["aws-s3", "s3-compatible", "oci-distribution"])(
    "retains the actual %s protocol constraint",
    (id) => {
      expect(() =>
        validateEngineVersion(engineProfiles[id]!, "99.12.4"),
      ).toThrow(/requires protocol/);
    },
  );

  it.each([
    "",
    "latest",
    ">=1.0",
    "1.*",
    "1.0\n",
    "https://example.org/package",
    "1.0;bad",
  ])("rejects malformed or mutable package coordinate %j", (selected) => {
    expect(() => validatePackagePins({ example: selected })).toThrow();
  });
  it("retains missing coordinates and duplicate normalized distribution failures", () => {
    expect(() => validatePackagePins({}, ["meridian-storage-core"])).toThrow(
      /Missing/,
    );
    expect(() =>
      validatePackagePins({ "example-name": "1", Example_Name: "2" }),
    ).toThrow(/duplicate/);
    expect(() => validatePackagePins({ "bad name": "1" })).toThrow(/Malformed/);
    expect(() => validatePackagePins(null as never)).toThrow();
    expect(() =>
      validatePackagePins({ example: "1!2.3rc1.post2.dev3+local.1" }),
    ).not.toThrow();
  });
});

describe("Core 1.1.0 public-wheel golden contracts", () => {
  const fixtures = JSON.parse(
    readFileSync(
      new URL(
        "../fixtures/core-1.1.0/release-provenance.v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    manifests: {
      name: string;
      document: JsonObject;
      fingerprint: string;
      descriptorFingerprint: string;
    }[];
    runtimeConfig: JsonObject;
    runtimeConfigFingerprint: string;
  };
  it("matches the byte-preserved public wheel fixture content hash", () => {
    const provenance = JSON.parse(
      readFileSync(
        new URL("../fixtures/core-1.1.0/artifact.json", import.meta.url),
        "utf8",
      ),
    ) as { fixtureSha256: string };
    const bytes = readFileSync(
      new URL(
        "../fixtures/core-1.1.0/release-provenance.v1.json",
        import.meta.url,
      ),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      provenance.fixtureSha256,
    );
  });
  for (const item of fixtures.manifests) {
    it(`preserves the canonical ${item.name} manifest and descriptor`, () => {
      expect(fingerprint(item.document)).toBe(item.fingerprint);
      expect(fingerprint(item.document.descriptor)).toBe(
        item.descriptorFingerprint,
      );
      expect(fingerprint(JSON.parse(canonicalJson(item.document)))).toBe(
        item.fingerprint,
      );
    });
  }
  it("preserves the released closed config as a deterministic renderer document", () => {
    validateRuntimeConfig(fixtures.runtimeConfig);
    // Core hashes RuntimeConfig.to_dict(), where retry.jitterRatio is a Python float.
    // The existing renderer hashes its JSON document (0 instead of 0.0). These are
    // distinct documents: do not silently change the persisted V1 renderer hash.
    expect(fingerprint(fixtures.runtimeConfig)).toBe(
      "sha256:4d65a7dd2a0081b176b9de20a842fbf0b5a7cdea52aef040474a89b77d205c3a",
    );
    expect(fingerprint(JSON.parse(canonicalJson(fixtures.runtimeConfig)))).toBe(
      fingerprint(fixtures.runtimeConfig),
    );
  });
});
