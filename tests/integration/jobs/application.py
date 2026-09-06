# SPDX-License-Identifier: Apache-2.0
"""Disposable application over host files extracted from the npm artifact."""

import json
import os
import signal
import sys
from pathlib import Path
from threading import Event
from time import sleep

sys.path.insert(0, str(Path(os.environ["PROJECTION_ASSETS"]).resolve()))
from worker import ProjectionWorker
from versioned_target import make_projector
from meridian_storage import OperationContext
from meridian_storage.registry.resources import (
    NamespaceDefinition,
    ResourceBundle,
    ResourceDefinition,
    ResourceRef,
    SchemaDefinition,
    SchemaRef,
)
from meridian_storage.spi.adapters import SecretValue

payload = json.load(sys.stdin)
bundle = payload["bundle"]
bundle = ResourceBundle(
    bundle["providerId"],
    bundle["providerVersion"],
    bundle["providerContractVersion"],
    namespaces=tuple(NamespaceDefinition(**n) for n in bundle["namespaces"]),
    schemas=tuple(
        SchemaDefinition(SchemaRef.parse(s["ref"]), s["definition"]) for s in bundle["schemas"]
    ),
    resources=tuple(
        ResourceDefinition(
            ResourceRef.parse(r["ref"]),
            r["profile"],
            schema=SchemaRef.parse(r["schema"]),
            required_scope=tuple(r["requiredScope"]),
        )
        for r in bundle["resources"]
    ),
)


class Schemas:
    provider_id = bundle.provider_id
    provider_contract_version = "1.0.0"

    def load(self):
        return bundle


class Secrets:
    def resolve(self, ref):
        return SecretValue(
            payload["identity" if ref.reference == "identity" else "credential"].encode()
        )


context = OperationContext(principal_ref="test:host", tenant="a", scope={"workspace": "a"})
host = ProjectionWorker(
    payload["job"], schema_providers=[Schemas()], secret_resolver=Secrets(), context=context
)
phase = payload["phase"]
project = make_projector(
    host.meridian, target="example.target", scope={"tenant": "a", "workspace": "a"}
)
original_complete = host.port.complete


def complete(*args, **kwargs):
    if phase == "before-checkpoint":
        os._exit(93)
    return original_complete(*args, **kwargs)


host.port.complete = complete
original_execute = host.meridian.execute


def execute(expression):
    result = original_execute(expression)
    if phase == "after-target":
        os._exit(92)
    return result


host.meridian.execute = execute


def intercepted(source, context):
    if phase == "after-claim":
        os._exit(91)
    if phase in ("graceful", "stuck"):
        print(json.dumps({"state": "entered"}), flush=True)
        if phase == "stuck":
            # Simulate a nonconforming callback that defeats its local call timer.
            # The separate host supervisor still enforces the actual drain deadline.
            signal.signal(signal.SIGALRM, signal.SIG_IGN)
            Event().wait()
        sleep(0.15)
    if phase == "recover":
        host.stop.set()
    if phase == "poison":
        host.stop.set()
        raise ValueError("SENSITIVE_PAYLOAD_MUST_NOT_BE_LOGGED")
    if phase == "retry":
        from meridian_storage import MeridianError
        from meridian_storage.errors import ErrorCategory

        host.stop.set()
        raise MeridianError(
            "unavailable",
            "SENSITIVE_PAYLOAD_MUST_NOT_BE_LOGGED",
            category=ErrorCategory.UNAVAILABLE,
            retryable=True,
        )
    return project(source, context)


try:
    host.run(intercepted)
finally:
    host.close()
