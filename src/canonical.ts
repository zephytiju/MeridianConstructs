// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export type JsonScalar = boolean | number | string | null;
export type JsonValue = JsonScalar | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export function normalizeJson(value: unknown, path = "$"): JsonValue {
  return normalize(value, path, new WeakSet<object>());
}

function normalize(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): JsonValue {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (
      Array.from(value).some((character) => {
        const point = character.codePointAt(0) ?? 0;
        return point >= 0xd800 && point <= 0xdfff;
      })
    ) {
      throw new TypeError(`${path} cannot contain an unpaired surrogate`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must contain only finite JSON numbers`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new TypeError(`${path} cannot contain a JSON cycle`);
    }
    ancestors.add(value);
    const result = value.map((item, index) =>
      normalize(item, `${path}[${index}]`, ancestors),
    );
    ancestors.delete(value);
    return result;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects`);
    }
    if (ancestors.has(value)) {
      throw new TypeError(`${path} cannot contain a JSON cycle`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`${path} must contain only string object keys`);
    }
    ancestors.add(value);
    const source = value as Record<string, unknown>;
    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(source).sort()) {
      normalized[key] = normalize(source[key], `${path}.${key}`, ancestors);
    }
    ancestors.delete(value);
    return normalized;
  }
  throw new TypeError(`${path} must contain only JSON-compatible values`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
