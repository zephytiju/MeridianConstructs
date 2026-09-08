// SPDX-License-Identifier: Apache-2.0
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const target = process.env.CONSTRUCTS_MODULE;
if (!target?.includes("node_modules/"))
  throw new Error("CONSTRUCTS_MODULE must select an installed package");
const {
  createClickHouseTelemetryPlan,
  telemetryFields,
}: typeof import("../../../src/index.js") = await import(
  pathToFileURL(resolve(target)).href
);
let source = "";
for await (const chunk of process.stdin) source += String(chunk);
const input = JSON.parse(source) as {
  command?: "fields";
  input: import("../../../src/index.js").ClickHouseTelemetryInput;
};
process.stdout.write(
  JSON.stringify(
    input.command === "fields"
      ? Object.fromEntries(
          (["log", "span", "metric"] as const).map((p) => [
            p,
            telemetryFields(p),
          ]),
        )
      : createClickHouseTelemetryPlan(input.input),
  ),
);
