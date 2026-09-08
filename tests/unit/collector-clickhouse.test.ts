// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createClickHouseTelemetryPlan,
  fingerprint,
  telemetryFields,
  type ClickHouseTelemetryInput,
  type JsonObject,
} from "../../src/index.js";
import {
  sqlIdentifier,
  sqlString,
} from "../../src/constructs/otel/exporters/clickhouse/sql.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/collector-clickhouse/input.json", import.meta.url),
    "utf8",
  ),
) as ClickHouseTelemetryInput;
const input = (
  overrides: Partial<ClickHouseTelemetryInput> = {},
): ClickHouseTelemetryInput => ({ ...structuredClone(fixture), ...overrides });
function layoutChange(
  change: (layout: Record<string, unknown>) => void,
): ClickHouseTelemetryInput {
  const layout = structuredClone(fixture.layouts.log) as Record<
    string,
    unknown
  >;
  delete layout.layoutFingerprint;
  change(layout);
  layout.layoutFingerprint = fingerprint(layout);
  return input({ layouts: { ...fixture.layouts, log: layout as JsonObject } });
}

describe("authenticated stock ClickHouse telemetry plan", () => {
  it("renders stable explicit migrations, complete public fields and opaque credentials", () => {
    const selected = input();
    const before = JSON.stringify(selected);
    const plan = createClickHouseTelemetryPlan(selected);
    expect(createClickHouseTelemetryPlan(selected)).toEqual(plan);
    expect(JSON.stringify(selected)).toBe(before);
    expect(plan.collector.formatVersion).toBe("meridian-otel-collector.v1");
    expect(plan.collector.signals).toEqual(["logs", "metrics", "traces"]);
    expect(plan.layouts).toEqual(selected.layouts);
    expect(plan.layouts.log).not.toBe(selected.layouts.log);
    expect(plan.commandArguments).toEqual([
      "--feature-gates=ottl.functions.enableLambda",
    ]);
    expect(plan.migration.requiredLayouts).toEqual(
      Object.values(fixture.layouts)
        .map((l) => l.layoutFingerprint)
        .sort(),
    );
    expect(plan.migration.statements.join("\n")).toContain("ENGINE = Null");
    expect(plan.migration.statements.join("\n")).not.toContain("DROP ");
    const exporters = plan.collector.config.exporters as JsonObject;
    expect(exporters.clickhouse).toMatchObject({
      create_schema: false,
      async_insert: false,
      password: "${env:CLICKHOUSE_PASSWORD}",
      username: "${env:CLICKHOUSE_USER}",
      sending_queue: { storage: "file_storage", block_on_overflow: true },
    });
    expect(exporters["otlphttp/envelope"]).toMatchObject({
      sending_queue: { enabled: false },
      tls: { insecure: false, insecure_skip_verify: false },
    });
    expect(telemetryFields("metric").find((f) => f.name === "value")).toEqual({
      name: "value",
      kind: "json",
      nullable: false,
    });
  });
  it("accepts caller-selected digests and actual feature availability without release membership", () => {
    const selected = input({
      mode: "sidecar",
      replicas: 1,
      image: "example.invalid/collector@sha256:" + "b".repeat(64),
      lambdaFunctions: "available",
    });
    expect(createClickHouseTelemetryPlan(selected).commandArguments).toEqual(
      [],
    );
    expect(createClickHouseTelemetryPlan(selected).collector.image).toBe(
      selected.image,
    );
  });
  it("binds names and identities to migration content and authenticated scope", () => {
    const plan = createClickHouseTelemetryPlan(input());
    const changed = createClickHouseTelemetryPlan(
      input({ tenant: "another-tenant" }),
    );
    expect(changed.migration.fingerprint).not.toBe(plan.migration.fingerprint);
    expect(changed.migration.stagingTable).not.toBe(
      plan.migration.stagingTable,
    );
    const scope = {
      "2": "two",
      "10": "ten",
      "😀": "face",
      "\uffff": "last BMP",
    };
    const publicBytes =
      '{"scope":{"10":"ten","2":"two","\uffff":"last BMP","😀":"face"},"tenant":"tenant-a"}';
    const expected = createHash("sha256").update(publicBytes).digest("hex");
    expect(
      createClickHouseTelemetryPlan(input({ scope })).migration.statements.join(
        "\n",
      ),
    ).toContain(expected);
  });
  it.each([
    { backendEndpoint: "http://backend:8123" },
    { backendEndpoint: "https://user:password@backend" },
    { backendEndpoint: "https://backend?secure=false" },
    { backendEndpoint: "https://backend/#fragment" },
    { backendEndpoint: "https://backend/arbitrary" },
    { queueDirectory: "relative/path" },
    { queueDirectory: "/queue/../other" },
    { queueRequests: 0 },
    { maxBatchRows: 0 },
    { insertQuorum: 65 },
    { maxEnvelopeBytes: 1048576 },
    { scope: {} },
    {
      scope: Object.fromEntries(
        Array.from({ length: 33 }, (_, i) => [String(i), "value"]),
      ),
    },
    { database: "database; DROP DATABASE important" },
    { relayCredentialEnvironment: "CLICKHOUSE_PASSWORD" },
    { backendCredentialEnvironment: "PASSWORD:-fallback" },
    { receiverTls: { ...fixture.receiverTls, mode: "disabled" as const } },
    { mode: "sidecar" as const, replicas: 2 },
    { lambdaFunctions: "unknown" as "available" },
  ])(
    "rejects insecure, unbounded or ambiguous deployment inputs %j",
    (overrides) => {
      expect(() => createClickHouseTelemetryPlan(input(overrides))).toThrow();
    },
  );
  it("preserves the public Adapter's selected upper batch limits", () => {
    const plan = createClickHouseTelemetryPlan(
      input({
        maxBatchRows: 1000000,
        maxBatchBytes: 2147483647,
        maxEnvelopeBytes: 1048576,
        insertQuorum: 64,
      }),
    );
    expect(plan.collector.config.exporters).toBeDefined();
  });
  it("rejects mixed Binding topology even when each public layout fingerprint is valid", () => {
    expect(() =>
      createClickHouseTelemetryPlan(
        layoutChange((l) => {
          l.topology = "clickhouse-replicated";
        }),
      ),
    ).toThrow(/mix/);
  });
  it("rejects a tampered public fingerprint before rendering any SQL", () => {
    expect(() =>
      createClickHouseTelemetryPlan(
        input({
          layouts: {
            ...fixture.layouts,
            log: { ...fixture.layouts.log, table: "other" },
          },
        }),
      ),
    ).toThrow(/fingerprint/);
  });
  it.each([
    (l: Record<string, unknown>) => {
      l.extra = true;
    },
    (l: Record<string, unknown>) => {
      l.recordProfile = "span";
    },
    (l: Record<string, unknown>) => {
      l.queryFinal = false;
    },
    (l: Record<string, unknown>) => {
      l.timestampField = "eventTime";
    },
    (l: Record<string, unknown>) => {
      l.identityFields = ["traceId"];
    },
    (l: Record<string, unknown>) => {
      l.topology = "unknown";
    },
    (l: Record<string, unknown>) => {
      l.table = "unsafe`";
    },
    (l: Record<string, unknown>) => {
      (l.columns as unknown[]).pop();
    },
    (l: Record<string, unknown>) => {
      (l.columns as Record<string, unknown>[])[0]!.many = true;
    },
    (l: Record<string, unknown>) => {
      (l.columns as Record<string, unknown>[])[0]!.nullable = true;
    },
    (l: Record<string, unknown>) => {
      (l.columns as Record<string, unknown>[])[0]!.logicalType = "float64";
    },
    (l: Record<string, unknown>) => {
      (l.columns as Record<string, unknown>[])[0]!.clickhouseType = "Float64";
    },
    (l: Record<string, unknown>) => {
      (l.columns as Record<string, unknown>[])[0]!.extra = true;
    },
  ])("rejects correctly hashed incompatible public layouts", (change) => {
    expect(() => createClickHouseTelemetryPlan(layoutChange(change))).toThrow();
  });
  it("accepts the public object logical type representation", () => {
    const selected = layoutChange((l) => {
      for (const c of l.columns as Record<string, unknown>[])
        c.logicalType = { kind: c.logicalType };
    });
    expect(
      createClickHouseTelemetryPlan(selected).migration.requiredLayouts,
    ).toContain(selected.layouts.log.layoutFingerprint);
  });
  it("retains the complete append-only document and its distinct migration lock", () => {
    const legacy = createClickHouseTelemetryPlan(input());
    const selected = layoutChange((l) => {
      l.appendOnly = true;
    });
    const plan = createClickHouseTelemetryPlan(selected);
    expect(plan.layouts).toEqual(selected.layouts);
    expect(plan.layouts.log.appendOnly).toBe(true);
    expect(legacy.layouts.log).not.toHaveProperty("appendOnly");
    expect(plan.migration.requiredLayouts).toContain(
      selected.layouts.log.layoutFingerprint,
    );
    expect(plan.migration.fingerprint).not.toBe(legacy.migration.fingerprint);
    // The selected destination/columns and canonical row mapping are unchanged.
    // The caller must explicitly migrate the public table's sorting key.
    expect(plan.migration.statements).toEqual(legacy.migration.statements);
  });
  it.each([false, null, 0, 1, "true", {}, []])(
    "rejects noncanonical appendOnly %j",
    (value) => {
      expect(() =>
        createClickHouseTelemetryPlan(
          layoutChange((l) => {
            l.appendOnly = value;
          }),
        ),
      ).toThrow(/appendOnly/);
    },
  );
  it("rejects adding appendOnly without re-locking the complete public content", () => {
    const selected = input();
    (selected.layouts.log as Record<string, unknown>).appendOnly = true;
    expect(() => createClickHouseTelemetryPlan(selected)).toThrow(
      /fingerprint/,
    );
  });
  it.each([
    (layout: Record<string, unknown>) => {
      (layout.resource as Record<string, unknown>).extra = true;
    },
    (layout: Record<string, unknown>) => {
      layout.administrativeProfiles = ["z", "a"];
    },
  ])(
    "rejects noncanonical nested public content even with its own hash",
    (change) => {
      expect(() =>
        createClickHouseTelemetryPlan(layoutChange(change)),
      ).toThrow();
    },
  );
  it("quotes literal SQL separately from closed physical identifiers", () => {
    expect(sqlString("a'\\\n\0")).toBe("'a\\'\\\\\\x0a\\x00'");
    expect(sqlIdentifier("physical_1")).toBe("`physical_1`");
    expect(() => sqlIdentifier("physical`injection")).toThrow();
  });
});
