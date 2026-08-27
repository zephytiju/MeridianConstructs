// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "../src/canonical.js";
import { compatibilityContract } from "../src/profiles/index.js";

const target = resolve("contracts/compatibility.v1.json");
const runtimeSchema = resolve("contracts/meridian-config.v1.schema.json");
const lockedRuntimeSchemaSha256 =
  "a7860792f5736315d68cc2295f4d206d0bbf6c735fdb73bdbbc381fb2814ae41";
const rendered = `${JSON.stringify(JSON.parse(canonicalJson(compatibilityContract())), null, 2)}\n`;

const observedRuntimeSchemaSha256 = createHash("sha256")
  .update(readFileSync(runtimeSchema))
  .digest("hex");
if (observedRuntimeSchemaSha256 !== lockedRuntimeSchemaSha256) {
  throw new Error(
    "contracts/meridian-config.v1.schema.json differs from the locked MeridianCore V1 schema",
  );
}

if (process.argv.includes("--write")) {
  writeFileSync(target, rendered, "utf8");
} else {
  const observed = readFileSync(target, "utf8");
  if (observed !== rendered) {
    throw new Error("contracts/compatibility.v1.json is not synchronized");
  }
}
