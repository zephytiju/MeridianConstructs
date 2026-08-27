<!-- SPDX-License-Identifier: Apache-2.0 -->

# MeridianConstructs

[![CI](https://github.com/zephytiju/MeridianConstructs/actions/workflows/ci.yml/badge.svg)](https://github.com/zephytiju/MeridianConstructs/actions/workflows/ci.yml)
[![CodeQL](https://github.com/zephytiju/MeridianConstructs/actions/workflows/codeql.yml/badge.svg)](https://github.com/zephytiju/MeridianConstructs/actions/workflows/codeql.yml)

`@zephytiju/meridian-storage-constructs` is the reusable TypeScript Pulumi construct library for deployment-time
Meridian Engine selection. It validates Resource placement and released Adapter capabilities,
supports managed and external Engines through explicit provider injection, and produces a closed,
canonical `meridian-config.v1` document plus logical Platform capability outputs.

The package does not import any Adapter—including Kafka—and never creates providers, discovers
ambient credentials, reads another stack, or assumes Platform/Vangu state and lifecycle authority.

```bash
npm install @zephytiju/meridian-storage-constructs @pulumi/pulumi
```

```ts
import {
  ExternalEngine,
  getEngineProfile,
  parseResourceSelector,
} from "@zephytiju/meridian-storage-constructs";

const profile = getEngineProfile("postgresql-postgis-local-single-primary");
const resource = parseResourceSelector("structured:orders.records");

const engine = new ExternalEngine("orders", {
  binding: {
    bindingId: "orders-db",
    profileId: profile.id,
    // Use the Adapter's public expected-fingerprint helper for the exact settings.
    requiredCapabilityFingerprint:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    acl: { provider: "policy-registry", reference: "orders-runtime" },
    migration: {
      contract: "meridian.migration.apply",
      version: "1.0.0",
      appliedFingerprint: "sha256:...",
    },
    observability: { enabled: false, labels: {} },
  },
  connection: {
    physicalNamespace: "orders",
    identityRef: { provider: "workload-identity", reference: "orders-runtime" },
    secretRef: { provider: "secret-manager", reference: "orders/database" },
    tls: {
      mode: "server",
      serverName: "postgres.example",
      caRef: { provider: "secret-manager", reference: "orders/postgres-ca" },
    },
    endpoint: "postgresql://postgres.example:5432/orders",
    requiredPhysicalFingerprint: "sha256:...",
  },
});

void resource;
void engine;
```

See [`examples/external.ts`](examples/external.ts) for a complete external-Engine deployment.

## V1 surface

- Exact Catalog registry: `structured`, `object`, `cache`, `evidence`, `streaming`.
- Released profiles for PostgreSQL, OpenSearch, ClickHouse, Valkey, S3, OCI Distribution, and
  Kafka/Streaming, with exact compatibility pins and operation descriptor fingerprints.
- One-primary defaults, opt-in multi-engine profiles, and exact-one Resource placement.
- Operation, guarantee, limit, topology, version, and physical-fingerprint validation.
- Opaque identity/secret references, authenticated TLS, and recursive inline-secret rejection.
- Canonical runtime configuration, SHA-256 fingerprints, logical Resource capability outputs, and
  deterministic plan diffs.
- Explicit migration, projection, cache-warm, streaming-bootstrap, backup, restore, and validation
  job specifications.
- Digest-pinned OpenTelemetry Collector sidecar/gateway specifications and a directly wireable,
  non-secret runtime telemetry capability.
- Pulumi mock integration and provider-neutral local cluster-equivalent conformance harnesses.

## Authority boundary

MeridianConstructs expresses deployment-time selection and reusable declarations. Platform/Vangu
IaC remains authoritative for providers, provisioning/reference, state, identity, ACLs,
migrations, recovery, and lifecycle. Applications receive logical Resource capabilities and a
runtime config mount; they do not select Engines or import Kafka.

NativeQuery and Catalogs such as ontology, query, projection, telemetry, audit, lineage, usage,
and cost are outside Meridian V1 and are rejected.

`EngineProfileV1.profileFingerprint` identifies the IaC selection profile. It must never be used
as `requiredCapabilityFingerprint`: that runtime pin is the selected Adapter's authenticated
`CapabilityManifest` fingerprint for the exact Engine version and settings. Generate it through
the Adapter's released public helper or take it from an authenticated probe.

## Development

Node.js 22 or later is required. The lockfile is authoritative.

```bash
npm ci --ignore-scripts
npm run check
npm audit --audit-level=high
```

`npm run check` runs formatting, linting, strict type checking, contract drift detection, tests
with coverage, compilation, and package-content inspection. See
[`docs/conformance.md`](docs/conformance.md) and
[`docs/compatibility.md`](docs/compatibility.md) for the evidence model.

## Design baseline

This release is locked to Meridian HLD revision 62, Catalogs and Public Interfaces revision 70,
Engine Adapters revision 24, Kafka Adapter revision 6, and MeridianConstructs revision 63. The
canonical repository is `zephytiju/MeridianConstructs`; the npm distribution is
`@zephytiju/meridian-storage-constructs`.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
