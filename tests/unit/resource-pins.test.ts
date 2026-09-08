// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  planDeployment,
  validateRuntimeConfig,
  resourceDefinitionFingerprint,
  getEngineProfile,
  type JsonObject,
  type SchemaRequirementV1,
} from "../../src/index.js";
import {
  catalogs,
  deploymentSpec,
  externalBinding,
  fingerprintA,
  fingerprintB,
  fingerprintC,
  ordersRequirement,
  schemaProviders,
} from "../fixtures.js";

describe("independent provider bundles and ResourceDefinition pins", () => {
  it("keeps legacy, explicit and matching-alias V1 bytes identical", () => {
    const legacy = planDeployment(deploymentSpec());
    const { fingerprint, ...coordinates } = ordersRequirement.schemas[0]!;
    for (const schema of [
      { ...coordinates, resourceFingerprint: fingerprintB },
      {
        ...coordinates,
        fingerprint: fingerprint!,
        resourceFingerprint: fingerprintB,
      },
    ]) {
      expect(
        planDeployment(
          deploymentSpec({
            resources: [{ ...ordersRequirement, schemas: [schema] }],
          }),
        ),
      ).toEqual(legacy);
    }
    expect(resourceDefinitionFingerprint(ordersRequirement.schemas[0]!)).toBe(
      fingerprintB,
    );
  });

  it.each([
    { fingerprint: undefined, resourceFingerprint: undefined },
    { fingerprint: fingerprintB, resourceFingerprint: fingerprintC },
    { fingerprint: "invalid" },
    { fingerprint: undefined, resourceFingerprint: "invalid" },
    { fingerprint: null, resourceFingerprint: fingerprintB },
    { fingerprint: fingerprintB, resourceFingerprint: null },
  ])(
    "rejects missing, malformed or conflicting ResourceDefinition pins: %j",
    (pins) => {
      const schema = {
        ...ordersRequirement.schemas[0],
        ...pins,
      } as SchemaRequirementV1;
      expect(() =>
        planDeployment(
          deploymentSpec({
            resources: [{ ...ordersRequirement, schemas: [schema] }],
          }),
        ),
      ).toThrow(/ResourceDefinition/);
    },
  );

  it.each([undefined, null, "", "sha256:invalid"])(
    "requires a separately valid bundle pin: %j",
    (pin) => {
      expect(() =>
        planDeployment(
          deploymentSpec({
            schemaProviders: [
              { ...schemaProviders[0]!, requiredFingerprint: pin! },
            ],
          }),
        ),
      ).toThrow(/schema provider fingerprint/);
    },
  );
  it("renders unequal bundle and resource fingerprints without substituting either", () => {
    const plan = planDeployment(
      deploymentSpec({
        schemaProviders: [
          { ...schemaProviders[0]!, requiredFingerprint: fingerprintA },
        ],
      }),
    );
    expect((plan.runtimeConfig.schemas as JsonObject).providers).toEqual([
      { ...schemaProviders[0]!, requiredFingerprint: fingerprintA },
    ]);
    expect((plan.runtimeConfig.resources as JsonObject).pins).toEqual([
      {
        ref: ordersRequirement.selector,
        providerId: "orders-schema",
        requiredFingerprint: fingerprintB,
      },
    ]);
  });

  it("pins distinct resources independently within one provider bundle", () => {
    const other = {
      ...ordersRequirement,
      selector: { ...ordersRequirement.selector, name: "other" },
      schemas: [
        { ...ordersRequirement.schemas[0]!, fingerprint: fingerprintC },
      ],
    };
    const spec = deploymentSpec({
      resources: [other, ordersRequirement],
      placements: [
        {
          id: "all-orders",
          selector: { resources: [], catalog: "structured", labels: {} },
          bindingId: "orders-db",
          extensions: {},
        },
      ],
    });
    const plan = planDeployment(spec);
    expect((plan.runtimeConfig.resources as JsonObject).pins).toEqual([
      {
        ref: other.selector,
        providerId: "orders-schema",
        requiredFingerprint: fingerprintC,
      },
      {
        ref: ordersRequirement.selector,
        providerId: "orders-schema",
        requiredFingerprint: fingerprintB,
      },
    ]);
    expect(
      planDeployment({ ...spec, resources: [...spec.resources].reverse() }),
    ).toEqual(plan);
  });
});

describe("selected Catalog subsets", () => {
  it.each([
    ["structured", "postgresql-postgis-local-single-primary"],
    ["evidence", "postgresql-postgis-local-single-primary"],
    ["cache", "valkey-standalone"],
    ["object", "s3-compatible"],
    ["streaming", "apache-kafka-test"],
  ] as const)(
    "accepts %s as the only installed and required Catalog",
    (name, profileId) => {
      const profile = getEngineProfile(profileId);
      const operation = Object.values(profile.operations).find((item) =>
        item.contract.startsWith(`meridian.${name}.`),
      )!;
      const resource = {
        ...ordersRequirement,
        selector: { ...ordersRequirement.selector, catalog: name },
        operations: [
          { contract: operation.contract, version: operation.versions[0]! },
        ],
      };
      const plan = planDeployment(
        deploymentSpec({
          catalogs: catalogs.filter((item) => item.name === name),
          resources: [resource],
          bindings: [
            externalBinding({
              profileId,
              engineVersion: profile.defaultEngineVersion,
              topology: profile.defaultTopology,
              compatibilityPins: profile.compatibilityPins,
            }),
          ],
          placements: [
            {
              id: "selected",
              selector: {
                resources: [resource.selector],
                catalog: null,
                labels: {},
              },
              bindingId: "orders-db",
              extensions: {},
            },
          ],
        }),
      );
      expect(
        (plan.runtimeConfig.catalogs as JsonObject).providers,
      ).toHaveLength(1);
    },
  );

  it.each([
    { names: ["structured"] },
    { names: ["structured", "evidence"] },
    { names: catalogs.map((c) => c.name) },
  ])(
    "accepts a supported set containing all required Catalogs: $names",
    ({ names }) => {
      const selected = catalogs.filter((c) => names.includes(c.name));
      expect(() =>
        planDeployment(deploymentSpec({ catalogs: selected })),
      ).not.toThrow();
    },
  );

  it("rejects duplicate, empty and unsupported Catalogs at input and generated-config boundaries", () => {
    for (const selected of [
      [],
      [catalogs[0]!, catalogs[0]!],
      [{ ...catalogs[0]!, name: "audit" as never }],
    ]) {
      expect(() =>
        planDeployment(deploymentSpec({ catalogs: selected })),
      ).toThrow();
      const runtime = structuredClone(
        planDeployment(deploymentSpec()).runtimeConfig,
      );
      (runtime.catalogs as Record<string, unknown>).providers = selected;
      expect(() => validateRuntimeConfig(runtime)).toThrow();
    }
  });

  it("rejects raw configuration with an unconfigured required Catalog", () => {
    const runtime = structuredClone(
      planDeployment(deploymentSpec()).runtimeConfig,
    );
    (runtime.catalogs as Record<string, unknown>).providers = [
      catalogs.find((c) => c.name === "evidence")!,
    ] as unknown;
    expect(() => validateRuntimeConfig(runtime)).toThrow(
      /unconfigured Catalog/,
    );
  });

  it("rejects a required Resource whose Catalog was not selected", () => {
    expect(() =>
      planDeployment(
        deploymentSpec({
          catalogs: catalogs.filter((c) => c.name === "evidence"),
        }),
      ),
    ).toThrow(/unconfigured Catalog/);
  });
});
