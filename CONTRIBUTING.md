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
python -m build
python -m twine check dist/*
```
