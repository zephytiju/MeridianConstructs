<!-- SPDX-License-Identifier: Apache-2.0 -->

# MeridianConstructs

[![CI](https://github.com/zephytiju/MeridianConstructs/actions/workflows/ci.yml/badge.svg)](https://github.com/zephytiju/MeridianConstructs/actions/workflows/ci.yml)
[![CodeQL](https://github.com/zephytiju/MeridianConstructs/actions/workflows/codeql.yml/badge.svg)](https://github.com/zephytiju/MeridianConstructs/actions/workflows/codeql.yml)

`meridian-constructs` is the typed Python/Pulumi package for deployment-time Meridian Engine
selection. It validates Resource placement and released Adapter capabilities before provisioning,
supports managed and external Engines through explicit provider injection, and produces a closed,
canonical `meridian-config.v1` document plus logical Platform capability outputs.

The base distribution depends only on Pulumi. It does not import any Adapter—including Kafka—and
it never creates cloud providers, reads environment credentials, reaches into another stack, or
owns Platform/Vangu state and lifecycle.

```bash
python -m pip install meridian-constructs
```

```python
from meridian_constructs import CatalogName, ResourceRef, get_profile

resource = ResourceRef.parse("structured:orders.records")
profile = get_profile("postgresql-postgis-local-single-primary")

assert resource.catalog is CatalogName.STRUCTURED
assert profile.adapter_package == "meridian-storage-postgresql"
```

See [`examples/external.py`](examples/external.py) for a complete external-Engine plan and
[`docs/architecture.md`](docs/architecture.md) for managed-Engine and Pulumi integration.

## V1 surface

- Exact Catalog registry: `structured`, `object`, `cache`, `evidence`, `streaming`.
- Released Adapters: PostgreSQL, OpenSearch, ClickHouse, Valkey, S3, OCI Distribution, and Kafka.
- Exact compatibility pins and entry-point conformance without importing Adapter modules.
- One-primary defaults and opt-in cluster/test profiles.
- Exact-one placement with operation, guarantee, limit, topology, and version validation.
- Opaque identity/secret references and inline-secret rejection.
- Canonical runtime config, stable fingerprints, logical `MeridianBindingCapabilityV1`-style
  Platform outputs, and deterministic preview diffs.
- Explicit migration, projection, cache warm, streaming bootstrap, backup, restore, and validation
  jobs.
- Digest-pinned OpenTelemetry Collector sidecar and gateway specifications.
- Provider-neutral local cluster-equivalent conformance harness.

## Authority boundary

MeridianConstructs expresses selection and reusable declarations. Platform/Vangu IaC remains
authoritative for providers, provisioning/reference, state, identity, ACLs, migrations, recovery,
and lifecycle. Applications receive logical Resource capability keys and a runtime config mount;
they do not select Engines or import Kafka.

NativeQuery and additional Catalogs such as ontology, audit, telemetry, usage, lineage, and cost
are not part of Meridian V1 and are rejected.

## Development and conformance

```bash
python -m pip install -e '.[test]'
ruff format --check src tests
ruff check src tests
python -m mypy src
pytest --cov=meridian_constructs --cov-report=term-missing
bandit -c pyproject.toml -r src
python -m pip_audit . --strict
python -m build
python -m twine check dist/*
```

The opt-in released-package check installs the complete pinned Adapter set solely in a conformance
environment:

```bash
python -m pip install -e '.[test,conformance]'
meridian-constructs-compatibility --verify-installed --json
pytest tests/integration/test_released_runtime.py
```

More detail is in [`docs/conformance.md`](docs/conformance.md) and
[`docs/compatibility.md`](docs/compatibility.md).

## Design baseline

This release is locked to Meridian HLD revision 56, Catalogs and Public Interfaces revision 70,
Engine Adapters revision 24, Kafka Adapter revision 6, and MeridianConstructs revision 45. The
repository name correction is `zephytiju/MeridianConstructs`; the distribution remains
`meridian-constructs` and the import package remains `meridian_constructs`.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
