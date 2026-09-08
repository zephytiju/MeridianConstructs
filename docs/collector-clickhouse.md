<!-- SPDX-License-Identifier: Apache-2.0 -->

# Authenticated Collector telemetry

`createClickHouseTelemetryPlan` renders the stock Collector configuration and an explicit
ClickHouse migration for three registered Evidence Resources. `telemetryFields` describes the
public Semantics Schema fields for logs, spans, and metric points. Both functions are exported
from the package root and `/constructs`. The package remains deployment-only TypeScript.

The caller owns the ResourceBundle/SchemaProvider, selected public distributions and image
digests, Pulumi provider, placement, identities, secret delivery, volumes, network policy,
migration execution, rotation, and recovery. The renderer does not discover credentials,
construct a provider, start an Engine, register application Resources, or execute SQL.

## Render and apply

1. Define three registered Resources with the `log`, `span`, and `metric` profiles, identity
   `evidenceId`, and the complete fields returned by `telemetryFields(profile)`. Compile their
   public ClickHouse `ResourceLayout` values using `observedTime`, `queryFinal: true`, and the
   selected standalone or replicated topology. Keep the public Resource, Schema, layout,
   capability and physical fingerprints in the deployment lock.
2. Supply the exact public `ResourceLayout.to_dict()` values to the renderer. A registered
   Core `SchemaDefinition` fingerprint identifies its wrapper; the inner Semantics
   `SchemaDocument` has a different content fingerprint. The caller must select the registered
   Schema pin in the public `ResourceLayout`/`SchemaCompilation` before migration and normal
   strict startup. The integration fixture demonstrates this public composition.
3. Run the public Adapter migration for those layouts, verify the required layout fingerprints,
   then explicitly execute `plan.migration.statements` in order. Record its fingerprint and
   the installed definitions in the owning stack's migration state. Apply to every server that
   can receive Collector writes. Startup must retain physical verification and must not run DDL.
4. Deliver `plan.collector.config`, `plan.commandArguments`, the declared environment variables,
   and read-only certificate mounts to the selected stock Collector. Persist `queueDirectory`
   across restarts. Use the existing `MeridianOtelCollector` construct under the caller's
   provider, passing its spec to the caller's deployment resource implementation.
5. Publish the authenticated OTLP endpoint through the existing telemetry capability. Applications
   use the public Observability plugin and read the registered Resources through Meridian.

```ts
import { createClickHouseTelemetryPlan } from "@zephytiju/meridian-storage-constructs";

const plan = createClickHouseTelemetryPlan({
  mode: "gateway", // or sidecar, sharing the workload network namespace
  image: selectedCollectorDigest,
  database: "telemetry",
  bindingId: "telemetry",
  layouts: { log: logLayout, span: spanLayout, metric: metricLayout },
  tenant: authenticatedTenant,
  scope: authenticatedScope,
  ingestionIdentity: collectorIdentity,
  receiverTls: mutualTlsPolicy,
  tlsFiles: {
    certificate: "/tls/server.pem",
    key: "/tls/server.key",
    clientCa: "/tls/clients-ca.pem",
    receiverCa: "/tls/server-ca.pem",
    backendCa: "/tls/backend-ca.pem",
  },
  backendEndpoint: "https://clickhouse.example:8443",
  backendIdentityEnvironment: "CLICKHOUSE_USER",
  backendCredentialEnvironment: "CLICKHOUSE_PASSWORD",
  relayCredentialEnvironment: "COLLECTOR_RELAY",
  queueDirectory: "/var/lib/collector/queue",
  queueRequests: 128,
  maxEnvelopeBytes: 32768,
  maxBatchBytes: 1048576,
  maxBatchRows: 100,
  insertQuorum: 1,
});
```

The three environment names must differ. Only complete declared `${env:NAME}` password
references are accepted; defaults and mixed literal interpolation remain rejected. The ingress
requires a client certificate. Its verified server name also authenticates the private HTTPS
loopback relay on port 18180; the relay additionally requires an independently delivered opaque
credential. Only OTLP ports 4317/4318 should be exposed. Backend HTTPS verifies its CA and uses
a caller-delivered identity and password. Each deployment route represents one authenticated
tenant/scope; do not share that identity across tenants. Reserved source attribute keys cannot
replace the deployment scope.

## Public append-only layouts

ClickHouse 1.1.3 emits `appendOnly: true` for newly compiled Evidence layouts. The renderer
accepts that exact public variant and returns the complete validated documents in `plan.layouts`,
including their unchanged layout fingerprints. A legacy document omits `appendOnly`; explicitly
setting it to false, null, a number or a string is invalid. Unknown fields and tampered content
remain rejected. Existing legacy Collector and migration output retains its identity.

The append-only public sorting key adds the canonical row fingerprint after scope, timestamp
and Evidence identity. Exact canonical retries may coalesce; different content under the same
identity and time remains distinct. This does not imply WORM, atomic transactions or exactly-once
delivery. Distinct occurrences with identical content require distinct identity or time.

The caller must explicitly compile, provision or migrate, select and lock the new layout,
capability, physical verification and generated runtime configuration. Retaining an old table
with `CREATE TABLE IF NOT EXISTS` cannot change its sorting key: public migration rejects that
transition before relabeling metadata. A changed Collector migration fingerprint does not
upgrade a backend table. Drain old queues and keep the old lock until its deployment migration
is complete. Never strip the new field, reuse an old fingerprint or disable physical checks.

When `capabilityManifest` is omitted, planning derives `append-only` only if the complete,
fingerprint-validated selection has at least one Evidence layout and every Evidence layout
uses the new variant. Legacy or mixed Evidence layouts do not receive that guarantee. Explicit
manifests may narrow guarantees and limits; configuration cannot add a missing explicit
guarantee or broaden a selected bound. Atomic Evidence remains unsupported.

## Stock components and data fidelity

The OTLP receiver forwards full OTLP JSON to a private `webhook_event` receiver. Validation
runs before the sole durable queue. The native ClickHouse exporter writes to an explicitly
migrated Null table; materialized views split envelopes, map typed fields, and insert into the
public layout. Intermediate Null tables retain no raw data. Separate row/field stages bound
SQL expression expansion. `create_schema` and asynchronous inserts are disabled.

The mapping covers logs, spans with events/links, Gauge, Sum, Histogram and ExponentialHistogram.
Summary is rejected. Signed integers remain exact, including adjacent values above 2^53.
Strings, booleans, integers, doubles, arrays and maps keep their types. Bytes use a logical
`{base64, type: "bytes"}` representation. The existing V1 extension
`org.meridian.constructs/otlp` retains typed source data, including bytes versus user maps,
integer versus double zero, schema URLs, dropped counts, trace state, metric descriptors and
metadata. It contains only the current metric point, so exporter batching does not change
record identity. Empty OTLP units normalize to `1`; the original unit remains in the extension.
Absent optional IDs are omitted from the Evidence append input and represented as null by
nullable layout columns. A missing log body remains the required V1 null body.

All timestamps retain nine fractional digits. Attribute maps are canonicalized recursively;
reordered attribute keys do not change identity. Each normalized record is one public Evidence
append batch. Evidence ID, scope fingerprint, operation fingerprint, batch ID and row
fingerprint use the released public canonical semantics. ReplacingMergeTree plus `FINAL`
provides logical retry deduplication; physical duplicate versions may exist before merging.

## Bounds, acknowledgements and recovery

The renderer preserves the selected Adapter batch limits. Every normalized batch has one row;
its conservative byte expansion bound must fit `maxBatchBytes`. `maxEnvelopeBytes` bounds both
OTLP HTTP input and the expanded JSON relay, including protobuf input. Validation also bounds
attributes to 128 per map, AnyValue nesting to 12, flattened leaves to 10,000 and nesting to 48.
Duplicate attribute/map keys, malformed records, unsupported signals, invalid source scope and nonfinite numbers fail before
persistent acknowledgement. A protobuf request may fit the receiver but exceed the expanded
JSON budget and be rejected; size the caller's batches accordingly.

The upstream relay has no queue or retry. The native exporter has one fsynced persistent queue,
one consumer, bounded request capacity, infinite retry and blocking overflow. A successful
OTLP response acknowledges durable queue acceptance, not completed backend insertion. During
backend outage, saturation returns HTTP 503; callers retry rejected requests. A SIGKILL must
retain acknowledged requests when the queue volume is intact. Monitor queue usage and exporter
failures, keep the selected mapping installed until its queues drain, and rotate credentials
through the owning deployment. The official [internal telemetry endpoint](https://opentelemetry.io/docs/collector/internal-telemetry/) exposes queue size/capacity for drain and saturation checks. Disk loss is outside the local queue durability guarantee.

## Migration lifecycle and conformance

Identical input and implementation render identical configuration, SQL, and migration identity.
Helper and materialized-view names hash their complete mapping implementation and destination
inputs. Changed mappings therefore receive new names. No-change explicit migration is
idempotent. Record and compare installed definitions; a matching plan fingerprint alone cannot
prove an Engine was not altered. Replacing an old mapping requires the caller to drain its
queues before removing its old views, Null tables and unreferenced SQL functions. The renderer
never drops caller-owned data or silently replaces a previous deployment's mapping.

The stock image must provide OTLP, webhook_event, transform/OTTL lambda functions, file_storage
and ClickHouse components. `lambdaFunctions: "feature-gate"` (default) enables
`ottl.functions.enableLambda`; select `"available"` only when the independently selected image
provides the functions without that gate. Image versions are conformance provenance, not an
allowlist. A different image or backend remains unverified until its actual feature, migration,
fidelity, TLS and recovery gates pass.

The required CI gate consumes an installed npm tarball (or an explicitly selected public
version), normal public Python distributions and digest-pinned stock images. It runs actual
plugin emission in gateway and shared-network sidecar modes, strict registered Meridian startup,
public reads and V1 Schema validation, canonical identities, nanosecond pagination, wrong-pin
and scope negatives, explicit no-change migration, invalid input, retry and SIGKILL recovery.
The fixture owns its temporary certificates, test identities, containers, network and volumes.
Existing V1, public capability, PostgreSQL, projection-host and package gates remain required.
