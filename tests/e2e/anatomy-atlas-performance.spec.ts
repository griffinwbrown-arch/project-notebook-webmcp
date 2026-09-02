import { expect, test, type BrowserContext, type CDPSession, type Page } from "@playwright/test";

import { bonesForSection } from "../../src/anatomy";
import {
  ATLAS_PATH,
  EXPECTED_ATLAS_BYTES,
  EXPECTED_ANATOMY_TOOLS,
  EXPECTED_SEMANTIC_MESHES,
  applyAtlasComposition,
  createEmptyNotebook,
  expectNoBrowserErrors,
  installAnatomyAcceptanceBridge,
  observeBrowser,
  percentile,
  requiredNumber,
  requiredRecord,
  toolPayload,
  waitForAtlasReady,
  waitForTools,
  writeEvidence,
} from "./anatomy-atlas-helpers";

test.skip(process.env.ANATOMY_ACCEPTANCE_RUN !== "1", "Run through test:anatomy:acceptance with the pinned external atlas.");

const COLD_READY_MAX_MS = 4_000;
const COLD_READY_MEDIAN_MAX_MS = 3_000;
const COLD_LONG_TASK_MAX_MS = 250;
const COLD_TBT_MAX_MS = 350;
const INTERACTION_MEDIAN_MAX_MS = 18.5;
const INTERACTION_P95_MAX_MS = 34;
const INTERACTION_MAX_MS = 100;
const INTERACTION_OVER_50_MAX_RATIO = 0.02;
const ATLAS_DRAW_CALL_MAX = 2;
const MODE_TOGGLE_P95_MAX_MS = 100;
const MODE_TOGGLE_MAX_MS = 150;
const SCORE_COMMIT_MAX_MS = 400;
const IDLE_TASK_DURATION_MAX_SECONDS = 0.25;
const AWAY_TASK_DURATION_MAX_SECONDS = 0.1;

type AtlasRequest = Readonly<{
  url: string;
  serviceWorkerFetch: boolean;
}>;

type AtlasRendererEvidence = Readonly<{
  renderer: string;
  batchInstances: number;
  drawCalls: number;
  visibleSemanticMeshes: number;
}>;

type AtlasRenderQualityEvidence = Readonly<{
  quality: "source";
  motionIndexRatio: number;
}>;

async function readAtRestRenderQuality(page: Page): Promise<AtlasRenderQualityEvidence> {
  const canvas = page.locator('.anatomy-model-canvas canvas[data-atlas-ready="true"]');
  await expect(canvas).toHaveAttribute("data-atlas-render-quality", "source");
  await expect.poll(async () => {
    const rawRatio = await canvas.getAttribute("data-atlas-motion-index-ratio");
    if (rawRatio === null || rawRatio.trim() === "") return false;
    const ratio = Number(rawRatio);
    return Number.isFinite(ratio) && ratio > 0 && ratio < 0.3;
  }, {
    message: "The motion LOD must publish a finite positive index ratio below 0.3.",
  }).toBe(true);
  const rawRatio = await canvas.getAttribute("data-atlas-motion-index-ratio");
  const motionIndexRatio = rawRatio === null ? Number.NaN : Number(rawRatio);
  if (!Number.isFinite(motionIndexRatio) || motionIndexRatio <= 0 || motionIndexRatio >= 0.3) {
    throw new Error("The motion LOD did not publish a finite positive index ratio below 0.3.");
  }
  return { quality: "source", motionIndexRatio };
}

async function readAtlasRendererEvidence(page: Page): Promise<AtlasRendererEvidence> {
  const canvas = page.locator('.anatomy-model-canvas canvas[data-atlas-ready="true"]');
  await expect(canvas).toHaveAttribute("data-atlas-renderer", "batched");
  await expect.poll(async () => Number(await canvas.getAttribute("data-atlas-draw-calls")), {
    message: "The batched atlas must publish a finite positive draw-call count after rendering.",
  }).toBeGreaterThan(0);
  return canvas.evaluate((element) => ({
    renderer: element.dataset.atlasRenderer ?? "",
    batchInstances: Number(element.dataset.atlasBatchInstances),
    drawCalls: Number(element.dataset.atlasDrawCalls),
    visibleSemanticMeshes: Number(element.dataset.visibleSemanticMeshes),
  }));
}

async function ensureServiceWorkerControls(page: Page): Promise<void> {
  const controlled = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return false;
    await navigator.serviceWorker.ready;
    return navigator.serviceWorker.controller !== null;
  });
  if (controlled) return;
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForTools(page, ["page_context_read", "page_composition_propose", "page_composition_apply"]);
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), {
    message: "The optimized notebook did not become service-worker controlled.",
    timeout: 15_000,
  }).toBe(true);
}

async function interactionFrameIntervals(page: Page): Promise<Readonly<{
  rafIntervals: number[];
  atlasIntervals: number[];
  atlasClears: number;
  qualityBefore: "source";
  motionIndexRatio: number;
  qualitySamples: string[];
  motionQualitySamples: number;
  qualityAfter: "source";
}>> {
  const canvas = page.locator(".anatomy-model-canvas canvas");
  await expect(canvas).toBeVisible();
  const qualityBefore = await readAtRestRenderQuality(page);
  await page.evaluate(() => {
    window.__anatomyAcceptance.resetLongTasks();
    window.__anatomyAcceptance.resetDrawStats();
  });
  const samplesPromise = page.evaluate((sampleCount) => new Promise<{
    intervals: number[];
    qualities: string[];
  }>((resolve, reject) => {
    const atlasCanvas = document.querySelector('.anatomy-model-canvas canvas[data-atlas-ready="true"]');
    if (!(atlasCanvas instanceof HTMLCanvasElement)) {
      reject(new Error("The ready anatomy canvas is unavailable for frame sampling."));
      return;
    }
    const intervals: number[] = [];
    const qualities: string[] = [];
    let previous: number | null = null;
    const sample = (timestamp: number): void => {
      if (previous !== null) intervals.push(timestamp - previous);
      qualities.push(atlasCanvas.dataset.atlasRenderQuality ?? "missing");
      previous = timestamp;
      if (intervals.length >= sampleCount) resolve({ intervals, qualities });
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }), 180);

  const views = ["left", "right", "anterior"] as const;
  for (let index = 0; index < 20; index += 1) {
    await page.evaluate((view) => window.__anatomyAcceptance.invoke("anatomy_camera_set", { view }), views[index % views.length]);
    await page.waitForTimeout(150);
  }
  const samples = await samplesPromise;
  const drawStats = await page.evaluate(() => window.__anatomyAcceptance.drawStats());
  await expect.poll(() => canvas.getAttribute("data-atlas-render-quality"), {
    message: "The atlas must restore source geometry after camera motion settles.",
    timeout: 3_000,
  }).toBe("source");
  return {
    rafIntervals: samples.intervals,
    atlasIntervals: drawStats.clearTimestamps.slice(1)
      .map((timestamp, index) => timestamp - (drawStats.clearTimestamps[index] ?? timestamp)),
    atlasClears: drawStats.clears,
    qualityBefore: qualityBefore.quality,
    motionIndexRatio: qualityBefore.motionIndexRatio,
    qualitySamples: samples.qualities,
    motionQualitySamples: samples.qualities.filter((quality) => quality === "motion").length,
    qualityAfter: "source",
  };
}

async function measureModeToggle(page: Page, mode: "Study" | "Test", expectedInputs: number): Promise<number> {
  return page.evaluate(async ({ label, inputCount }) => {
    const root = document.querySelector(".anatomy-study-card");
    if (!(root instanceof HTMLElement)) throw new Error("The anatomy root is unavailable.");
    const button = [...root.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === label);
    if (!(button instanceof HTMLButtonElement)) throw new Error(`${label} mode is unavailable.`);
    const expectedMode = label.toLocaleLowerCase();
    const startedAt = performance.now();
    button.click();
    while (performance.now() - startedAt < 1_500) {
      const currentInputs = root.querySelectorAll('input[aria-label^="Answer for question "]').length;
      if (root.dataset.anatomyMode === expectedMode && currentInputs === inputCount) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return performance.now() - startedAt;
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    throw new Error(`${label} mode did not settle with ${inputCount} test inputs.`);
  }, { label: mode, inputCount: expectedInputs });
}

async function taskDuration(session: CDPSession): Promise<number> {
  const metrics = await session.send("Performance.getMetrics");
  const task = metrics.metrics.find((metric) => metric.name === "TaskDuration");
  if (task === undefined) throw new Error("Chromium did not expose TaskDuration.");
  return task.value;
}

function recordAtlasRequests(context: BrowserContext): AtlasRequest[] {
  const requests: AtlasRequest[] = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname !== ATLAS_PATH || url.search !== "") return;
    requests.push({ url: request.url(), serviceWorkerFetch: request.serviceWorker() !== null });
  });
  return requests;
}

test("@desktop loads three cold atlas notebooks inside the readiness budget", async ({ browser }, testInfo) => {
  expect(testInfo.project.name).toBe("anatomy-desktop");
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("The anatomy performance project needs a base URL.");
  const coldRuns: Readonly<{
    readyMs: number;
    longTasksMs: number[];
    totalBlockingTimeMs: number;
    longestTaskMs: number;
  }>[] = [];
  for (let index = 0; index < 3; index += 1) {
    const context = await browser.newContext({
      baseURL,
      serviceWorkers: "allow",
      viewport: { width: 1440, height: 900 },
    });
    await installAnatomyAcceptanceBridge(context);
    const page = await context.newPage();
    const issues = observeBrowser(page);
    try {
      await createEmptyNotebook(page, `Cold anatomy acceptance ${index + 1}`);
      await ensureServiceWorkerControls(page);
      await page.evaluate(async () => {
        window.__anatomyAcceptance.resetLongTasks();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        window.__anatomyAcceptance.resetLongTasks();
      });
      const startedAt = Date.now();
      await applyAtlasComposition(page);
      await waitForAtlasReady(page);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const longTasksMs = await page.evaluate(() => window.__anatomyAcceptance.longTasks());
      const totalBlockingTimeMs = longTasksMs.reduce((total, duration) => total + Math.max(0, duration - 50), 0);
      const longestTaskMs = Math.max(0, ...longTasksMs);
      coldRuns.push({
        readyMs: Date.now() - startedAt,
        longTasksMs,
        totalBlockingTimeMs,
        longestTaskMs,
      });
      expectNoBrowserErrors(issues);
    } finally {
      await context.close();
    }
  }
  expect(coldRuns, "The cold gate must finish in three fresh browser contexts.").toHaveLength(3);
  for (const run of coldRuns) {
    expect(run.readyMs).toBeLessThanOrEqual(COLD_READY_MAX_MS);
    expect(run.longestTaskMs, "Atlas validation must not create a cold-load task longer than 250 ms.")
      .toBeLessThanOrEqual(COLD_LONG_TASK_MAX_MS);
    expect(run.totalBlockingTimeMs, "Atlas validation cold-load TBT must stay within 350 ms.")
      .toBeLessThanOrEqual(COLD_TBT_MAX_MS);
  }
  const durations = coldRuns.map((run) => run.readyMs);
  expect(percentile(durations, 50), "Median cold readiness must stay at or below three seconds.")
    .toBeLessThanOrEqual(COLD_READY_MEDIAN_MAX_MS);
  await writeEvidence(testInfo, "cold-readiness.json", {
    runs: coldRuns,
    durationsMs: durations,
    medianMs: percentile(durations, 50),
    budgets: {
      eachMaxMs: COLD_READY_MAX_MS,
      medianMaxMs: COLD_READY_MEDIAN_MAX_MS,
      longestTaskMaxMs: COLD_LONG_TASK_MAX_MS,
      totalBlockingTimeMaxMs: COLD_TBT_MAX_MS,
    },
  });
});

test("@desktop holds frame, toggle, idle, score, cache, and away-state budgets", async ({ context, page }, testInfo) => {
  expect(testInfo.project.name).toBe("anatomy-desktop");
  await installAnatomyAcceptanceBridge(context);
  const issues = observeBrowser(page);
  const atlasRequests = recordAtlasRequests(context);
  const title = "Warm anatomy performance acceptance";
  await createEmptyNotebook(page, title);
  await ensureServiceWorkerControls(page);
  await applyAtlasComposition(page);
  await waitForAtlasReady(page);
  await waitForTools(page, EXPECTED_ANATOMY_TOOLS);

  const atlasRenderer = await readAtlasRendererEvidence(page);
  expect(atlasRenderer.renderer).toBe("batched");
  expect(atlasRenderer.batchInstances, "One batched atlas object must own all 208 source-mesh instances.")
    .toBe(EXPECTED_SEMANTIC_MESHES);
  expect(atlasRenderer.visibleSemanticMeshes, "The draw-call gate must cover the complete 208-mesh atlas.")
    .toBe(EXPECTED_SEMANTIC_MESHES);
  expect(Number.isSafeInteger(atlasRenderer.drawCalls)).toBe(true);
  expect(atlasRenderer.drawCalls, "The complete atlas must render in at most two draw calls.")
    .toBeLessThanOrEqual(ATLAS_DRAW_CALL_MAX);
  await writeEvidence(testInfo, "atlas-renderer-evidence.json", {
    renderer: atlasRenderer,
    expectedSemanticMeshes: EXPECTED_SEMANTIC_MESHES,
    drawCallMax: ATLAS_DRAW_CALL_MAX,
  });

  await page.waitForTimeout(1_000);
  const idleDrawStart = await page.evaluate(() => window.__anatomyAcceptance.drawStats());
  const performanceSession = await context.newCDPSession(page);
  await performanceSession.send("Performance.enable");
  const idleTaskStart = await taskDuration(performanceSession);
  await page.waitForTimeout(5_000);
  const idleTaskEnd = await taskDuration(performanceSession);
  await performanceSession.detach();
  const idleDrawEnd = await page.evaluate(() => window.__anatomyAcceptance.drawStats());
  expect(idleDrawEnd.clears - idleDrawStart.clears, "A settled atlas must not keep a permanent render loop.").toBe(0);
  expect(idleTaskEnd - idleTaskStart, "Five idle seconds must consume at most 250 ms of browser task time.")
    .toBeLessThanOrEqual(IDLE_TASK_DURATION_MAX_SECONDS);

  const interaction = await interactionFrameIntervals(page);
  const frameIntervals = interaction.atlasIntervals;
  const frameMedian = percentile(frameIntervals, 50);
  const frameP95 = percentile(frameIntervals, 95);
  const frameMax = Math.max(...frameIntervals);
  const over50Ratio = frameIntervals.filter((duration) => duration > 50).length / frameIntervals.length;
  await writeEvidence(testInfo, "interaction-frame-probe.json", {
    renderQuality: {
      before: interaction.qualityBefore,
      motionIndexRatio: interaction.motionIndexRatio,
      sampledFrames: interaction.qualitySamples.length,
      motionFrames: interaction.motionQualitySamples,
      observedValues: [...new Set(interaction.qualitySamples)],
      after: interaction.qualityAfter,
    },
    browserRaf: {
      count: interaction.rafIntervals.length,
      medianMs: percentile(interaction.rafIntervals, 50),
      p95Ms: percentile(interaction.rafIntervals, 95),
      maxMs: Math.max(...interaction.rafIntervals),
    },
    atlasRender: {
      count: frameIntervals.length,
      medianMs: frameMedian,
      p95Ms: frameP95,
      maxMs: frameMax,
      over50Ratio,
    },
  });
  expect(interaction.qualityBefore).toBe("source");
  expect(interaction.motionIndexRatio).toBeGreaterThan(0);
  expect(interaction.motionIndexRatio).toBeLessThan(0.3);
  expect(interaction.motionQualitySamples,
    "Continuous camera interaction must render at least one sampled motion-LOD frame.").toBeGreaterThan(0);
  expect(interaction.qualityAfter).toBe("source");
  expect(interaction.rafIntervals.length).toBeGreaterThanOrEqual(150);
  expect(interaction.atlasClears, "The actual atlas must render throughout continuous camera interaction.")
    .toBeGreaterThanOrEqual(80);
  expect(frameIntervals.length).toBeGreaterThanOrEqual(79);
  expect(frameMedian).toBeLessThanOrEqual(INTERACTION_MEDIAN_MAX_MS);
  expect(frameP95).toBeLessThanOrEqual(INTERACTION_P95_MAX_MS);
  expect(over50Ratio).toBeLessThanOrEqual(INTERACTION_OVER_50_MAX_RATIO);
  expect(frameMax).toBeLessThanOrEqual(INTERACTION_MAX_MS);
  const interactionLongTasks = await page.evaluate(() => window.__anatomyAcceptance.longTasks());
  expect(interactionLongTasks.filter((duration) => duration >= 50), "Camera interaction must create no 50 ms long tasks.").toEqual([]);

  await page.evaluate(() => window.__anatomyAcceptance.resetLongTasks());
  await toolPayload(await page.evaluate(() => window.__anatomyAcceptance.invoke("anatomy_section_set", { section: "upper-limb" })));
  for (let warmup = 0; warmup < 2; warmup += 1) {
    await measureModeToggle(page, "Test", 64);
    await measureModeToggle(page, "Study", 0);
  }
  await page.evaluate(() => window.__anatomyAcceptance.resetLongTasks());
  const testToggleDurations: number[] = [];
  const studyToggleDurations: number[] = [];
  for (let sample = 0; sample < 12; sample += 1) {
    testToggleDurations.push(await measureModeToggle(page, "Test", 64));
    studyToggleDurations.push(await measureModeToggle(page, "Study", 0));
  }
  const toggleDurations = [...testToggleDurations, ...studyToggleDurations];
  const toggleP95 = percentile(toggleDurations, 95);
  const toggleMax = Math.max(...toggleDurations);
  expect(toggleP95).toBeLessThanOrEqual(MODE_TOGGLE_P95_MAX_MS);
  expect(toggleMax).toBeLessThanOrEqual(MODE_TOGGLE_MAX_MS);
  const toggleLongTasks = await page.evaluate(() => window.__anatomyAcceptance.longTasks());
  expect(toggleLongTasks.filter((duration) => duration >= 50), "Study and Test toggles must create no 50 ms long tasks.").toEqual([]);

  toolPayload(await page.evaluate(() => window.__anatomyAcceptance.invoke("anatomy_section_set", { section: "pelvis" })));
  toolPayload(await page.evaluate(() => window.__anatomyAcceptance.invoke("anatomy_mode_set", { mode: "test" })));
  const pelvis = bonesForSection("pelvis");
  for (let index = 0; index < pelvis.length; index += 1) {
    const bone = pelvis[index];
    if (bone === undefined) throw new Error("The pelvis catalogue was incomplete.");
    toolPayload(await page.evaluate(
      ({ questionNumber, answer }) => window.__anatomyAcceptance.invoke("anatomy_answer_set", { questionNumber, answer }),
      { questionNumber: index + 1, answer: bone.name },
    ));
  }
  const scoreMeasurement = await page.evaluate(async () => {
    const startedAt = performance.now();
    const result = await window.__anatomyAcceptance.invoke("anatomy_test_submit", {});
    return { durationMs: performance.now() - startedAt, result };
  });
  const score = toolPayload(scoreMeasurement.result);
  expect(scoreMeasurement.durationMs, "Score commit, including app-owned persistence, must finish in 400 ms.")
    .toBeLessThanOrEqual(SCORE_COMMIT_MAX_MS);
  expect(requiredNumber(requiredRecord(score, "score"), "correct")).toBe(2);
  await expect(page.locator(".anatomy-score-pill")).toContainText("2/2");

  const cachedAtlasBytes = await page.evaluate(async (path) => {
    const cached = await caches.match(path);
    return cached === undefined ? null : (await cached.arrayBuffer()).byteLength;
  }, ATLAS_PATH);
  expect(cachedAtlasBytes, "The bounded service-worker cache must contain the exact atlas.").toBe(EXPECTED_ATLAS_BYTES);
  await page.evaluate(() => performance.clearResourceTimings());
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForAtlasReady(page);
  await waitForTools(page, EXPECTED_ANATOMY_TOOLS);
  await expect(page.locator(".anatomy-score-pill")).toContainText("2/2");
  const serviceWorkerFetches = atlasRequests.filter((request) => request.serviceWorkerFetch);
  expect(serviceWorkerFetches, "A warm reload must not make a second network fetch for the 7.2 MB atlas.").toHaveLength(1);
  const warmResources = await page.evaluate((path) => performance.getEntriesByType("resource")
    .filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming && new URL(entry.name).pathname === path)
    .map((entry) => ({
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
      decodedBodySize: entry.decodedBodySize,
      duration: entry.duration,
    })), ATLAS_PATH);
  expect(warmResources).toHaveLength(1);
  expect(warmResources[0]?.transferSize, "The warm atlas response must transfer zero network bytes.").toBe(0);

  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAtlasReady(page);
    await waitForTools(page, EXPECTED_ANATOMY_TOOLS);
    await expect(page.locator(".anatomy-score-pill")).toContainText("2/2");
  } finally {
    await context.setOffline(false);
  }
  expect(atlasRequests.filter((request) => request.serviceWorkerFetch),
    "A cached offline reload must not start another atlas network request.").toHaveLength(1);

  await page.getByRole("button", { name: /Shelf/ }).click();
  await expect(page.locator(".anatomy-model-canvas canvas")).toHaveCount(0);
  const awayDrawStart = await page.evaluate(() => window.__anatomyAcceptance.drawStats());
  const awayPerformanceSession = await context.newCDPSession(page);
  await awayPerformanceSession.send("Performance.enable");
  const awayTaskStart = await taskDuration(awayPerformanceSession);
  await page.waitForTimeout(1_500);
  const awayTaskEnd = await taskDuration(awayPerformanceSession);
  await awayPerformanceSession.detach();
  const awayDrawEnd = await page.evaluate(() => window.__anatomyAcceptance.drawStats());
  expect(awayDrawEnd.clears).toBe(awayDrawStart.clears);
  expect(awayTaskEnd - awayTaskStart, "An unmounted atlas must not leave meaningful browser work behind.")
    .toBeLessThanOrEqual(AWAY_TASK_DURATION_MAX_SECONDS);
  await page.getByRole("button", { name: `Open ${title} notebook` }).click();
  await waitForAtlasReady(page);
  await expect(page.locator(".anatomy-model-canvas canvas")).toHaveCount(1);
  expectNoBrowserErrors(issues);

  await writeEvidence(testInfo, "performance-evidence.json", {
    budgets: {
      idleTaskDurationMaxSeconds: IDLE_TASK_DURATION_MAX_SECONDS,
      interactionMedianMaxMs: INTERACTION_MEDIAN_MAX_MS,
      interactionP95MaxMs: INTERACTION_P95_MAX_MS,
      interactionOver50MaxRatio: INTERACTION_OVER_50_MAX_RATIO,
      interactionMaxMs: INTERACTION_MAX_MS,
      atlasDrawCallMax: ATLAS_DRAW_CALL_MAX,
      modeToggleP95MaxMs: MODE_TOGGLE_P95_MAX_MS,
      modeToggleMaxMs: MODE_TOGGLE_MAX_MS,
      scoreCommitMaxMs: SCORE_COMMIT_MAX_MS,
      awayTaskDurationMaxSeconds: AWAY_TASK_DURATION_MAX_SECONDS,
    },
    idle: {
      clearDelta: idleDrawEnd.clears - idleDrawStart.clears,
      taskDurationSeconds: idleTaskEnd - idleTaskStart,
    },
    atlasRenderer,
    interaction: {
      samples: frameIntervals.length,
      medianMs: frameMedian,
      p95Ms: frameP95,
      maxMs: frameMax,
      over50Ratio,
      clearDelta: interaction.atlasClears,
      atlasClearCount: interaction.atlasClears,
      browserRafSamples: interaction.rafIntervals.length,
      longTasksMs: interactionLongTasks,
      renderQuality: {
        before: interaction.qualityBefore,
        motionIndexRatio: interaction.motionIndexRatio,
        sampledFrames: interaction.qualitySamples.length,
        motionFrames: interaction.motionQualitySamples,
        observedValues: [...new Set(interaction.qualitySamples)],
        after: interaction.qualityAfter,
      },
    },
    testToggle: {
      samples: testToggleDurations.length,
      testDurationsMs: testToggleDurations,
      studyDurationsMs: studyToggleDurations,
      p95Ms: toggleP95,
      maxMs: toggleMax,
      longTasksMs: toggleLongTasks,
    },
    score: { durationMs: scoreMeasurement.durationMs, result: score },
    cache: { requests: atlasRequests, cachedAtlasBytes, warmResources, offlineReload: true },
    away: {
      clearDelta: awayDrawEnd.clears - awayDrawStart.clears,
      taskDurationSeconds: awayTaskEnd - awayTaskStart,
    },
  });
});
