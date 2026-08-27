// SPDX-License-Identifier: Apache-2.0

import type * as pulumi from "@pulumi/pulumi";
import { describe, expectTypeOf, it } from "vitest";
import type {
  AclPolicyRef,
  MeridianBindingOutputV1,
  MeridianCapabilityV1,
  MeridianResourceRequirementV1,
  MigrationStateV1,
  ObservabilityBindingV1,
  OpaqueIdentityRef,
  OpaqueSecretRef,
  RecoveryCapabilityV1,
  ResourceSelectorV1,
  TlsPolicy,
} from "../../src/index.js";

describe("locked revision 62 public interfaces", () => {
  it("keeps only deployment-resolved Binding fields as Pulumi Outputs", () => {
    expectTypeOf<MeridianBindingOutputV1["bindingRef"]>().toEqualTypeOf<
      pulumi.Output<string>
    >();
    expectTypeOf<MeridianBindingOutputV1["engineVersion"]>().toEqualTypeOf<
      pulumi.Output<string>
    >();
    expectTypeOf<MeridianBindingOutputV1["endpoint"]>().toEqualTypeOf<
      pulumi.Output<string>
    >();
    expectTypeOf<MeridianBindingOutputV1["physicalNamespace"]>().toEqualTypeOf<
      pulumi.Output<string>
    >();

    expectTypeOf<
      MeridianBindingOutputV1["identity"]
    >().toEqualTypeOf<OpaqueIdentityRef>();
    expectTypeOf<
      MeridianBindingOutputV1["credentials"]
    >().toEqualTypeOf<OpaqueSecretRef>();
    expectTypeOf<MeridianBindingOutputV1["tls"]>().toEqualTypeOf<TlsPolicy>();
    expectTypeOf<
      MeridianBindingOutputV1["acl"]
    >().toEqualTypeOf<AclPolicyRef>();
    expectTypeOf<
      MeridianBindingOutputV1["migration"]
    >().toEqualTypeOf<MigrationStateV1>();
    expectTypeOf<
      MeridianBindingOutputV1["observability"]
    >().toEqualTypeOf<ObservabilityBindingV1>();
    expectTypeOf<MeridianBindingOutputV1["recovery"]>().toEqualTypeOf<
      RecoveryCapabilityV1 | undefined
    >();
  });

  it("preserves the mapping-first Resource and Capability contracts", () => {
    expectTypeOf<
      MeridianResourceRequirementV1["selector"]
    >().toEqualTypeOf<ResourceSelectorV1>();
    expectTypeOf<MeridianResourceRequirementV1["operations"]>().toExtend<
      readonly unknown[]
    >();
    expectTypeOf<
      MeridianCapabilityV1["operationContract"]
    >().toEqualTypeOf<string>();
    expectTypeOf<MeridianCapabilityV1["fingerprint"]>().toEqualTypeOf<string>();
  });
});
