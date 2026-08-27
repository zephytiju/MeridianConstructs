<!-- SPDX-License-Identifier: Apache-2.0 -->

# Contributing

Changes must preserve the one-repository/one-distribution boundary, the five-Catalog registry,
deployment-only Engine selection, opaque secret references, deterministic serialization, and
independent Platform/Vangu state authority.

Install and run the complete local gate before opening a pull request:

```bash
npm ci --ignore-scripts
npm run check
npm audit --audit-level=high
```

Compatibility changes must update the executable profile registry and then regenerate the
machine-readable contract:

```bash
npm run contracts:update
npm run contracts:check
```

Do not add Adapter or Kafka runtime dependencies, provider construction, ambient credential
discovery, `StackReference`, inline secrets, NativeQuery, or additional Catalog names. Changes to
the public architecture or interfaces require an approved design write-back before merge.
