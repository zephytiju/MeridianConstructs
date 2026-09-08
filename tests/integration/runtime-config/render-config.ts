// SPDX-License-Identifier: Apache-2.0
import { pathToFileURL } from "node:url";

// The module must come from an installed npm tarball, never the source checkout.
const modulePath = process.env.CONSTRUCTS_MODULE;
if (!modulePath?.includes("node_modules/"))
  throw new Error("CONSTRUCTS_MODULE must identify an installed package");
const constructs: typeof import("../../../src/index.js") = await import(
  pathToFileURL(modulePath).href
);
let source = "";
for await (const chunk of process.stdin) source += String(chunk);
const input = JSON.parse(source) as {
  command: "defaults" | "plan" | "validate";
  spec: import("../../../src/index.js").DeploymentSpecV1;
  config: unknown;
};
if (input.command === "defaults") {
  process.stdout.write(
    JSON.stringify({
      client: constructs.defaultClientPolicy,
      validation: constructs.defaultValidationPolicy,
      telemetry: constructs.disabledTelemetryCapability,
      profile: constructs.getEngineProfile(
        "postgresql-postgis-local-single-primary",
      ),
    }),
  );
} else if (input.command === "validate") {
  constructs.validateRuntimeConfig(input.config);
  process.stdout.write("{}");
} else {
  process.stdout.write(JSON.stringify(constructs.planDeployment(input.spec)));
}
