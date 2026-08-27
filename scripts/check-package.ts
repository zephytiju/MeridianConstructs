// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface PackFile {
  readonly path: string;
}

interface PackResult {
  readonly name: string;
  readonly version: string;
  readonly files: readonly PackFile[];
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  readonly name: string;
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly workspaces?: unknown;
};
if (
  packageJson.name !== "meridian-storage-iac" ||
  packageJson.version !== "1.0.0"
) {
  throw new Error(
    "The repository must publish only meridian-storage-iac@1.0.0",
  );
}
if (packageJson.workspaces !== undefined) {
  throw new Error(
    "MeridianConstructs must not be an npm workspace or monorepo",
  );
}
if (
  Object.keys(packageJson.dependencies).some(
    (name) => name.includes("kafka") || name.includes("adapter"),
  )
) {
  throw new Error(
    "The TypeScript construct package must not depend on Adapter or Kafka packages",
  );
}

const result = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
  }),
) as readonly PackResult[];
const pack = result[0];
if (pack?.name !== packageJson.name || pack?.version !== packageJson.version) {
  throw new Error("npm pack returned an unexpected package identity");
}
const files = new Set(pack.files.map((item) => item.path));
for (const required of [
  "LICENSE",
  "NOTICE",
  "README.md",
  "contracts/compatibility.v1.json",
  "contracts/meridian-config.v1.schema.json",
  "dist/index.d.ts",
  "dist/index.js",
]) {
  if (!files.has(required)) {
    throw new Error(`npm package is missing ${required}`);
  }
}
if (
  [...files].some(
    (path) =>
      path.endsWith(".py") ||
      path.endsWith(".whl") ||
      path.endsWith(".tar.gz") ||
      path.includes("meridian_constructs") ||
      path === "pyproject.toml",
  )
) {
  throw new Error(
    "npm package unexpectedly contains the superseded Python implementation",
  );
}
