# SPDX-License-Identifier: Apache-2.0
"""Generated config, public migration hooks, and real Core metadata dispatch."""

from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import psycopg
import pytest
from fixture import BUNDLE, RESOURCE, SCHEMA, deployment_spec, plan
from meridian_storage import (
    CompatibilityError,
    ErrorCode,
    Meridian,
    MeridianError,
    OperationContext,
)
from meridian_storage.adapters.postgresql import (
    MigrationExecutor,
    PostgreSQLSchemaRepository,
    PostgreSQLSettings,
    SchemaCompiler,
)
from meridian_storage.runtime.config import RuntimeConfig
from meridian_storage.semantics import IncompatibleSchema, SchemaAPI, SchemaDocument
from meridian_storage.spi.adapters import SecretValue
from psycopg import sql

CONTEXT = OperationContext(principal_ref="test:constructs", tenant="acceptance", scope={})
DEFINITION = {
    "semanticKind": "relational",
    "fields": [{"name": "id", "logicalType": "string"}],
    "identity": ["id"],
}


def pinned_plan(spec):
    # A render for offline planning precedes migration. Only the second render,
    # containing the actual plan/physical hashes, is ever given to Meridian.start.
    preview = RuntimeConfig.from_mapping(plan(spec)["runtimeConfig"])
    settings = PostgreSQLSettings.from_binding(preview.bindings[0])
    migration = SchemaCompiler(settings).compile()
    selected = copy.deepcopy(spec)
    selected["bindings"][0]["connection"]["requiredPhysicalFingerprint"] = (
        migration.physical_fingerprint
    )
    selected["bindings"][0]["migration"]["appliedFingerprint"] = migration.plan_fingerprint
    selected["validation"]["requirePhysicalFingerprints"] = True
    rendered = plan(selected)
    return selected, rendered, settings, migration


@pytest.fixture
def deployed(tmp_path):
    # Required CI acceptance fails when no Engine is supplied; it never skips.
    dsn = os.environ["MERIDIAN_POSTGRESQL_TEST_DSN"]
    namespace = "cm_" + uuid4().hex[:12]
    role = "cr_" + uuid4().hex[:12]
    credential = uuid4().hex
    spec, rendered, settings, migration = pinned_plan(deployment_spec(namespace))
    with psycopg.connect(dsn, autocommit=True) as connection:
        MigrationExecutor(settings).apply(connection, migration)
        connection.execute(
            sql.SQL(
                "CREATE ROLE {} LOGIN PASSWORD {} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT"
            ).format(sql.Identifier(role), sql.Literal(credential))
        )
        connection.execute(
            sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(
                sql.Identifier(namespace), sql.Identifier(role)
            )
        )
        connection.execute(
            sql.SQL("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA {} TO {}").format(
                sql.Identifier(namespace), sql.Identifier(role)
            )
        )

    class Secrets:
        def resolve(self, ref):
            return SecretValue((role if ref.reference == "identity" else credential).encode())

    @contextmanager
    def connect():
        with psycopg.connect(dsn, user=role, password=credential) as connection:
            yield connection

    def runtime(config=None):
        # Discover installed public Catalog/Schema/Adapter entry points normally.
        return Meridian(
            RuntimeConfig.from_mapping(config or rendered["runtimeConfig"]),
            secret_resolver=Secrets(),
        )

    def api():
        return SchemaAPI(
            PostgreSQLSchemaRepository(
                connection_factory=connect, physical_namespace=namespace, context=CONTEXT
            )
        )

    try:
        (tmp_path / "generated-config.json").write_text(rendered["runtimeConfigJson"] + "\n")
        if evidence_dir := os.environ.get("MERIDIAN_ACCEPTANCE_EVIDENCE_DIR"):
            output = Path(evidence_dir) / namespace
            output.mkdir(parents=True, exist_ok=True)
            (output / "deployment-input.json").write_text(json.dumps(spec, indent=2) + "\n")
            (output / "generated-config.json").write_text(rendered["runtimeConfigJson"] + "\n")
            (output / "fingerprints.json").write_text(
                json.dumps(
                    {
                        "providerBundle": BUNDLE.fingerprint,
                        "resourceDefinition": RESOURCE.fingerprint,
                        "schemaDefinition": SCHEMA.fingerprint,
                        "schemaDocument": SCHEMA.definition["fingerprint"],
                        "migrationPlan": migration.plan_fingerprint,
                        "physicalLayout": migration.physical_fingerprint,
                    },
                    indent=2,
                )
                + "\n"
            )
        yield SimpleNamespace(
            spec=spec,
            rendered=rendered,
            namespace=namespace,
            role=role,
            credential=credential,
            connect=connect,
            runtime=runtime,
            api=api,
            dsn=dsn,
            migration=migration,
        )
    finally:
        with psycopg.connect(dsn, autocommit=True) as connection:
            connection.execute(
                sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(sql.Identifier(namespace))
            )
            connection.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(role)))


def test_generated_config_dispatches_and_reopens_persistent_schema_without_ddl(deployed, tmp_path):
    document = SchemaDocument.from_definition(
        catalog="structured",
        namespace="example",
        name="customer",
        version="1.0.0",
        definition=DEFINITION,
    )
    with deployed.connect() as connection:
        assert not connection.execute(
            "SELECT has_schema_privilege(current_user, %s, 'CREATE')", (deployed.namespace,)
        ).fetchone()[0]
        with pytest.raises(psycopg.errors.InsufficientPrivilege), connection.transaction():
            connection.execute(
                sql.SQL("CREATE TABLE {}.forbidden (id int)").format(
                    sql.Identifier(deployed.namespace)
                )
            )

    for attempt in range(2):
        runtime = deployed.runtime()
        try:
            report = runtime.start()
            assert report.catalogs == ("structured",)
            assert report.resources == (RESOURCE.ref.canonical,)
            structured = runtime.catalog("structured")
            with runtime.context(CONTEXT):
                result = runtime.execute(
                    structured.publish_schema(
                        namespace="example", name="customer", version="1.0.0", definition=DEFINITION
                    )
                )
            assert result.operation_contract == "meridian.structured.publish_schema"
            assert result.data["publication"]["schema"]["fingerprint"] == document.fingerprint
            assert result.data["idempotent"] is bool(attempt)
            assert result.data["registryRevision"] == 1
        finally:
            runtime.close()
        publication = deployed.api().read(
            namespace="example",
            name="customer",
            version="1.0.0",
            expected_fingerprint=document.fingerprint,
        )
        assert publication.document == document

    # Read through a fresh Python process from installed public wheels, so an
    # in-process cache cannot satisfy the durability assertion.
    child = subprocess.run(
        [sys.executable, "-I", str(Path(__file__).with_name("read-schema.py"))],
        input=json.dumps(
            {
                "namespace": deployed.namespace,
                "user": deployed.role,
                "password": deployed.credential,
                "fingerprint": document.fingerprint,
            }
        ),
        text=True,
        capture_output=True,
        check=True,
    )
    assert json.loads(child.stdout)["schema"]["fingerprint"] == document.fingerprint
    for wrong in [BUNDLE.fingerprint, RESOURCE.fingerprint, SCHEMA.fingerprint]:
        with pytest.raises(IncompatibleSchema):
            deployed.api().read(
                namespace="example", name="customer", version="1.0.0", expected_fingerprint=wrong
            )


@pytest.mark.parametrize(
    "kind,wrong",
    [
        ("bundle", RESOURCE.fingerprint),
        ("resource", BUNDLE.fingerprint),
        ("bundle", "sha256:" + "f" * 64),
        ("resource", "sha256:" + "f" * 64),
    ],
)
def test_valid_but_swapped_or_stale_pins_fail_at_core_registry_boundary(deployed, kind, wrong):
    spec = copy.deepcopy(deployed.spec)
    if kind == "bundle":
        spec["schemaProviders"][0]["requiredFingerprint"] = wrong
    else:
        spec["resources"][0]["schemas"][0]["resourceFingerprint"] = wrong
    config = plan(spec)["runtimeConfig"]
    runtime = deployed.runtime(config)
    try:
        with pytest.raises(CompatibilityError) as error:
            runtime.start()
        assert error.value.code == ErrorCode.REGISTRY_REFERENCE
        assert ("bundle fingerprint" if kind == "bundle" else "provider pin") in str(error.value)
    finally:
        runtime.close()


def test_inner_schema_document_cannot_replace_the_physical_wrapper_pin(deployed):
    # Negative control: corrupt only the physical metadata's wrapper hash.
    with psycopg.connect(deployed.dsn) as connection:
        connection.execute(
            sql.SQL(
                "UPDATE {}.__meridian_resources SET schema_fingerprint = %s WHERE resource_ref = %s"
            ).format(sql.Identifier(deployed.namespace)),
            (SCHEMA.definition["fingerprint"], RESOURCE.ref.canonical),
        )
    runtime = deployed.runtime()
    try:
        with pytest.raises(MeridianError) as error:
            runtime.start()
        assert error.value.code == ErrorCode.PHYSICAL_FINGERPRINT
    finally:
        runtime.close()


def test_missing_metadata_migration_fails_without_creating_storage(deployed):
    with psycopg.connect(deployed.dsn) as connection:
        connection.execute(
            sql.SQL("DROP TABLE {}.__meridian_schema_registry").format(
                sql.Identifier(deployed.namespace)
            )
        )
    runtime = deployed.runtime()
    try:
        with pytest.raises(MeridianError):
            runtime.start()
    finally:
        runtime.close()
    with psycopg.connect(deployed.dsn) as connection:
        assert (
            connection.execute(
                "SELECT to_regclass(%s)", (f"{deployed.namespace}.__meridian_schema_registry",)
            ).fetchone()[0]
            is None
        )
