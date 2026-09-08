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

## Configured limits in 1.5.1

Constructs 1.5.0's optional manifest path handles selected limits, but the legacy
input path still compared default limits when `connection.settings` selected a
smaller bound. The expanded independent audit found 96 ClickHouse false accepts
(one above four configured limits across six Operations and four profile/mode
combinations). The published 1.5.0 artifact remains immutable.

Version 1.5.1 reads the released configuration-to-capability mappings for ClickHouse
batch rows/bytes, time range and retry window; OpenSearch `limits`; Valkey `limits`
and maximum TTL; S3 object/range bytes; and OCI part/object/range bytes, list page
size and multipart part count. It validates the known setting bounds and compares
requirements with the selected values, including valid increases over historical
profile defaults. When a complete manifest is supplied, the effective limit cannot
exceed either the configured value or the advertised limit; missing advertised
limits stay missing. Settings, package locks, manifest and physical fingerprint
pins are serialized unchanged. PostgreSQL and Kafka Operation limits are fixed in
the inspected public descriptors. This does not add an Engine probe or interpret
unrelated provider settings. Conditional features still require explicit selected
manifest evidence.

Resource and Operation minimum limits are both enforced. If both scopes specify
the same key, a lower minimum in one scope cannot weaken the other requirement.

Public-artifact parity tests vary every configurable limit represented above and
check at-limit acceptance and one-above rejection, with and without a supplied
manifest. They classify this as configuration/contract metadata, not Engine
behavior. The separate independent expanded audit covers 2,454 cases and 978
negative controls; its published 1.4.0 results identified 72 PostgreSQL rejections
and 96 ClickHouse false accepts. Both groups must be zero on the final public
release before this task is complete.
