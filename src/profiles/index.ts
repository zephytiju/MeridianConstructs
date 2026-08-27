// SPDX-License-Identifier: Apache-2.0

import { fingerprint } from "../canonical.js";
import type {
  CatalogName,
  DeploymentMode,
  Topology,
} from "../contracts/index.js";
import { MeridianConstructError, constructErrorCodes } from "../errors.js";

export interface OperationCapabilityV1 {
  readonly contract: string;
  readonly versions: readonly string[];
  readonly guarantees: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
  readonly fingerprint: string;
}

export interface EngineProfileV1 {
  readonly id: string;
  readonly adapterId: string;
  readonly adapterPackage: string;
  readonly adapterVersion: string;
  readonly adapterContract: string;
  readonly engineProfile: string;
  readonly supportedEngineVersions: readonly string[];
  readonly defaultEngineVersion: string;
  readonly catalogs: readonly CatalogName[];
  readonly operations: Readonly<Record<string, OperationCapabilityV1>>;
  readonly allowedTopologies: readonly Topology[];
  readonly defaultTopology: Topology;
  readonly allowedModes: readonly DeploymentMode[];
  readonly managedStorage:
    "required" | "optional" | "provider-managed" | "disposable";
  readonly minimumTlsMode: "disabled" | "server";
  readonly compatibilityPins: Readonly<Record<string, string>>;
  /** Fingerprint of this IaC selection profile, not an Adapter runtime manifest. */
  readonly profileFingerprint: string;
}

export const packagePins: Readonly<Record<string, string>> = Object.freeze({
  "meridian-plugin-observability": "1.0.0",
  "meridian-storage-clickhouse": "1.0.0",
  "meridian-storage-core": "1.0.0",
  "meridian-storage-evidence": "1.0.0",
  "meridian-storage-kafka": "1.0.1",
  "meridian-storage-object-common": "1.0.0",
  "meridian-storage-oci": "1.0.0",
  "meridian-storage-opensearch": "1.0.0",
  "meridian-storage-postgresql": "1.0.0",
  "meridian-storage-query": "1.0.0",
  "meridian-storage-s3": "1.0.0",
  "meridian-storage-semantics": "1.0.0",
  "meridian-storage-streaming": "1.0.0",
  "meridian-storage-valkey": "1.0.0",
});

export const adapterPackages: Readonly<Record<string, string>> = Object.freeze({
  clickhouse: "meridian-storage-clickhouse",
  kafka: "meridian-storage-kafka",
  "oci-distribution": "meridian-storage-oci",
  opensearch: "meridian-storage-opensearch",
  postgresql: "meridian-storage-postgresql",
  s3: "meridian-storage-s3",
  valkey: "meridian-storage-valkey",
});

function capability(
  contract: string,
  guarantees: readonly string[] = [],
  limits: Readonly<Record<string, number>> = {},
): OperationCapabilityV1 {
  const body = {
    contract,
    versions: Object.freeze(["1.0.0"]),
    guarantees: Object.freeze([...guarantees].sort()),
    limits: Object.freeze(
      Object.fromEntries(
        Object.entries(limits).sort(([a], [b]) => a.localeCompare(b)),
      ),
    ),
  };
  return Object.freeze({ ...body, fingerprint: fingerprint(body) });
}

const postgresCommon = [
  "bound-parameters",
  "scope-injected",
  "single-binding",
  "strong-consistency",
] as const;
const postgresMutation = [
  ...postgresCommon,
  "conditional-mutation",
  "read-committed",
] as const;
const postgresOperations: Record<string, OperationCapabilityV1> = {};
for (const method of [
  "aggregate",
  "create_resource",
  "delete",
  "get",
  "patch",
  "publish_schema",
  "put",
  "query",
  "search",
  "traverse",
]) {
  const contract = `meridian.structured.${method}`;
  const guarantees = ["delete", "patch", "put"].includes(method)
    ? postgresMutation
    : ["create_resource", "publish_schema"].includes(method)
      ? [...postgresCommon, "external-migration"]
      : method === "traverse"
        ? [...postgresCommon, "bounded-traversal", "relation-collections"]
        : postgresCommon;
  postgresOperations[contract] = capability(contract, guarantees, {
    maxMembershipNames: 10_000,
    maxPageSize: 500,
    maxRelationResources: 32,
    maxTraversalDepth: 8,
    pageSize: 500,
  });
}
postgresOperations["meridian.evidence.append"] = capability(
  "meridian.evidence.append",
  [
    "append-only",
    "bound-parameters",
    "read-committed",
    "scope-injected",
    "transactional-with-structured",
  ],
  { maxPageSize: 500 },
);
postgresOperations["meridian.evidence.query"] = capability(
  "meridian.evidence.query",
  ["bound-parameters", "scope-injected", "strong-consistency"],
  { maxPageSize: 500 },
);
postgresOperations["meridian.transaction"] = capability(
  "meridian.transaction",
  ["atomic", "no-dirty-reads", "read-committed"],
  { maxOperations: 10_000 },
);
Object.freeze(postgresOperations);

const s3ObjectOperations: Readonly<Record<string, OperationCapabilityV1>> =
  Object.freeze({
    "meridian.object.delete": capability("meridian.object.delete", [
      "object.exact-version-delete",
    ]),
    "meridian.object.get": capability("meridian.object.get", [
      "object.digest-verification",
      "object.streaming",
    ]),
    "meridian.object.list": capability(
      "meridian.object.list",
      ["object.bounded-prefix-list"],
      { "object.max-list-page-size": 1_000 },
    ),
    "meridian.object.put": capability(
      "meridian.object.put",
      [
        "object.conditional-create",
        "object.digest-sha256",
        "object.digest-verification",
        "object.immutability-intent",
        "object.metadata-after-commit",
        "object.multipart",
        "object.retention-intent",
        "object.streaming",
      ],
      {
        "object.max-multipart-part-bytes": 5 * 1024 * 1024 * 1024,
        "object.max-multipart-parts": 10_000,
        "object.max-object-bytes": 5 * 1024 * 1024 * 1024 * 1024,
        "object.max-user-metadata-entries": 128,
      },
    ),
    "meridian.object.read_range": capability(
      "meridian.object.read_range",
      ["object.digest-verification", "object.range-read"],
      { "object.max-range-bytes": 64 * 1024 * 1024 },
    ),
    "meridian.object.stat": capability("meridian.object.stat"),
  });
const s3Operations: Readonly<Record<string, OperationCapabilityV1>> =
  Object.freeze({
    ...s3ObjectOperations,
    "meridian.object.create_resource": capability(
      "meridian.object.create_resource",
    ),
    "meridian.object.publish_schema": capability(
      "meridian.object.publish_schema",
    ),
  });

const ociOperations: Readonly<Record<string, OperationCapabilityV1>> =
  Object.freeze({
    "meridian.object.delete": capability("meridian.object.delete", [
      "object.exact-version-delete",
      "object.retention-intent",
    ]),
    "meridian.object.get": capability(
      "meridian.object.get",
      ["object.digest-verification", "object.streaming"],
      { "object.max-object-bytes": 5 * 1024 * 1024 * 1024 * 1024 },
    ),
    "meridian.object.list": capability(
      "meridian.object.list",
      ["object.bounded-prefix-list"],
      { "object.max-list-page-size": 1_000 },
    ),
    "meridian.object.put": capability(
      "meridian.object.put",
      [
        "object.conditional-create",
        "object.digest-sha256",
        "object.immutability-intent",
        "object.metadata-after-commit",
        "object.multipart",
        "object.retention-intent",
        "object.streaming",
      ],
      {
        "object.max-multipart-part-bytes": 4 * 1024 * 1024,
        "object.max-multipart-parts": 10_000,
        "object.max-object-bytes": 5 * 1024 * 1024 * 1024 * 1024,
        "object.max-user-metadata-entries": 128,
      },
    ),
    "meridian.object.read_range": capability(
      "meridian.object.read_range",
      ["object.digest-verification", "object.range-read"],
      { "object.max-range-bytes": 256 * 1024 * 1024 },
    ),
    "meridian.object.stat": capability("meridian.object.stat", [
      "object.digest-verification",
    ]),
  });

const clickHouseLimits = {
  maxBatchBytes: 16 * 1024 * 1024,
  maxBatchRows: 10_000,
  maxTimeRangeSeconds: 31 * 24 * 60 * 60,
  pageSize: 500,
  retryWindowSeconds: 24 * 60 * 60,
} as const;

const clickHouseOperations: Readonly<Record<string, OperationCapabilityV1>> =
  Object.freeze({
    "meridian.evidence.append": capability(
      "meridian.evidence.append",
      ["eventual-visibility", "retry-window-dedup", "scope-isolation"],
      clickHouseLimits,
    ),
    "meridian.evidence.query": capability(
      "meridian.evidence.query",
      ["bounded-time-range", "scope-isolation", "single-binding"],
      clickHouseLimits,
    ),
    "meridian.structured.aggregate": capability(
      "meridian.structured.aggregate",
      ["bounded-time-range", "scope-isolation", "single-binding"],
      clickHouseLimits,
    ),
    "meridian.structured.get": capability(
      "meridian.structured.get",
      ["eventual-visibility", "scope-isolation", "single-binding"],
      clickHouseLimits,
    ),
    "meridian.structured.put": capability(
      "meridian.structured.put",
      ["eventual-visibility", "retry-window-dedup", "scope-isolation"],
      clickHouseLimits,
    ),
    "meridian.structured.query": capability(
      "meridian.structured.query",
      ["bounded-time-range", "scope-isolation", "single-binding"],
      clickHouseLimits,
    ),
  });

const valkeyOperations: Record<string, OperationCapabilityV1> = {};
for (const method of [
  "get",
  "put",
  "put_if_absent",
  "compare_and_set",
  "delete",
  "invalidate",
]) {
  const contract = `meridian.cache.${method}`;
  const methodGuarantees: Readonly<Record<string, readonly string[]>> = {
    compare_and_set: [
      "atomic-single-key",
      "disposable-cache",
      "scope-isolation",
      "ttl-bounded",
    ],
    delete: ["disposable-cache", "scope-isolation"],
    get: [
      "disposable-cache",
      "miss-on-unavailable",
      "schema-validated",
      "scope-isolation",
      "ttl-bounded",
    ],
    invalidate: ["bounded-exact-keys", "disposable-cache", "scope-isolation"],
    put: ["disposable-cache", "scope-isolation", "ttl-bounded"],
    put_if_absent: [
      "atomic-single-key",
      "disposable-cache",
      "scope-isolation",
      "ttl-bounded",
    ],
  };
  valkeyOperations[contract] = capability(contract, methodGuarantees[method], {
    batchSize: 128,
    keyBytes: 512,
    maximumTtlMs: 86_400_000,
    valueBytes: 4 * 1024 * 1024,
  });
}

const kafkaOperations: Readonly<Record<string, OperationCapabilityV1>> =
  Object.freeze({
    "meridian.streaming.acknowledge": capability(
      "meridian.streaming.acknowledge",
      ["at-least-once", "consumer-groups", "monotonic-safe-position"],
    ),
    "meridian.streaming.create-resource": capability(
      "meridian.streaming.create-resource",
      ["streaming-resource-lifecycle"],
    ),
    "meridian.streaming.group-position": capability(
      "meridian.streaming.group-position",
      [
        "compare-and-set",
        "consumer-groups",
        "explicit-group-position",
        "opaque-cursors",
      ],
    ),
    "meridian.streaming.negative-acknowledge": capability(
      "meridian.streaming.negative-acknowledge",
      ["at-least-once", "consumer-groups", "dead-letter", "redelivery"],
    ),
    "meridian.streaming.poll": capability(
      "meridian.streaming.poll",
      ["at-least-once", "consumer-groups", "per-logical-partition-ordering"],
      { maxPollSize: 10_000, maxWaitTimeoutMs: 300_000 },
    ),
    "meridian.streaming.publish": capability("meridian.streaming.publish", [
      "at-least-once",
      "idempotent-producer",
      "per-logical-partition-ordering",
      "schema-fingerprint",
    ]),
    "meridian.streaming.publish-batch": capability(
      "meridian.streaming.publish-batch",
      [
        "at-least-once",
        "idempotent-producer",
        "per-logical-partition-ordering",
        "schema-fingerprint",
      ],
      { maxBatchSize: 10_000 },
    ),
    "meridian.streaming.publish-schema": capability(
      "meridian.streaming.publish-schema",
      ["streaming-schema-publication"],
    ),
    "meridian.streaming.read-range": capability(
      "meridian.streaming.read-range",
      [
        "finite-retained-range",
        "opaque-cursors",
        "retention-boundary-validation",
      ],
      { maxRangePartitions: 128, maxRangeSize: 10_000 },
    ),
    "meridian.streaming.replay": capability(
      "meridian.streaming.replay",
      [
        "explicit-replay",
        "finite-retained-range",
        "opaque-cursors",
        "retention-boundary-validation",
      ],
      { maxRangePartitions: 128, maxRangeSize: 10_000 },
    ),
    "meridian.streaming.subscribe": capability("meridian.streaming.subscribe", [
      "subscriptions",
    ]),
    "meridian.streaming.transactional-consume-publish": capability(
      "meridian.streaming.transactional-consume-publish",
      [
        "atomic-consumed-offset",
        "atomic-publish",
        "committed-reads",
        "idempotent-producer",
        "single-binding",
      ],
      { maxBatchSize: 10_000 },
    ),
    "meridian.transaction": capability("meridian.transaction", [
      "atomic",
      "no-dirty-reads",
      "single-binding",
    ]),
  });

interface ProfileInput {
  readonly id: string;
  readonly adapterId: string;
  readonly adapterPackage: string;
  readonly adapterVersion: string;
  readonly adapterContract: string;
  readonly supportedEngineVersions: readonly string[];
  readonly defaultEngineVersion: string;
  readonly catalogs: readonly CatalogName[];
  readonly operations: Readonly<Record<string, OperationCapabilityV1>>;
  readonly allowedTopologies: readonly Topology[];
  readonly defaultTopology: Topology;
  readonly managedStorage: EngineProfileV1["managedStorage"];
  readonly minimumTlsMode: EngineProfileV1["minimumTlsMode"];
  readonly allowedModes?: readonly DeploymentMode[];
}

function createProfile(input: ProfileInput): EngineProfileV1 {
  if (!input.supportedEngineVersions.includes(input.defaultEngineVersion)) {
    throw new Error(
      `Profile ${input.id} has an unsupported default Engine version`,
    );
  }
  Object.freeze(valkeyOperations);
  if (!input.allowedTopologies.includes(input.defaultTopology)) {
    throw new Error(`Profile ${input.id} has an unsupported default topology`);
  }
  const compatibilityPins: Record<string, string> = {
    [input.adapterPackage]: input.adapterVersion,
    "meridian-storage-core": "1.0.0",
  };
  if (
    [
      "meridian-storage-clickhouse",
      "meridian-storage-opensearch",
      "meridian-storage-postgresql",
    ].includes(input.adapterPackage)
  ) {
    compatibilityPins["meridian-storage-query"] = "1.0.0";
    compatibilityPins["meridian-storage-semantics"] = "1.0.0";
  } else if (input.adapterPackage === "meridian-storage-valkey") {
    compatibilityPins["meridian-storage-semantics"] = "1.0.0";
  } else if (
    ["meridian-storage-s3", "meridian-storage-oci"].includes(
      input.adapterPackage,
    )
  ) {
    compatibilityPins["meridian-storage-object-common"] = "1.0.0";
  } else if (input.adapterPackage === "meridian-storage-kafka") {
    compatibilityPins["meridian-storage-semantics"] = "1.0.0";
    compatibilityPins["meridian-storage-streaming"] = "1.0.0";
  }
  const body = {
    ...input,
    engineProfile: input.id,
    supportedEngineVersions: Object.freeze([...input.supportedEngineVersions]),
    catalogs: Object.freeze([...input.catalogs]),
    operations: Object.freeze({ ...input.operations }),
    allowedTopologies: Object.freeze([...input.allowedTopologies]),
    allowedModes: Object.freeze([
      ...(input.allowedModes ?? (["managed", "external"] as const)),
    ]),
    compatibilityPins: Object.freeze(
      Object.fromEntries(
        Object.entries(compatibilityPins).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      ),
    ),
  };
  return Object.freeze({ ...body, profileFingerprint: fingerprint(body) });
}

const profileList: readonly EngineProfileV1[] = [
  createProfile({
    id: "postgresql-postgis-local-single-primary",
    adapterId: "postgresql",
    adapterPackage: "meridian-storage-postgresql",
    adapterVersion: "1.0.0",
    adapterContract: "1.0.0",
    supportedEngineVersions: ["16-postgis-3.4", "17-postgis-3.5"],
    defaultEngineVersion: "17-postgis-3.5",
    catalogs: ["structured", "evidence"],
    operations: postgresOperations,
    allowedTopologies: ["single-primary"],
    defaultTopology: "single-primary",
    managedStorage: "required",
    minimumTlsMode: "disabled",
  }),
  createProfile({
    id: "postgresql-postgis-cluster",
    adapterId: "postgresql",
    adapterPackage: "meridian-storage-postgresql",
    adapterVersion: "1.0.0",
    adapterContract: "1.0.0",
    supportedEngineVersions: ["16-postgis-3.4", "17-postgis-3.5"],
    defaultEngineVersion: "17-postgis-3.5",
    catalogs: ["structured", "evidence"],
    operations: postgresOperations,
    allowedTopologies: ["cluster"],
    defaultTopology: "cluster",
    managedStorage: "required",
    minimumTlsMode: "server",
  }),
  createProfile({
    id: "opensearch",
    adapterId: "org.meridian.storage.opensearch",
    adapterPackage: "meridian-storage-opensearch",
    adapterVersion: "1.0.0",
    adapterContract: "1.0.0",
    supportedEngineVersions: [
      "2.17.0",
      "2.18.0",
      "2.19.0",
      "2.19.1",
      "2.19.2",
      "3.0.0",
      "3.1.0",
      "3.2.0",
    ],
    defaultEngineVersion: "2.19.1",
    catalogs: ["structured"],
    operations: {
      "meridian.structured.search": capability(
        "meridian.structured.search",
        [
          "eventual-consistency",
          "logical-record-references",
          "scope-isolation",
          "single-binding",
          "stable-keyset",
        ],
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
      ),
    },
    allowedTopologies: ["single-primary", "cluster"],
    defaultTopology: "single-primary",
    managedStorage: "optional",
    minimumTlsMode: "server",
  }),
  createProfile({
    id: "clickhouse-standalone",
    adapterId: "meridian.storage.clickhouse",
    adapterPackage: "meridian-storage-clickhouse",
    adapterVersion: "1.0.0",
    adapterContract: "1.0.0",
    supportedEngineVersions: ["25.3"],
    defaultEngineVersion: "25.3",
    catalogs: ["structured", "evidence"],
    operations: clickHouseOperations,
    allowedTopologies: ["single-primary"],
    defaultTopology: "single-primary",
    managedStorage: "required",
    minimumTlsMode: "server",
  }),
  createProfile({
    id: "clickhouse-replicated",
    adapterId: "meridian.storage.clickhouse",
    adapterPackage: "meridian-storage-clickhouse",
    adapterVersion: "1.0.0",
    adapterContract: "1.0.0",
    supportedEngineVersions: ["25.3"],
    defaultEngineVersion: "25.3",
    catalogs: ["structured", "evidence"],
    operations: clickHouseOperations,
    allowedTopologies: ["cluster"],
    defaultTopology: "cluster",
    managedStorage: "required",
    minimumTlsMode: "server",
  }),
  createProfile({
    id: "valkey-standalone",
    adapterId: "org.meridian.storage.valkey",
    adapterPackage: "meridian-storage-valkey",
    adapterVersion: "1.0.0",
    adapterContract: "1.0.0",
    supportedEngineVersions: ["8.1.9"],
    defaultEngineVersion: "8.1.9",
    catalogs: ["cache"],
    operations: valkeyOperations,
    allowedTopologies: ["single-primary"],
    defaultTopology: "single-primary",
    managedStorage: "disposable",
    minimumTlsMode: "server",
  }),
  createProfile({
    id: "valkey-sentinel",
    adapterId: "org.meridian.storage.valkey",
    adapterPackage: "meridian-storage-valkey",
    adapterVersion: "1.0.0",
    adapterContract: "1.0.0",
    supportedEngineVersions: ["8.1.9"],
    defaultEngineVersion: "8.1.9",
    catalogs: ["cache"],
    operations: valkeyOperations,
    allowedTopologies: ["cluster"],
    defaultTopology: "cluster",
    managedStorage: "disposable",
    minimumTlsMode: "server",
  }),
  createProfile({
    id: "aws-s3",
    adapterId: "s3",
    adapterPackage: "meridian-storage-s3",
    adapterVersion: "1.0.0",
    adapterContract: "1.0.0",
    supportedEngineVersions: ["2006-03-01"],
    defaultEngineVersion: "2006-03-01",
    catalogs: ["object"],
    operations: s3Operations,
    allowedTopologies: ["provider-managed"],
    defaultTopology: "provider-managed",
    managedStorage: "provider-managed",
    minimumTlsMode: "server",
  }),
  createProfile({
    id: "s3-compatible",
    adapterId: "s3",
    adapterPackage: "meridian-storage-s3",
    adapterVersion: "1.0.0",
    adapterContract: "1.0.0",
    supportedEngineVersions: ["2006-03-01"],
    defaultEngineVersion: "2006-03-01",
    catalogs: ["object"],
    operations: s3Operations,
    allowedTopologies: ["single-primary", "cluster"],
    defaultTopology: "single-primary",
    managedStorage: "required",
    minimumTlsMode: "disabled",
  }),
  createProfile({
    id: "oci-distribution",
    adapterId: "oci-distribution",
    adapterPackage: "meridian-storage-oci",
    adapterVersion: "1.0.0",
    adapterContract: "1.0.0",
    supportedEngineVersions: ["1.1.1"],
    defaultEngineVersion: "1.1.1",
    catalogs: ["object"],
    operations: ociOperations,
    allowedTopologies: ["provider-managed"],
    defaultTopology: "provider-managed",
    managedStorage: "provider-managed",
    minimumTlsMode: "server",
  }),
  createProfile({
    id: "apache-kafka",
    adapterId: "meridian.kafka",
    adapterPackage: "meridian-storage-kafka",
    adapterVersion: "1.0.1",
    adapterContract: "1.0.0",
    supportedEngineVersions: ["4.1.2", "4.2.1", "4.3.1"],
    defaultEngineVersion: "4.3.1",
    catalogs: ["streaming"],
    operations: kafkaOperations,
    allowedTopologies: ["cluster"],
    defaultTopology: "cluster",
    managedStorage: "required",
    minimumTlsMode: "server",
  }),
  createProfile({
    id: "apache-kafka-test",
    adapterId: "meridian.kafka",
    adapterPackage: "meridian-storage-kafka",
    adapterVersion: "1.0.1",
    adapterContract: "1.0.0",
    supportedEngineVersions: ["4.1.2", "4.2.1", "4.3.1"],
    defaultEngineVersion: "4.3.1",
    catalogs: ["streaming"],
    operations: kafkaOperations,
    allowedTopologies: ["test"],
    defaultTopology: "test",
    managedStorage: "optional",
    minimumTlsMode: "disabled",
  }),
];

export const engineProfiles: Readonly<Record<string, EngineProfileV1>> =
  Object.freeze(
    Object.fromEntries(
      profileList
        .map((profile): readonly [string, EngineProfileV1] => [
          profile.id,
          profile,
        ])
        .sort((left, right) => left[0].localeCompare(right[0])),
    ),
  );

export const onePrimaryDefaults: Readonly<
  Partial<Record<CatalogName, string>>
> = Object.freeze({
  structured: "postgresql-postgis-local-single-primary",
  object: "s3-compatible",
  cache: "valkey-standalone",
  evidence: "clickhouse-standalone",
});

export function getEngineProfile(profileId: string): EngineProfileV1 {
  const profile = engineProfiles[profileId];
  if (profile === undefined) {
    throw new MeridianConstructError(
      constructErrorCodes.profileNotFound,
      `Unknown Engine profile ${profileId}`,
    );
  }
  return profile;
}

export function defaultEngineProfiles(
  includeStreaming = false,
): Readonly<Partial<Record<CatalogName, EngineProfileV1>>> {
  const selected: Partial<Record<CatalogName, EngineProfileV1>> = {};
  for (const [catalog, profileId] of Object.entries(onePrimaryDefaults) as [
    CatalogName,
    string,
  ][]) {
    selected[catalog] = getEngineProfile(profileId);
  }
  if (includeStreaming) {
    selected.streaming = getEngineProfile("apache-kafka-test");
  }
  return Object.freeze(selected);
}

export interface CompatibilityContractV1 {
  readonly formatVersion: "meridian-storage-constructs-compatibility.v1";
  readonly distribution: "meridian-storage-constructs";
  readonly node: ">=22";
  readonly designRevisions: Readonly<Record<string, number>>;
  readonly catalogRegistry: readonly CatalogName[];
  readonly consumerRestrictions: Readonly<Record<string, boolean>>;
  readonly packages: Readonly<Record<string, string>>;
  readonly adapterPackages: Readonly<Record<string, string>>;
  readonly profiles: Readonly<
    Record<string, Readonly<Record<string, string | readonly string[]>>>
  >;
}

export function compatibilityContract(): CompatibilityContractV1 {
  return Object.freeze({
    formatVersion: "meridian-storage-constructs-compatibility.v1",
    distribution: "meridian-storage-constructs",
    node: ">=22",
    designRevisions: Object.freeze({
      catalogsAndPublicInterfaces: 70,
      engineAdapters: 24,
      hld: 61,
      kafkaAdapter: 6,
      meridianConstructs: 62,
    }),
    catalogRegistry: [
      "structured",
      "object",
      "cache",
      "evidence",
      "streaming",
    ] as const,
    consumerRestrictions: Object.freeze({
      adapterConcepts: false,
      engineConcepts: false,
      kafkaImports: false,
      nativeQueryV1: false,
    }),
    packages: packagePins,
    adapterPackages,
    profiles: Object.freeze(
      Object.fromEntries(
        Object.entries(engineProfiles).map(([id, profile]) => [
          id,
          Object.freeze({
            adapterId: profile.adapterId,
            adapterPackage: profile.adapterPackage,
            adapterVersion: profile.adapterVersion,
            adapterContract: profile.adapterContract,
            engineProfile: profile.engineProfile,
            engineVersions: profile.supportedEngineVersions,
            defaultEngineVersion: profile.defaultEngineVersion,
            managedStorage: profile.managedStorage,
            minimumTlsMode: profile.minimumTlsMode,
            operationFingerprints: Object.entries(profile.operations)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(
                ([contract, operation]) =>
                  `${contract}=${operation.fingerprint}`,
              ),
            profileFingerprint: profile.profileFingerprint,
          }),
        ]),
      ),
    ),
  });
}

export function compatibilityFingerprint(): string {
  return fingerprint(compatibilityContract());
}
