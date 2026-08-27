// SPDX-License-Identifier: Apache-2.0

import {
  defaultClientPolicy,
  defaultValidationPolicy,
  disabledTelemetryCapability,
  getEngineProfile,
  type BindingSpecV1,
  type CatalogProviderV1,
  type DeploymentSpecV1,
  type MeridianResourceRequirementV1,
  type PlacementRuleV1,
  type SchemaProviderV1,
} from "../src/index.js";

export const fingerprintA = `sha256:${"a".repeat(64)}`;
export const fingerprintB = `sha256:${"b".repeat(64)}`;
export const fingerprintC = `sha256:${"c".repeat(64)}`;
export const digestImage = `ghcr.io/zephytiju/meridian-job@sha256:${"d".repeat(64)}`;

export const catalogs: readonly CatalogProviderV1[] = [
  "structured",
  "object",
  "cache",
  "evidence",
  "streaming",
].map((name) => ({
  name: name as CatalogProviderV1["name"],
  package: `meridian-storage-${name}`,
  contract: "1.0.0",
  requiredFingerprint: fingerprintA,
}));

export const schemaProviders: readonly SchemaProviderV1[] = [
  {
    id: "orders-schema",
    package: "example-orders-schema",
    contract: "1.0.0",
    requiredFingerprint: fingerprintB,
  },
];

export const ordersRequirement: MeridianResourceRequirementV1 = {
  selector: { catalog: "structured", namespace: "orders", name: "records" },
  schemas: [
    {
      providerId: "orders-schema",
      package: "example-orders-schema",
      version: "1.0.0",
      fingerprint: fingerprintB,
    },
  ],
  operations: [
    {
      contract: "meridian.structured.get",
      version: "1.0.0",
      guarantees: ["bound-parameters", "scope-injected"],
      limits: { maxPageSize: 100 },
    },
  ],
  guarantees: { required: [] },
  limits: { values: {} },
  dataClass: "internal-operational",
  labels: { authority: "application" },
};

export const placement: PlacementRuleV1 = {
  id: "orders-primary",
  selector: {
    resources: [ordersRequirement.selector],
    catalog: null,
    labels: {},
  },
  bindingId: "orders-db",
  extensions: { selection: "one-primary" },
};

export function externalBinding(
  overrides: Partial<BindingSpecV1> = {},
): BindingSpecV1 {
  const profile = getEngineProfile("postgresql-postgis-local-single-primary");
  return {
    id: "orders-db",
    profileId: profile.id,
    requiredCapabilityFingerprint: fingerprintA,
    connection: {
      physicalNamespace: "orders",
      identityRef: {
        provider: "workload-identity",
        reference: "orders-runtime",
      },
      secretRef: { provider: "secret-manager", reference: "orders/database" },
      tls: {
        mode: "server",
        serverName: "postgres.example",
        caRef: { provider: "secret-manager", reference: "orders/postgres-ca" },
        clientCertificateRef: null,
      },
      endpoint: "postgresql://postgres.example:5432/orders",
      serviceRef: null,
      requiredPhysicalFingerprint: fingerprintC,
      settings: { connectTimeoutSeconds: 10 },
      extensions: {},
    },
    mode: "external",
    topology: profile.defaultTopology,
    engineVersion: profile.defaultEngineVersion,
    client: defaultClientPolicy,
    compatibilityPins: profile.compatibilityPins,
    acl: { provider: "policy-registry", reference: "orders-runtime-acl" },
    migration: {
      contract: "meridian.migration.apply",
      version: "1.0.0",
      appliedFingerprint: fingerprintB,
    },
    observability: { enabled: false, labels: { service: "orders" } },
    recovery: {
      method: "backup-restore",
      owner: "orders-platform",
      policyRef: "orders-postgres-daily",
      rpoSeconds: 300,
      rtoSeconds: 14_400,
      validationFingerprint: fingerprintC,
    },
    ...overrides,
  };
}

export function deploymentSpec(
  overrides: Partial<DeploymentSpecV1> = {},
): DeploymentSpecV1 {
  return {
    profile: "development",
    catalogs,
    schemaProviders,
    resources: [ordersRequirement],
    bindings: [externalBinding()],
    placements: [placement],
    liveSchemas: { enabled: false, required: false, providerId: null },
    validation: defaultValidationPolicy,
    telemetry: disabledTelemetryCapability,
    extensions: {},
    ...overrides,
  };
}
