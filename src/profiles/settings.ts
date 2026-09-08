// SPDX-License-Identifier: Apache-2.0
import { fingerprint, type JsonObject } from "../canonical.js";
import { MeridianConstructError, constructErrorCodes } from "../errors.js";
import type { EngineProfileV1 } from "./index.js";

// Released Adapter configuration-to-capability mappings, independently verified
// against public artifact parsers in integration tests. These are contract bounds,
// not package/Engine release allowlists. Unmapped settings remain Adapter-owned.
type LimitSetting = readonly [
  path: string,
  limit: string,
  minimum: number,
  maximum: number,
];
const maps: Readonly<Record<string, readonly LimitSetting[]>> = {
  "meridian.storage.clickhouse": [
    ["maxBatchRows", "maxBatchRows", 1, 1_000_000],
    ["maxBatchBytes", "maxBatchBytes", 1, 2_147_483_647],
    ["maxTimeRangeSeconds", "maxTimeRangeSeconds", 1, 366 * 86400],
    ["retryWindowSeconds", "retryWindowSeconds", 1, 7 * 86400],
  ],
  "org.meridian.storage.opensearch": [
    ["limits.maxPageSize", "pageSize", 1, 500],
    ["limits.maxQueryBytes", "queryBytes", 1, 1_048_576],
    ["limits.maxFacets", "facets", 0, 100],
    ["limits.maxHighlights", "highlights", 0, 100],
    ["limits.maxFilterClauses", "filterClauses", 1, 1024],
    ["limits.maxBulkActions", "bulkActions", 1, 10_000],
    ["limits.maxBulkBytes", "bulkBytes", 1024, 100 * 1024 * 1024],
    ["limits.facetBucketLimit", "facetBuckets", 1, 10_000],
    ["limits.highlightFragmentLimit", "highlightFragments", 1, 100],
  ],
  "org.meridian.storage.valkey": [
    ["limits.maxKeyBytes", "keyBytes", 96, 4096],
    ["limits.maxValueBytes", "valueBytes", 1, 64 * 1024 * 1024],
    ["limits.maxBatchSize", "batchSize", 1, 10_000],
    ["ttl.maximumTtlMs", "maximumTtlMs", 1, 2_147_483_647],
  ],
  s3: [
    ["maxObjectBytes", "object.max-object-bytes", 1, 5 * 1024 ** 4],
    ["maxRangeBytes", "object.max-range-bytes", 1, 5 * 1024 ** 4],
  ],
  "oci-distribution": [
    [
      "chunkSize",
      "object.max-multipart-part-bytes",
      64 * 1024,
      16 * 1024 * 1024,
    ],
    ["maxObjectBytes", "object.max-object-bytes", 1, Number.MAX_SAFE_INTEGER],
    ["maxRangeBytes", "object.max-range-bytes", 1, Number.MAX_SAFE_INTEGER],
    ["maxListPageSize", "object.max-list-page-size", 1, 1000],
    ["maxMultipartParts", "object.max-multipart-parts", 1, 100_000],
  ],
};

export function configuredCapabilityProfile(
  profile: EngineProfileV1,
  settings: JsonObject,
  hasManifest: boolean,
): EngineProfileV1 {
  const selected: Record<string, number> = {};
  for (const [path, limit, minimum, maximum] of maps[profile.adapterId] ?? []) {
    let value: unknown = settings;
    for (const key of path.split(".")) {
      if (value === undefined) break;
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new MeridianConstructError(
          constructErrorCodes.invalidInput,
          `Profile ${profile.id} settings.${path} has an invalid container`,
        );
      }
      value = (value as Record<string, unknown>)[key];
    }
    if (value === undefined) continue;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < minimum ||
      value > maximum
    ) {
      throw new MeridianConstructError(
        constructErrorCodes.invalidInput,
        `Profile ${profile.id} settings.${path} is outside the released configuration contract`,
      );
    }
    selected[limit] = value;
  }
  if (Object.keys(selected).length === 0) return profile;
  const operations = Object.fromEntries(
    Object.entries(profile.operations).map(([name, operation]) => {
      const limits = { ...operation.limits };
      for (const [limit, value] of Object.entries(selected)) {
        if (Object.hasOwn(limits, limit)) {
          // Explicit evidence may narrow a configured bound. It cannot acquire a
          // missing limit or advertise more than the selected configuration allows.
          limits[limit] = hasManifest ? Math.min(limits[limit]!, value) : value;
        }
      }
      const body = {
        contract: operation.contract,
        versions: operation.versions,
        guarantees: operation.guarantees,
        limits: Object.freeze(limits),
      };
      return [name, Object.freeze({ ...body, fingerprint: fingerprint(body) })];
    }),
  );
  const { profileFingerprint: previous, ...selection } = profile;
  void previous;
  const body = { ...selection, operations: Object.freeze(operations) };
  return Object.freeze({ ...body, profileFingerprint: fingerprint(body) });
}
