// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fingerprint, normalizeJson } from "../canonical.js";
import type { BindingSpecV1 } from "../contracts/index.js";
import { rejectSecretMaterial } from "../contracts/index.js";
import { MeridianConstructError, constructErrorCodes } from "../errors.js";
import type { EngineProfileV1, OperationCapabilityV1 } from "./index.js";

interface Manifest {
  readonly engineProfile: string;
  readonly engineVersion: string;
  readonly availableOperationContracts: readonly string[];
  readonly descriptor: {
    readonly adapterId: string;
    readonly adapterContractVersion: string;
    readonly supportedEngineVersions: Readonly<
      Record<string, readonly string[]>
    >;
    readonly capabilities: readonly {
      readonly operationContract: string;
      readonly operationVersions: readonly string[];
      readonly guarantees: readonly string[];
      readonly limits: Readonly<Record<string, number>>;
    }[];
  };
}

// Copied unchanged from the installed public Core 1.1.0 contract. This is
// planning evidence; Core still probes the Engine and verifies the same pin.
const schema = JSON.parse(
  readFileSync(
    new URL(
      "../../contracts/meridian-adapter-capabilities.v1.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as object;
const validate = new Ajv2020({
  allErrors: true,
  strict: true,
}).compile<Manifest>(schema);

export function selectedCapabilityProfile(
  binding: Pick<
    BindingSpecV1,
    | "id"
    | "engineVersion"
    | "requiredCapabilityFingerprint"
    | "capabilityManifest"
  >,
  profile: EngineProfileV1,
): EngineProfileV1 {
  if (binding.capabilityManifest === undefined) return profile;
  const manifest = normalizeJson(binding.capabilityManifest);
  rejectSecretMaterial(manifest, "CapabilityManifest");
  if (!validate(manifest)) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      `Binding ${binding.id} has an invalid public CapabilityManifest`,
    );
  }
  const descriptor = manifest.descriptor;
  if (
    fingerprint(manifest) !== binding.requiredCapabilityFingerprint ||
    manifest.engineProfile !== profile.engineProfile ||
    manifest.engineVersion !== binding.engineVersion ||
    descriptor.adapterId !== profile.adapterId ||
    descriptor.adapterContractVersion !== profile.adapterContract ||
    !Object.hasOwn(descriptor.supportedEngineVersions, profile.engineProfile)
  ) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      `Binding ${binding.id} CapabilityManifest identity, SPI or fingerprint differs from its deployment pin`,
    );
  }
  const operations: Record<string, OperationCapabilityV1> = {};
  for (const item of descriptor.capabilities) {
    if (Object.hasOwn(operations, item.operationContract)) {
      throw new MeridianConstructError(
        constructErrorCodes.invalidInput,
        `Binding ${binding.id} CapabilityManifest has duplicate Operations`,
      );
    }
    const body = {
      contract: item.operationContract,
      versions: Object.freeze([...item.operationVersions].sort()),
      guarantees: Object.freeze([...item.guarantees].sort()),
      limits: Object.freeze({ ...item.limits }),
    };
    operations[item.operationContract] = Object.freeze({
      ...body,
      fingerprint: fingerprint(body),
    });
  }
  if (
    manifest.availableOperationContracts.some(
      (contract) => !Object.hasOwn(operations, contract),
    )
  ) {
    throw new MeridianConstructError(
      constructErrorCodes.invalidInput,
      `Binding ${binding.id} exposes an Operation absent from its descriptor`,
    );
  }
  const { profileFingerprint: previousFingerprint, ...selection } = profile;
  void previousFingerprint;
  const body = {
    ...selection,
    operations: Object.freeze(
      Object.fromEntries(
        manifest.availableOperationContracts.map((contract) => [
          contract,
          operations[contract]!,
        ]),
      ),
    ),
  };
  return Object.freeze({ ...body, profileFingerprint: fingerprint(body) });
}
