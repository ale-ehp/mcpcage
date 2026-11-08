// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
// The mutation score of each file in Stryker's JSON report (npm run mutation), as a Markdown table:
// the job summary of the mutation workflow, and the numbers in the README.
//
//   node test/mutation-score.mjs [reports/mutation/mutation.json]
//
// The score is Stryker's: mutants detected (killed, or timed out) out of all those that ran or no test
// reached; "covered" leaves out the ones no test reached. A mutant that does not compile or cannot run
// counts in neither.
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2] ?? "reports/mutation/mutation.json", "utf8"));

function count(mutants) {
  const by = (status) => mutants.filter((mutant) => mutant.status === status).length;
  const killed = by("Killed");
  const timeout = by("Timeout");
  const survived = by("Survived");
  const noCoverage = by("NoCoverage");
  const errors = by("RuntimeError") + by("CompileError");
  const detected = killed + timeout;
  return { killed, timeout, survived, noCoverage, errors, score: percent(detected, detected + survived + noCoverage), covered: percent(detected, detected + survived) };
}

function percent(part, whole) {
  return whole === 0 ? "n/a" : `${((100 * part) / whole).toFixed(2)}%`;
}

function row(name, c) {
  return `| ${name} | ${c.score} | ${c.covered} | ${c.killed} | ${c.timeout} | ${c.survived} | ${c.noCoverage} | ${c.errors} |`;
}

const files = Object.keys(report.files).sort();
const lines = [
  "| File | Score | Covered | Killed | Timeout | Survived | No coverage | Errors |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...files.map((name) => row(name, count(report.files[name].mutants))),
  row("**All files**", count(files.flatMap((name) => report.files[name].mutants))),
];
process.stdout.write(`${lines.join("\n")}\n`);
