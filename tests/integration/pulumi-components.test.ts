// SPDX-License-Identifier: Apache-2.0

import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ExternalEngine,
  ManagedEngine,
  MeridianDeployment,
  MeridianLifecycleJob,
  MeridianOtelCollector,
  createOtelCollectorSpec,
  migrationJob,
  type CollectorProvisionerV1,
  type LifecycleJobProvisionerV1,
  type ManagedEngineProvisionerV1,
} from "../../src/index.js";
import {
  catalogs,
  digestImage,
  fingerprintA,
  fingerprintB,
  fingerprintC,
  ordersRequirement,
  placement,
  schemaProviders,
} from "../fixtures.js";

const resources: pulumi.runtime.MockResourceArgs[] = [];

beforeAll(async () => {
  await pulumi.runtime.setMocks(
    {
      newResource: (args) => {
        resources.push(args);
        return { id: args.id ?? `${args.name}_id`, state: args.inputs };
      },
      call: (args) => args.inputs,
    },
    "meridian-storage-constructs",
    "test",
    false,
  );
});

class TestProvider extends pulumi.ProviderResource {
  public constructor(name: string) {
    super("test-provider", name, {});
  }
}

function bindingArgs(profileId: string) {
  return {
    bindingId: "orders-db",
    profileId,
    requiredCapabilityFingerprint: fingerprintA,
    acl: { provider: "policy-registry", reference: "orders-acl" },
    migration: {
      contract: "meridian.migration.apply",
      version: "1.0.0",
      appliedFingerprint: fingerprintB,
    },
    observability: { enabled: false, labels: { service: "orders" } },
    recovery: {
      method: "backup-restore" as const,
      owner: "orders-platform",
      policyRef: "orders-daily",
      rpoSeconds: 300,
      rtoSeconds: 14_400,
      validationFingerprint: fingerprintC,
    },
  };
}

function connectionInputs() {
  return {
    physicalNamespace: "orders",
    identityRef: { provider: "workload-identity", reference: "orders-runtime" },
    secretRef: { provider: "secret-manager", reference: "orders/database" },
    tls: {
      mode: "server" as const,
      serverName: "postgres.example",
      caRef: { provider: "secret-manager", reference: "orders/postgres-ca" },
    },
    endpoint: "postgresql://postgres.example:5432/orders",
    requiredPhysicalFingerprint: fingerprintC,
    settings: { connectTimeoutSeconds: 10 },
  };
}

describe("Pulumi component integration", () => {
  it("renders an external Engine into typed runtime and logical capability outputs", async () => {
    const engine = new ExternalEngine("orders-external", {
      binding: bindingArgs("postgresql-postgis-local-single-primary"),
      connection: connectionInputs(),
    });
    const deployment = new MeridianDeployment("orders", {
      profile: "test",
      catalogs,
      schemaProviders,
      resources: [ordersRequirement],
      engines: [engine],
      placements: [placement],
    });
    expect(pulumi.resourceType(engine)).toBe("meridian:storage:ExternalEngine");
    expect(pulumi.resourceType(deployment)).toBe("meridian:storage:Deployment");
    const runtime = await resolveOutput(deployment.runtimeConfigJson);
    expect(runtime).toContain(
      '"engineProfile":"postgresql-postgis-local-single-primary"',
    );
    expect(runtime).not.toContain("password");
    expect(await resolveOutput(engine.endpoint)).toBe(
      "postgresql://postgres.example:5432/orders",
    );
    expect(
      deployment.bindingOutputs["structured:orders.records"],
    ).toMatchObject({
      adapterId: "postgresql",
      engineProfile: "postgresql-postgis-local-single-primary",
    });
    expect(
      await resolveOutput(
        deployment.bindingOutputs["structured:orders.records"]!.bindingRef,
      ),
    ).toBe("orders-db");
  });

  it("delegates managed provisioning with an explicit provider", async () => {
    const provider = new TestProvider("managed-provider");
    let observedProvider: pulumi.ProviderResource | undefined;
    let observedParent: pulumi.Resource | undefined;
    const provisioner: ManagedEngineProvisionerV1 = {
      provision(_name, profile, request, options) {
        observedProvider = options.provider;
        observedParent = options.parent;
        expect(profile.id).toBe("postgresql-postgis-local-single-primary");
        expect(request.mode).toBe("managed");
        expect(request.topology).toBe("single-primary");
        return connectionInputs();
      },
    };
    const engine = new ManagedEngine("orders-managed", {
      binding: bindingArgs("postgresql-postgis-local-single-primary"),
      provider,
      provisioner,
      request: {
        target: "local-kubernetes",
        storage: { class: "local-path", sizeGiB: 20 },
        networkPolicy: { ingressFrom: ["orders"] },
        workloadIdentity: {
          provider: "workload-identity",
          reference: "orders-runtime",
        },
        acl: { provider: "policy-registry", reference: "orders-acl" },
        tls: {
          mode: "server",
          serverName: "postgres.example",
          caRef: {
            provider: "secret-manager",
            reference: "orders/postgres-ca",
          },
          clientCertificateRef: null,
        },
        observability: { enabled: false, labels: { service: "orders" } },
      },
    });
    expect(observedProvider).toBe(provider);
    expect(observedParent).toBe(engine);
    expect(pulumi.resourceType(engine)).toBe("meridian:storage:ManagedEngine");
    expect(await resolveOutput(engine.engineVersion)).toBe("17-postgis-3.5");
  });

  it("delegates lifecycle and Collector resources without creating providers", async () => {
    const provider = new TestProvider("workload-provider");
    const jobProvisioner: LifecycleJobProvisionerV1 = {
      provision(_name, spec, options) {
        expect(options.provider).toBe(provider);
        return { kind: spec.kind, accepted: true };
      },
    };
    const job = new MeridianLifecycleJob("orders-migration", {
      spec: migrationJob({
        image: digestImage,
        resources: [ordersRequirement.selector],
        fromFingerprint: fingerprintA,
        toFingerprint: fingerprintB,
      }),
      provider,
      provisioner: jobProvisioner,
    });
    expect(await resolveOutput(job.specFingerprint)).toMatch(/^sha256:/);
    expect(pulumi.resourceType(job)).toBe("meridian:storage:LifecycleJob");

    const collectorProvisioner: CollectorProvisionerV1 = {
      provision(_name, _spec, options) {
        expect(options.provider).toBe(provider);
        return {
          endpoint: "http://otel-collector:4317",
          healthEndpoint: "http://otel-collector:13133",
        };
      },
    };
    const collector = new MeridianOtelCollector("orders-otel", {
      provider,
      provisioner: collectorProvisioner,
      spec: createOtelCollectorSpec({
        mode: "sidecar",
        image: digestImage,
        config: {
          receivers: { otlp: {} },
          processors: { batch: {} },
          exporters: { otlp: {} },
          service: { pipelines: { traces: {} } },
        },
        protocol: "grpc",
        signals: ["traces"],
        tls: {
          mode: "disabled",
          serverName: null,
          caRef: null,
          clientCertificateRef: null,
        },
        batchingSamplingFingerprint: fingerprintA,
        backendReadPlacement: {
          catalog: "evidence",
          namespace: "telemetry",
          name: "signals",
        },
      }),
    });
    expect(await resolveOutput(collector.endpoint)).toBe(
      "http://otel-collector:4317",
    );
    expect(pulumi.resourceType(collector)).toBe(
      "meridian:storage:OtelCollector",
    );
    const telemetry = await resolveOutput(
      collector.runtimeCapability({
        serviceName: "orders",
        attributes: { environment: "test" },
      }),
    );
    expect(telemetry).toMatchObject({
      enabled: true,
      serviceName: "orders",
      suppressExporterRecursion: true,
      extensions: {
        "org.meridian.constructs/otelCollector": {
          endpoint: "http://otel-collector:4317",
          protocol: "grpc",
          signals: ["traces"],
          backendReadPlacement: {
            catalog: "evidence",
            namespace: "telemetry",
            name: "signals",
          },
        },
      },
    });
    const engine = new ExternalEngine("telemetry-orders-engine", {
      binding: bindingArgs("postgresql-postgis-local-single-primary"),
      connection: connectionInputs(),
    });
    const deployment = new MeridianDeployment("telemetry-orders", {
      profile: "test",
      catalogs,
      schemaProviders,
      resources: [ordersRequirement],
      engines: [engine],
      placements: [placement],
      telemetry: collector.runtimeCapability({ serviceName: "orders" }),
    });
    expect(await resolveOutput(deployment.runtimeConfigJson)).toContain(
      '"endpoint":"http://otel-collector:4317"',
    );
  });

  it("registers only caller-supplied providers", () => {
    expect(
      resources.filter((resource) =>
        resource.type.startsWith("pulumi:providers:"),
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      resources.some(
        (resource) =>
          resource.type.startsWith("pulumi:providers:") &&
          ![
            "managed-provider",
            "workload-provider",
            "validation-provider",
          ].includes(resource.name),
      ),
    ).toBe(false);
  });

  it("fails synchronously without explicit providers or pinned selections", () => {
    const managedProvisioner: ManagedEngineProvisionerV1 = {
      provision: () => connectionInputs(),
    };
    expect(
      () =>
        new ManagedEngine("missing-managed-provider", {
          binding: bindingArgs("postgresql-postgis-local-single-primary"),
          provider: undefined as never,
          provisioner: managedProvisioner,
          request: {
            target: "local-kubernetes",
            networkPolicy: {},
            workloadIdentity: {
              provider: "workload-identity",
              reference: "orders-runtime",
            },
            acl: { provider: "policy-registry", reference: "orders-acl" },
            tls: {
              mode: "server",
              serverName: "postgres.example",
              caRef: {
                provider: "secret-manager",
                reference: "orders/postgres-ca",
              },
              clientCertificateRef: null,
            },
            observability: { enabled: false, labels: { service: "orders" } },
          },
        }),
    ).toThrow(/explicit provider/);

    const jobProvisioner: LifecycleJobProvisionerV1 = {
      provision: () => ({}),
    };
    expect(
      () =>
        new MeridianLifecycleJob("missing-job-provider", {
          spec: migrationJob({
            image: digestImage,
            resources: [ordersRequirement.selector],
            fromFingerprint: fingerprintA,
            toFingerprint: fingerprintB,
          }),
          provider: undefined as never,
          provisioner: jobProvisioner,
        }),
    ).toThrow(/explicit provider/);

    const collectorProvisioner: CollectorProvisionerV1 = {
      provision: () => ({ endpoint: "unused", healthEndpoint: "unused" }),
    };
    expect(
      () =>
        new MeridianOtelCollector("missing-collector-provider", {
          provider: undefined as never,
          provisioner: collectorProvisioner,
          spec: createOtelCollectorSpec({
            mode: "sidecar",
            image: digestImage,
            config: {
              receivers: { otlp: {} },
              processors: { batch: {} },
              exporters: { otlp: {} },
              service: { pipelines: { traces: {} } },
            },
            protocol: "grpc",
            signals: ["traces"],
            tls: {
              mode: "disabled",
              serverName: null,
              caRef: null,
              clientCertificateRef: null,
            },
            batchingSamplingFingerprint: fingerprintA,
            backendReadPlacement: {
              catalog: "evidence",
              namespace: "telemetry",
              name: "signals",
            },
          }),
        }),
    ).toThrow(/explicit provider/);

    expect(
      () =>
        new ExternalEngine("unsupported-engine-version", {
          binding: {
            ...bindingArgs("postgresql-postgis-local-single-primary"),
            engineVersion: "0",
          },
          connection: connectionInputs(),
        }),
    ).toThrow(/does not support Engine/);

    const validationProvider = new TestProvider("validation-provider");
    expect(
      () =>
        new ManagedEngine("missing-storage-policy", {
          binding: bindingArgs("postgresql-postgis-cluster"),
          provider: validationProvider,
          provisioner: managedProvisioner,
          request: {
            target: "production-kubernetes",
            networkPolicy: {},
            workloadIdentity: {
              provider: "workload-identity",
              reference: "orders-runtime",
            },
            acl: { provider: "policy-registry", reference: "orders-acl" },
            tls: {
              mode: "server",
              serverName: "postgres.example",
              caRef: {
                provider: "secret-manager",
                reference: "orders/postgres-ca",
              },
              clientCertificateRef: null,
            },
            observability: {
              enabled: false,
              labels: { service: "orders" },
            },
          },
        }),
    ).toThrow(/requires an explicit storage policy/);

    expect(
      () =>
        new ExternalEngine("plaintext-production-engine", {
          binding: bindingArgs("postgresql-postgis-cluster"),
          connection: {
            ...connectionInputs(),
            tls: {
              mode: "disabled",
            },
          },
        }),
    ).toThrow(/requires authenticated TLS/);
  });
});

async function resolveOutput<T>(output: pulumi.Output<T>): Promise<T> {
  return await new Promise<T>((resolve) => {
    output.apply((value) => {
      resolve(value);
      return value;
    });
  });
}
