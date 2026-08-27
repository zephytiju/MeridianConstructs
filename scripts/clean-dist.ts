// SPDX-License-Identifier: Apache-2.0

import { rmSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(".");
const distributionDirectory = resolve("dist");
if (distributionDirectory !== resolve(repositoryRoot, "dist")) {
  throw new Error("Refusing to clean an unexpected distribution directory");
}
rmSync(distributionDirectory, { recursive: true, force: true });
