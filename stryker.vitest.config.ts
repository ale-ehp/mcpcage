// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";

// The tests Stryker runs against each mutant: those of npm test, without the Docker ones, which need a
// Docker daemon and take minutes per run (see stryker.config.mjs), and with what each test file made
// in the run's temporary directory removed once it is done (see test/mutation-setup.ts). The code they
// test is instrumented and runs many times slower: the tests that measure how long it takes allow
// for it (SLOWER in test/helpers.ts), and every test may take ten times as long.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      exclude: ["test/**/*.docker.test.ts"],
      setupFiles: ["test/mutation-setup.ts"],
      env: { MCPCAGE_MUTATION_RUN: "1" },
      testTimeout: 300_000,
      hookTimeout: 300_000,
    },
  }),
);
