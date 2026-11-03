import { defineConfig } from "vitest/config";

// Most tests start the CLI as a process, and some build and start containers. On a busy machine a
// single `mcpcage protect` scan can take more than vitest's default 5 seconds, which made tests
// fail with a timeout while nothing was wrong. The limit here is for the slowest honest run.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
