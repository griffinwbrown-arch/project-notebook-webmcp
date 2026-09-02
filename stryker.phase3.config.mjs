/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  plugins: ["@stryker-mutator/vitest-runner"],
  // Phase 3's app-owned page authority. The tldraw adapter is a transient
  // projection, so mutation scope stays on the canonical writers and storage.
  mutate: [
    "src/page/domain.ts",
    "src/page/commands.ts",
    "src/indexeddb/page-storage.ts",
  ],
  testRunner: "vitest",
  vitest: {
    configFile: "vitest.config.ts",
  },
  testFiles: [
    "tests/unit/phase3/page-domain.test.ts",
    "tests/unit/phase3/page-commands.test.ts",
    "tests/unit/phase3/page-storage.test.ts",
    // Phase 2 regression coverage is required for the additive migration and
    // legacy-row preservation exercised by page storage.
    "tests/unit/core/phase2-domain.test.ts",
    "tests/unit/core/phase2-indexeddb.test.ts",
  ],
  reporters: ["clear-text", "progress", "html", "json"],
  thresholds: { high: 90, low: 80, break: 0 },
  coverageAnalysis: "perTest",
  concurrency: 8,
  timeoutMS: 15000,
  tempDirName: ".stryker-phase3-tmp",
  htmlReporter: { fileName: "artifacts/mutation-phase3/index.html" },
  jsonReporter: { fileName: "artifacts/mutation-phase3/mutation.json" },
  logLevel: "info",
};

export default config;
