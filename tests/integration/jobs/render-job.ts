// SPDX-License-Identifier: Apache-2.0
import { writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { durableProjectionJob, projectionHostFiles } = (await import(
  pathToFileURL(process.env.CONSTRUCTS_MODULE!).href
)) as typeof import("../../../src/index.js");
let source = "";
for await (const chunk of process.stdin) source += String(chunk);
const input = JSON.parse(source) as {
  args: import("../../../src/index.js").DurableProjectionJobInputV1;
  assets: string;
};
const job = durableProjectionJob(input.args);
mkdirSync(input.assets, { recursive: true });
for (const [name, content] of Object.entries(projectionHostFiles()))
  writeFileSync(`${input.assets}/${name}`, content);
process.stdout.write(JSON.stringify(job));
