<!-- SPDX-License-Identifier: Apache-2.0 -->

# Contributing

Changes must preserve the one-repository/one-distribution boundary, the five-Catalog registry,
deployment-only engine selection, opaque secret references, deterministic serialization, and
independent Platform/Vangu state authority. Run the complete local gate before opening a pull
request:

```bash
python -m pip install -e '.[test]'
ruff format --check src tests
ruff check src tests
python -m mypy src
pytest
bandit -c pyproject.toml -r src
python -m pip_audit . --strict
python -m build
python -m twine check dist/*
```

Changes to compatibility require updating both the executable profile registry and
`src/meridian_constructs/contracts/compatibility.v1.json`. The released-package gate is:

```bash
python -m pip install -e '.[test,conformance]'
meridian-constructs-compatibility --verify-installed --json
pytest tests/integration/test_released_runtime.py
```
