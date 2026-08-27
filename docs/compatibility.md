<!-- SPDX-License-Identifier: Apache-2.0 -->

# Released compatibility matrix

The executable matrix and packaged evidence are checked for drift on every CI run.

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

Profile compatibility pins also capture the required Core, Semantics, Query, Object Common, and
Streaming public package versions. These are contract evidence, not runtime dependencies of
`meridian-storage-iac`. Consumer code therefore does not load Adapter modules or Kafka.

Each profile records a `profileFingerprint` and the released operation-statement fingerprints.
Those values make IaC compatibility drift visible. They are deliberately distinct from a
Binding's `requiredCapabilityFingerprint`, which is the Adapter's authenticated manifest
fingerprint and can depend on the exact Engine settings. Platform/Vangu obtains that value from
the Adapter's released expected-fingerprint helper or an authenticated probe.

The machine-readable source is
[`contracts/compatibility.v1.json`](../contracts/compatibility.v1.json). `npm run contracts:check`
rebuilds the contract from the executable registry and fails on byte drift.
