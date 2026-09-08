// SPDX-License-Identifier: Apache-2.0
import { sqlString as q } from "./sql.js";

export type TelemetryRecordProfile = "log" | "span" | "metric";
export type TelemetryFieldKind =
  "string" | "utcTimestamp" | "json" | "int64" | "boolean";
export interface TelemetryField {
  readonly name: string;
  readonly kind: TelemetryFieldKind;
  readonly nullable: boolean;
}

const common = {
  formatVersion: "string",
  profile: "string",
  kind: "string",
  evidenceId: "string",
  eventTime: "utcTimestamp",
  observedTime: "utcTimestamp",
  tenant: "string",
  scope: "json",
  otelResource: "json",
  instrumentationScope: "json",
  ingestionIdentity: "string",
  sourceProtocolVersion: "string",
  attributes: "json",
  provenance: "json",
  extensions: "json",
} as const;
const specialized = {
  log: {
    severity: "string",
    body: "json",
    flags: "int64",
    traceId: "string",
    spanId: "string",
  },
  span: {
    traceId: "string",
    spanId: "string",
    name: "string",
    spanKind: "string",
    startTime: "utcTimestamp",
    endTime: "utcTimestamp",
    status: "string",
    parentSpanId: "string",
    events: "json",
    links: "json",
  },
  metric: {
    name: "string",
    unit: "string",
    metricType: "string",
    temporality: "string",
    monotonic: "boolean",
    startTime: "utcTimestamp",
    endTime: "utcTimestamp",
    value: "json",
    dimensions: "json",
    flags: "int64",
    exemplars: "json",
  },
} as const;

/** Fields for the caller's public Semantics Schema/ClickHouse compiler. */
export function telemetryFields(
  profile: TelemetryRecordProfile,
): readonly TelemetryField[] {
  return Object.entries({ ...common, ...specialized[profile] })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, kind]) => ({
      name,
      kind,
      nullable:
        profile === "log"
          ? ["body", "traceId", "spanId"].includes(name)
          : profile === "span" && name === "parentSpanId",
    }));
}

export interface MappingContext {
  readonly prefix: string;
  readonly tenant: string;
  readonly scopeJson: string;
  readonly ingestionIdentity: string;
}

/** Expressions run solely in the explicitly migrated Collector materialized view. */
export function telemetryRecordExpressions(
  profile: TelemetryRecordProfile,
  context: MappingContext,
): Readonly<Record<string, string>> {
  const f = (name: string) => `${context.prefix}_${name}`;
  const raw = (x: string, key: string) =>
    `if(JSONHas(${x},${q(key)}),JSONExtractRaw(${x},${q(key)}),'{}')`;
  const string = (x: string, key: string) =>
    `${f("quote")}(JSONExtractString(${x},${q(key)}))`;
  const uint = (x: string, key: string) =>
    `toString(JSONExtractUInt(${x},${q(key)}))`;
  const boolean = (x: string, key: string) =>
    `if(JSONExtractBool(${x},${q(key)}),'true','false')`;
  const attributes = (x: string, key = "attributes") =>
    `${f("attributes")}(${raw(x, key)})`;
  const object = (values: Record<string, string>) =>
    `${f("object")}([${Object.entries(values)
      .map(([k, v]) => `(${q(k)},${v})`)
      .join(",")}])`;
  const array = (x: string, key: string, item: string) =>
    `${f("array")}(arrayMap(t -> ${item},JSONExtractArrayRaw(${x},${q(key)})))`;
  const nanos = (x: string, key: string) =>
    `toInt64OrZero(JSONExtractString(${x},${q(key)}))`;
  const time = (ns: string) =>
    `${f("quote")}(concat(formatDateTime(fromUnixTimestamp64Nano(${ns}),'%Y-%m-%dT%H:%i:%S','UTC'),'.',leftPad(toString(modulo(${ns},1000000000)),9,'0'),'Z'))`;
  const number = (x: string, key: string) =>
    `${f("float")}(${f("number")}(${raw(x, key)}))`;
  const numericValue = (x: string) =>
    `if(JSONHas(${x},'asInt'),toString(toInt64OrZero(JSONExtractString(${x},'asInt'))),${number(x, "asDouble")})`;
  const optionalId = (key: string) =>
    `if(JSONExtractString(d,${q(key)})='','null',${string("d", key)})`;
  const observed =
    profile === "log"
      ? `if(${nanos("d", "observedTimeUnixNano")}=0,${nanos("d", "timeUnixNano")},${nanos("d", "observedTimeUnixNano")})`
      : nanos("d", profile === "span" ? "endTimeUnixNano" : "timeUnixNano");
  const event =
    profile === "log"
      ? `if(${nanos("d", "timeUnixNano")}=0,${observed},${nanos("d", "timeUnixNano")})`
      : nanos("d", profile === "span" ? "startTimeUnixNano" : "timeUnixNano");
  // Exact typed OTLP source in an existing V1 extension disambiguates bytes,
  // integer vs double zero, dropped counts and any source metadata. Canonical
  // attribute ordering keeps the identity independent of Collector batching.
  const source = object({
    resource: raw("r", "resource"),
    resourceSchemaUrl: string("r", "schemaUrl"),
    scope: raw("s", "scope"),
    scopeSchemaUrl: string("s", "schemaUrl"),
    record: "d",
    ...(profile === "metric"
      ? {
          metric: object({
            name: string("m", "name"),
            unit: string("m", "unit"),
            description: string("m", "description"),
            metadata: `if(JSONHas(m,'metadata'),${raw("m", "metadata")},'[]')`,
            type: `${f("quote")}(metric_type)`,
            temporality: uint("metric_data", "aggregationTemporality"),
            monotonic: boolean("metric_data", "isMonotonic"),
          }),
        }
      : {}),
  });
  const fields: Record<string, string> = {
    formatVersion: q('"meridian-evidence-data.v1"'),
    profile: q('"telemetry"'),
    kind: q(JSON.stringify(profile === "metric" ? "metric-point" : profile)),
    eventTime: time(event),
    observedTime: time(observed),
    tenant: q(JSON.stringify(context.tenant)),
    scope: q(context.scopeJson),
    otelResource: attributes(raw("r", "resource")),
    instrumentationScope: object({
      name: string(raw("s", "scope"), "name"),
      version: string(raw("s", "scope"), "version"),
      attributes: attributes(raw("s", "scope")),
    }),
    ingestionIdentity: q(JSON.stringify(context.ingestionIdentity)),
    sourceProtocolVersion: q('"opentelemetry.proto.collector.v1"'),
    attributes: attributes("d"),
    provenance: q("{}"),
    extensions: object({
      "org.meridian.constructs/otlp": `${f("wire")}(${source},'')`,
    }),
  };
  if (profile === "log") {
    Object.assign(fields, {
      severity: `${f("quote")}(multiIf(JSONExtractUInt(d,'severityNumber')>=21,'FATAL',JSONExtractUInt(d,'severityNumber')>=17,'ERROR',JSONExtractUInt(d,'severityNumber')>=13,'WARN',JSONExtractUInt(d,'severityNumber')>=9,'INFO',JSONExtractUInt(d,'severityNumber')>=5,'DEBUG',JSONExtractUInt(d,'severityNumber')>=1,'TRACE',if(JSONExtractString(d,'severityText')='','UNSPECIFIED',JSONExtractString(d,'severityText'))))`,
      body: `${f("any_12")}(${raw("d", "body")})`,
      flags: uint("d", "flags"),
      traceId: optionalId("traceId"),
      spanId: optionalId("spanId"),
    });
  } else if (profile === "span") {
    Object.assign(fields, {
      traceId: string("d", "traceId"),
      spanId: string("d", "spanId"),
      parentSpanId: optionalId("parentSpanId"),
      name: string("d", "name"),
      spanKind: `${f("quote")}(['unspecified','internal','server','client','producer','consumer'][JSONExtractUInt(d,'kind')+1])`,
      startTime: time(nanos("d", "startTimeUnixNano")),
      endTime: time(nanos("d", "endTimeUnixNano")),
      status: `${f("quote")}(['unset','ok','error'][JSONExtractUInt(d,'status','code')+1])`,
      events: array(
        "d",
        "events",
        object({
          name: string("t", "name"),
          time: time(nanos("t", "timeUnixNano")),
          attributes: attributes("t"),
          droppedAttributesCount: uint("t", "droppedAttributesCount"),
        }),
      ),
      links: array(
        "d",
        "links",
        object({
          traceId: string("t", "traceId"),
          spanId: string("t", "spanId"),
          traceState: string("t", "traceState"),
          flags: uint("t", "flags"),
          attributes: attributes("t"),
          droppedAttributesCount: uint("t", "droppedAttributesCount"),
        }),
      ),
    });
  } else {
    const uint64 = (x: string, key: string) =>
      `toString(toUInt64OrZero(JSONExtractString(${x},${q(key)})))`;
    const counts = (x: string) =>
      array(
        x,
        "bucketCounts",
        "toString(toUInt64OrZero(JSONExtractString(t)))",
      );
    const buckets = (key: string) =>
      object({
        offset: `toString(JSONExtractInt(d,${q(key)},'offset'))`,
        bucketCounts: counts(raw("d", key)),
      });
    const histogram = object({
      count: uint64("d", "count"),
      sum: `if(JSONHas(d,'sum'),${number("d", "sum")},'null')`,
      min: `if(JSONHas(d,'min'),${number("d", "min")},'null')`,
      max: `if(JSONHas(d,'max'),${number("d", "max")},'null')`,
      bucketCounts: counts("d"),
      explicitBounds: array(
        "d",
        "explicitBounds",
        `${f("float")}(${f("number")}(t))`,
      ),
    });
    const exponential = object({
      count: uint64("d", "count"),
      sum: `if(JSONHas(d,'sum'),${number("d", "sum")},'null')`,
      min: `if(JSONHas(d,'min'),${number("d", "min")},'null')`,
      max: `if(JSONHas(d,'max'),${number("d", "max")},'null')`,
      scale: "toString(JSONExtractInt(d,'scale'))",
      zeroCount: uint64("d", "zeroCount"),
      zeroThreshold: number("d", "zeroThreshold"),
      positive: buckets("positive"),
      negative: buckets("negative"),
    });
    Object.assign(fields, {
      name: string("m", "name"),
      unit: `${f("quote")}(if(JSONExtractString(m,'unit')='','1',JSONExtractString(m,'unit')))`,
      metricType: `${f("quote")}(if(metric_type='exponentialHistogram','exponential-histogram',metric_type))`,
      temporality: `${f("quote")}(['unspecified','delta','cumulative'][JSONExtractUInt(metric_data,'aggregationTemporality')+1])`,
      monotonic: boolean("metric_data", "isMonotonic"),
      startTime: time(
        `if(${nanos("d", "startTimeUnixNano")}=0,${nanos("d", "timeUnixNano")},${nanos("d", "startTimeUnixNano")})`,
      ),
      endTime: time(nanos("d", "timeUnixNano")),
      value: `multiIf(metric_type='histogram',${histogram},metric_type='exponentialHistogram',${exponential},${numericValue("d")})`,
      dimensions: attributes("d"),
      flags: uint("d", "flags"),
      exemplars: array(
        "d",
        "exemplars",
        object({
          time: time(nanos("t", "timeUnixNano")),
          traceId: string("t", "traceId"),
          spanId: string("t", "spanId"),
          filteredAttributes: attributes("t", "filteredAttributes"),
          value: numericValue("t"),
        }),
      ),
    });
  }
  return fields;
}
