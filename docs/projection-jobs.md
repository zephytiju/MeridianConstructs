<!-- SPDX-License-Identifier: Apache-2.0 -->

# Durable projection jobs

`durableProjectionJob` adds the approved initial Structured integer-version profile.
The existing `projectionJob` remains a rebuild declaration. Both return ordinary
`LifecycleJobSpecV1` values for `MeridianLifecycleJob`; the calling IaC package supplies
the provider/provisioner and owns the image, scheduling, identities, secret delivery,
migration dependencies and termination policy. This package starts no autonomous worker.

## Deployment inputs

Pass the owning package's closed `meridian-config.v1` as `runtimeConfig`, the logical
source/outbox/target selectors, exact source and target Schema references, a projector
fingerprint, migration job dependencies, and a digest-pinned **caller-owned image**.
The initial profile accepts exact or Catalog placement with no label predicates. It
requires three distinct Structured Resources and exactly one pinned Resource descriptor
per role. Source and outbox must resolve to the same Binding, even when two Bindings
would connect to the same database. The target may use a separate PostgreSQL Binding.

`manifests` contains the complete released `CapabilityManifest.to_dict()` keyed by
Binding ID, produced by the selected adapter's descriptor helper or authenticated probe.
The template recomputes each fingerprint, checks Engine profile/version and requires
Structured put 2.0.0, query 1.0.0 and atomic transaction capabilities. Startup independently
authenticates and validates the actual capability, physical and Resource fingerprints.
Secret values are resolved only inside the caller's host. Job outputs include opaque
identity, credential and TLS references; endpoints may not contain credentials.

Use `projectionPackagePins` for the exact public integration:

| Package                     | Version |
| --------------------------- | ------- |
| meridian-storage-core       | 1.0.1   |
| meridian-storage-semantics  | 2.0.0   |
| meridian-storage-query      | 1.0.2   |
| meridian-storage-projection | 1.0.2   |
| meridian-storage-postgresql | 2.1.0   |

These are **deployment package pins**. Core's Binding `compatibilityPins` are runtime
contract/manifest pins and must not be populated with Python distribution versions.
The older general Engine profiles in this package retain their existing compatibility
baseline. The dedicated projection template consumes the supplied released descriptors.

```ts
import {
  durableProjectionJob,
  projectionHostFiles,
  projectionPackagePins,
} from "@zephytiju/meridian-storage-constructs";

const spec = durableProjectionJob({
  image: ownedImageDigest,
  runtimeConfig: renderedRuntimeConfig,
  packages: projectionPackagePins,
  source: { catalog: "structured", namespace: "orders", name: "source" },
  outbox: { catalog: "structured", namespace: "orders", name: "outbox" },
  target: { catalog: "structured", namespace: "orders", name: "target" },
  sourceSchema: "orders.source@1.0.0",
  targetSchema: "orders.target@1.0.0",
  name: "orders-projection",
  projectionFingerprint: pinnedProjectorFingerprint,
  manifests: releasedManifestsByBinding,
  dependsOn: ["orders-explicit-migration"],
  budgets: {
    batchSize: 2,
    poisonThreshold: 3,
    pollIntervalMs: 100,
    calls: {
      claim: 1000,
      load: 100,
      project: 100,
      target: 1000,
      acknowledge: 100,
      complete: 1000,
      release: 1000,
      lag: 1000,
      evidence: 100,
    },
    overheadMs: 1000,
    drainMs: 15000,
    leaseMs: 20000,
    leaseMarginMs: 1000,
    terminationGraceMs: 17000,
  },
});

// The owning image builder copies these four files. This is not a Python package.
const hostFiles = projectionHostFiles();
// Mount spec as job.json and wire it through the existing LifecycleJobProvisionerV1.
```

The call bounds are **whole-call elapsed limits**, including internal retries, pool
waits, source loading, target work and evidence. They are not just SQL statement
timeouts. The conservative cycle is:

```text
claim + batch * (load + project + target + acknowledge + complete + release + 2*evidence)
      + lag + evidence + overhead
```

This includes a successful completion followed by an evidence failure and a release
attempt. It must fit `drainMs`; the lease covers it plus `leaseMarginMs`. The configured
termination grace must exceed drain by at least one second for hard termination and
reaping. The example admits a 10,100 ms cycle. `overheadMs` must cover host scheduling
and cleanup for the selected deployment. The provisioner must enforce the returned
`timeoutSeconds`, migration dependencies and `terminationGraceMs`, and mount referenced
secrets using its own authority. Tests use a disposable local-engine process deployment;
they do not claim a production cluster rollout.

## Hosting executable

`projectionHostFiles()` returns `worker.py`, `supervisor.py`, `versioned_target.py` and
`requirements.txt`. Copy them into the owning image beside its application entrypoint,
install the exact public requirements, and pin the resulting image digest. These files
are deployment templates in the npm distribution, with no additional Python distribution
or provider SPI. The host selects the supported `PostgreSQLOutbox(runtime, resource=...,
spec=..., context=...)` injection path. Business code supplies a pure projector and
logical Resource names; it never constructs engine clients or SQL.

```python
import json
from worker import ProjectionWorker
from versioned_target import make_projector

# schema_providers, secret_resolver and context belong to this hosting executable.
# Secret references are resolved by target-native identity/secret delivery.
with open("/config/job.json", encoding="utf8") as stream:
    job = json.load(stream)
host = ProjectionWorker(job, schema_providers=schema_providers,
                        secret_resolver=secret_resolver, context=context)
try:
    project = make_projector(host.meridian, target="orders.target",
                             scope={"tenant": context.tenant, **dict(context.scope)})
    host.run(project)
finally:
    host.close()
```

Run the executable under the included POSIX supervisor:

```sh
python /app/supervisor.py /config/job.json -- python /app/application.py
```

SIGTERM/SIGINT is forwarded once to the worker, which sets the stop Event supplied to
the released `run_until_stopped`. It completes the already admitted batch and makes no
new claim cycle. The supervisor enforces the host drain deadline independently of the
worker's callback timers. A stuck callback that defeats its local timer is killed as a
process group, produces `failed-drain`, and exits 70. A local whole-call timeout exits 71. Neither path invents acknowledgement or checkpoint progress. Outstanding claims
remain durable and recover only after real lease expiry. Owners are unique per host
attempt; the provider's owner-only protocol does not provide generation-token fencing.

The host emits bounded state/count observations for lag, completion, retry, quarantine,
drain and termination. It emits no source payload, event identity, principal, exception
message, endpoint or credential values. Route stdout through the caller's telemetry
collector with its configured backpressure/termination policy. Callback deadlines use
POSIX signals on the worker's main thread; deploy this template on POSIX hosts and keep
the supervisor as the process entrypoint.

## Target and read composition

The pinned target Schema has `id`, `sourceKey` (string), `sourceVersion` (int64),
`deleted` (boolean) and `document` (json), with identity `["id"]`. The example computes
source identity from projection, logical scope, source Resource and Data identity, then
derives the row identity from that key plus the exact integer source version. A pure
projector returns `structured.put(..., mode="upsert")`. The host checks that identity,
version and upsert mode before target execution. The same version must produce the same
Data under the pinned projector/Schema. Its actual target result must acknowledge that
exact version before the durable provider completes and advances the checkpoint.

`latest_visible` reduces a **complete bounded, scope-authorized set of versions** to
the highest integer version per source identity, then applies tombstone and business
filters. Fetch all pages before using it. It is not an unbounded query planner or a
snapshot-consistency promise. Retain versions, including latest tombstones, while older
events may replay. Immutable version 1 replay cannot overwrite version 2 or resurrect
a deleted identity. A mutable single-row target is rejected by the host.

## Reproducing acceptance

The `tests/integration/jobs` suite adapts disposable migration fixtures from the
published PostgreSQL 2.1.0 conformance setup and the reviewed DataLifecycle integer
profile. Only test setup uses adapter-owned compilers/migration and SQL to remove its
unique disposable Schema. Host startup executes no DDL. Tests import every runtime from
`site-packages` and extract host files from the installed npm tarball; no sibling source
or workspace package imports are used.

```sh
npm ci --ignore-scripts
npm run check
npm pack --ignore-scripts --pack-destination /tmp
npm install --ignore-scripts --prefix /tmp/projection-consumer /tmp/zephytiju-meridian-storage-constructs-1.1.0.tgz
python3.12 -m venv /tmp/projection-runtime
/tmp/projection-runtime/bin/pip install -r src/jobs/projection/assets/requirements.txt pytest==8.4.2
export CONSTRUCTS_MODULE=/tmp/projection-consumer/node_modules/@zephytiju/meridian-storage-constructs/dist/index.js
# Supply a disposable local PostgreSQL/PostGIS DSN through the test environment.
/tmp/projection-runtime/bin/python -m pytest tests/integration/jobs -v
```

CI runs the same suite with immutable PostgreSQL 16/PostGIS 3.4 and PostgreSQL 17/PostGIS
3.5 images. It records JUnit, installed versions and package SHA-256. The suite proves
actual restart after claim, target commit and before checkpoint; source-result mismatch
rollback without intent; exact old-version replay; latest/tombstone reads; bounded
admitted-batch drain; a separate failed drain, hard termination and expired-claim recovery;
retry/quarantine persistence; and invalid placement/capability rejection before claims.
