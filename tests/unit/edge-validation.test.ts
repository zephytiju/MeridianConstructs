// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  assertBoundedText,
  assertDigestPinnedImage,
  assertFingerprint,
  assertIdentifier,
  canonicalJson,
  catalogPlacementRules,
  collectorEnvironment,
  createLifecycleJobSpec,
  createOtelCollectorSpec,
  defaultClientPolicy,
  defaultValidationPolicy,
  diffPlans,
  normalizeJson,
  planDeployment,
  runtimeConfigContract,
  runtimeEnvironment,
  validateClientPolicy,
  validateEngineConnection,
  validatePlacementSelector,
  validateResourceRequirement,
  validateTelemetryCapability,
  validateTlsPolicy,
  validateValidationPolicy,
  type EngineConnectionV1,
  type MeridianResourceRequirementV1,
  type OtelCollectorInputV1,
  type PlacementRuleV1,
} from "../../src/index.js";
import {
  catalogs,
  deploymentSpec,
  digestImage,
  externalBinding,
  fingerprintA,
  fingerprintC,
  ordersRequirement,
  placement,
  schemaProviders,
} from "../fixtures.js";

const disabledTls = {
  mode: "disabled",
  serverName: null,
  caRef: null,
  clientCertificateRef: null,
} as const;

const validConnection: EngineConnectionV1 = {
  ...externalBinding().connection,
  tls: disabledTls,
  endpoint: null,
  serviceRef: "orders-postgresql.default.svc",
};

const collectorConfig = {
  receivers: { otlp: { protocols: { grpc: {} } } },
  processors: { batch: {} },
  exporters: { otlp: { endpoint: "https://telemetry.example:4317" } },
  service: {
    pipelines: { traces: { receivers: ["otlp"], exporters: ["otlp"] } },
  },
} as const;

function collectorInput(
  overrides: Partial<OtelCollectorInputV1> = {},
): OtelCollectorInputV1 {
  return {
    mode: "gateway",
    image: digestImage,
    config: collectorConfig,
    protocol: "grpc",
    signals: ["traces"],
    tls: disabledTls,
    batchingSamplingFingerprint: fingerprintA,
    backendReadPlacement: {
      catalog: "evidence",
      namespace: "telemetry",
      name: "signals",
    },
    ...overrides,
  };
}

describe("canonical and primitive validation edges", () => {
  it("canonicalizes sorted JSON and rejects non-JSON values", () => {
    expect(canonicalJson({ z: [true, null], a: 1 })).toBe(
      '{"a":1,"z":[true,null]}',
    );
    expect(() => normalizeJson(Number.NaN)).toThrow(/finite JSON numbers/);
    expect(() => normalizeJson(() => undefined)).toThrow(/JSON-compatible/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => normalizeJson(cyclic)).toThrow(/JSON cycle/);
    expect(() => normalizeJson(new Date())).toThrow(/plain JSON objects/);
    expect(() => normalizeJson("\ud800")).toThrow(/unpaired surrogate/);
    expect(() => normalizeJson({ [Symbol("not-json")]: true })).toThrow(
      /string object keys/,
    );
  });

  it("validates bounded identifiers, fingerprints, and image digests", () => {
    expect(() =>
      assertIdentifier("orders-primary", "identifier"),
    ).not.toThrow();
    expect(() => assertIdentifier("1orders", "identifier")).toThrow(
      /valid identifier/,
    );
    expect(() => assertBoundedText("line\nfeed", "text")).toThrow(/bounded/);
    expect(() => assertBoundedText("éé", "text", 3)).toThrow(/bounded/);
    expect(() => assertFingerprint("sha256:not-hex", "fingerprint")).toThrow(
      /sha256 fingerprint/,
    );
    expect(() => assertDigestPinnedImage("example/image:latest")).toThrow(
      /pinned by sha256 digest/,
    );
  });
});

describe("contract validation edges", () => {
  it("enforces every TLS mode and opaque endpoint shape", () => {
    expect(() => validateTlsPolicy(disabledTls)).not.toThrow();
    expect(() =>
      validateTlsPolicy({
        mode: "server",
        serverName: "db.example",
        caRef: { provider: "secrets", reference: "db/ca" },
        clientCertificateRef: { provider: "secrets", reference: "db/client" },
      }),
    ).toThrow(/cannot carry a client certificate/);
    expect(() =>
      validateTlsPolicy({
        mode: "mutual",
        serverName: "db.example",
        caRef: { provider: "secrets", reference: "db/ca" },
        clientCertificateRef: null,
      }),
    ).toThrow(/requires a client certificate/);
    expect(() =>
      validateTlsPolicy({
        mode: "mutual",
        serverName: "db.example",
        caRef: { provider: "secrets", reference: "db/ca" },
        clientCertificateRef: { provider: "secrets", reference: "db/client" },
      }),
    ).not.toThrow();

    expect(() => validateEngineConnection(validConnection)).not.toThrow();
    expect(() =>
      validateEngineConnection({
        ...validConnection,
        endpoint: null,
        serviceRef: null,
      }),
    ).toThrow(/exactly one endpoint/);
    expect(() =>
      validateEngineConnection({
        ...validConnection,
        endpoint: "postgresql://db.example/orders",
      }),
    ).toThrow(/exactly one endpoint/);
    expect(() =>
      validateEngineConnection({
        ...validConnection,
        endpoint: "not-an-uri",
        serviceRef: null,
      }),
    ).toThrow(/absolute URI/);
    expect(() =>
      validateEngineConnection({
        ...validConnection,
        endpoint: "postgresql://db.example/orders#fragment",
        serviceRef: null,
      }),
    ).toThrow(/credentials, a query, or a fragment/);
  });

  it("bounds client, placement, validation, and telemetry policies", () => {
    expect(() => validateClientPolicy(defaultClientPolicy)).not.toThrow();
    expect(() =>
      validateClientPolicy({ ...defaultClientPolicy, acquireTimeoutMs: 0 }),
    ).toThrow(/out of range/);
    expect(() =>
      validateClientPolicy({ ...defaultClientPolicy, minSize: 5, maxSize: 4 }),
    ).toThrow(/cannot exceed/);
    expect(() =>
      validatePlacementSelector({ resources: [], catalog: null, labels: {} }),
    ).toThrow(/cannot be empty/);
    expect(() =>
      validatePlacementSelector({
        resources: [ordersRequirement.selector, ordersRequirement.selector],
        catalog: null,
        labels: {},
      }),
    ).toThrow(/must be unique/);
    expect(() =>
      validatePlacementSelector({
        resources: [],
        catalog: "audit" as never,
        labels: {},
      }),
    ).toThrow(/unregistered Catalog/);

    expect(() =>
      validateValidationPolicy({
        ...defaultValidationPolicy,
        strict: false as never,
      }),
    ).toThrow(/must be strict/);
    expect(() =>
      validateValidationPolicy({
        ...defaultValidationPolicy,
        defaultOperationTimeoutMs: 0,
      }),
    ).toThrow(/operation timeout/);
    expect(() =>
      validateValidationPolicy({
        ...defaultValidationPolicy,
        idempotencyCacheEntries: 0,
      }),
    ).toThrow(/cache size/);
    expect(() =>
      validateValidationPolicy({
        ...defaultValidationPolicy,
        retry: { ...defaultValidationPolicy.retry, maxAttempts: 0 },
      }),
    ).toThrow(/Retry policy/);
    expect(() =>
      validateTelemetryCapability({
        enabled: true,
        serviceName: null,
        suppressExporterRecursion: true,
        attributes: {},
        extensions: {},
      }),
    ).toThrow(/service name/);
    expect(() =>
      validateTelemetryCapability({
        enabled: false,
        serviceName: null,
        suppressExporterRecursion: false as never,
        attributes: {},
        extensions: {},
      }),
    ).toThrow(/recursion suppression/);
  });

  it("rejects empty, duplicate, negative, and malformed Resource requirements", () => {
    expect(() =>
      validateResourceRequirement({ ...ordersRequirement, schemas: [] }),
    ).toThrow(/must be non-empty/);
    expect(() =>
      validateResourceRequirement({
        ...ordersRequirement,
        schemas: [ordersRequirement.schemas[0]!, ordersRequirement.schemas[0]!],
      }),
    ).toThrow(/schema providers must be unique/);
    expect(() =>
      validateResourceRequirement({
        ...ordersRequirement,
        operations: [
          {
            ...ordersRequirement.operations[0]!,
            guarantees: ["ordered", "ordered"],
          },
        ],
      }),
    ).toThrow(/operation guarantees must be unique/);
    expect(() =>
      validateResourceRequirement({
        ...ordersRequirement,
        limits: { values: { maxPageSize: -1 } },
      }),
    ).toThrow(/non-negative integer/);
    expect(() =>
      validateResourceRequirement({
        ...ordersRequirement,
        retentionReplay: { retentionSeconds: 1.5 },
      }),
    ).toThrow(/non-negative integer/);
  });
});

describe("deployment planner failure closure", () => {
  it("validates duplicate identifiers and schema references", () => {
    expect(() =>
      planDeployment(deploymentSpec({ catalogs: [...catalogs, catalogs[0]!] })),
    ).toThrow(/Duplicate deployment identifier/);
    expect(() =>
      planDeployment(
        deploymentSpec({
          schemaProviders: [...schemaProviders, schemaProviders[0]!],
        }),
      ),
    ).toThrow(/Duplicate deployment identifier/);
    expect(() =>
      planDeployment(
        deploymentSpec({ resources: [ordersRequirement, ordersRequirement] }),
      ),
    ).toThrow(/DUPLICATE_RESOURCE/);
    expect(() =>
      planDeployment(
        deploymentSpec({
          bindings: [
            externalBinding(),
            { ...externalBinding(), profileId: "opensearch" },
          ],
        }),
      ),
    ).toThrow(/DUPLICATE_BINDING/);
    expect(() =>
      planDeployment(deploymentSpec({ placements: [placement, placement] })),
    ).toThrow(/DUPLICATE_PLACEMENT/);

    expect(() =>
      planDeployment(
        deploymentSpec({
          resources: [
            {
              ...ordersRequirement,
              schemas: [
                {
                  ...ordersRequirement.schemas[0]!,
                  providerId: "missing-schema",
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/unknown schema provider/);
    expect(() =>
      planDeployment(
        deploymentSpec({
          resources: [
            {
              ...ordersRequirement,
              schemas: [
                { ...ordersRequirement.schemas[0]!, fingerprint: fingerprintC },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/differs from its provider/);
  });

  it("validates placement and live-schema references", () => {
    expect(() =>
      planDeployment(
        deploymentSpec({
          placements: [{ ...placement, bindingId: "missing-binding" }],
        }),
      ),
    ).toThrow(/unknown binding/);
    expect(() =>
      planDeployment(
        deploymentSpec({
          liveSchemas: { enabled: false, required: true, providerId: null },
        }),
      ),
    ).toThrow(/must be enabled/);
    expect(() =>
      planDeployment(
        deploymentSpec({
          liveSchemas: { enabled: true, required: false, providerId: null },
        }),
      ),
    ).toThrow(/must be set exactly/);
    expect(() =>
      planDeployment(
        deploymentSpec({
          liveSchemas: {
            enabled: true,
            required: true,
            providerId: "missing-schema",
          },
        }),
      ),
    ).toThrow(/unknown provider/);
  });

  it("fails on profile Catalog mismatch and invalid binding metadata", () => {
    const objectRequirement: MeridianResourceRequirementV1 = {
      ...ordersRequirement,
      selector: { catalog: "object", namespace: "orders", name: "records" },
    };
    const objectPlacement: PlacementRuleV1 = {
      ...placement,
      selector: {
        resources: [objectRequirement.selector],
        catalog: null,
        labels: {},
      },
    };
    expect(() =>
      planDeployment(
        deploymentSpec({
          resources: [objectRequirement],
          placements: [objectPlacement],
        }),
      ),
    ).toThrow(/does not serve object/);
    expect(() =>
      planDeployment(
        deploymentSpec({
          bindings: [externalBinding({ mode: "test" as never })],
        }),
      ),
    ).toThrow(/unsupported mode/);
    expect(() =>
      planDeployment(
        deploymentSpec({
          bindings: [externalBinding({ topology: "test" })],
        }),
      ),
    ).toThrow(/unsupported topology/);
    expect(() =>
      planDeployment(
        deploymentSpec({
          bindings: [
            externalBinding({
              observability: {
                enabled: true,
                labels: {},
                collectorCapabilityFingerprint: "invalid",
              },
            }),
          ],
        }),
      ),
    ).toThrow(/Collector capability fingerprint/);
    expect(() =>
      planDeployment(
        deploymentSpec({
          bindings: [
            externalBinding({
              recovery: {
                ...externalBinding().recovery!,
                validationFingerprint: "invalid",
              },
            }),
          ],
        }),
      ),
    ).toThrow(/recovery validation fingerprint/);
  });

  it("handles multiple schemas, placement labels, plan membership diffs, and clones", () => {
    const secondSchema = {
      id: "orders-schema-secondary",
      package: "example-orders-schema-secondary",
      contract: "1.0.0",
      requiredFingerprint: fingerprintC,
    } as const;
    const multiSchemaRequirement: MeridianResourceRequirementV1 = {
      ...ordersRequirement,
      schemas: [
        ...ordersRequirement.schemas,
        {
          providerId: secondSchema.id,
          package: secondSchema.package,
          version: "1.0.0",
          fingerprint: fingerprintC,
        },
      ],
    };
    const plan = planDeployment(
      deploymentSpec({
        schemaProviders: [...schemaProviders, secondSchema],
        resources: [multiSchemaRequirement],
        placements: [
          {
            ...placement,
            selector: {
              resources: [],
              catalog: "structured",
              labels: { authority: "application" },
            },
          },
        ],
      }),
    );
    expect(
      plan.resourceBindings["structured:orders.records"]!.schemaFingerprint,
    ).toMatch(/^sha256:/);

    const emptyPlan = {
      ...plan,
      resourceBindings: {},
      fingerprint: fingerprintA,
    };
    expect(diffPlans(emptyPlan, plan).addedResources).toEqual([
      "structured:orders.records",
    ]);
    expect(diffPlans(plan, emptyPlan).removedResources).toEqual([
      "structured:orders.records",
    ]);
    expect(runtimeEnvironment("/etc/meridian/config.json")).toEqual({
      MERIDIAN_CONFIG: "/etc/meridian/config.json",
    });
    const contract = runtimeConfigContract() as Record<string, unknown>;
    contract.title = "mutated clone";
    expect(runtimeConfigContract()).not.toHaveProperty(
      "title",
      "mutated clone",
    );

    expect(() =>
      catalogPlacementRules({ structured: undefined } as never),
    ).toThrow(/no binding identifier/);
  });
});

describe("lifecycle and Collector edge validation", () => {
  it("rejects incomplete and out-of-range lifecycle specs", () => {
    const base = {
      kind: "migration" as const,
      image: digestImage,
      resources: [ordersRequirement.selector],
      operation: { contract: "meridian.migration.apply" },
    };
    expect(() => createLifecycleJobSpec({ ...base, resources: [] })).toThrow(
      /resources must be non-empty/,
    );
    expect(() => createLifecycleJobSpec({ ...base, operation: {} })).toThrow(
      /operation cannot be empty/,
    );
    expect(() =>
      createLifecycleJobSpec({ ...base, dependsOn: ["prepare", "prepare"] }),
    ).toThrow(/dependencies must be unique/);
    expect(() =>
      createLifecycleJobSpec({ ...base, dependsOn: ["bad dependency"] }),
    ).toThrow(/valid identifier/);
    expect(() =>
      createLifecycleJobSpec({ ...base, timeoutSeconds: 0 }),
    ).toThrow(/timeout is out of range/);
    expect(() => createLifecycleJobSpec({ ...base, maxAttempts: 21 })).toThrow(
      /max attempts is out of range/,
    );
    expect(() =>
      createLifecycleJobSpec({
        ...base,
        secretRefs: [{ provider: "bad provider", reference: "orders" }],
      }),
    ).toThrow(/valid identifier/);
    expect(() =>
      createLifecycleJobSpec({ ...base, operation: [] as never }),
    ).toThrow(/must be an object/);
  });

  it("validates gateway counts, ports, signals, config, and opaque credentials", () => {
    expect(
      createOtelCollectorSpec(collectorInput({ replicas: 3 })).replicas,
    ).toBe(3);
    expect(() =>
      createOtelCollectorSpec(collectorInput({ replicas: 0 })),
    ).toThrow(/replicas are out of range/);
    expect(() =>
      createOtelCollectorSpec(collectorInput({ grpcPort: 65_536 })),
    ).toThrow(/grpc port is invalid/);
    expect(() =>
      createOtelCollectorSpec(collectorInput({ signals: [] })),
    ).toThrow(/signals must be non-empty/);
    expect(() =>
      createOtelCollectorSpec(
        collectorInput({ signals: ["traces", "traces"] }),
      ),
    ).toThrow(/signals must be non-empty and unique/);
    expect(() =>
      createOtelCollectorSpec(
        collectorInput({ batchingSamplingFingerprint: "invalid" }),
      ),
    ).toThrow(/sha256 fingerprint/);
    expect(() =>
      createOtelCollectorSpec(
        collectorInput({
          config: { ...collectorConfig, access_token: "secret" },
        }),
      ),
    ).toThrow(/inline secret material/);
    expect(() =>
      createOtelCollectorSpec(
        collectorInput({
          config: {
            receivers: {},
            processors: {},
            exporters: {},
            service: { pipelines: {} },
          },
        }),
      ),
    ).toThrow(/OTLP receiver/);
    expect(() =>
      createOtelCollectorSpec(
        collectorInput({
          config: {
            receivers: { otlp: {} },
            processors: {},
            exporters: {},
            service: {},
          },
        }),
      ),
    ).toThrow(/service pipelines/);
    expect(() =>
      createOtelCollectorSpec(
        collectorInput({
          credentialRefs: [{ provider: "bad provider", reference: "otel" }],
        }),
      ),
    ).toThrow(/valid identifier/);
    expect(() => collectorEnvironment("", "grpc")).toThrow(/bounded/);
  });
});
