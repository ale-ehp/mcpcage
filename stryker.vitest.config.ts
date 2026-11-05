import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";

// The tests Stryker runs against each mutant: those of npm test, without the Docker ones, which need a
// Docker daemon and take minutes per run (see stryker.config.mjs).
export default mergeConfig(base, defineConfig({ test: { exclude: ["test/**/*.docker.test.ts"] } }));
