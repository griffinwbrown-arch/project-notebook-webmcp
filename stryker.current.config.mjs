/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: ["src/indexeddb/workspace-backup.ts"],
  testRunner: "vitest",
  vitest: { configFile: "vitest.config.ts" },
  testFiles: ["tests/unit/realignment/workspace-backup.test.ts"],
  reporters: ["clear-text", "progress", "html", "json"],
  thresholds: { high: 80, low: 50, break: 40 },
  coverageAnalysis: "perTest",
  concurrency: 4,
  timeoutMS: 15000,
  tempDirName: ".stryker-current-tmp",
  htmlReporter: { fileName: "artifacts/mutation-current/index.html" },
  jsonReporter: { fileName: "artifacts/mutation-current/mutation.json" },
};

export default config;
