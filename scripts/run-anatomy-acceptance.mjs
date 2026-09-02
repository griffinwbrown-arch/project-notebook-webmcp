import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const EXPECTED_ATLAS_BYTES = 7_206_984;
const EXPECTED_ATLAS_SHA256 = "a8a2dc6c2d8938541c814c23f1a04a6677d1af3fe68d38332239a2f301950a98";
const playwrightArguments = process.argv.slice(2);
const FULL_EXPECTED_CASES = [
  ["@desktop creates seven anatomy pages and proves source-mesh study, test, coloring, fit, and remount safety", "anatomy-desktop"],
  ["@mobile keeps the atlas and opaque test controls usable at 390 by 844", "anatomy-mobile"],
  ["@desktop loads three cold atlas notebooks inside the readiness budget", "anatomy-desktop"],
  ["@desktop holds frame, toggle, idle, score, cache, and away-state budgets", "anatomy-desktop"],
  ["@desktop keeps 3D brush strokes local, continuous, anchored, persistent, and undoable", "anatomy-desktop"],
];
const suiteSelections = new Map([
  ["", FULL_EXPECTED_CASES],
  ["anatomy-atlas.spec.ts", FULL_EXPECTED_CASES.slice(0, 2)],
  ["anatomy-atlas-performance.spec.ts", FULL_EXPECTED_CASES.slice(2, 4)],
  ["anatomy-surface-paint.spec.ts", FULL_EXPECTED_CASES.slice(4)],
]);
const selectionKey = playwrightArguments.join(" ");
const expectedCases = suiteSelections.get(selectionKey);
if (expectedCases === undefined) {
  throw new Error(
    "The bounded anatomy runner accepts no filters. Run the full suite or pass exactly "
    + "anatomy-atlas.spec.ts, anatomy-atlas-performance.spec.ts, or anatomy-surface-paint.spec.ts.",
  );
}
const execFileAsync = promisify(execFile);
const repositoryRoot = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
  cwd: process.cwd(),
  windowsHide: true,
}).then((result) => resolve(result.stdout.trim()));
const port = Number.parseInt(process.env.ANATOMY_ACCEPTANCE_PORT ?? "3342", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("ANATOMY_ACCEPTANCE_PORT must be an integer between 1 and 65535.");
}
const baseURL = `http://127.0.0.1:${port}`;
const DEFAULT_ARTIFACT_ROOT = join(
  homedir(),
  ".codex",
  "visualizations",
  "2026",
  "08",
  "30",
  "01a05482-c50e-7bc3-95e5-7cb16b0a8120",
  "anatomy-exam-prep",
  "embedded-acceptance-results",
);

const atlasPath = join(repositoryRoot, "public", "assets", "anatomy", "authority-atlas-206.glb");
const atlas = await stat(atlasPath).catch(() => null);
if (atlas === null || !atlas.isFile() || atlas.size !== EXPECTED_ATLAS_BYTES) {
  throw new Error(
    `Expected the bundled ${EXPECTED_ATLAS_BYTES}-byte atlas at ${atlasPath}.`,
  );
}
const atlasSha256 = createHash("sha256").update(await readFile(atlasPath)).digest("hex");
if (atlasSha256 !== EXPECTED_ATLAS_SHA256) {
  throw new Error(`The atlas SHA-256 did not match the pinned source: ${atlasSha256}.`);
}

const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const artifactRoot = resolve(
  process.env.ANATOMY_ACCEPTANCE_ARTIFACT_DIR
    ?? join(DEFAULT_ARTIFACT_ROOT, runId),
);
const artifactRelativeToRepository = relative(repositoryRoot, artifactRoot);
const artifactIsOutsideRepository = artifactRelativeToRepository === ".."
  || artifactRelativeToRepository.startsWith(`..${sep}`)
  || isAbsolute(artifactRelativeToRepository);
if (!artifactIsOutsideRepository) {
  throw new Error("ANATOMY_ACCEPTANCE_ARTIFACT_DIR must stay outside the application repository.");
}
await mkdir(artifactRoot, { recursive: true });

const gitText = async (args) => {
  const result = await execFileAsync("git", args, { cwd: repositoryRoot, windowsHide: true });
  return result.stdout.trim();
};
const source = {
  commit: await gitText(["rev-parse", "HEAD"]).catch(() => "unavailable"),
  branch: await gitText(["branch", "--show-current"]).catch(() => "unavailable"),
  workingTree: await gitText(["status", "--short"]).catch(() => "unavailable"),
};

const environment = {
  ...process.env,
  ANATOMY_ACCEPTANCE_ARTIFACT_DIR: artifactRoot,
  ANATOMY_ACCEPTANCE_RUN: "1",
};

async function run(label, args) {
  const startedAt = new Date().toISOString();
  try {
    const exitCode = await new Promise((resolveExit, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: repositoryRoot,
        env: environment,
        stdio: "inherit",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal !== null) reject(new Error(`${label} stopped with signal ${signal}.`));
        else resolveExit(code ?? 1);
      });
    });
    return { label, startedAt, completedAt: new Date().toISOString(), exitCode };
  } catch (error) {
    return {
      label,
      startedAt,
      completedAt: new Date().toISOString(),
      exitCode: 1,
      error: error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) },
    };
  }
}

async function startOptimizedServer() {
  const label = "dedicated optimized Next.js server start";
  const startedAt = new Date().toISOString();
  let output = "";
  const child = spawn(process.execPath, [
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const appendOutput = (chunk, target) => {
    const text = chunk.toString();
    output += text;
    target.write(text);
  };
  child.stdout.on("data", (chunk) => appendOutput(chunk, process.stdout));
  child.stderr.on("data", (chunk) => appendOutput(chunk, process.stderr));
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`The optimized server exited early with code ${child.exitCode}.`);
      try {
        const response = await fetch(baseURL, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) {
          return {
            child,
            output: () => output,
            step: { label, startedAt, completedAt: new Date().toISOString(), exitCode: 0, baseURL },
          };
        }
      } catch {
        // The dedicated server is still starting.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error(`The optimized server did not become ready at ${baseURL} within 60 seconds.`);
  } catch (error) {
    await stopChild(child);
    return {
      child: null,
      output: () => output,
      step: {
        label,
        startedAt,
        completedAt: new Date().toISOString(),
        exitCode: 1,
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) },
      },
    };
  }
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill();
  await Promise.race([
    exited,
    new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function stopOptimizedServer(handle) {
  const label = "dedicated optimized Next.js server stop";
  const startedAt = new Date().toISOString();
  try {
    if (handle.child !== null) await stopChild(handle.child);
    await writeFile(join(artifactRoot, "server-output.log"), handle.output(), "utf8");
    return { label, startedAt, completedAt: new Date().toISOString(), exitCode: 0 };
  } catch (error) {
    return {
      label,
      startedAt,
      completedAt: new Date().toISOString(),
      exitCode: 1,
      error: error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) },
    };
  }
}

const steps = [];
const build = await run("optimized Next.js build", ["node_modules/next/dist/bin/next", "build", "--webpack"]);
steps.push(build);
if (build.exitCode !== 0) {
  await writeManifest(steps);
  process.exitCode = build.exitCode;
}

if (process.exitCode === undefined) {
  const server = await startOptimizedServer();
  steps.push(server.step);
  if (server.step.exitCode !== 0) {
    await writeFile(join(artifactRoot, "server-output.log"), server.output(), "utf8");
    process.exitCode = server.step.exitCode;
  } else {
    try {
      const acceptance = await run("embedded atlas acceptance", [
        "node_modules/@playwright/test/cli.js",
        "test",
        "--config",
        "scripts/anatomy-playwright.config.ts",
        ...playwrightArguments,
      ]);
      steps.push(acceptance);
      process.exitCode = acceptance.exitCode;
      if (acceptance.exitCode === 0) {
        const completeness = await validateCompleteness(expectedCases);
        steps.push(completeness);
        process.exitCode = completeness.exitCode;
      }
    } finally {
      const stopped = await stopOptimizedServer(server);
      steps.push(stopped);
      if (stopped.exitCode !== 0 && process.exitCode === 0) process.exitCode = stopped.exitCode;
    }
  }
}

await writeManifest(steps);

async function writeManifest(steps) {
  const buildId = await readFile(join(repositoryRoot, ".next", "BUILD_ID"), "utf8")
    .then((value) => value.trim())
    .catch(() => null);
  await writeFile(join(artifactRoot, "run-manifest.json"), `${JSON.stringify({
    runId,
    atlasPath,
    atlasBytes: atlas.size,
    atlasSha256,
    artifactRoot,
    repositoryRoot,
    source,
    buildId,
    optimizedBuild: true,
    releaseEligible: true,
    videoCapture: false,
    playwrightArguments,
    steps,
  }, null, 2)}\n`, "utf8");
}

async function validateCompleteness(expected) {
  const label = "acceptance result completeness";
  const startedAt = new Date().toISOString();
  try {
    const report = JSON.parse(await readFile(join(artifactRoot, "playwright-results.json"), "utf8"));
    const actual = [];
    const visit = (suites) => {
      for (const suite of suites ?? []) {
        for (const spec of suite.specs ?? []) {
          for (const test of spec.tests ?? []) {
            const result = test.results?.at(-1);
            if (result !== undefined) actual.push([spec.title, test.projectName, result.status]);
          }
        }
        visit(suite.suites);
      }
    };
    visit(report.suites);
    const expectedPassed = expected.map(([title, project]) => [title, project, "passed"]);
    const sortCases = (cases) => cases.map((entry) => JSON.stringify(entry)).sort();
    const statsMatch = report.stats?.expected === expected.length
      && report.stats?.skipped === 0
      && report.stats?.unexpected === 0
      && report.stats?.flaky === 0;
    const casesMatch = JSON.stringify(sortCases(actual)) === JSON.stringify(sortCases(expectedPassed));
    if (!statsMatch || !casesMatch) {
      throw new Error(`Expected ${JSON.stringify(expectedPassed)}, received ${JSON.stringify(actual)} with stats ${JSON.stringify(report.stats)}.`);
    }
    return { label, startedAt, completedAt: new Date().toISOString(), exitCode: 0, expectedCases: expectedPassed };
  } catch (error) {
    return {
      label,
      startedAt,
      completedAt: new Date().toISOString(),
      exitCode: 1,
      error: error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) },
    };
  }
}
