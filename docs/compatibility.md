<!-- SPDX-License-Identifier: Apache-2.0 -->

# Historical release recipes and required contracts

These historical recipes are reproducibility metadata, never release allowlists.
Deployments choose and hash-lock exact distributions and Engine images independently.
Previously unlisted selections pass metadata validation; they remain unverified until
real Engine acceptance. Protocol, feature, provider and integrity gates still apply.

| Engine profile                                    | Adapter distribution pin            | Adapter ID                        | Engine versions                    | Default          |
| ------------------------------------------------- | ----------------------------------- | --------------------------------- | ---------------------------------- | ---------------- |
| `postgresql-postgis-local-single-primary`         | `meridian-storage-postgresql@1.0.0` | `postgresql`                      | `16-postgis-3.4`, `17-postgis-3.5` | `17-postgis-3.5` |
| `postgresql-postgis-cluster`                      | `meridian-storage-postgresql@1.0.0` | `postgresql`                      | `16-postgis-3.4`, `17-postgis-3.5` | `17-postgis-3.5` |
| `opensearch`                                      | `meridian-storage-opensearch@1.0.0` | `org.meridian.storage.opensearch` | released 2.x/3.x matrix            | `2.19.1`         |
| `clickhouse-standalone` / `clickhouse-replicated` | `meridian-storage-clickhouse@1.0.0` | `meridian.storage.clickhouse`     | `25.3`                             | `25.3`           |
| `valkey-standalone` / `valkey-sentinel`           | `meridian-storage-valkey@1.0.0`     | `org.meridian.storage.valkey`     | `8.1.9`                            | `8.1.9`          |
| `aws-s3` / `s3-compatible`                        | `meridian-storage-s3@1.0.0`         | `s3`                              | `2006-03-01`                       | `2006-03-01`     |
| `oci-distribution`                                | `meridian-storage-oci@1.0.0`        | `oci-distribution`                | `1.1.1`                            | `1.1.1`          |
| `apache-kafka` / `apache-kafka-test`              | `meridian-storage-kafka@1.0.1`      | `meridian.kafka`                  | `4.1.2`, `4.2.1`, `4.3.1`          | `4.3.1`          |

Profile `compatibilityPins` and `adapterVersion` record the old example recipe.
Their package names describe required dependencies; their release values are not predicates.
The caller supplies the complete `BindingSpecV1.compatibilityPins` deployment lock.
Coordinates are validated and rendered into `org.meridian.constructs/package-lock.v1`;
`runtimeCompatibilityPins` carries genuine Core contract/manifest expectations separately.
These records are not runtime dependencies of
`@zephytiju/meridian-storage-constructs`. Consumer code therefore does not load Adapter modules or
Kafka.

Each profile records a `profileFingerprint` and the released operation-statement fingerprints.
Those values make IaC compatibility drift visible. They are deliberately distinct from a
Binding's `requiredCapabilityFingerprint`, which is the Adapter's authenticated manifest
fingerprint and can depend on the exact Engine settings. Platform/Vangu obtains that value from
the Adapter's released expected-fingerprint helper or an authenticated probe.

The machine-readable source is
[`contracts/compatibility.v2.json`](../contracts/compatibility.v2.json). `npm run contracts:check`
rebuilds the contract from the executable registry and fails on byte drift.

The V1 artifact remains packaged unchanged as a historical document. V2 explicitly
uses `examplePackages`, `testedEngineVersions` and `engineVersionMeaning`.
S3 `2006-03-01` and OCI `1.1.1` remain protocol identifiers in legacy profile fields;
observed server software must be recorded separately by the authenticated harness.
See [gate inventory and release acceptance](release-validation.md).
