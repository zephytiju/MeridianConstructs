// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  backupJob,
  cacheWarmJob,
  collectorEnvironment,
  createLifecycleJobSpec,
  createOtelCollectorSpec,
  migrationJob,
  projectionJob,
  restoreJob,
  streamingBootstrapJob,
  validationJob,
} from "../../src/index.js";
import {
  digestImage,
  fingerprintA,
  fingerprintB,
  ordersRequirement,
} from "../fixtures.js";

const resource = ordersRequirement.selector;
const target = {
  catalog: "structured",
  namespace: "orders",
  name: "projection",
} as const;

describe("caller-owned lifecycle jobs", () => {
  it("creates deterministic digest-pinned migration and validation jobs", () => {
    const migration = migrationJob({
      image: digestImage,
      resources: [resource],
      fromFingerprint: fingerprintA,
      toFingerprint: fingerprintB,
      secretRefs: [
        { provider: "secret-manager", reference: "orders/migration" },
      ],
    });
    expect(migration.kind).toBe("migration");
    expect(migration.operation.contract).toBe("meridian.migration.apply");
    expect(migration.specFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      migrationJob({
        image: digestImage,
        resources: [resource],
        fromFingerprint: fingerprintA,
        toFingerprint: fingerprintB,
      }).specFingerprint,
    ).not.toBe(migration.specFingerprint);
    expect(
      validationJob({
        image: digestImage,
        resources: [resource],
        expectedConfigFingerprint: fingerprintA,
      }).kind,
    ).toBe("validation");
  });

  it("provides projection, cache, streaming, backup, and restore templates", () => {
    expect(
      projectionJob({
        image: digestImage,
        source: resource,
        target,
        projectionFingerprint: fingerprintA,
      }).kind,
    ).toBe("projection");
    expect(
      cacheWarmJob({
        image: digestImage,
        source: resource,
        cache: { catalog: "cache", namespace: "orders", name: "records" },
        generation: "v1",
      }).kind,
    ).toBe("cache-warm");
    expect(
      streamingBootstrapJob({
        image: digestImage,
        resources: [
          { catalog: "streaming", namespace: "orders", name: "events" },
        ],
        mappingFingerprint: fingerprintB,
      }).kind,
    ).toBe("streaming-bootstrap");
    expect(
      backupJob({
        image: digestImage,
        resources: [resource],
        policyRef: "daily",
      }).kind,
    ).toBe("backup");
    expect(
      restoreJob({
        image: digestImage,
        resources: [resource],
        recoveryPointRef: "daily/2026-08-26",
      }).kind,
    ).toBe("restore");
  });

  it("rejects mutable images, duplicate resources, and inline credentials", () => {
    expect(() =>
      createLifecycleJobSpec({
        kind: "migration",
        image: "ghcr.io/example/job:latest",
        resources: [resource],
        operation: { contract: "test" },
      }),
    ).toThrow(/pinned by sha256 digest/);
    expect(() =>
      createLifecycleJobSpec({
        kind: "migration",
        image: digestImage,
        resources: [resource, resource],
        operation: { contract: "test" },
      }),
    ).toThrow(/resources must be unique/);
    expect(() =>
      createLifecycleJobSpec({
        kind: "migration",
        image: digestImage,
        resources: [resource],
        operation: { password: "forbidden" },
      }),
    ).toThrow(/inline secret material/);
  });
});

describe("OpenTelemetry Collector contract", () => {
  const collectorConfig = {
    receivers: { otlp: { protocols: { grpc: {}, http: {} } } },
    processors: { batch: {} },
    exporters: { otlp: { endpoint: "https://telemetry.example:4317" } },
    service: {
      pipelines: {
        logs: { receivers: ["otlp"], exporters: ["otlp"] },
        metrics: { receivers: ["otlp"], exporters: ["otlp"] },
        traces: { receivers: ["otlp"], exporters: ["otlp"] },
      },
    },
  } as const;

  function authenticatedCollector(
    password: unknown,
    credentialRefs = [
      { provider: "environment", reference: "CLICKHOUSE_PASSWORD" },
    ],
    extras = {},
  ) {
    return createOtelCollectorSpec({
      mode: "gateway",
      image: digestImage,
      config: {
        ...collectorConfig,
        exporters: {
          clickhouse: {
            endpoint: "https://clickhouse.example:8443",
            password: password as string,
            ...extras,
          },
        },
      },
      credentialRefs,
      protocol: "grpc",
      signals: ["traces", "metrics", "logs"],
      tls: {
        mode: "disabled",
        serverName: null,
        caRef: null,
        clientCertificateRef: null,
      },
      batchingSamplingFingerprint: fingerprintA,
      backendReadPlacement: {
        catalog: "evidence",
        namespace: "telemetry",
        name: "signals",
      },
    });
  }

  it("preserves declared opaque environment passwords without reading the environment", () => {
    const value = "${env:CLICKHOUSE_PASSWORD}";
    const first = authenticatedCollector(value);
    expect(first.config.exporters).toEqual({
      clickhouse: {
        endpoint: "https://clickhouse.example:8443",
        password: value,
      },
    });
    expect(first.credentialRefs).toEqual([
      { provider: "environment", reference: "CLICKHOUSE_PASSWORD" },
    ]);
    expect(authenticatedCollector(value)).toEqual(first);
    expect(
      authenticatedCollector("${env:OTHER_PASSWORD}", [
        { provider: "environment", reference: "OTHER_PASSWORD" },
      ]).specFingerprint,
    ).not.toEqual(first.specFingerprint);
  });

  it.each([
    "literal-secret",
    "",
    "${env:CLICKHOUSE_PASSWORD:-fallback}",
    "prefix-${env:CLICKHOUSE_PASSWORD}",
    "${env:CLICKHOUSE_PASSWORD}${env:CLICKHOUSE_PASSWORD}",
    "$${env:CLICKHOUSE_PASSWORD}",
    "${CLICKHOUSE_PASSWORD}",
    "${file:/secret/password}",
    "${env:UNDECLARED}",
    { reference: "CLICKHOUSE_PASSWORD" },
    ["${env:CLICKHOUSE_PASSWORD}"],
    null,
  ])(
    "rejects literal, compound, defaulted and unresolved passwords (%j)",
    (value) => {
      expect(() => authenticatedCollector(value)).toThrow(
        /inline secret material/,
      );
    },
  );

  it("requires the exact environment authority and retains other secret checks", () => {
    const value = "${env:CLICKHOUSE_PASSWORD}";
    expect(() => authenticatedCollector(value, [])).toThrow(/inline secret/);
    expect(() =>
      authenticatedCollector(value, [
        { provider: "secret-manager", reference: "CLICKHOUSE_PASSWORD" },
      ]),
    ).toThrow(/inline secret/);
    expect(() =>
      authenticatedCollector(value, [
        { provider: "environment", reference: "CLICKHOUSE_PASSWORD" },
        { provider: "environment", reference: "CLICKHOUSE_PASSWORD" },
      ]),
    ).toThrow(/must be unique/);
    expect(() =>
      authenticatedCollector(value, [
        { provider: "environment", reference: "invalid/name" },
      ]),
    ).toThrow(/one environment variable/);
    expect(() =>
      authenticatedCollector(value, undefined, { access_key: value }),
    ).toThrow(/inline secret/);
    expect(() =>
      authenticatedCollector(value, undefined, {
        endpoint: "${env:UNDECLARED}",
      }),
    ).toThrow(/declared environment reference/);
    expect(() =>
      authenticatedCollector(value, undefined, {
        nested: [{ password: "inline-secret" }],
      }),
    ).toThrow(/inline secret/);
  });

  it("creates sidecar and gateway capabilities without credential bytes", () => {
    const sidecar = createOtelCollectorSpec({
      mode: "sidecar",
      image: digestImage,
      config: collectorConfig,
      credentialRefs: [
        { provider: "secret-manager", reference: "otel/exporter" },
      ],
      protocol: "grpc",
      signals: ["traces", "metrics", "logs"],
      tls: {
        mode: "server",
        serverName: "telemetry.example",
        caRef: { provider: "secret-manager", reference: "otel/ca" },
        clientCertificateRef: null,
      },
      batchingSamplingFingerprint: fingerprintA,
      backendReadPlacement: {
        catalog: "evidence",
        namespace: "telemetry",
        name: "signals",
      },
    });
    expect(sidecar.replicas).toBe(1);
    expect(sidecar.specFingerprint).toMatch(/^sha256:/);
    expect(JSON.stringify(sidecar)).not.toContain("credentialBytes");
    expect(collectorEnvironment("http://localhost:4317", "grpc")).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4317",
      OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
    });
  });

  it("rejects invalid sidecars and incomplete Collector pipelines", () => {
    expect(() =>
      createOtelCollectorSpec({
        mode: "sidecar",
        image: digestImage,
        config: collectorConfig,
        replicas: 2,
        protocol: "grpc",
        signals: ["traces"],
        tls: {
          mode: "disabled",
          serverName: null,
          caRef: null,
          clientCertificateRef: null,
        },
        batchingSamplingFingerprint: fingerprintA,
        backendReadPlacement: {
          catalog: "evidence",
          namespace: "telemetry",
          name: "signals",
        },
      }),
    ).toThrow(/exactly one replica/);
    expect(() =>
      createOtelCollectorSpec({
        mode: "gateway",
        image: digestImage,
        config: { receivers: {} },
        protocol: "http/protobuf",
        signals: ["logs"],
        tls: {
          mode: "disabled",
          serverName: null,
          caRef: null,
          clientCertificateRef: null,
        },
        batchingSamplingFingerprint: fingerprintA,
        backendReadPlacement: {
          catalog: "evidence",
          namespace: "telemetry",
          name: "signals",
        },
      }),
    ).toThrow(/missing processors, exporters, service/);
    expect(() =>
      createOtelCollectorSpec({
        mode: "gateway",
        image: digestImage,
        config: collectorConfig,
        protocol: "grpc",
        signals: ["traces"],
        tls: {
          mode: "disabled",
          serverName: null,
          caRef: null,
          clientCertificateRef: null,
        },
        batchingSamplingFingerprint: fingerprintA,
        backendReadPlacement: {
          catalog: "object",
          namespace: "telemetry",
          name: "signals",
        },
      }),
    ).toThrow(/evidence Catalog/);
  });
});
