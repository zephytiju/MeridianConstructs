// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  MeridianConstructError,
  catalogNames,
  compatibilityContract,
  defaultEngineProfiles,
  engineProfiles,
  getEngineProfile,
  parseResourceSelector,
  rejectSecretMaterial,
  resourceSelectorKey,
  validateEngineConnection,
  validateResourceRequirement,
  validateTlsPolicy,
} from "../../src/index.js";
import { fingerprintA, fingerprintB, ordersRequirement } from "../fixtures.js";

describe("public contracts", () => {
  it("locks the Catalog registry and parses mapping-first Resource selectors", () => {
    expect(catalogNames).toEqual([
      "structured",
      "object",
      "cache",
      "evidence",
      "streaming",
    ]);
    const selector = parseResourceSelector("structured:orders.records");
    expect(resourceSelectorKey(selector)).toBe("structured:orders.records");
    expect(parseResourceSelector(selector)).toEqual(selector);
    expect(() => parseResourceSelector("telemetry:orders.records")).toThrow(
      MeridianConstructError,
    );
    expect(() =>
      parseResourceSelector({
        catalog: "telemetry" as never,
        namespace: "orders",
        name: "records",
      }),
    ).toThrow(/unregistered Catalog/);
  });

  it("rejects inline credentials recursively", () => {
    expect(() =>
      rejectSecretMaterial({ nested: [{ database_password: "do-not-store" }] }),
    ).toThrow(/inline secret material/);
    expect(() => rejectSecretMaterial({ pool: { size: 10 } })).not.toThrow();
  });

  it("enforces authenticated TLS and endpoint boundaries", () => {
    expect(() =>
      validateTlsPolicy({
        mode: "server",
        serverName: null,
        caRef: null,
        clientCertificateRef: null,
      }),
    ).toThrow(/requires a server name/);
    expect(() =>
      validateTlsPolicy({
        mode: "disabled",
        serverName: "unexpected",
        caRef: null,
        clientCertificateRef: null,
      }),
    ).toThrow(/cannot carry TLS references/);
    expect(() =>
      validateEngineConnection({
        physicalNamespace: "orders",
        identityRef: { provider: "identity", reference: "orders" },
        secretRef: { provider: "secrets", reference: "orders" },
        tls: {
          mode: "disabled",
          serverName: null,
          caRef: null,
          clientCertificateRef: null,
        },
        endpoint: "postgresql://user:password@example.test/orders",
        serviceRef: null,
        requiredPhysicalFingerprint: fingerprintA,
        settings: {},
        extensions: {},
      }),
    ).toThrow(/credentials/);
  });

  it("validates schema and operation requirements", () => {
    expect(() => validateResourceRequirement(ordersRequirement)).not.toThrow();
    expect(() =>
      validateResourceRequirement({
        ...ordersRequirement,
        schemas: [
          {
            ...ordersRequirement.schemas[0]!,
            fingerprint: "not-a-fingerprint",
          },
        ],
      }),
    ).toThrow(/sha256 fingerprint/);
    expect(() =>
      validateResourceRequirement({
        ...ordersRequirement,
        operations: [
          { contract: "meridian.structured.get", version: "1.0.0" },
          { contract: "meridian.structured.get", version: "1.0.0" },
        ],
      }),
    ).toThrow(/operation contracts must be unique/);
  });
});

describe("released Engine profiles", () => {
  it("covers the complete released Adapter set without runtime Adapter dependencies", () => {
    expect(
      new Set(Object.values(engineProfiles).map((item) => item.adapterPackage)),
    ).toEqual(
      new Set([
        "meridian-storage-postgresql",
        "meridian-storage-opensearch",
        "meridian-storage-clickhouse",
        "meridian-storage-valkey",
        "meridian-storage-s3",
        "meridian-storage-oci",
        "meridian-storage-kafka",
      ]),
    );
    expect(getEngineProfile("apache-kafka").compatibilityPins).toMatchObject({
      "meridian-storage-core": "1.0.0",
      "meridian-storage-semantics": "1.0.0",
      "meridian-storage-streaming": "1.0.0",
      "meridian-storage-kafka": "1.0.1",
    });
    expect(() => getEngineProfile("not-released")).toThrow(/PROFILE_NOT_FOUND/);
  });

  it("uses one-primary defaults and keeps Streaming opt-in", () => {
    const defaults = defaultEngineProfiles();
    expect(Object.keys(defaults).sort()).toEqual([
      "cache",
      "evidence",
      "object",
      "structured",
    ]);
    expect(defaults.streaming).toBeUndefined();
    expect(defaultEngineProfiles(true).streaming?.id).toBe("apache-kafka-test");
    expect(
      engineProfiles["postgresql-postgis-local-single-primary"]
        ?.defaultTopology,
    ).toBe("single-primary");
    expect(engineProfiles["valkey-standalone"]?.defaultTopology).toBe(
      "single-primary",
    );
  });

  it("mirrors every released Adapter's public V1 guarantees and default limits", () => {
    const postgres = getEngineProfile(
      "postgresql-postgis-local-single-primary",
    );
    expect(postgres.operations["meridian.structured.traverse"]).toMatchObject({
      guarantees: expect.arrayContaining([
        "bounded-traversal",
        "relation-collections",
      ]),
      limits: {
        maxMembershipNames: 10_000,
        maxPageSize: 500,
        maxRelationResources: 32,
        maxTraversalDepth: 8,
        pageSize: 500,
      },
    });

    const opensearch = getEngineProfile("opensearch");
    expect(opensearch.operations["meridian.structured.search"]?.limits).toEqual(
      {
        bulkActions: 1_000,
        bulkBytes: 8 * 1024 * 1024,
        facetBuckets: 100,
        facets: 32,
        filterClauses: 128,
        highlightFragments: 5,
        highlights: 32,
        pageSize: 500,
        queryBytes: 16_384,
      },
    );

    const clickhouse = getEngineProfile("clickhouse-standalone");
    expect(clickhouse.operations["meridian.evidence.append"]?.limits).toEqual({
      maxBatchBytes: 16 * 1024 * 1024,
      maxBatchRows: 10_000,
      maxTimeRangeSeconds: 31 * 24 * 60 * 60,
      pageSize: 500,
      retryWindowSeconds: 24 * 60 * 60,
    });

    const valkey = getEngineProfile("valkey-standalone");
    expect(valkey.operations["meridian.cache.get"]).toMatchObject({
      guarantees: expect.arrayContaining([
        "miss-on-unavailable",
        "schema-validated",
      ]),
      limits: {
        batchSize: 128,
        keyBytes: 512,
        maximumTtlMs: 86_400_000,
        valueBytes: 4 * 1024 * 1024,
      },
    });
    expect(
      valkey.operations["meridian.cache.compare_and_set"]?.guarantees,
    ).toContain("atomic-single-key");

    const s3 = getEngineProfile("aws-s3");
    expect(s3.operations["meridian.object.put"]).toMatchObject({
      guarantees: expect.arrayContaining(["object.digest-verification"]),
      limits: {
        "object.max-multipart-part-bytes": 5 * 1024 * 1024 * 1024,
        "object.max-multipart-parts": 10_000,
        "object.max-object-bytes": 5 * 1024 * 1024 * 1024 * 1024,
        "object.max-user-metadata-entries": 128,
      },
    });
    expect(s3.operations["meridian.object.delete"]?.guarantees).toEqual([
      "object.exact-version-delete",
    ]);

    const oci = getEngineProfile("oci-distribution");
    expect(oci.operations["meridian.object.put"]?.limits).toMatchObject({
      "object.max-multipart-part-bytes": 4 * 1024 * 1024,
    });
    expect(oci.operations["meridian.object.delete"]?.guarantees).toContain(
      "object.retention-intent",
    );

    const kafka = getEngineProfile("apache-kafka");
    expect(kafka.operations["meridian.streaming.read-range"]?.limits).toEqual({
      maxRangePartitions: 128,
      maxRangeSize: 10_000,
    });
  });

  it("publishes a TypeScript-only compatibility contract", () => {
    const contract = compatibilityContract();
    expect(contract.distribution).toBe("meridian-storage-iac");
    expect(contract.node).toBe(">=22");
    expect(contract.catalogRegistry).toEqual(catalogNames);
    expect(contract.consumerRestrictions).toEqual({
      adapterConcepts: false,
      engineConcepts: false,
      kafkaImports: false,
      nativeQueryV1: false,
    });
    expect(JSON.stringify(contract)).not.toContain('"python"');
    expect(contract.designRevisions.meridianConstructs).toBe(45);
    expect(contract.profiles.opensearch?.operationFingerprints).toHaveLength(1);
    expect(fingerprintB).toMatch(/^sha256:/);
  });
});
