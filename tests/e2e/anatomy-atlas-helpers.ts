import { expect, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";

export const ATLAS_PATH = "/assets/anatomy/authority-atlas-206.glb";
export const EXPECTED_ATLAS_BYTES = 7_206_984;
export const EXPECTED_ATLAS_SHA256 = "a8a2dc6c2d8938541c814c23f1a04a6677d1af3fe68d38332239a2f301950a98";
export const EXPECTED_LOGICAL_BONES = 206;
export const EXPECTED_SEMANTIC_MESHES = 208;
export const ANATOMY_TEMPLATE = "anatomy-exam-prep";

export const EXPECTED_ANATOMY_TOOLS = [
  "anatomy_answer_set",
  "anatomy_bone_focus",
  "anatomy_camera_set",
  "anatomy_context_read",
  "anatomy_mode_set",
  "anatomy_section_set",
  "anatomy_session_set",
  "anatomy_test_submit",
] as const;

type JsonRecord = Readonly<Record<string, unknown>>;

type RecordedToolDescriptor = Readonly<{
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  annotations: unknown;
}>;

type AtlasDrawStats = Readonly<{
  clears: number;
  lastClearAt: number | null;
  clearTimestamps: number[];
}>;

type AnatomyAcceptanceBridge = Readonly<{
  names: () => string[];
  registrationCounts: () => Record<string, number>;
  descriptors: () => RecordedToolDescriptor[];
  invoke: (name: string, input: unknown) => Promise<unknown>;
  drawStats: () => AtlasDrawStats;
  resetDrawStats: () => void;
  longTasks: () => number[];
  resetLongTasks: () => void;
}>;

declare global {
  interface Window {
    __anatomyAcceptance: AnatomyAcceptanceBridge;
  }
}

export type BrowserIssues = Readonly<{
  consoleErrors: string[];
  pageErrors: string[];
}>;

export type AtlasNotebook = Readonly<{
  url: string;
  proposal: JsonRecord;
  verification: JsonRecord;
}>;

export type EmptyNotebook = Readonly<{
  url: string;
  initialContext: JsonRecord;
}>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredRecord(record: JsonRecord, key: string): JsonRecord {
  const value = record[key];
  if (!isRecord(value)) throw new Error(`Expected ${key} to be an object.`);
  return value;
}

export function requiredString(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${key} to be a non-empty string.`);
  }
  return value;
}

export function requiredNumber(record: JsonRecord, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected ${key} to be a finite number.`);
  }
  return value;
}

export function toolPayload(value: unknown): JsonRecord {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      throw new Error(`Tool returned non-JSON text: ${candidate}`);
    }
  }
  if (!isRecord(candidate)) throw new Error(`Tool returned ${String(candidate)} instead of an object.`);
  if (candidate.outcome === "error") {
    const error = isRecord(candidate.error) && typeof candidate.error.message === "string"
      ? candidate.error.message
      : JSON.stringify(candidate);
    throw new Error(`Tool failed: ${error}`);
  }
  if (candidate.outcome === "success" && isRecord(candidate.output)) return candidate.output;
  if (isRecord(candidate.structuredContent)) return candidate.structuredContent;
  return candidate;
}

export async function installAnatomyAcceptanceBridge(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    type BrowserTool = Readonly<{
      name: string;
      description?: string;
      inputSchema?: unknown;
      outputSchema?: unknown;
      annotations?: unknown;
      execute?: (input: unknown) => unknown | Promise<unknown>;
      handler?: (input: unknown) => unknown | Promise<unknown>;
      callback?: (input: unknown) => unknown | Promise<unknown>;
    }>;

    const tools = new Map<string, BrowserTool>();
    const registrationCounts = new Map<string, number>();
    const normalizeTool = (first: unknown, second: unknown): BrowserTool => {
      if (typeof first === "string" && typeof second === "object" && second !== null && !Array.isArray(second)) {
        const candidate = Object.assign({}, second, { name: first });
        if (typeof candidate.name === "string") return candidate;
      }
      if (typeof first === "object" && first !== null && !Array.isArray(first)) {
        const name = Reflect.get(first, "name");
        if (typeof name === "string") {
          return {
            name,
            description: typeof Reflect.get(first, "description") === "string"
              ? Reflect.get(first, "description")
              : undefined,
            inputSchema: Reflect.get(first, "inputSchema"),
            outputSchema: Reflect.get(first, "outputSchema"),
            annotations: Reflect.get(first, "annotations"),
            execute: typeof Reflect.get(first, "execute") === "function"
              ? Reflect.get(first, "execute")
              : undefined,
            handler: typeof Reflect.get(first, "handler") === "function"
              ? Reflect.get(first, "handler")
              : undefined,
            callback: typeof Reflect.get(first, "callback") === "function"
              ? Reflect.get(first, "callback")
              : undefined,
          };
        }
      }
      throw new TypeError("A WebMCP tool must register with a string name.");
    };

    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool(first: unknown, second?: unknown): void {
          const tool = normalizeTool(first, second);
          registrationCounts.set(tool.name, (registrationCounts.get(tool.name) ?? 0) + 1);
          tools.set(tool.name, tool);
        },
        unregisterTool(value: unknown): void {
          const name = typeof value === "string"
            ? value
            : typeof value === "object" && value !== null
              ? Reflect.get(value, "name")
              : null;
          if (typeof name === "string") tools.delete(name);
        },
      },
    });

    let atlasClears = 0;
    let lastAtlasClearAt: number | null = null;
    let atlasClearTimestamps: number[] = [];
    const instrumentClear = (
      prototype: Readonly<{
        canvas: HTMLCanvasElement | OffscreenCanvas;
        clear: (mask: GLbitfield) => void;
      }>,
    ): void => {
      const originalClear = prototype.clear;
      Object.defineProperty(prototype, "clear", {
        configurable: true,
        writable: true,
        value: function instrumentedAtlasClear(this: WebGLRenderingContext | WebGL2RenderingContext, mask: GLbitfield): void {
          if (this.canvas instanceof HTMLCanvasElement && this.canvas.closest(".anatomy-model-canvas") !== null) {
            atlasClears += 1;
            lastAtlasClearAt = performance.now();
            atlasClearTimestamps.push(lastAtlasClearAt);
          }
          originalClear.call(this, mask);
        },
      });
    };
    instrumentClear(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== "undefined") instrumentClear(WebGL2RenderingContext.prototype);

    let longTaskDurations: number[] = [];
    try {
      const observer = new PerformanceObserver((list) => {
        longTaskDurations.push(...list.getEntries().map((entry) => entry.duration));
      });
      observer.observe({ type: "longtask", buffered: true });
    } catch {
      longTaskDurations = [];
    }

    window.__anatomyAcceptance = {
      names: () => [...tools.keys()].sort(),
      registrationCounts: () => Object.fromEntries([...registrationCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
      descriptors: () => [...tools.values()]
        .map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema ?? null,
          outputSchema: tool.outputSchema ?? null,
          annotations: tool.annotations ?? null,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      async invoke(name: string, input: unknown): Promise<unknown> {
        const tool = tools.get(name);
        if (tool === undefined) throw new Error(`WebMCP tool is not registered: ${name}`);
        const execute = tool.execute ?? tool.handler ?? tool.callback;
        if (execute === undefined) throw new Error(`WebMCP tool has no executable callback: ${name}`);
        const result = await execute(input);
        try {
          return structuredClone(result);
        } catch {
          return JSON.parse(JSON.stringify(result));
        }
      },
      drawStats: () => ({ clears: atlasClears, lastClearAt: lastAtlasClearAt, clearTimestamps: [...atlasClearTimestamps] }),
      resetDrawStats: () => {
        atlasClears = 0;
        lastAtlasClearAt = null;
        atlasClearTimestamps = [];
      },
      longTasks: () => [...longTaskDurations],
      resetLongTasks: () => { longTaskDurations = []; },
    };
  });
}

export function observeBrowser(page: Page): BrowserIssues {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location();
    consoleErrors.push(`${message.text()} (${location.url}:${location.lineNumber})`);
  });
  page.on("pageerror", (error) => pageErrors.push(`${error.message}\n${error.stack ?? ""}`));
  return { consoleErrors, pageErrors };
}

export function expectNoBrowserErrors(issues: BrowserIssues): void {
  expect(issues.consoleErrors, "The anatomy notebook must not log browser errors.").toEqual([]);
  expect(issues.pageErrors, "The anatomy notebook must not throw uncaught page errors.").toEqual([]);
}

export async function waitForTools(page: Page, expectedNames: readonly string[]): Promise<void> {
  await expect.poll(
    () => page.evaluate((names) => {
      const registered = new Set(window.__anatomyAcceptance.names());
      return names.every((name) => registered.has(name));
    }, expectedNames),
    { message: `WebMCP did not register ${expectedNames.join(", ")}.`, timeout: 20_000 },
  ).toBe(true);
}

export async function executeTool(
  page: Page,
  name: string,
  input: Readonly<Record<string, unknown>>,
): Promise<JsonRecord> {
  const result = await page.evaluate(
    ({ toolName, toolInput }) => window.__anatomyAcceptance.invoke(toolName, toolInput),
    { toolName: name, toolInput: input },
  );
  return toolPayload(result);
}

export async function createEmptyNotebook(page: Page, title: string): Promise<EmptyNotebook> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/desk$/);
  await expect(page.getByRole("heading", { name: "Notebook shelf" })).toBeVisible();
  await page.getByRole("button", { name: "New notebook" }).click();
  const dialog = page.getByRole("dialog", { name: "Name your notebook" });
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByLabel("Subject").fill("Source-mesh anatomy study and test");
  await dialog.getByRole("button", { name: "Create notebook" }).click();
  await expect(page.getByTestId("focused-notebook")).toBeVisible();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page).toHaveURL(/\/desk\?notebook=[^&]+$/);

  await waitForTools(page, ["page_context_read", "page_composition_propose", "page_composition_apply", "page_composition_verify"]);
  const before = await executeTool(page, "page_context_read", {});
  const beforeContext = requiredRecord(before, "context");
  expect(requiredNumber(beforeContext, "pageCount"), "A new notebook must start with one page.").toBe(1);
  const beforeElements = beforeContext.elements;
  expect(Array.isArray(beforeElements) ? beforeElements.length : -1, "Page 1 must be empty before composition.").toBe(0);
  return { url: page.url(), initialContext: beforeContext };
}

export async function applyAtlasComposition(page: Page): Promise<Readonly<{
  proposal: JsonRecord;
  verification: JsonRecord;
}>> {
  const proposed = await executeTool(page, "page_composition_propose", { template: ANATOMY_TEMPLATE });
  const proposal = requiredRecord(proposed, "proposal");
  expect(requiredNumber(proposal, "pageCount"), "The anatomy composition must propose its exact seven-page workbook.").toBe(7);
  await executeTool(page, "page_composition_apply", {
    template: ANATOMY_TEMPLATE,
    proposalId: requiredString(proposal, "proposalId"),
    expectedDocumentRevision: requiredNumber(proposal, "expectedDocumentRevision"),
    mutationId: `acceptance-atlas-${Date.now()}`,
    actorId: "assistant:anatomy-acceptance",
  });
  const verified = await executeTool(page, "page_composition_verify", { template: ANATOMY_TEMPLATE });
  const verification = requiredRecord(verified, "verification");
  expect(verification.status, "The app-owned composition verification must pass.").toBe("complete");
  expect(requiredNumber(verification, "pageCount")).toBe(7);
  expect(requiredNumber(verification, "logicalBoneCount")).toBe(EXPECTED_LOGICAL_BONES);
  expect(requiredNumber(verification, "semanticMeshCount")).toBe(EXPECTED_SEMANTIC_MESHES);
  return { proposal, verification };
}

export async function createAtlasNotebook(page: Page, title: string): Promise<AtlasNotebook> {
  const empty = await createEmptyNotebook(page, title);
  const composition = await applyAtlasComposition(page);
  return { url: empty.url, ...composition };
}

export async function waitForAtlasReady(page: Page): Promise<void> {
  const study = page.locator('.anatomy-study-card[data-atlas-state="ready"]');
  await expect(study, "The source-mesh atlas must validate and become interactive.").toBeVisible({ timeout: 30_000 });
  await expect(study.locator(".anatomy-model-canvas canvas"), "The atlas must render into its notebook page.").toBeVisible();
}

export async function writeEvidence(testInfo: TestInfo, name: string, value: unknown): Promise<string> {
  const path = testInfo.outputPath(name);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

export function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) throw new Error("Cannot calculate a percentile without samples.");
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  const value = sorted[index];
  if (value === undefined) throw new Error("Percentile sample was unavailable.");
  return value;
}
