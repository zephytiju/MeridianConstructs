# SPDX-License-Identifier: Apache-2.0
"""Fresh-process exact-pin read through public Adapter/Semantics APIs."""

import json
import os
import sys
from contextlib import contextmanager

import psycopg
from meridian_storage import OperationContext
from meridian_storage.adapters.postgresql import PostgreSQLSchemaRepository
from meridian_storage.semantics import SchemaAPI

request = json.load(sys.stdin)


@contextmanager
def connect():
    with psycopg.connect(
        os.environ["MERIDIAN_POSTGRESQL_TEST_DSN"],
        user=request["user"],
        password=request["password"],
    ) as connection:
        yield connection


repository = PostgreSQLSchemaRepository(
    connection_factory=connect,
    physical_namespace=request["namespace"],
    context=OperationContext(principal_ref="test:constructs", tenant="acceptance", scope={}),
)
publication = SchemaAPI(repository).read(
    namespace="example",
    name="customer",
    version="1.0.0",
    expected_fingerprint=request["fingerprint"],
)
print(json.dumps(publication.to_dict()))
