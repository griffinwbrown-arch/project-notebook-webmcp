/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: [
    "src/domain/note.ts",
    "src/indexeddb/database.ts",
    "src/indexeddb/workspace-repository.ts",
    "src/workspace/controller.ts",
  ],
  testRunner: "vitest",
  vitest: {
    configFile: "vitest.config.ts",
  },
  testFiles: [
    "tests/unit/core/phase2-domain.test.ts",
    "tests/unit/core/phase2-indexeddb.test.ts",
    "tests/unit/core/phase2-coverage.test.ts",
    "tests/unit/workspace/phase2-controller.test.ts",
    "tests/unit/workspace/phase2-controller-coverage.test.ts",
    "tests/unit/workspace/controller.test.ts",
  ],
  reporters: ["clear-text", "progress", "html", "json"],
  thresholds: { high: 90, low: 80, break: 0 },
  coverageAnalysis: "perTest",
  concurrency: 8,
  timeoutMS: 15000,
  tempDirName: ".stryker-phase2-tmp",
  htmlReporter: { fileName: "artifacts/mutation-phase2/index.html" },
  jsonReporter: { fileName: "artifacts/mutation-phase2/mutation.json" },
  logLevel: "info",
};

export default config;
