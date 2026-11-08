// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import { readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { afterAll } from "vitest";

/*
 * Run before every test file of a mutation run only (stryker.vitest.config.ts). npm test removes its
 * temporary directory when the run ends (see test/global-setup.ts). Under Stryker one vitest run
 * lasts as long as its worker, through thousands of mutants, and what each test file made there
 * piled up until the run ended: about 4 GB per worker in half an hour of static mutants, and the
 * disk filled. So what a test file made goes as soon as the file is done.
 */
afterAll(() => {
  const root = process.env.TMPDIR;
  if (root === undefined || !basename(root).startsWith("mcpcage-vitest-")) return;
  for (const name of readdirSync(root)) rmSync(join(root, name), { recursive: true, force: true, maxRetries: 3 });
});
