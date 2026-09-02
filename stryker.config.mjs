/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: [
    "src/domain/**/*.ts",
    "src/commands/**/*.ts",
    "!src/**/*.d.ts",
  ],
  testRunner: "vitest",
  reporters: ["clear-text", "progress", "html", "json"],
  thresholds: { high: 90, low: 80, break: 80 },
  coverageAnalysis: "perTest",
  tempDirName: ".stryker-tmp",
  htmlReporter: { fileName: "artifacts/mutation/index.html" },
  jsonReporter: { fileName: "artifacts/mutation/mutation.json" },
};

export default config;
