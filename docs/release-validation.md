<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deployment release selection and validation

Constructs 1.3.0 accepts deployment-selected exact distribution coordinates and
Engine releases independently. Historical tables are conformance metadata, not
acceptance allowlists. Passing metadata validation does not establish behavioral
compatibility. The calling stack owns providers, package resolution, hash locks,
image digests, secrets, migrations and lifecycle actions.

## Exhaustive exported family inventory

The registry currently exports 12 profiles and 28 allowed mode/topology combinations.
Both generic planning and Pulumi component integration exercise every combination
with independent package selections and previously unlisted Engine releases.

| Profile                                 | Modes retained    | Topologies retained     | Version classification             |
| --------------------------------------- | ----------------- | ----------------------- | ---------------------------------- |
| PostgreSQL/PostGIS local single-primary | managed, external | single-primary          | Selected server release            |
| PostgreSQL/PostGIS cluster              | managed, external | cluster                 | Selected server release            |
| OpenSearch                              | managed, external | single-primary, cluster | Selected server release            |
| ClickHouse standalone                   | managed, external | single-primary          | Selected server release            |
| ClickHouse replicated                   | managed, external | cluster with Keeper     | Selected server release            |
| Valkey standalone                       | managed, external | single-primary          | Selected server release            |
| Valkey Sentinel                         | managed, external | cluster                 | Selected server release            |
| AWS S3                                  | managed, external | provider-managed        | Legacy API identifier `2006-03-01` |
| S3-compatible                           | managed, external | single-primary, cluster | Legacy API identifier `2006-03-01` |
| OCI Distribution                        | managed, external | provider-managed        | Legacy specification `1.1.1`       |
| Apache Kafka                            | managed, external | cluster                 | Selected server release            |
| Apache Kafka test                       | managed, external | test                    | Selected server release            |

Managed support means delegation to the caller's explicit provider/provisioner;
it is not a built-in provider, an external-resource adoption path or a new provider
support claim. Provider restrictions and the registry's allowed modes/topologies
remain enforced. S3/OCI server implementation observations must be recorded
separately and must never be synthesized from their legacy protocol fields.

## Gate inventory by family-independent entry point

| Entry point                                                                                                         | Classification and retained checks                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Profile `supportedEngineVersions`, `adapterVersion`, `compatibilityPins`, `packagePins` and `projectionPackagePins` | Historical metadata/example recipes. No value membership predicate selects a deployment release. Profile identities, Catalogs, Adapter SPI/Operation versions, guarantees, limits and topology stay closed.                                                                                      |
| `ManagedEngine`, `ExternalEngine`, `EngineBinding`                                                                  | Exact selected Engine text and complete selected package coordinates; required providers, supported modes/topologies, storage, identity, ACL, TLS, network/recovery inputs. No global provider or implicit fallback.                                                                             |
| `MeridianDeployment`, `planDeployment`, renderer and `diffPlans`                                                    | Exact locks; required contracts/features; unique Resource/Binding/placement, Schema and physical/capability fingerprints, TLS, secrets and recovery. Release changes alter the selected document and explicit deployment diff, not semantic compatibility.                                       |
| `runDeploymentConformance`, `runLocalClusterConformance`, `conformanceEvidence`                                     | Same metadata/contract distinction; authenticated harness owns observations. Profile/Adapter identity, topology health, one writable primary where required, Operation availability and every lifecycle stage remain required. A synthetic harness proves its validation logic only.             |
| Migration, projection, cache-warm, streaming-bootstrap, backup, restore, validation and `MeridianLifecycleJob`      | Independently selected digest-pinned image; existing explicit operation contracts, unique Resources, required dependencies/references, finite attempts/timeouts and caller provider. No helper has a library/server release gate.                                                                |
| `durableProjectionJob` and packaged `worker.py`                                                                     | Complete deployment package map; exact installed versions compared to that map; required host APIs and worker contract 1.0.0/1.1.0. Source/outbox/required Evidence placement, atomic guarantees, physical Schema, exact acknowledgements, claims, budgets and startup drift remain fail-closed. |
| Packaged `supervisor.py`, `versioned_target.py`, example requirements                                               | Caller-owned host/image/closure. Preserve stop signalling, graceful drain, hard deadline and process termination, expiry recovery, version-addressed target identity, latest reads and tombstones. Requirements are a replaceable reproducible example.                                          |
| `MeridianOtelCollector`, sidecar/gateway spec and telemetry helpers                                                 | Independent image digest; required OTLP receiver/pipelines, TLS, signal/port/replica constraints, credential references and provider. Collector configuration features remain checked; a new Collector image is not automatically verified.                                                      |
| Build/release scripts, npm pack, install reports, image inspection                                                  | Artifact identity/integrity and provenance. Exact build version/tag/merge ancestry and all required CI remain enforced. No local publication or changed bytes under an existing version.                                                                                                         |

## Serialization and migration

The generated compatibility document is explicitly V2, with `examplePackages`,
`testedEngineVersions` and `engineVersionMeaning`. The historical V1 file remains
packaged unchanged. Profile fingerprints and generic V1 hashing are preserved.

`BindingSpecV1.compatibilityPins` is the complete deployment distribution lock;
the renderer now places it in the versioned, namespaced
`org.meridian.constructs/package-lock.v1` extension. Core's existing closed
Binding `compatibilityPins` has contract/manifest semantics, so the additive
`runtimeCompatibilityPins` input supplies those expectations separately. Inserting
distribution names into Core's contract map would fail startup. No Core config
field or shared parser is added. Callers must explicitly supply all required
distribution coordinates instead of inheriting a compiled recipe. Re-render and
review the deployment diff when migrating to this release.

The Core 1.1.0 golden fixture is extracted byte-for-byte from its public wheel;
`tests/fixtures/core-1.1.0/artifact.json` records wheel and fixture SHA-256. All
four manifest/descriptor hashes (legacy, unlisted, S3 and OCI) remain identical
in TypeScript. Core's typed `RuntimeConfig.fingerprint` is checked through the
installed public runtime. The established Constructs renderer hashes its exact
JSON document, where JavaScript serializes `0`; Core's typed configuration uses
`0.0` for retry jitter. These are different canonical documents with distinct
golden hashes, never compared interchangeably. No persisted fingerprint algorithm
is silently rewritten or declared equivalent.

## Historical regression acceptance and final release gate

The historical regression CI matrix tests the packed npm host against PostgreSQL 16/PostGIS 3.4
and PostgreSQL 17/PostGIS 3.5, independently of PostgreSQL Adapter 2.1.0/2.1.1.
The public dependency closure is Core 1.0.1, Semantics 2.0.0, Query 1.0.2,
Projection 1.0.2 and Evidence 1.0.1; installation uses normal dependency resolution
and `pip check`, with no sibling source or dependency overrides. The historical
runtime dependencies still require Core 1.0.1.

The additional final-release matrix tests PostgreSQL Adapter 2.2.0 against both
Engine images using the independently selected public closure in
`tests/integration/jobs/requirements-repaired.txt`: Core 1.1.0, Semantics 2.0.1,
Query 1.0.3, Projection 1.0.3 and Evidence 1.0.2. Both matrices use ordinary public
installation and `pip check`, without dependency overrides. The tests compare
installed versions with the selected requirements before exercising the packed
host. These six combinations establish the recorded PostgreSQL acceptance only;
they do not claim complete upgraded-family conformance. Historical bundled
requirements and exported example recipes remain labeled, replaceable examples.

The PostgreSQL images are selected by immutable digest in CI:

- 16: `postgis/postgis@sha256:681931a625df344215e9b8998bf34daf146b6a395ceacee4439eb9c85869239f`
- 17: `postgis/postgis@sha256:894f570c0cf0664ed5576a8fd5d5bfb8fb1b19d592885b686c3a88c8bd90c41f`

Each matrix artifact contains JUnit, observed PostgreSQL/PostGIS versions,
installed distributions, pip reports with public archive hashes, selected and
resolved image digests, and the packed host SHA-256. The evidence collector rejects
skipped, failed or errored required cases. Tests cover explicit atomic source,
Evidence and intent commit/rollback, process restart, durable claims, exact ack,
v1 replay after v2, latest/tombstone reads and distinct graceful/failed-drain paths.

`npm run check` retains the existing 90% coverage thresholds, family integration,
cluster-harness, provider, Operation/guarantee, auth/TLS, Schema, placement and
integrity negative controls. Other Engine families' real-engine acceptance belongs
to the separate all-family closure task; neither these metadata tests nor this
release report claim those unexecuted combinations are verified.
