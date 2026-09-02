import { readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const MUTATION_BREAK_FLOORS = Object.freeze({
  core: 54.73,
  persistence: 45.76,
  "page-domain": 36.57,
  "page-commands": 53.56,
  "page-layout": 49.49,
  workspace: 63.85,
  desk: 33.83,
  integrations: 73.27,
  "app-shell": 80.95,
});

export const MUTATION_THRESHOLDS = Object.freeze({ high: 80, low: 60 });

export const SOURCE_EXCLUSIONS = Object.freeze([
  {
    pattern: "src/types/**/*.d.ts",
    reason: "Ambient declarations describe types for the WebMCP host and emit no executable JavaScript.",
  },
]);

const BATCH_DEFINITIONS = [
  {
    id: "core",
    label: "Core domain and commands",
    roots: ["src/domain", "src/projects", "src/commands"],
    testFiles: [
      "tests/unit/core/**/*.test.ts",
      "tests/unit/phase11/project-identity-tracking.test.ts",
    ],
  },
  {
    id: "persistence",
    label: "IndexedDB persistence",
    roots: ["src/indexeddb"],
    testFiles: [
      "tests/unit/core/indexeddb.test.ts",
      "tests/unit/core/phase2-indexeddb.test.ts",
      "tests/unit/phase3/page-storage*.test.ts",
      "tests/unit/phase11/page-core.test.ts",
      "tests/unit/phase11/project-identity-tracking.test.ts",
      "tests/unit/realignment/workspace-backup*.test.ts",
    ],
  },
  {
    id: "page-domain",
    label: "Page model and persisted element validation",
    roots: [
      "src/page/domain.ts",
      "src/page/diagram-templates.ts",
      "src/page/index.ts",
      "src/page/review-callout.ts",
      "src/page/vector-ink.ts",
      "src/page/vector-ink-replacement.ts",
    ],
    testFiles: [
      "tests/unit/phase3/page-domain.test.ts",
      "tests/unit/page/native-diagram-domain.test.ts",
      "tests/unit/phase5/review-callout.test.ts",
      "tests/unit/phase6/vector-ink.test.ts",
      "tests/unit/phase9/*.test.ts",
      "tests/unit/phase11/page-core.test.ts",
    ],
  },
  {
    id: "page-commands",
    label: "Page commands and placement",
    roots: [
      "src/page/commands.ts",
      "src/page/command-targets.ts",
      "src/page/placement.ts",
    ],
    testFiles: [
      "tests/unit/phase3/page-command-boundaries.test.ts",
      "tests/unit/phase3/page-commands.test.ts",
      "tests/unit/phase9/*.test.ts",
      "tests/unit/phase10/*.test.ts",
      "tests/unit/phase11/page-core.test.ts",
    ],
  },
  {
    id: "page-layout",
    label: "Page layout and annotation geometry",
    roots: ["src/page/annotation-geometry.ts", "src/page/layout.ts"],
    testFiles: [
      "tests/unit/entries/desk/PageSurface.test.tsx",
      "tests/unit/phase3/annotation-geometry.test.ts",
      "tests/unit/phase3/annotation-geometry-edge-cases.test.ts",
      "tests/unit/phase3/page-layout.test.ts",
      "tests/unit/phase3/page-layout-edge-cases.test.ts",
    ],
  },
  {
    id: "workspace",
    label: "Workspace state and history",
    roots: ["src/workspace"],
    testFiles: [
      "tests/unit/core/phase2-command-contracts.test.ts",
      "tests/unit/core/phase2-coverage.test.ts",
      "tests/unit/workspace/*.test.ts",
    ],
  },
  {
    id: "desk",
    label: "Desk entry components",
    roots: ["src/entries/desk"],
    testFiles: [
      "tests/unit/entries/desk/*.test.ts",
      "tests/unit/entries/desk/*.test.tsx",
      "tests/unit/phase11/ui-components.test.tsx",
      "tests/unit/phase11/ui-integration.test.tsx",
    ],
  },
  {
    id: "integrations",
    label: "WebMCP, runtime, and offline shell",
    roots: ["src/entries/webmcp", "src/pwa", "src/runtime", "public/sw.js"],
    testFiles: [
      "tests/unit/integrations/*.test.ts",
      "tests/unit/pwa/*.test.ts",
      "tests/unit/workspace/browser-runtime*.test.ts",
      "tests/unit/phase11/no-gpt-realtime.test.ts",
      "tests/unit/core/contracts.test.ts",
    ],
  },
  {
    id: "app-shell",
    label: "Next app shell",
    roots: ["src/app"],
    testFiles: [
      "tests/unit/entries/app-routes.test.tsx",
      "tests/unit/phase11/no-gpt-realtime.test.ts",
    ],
  },
];

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function isExecutableSource(filePath) {
  return (filePath.endsWith(".js") || filePath.endsWith(".ts") || filePath.endsWith(".tsx"))
    && !filePath.endsWith(".d.ts");
}

function listFiles(rootPath) {
  return readdirSync(rootPath, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(rootPath, entry.name);
    if (entry.isDirectory()) return listFiles(entryPath);
    return isExecutableSource(entryPath) ? [entryPath] : [];
  });
}

function sourceFilesForRoot(root) {
  const rootPath = resolve(APP_ROOT, root);
  const rootStat = statSync(rootPath);
  if (rootStat.isFile()) {
    if (!isExecutableSource(rootPath)) throw new Error(`Mutation batch file is not executable source: ${root}`);
    return [normalizePath(relative(APP_ROOT, rootPath))];
  }
  if (!rootStat.isDirectory()) throw new Error(`Mutation batch root is not a file or directory: ${root}`);
  return listFiles(rootPath)
    .map((filePath) => normalizePath(relative(APP_ROOT, filePath)))
    .sort();
}

function sourceFilesForRoots(roots) {
  return [...new Set(roots.flatMap(sourceFilesForRoot))].sort();
}

export const EXECUTABLE_SOURCE_FILES = Object.freeze(
  [...sourceFilesForRoot("src"), "public/sw.js"].sort(),
);

export const BATCHES = Object.freeze(
  BATCH_DEFINITIONS.map((definition) => {
    const sourceFiles = sourceFilesForRoots(definition.roots);
    return Object.freeze({
      ...definition,
      sourceFiles: Object.freeze(sourceFiles),
      configFile: `stryker.batch-${definition.id}.config.mjs`,
      tempDirName: `.stryker-tmp/mutation-${definition.id}`,
      reportDirectory: `artifacts/mutation/${definition.id}`,
    });
  }),
);

export function getBatch(batchId) {
  const batch = BATCHES.find(({ id }) => id === batchId);
  if (!batch) {
    const validIds = BATCHES.map(({ id }) => id).join(", ");
    throw new Error(`Unknown mutation batch "${batchId}". Choose one of: ${validIds}`);
  }
  return batch;
}

export function createStrykerConfig(batchId) {
  const batch = getBatch(batchId);
  const breakThreshold = MUTATION_BREAK_FLOORS[batchId];
  if (breakThreshold === undefined) {
    throw new Error(`Mutation break floor is missing for batch "${batchId}".`);
  }
  return {
    plugins: ["@stryker-mutator/vitest-runner"],
    mutate: [...batch.sourceFiles],
    testRunner: "vitest",
    vitest: { configFile: "vitest.config.ts" },
    testFiles: [...batch.testFiles],
    reporters: ["clear-text", "progress", "html", "json"],
    ignorePatterns: [
      ".stryker-tmp/**",
      ".next/**",
      "artifacts/**",
      "coverage/**",
    ],
    thresholds: { ...MUTATION_THRESHOLDS, break: breakThreshold },
    coverageAnalysis: "perTest",
    concurrency: 10,
    timeoutMS: 15000,
    tempDirName: batch.tempDirName,
    htmlReporter: { fileName: `${batch.reportDirectory}/index.html` },
    jsonReporter: { fileName: `${batch.reportDirectory}/mutation.json` },
    logLevel: "info",
  };
}

export function appWideSourceAudit() {
  const assignments = new Map();
  for (const batch of BATCHES) {
    for (const sourceFile of batch.sourceFiles) {
      const owners = assignments.get(sourceFile) ?? [];
      owners.push(batch.id);
      assignments.set(sourceFile, owners);
    }
  }

  const duplicateAssignments = [...assignments.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([sourceFile, owners]) => ({ sourceFile, owners }));
  const assignedFiles = [...assignments.keys()].sort();
  const omittedFiles = EXECUTABLE_SOURCE_FILES.filter((file) => !assignments.has(file));
  const unknownFiles = assignedFiles.filter((file) => !EXECUTABLE_SOURCE_FILES.includes(file));

  return { assignedFiles, duplicateAssignments, omittedFiles, unknownFiles };
}
