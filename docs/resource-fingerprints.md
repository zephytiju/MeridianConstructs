<!-- SPDX-License-Identifier: Apache-2.0 -->

# Resource pins and selected Catalogs

Constructs 1.4.0 removes an invalid equality check between an entire provider bundle
and an individual ResourceDefinition. Supply the canonical fingerprint of each
object at its own boundary. Core verifies the supplied values against installed
providers and physical storage at startup.

| Object                   | Input or runtime field                                                               | Meaning                                                               |
| ------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Provider ResourceBundle  | `schemaProviders[].requiredFingerprint` → `schemas.providers[].requiredFingerprint`  | Complete bundle returned by the provider                              |
| ResourceDefinition       | `resources[].schemas[].resourceFingerprint` → `resources.pins[].requiredFingerprint` | One Resource selected from that bundle                                |
| Core SchemaDefinition    | Adapter layout `settings.resources[].schemaFingerprint`                              | Core wrapper used for physical Resource verification                  |
| Semantics SchemaDocument | `SchemaAPI.read(..., expected_fingerprint=...)`                                      | Inner logical document published/read through the metadata repository |

All four fingerprints are independent. Never substitute one for another. When a
deployment carries explicit wrapper metadata outside Adapter settings, name it
`schemaDefinitionFingerprint`; optional logical Schema metadata must not overwrite
the Adapter's physical `schemaFingerprint`.

## Existing callers

The historical `SchemaRequirementV1.fingerprint` already meant ResourceDefinition.
It retains that meaning. The explicit `resourceFingerprint` alias can be used alone,
or alongside `fingerprint` when both values agree. Missing, malformed or conflicting
resource pins fail validation. The `resourceDefinitionFingerprint` helper applies
the same selection and validation rules.

`ResourceBindingCapabilityV1.schemaFingerprint` is also a historical name. It
continues returning the ResourceDefinition pin (or the existing aggregate of legacy
pins); it has not been reinterpreted as either logical Schema hash. Matching old and
new input forms produce identical V1 output bytes. The closed Core wire schema,
historical compatibility V1 artifact and canonical hash algorithm are unchanged.

Package locks still live in the `org.meridian.constructs/package-lock.v1` extension.
`runtimeCompatibilityPins` still supplies Core contract expectations separately.

## Catalog selection

Select any non-empty subset of `structured`, `object`, `cache`, `evidence` and
`streaming`. Every required Resource's Catalog must be selected. Unknown Catalogs,
duplicates, empty sets and missing required Catalogs fail at both `planDeployment`
and `validateRuntimeConfig`. Existing operation, provider, placement, capability,
TLS and release-selection validation continues to apply.

## Public metadata fixture and acceptance

The fixture selects only `structured:meridian.registry` from the complete public
Semantics 2.1.0 bundle, which also contains an unselected cache Resource. Its physical
profile is `metadata-registry`, table `__meridian_schema_registry`, empty
`fields`/`identity`/`indexes`, and `relation: null`.

| Public Semantics 2.1.0 object  | SHA-256 fingerprint                                                       |
| ------------------------------ | ------------------------------------------------------------------------- |
| Complete bundle                | `sha256:1579517f378f4ceaec3ee78de6f14f705b73320737384f14c720aa4c0edf0366` |
| Structured registry Resource   | `sha256:b02229d273a6c5439da926c7be897dbcc2545bb1778d72f124cb0b8528487b39` |
| Core SchemaDefinition wrapper  | `sha256:29dd42b077a4848db31be148c0d486a1831d9481c91a4e5f44482c732482f380` |
| Inner bootstrap SchemaDocument | `sha256:1a252016558ca0c14993f352e6bd512793631bc6a468d3168cb1c0938684b46a` |

Tests derive these values from installed public objects. They load Constructs from
an installed npm tarball and pass its generated configuration to public Core 1.1.0.
Public `PostgreSQLSettings.from_binding`, `SchemaCompiler` and `MigrationExecutor`
from Adapter 2.3.1 prepare the explicit physical layout. The final configuration is
rendered again with actual migration/physical fingerprints. Runtime code only uses
Core's `structured.publish_schema`; reads inject public `PostgreSQLSchemaRepository`
into `SchemaAPI`. A restricted role cannot create tables. Fresh runtime instances
and a separate Python process verify persistent readback.

The CI job `Packaged metadata config PostgreSQL 16/17` retains generated configuration,
four-fingerprint evidence, package install reports, Engine observations and JUnit.
It rejects skipped tests. Parser-only tests cover malformed/missing pins and Catalog
sets; real-Engine tests prove stale/swapped pins fail at the Core Registry boundary,
wrong wrapper metadata fails physical verification, and absent migration fails closed.
The historical six packed projection jobs remain separate regression gates.

To repeat the package-only fixture, install the candidate/public Constructs tarball
in an isolated npm consumer and create a normal Python environment from
`tests/integration/runtime-config/requirements.txt`, plus pytest 8.4.2. Set
`CONSTRUCTS_MODULE` to that consumer's `node_modules/@zephytiju/meridian-storage-constructs/dist/index.js`,
`MERIDIAN_POSTGRESQL_TEST_DSN` to a disposable database, and
`MERIDIAN_POSTGRESQL_ENGINE_VERSION` to `16-postgis-3.4` or `17-postgis-3.5`.
Run `python -m pytest tests/integration/runtime-config` from this checkout; the
TypeScript fixture runner uses the repository's `tsx` development dependency.

This Constructs change introduces no physical migration of its own. Deploy the
Adapter-owned metadata layout before selecting the registry Resource. Rollback to
an older renderer may reject configurations using unequal real pins or Catalog
subsets; retain an already generated, Core-validated configuration or roll back the
complete deployment selection. Do not make incompatible hashes equal to bypass
the older validation.
