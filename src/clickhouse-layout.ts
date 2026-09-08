// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { normalizeJson, type JsonObject, type JsonValue } from "./canonical.js";
import {
  assertFingerprint,
  resourceSelectorKey,
  type ResourceSelectorV1,
} from "./contracts/index.js";

/** Public layout identities use UTF-8 key ordering and exact integer values. */
export function publicCanonicalJson(value: unknown): string {
  const encode = (v: JsonValue): string => {
    if (Array.isArray(v)) return `[${v.map(encode).join(",")}]`;
    if (v !== null && typeof v === "object")
      return `{${Object.keys(v)
        .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
        .map((k) => `${JSON.stringify(k)}:${encode((v as JsonObject)[k]!)}`)
        .join(",")}}`;
    if (typeof v === "number" && !Number.isSafeInteger(v))
      throw new TypeError(
        "Public layout identities require exact safe integers",
      );
    return JSON.stringify(v);
  };
  return encode(normalizeJson(value));
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Public layout requires an object");
  return value as Record<string, unknown>;
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError("Public layout requires nonempty strings");
}
function identifier(value: unknown): void {
  text(value);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value))
    throw new TypeError("Invalid public physical identifier");
}
function strings(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== "string" || !v) ||
    new Set(value).size !== value.length
  )
    throw new TypeError(
      "Public layout requires unique nonempty string entries",
    );
  return value as string[];
}
function keys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  if (
    Object.keys(value).some(
      (k) => !required.includes(k) && !optional.includes(k),
    ) ||
    required.some((k) => !(k in value))
  )
    throw new TypeError("Public ResourceLayout has unknown or missing fields");
}
function columnType(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (
    [
      "Bool",
      "Date32",
      "DateTime64(9, 'UTC')",
      "Float64",
      "Int8",
      "Int16",
      "Int32",
      "Int64",
      "String",
      "Tuple(Float64, Float64)",
      "UUID",
      "LowCardinality(String)",
    ].includes(value)
  )
    return true;
  const decimal = /^Decimal\(([1-9][0-9]?), ([0-9]{1,2})\)$/.exec(value);
  if (decimal)
    return Number(decimal[1]) <= 76 && Number(decimal[2]) <= Number(decimal[1]);
  const wrapper = /^(Array|Nullable)\((.*)\)$/.exec(value);
  return wrapper !== null && columnType(wrapper[2]);
}

/** Validate the actual closed public document before deriving any guarantee. */
export function publicClickHouseLayout(input: unknown): JsonObject {
  const value = object(normalizeJson(input));
  keys(
    value,
    [
      "resource",
      "table",
      "recordProfile",
      "schemaVersion",
      "resourceFingerprint",
      "schemaFingerprint",
      "columns",
      "timestampField",
      "identityFields",
      "dimensionFields",
      "measurementFields",
      "retentionSeconds",
      "partitionInterval",
      "topology",
      "queryFinal",
      "administrativeProfiles",
      "indexes",
      "layoutFingerprint",
    ],
    ["appendOnly"],
  );
  if ("appendOnly" in value && value.appendOnly !== true)
    throw new TypeError(
      "Public appendOnly must be true when present; omit it for legacy layouts",
    );
  const resource = object(value.resource);
  keys(resource, ["catalog", "namespace", "name"]);
  resourceSelectorKey(resource as unknown as ResourceSelectorV1);
  if (
    !["evidence", "structured"].includes(resource.catalog as string) ||
    (value.appendOnly === true && resource.catalog !== "evidence")
  )
    throw new TypeError("Public appendOnly requires Evidence");
  identifier(value.table);
  text(value.schemaVersion);
  if (
    ![
      "log",
      "span",
      "metric",
      "usage",
      "cost",
      "time-series",
      "analytical",
    ].includes(value.recordProfile as string)
  )
    throw new TypeError("Invalid public record profile");
  if (
    !["clickhouse-standalone", "clickhouse-replicated"].includes(
      value.topology as string,
    ) ||
    typeof value.queryFinal !== "boolean"
  )
    throw new TypeError("Invalid public topology or queryFinal");
  if (
    !["hour", "day", "month"].includes(value.partitionInterval as string) ||
    (value.retentionSeconds !== null &&
      (typeof value.retentionSeconds !== "number" ||
        !Number.isSafeInteger(value.retentionSeconds) ||
        value.retentionSeconds <= 0))
  )
    throw new TypeError("Invalid public partition or retention");
  for (const key of [
    "resourceFingerprint",
    "schemaFingerprint",
    "layoutFingerprint",
  ])
    assertFingerprint(value[key] as string, key);
  if (!Array.isArray(value.columns) || value.columns.length === 0)
    throw new TypeError("Public columns must be nonempty");
  const names: string[] = [],
    physical: string[] = [];
  for (const raw of value.columns) {
    const c = object(raw);
    keys(c, [
      "logicalName",
      "physicalName",
      "logicalType",
      "clickhouseType",
      "nullable",
      "many",
    ]);
    text(c.logicalName);
    identifier(c.physicalName);
    if (
      c.logicalName.startsWith("_meridian_") ||
      typeof c.nullable !== "boolean" ||
      typeof c.many !== "boolean" ||
      !columnType(c.clickhouseType)
    )
      throw new TypeError("Malformed public ColumnLayout");
    names.push(c.logicalName);
    physical.push(c.physicalName as string);
  }
  strings(names);
  strings(physical);
  if (
    publicCanonicalJson(names) !==
    publicCanonicalJson(
      [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
    )
  )
    throw new TypeError("Public columns must use canonical order");
  const roles = [
    value.timestampField,
    ...strings(value.identityFields),
    ...strings(value.dimensionFields),
    ...strings(value.measurementFields),
  ];
  if (
    (value.identityFields as string[]).length === 0 ||
    roles.some((r) => !names.includes(r as string)) ||
    new Set(roles).size !== roles.length
  )
    throw new TypeError(
      "Public layout roles must be disjoint registered fields",
    );
  const administrative = strings(value.administrativeProfiles);
  if (
    publicCanonicalJson(administrative) !==
    publicCanonicalJson(
      [...administrative].sort((a, b) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b)),
      ),
    )
  )
    throw new TypeError(
      "Public administrative profiles must use canonical order",
    );
  for (const [name, fields] of Object.entries(object(value.indexes))) {
    identifier(name);
    const selected = strings(fields);
    if (!selected.length || selected.some((f) => !names.includes(f)))
      throw new TypeError("Invalid public index fields");
  }
  const { layoutFingerprint, ...content } = value;
  if (
    `sha256:${createHash("sha256").update(publicCanonicalJson(content)).digest("hex")}` !==
    layoutFingerprint
  )
    throw new TypeError("Public layout fingerprint does not match its content");
  return value as JsonObject;
}
