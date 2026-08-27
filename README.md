<!-- SPDX-License-Identifier: Apache-2.0 -->

# MeridianConstructs

`meridian-constructs` is the Python Pulumi construct package for deployment-time Meridian
engine placement, typed binding outputs, runtime configuration, lifecycle jobs, recovery, and
OpenTelemetry Collector integration. Platform and Vangu IaC retain provider, stack state,
identity, ACL, secret, migration, recovery, and engine lifecycle authority.

The repository is public from before its first commit and publishes exactly one Python
distribution and import package:

```bash
python -m pip install meridian-constructs
```

```python
import meridian_constructs
```

The complete V1 implementation is being developed against Meridian HLD revision 56,
Catalogs/Public Interfaces revision 70, Engine Adapters revision 24, Kafka Adapter revision 6,
and MeridianConstructs revision 45.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
