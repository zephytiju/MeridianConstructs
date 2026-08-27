<!-- SPDX-License-Identifier: Apache-2.0 -->

# Conformance and evidence

`run_deployment_conformance` executes repeated planning, compares byte-identical canonical JSON,
checks the packaged compatibility contract, and validates the result against the released closed
`meridian-config.v1` JSON Schema.

`run_local_cluster_conformance` is provider neutral. A fixture implements `LocalClusterHarness`
for Docker, Kubernetes, or another local cluster-equivalent environment and returns an
authenticated `ProbeResult`. The harness verifies:

- the exact released Adapter and Engine profile/version;
- exactly one primary for single and replicated topologies;
- all declared roles are healthy;
- the complete released operation surface is present.

The shipped matrix includes PostgreSQL single/cluster, OpenSearch single/cluster, ClickHouse
single/replicated, Valkey standalone/Sentinel, S3-compatible, OCI Distribution, and Kafka
test/cluster profiles. The package provisions none of those products itself; the local fixture
uses the same explicit provider boundary as production.

`conformance_evidence` returns a deterministic document containing the deployment fingerprint,
compatibility fingerprint, preview repeat count, local profile IDs, and its own evidence
fingerprint. CI logs this evidence and validates generated artifacts.
