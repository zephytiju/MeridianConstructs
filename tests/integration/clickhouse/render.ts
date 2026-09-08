// SPDX-License-Identifier: Apache-2.0
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const target = process.env.CONSTRUCTS_MODULE;
if (!target?.includes("node_modules/"))
  throw new Error("CONSTRUCTS_MODULE must select an installed package");
const {
  createClickHouseTelemetryPlan,
  telemetryFields,
  planDeployment,
  getEngineProfile,
  disabledTelemetryCapability,
  defaultClientPolicy,
  defaultValidationPolicy,
  engineProfiles,
}: typeof import("../../../src/index.js") = await import(
  pathToFileURL(resolve(target)).href
);
let source = "";
for await (const chunk of process.stdin) source += String(chunk);
const input = JSON.parse(source) as {
  command?: "fields" | "defaults" | "deployment";
  input: import("../../../src/index.js").ClickHouseTelemetryInput;
  spec: import("../../../src/index.js").DeploymentSpecV1;
};
process.stdout.write(
  JSON.stringify(
    input.command === "defaults"
      ? {
          profile: getEngineProfile("clickhouse-standalone"),
          telemetry: disabledTelemetryCapability,
          client: defaultClientPolicy,
          validation: defaultValidationPolicy,
          profiles: engineProfiles,
        }
      : input.command === "deployment"
        ? planDeployment(input.spec)
        : input.command === "fields"
          ? Object.fromEntries(
              (["log", "span", "metric"] as const).map((p) => [
                p,
                telemetryFields(p),
              ]),
            )
          : createClickHouseTelemetryPlan(input.input),
  ),
);
