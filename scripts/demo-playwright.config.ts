import { defineConfig, devices } from "@playwright/test";
import { isAbsolute, relative, resolve, sep } from "node:path";

const port = Number.parseInt(process.env.DEMO_ACCEPTANCE_PORT ?? "3350", 10);
const artifactRoot = process.env.DEMO_ACCEPTANCE_ARTIFACT_DIR;
if (artifactRoot === undefined || artifactRoot.trim().length === 0) {
  throw new Error("DEMO_ACCEPTANCE_ARTIFACT_DIR must point outside the application repository.");
}
const artifactRelative = relative(process.cwd(), artifactRoot);
if (!(artifactRelative === ".." || artifactRelative.startsWith(`..${sep}`) || isAbsolute(artifactRelative))) {
  throw new Error("DEMO_ACCEPTANCE_ARTIFACT_DIR must stay outside the application repository.");
}

export default defineConfig({
  testDir: "../tests/e2e",
  testMatch: /demo-judge\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 90_000,
  reporter: [["list"], ["json", { outputFile: resolve(artifactRoot, "results.json") }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "demo-desktop", grep: /@desktop/, use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "demo-mobile", grep: /@mobile/, use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
  ],
  outputDir: resolve(artifactRoot, "test-output"),
});
