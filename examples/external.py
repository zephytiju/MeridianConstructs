# SPDX-License-Identifier: Apache-2.0
"""Compile a minimal external PostgreSQL deployment without provisioning resources."""

from meridian_constructs import (
    BindingSpec,
    CatalogName,
    CatalogProvider,
    DeploymentSpec,
    EngineConnection,
    OperationRequirement,
    PlacementRule,
    PlacementSelector,
    ResourceRef,
    ResourceRequirement,
    SchemaProvider,
    SecretReference,
    TLSPolicy,
    plan_deployment,
)

FP = "sha256:" + "0" * 64
resource = ResourceRef.parse("structured:orders.records")
tls = TLSPolicy(
    mode="server",
    server_name="postgresql.internal",
    ca_ref=SecretReference("vault", "pki/meridian/ca"),
)
binding = BindingSpec(
    id="records",
    profile_id="postgresql-postgis-cluster",
    required_capability_fingerprint=FP,
    connection=EngineConnection(
        physical_namespace="orders",
        identity_ref=SecretReference("workload-identity", "orders/api"),
        secret_ref=SecretReference("vault", "engines/orders-postgresql"),
        tls=tls,
        service_ref="platform/meridian/orders-postgresql",
        required_physical_fingerprint=FP,
    ),
)
plan = plan_deployment(
    DeploymentSpec(
        profile="production",
        catalogs=(
            CatalogProvider(
                CatalogName.STRUCTURED,
                "meridian-storage-semantics",
                "1.0.0",
                FP,
            ),
        ),
        schema_providers=(
            SchemaProvider("semantics", "meridian-storage-semantics", "1.0.0", FP),
        ),
        resources=(
            ResourceRequirement(
                resource,
                "semantics",
                FP,
                (
                    OperationRequirement(
                        "meridian.structured.put",
                        guarantees=("strong-consistency",),
                    ),
                ),
            ),
        ),
        bindings=(binding,),
        placements=(
            PlacementRule(
                "orders-records",
                PlacementSelector(resources=(resource,)),
                "records",
            ),
        ),
    )
)

print(plan.runtime_config_json)
