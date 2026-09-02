import { spawn } from "node:child_process";

import { resolve } from "node:path";

import { APP_ROOT, BATCHES, getBatch } from "./mutation-batches.mjs";
import { printMutationSummary } from "./mutation-summary.mjs";

const requestedBatch = process.argv[2] ?? "all";
const batches = requestedBatch === "all" ? BATCHES : [getBatch(requestedBatch)];
const strykerEntry = resolve(APP_ROOT, "node_modules/@stryker-mutator/core/bin/stryker.js");

function runBatch(batch) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [strykerEntry, "run", batch.configFile], {
      cwd: APP_ROOT,
      stdio: "inherit",
      windowsHide: true,
    });

    child.on("error", (error) => {
      resolveRun({ code: 1, error });
    });
    child.on("exit", (code, signal) => {
      resolveRun({ code: code ?? 1, signal });
    });
  });
}

const failures = [];

for (const batch of batches) {
  console.log(`\nMutation batch: ${batch.id} (${batch.sourceFiles.length} source files)`);
  const result = await runBatch(batch);
  if (result.error) {
    console.error(`Could not start ${batch.configFile}: ${result.error.message}`);
  }
  if (result.signal) {
    console.error(`${batch.id} stopped after signal ${result.signal}.`);
  }
  if (result.code !== 0) failures.push(batch.id);
}

if (failures.length > 0) {
  console.error(`\nMutation batches failed: ${failures.join(", ")}.`);
  process.exitCode = 1;
} else {
  console.log(`\nMutation batches complete: ${batches.map(({ id }) => id).join(", ")}.`);
  printMutationSummary(batches);
}
