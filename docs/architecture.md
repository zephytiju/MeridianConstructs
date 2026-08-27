<!-- SPDX-License-Identifier: Apache-2.0 -->

# Architecture and authority

MeridianConstructs has one directional flow:

```text
Platform/Vangu inputs
  -> explicit Engine provider/reference
  -> fail-closed placement planner
  -> canonical meridian-config.v1
  -> logical Resource capability outputs
  -> workload mount selected by MERIDIAN_CONFIG
```

The planner is pure and deterministic. Pulumi components wrap it without creating a provider or
using ambient credentials. A managed Engine requires a caller implementation of
`ManagedEngineProvider`; an external Engine requires `EngineConnectionInputs`. Both resolve to
the same immutable `BindingSpec` and therefore exercise the same validation.

The connection carries exactly one endpoint or service reference, opaque deployment-owned
identity and secret references, TLS policy, physical namespace, and authenticated capability and
physical fingerprints. It never carries secret bytes. Strict mode requires a physical fingerprint
for every Binding.

## Managed Engine

```python
managed = ManagedEngine(
    "records",
    ManagedEngineArgs(
        binding=EngineBindingArgs(
            binding_id="records",
            profile_id="postgresql-postgis-local-single-primary",
            required_capability_fingerprint="sha256:...",
        ),
        provider=platform_meridian_provider,
    ),
)
```

`platform_meridian_provider` owns the actual cloud or cluster resources and returns only typed
connection inputs. The construct passes itself as the Pulumi parent but does not construct or
configure the provider.

## External Engine

```python
external = ExternalEngine(
    "records",
    ExternalEngineArgs(
        binding=EngineBindingArgs(
            binding_id="records",
            profile_id="postgresql-postgis-cluster",
            required_capability_fingerprint="sha256:...",
        ),
        connection=platform_connection_inputs,
    ),
)
```

## Deployment output

`MeridianDeployment` exposes Pulumi Outputs for the runtime mapping, canonical JSON, its SHA-256
fingerprint, and logical Resource capabilities. Public capability keys follow
`juntai.platform.meridian.resource.<catalog>.<namespace>.<resource>@1.0.0`; no public key contains
an Adapter, Engine, broker, or package name.

The caller writes or mounts the JSON with its own workload provider and sets `MERIDIAN_CONFIG`.
`MERIDIAN_PROFILE` is optional. No implicit `StackReference`, global provider, environment
credential, or imperative CLI is used.
