<!-- SPDX-License-Identifier: Apache-2.0 -->

# Released compatibility matrix

The executable matrix and packaged evidence are checked for drift on every test run.

| Engine profile | Adapter distribution | Adapter | Engine versions | Default |
| --- | --- | --- | --- | --- |
| `postgresql-postgis-local-single-primary` | `meridian-storage-postgresql==1.0.0` | `postgresql` | `16-postgis-3.4`, `17-postgis-3.5` | `17-postgis-3.5` |
| `postgresql-postgis-cluster` | `meridian-storage-postgresql==1.0.0` | `postgresql` | `16-postgis-3.4`, `17-postgis-3.5` | `17-postgis-3.5` |
| `opensearch` | `meridian-storage-opensearch==1.0.0` | `org.meridian.storage.opensearch` | `2.17.0` through `3.2.0` as released | `2.19.1` |
| `clickhouse-standalone` / `clickhouse-replicated` | `meridian-storage-clickhouse==1.0.0` | `meridian.storage.clickhouse` | `25.3` | `25.3` |
| `valkey-standalone` / `valkey-sentinel` | `meridian-storage-valkey==1.0.0` | `org.meridian.storage.valkey` | `8.1.9` | `8.1.9` |
| `aws-s3` / `s3-compatible` | `meridian-storage-s3==1.0.0` | `s3` | `2006-03-01` | `2006-03-01` |
| `oci-distribution` | `meridian-storage-oci==1.0.0` | `oci-distribution` | `1.1.1` | `1.1.1` |
| `apache-kafka` / `apache-kafka-test` | `meridian-storage-kafka==1.0.1` | `meridian.kafka` | `4.1.2`, `4.2.1`, `4.3.1` | `4.3.1` |

The `conformance` extra additionally pins Core, Semantics, Query, Evidence, Object Common,
Streaming, and the Observability plugin to `1.0.0`. It is never installed by the base package.

`meridian-constructs-compatibility --verify-installed` reads distribution versions and public
entry-point metadata. It deliberately does not load Adapter modules, which keeps the Kafka
implementation outside consumer imports.

The machine-readable source is
[`src/meridian_constructs/contracts/compatibility.v1.json`](../src/meridian_constructs/contracts/compatibility.v1.json).
