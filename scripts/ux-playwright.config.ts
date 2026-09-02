import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const port = 3217;
const baseURL = `http://127.0.0.1:${port}`;
const mobileUserAgent = devices["Pixel 7"].userAgent;
const artifactRoot = process.env.UX_ARTIFACT_DIR
  ?? resolve(process.cwd(), "..", "project-notebook-ui-ux-results");
process.env.CHROME_LOG_FILE ??= resolve(artifactRoot, "chromium-debug.log");

export default defineConfig({
  testDir: "../tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.002,
    },
  },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: resolve(artifactRoot, "report") }],
  ],
  use: {
    baseURL,
    trace: process.env.UX_LIGHTWEIGHT_RUN === "1" ? "off" : "retain-on-failure",
    screenshot: "only-on-failure",
    video: process.env.UX_LIGHTWEIGHT_RUN === "1" ? "off" : "retain-on-failure",
  },
  projects: [
    {
      name: "ux-desktop-1280",
      use: {
        browserName: "chromium",
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: "ux-mobile-390",
      use: {
        browserName: "chromium",
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true,
        userAgent: mobileUserAgent,
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: "ux-mobile-320",
      use: {
        browserName: "chromium",
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true,
        userAgent: mobileUserAgent,
        viewport: { width: 320, height: 720 },
      },
    },
    {
      name: "ux-mobile-short-320",
      use: {
        browserName: "chromium",
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true,
        userAgent: mobileUserAgent,
        viewport: { width: 320, height: 568 },
      },
    },
    {
      name: "ux-mobile-landscape-844",
      use: {
        browserName: "chromium",
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true,
        userAgent: mobileUserAgent,
        viewport: { width: 844, height: 390 },
      },
    },
    {
      name: "ux-mobile-landscape-short",
      use: {
        browserName: "chromium",
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true,
        userAgent: mobileUserAgent,
        viewport: { width: 568, height: 320 },
      },
    },
  ],
  webServer: {
    command: `"${process.execPath}" node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port ${port}`,
    cwd: "..",
    url: baseURL,
    reuseExistingServer: process.env.UX_REUSE_SERVER === "1",
    timeout: 120_000,
  },
  outputDir: resolve(artifactRoot, "results"),
});
