// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["src/index.ts"],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json", "lcov", "cobertura"],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
    include: ["tests/**/*.test.ts"],
  },
});
