/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: [
    "src/workspace/history.ts",
    "src/workspace/controller.ts",
    "src/entries/desk/notebook-page-state.ts",
  ],
  testRunner: "vitest",
  vitest: { configFile: "vitest.workspace.config.ts" },
  reporters: ["clear-text", "progress", "html", "json"],
  thresholds: { high: 90, low: 80, break: 0 },
  coverageAnalysis: "perTest",
  tempDirName: ".stryker-workspace-tmp",
  htmlReporter: { fileName: "artifacts/mutation-workspace/index.html" },
  jsonReporter: { fileName: "artifacts/mutation-workspace/mutation.json" },
};

export default config;
