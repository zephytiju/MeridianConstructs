<!-- SPDX-License-Identifier: Apache-2.0 -->

# Conformance and evidence

`runDeploymentConformance` plans repeatedly, compares byte-identical canonical JSON, and validates
the result against the released closed `meridian-config.v1` JSON Schema.

`runLocalClusterConformance` is provider-neutral. A Docker, Kubernetes, or equivalent local
fixture implements `LocalClusterHarnessV1` and returns authenticated probe evidence. The harness
fails closed unless it observes:

- the exact released Adapter, Engine profile, and pinned Engine version;
- exactly one primary where the Engine defines a primary role, and every declared topology role
  healthy;
- every released operation contract; and
- every acceptance stage from fresh/no-change apply through failover, recovery, runtime startup,
  and semantic conformance.

The shipped harness matrix contains PostgreSQL single/cluster, OpenSearch single/cluster, ClickHouse
single/replicated, Valkey standalone/Sentinel, S3-compatible, OCI Distribution, and Kafka
test/cluster profiles. The library provisions none of those products itself; concrete fixtures use
the same caller-supplied provider and provisioner boundaries as production. Unit contract tests
also lock the guarantees and default limits from every released Adapter descriptor; the Adapter
repositories remain authoritative for their engine-backed cluster evidence.

`conformanceEvidence` emits the deployment fingerprint, compatibility fingerprint, repeat count,
local profile IDs, and an evidence fingerprint. CI also records JUnit results, Cobertura/LCOV
coverage, the npm tarball, its SHA-256 checksum, and package-content verification.

Run the local acceptance gate with:

```bash
npm ci --ignore-scripts
npm run check
```
