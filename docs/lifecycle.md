<!-- SPDX-License-Identifier: Apache-2.0 -->

# Lifecycle, recovery, and observability

Migration, projection rebuild, cache warm, streaming bootstrap, backup, restore, and deployment
validation are explicit `LifecycleJobSpecV1` values. Each uses a digest-pinned image, a serialized
versioned operation, bounded timeout/attempt policy, an exact Resource list, and opaque secret
references.

`MeridianLifecycleJob` executes nothing by itself. Platform/Vangu supplies a
`LifecycleJobProvisionerV1` and retains scheduling, identity, ACL, rollback, recovery-point,
migration, and lifecycle authority.

The OpenTelemetry integration follows the same pattern. `OtelCollectorSpecV1` supports sidecar
and gateway modes, requires a digest-pinned Collector image, validates an OTLP receiver and
service pipelines, and rejects credential-looking inline configuration recursively.
Platform/Vangu supplies a `CollectorProvisionerV1` and an explicit provider. Calling
`MeridianOtelCollector.runtimeCapability(...)` produces a Pulumi Output that can be passed
directly to `MeridianDeployment.telemetry`. The rendered non-secret capability includes endpoint,
protocol, enabled signals, TLS, batching/sampling fingerprint, and Evidence backend-read
placement; credential references remain confined to the caller-owned Collector provisioner.
