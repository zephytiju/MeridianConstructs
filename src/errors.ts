// SPDX-License-Identifier: Apache-2.0

export const constructErrorCodes = {
  ambiguousPlacement: "MERIDIAN_CONSTRUCTS_AMBIGUOUS_PLACEMENT",
  duplicateBinding: "MERIDIAN_CONSTRUCTS_DUPLICATE_BINDING",
  duplicatePlacement: "MERIDIAN_CONSTRUCTS_DUPLICATE_PLACEMENT",
  duplicateResource: "MERIDIAN_CONSTRUCTS_DUPLICATE_RESOURCE",
  incompatibleCatalog: "MERIDIAN_CONSTRUCTS_INCOMPATIBLE_CATALOG",
  incompatibleGuarantee: "MERIDIAN_CONSTRUCTS_INCOMPATIBLE_GUARANTEE",
  incompatibleOperation: "MERIDIAN_CONSTRUCTS_INCOMPATIBLE_OPERATION",
  invalidEndpoint: "MERIDIAN_CONSTRUCTS_INVALID_ENDPOINT",
  invalidInput: "MERIDIAN_CONSTRUCTS_INVALID_INPUT",
  invalidReference: "MERIDIAN_CONSTRUCTS_INVALID_REFERENCE",
  limitExceeded: "MERIDIAN_CONSTRUCTS_LIMIT_EXCEEDED",
  missingPlacement: "MERIDIAN_CONSTRUCTS_MISSING_PLACEMENT",
  profileNotFound: "MERIDIAN_CONSTRUCTS_PROFILE_NOT_FOUND",
  providerRequired: "MERIDIAN_CONSTRUCTS_PROVIDER_REQUIRED",
  secretMaterial: "MERIDIAN_CONSTRUCTS_SECRET_MATERIAL",
  versionNotPinned: "MERIDIAN_CONSTRUCTS_VERSION_NOT_PINNED",
} as const;

export type ConstructErrorCode =
  (typeof constructErrorCodes)[keyof typeof constructErrorCodes];

export class MeridianConstructError extends Error {
  public constructor(
    public readonly code: ConstructErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "MeridianConstructError";
  }
}
