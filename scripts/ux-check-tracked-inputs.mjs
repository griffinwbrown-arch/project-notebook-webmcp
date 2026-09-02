import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const trackedInputs = [
  "package.json",
  "playwright.config.ts",
  "scripts/ux-check-tracked-inputs.mjs",
  "scripts/ux-playwright.config.ts",
  "tests/e2e/ux-placement-responsive.spec.ts",
  "tests/e2e/ux-smoke.spec.ts",
  "tests/e2e/phase6-vector-ink.spec.ts",
  "tests/e2e/ux-smoke.spec.ts-snapshots/ux-add-menu-reachable-ux-desktop-1280-win32.png",
  "tests/e2e/ux-smoke.spec.ts-snapshots/ux-add-menu-reachable-ux-mobile-390-win32.png",
  "tests/e2e/ux-smoke.spec.ts-snapshots/ux-structured-editor-ux-desktop-1280-win32.png",
  "tests/e2e/ux-smoke.spec.ts-snapshots/ux-structured-editor-ux-mobile-390-win32.png",
  "tests/e2e/ux-smoke.spec.ts-snapshots/ux-add-menu-reachable-ux-mobile-landscape-short-win32.png",
  "tests/e2e/ux-smoke.spec.ts-snapshots/ux-structured-editor-ux-mobile-landscape-short-win32.png",
  "tests/helpers/phase11-contracts.ts",
  "tests/helpers/detailed-vector-ink-fixture.ts",
  "tests/helpers/ux-browser.ts",
  "tests/fixtures/phase9/neutral-vector-replacement.json",
  "tests/unit/phase3/placement-quality.test.ts",
  "tests/unit/phase6/vector-ink.test.ts",
  "tests/unit/phase11/ui-integration.test.tsx",
  "tests/unit/phase9/vector-ink-replacement.test.ts",
];
const importOwners = trackedInputs.filter((relativePath) => relativePath.startsWith("tests/unit/"));

const git = (...args) => execFileSync(
  "git",
  ["-c", `safe.directory=${root}`, ...args],
  { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

for (const relativePath of trackedInputs) {
  if (!existsSync(resolve(root, relativePath))) {
    throw new Error(`${relativePath} is missing.`);
  }
  try {
    git("ls-files", "--error-unmatch", relativePath);
  } catch {
    throw new Error(`${relativePath} is not tracked and would be missing from a clean checkout.`);
  }
}

for (const relativePath of importOwners) {
  const source = readFileSync(resolve(root, relativePath), "utf8");
  if (source.includes(".audit/")) {
    throw new Error(`${relativePath} still imports an ignored .audit test input.`);
  }
}

process.stdout.write(`UX tracked-input check passed. ${trackedInputs.length} required inputs are tracked.\n`);
