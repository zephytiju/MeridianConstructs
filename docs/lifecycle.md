<!-- SPDX-License-Identifier: Apache-2.0 -->

# Lifecycle, recovery, and observability

Migration, projection rebuild, cache warm, streaming bootstrap, backup, restore, and deployment
validation are explicit `JobSpec` values. Each uses a digest-pinned image, serialized versioned
operation, bounded timeout/attempt policy, exact Resource list, and opaque secret references.
`MeridianLifecycleJob` executes nothing on its own; Platform/Vangu supplies `JobProvisioner` and
retains scheduling, identity, ACL, rollback, recovery-point, and lifecycle authority.

The OpenTelemetry integration follows the same pattern. `OtelCollectorSpec` supports sidecar and
gateway modes, requires a digest-pinned Collector image, validates an OTLP receiver and service
pipelines, and rejects inline credential-looking configuration. Platform/Vangu supplies a
`CollectorProvisioner`. Workloads receive only `OTEL_EXPORTER_OTLP_ENDPOINT` and a supported
protocol (`grpc` or `http/protobuf`).
