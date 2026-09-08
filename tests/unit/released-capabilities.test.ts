// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  engineProfiles,
  fingerprint,
  planDeployment,
  type JsonObject,
  type DeploymentSpecV1,
} from "../../src/index.js";
import {
  deploymentSpec,
  externalBinding,
  ordersRequirement,
} from "../fixtures.js";

interface ReleasedManifest {
  engineProfile: string;
  engineVersion: string;
  descriptor: {
    adapterId: string;
    adapterContractVersion: string;
    supportedEngineVersions: Record<string, string[]>;
    capabilities: {
      operationContract: string;
      operationVersions: string[];
      guarantees: string[];
      limits: Record<string, number>;
    }[];
  };
  availableOperationContracts: string[];
}
const inventory = JSON.parse(
  readFileSync("tests/fixtures/released-capabilities/inventory.json", "utf8"),
) as {
  profiles: Record<string, { manifest: ReleasedManifest; fingerprint: string }>;
};
const asJson = (manifest: ReleasedManifest) =>
  manifest as unknown as JsonObject;

function specFor(manifest: ReleasedManifest): DeploymentSpecV1 {
  const profile = engineProfiles[manifest.engineProfile]!;
  const selector = {
    ...ordersRequirement.selector,
    catalog: profile.catalogs[0]!,
  };
  return deploymentSpec({
    resources: [
      {
        ...ordersRequirement,
        selector,
        operations: [
          {
            contract: manifest.availableOperationContracts[0]!,
            version: "1.0.0",
          },
        ],
      },
    ],
    bindings: [
      externalBinding({
        profileId: profile.id,
        topology: profile.defaultTopology,
        engineVersion: manifest.engineVersion,
        compatibilityPins: profile.compatibilityPins,
        requiredCapabilityFingerprint: fingerprint(manifest),
        capabilityManifest: asJson(manifest),
      }),
    ],
    placements: [
      {
        id: "selected",
        bindingId: "orders-db",
        extensions: {},
        selector: { resources: [selector], catalog: null, labels: {} },
      },
    ],
  });
}

describe("selected public Operation contracts", () => {
  it("rejects inline secrets in manifest extensions before exposing a Binding", () => {
    const manifest =
      inventory.profiles["postgresql-postgis-local-single-primary"]!.manifest;
    const base = specFor(manifest);
    const privateInput = {
      ...asJson(manifest),
      extensions: { password: "fixture-only" },
    };
    expect(() =>
      planDeployment({
        ...base,
        bindings: [
          {
            ...base.bindings[0]!,
            capabilityManifest: privateInput,
            requiredCapabilityFingerprint: fingerprint(privateInput),
          },
        ],
      }),
    ).toThrow(/inline secret/);
  });
  it("inventories every exported family and profile against released descriptors", () => {
    expect(Object.keys(inventory.profiles).sort()).toEqual(
      Object.keys(engineProfiles).sort(),
    );
    for (const [id, selected] of Object.entries(inventory.profiles)) {
      expect(fingerprint(selected.manifest)).toBe(selected.fingerprint);
      const profile = engineProfiles[id]!;
      expect(Object.keys(profile.operations).sort()).toEqual(
        selected.manifest.descriptor.capabilities
          .map((c) => c.operationContract)
          .sort(),
      );
      for (const cap of selected.manifest.descriptor.capabilities) {
        expect(profile.operations[cap.operationContract]).toMatchObject({
          contract: cap.operationContract,
          versions: cap.operationVersions,
          guarantees: cap.guarantees,
          limits: cap.limits,
        });
      }
    }
  });

  for (const [id, selected] of Object.entries(inventory.profiles)) {
    for (const mode of engineProfiles[id]!.allowedModes) {
      it(`${id}/${mode} compares every selected available contract and keeps negative gates`, () => {
        const manifest = selected.manifest;
        const base = specFor(manifest);
        for (const cap of manifest.descriptor.capabilities) {
          for (const version of cap.operationVersions) {
            const spec = {
              ...base,
              bindings: [{ ...base.bindings[0]!, mode }],
              resources: [
                {
                  ...base.resources[0]!,
                  operations: [
                    {
                      contract: cap.operationContract,
                      version,
                      guarantees: cap.guarantees,
                      limits: cap.limits,
                    },
                  ],
                },
              ],
            };
            if (
              !manifest.availableOperationContracts.includes(
                cap.operationContract,
              )
            ) {
              expect(() => planDeployment(spec)).toThrow(/does not provide/);
              continue;
            }
            const plan = planDeployment(spec);
            expect(planDeployment(spec)).toEqual(plan);
            expect(canonicalJson(plan.runtimeConfig)).not.toContain(
              '"capabilityManifest"',
            );
            for (const bad of [
              { version: "99.0.0" },
              { guarantees: ["not-advertised"] },
              { limits: { notAdvertised: 1 } },
            ]) {
              expect(() =>
                planDeployment({
                  ...spec,
                  resources: [
                    {
                      ...spec.resources[0]!,
                      operations: [
                        { ...spec.resources[0]!.operations[0]!, ...bad },
                      ],
                    },
                  ],
                }),
              ).toThrow();
            }
          }
        }
      });
    }
  }

  for (const id of [
    "postgresql-postgis-local-single-primary",
    "postgresql-postgis-cluster",
  ]) {
    for (const mode of engineProfiles[id]!.allowedModes) {
      it(`${id}/${mode} fixes the original four public reproduction cases without new input`, () => {
        const base = specFor(inventory.profiles[id]!.manifest);
        for (const [contract, version, guarantees, accepted] of [
          ["meridian.structured.get", "1.0.0", [], true],
          ["meridian.structured.put", "2.0.0", [], true],
          ["meridian.evidence.append", "1.0.0", ["atomic-evidence"], true],
          ["meridian.structured.put", "99.0.0", [], false],
          ["meridian.structured.put", "1.0.0", [], false],
        ] as const) {
          const { capabilityManifest: _manifest, ...binding } =
            base.bindings[0]!;
          void _manifest;
          const spec = {
            ...base,
            bindings: [{ ...binding, mode }],
            resources: [
              {
                ...base.resources[0]!,
                operations: [{ contract, version, guarantees }],
              },
            ],
          };
          if (accepted) expect(() => planDeployment(spec)).not.toThrow();
          else expect(() => planDeployment(spec)).toThrow(/does not provide/);
        }
      });
    }
  }

  it("honors a selected manifest's reduced availability and limits without merging default capabilities", () => {
    const manifest = structuredClone(
      inventory.profiles["postgresql-postgis-local-single-primary"]!.manifest,
    );
    const get = manifest.descriptor.capabilities.find(
      (c) => c.operationContract === "meridian.structured.get",
    )!;
    manifest.availableOperationContracts = [get.operationContract];
    get.limits.maxPageSize = 2;
    get.guarantees = [];
    const spec = specFor(manifest);
    expect(() => planDeployment(spec)).not.toThrow();
    for (const op of [
      { contract: "meridian.structured.put", version: "2.0.0" },
      {
        contract: get.operationContract,
        version: "1.0.0",
        limits: { maxPageSize: 3 },
      },
      {
        contract: get.operationContract,
        version: "1.0.0",
        guarantees: ["bound-parameters"],
      },
    ])
      expect(() =>
        planDeployment({
          ...spec,
          resources: [{ ...spec.resources[0]!, operations: [op] }],
        }),
      ).toThrow();
  });

  for (const kind of [
    "fingerprint",
    "engine",
    "profile",
    "adapter",
    "spi",
    "profile-key",
    "duplicate",
    "unadvertised",
    "malformed",
    "non-json",
  ]) {
    it(`rejects ${kind} manifest errors before planning`, () => {
      const manifest = structuredClone(
        inventory.profiles["postgresql-postgis-local-single-primary"]!.manifest,
      );
      const base = specFor(manifest);
      if (kind === "engine") manifest.engineVersion = "999.0.0";
      if (kind === "profile")
        manifest.engineProfile = "postgresql-postgis-cluster";
      if (kind === "adapter") manifest.descriptor.adapterId = "s3";
      if (kind === "spi") manifest.descriptor.adapterContractVersion = "99.0.0";
      if (kind === "profile-key")
        manifest.descriptor.supportedEngineVersions = { other: ["1.0.0"] };
      if (kind === "duplicate")
        manifest.descriptor.capabilities.push(
          manifest.descriptor.capabilities[0]!,
        );
      if (kind === "unadvertised")
        manifest.availableOperationContracts.push("meridian.missing");
      if (kind === "malformed")
        manifest.descriptor.capabilities[0]!.operationVersions = [];
      if (kind === "non-json")
        manifest.descriptor.capabilities[0]!.limits.bad = Infinity;
      const pin =
        kind === "fingerprint" || kind === "non-json"
          ? "sha256:" + "0".repeat(64)
          : fingerprint(manifest);
      expect(() =>
        planDeployment({
          ...base,
          bindings: [
            {
              ...base.bindings[0]!,
              capabilityManifest: asJson(manifest),
              requiredCapabilityFingerprint: pin,
            },
          ],
        }),
      ).toThrow();
    });
  }
});
