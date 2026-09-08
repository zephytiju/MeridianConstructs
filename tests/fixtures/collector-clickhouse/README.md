# Public layout fixture

Generated with the installed public `meridian-storage-core==1.1.0`,
`meridian-storage-semantics==2.1.0`, and `meridian-storage-clickhouse==1.1.2`.
Each target is a public `SchemaCompilation`/`ResourceLayout`; the explicit
physical Schema pin is the registered Core `SchemaDefinition.fingerprint`.
The integration suite regenerates these layouts through the public APIs and
keeps Core physical verification enabled. Image digests identify the tested
configuration; the renderer validates required configuration, not release
membership.
