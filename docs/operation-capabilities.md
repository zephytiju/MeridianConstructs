<!-- SPDX-License-Identifier: Apache-2.0 -->

# Planning with released Operation capabilities

Constructs 1.5.0 aligns the PostgreSQL profile with the public PostgreSQL Adapter
2.3.1 descriptor: `meridian.structured.put` supports `2.0.0` (not `1.0.0`);
Evidence append advertises `atomic-evidence` and `scope-isolation`, Evidence query
advertises `scope-isolation`, and Schema publication advertises `durable-metadata`,
`immutable-schema-version`, and `no-runtime-ddl`. Schema publication does not
advertise `external-migration`. These are existing released contracts; the fix
does not add Adapter behavior.

`BindingSpecV1` and the `binding` arguments to `ManagedEngine` / `ExternalEngine`
accept optional `capabilityManifest`: the complete JSON from the selected public
Adapter's `CapabilityManifest.to_dict()`. Pass its canonical fingerprint as
`requiredCapabilityFingerprint`. Select exact package coordinates separately in
`compatibilityPins`, as in 1.3.0. For example:

```ts
const binding = {
  ...deploymentBinding,
  capabilityManifest: selectedManifest,
  requiredCapabilityFingerprint: selectedManifestFingerprint,
};
```

Planning validates the public Core 1.1.0 manifest schema, canonical hash, Adapter
identity and SPI, profile identity, and the deployment-selected Engine version.
The comparison uses only the manifest's available Operations, exact supported
Operation versions, guarantees and limits. Missing capabilities are never filled
from the default profile. Invalid, duplicate or unadvertised Operations fail
closed. Tested Engine release tables remain historical metadata. The selected
Engine version and fingerprint are still deployment integrity expectations.

The manifest is planning input and is not serialized into `meridian-config.v1`.
The existing runtime manifest pin is serialized unchanged. Core must still
authenticate, probe, compare the actual manifest and physical fingerprints, and
validate placement before readiness. A supplied descriptor is not proof of live
Engine behavior. No endpoint discovery, package selection, provider creation,
fallback, or ownership transfer is introduced.

Omitting `capabilityManifest` uses the bundled profile's documented capability
baseline. Existing Binding shapes and V1 runtime JSON remain supported. Select an explicit
manifest when using a different public release, tuned limits or conditional
features; do not infer capability from a distribution version. An older Adapter's
Operation contract must be selected from that older released manifest rather than
added to a union of unrelated releases. No older serialized expression is
reinterpreted as `put@2.0.0`. Unsupported versions and guarantees remain rejected.

## Family and helper inventory

The immutable inventory fixture is generated from installed public wheels by
`tests/integration/released-capabilities/export_contracts.py`. CI re-exports and
compares it, checks the copied Core manifest schema, and compares every available
Operation, guarantee, limit and negative control against public Core. All allowed
modes and topologies are included; metadata cases do not claim provider support.

| Family and exported profiles                | Selected public artifact | Finding                                                                                                                                                                |
| ------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL local single primary and cluster | PostgreSQL 2.3.1         | Corrected put version, Evidence guarantees and Schema publication guarantees.                                                                                          |
| OpenSearch single and cluster topology      | OpenSearch 1.1.0         | Default operation surface matches; PIT and tuned limits require selected manifest evidence.                                                                            |
| ClickHouse standalone and replicated/Keeper | ClickHouse 1.1.1         | Default surface matches; put remains 1.0.0, and atomic Evidence is unsupported. Tuned limits come from the selected manifest.                                          |
| Valkey standalone and Sentinel              | Valkey 1.1.0             | Default surface matches; TTL and other tuned limits come from the selected manifest.                                                                                   |
| AWS S3 and S3 compatible                    | S3 1.0.4                 | Default surface matches; signed references and retention enforcement remain conditional. The API identifier keeps its protocol meaning.                                |
| OCI Distribution                            | OCI 1.1.0                | Descriptor matches; selected manifest excludes delete when deletion is disabled. Retention and limits remain conditional; the Distribution version remains a protocol. |
| Apache Kafka cluster and test               | Kafka 1.1.0              | Default surface matches; selected manifest availability is authoritative for planning.                                                                                 |

`MeridianDeployment`, rendering, plan diffing and deployment conformance call the
same planner. Managed/external components validate supplied evidence before
provisioner invocation and forward it into their Binding. Provider restrictions,
topology, persistence, TLS, secret references, migration and recovery gates stay
in their existing paths. Migration, cache warm, streaming bootstrap, backup,
restore and validation job builders consume explicit job contracts and do not
select Adapter capabilities. The durable projection helper already consumes
pinned manifests independently; its host repeats validation at startup. Collector
sidecar/gateway validation concerns Collector configuration, not storage Operation
versions. No helper introduces a package-release membership gate.

The regression suite retains the 1.4 Catalog subsets and four independent
fingerprints, all prior TypeScript tests, packed-host lifecycle tests and
PostgreSQL 16/17 metadata tests. The public PostgreSQL 2.3.1 closure adds real
required-Evidence commit/rollback and all packed-host lifecycle regressions on
both versions. Other families are contract inventory and parsing evidence here;
their real Engine conformance belongs to the downstream all-family closure.
