<!-- SPDX-License-Identifier: Apache-2.0 -->

# Changelog

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
