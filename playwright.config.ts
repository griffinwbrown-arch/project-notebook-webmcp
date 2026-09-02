import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: /ux-(?:smoke|placement-responsive)\.spec\.ts/,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "artifacts/playwright-report" }]],
  use: {
    baseURL: "http://127.0.0.1:3211",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command:
      `"${process.execPath}" node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3211`,
    url: "http://127.0.0.1:3211",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  outputDir: "artifacts/playwright-results",
});
