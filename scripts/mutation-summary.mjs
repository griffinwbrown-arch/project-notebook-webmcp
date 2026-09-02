import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { APP_ROOT, BATCHES } from "./mutation-batches.mjs";

const SCORE_STATUSES = new Set(["Killed", "Timeout", "Survived", "NoCoverage"]);

function mutationScore(counts) {
  const denominator = counts.Killed + counts.Timeout + counts.Survived + counts.NoCoverage;
  return denominator === 0 ? 0 : 100 * (counts.Killed + counts.Timeout) / denominator;
}

function coveredScore(counts) {
  const denominator = counts.Killed + counts.Timeout + counts.Survived;
  return denominator === 0 ? 0 : 100 * (counts.Killed + counts.Timeout) / denominator;
}

function readBatchResult(batch) {
  const reportPath = resolve(APP_ROOT, batch.reportDirectory, "mutation.json");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const reportFiles = Object.keys(report.files).sort();
  const missing = batch.sourceFiles.filter((sourceFile) => !reportFiles.includes(sourceFile));
  const unexpected = reportFiles.filter((sourceFile) => !batch.sourceFiles.includes(sourceFile));
  if (unexpected.length > 0) {
    throw new Error(
      `${batch.id} report contains source outside its manifest: ${unexpected.join(", ")}.`,
    );
  }

  const counts = {
    Killed: 0,
    Timeout: 0,
    Survived: 0,
    NoCoverage: 0,
    Error: 0,
  };
  for (const file of Object.values(report.files)) {
    for (const mutant of file.mutants) {
      if (SCORE_STATUSES.has(mutant.status)) counts[mutant.status] += 1;
      else counts.Error += 1;
    }
  }

  return {
    batch: batch.id,
    filesWithoutMutants: missing.length,
    ...counts,
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    mutationScore: mutationScore(counts),
    coveredScore: coveredScore(counts),
  };
}

export function mutationSummary(batches = BATCHES) {
  const results = batches.map(readBatchResult);
  const aggregateCounts = results.reduce(
    (aggregate, result) => {
      for (const status of ["Killed", "Timeout", "Survived", "NoCoverage", "Error"]) {
        aggregate[status] += result[status];
      }
      return aggregate;
    },
    { Killed: 0, Timeout: 0, Survived: 0, NoCoverage: 0, Error: 0 },
  );
  return {
    results,
    aggregate: {
      ...aggregateCounts,
      total: Object.values(aggregateCounts).reduce((sum, count) => sum + count, 0),
      mutationScore: mutationScore(aggregateCounts),
      coveredScore: coveredScore(aggregateCounts),
    },
  };
}

export function printMutationSummary(batches = BATCHES) {
  const summary = mutationSummary(batches);
  console.table(summary.results.map((result) => ({
    batch: result.batch,
    zeroMutantFiles: result.filesWithoutMutants,
    mutants: result.total,
    killed: result.Killed,
    timeout: result.Timeout,
    survived: result.Survived,
    uncovered: result.NoCoverage,
    errors: result.Error,
    score: result.mutationScore.toFixed(2),
    covered: result.coveredScore.toFixed(2),
  })));
  console.log(`Mutation aggregate: ${JSON.stringify(summary.aggregate)}`);
  return summary;
}

if (process.argv[1] === import.meta.filename) printMutationSummary();
