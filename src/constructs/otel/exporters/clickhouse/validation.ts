// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from "../../../../canonical.js";

/** Validate the complete stock OTLP JSON relay before its persistent queue. */
export function envelopeValidation(maxBytes: number): JsonObject {
  const wire = 'log.cache["wire"]';
  const reject = (condition: string) =>
    `set(log.cache["invalid"], ParseJSON("invalid OTLP envelope")) where ${condition}`;
  return {
    error_mode: "propagate",
    log_statements: [
      {
        context: "log",
        statements: [
          reject(`Len(log.body) > ${maxBytes}`),
          `set(${wire}, ParseJSON(log.body))`,
          reject(`Len(${wire}) != 1`),
          reject(
            `${wire}["resourceLogs"] == nil and ${wire}["resourceSpans"] == nil and ${wire}["resourceMetrics"] == nil`,
          ),
          ...recordValidation(wire, reject),
          `flatten(${wire}, depth=48)`,
          reject(`Len(${wire}) == 0 or Len(${wire}) > 10000`),
          reject(invalidFields(wire)),
          // Detect repeated KeyValue keys at every nesting level in linear
          // passes. Distinct parent paths remain distinct; the original Body
          // and its typed values are never changed by this validation copy.
          `set(log.cache["key_identity"], MapKeys(${wire}, (k, v) => When(() => IsMatch(k, "[.]key$"), Concat([k, "=", String(v)], ""), k)))`,
          `replace_all_patterns(log.cache["key_identity"], "key", "^(.+?)[.][0-9]+[.]key=", "$1.__key__=")`,
          reject(`Len(log.cache["key_identity"]) != Len(${wire})`),
        ],
      },
    ],
  };
}

function invalidFields(value: string): string {
  // ParseJSON is used only for validation. The untouched Body carries the
  // original protobuf JSON integer strings and floating point wire values.
  const checks = [
    `(IsMatch(k, "[.]key$") and (not IsString(v) or Len(v) == 0 or Len(v) > 128 or IsMatch(v, "[[:cntrl:]]") or IsMatch(v, "^(_meridian_|meridian[.]scope[.]|meridian[.]tenant$|meridian[.]ingestion)")))`,
    `IsMatch(k, "[.](attributes|filteredAttributes)[.](12[89]|1[3-9][0-9]|[2-9][0-9]{2}|[1-9][0-9]{3,})[.]")`,
    `(IsMatch(k, "[.]((doubleValue|asDouble|min|max|sum|zeroThreshold)$|explicitBounds[.][0-9]+$)") and not IsInt(v) and not IsDouble(v))`,
    `IsMatch(k, "[.]summary[.]")`,
    `(IsMatch(k, "[.]unit$") and Len(v) > 256)`,
    `(IsMatch(k, "[.]severityText$") and Len(v) > 32)`,
    `(IsMatch(k, "[.]kind$") and (v < 0 or v > 5))`,
    `(IsMatch(k, "[.](code|aggregationTemporality)$") and (v < 0 or v > 2))`,
    `(IsMatch(k, "[.](traceId|spanId|parentSpanId)$") and (not IsString(v) or not IsMatch(v, "^[0-9a-f]+$")))`,
    `(IsMatch(k, "[.](startTimeUnixNano|timeUnixNano|observedTimeUnixNano|endTimeUnixNano)$") and (not IsString(v) or not IsMatch(v, "^[0-9]{1,19}$") or Int(v) < 0))`,
    `IsMatch(k, "(.*[.](arrayValue|kvlistValue)[.]){13}")`,
    `(IsMap(v) or IsList(v))`,
  ];
  return `Any(${value}, (k, v) => ${checks.join(" or ")})`;
}

function recordValidation(
  wire: string,
  reject: (condition: string) => string,
): string[] {
  const timeMissing = (key: string) =>
    `(d["${key}"] == nil or d["${key}"] == "0")`;
  const invalidId = (key: string, length: number) =>
    `(d["${key}"] == nil or not IsMatch(d["${key}"], "^[0-9a-f]{${length}}$") or IsMatch(d["${key}"], "^0+$"))`;
  const statements: string[] = [];
  for (const [root, scopes, records, invalid] of [
    [
      "resourceLogs",
      "scopeLogs",
      "logRecords",
      `${timeMissing("timeUnixNano")} and ${timeMissing("observedTimeUnixNano")}`,
    ],
    [
      "resourceSpans",
      "scopeSpans",
      "spans",
      `d["name"] == nil or Len(d["name"]) == 0 or Len(d["name"]) > 256 or ${invalidId("traceId", 32)} or ${invalidId("spanId", 16)} or ${timeMissing("startTimeUnixNano")} or ${timeMissing("endTimeUnixNano")} or Int(d["endTimeUnixNano"]) < Int(d["startTimeUnixNano"])`,
    ],
  ]) {
    statements.push(
      reject(
        `Any(${wire}["${root}"], (_, r) => r["${scopes}"] == nil or Any(r["${scopes}"], (_, s) => s["${records}"] == nil or Len(s["${records}"]) == 0 or Any(s["${records}"], (_, d) => ${invalid})))`,
      ).replace(" where ", ` where ${wire}["${root}"] != nil and `),
    );
  }
  const metrics = `${wire}["resourceMetrics"]`;
  statements.push(
    reject(
      `Any(${metrics}, (_, r) => r["scopeMetrics"] == nil or Any(r["scopeMetrics"], (_, s) => s["metrics"] == nil or Len(s["metrics"]) == 0 or Any(s["metrics"], (_, m) => m["name"] == nil or Len(m["name"]) == 0 or Len(m["name"]) > 256 or m["summary"] != nil or (m["gauge"] == nil and m["sum"] == nil and m["histogram"] == nil and m["exponentialHistogram"] == nil))))`,
    ).replace(" where ", ` where ${metrics} != nil and `),
  );
  for (const type of ["gauge", "sum", "histogram", "exponentialHistogram"]) {
    const numberMissing = ["gauge", "sum"].includes(type)
      ? ` or (d["asInt"] == nil and d["asDouble"] == nil)`
      : "";
    statements.push(
      reject(
        `Any(${metrics}, (_, r) => Any(r["scopeMetrics"], (_, s) => Any(s["metrics"], (_, m) => m["${type}"] != nil and (m["${type}"]["dataPoints"] == nil or Len(m["${type}"]["dataPoints"]) == 0 or Any(m["${type}"]["dataPoints"], (_, d) => ${timeMissing("timeUnixNano")}${numberMissing})))))`,
      ).replace(" where ", ` where ${metrics} != nil and `),
    );
  }
  // OTTL local lambda identifiers raise on a missing map key. Unlike pdata
  // paths, comparing such an index to nil is not a presence test.
  return statements.map((statement) =>
    statement.replace(
      /([rsdm](?:\["[^"]+"\])?)\["([^"]+)"\] (==|!=) nil/g,
      (_match: string, object: string, key: string, comparison: string) =>
        `${comparison === "==" ? "not " : ""}ContainsValue(Keys(${object}), "${key}")`,
    ),
  );
}
