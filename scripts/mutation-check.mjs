import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  APP_ROOT,
  BATCHES,
  EXECUTABLE_SOURCE_FILES,
  MUTATION_BREAK_FLOORS,
  MUTATION_THRESHOLDS,
  appWideSourceAudit,
} from "./mutation-batches.mjs";

const failures = [];
const expectedSourceFiles = new Set(EXECUTABLE_SOURCE_FILES);
const audit = appWideSourceAudit();

if (audit.duplicateAssignments.length > 0) {
  for (const { sourceFile, owners } of audit.duplicateAssignments) {
    failures.push(`${sourceFile} is assigned to multiple batches: ${owners.join(", ")}`);
  }
}

if (audit.omittedFiles.length > 0) {
  failures.push(`Executable source files are not assigned to a batch: ${audit.omittedFiles.join(", ")}`);
}

if (audit.unknownFiles.length > 0) {
  failures.push(`Mutation batches name files outside executable src: ${audit.unknownFiles.join(", ")}`);
}

const reportDirectories = new Set();
const tempDirectories = new Set();

for (const batch of BATCHES) {
  if (!existsSync(resolve(APP_ROOT, batch.configFile))) {
    failures.push(`${batch.id} is missing ${batch.configFile}`);
  }
  if (reportDirectories.has(batch.reportDirectory)) {
    failures.push(`${batch.id} reuses report directory ${batch.reportDirectory}`);
  }
  reportDirectories.add(batch.reportDirectory);
  if (tempDirectories.has(batch.tempDirName)) {
    failures.push(`${batch.id} reuses temp directory ${batch.tempDirName}`);
  }
  tempDirectories.add(batch.tempDirName);

  const config = await import(`../${batch.configFile}`);
  const options = config.default;
  const thresholdMatches = Object.entries(MUTATION_THRESHOLDS).every(
    ([key, value]) => options.thresholds?.[key] === value,
  );
  if (!thresholdMatches) {
    failures.push(`${batch.configFile} does not use the declared mutation thresholds`);
  }
  if (options.thresholds?.break !== MUTATION_BREAK_FLOORS[batch.id]) {
    failures.push(`${batch.configFile} does not use the measured ${batch.id} break floor`);
  }
  if (options.testRunner !== "vitest") failures.push(`${batch.configFile} must use the Vitest runner`);
  if (options.coverageAnalysis !== "perTest") failures.push(`${batch.configFile} must use per-test coverage analysis`);
  if (!options.plugins?.includes("@stryker-mutator/vitest-runner")) {
    failures.push(`${batch.configFile} must load the Vitest Stryker plugin`);
  }

  const configuredSourceFiles = new Set(options.mutate ?? []);
  const expectedBatchSourceFiles = new Set(batch.sourceFiles);
  const missing = [...expectedBatchSourceFiles].filter((file) => !configuredSourceFiles.has(file));
  const extra = [...configuredSourceFiles].filter((file) => !expectedBatchSourceFiles.has(file));
  if (missing.length > 0) failures.push(`${batch.configFile} omits ${missing.join(", ")}`);
  if (extra.length > 0) failures.push(`${batch.configFile} adds unmanifested files ${extra.join(", ")}`);
  for (const testFile of batch.testFiles) {
    if (!testFile.startsWith("tests/unit/")) failures.push(`${batch.configFile} includes a non-unit test path: ${testFile}`);
  }
}

if (new Set(audit.assignedFiles).size !== expectedSourceFiles.size) {
  failures.push("App-wide mutation assignment count does not match executable source count");
}

if (failures.length > 0) {
  console.error("Mutation configuration check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Mutation configuration OK: ${BATCHES.length} batches cover ${EXECUTABLE_SOURCE_FILES.length} executable src files with no overlap.`);
  console.log("Excluded declarations: src/types/**/*.d.ts");
}
