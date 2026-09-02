import { defineConfig, devices } from "@playwright/test";
import { isAbsolute, relative, resolve, sep } from "node:path";

const port = Number.parseInt(process.env.ANATOMY_ACCEPTANCE_PORT ?? "3342", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("ANATOMY_ACCEPTANCE_PORT must be an integer between 1 and 65535.");
}

const baseURL = `http://127.0.0.1:${port}`;
const artifactRoot = process.env.ANATOMY_ACCEPTANCE_ARTIFACT_DIR;
if (artifactRoot === undefined || artifactRoot.trim().length === 0) {
  throw new Error("ANATOMY_ACCEPTANCE_ARTIFACT_DIR must point outside the application repository.");
}
const artifactRelativeToRepository = relative(process.cwd(), artifactRoot);
const artifactIsOutsideRepository = artifactRelativeToRepository === ".."
  || artifactRelativeToRepository.startsWith(`..${sep}`)
  || isAbsolute(artifactRelativeToRepository);
if (!artifactIsOutsideRepository) {
  throw new Error("ANATOMY_ACCEPTANCE_ARTIFACT_DIR must stay outside the application repository.");
}
process.env.ANATOMY_ACCEPTANCE_RUN = "1";

export default defineConfig({
  testDir: "../tests/e2e",
  testMatch: /(?:anatomy-atlas(?:-performance)?|anatomy-surface-paint)\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [
    ["list"],
    ["json", { outputFile: resolve(artifactRoot, "playwright-results.json") }],
    ["html", { open: "never", outputFolder: resolve(artifactRoot, "report") }],
  ],
  use: {
    baseURL,
    serviceWorkers: "allow",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "anatomy-desktop",
      grep: /@desktop/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "anatomy-mobile",
      grep: /@mobile/,
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  outputDir: resolve(artifactRoot, "test-output"),
});
