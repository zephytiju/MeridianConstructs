// SPDX-License-Identifier: Apache-2.0
import { cpSync } from "node:fs";
cpSync("src/jobs/projection/assets", "dist/jobs/projection/assets", {
  recursive: true,
});
