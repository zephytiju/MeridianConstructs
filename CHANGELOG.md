<!-- SPDX-License-Identifier: Apache-2.0 -->

# Changelog

## 1.6.0

- Render authenticated stock Collector telemetry plans and explicit public ClickHouse layout migrations for log, span and metric Resources.
- Preserve typed OTLP data, exact integers, nanoseconds and canonical retry identity through public Meridian reads; validate before durable acknowledgement.
- Accept complete declared environment references in Collector password fields while retaining secret interpolation restrictions.
- Add installed-package, real-plugin sidecar/gateway integration and fault conformance.

## 1.5.1

- Compare deployment-selected ClickHouse limits even when a Binding omits the new
  manifest input; reject one-above requirements instead of using bundled defaults.
- Apply the same released configuration mappings to OpenSearch, Valkey, S3 and OCI
  limit settings. Explicit manifests never gain missing or larger capabilities.
- Enforce both Resource and Operation minimum limits when the same key appears in
  both scopes, so a lower Operation minimum cannot hide a Resource requirement.
- Add public-artifact tuned-limit parity tests and preserve the expanded independent
  2,454-case audit, including all 978 negative controls.

## 1.5.0

- Align PostgreSQL planning with public 2.3.1 Operation versions, required Evidence
  guarantees and durable Schema publication capabilities.
- Accept a fingerprint-pinned public CapabilityManifest as planning-only Binding
  input. Compare its available Operations, versions, guarantees and limits without
  merging bundled defaults; preserve deployment identity and all V1 runtime checks.
- Inventory all seven Adapter families and retain the existing test suites. Add
  public Core comparison and PostgreSQL 2.3.1 packed-host acceptance on PG 16/17.
- See [Operation capability migration](docs/operation-capabilities.md) for baseline
  changes, selected-manifest usage and the limits of metadata conformance evidence.

## 1.4.0

- Pin complete provider bundles independently from their individual ResourceDefinitions.
- Add `resourceFingerprint` as an explicit resource-pin alias; matching legacy inputs
  retain the same V1 configuration bytes, capability outputs and hashing semantics.
- Accept supported non-empty Catalog subsets, including each standalone Catalog;
  reject unknown, empty, duplicate and missing-required selections at both boundaries.
- Add packed Constructs/public Core metadata acceptance with public Semantics 2.1.0
  and PostgreSQL Adapter 2.3.1 on PostgreSQL 16/17, including stale/swapped pins,
  migration verification and durable publication/read under a role without DDL rights.

## 1.3.0

- Accept independently deployment-selected Engine and library releases across every
  profile, managed/external construct, renderer, conformance helper and durable host.
- Retain required contracts, protocol constraints, provider modes, complete exact
  package locks, image digests, placement, physical Schema and lifecycle checks.
- Separate package-lock extensions from Core runtime compatibility expectations;
  version generated release metadata as V2 while preserving the historical V1 file.
- Consume public Core 1.1.0 golden fixtures and verify packed hosts against PostgreSQL
  16/17 with independently selected public PostgreSQL Adapter 2.1.0/2.1.1 and
  the repaired Core 1.1.0 / PostgreSQL 2.2.0 / Projection 1.0.3 public closure.

## 1.2.0 — 2026-09-06

- Declare required atomic Evidence Resources with `requiredEvidence`, validate
  their source/outbox Binding and `atomic-evidence` support at preview and host
  startup, and pin the compatible Evidence package.
- Fingerprint required participants under worker contract 1.1.0 while retaining
  evidence-free worker 1.0.0 compatibility and separately bound optional Evidence.
- Verify three-participant commit/rollback, runtime drift and host/spec compatibility
  alongside the existing durable projection and bounded shutdown conformance.

## 1.1.0 — 2026-09-06

- Add durable projection job validation for released PostgreSQL/provider packages,
  same-Binding source/intent placement, Schema/capability pins and opaque secret references.
- Package caller-owned worker/supervisor templates with bounded whole-call and batch
  budgets, stop/drain/termination handling and redacted lifecycle evidence.
- Preserve integer-version target identities, latest-version reads and tombstones;
  verify actual host crash/restart, rollback and graceful/failed drain on PostgreSQL 16/17.

## 1.0.0 - 2026-08-26

- Publish the authoritative TypeScript Pulumi distribution,
  `@zephytiju/meridian-storage-constructs`.
- Add deterministic deployment planning and closed `meridian-config.v1` generation.
- Cover PostgreSQL, OpenSearch, ClickHouse, Valkey, S3, OCI Distribution, and Kafka/Streaming with
  exact released compatibility pins and without runtime Adapter imports.
- Add managed/external Engine components, logical Platform capability outputs, explicit lifecycle
  and recovery jobs, and OpenTelemetry Collector sidecar/gateway specifications.
- Add unit, Pulumi mock integration, package-contract, and local cluster-equivalent conformance
  tests with deterministic evidence.
- Replace the unpublished Python scaffold after resolving its contradiction with the locked
  TypeScript architecture and apply the owner-approved package identity from MeridianConstructs
  revision 63 and Repository Atlas revision 16.
