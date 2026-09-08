// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  compatibilityContract,
  runtimeConfigContract,
} from "../../src/index.js";

describe("one repository, one TypeScript package", () => {
  it("owns only the Apache-2.0 @zephytiju/meridian-storage-constructs distribution", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      name: string;
      version: string;
      license: string;
      workspaces?: unknown;
      dependencies: Record<string, string>;
      publishConfig: { access: string; provenance: boolean };
    };
    expect(packageJson).toMatchObject({
      name: "@zephytiju/meridian-storage-constructs",
      version: "1.3.0",
      license: "Apache-2.0",
      publishConfig: { access: "public", provenance: true },
    });
    expect(packageJson.workspaces).toBeUndefined();
    expect(packageJson.dependencies).toEqual({
      "@pulumi/pulumi": "3.257.0",
      ajv: "8.20.0",
    });
    expect(readFileSync("LICENSE", "utf8")).toContain("Apache License");
    expect(readFileSync("NOTICE", "utf8")).toContain("MeridianConstructs");
  });

  it("ships synchronized compatibility and runtime contracts", () => {
    const compatibility = JSON.parse(
      readFileSync("contracts/compatibility.v2.json", "utf8"),
    );
    const runtimeSchema = JSON.parse(
      readFileSync("contracts/meridian-config.v1.schema.json", "utf8"),
    );
    expect(canonicalJson(compatibility)).toBe(
      canonicalJson(compatibilityContract()),
    );
    expect(canonicalJson(runtimeSchema)).toBe(
      canonicalJson(runtimeConfigContract()),
    );
    expect(
      createHash("sha256")
        .update(readFileSync("contracts/meridian-config.v1.schema.json"))
        .digest("hex"),
    ).toBe("a7860792f5736315d68cc2295f4d206d0bbf6c735fdb73bdbbc381fb2814ae41");
  });

  it("contains only the three host assets, no Python distribution or Kafka import", () => {
    expect(existsSync("pyproject.toml")).toBe(false);
    expect(existsSync("setup.py")).toBe(false);
    // Include untracked files too: a git-only scan missed new assets locally.
    expect(sourceFiles("src", ".py").sort()).toEqual([
      "src/jobs/projection/assets/supervisor.py",
      "src/jobs/projection/assets/versioned_target.py",
      "src/jobs/projection/assets/worker.py",
    ]);
    const source = sourceFiles("src")
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(source).not.toMatch(
      /(?:from\s+|import\s*\(|require\s*\()\s*["'][^"']*(?:kafka|adapter)/i,
    );
  });
});

function sourceFiles(directory: string, extension = ".ts"): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path, extension);
    }
    return path.endsWith(extension) ? [path] : [];
  });
}
