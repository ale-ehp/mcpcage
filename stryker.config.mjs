// @ts-check
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
/*
 * Mutation testing (npm run mutation): Stryker changes the code of src/ in small ways, one change at a
 * time (a `<` into `<=`, a condition into `true`, a string emptied), and runs the tests that reach the
 * change; a mutant no test notices is reported as survived.
 *
 * What it cannot see: the Docker tests (test/*.docker.test.ts) are left out, they need a Docker daemon
 * and take minutes per run. And many tests start the CLI as a process, dist/cli.js, which is built
 * from src/ unchanged: only what the tests run in their own process is mutated, so code that only
 * those processes reach counts as "no coverage".
 */
/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  // Forks, as npm test runs them: in the worker threads the runner uses by default, os.homedir() does
  // not see the HOME a test sets, and the tests of ~/ paths fail before any mutant.
  vitest: { configFile: "stryker.vitest.config.ts", pool: "forks" },
  // Each mutant runs only the tests that reached it; incremental mode reuses the results of mutants
  // and tests that have not changed since the last run (reports/stryker-incremental.json). It also
  // reuses the result of a static mutant (one that runs only as its module loads, such as a table of
  // names) after tests were added that would kill it: --force measures everything again.
  coverageAnalysis: "perTest",
  incremental: true,
  // Other work runs on the machine (Docker, other tests): two test processes at a time by default,
  // --concurrency to change it.
  concurrency: 2,
  // A slow test on a busy machine is not a mutant that hangs.
  timeoutMS: 10_000,
  mutate: ["src/**/*.ts"],
  // Stryker reads tsconfig.json with TypeScript's JavaScript API, which TypeScript 7 no longer has,
  // only to rewrite paths that point out of its sandbox: there are none here, so it is given no file.
  tsconfigFile: "no-tsconfig-to-rewrite.json",
  reporters: ["clear-text", "progress", "html", "json"],
  // The mutants that survived, not the long list of tests that reached no mutant.
  clearTextReporter: { logTests: false },
  htmlReporter: { fileName: "reports/mutation/mutation.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  thresholds: { high: 80, low: 60, break: null },
};
