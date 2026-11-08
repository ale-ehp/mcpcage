// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import { configDefaults, defineConfig } from "vitest/config";

// Most tests start the CLI as a process, and some build and start containers. On a busy machine a
// single `mcpcage protect` scan can take more than vitest's default 5 seconds, which made tests
// fail with a timeout while nothing was wrong. The limit here is for the slowest honest run.
export default defineConfig({
  test: {
    // One temporary directory for the whole run, removed at its end (see test/global-setup.ts).
    globalSetup: ["test/global-setup.ts"],
    // A copy of the project that a mutation run left behind (npm run mutation) is not more tests.
    exclude: [...configDefaults.exclude, ".stryker-tmp/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Read only with --coverage (npm run test:coverage, which CI runs on Linux). Code that a test
    // runs through dist/cli.js in a child process is not counted (cli.ts reads 0%), so the numbers
    // are a floor. Statements must stay at 80% or more; the other thresholds sit a few points under
    // the measure (88.65% statements, 85.39% branches, 92.1% functions, 89.8% lines in November
    // 2026) to leave room for branches taken only on another platform.
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text", "text-summary"],
      thresholds: { statements: 80, branches: 80, functions: 85, lines: 85 },
    },
  },
});
