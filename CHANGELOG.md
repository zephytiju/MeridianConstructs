<!-- SPDX-License-Identifier: Apache-2.0 -->

# Changelog

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
