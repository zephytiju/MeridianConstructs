// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { fingerprint, type JsonObject } from "../../../../canonical.js";
import {
  assertBoundedText,
  assertFingerprint,
  resourceSelectorKey,
  type TlsPolicy,
  type ResourceSelectorV1,
} from "../../../../contracts/index.js";
import {
  createOtelCollectorSpec,
  type CollectorMode,
  type OtelCollectorSpecV1,
} from "../../../otel.js";
import {
  telemetryFields,
  telemetryRecordExpressions,
  type TelemetryRecordProfile,
} from "./mapping.js";
import {
  canonicalSqlFunctions,
  sqlIdentifier as ident,
  sqlString as q,
} from "./sql.js";
import {
  publicCanonicalJson,
  publicClickHouseLayout,
} from "../../../../clickhouse-layout.js";
import { envelopeValidation } from "./validation.js";

export { telemetryFields } from "./mapping.js";
export type {
  TelemetryField,
  TelemetryFieldKind,
  TelemetryRecordProfile,
} from "./mapping.js";

interface PublicColumn {
  readonly logicalName: string;
  readonly physicalName: string;
  readonly logicalType: string | { readonly kind: string };
  readonly clickhouseType: string;
  readonly nullable: boolean;
  readonly many: boolean;
}
interface PublicLayout {
  readonly resource: ResourceSelectorV1;
  readonly table: string;
  readonly recordProfile: TelemetryRecordProfile;
  readonly schemaVersion: string;
  readonly resourceFingerprint: string;
  readonly schemaFingerprint: string;
  readonly layoutFingerprint: string;
  readonly columns: readonly PublicColumn[];
  readonly timestampField: string;
  readonly identityFields: readonly string[];
  readonly topology: string;
  readonly queryFinal: boolean;
  readonly appendOnly?: true;
}

export interface ClickHouseTelemetryInput {
  readonly mode: CollectorMode;
  readonly image: string;
  readonly replicas?: number;
  /** Select the actual image's feature configuration, without a release allowlist. */
  readonly lambdaFunctions?: "feature-gate" | "available";
  readonly database: string;
  readonly bindingId: string;
  /** Exact public ResourceLayout.to_dict() values, following caller-owned migration. */
  readonly layouts: Readonly<Record<TelemetryRecordProfile, JsonObject>>;
  readonly tenant: string;
  readonly scope: Readonly<Record<string, string>>;
  readonly ingestionIdentity: string;
  readonly receiverTls: TlsPolicy;
  readonly tlsFiles: {
    readonly certificate: string;
    readonly key: string;
    readonly clientCa: string;
    readonly backendCa: string;
    readonly receiverCa: string;
  };
  readonly backendEndpoint: string;
  readonly backendIdentityEnvironment: string;
  readonly backendCredentialEnvironment: string;
  readonly relayCredentialEnvironment: string;
  readonly queueDirectory: string;
  readonly queueRequests: number;
  readonly maxEnvelopeBytes: number;
  /** Public Adapter settings; the renderer cannot broaden these limits. */
  readonly maxBatchBytes: number;
  readonly maxBatchRows: number;
  readonly insertQuorum: number;
}

export interface ClickHouseTelemetryPlan {
  /** Complete validated public layouts; omission retains legacy layout semantics. */
  readonly layouts: Readonly<Record<TelemetryRecordProfile, JsonObject>>;
  readonly collector: OtelCollectorSpecV1;
  readonly commandArguments: readonly string[];
  readonly migration: {
    readonly fingerprint: string;
    readonly requiredLayouts: readonly string[];
    readonly statements: readonly string[];
    readonly stagingTable: string;
  };
}

/** Pure render. The caller provisions identity, mounts, provider and migration. */
export function createClickHouseTelemetryPlan(
  input: ClickHouseTelemetryInput,
): ClickHouseTelemetryPlan {
  ident(input.database);
  for (const [name, value] of Object.entries({
    bindingId: input.bindingId,
    tenant: input.tenant,
    ingestionIdentity: input.ingestionIdentity,
  }))
    assertBoundedText(value, name, 256);
  if (input.receiverTls.mode !== "mutual")
    throw new TypeError("Telemetry receiver requires mutual TLS");
  if (input.receiverTls.serverName === null)
    throw new TypeError("Receiver TLS server name is required");
  assertBoundedText(
    input.receiverTls.serverName,
    "receiver TLS server name",
    256,
  );
  if (
    input.lambdaFunctions !== undefined &&
    !["feature-gate", "available"].includes(input.lambdaFunctions)
  )
    throw new TypeError("Collector lambda function configuration is invalid");
  for (const [name, value] of Object.entries({
    ...input.tlsFiles,
    queueDirectory: input.queueDirectory,
  })) {
    if (!/^\/[A-Za-z0-9_./-]+$/.test(value) || value.split("/").includes(".."))
      throw new TypeError(`${name} must be an absolute mounted path`);
  }
  if (
    Object.keys(input.scope).length === 0 ||
    Object.keys(input.scope).length > 32
  )
    throw new TypeError("Authenticated scope must contain 1–32 entries");
  for (const [name, value] of Object.entries(input.scope)) {
    assertBoundedText(name, "scope key", 128);
    assertBoundedText(value, "scope value", 512);
  }
  const endpoint = new URL(input.backendEndpoint);
  if (
    endpoint.protocol !== "https:" ||
    !endpoint.hostname ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !["", "/"].includes(endpoint.pathname)
  )
    throw new TypeError(
      "Backend endpoint must be an HTTPS authority without credentials or parameters",
    );
  const variables = [
    input.backendIdentityEnvironment,
    input.backendCredentialEnvironment,
    input.relayCredentialEnvironment,
  ];
  if (
    new Set(variables).size !== 3 ||
    variables.some((v) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v))
  )
    throw new TypeError(
      "Backend identity, credential and private relay must use separate environment references",
    );
  for (const [name, value, maximum] of [
    ["queueRequests", input.queueRequests, 10000],
    ["maxEnvelopeBytes", input.maxEnvelopeBytes, 1048576],
    ["maxBatchBytes", input.maxBatchBytes, 2147483647],
    ["maxBatchRows", input.maxBatchRows, 1000000],
    ["insertQuorum", input.insertQuorum, 64],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new TypeError(`${name} is outside the bounded range`);
  }
  const scopeJson = publicCanonicalJson(input.scope);
  if (
    input.maxEnvelopeBytes * 16 + Buffer.byteLength(scopeJson) * 2 + 8192 >
    input.maxBatchBytes
  )
    throw new TypeError(
      "Envelope expansion can exceed the public Adapter batch byte limit",
    );
  const layouts = Object.fromEntries(
    (["log", "span", "metric"] as const).map((profile) => [
      profile,
      validateLayout(input.layouts[profile], profile),
    ]),
  ) as unknown as Record<TelemetryRecordProfile, PublicLayout>;
  if (new Set(Object.values(layouts).map((l) => l.topology)).size !== 1)
    throw new TypeError("One Binding cannot mix public ClickHouse topologies");
  if (new Set(Object.values(layouts).map((l) => l.table)).size !== 3)
    throw new TypeError("Signals require separate registered Resource tables");
  const template = "mrd_template";
  const prefix = `mrd_otel_${fingerprint({ helpers: canonicalSqlFunctions(template), staging: stagingDdl(input.database, `${template}_ingress`), mappings: Object.values(layouts).flatMap((layout) => materializedView(input, layout, template, `${template}_ingress`, scopeJson)) }).slice(7, 23)}`;
  const stagingTable = `${prefix}_ingress`;
  const statements = [
    ...canonicalSqlFunctions(prefix),
    stagingDdl(input.database, stagingTable),
    ...Object.values(layouts).flatMap((layout) =>
      materializedView(input, layout, prefix, stagingTable, scopeJson),
    ),
  ];
  const migration = {
    requiredLayouts: Object.values(layouts)
      .map((l) => l.layoutFingerprint)
      .sort(),
    statements,
    stagingTable,
  };
  const migrationFingerprint = fingerprint(migration);
  const environment = (name: string) => `\${env:${name}}`;
  const relayEndpoint = "https://127.0.0.1:18180/events";
  const receiverTls = {
    cert_file: input.tlsFiles.certificate,
    key_file: input.tlsFiles.key,
    client_ca_file: input.tlsFiles.clientCa,
  };
  const config: JsonObject = {
    extensions: {
      file_storage: {
        directory: input.queueDirectory,
        create_directory: true,
        fsync: true,
      },
    },
    receivers: {
      otlp: {
        protocols: {
          http: {
            endpoint: "0.0.0.0:4318",
            tls: receiverTls,
            max_request_body_size: input.maxEnvelopeBytes,
          },
          grpc: {
            endpoint: "0.0.0.0:4317",
            tls: receiverTls,
            max_recv_msg_size_mib: 1,
          },
        },
      },
      webhook_event: {
        endpoint: "127.0.0.1:18180",
        path: "/events",
        tls: {
          cert_file: input.tlsFiles.certificate,
          key_file: input.tlsFiles.key,
        },
        required_header: {
          key: "X-Meridian-Relay",
          value: environment(input.relayCredentialEnvironment),
        },
        read_timeout: "10s",
        write_timeout: "0s",
        max_request_body_size: input.maxEnvelopeBytes,
      },
    },
    processors: {
      "transform/validate": envelopeValidation(input.maxEnvelopeBytes),
    },
    exporters: {
      "otlphttp/envelope": {
        endpoint: relayEndpoint,
        logs_endpoint: relayEndpoint,
        traces_endpoint: relayEndpoint,
        metrics_endpoint: relayEndpoint,
        encoding: "json",
        compression: "none",
        tls: {
          ca_file: input.tlsFiles.receiverCa,
          server_name_override: input.receiverTls.serverName,
          insecure: false,
          insecure_skip_verify: false,
        },
        headers: {
          "X-Meridian-Relay": environment(input.relayCredentialEnvironment),
        },
        timeout: "2s",
        sending_queue: { enabled: false },
        retry_on_failure: { enabled: false },
      },
      clickhouse: {
        endpoint: input.backendEndpoint,
        database: input.database,
        username: environment(input.backendIdentityEnvironment),
        password: environment(input.backendCredentialEnvironment),
        tls: {
          ca_file: input.tlsFiles.backendCa,
          insecure: false,
          insecure_skip_verify: false,
        },
        logs_table_name: stagingTable,
        create_schema: false,
        async_insert: false,
        timeout: "30s",
        connection_params: {
          allow_simdjson: "0",
          short_circuit_function_evaluation: "force_enable",
          insert_quorum: String(input.insertQuorum),
        },
        sending_queue: {
          enabled: true,
          queue_size: input.queueRequests,
          num_consumers: 1,
          storage: "file_storage",
          block_on_overflow: true,
        },
        retry_on_failure: {
          enabled: true,
          initial_interval: "1s",
          max_interval: "30s",
          max_elapsed_time: "0s",
        },
      },
    },
    service: {
      extensions: ["file_storage"],
      pipelines: {
        logs: { receivers: ["otlp"], exporters: ["otlphttp/envelope"] },
        traces: { receivers: ["otlp"], exporters: ["otlphttp/envelope"] },
        metrics: { receivers: ["otlp"], exporters: ["otlphttp/envelope"] },
        "logs/envelope": {
          receivers: ["webhook_event"],
          processors: ["transform/validate"],
          exporters: ["clickhouse"],
        },
      },
    },
  };
  return {
    layouts: layouts as unknown as Record<TelemetryRecordProfile, JsonObject>,
    collector: createOtelCollectorSpec({
      mode: input.mode,
      image: input.image,
      ...(input.replicas === undefined ? {} : { replicas: input.replicas }),
      config,
      credentialRefs: variables.map((reference) => ({
        provider: "environment",
        reference,
      })),
      protocol: "http/protobuf",
      signals: ["logs", "traces", "metrics"],
      tls: input.receiverTls,
      batchingSamplingFingerprint: fingerprint({
        queueRequests: input.queueRequests,
        maxEnvelopeBytes: input.maxEnvelopeBytes,
        maxBatchBytes: input.maxBatchBytes,
        migrationFingerprint,
      }),
      backendReadPlacement: layouts.log.resource,
      extensions: {
        "org.meridian.constructs/clickhouseTelemetry": {
          migrationFingerprint,
          lambdaFunctions: input.lambdaFunctions ?? "feature-gate",
          resources: Object.fromEntries(
            Object.entries(layouts).map(([k, v]) => [k, v.resource]),
          ) as unknown as JsonObject,
        },
      },
    }),
    commandArguments:
      input.lambdaFunctions === "available"
        ? []
        : ["--feature-gates=ottl.functions.enableLambda"],
    migration: { ...migration, fingerprint: migrationFingerprint },
  };
}

function validateLayout(
  input: JsonObject,
  profile: TelemetryRecordProfile,
): PublicLayout {
  const value = publicClickHouseLayout(input);
  const layout = value as unknown as PublicLayout;
  resourceSelectorKey(layout.resource);
  if (
    layout.recordProfile !== profile ||
    layout.resource.catalog !== "evidence" ||
    layout.queryFinal !== true ||
    layout.timestampField !== "observedTime" ||
    publicCanonicalJson(layout.identityFields) !== '["evidenceId"]'
  )
    throw new TypeError(
      "Telemetry layout must select its registered Evidence profile, timestamp and stable identity",
    );
  if (
    !["clickhouse-standalone", "clickhouse-replicated"].includes(
      layout.topology,
    )
  )
    throw new TypeError("Unsupported public ClickHouse topology");
  ident(layout.table);
  assertFingerprint(layout.resourceFingerprint, "Resource fingerprint");
  assertFingerprint(layout.schemaFingerprint, "Schema fingerprint");
  const fields = telemetryFields(profile);
  if (
    layout.columns.length !== fields.length ||
    new Set(layout.columns.map((c) => c.logicalName)).size !== fields.length ||
    new Set(layout.columns.map((c) => c.physicalName)).size !== fields.length
  )
    throw new TypeError(
      "Layout must contain the complete unique telemetry fields",
    );
  for (const field of fields) {
    const column = layout.columns.find((c) => c.logicalName === field.name);
    if (
      column !== undefined &&
      Object.keys(column).sort().join(",") !==
        "clickhouseType,logicalName,logicalType,many,nullable,physicalName"
    )
      throw new TypeError("Public ColumnLayout has unknown or missing fields");
    const type = column?.logicalType;
    const kind = typeof type === "string" ? type : type?.kind;
    const physical = {
      string: "String",
      utcTimestamp: "DateTime64(9, 'UTC')",
      json: "String",
      int64: "Int64",
      boolean: "Bool",
    }[field.kind];
    if (
      column === undefined ||
      kind !== field.kind ||
      column.many !== false ||
      column.nullable !== field.nullable ||
      column.clickhouseType !==
        (field.nullable ? `Nullable(${physical})` : physical)
    )
      throw new TypeError(
        `Public layout field ${field.name} does not match the telemetry mapping`,
      );
    ident(column.physicalName);
  }
  return layout;
}

function stagingDdl(database: string, table: string): string {
  return `CREATE TABLE IF NOT EXISTS ${ident(database)}.${ident(table)} (Timestamp DateTime64(9), TraceId String, SpanId String, TraceFlags UInt8, SeverityText LowCardinality(String), SeverityNumber UInt8, ServiceName LowCardinality(String), Body String, ResourceSchemaUrl LowCardinality(String), ResourceAttributes Map(LowCardinality(String),String), ScopeSchemaUrl LowCardinality(String), ScopeName String, ScopeVersion LowCardinality(String), ScopeAttributes Map(LowCardinality(String),String), LogAttributes Map(LowCardinality(String),String), EventName String) ENGINE = Null`;
}

function materializedView(
  input: ClickHouseTelemetryInput,
  layout: PublicLayout,
  prefix: string,
  staging: string,
  scopeJson: string,
): readonly string[] {
  const profile = layout.recordProfile;
  const fields = telemetryRecordExpressions(profile, {
    prefix,
    tenant: input.tenant,
    scopeJson,
    ingestionIdentity: input.ingestionIdentity,
  });
  const pairs = Object.entries(fields)
    .map(([key, expr]) => `(${q(key)},${expr})`)
    .join(",");
  const scopeFingerprint = sha(
    publicCanonicalJson({ tenant: input.tenant, scope: input.scope }),
  );
  const canonicalResource = `${layout.resource.catalog}:${layout.resource.namespace}.${layout.resource.name}`;
  const operation = {
    formatVersion: "meridian-operation.v1",
    catalog: "evidence",
    operationContract: "meridian.evidence.append",
    operationVersion: "1.0.0",
    resources: [layout.resource],
    input: { records: ["ROW_PLACEHOLDER"] },
    requirements: [],
    readOnly: false,
    idempotent: true,
  };
  const [opBefore, opAfter] =
    publicCanonicalJson(operation).split('"ROW_PLACEHOLDER"');
  const batch = {
    bindingId: input.bindingId,
    operationFingerprint: "OP_PLACEHOLDER",
    resource: canonicalResource,
    schemaFingerprint: layout.schemaFingerprint,
    scopeFingerprint,
    stableKey: "KEY_PLACEHOLDER",
  };
  const [batchBefore, rest] =
    publicCanonicalJson(batch).split('"OP_PLACEHOLDER"');
  const [batchMiddle, batchAfter] = rest!.split('"KEY_PLACEHOLDER"');
  const target = `${ident(input.database)}.${ident(layout.table)}`;
  const lookup = (name: string) =>
    `arrayFirst(t -> t.1=${q(name)},record_fields).2`;
  const columns = layout.columns.map((c) => {
    const value = lookup(c.logicalName);
    const kind =
      typeof c.logicalType === "string" ? c.logicalType : c.logicalType.kind;
    const converted =
      kind === "string"
        ? `JSONExtractString(${value})`
        : kind === "utcTimestamp"
          ? `parseDateTime64BestEffort(JSONExtractString(${value}),9,'UTC')`
          : kind === "int64"
            ? `toInt64(${value})`
            : kind === "boolean"
              ? `toBool(${value}='true')`
              : value;
    return `${c.nullable ? `if(${value}='null',NULL,${converted})` : converted} AS ${ident(c.physicalName)}`;
  });
  const resourceKey =
    profile === "log"
      ? "resourceLogs"
      : profile === "span"
        ? "resourceSpans"
        : "resourceMetrics";
  const scopeKey =
    profile === "log"
      ? "scopeLogs"
      : profile === "span"
        ? "scopeSpans"
        : "scopeMetrics";
  const source =
    profile === "metric"
      ? `SELECT *,JSONExtractRaw(m,metric_type) AS metric_data,arrayJoin(JSONExtractArrayRaw(metric_data,'dataPoints')) AS d FROM (SELECT *,arrayJoin(JSONExtractArrayRaw(s,'metrics')) AS m,arrayFirst(k -> JSONHas(m,k),['gauge','sum','histogram','exponentialHistogram']) AS metric_type FROM source_scopes)`
      : `SELECT *,arrayJoin(JSONExtractArrayRaw(s,${q(profile === "log" ? "logRecords" : "spans")})) AS d FROM source_scopes`;
  const fieldTable = `${ident(input.database)}.${ident(`${prefix}_${profile}_fields`)}`;
  const rowTable = `${ident(input.database)}.${ident(`${prefix}_${profile}_rows`)}`;
  const sourceSql = `WITH source_resources AS (SELECT arrayJoin(JSONExtractArrayRaw(${prefix}_protect_zero(Body),${q(resourceKey)})) AS r FROM ${ident(input.database)}.${ident(staging)}),
source_scopes AS (SELECT *,arrayJoin(JSONExtractArrayRaw(r,${q(scopeKey)})) AS s FROM source_resources)`;
  const included =
    't -> NOT (t.1 IN ("traceId","spanId","parentSpanId") AND t.2="null")'.replaceAll(
      '"',
      "'",
    );
  return [
    `CREATE TABLE IF NOT EXISTS ${rowTable} (r String,s String,d String,m String,metric_type String,metric_data String) ENGINE = Null`,
    `CREATE TABLE IF NOT EXISTS ${fieldTable} (Fields Array(Tuple(String,String))) ENGINE = Null`,
    `CREATE MATERIALIZED VIEW IF NOT EXISTS ${ident(input.database)}.${ident(`${prefix}_${profile}_split`)} TO ${rowTable} AS ${sourceSql} SELECT r,s,d,${profile === "metric" ? "m,metric_type,metric_data" : "'{}' AS m,'' AS metric_type,'{}' AS metric_data"} FROM (${source})`,
    `CREATE MATERIALIZED VIEW IF NOT EXISTS ${ident(input.database)}.${ident(`${prefix}_${profile}_map`)} TO ${fieldTable} AS SELECT [${pairs}] AS Fields FROM ${rowTable}`,
    `CREATE MATERIALIZED VIEW IF NOT EXISTS ${ident(input.database)}.${ident(`${prefix}_${profile}`)} TO ${target} AS
WITH Fields AS base_fields,
${prefix}_object(arrayFilter(${included},base_fields)) AS base_record,
concat('sha256:',lower(hex(SHA256(base_record)))) AS evidence_id,
arrayPushBack(base_fields,('evidenceId',${prefix}_quote(evidence_id))) AS record_fields,
${prefix}_object(arrayFilter(${included},record_fields)) AS record_json,
${prefix}_object(record_fields) AS canonical_row,
concat('sha256:',lower(hex(SHA256(concat(${q(opBefore!)},record_json,${q(opAfter!)}))))) AS operation_fingerprint,
concat('mb1_',lower(hex(SHA256(concat(${q(batchBefore!)},${prefix}_quote(operation_fingerprint),${q(batchMiddle!)},${prefix}_quote(evidence_id),${q(batchAfter!)}))))) AS batch_id
SELECT ${q(scopeFingerprint)} AS _meridian_scope_fingerprint,${q(input.tenant)} AS _meridian_tenant,batch_id AS _meridian_batch_id,lower(hex(SHA256(canonical_row))) AS _meridian_row_fingerprint,${q(canonicalResource)} AS _meridian_resource,${q(layout.schemaVersion)} AS _meridian_schema_version,now64(9) AS _meridian_ingested_at,${columns.join(",\n")}
FROM ${fieldTable}`,
  ];
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
