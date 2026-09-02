import { expect, type Locator, type Page } from "@playwright/test";

export type RecordedPageTool = Readonly<{
  name: string;
  execute: (input: unknown) => unknown | Promise<unknown>;
}>;

declare global {
  interface Window {
    __uxRecordedPageTools: RecordedPageTool[];
  }
}

export type BrowserIssues = Readonly<{
  consoleIssues: string[];
  pageErrors: string[];
}>;

export type Rect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type PageElementSnapshot = Readonly<{
  kind: string;
  label: string;
  frame: Rect;
}>;

export type PageContextSnapshot = Readonly<{
  pageRevision: number;
  elements: readonly PageElementSnapshot[];
}>;

const VIEWPORT_TOLERANCE_PX = 1;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(record: Readonly<Record<string, unknown>>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected ${key} to be a finite number.`);
  }
  return value;
}

function requiredString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${key} to be a non-empty string.`);
  }
  return value;
}

function parseRect(value: unknown): Rect {
  if (!isRecord(value)) throw new Error("Expected a page element frame.");
  return {
    x: finiteNumber(value, "x"),
    y: finiteNumber(value, "y"),
    width: finiteNumber(value, "width"),
    height: finiteNumber(value, "height"),
  };
}

function parseElement(value: unknown): PageElementSnapshot {
  if (!isRecord(value)) throw new Error("Expected a page element context.");
  return {
    kind: requiredString(value, "kind"),
    label: requiredString(value, "label"),
    frame: parseRect(value.frame),
  };
}

export function parsePageContextResult(result: unknown): PageContextSnapshot {
  const context = isRecord(result) && isRecord(result.context)
    ? result.context
    : isRecord(result) && result.outcome === "success" && isRecord(result.output) && isRecord(result.output.context)
      ? result.output.context
      : null;
  if (context === null) {
    const detail = isRecord(result) ? JSON.stringify(result) : String(result);
    throw new Error(`Expected a successful page command with context, received ${detail}.`);
  }
  const elements = context.elements;
  if (!Array.isArray(elements)) throw new Error("The page context did not include elements.");
  return {
    pageRevision: finiteNumber(context, "pageRevision"),
    elements: elements.map(parseElement),
  };
}

export function observeBrowser(page: Page): BrowserIssues {
  const consoleIssues: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    const type = message.type();
    if (type !== "error" && type !== "warning") return;
    const location = message.location();
    consoleIssues.push(`${type}: ${message.text()} (${location.url}:${location.lineNumber})`);
  });
  page.on("pageerror", (error) => {
    pageErrors.push(`${error.message}${error.stack === undefined ? "" : ` (${error.stack})`}`);
  });
  return { consoleIssues, pageErrors };
}

export function expectNoBrowserIssues(issues: BrowserIssues): void {
  expect(issues.consoleIssues, "The app must not log warnings or errors.").toEqual([]);
  expect(issues.pageErrors, "The page must not throw uncaught errors.").toEqual([]);
}

export async function installPageWebMcpRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__uxRecordedPageTools = [];
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool(tool: RecordedPageTool): void {
          window.__uxRecordedPageTools.push(tool);
        },
      },
    });
  });
}

export async function waitForPageWebMcp(page: Page): Promise<void> {
  await expect.poll(
    () => page.evaluate(() => window.__uxRecordedPageTools.length),
    { message: "The page-scoped document.modelContext tools did not register.", timeout: 10_000 },
  ).toBeGreaterThan(0);
}

export async function executePageTool(
  page: Page,
  name: string,
  input: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  return page.evaluate(
    ({ toolName, toolInput }) => {
      const tool = window.__uxRecordedPageTools.find((candidate) => candidate.name === toolName);
      if (tool === undefined) throw new Error(`Page tool ${toolName} was not registered.`);
      return tool.execute(toolInput);
    },
    { toolName: name, toolInput: input },
  );
}

export async function createNotebook(
  page: Page,
  input: Readonly<{ title: string; subject: string }>,
): Promise<void> {
  await page.goto("/");
  await expect(page).toHaveURL(/\/desk$/);
  await expect(page.getByRole("heading", { name: "Notebook shelf" })).toBeVisible();
  await page.getByRole("button", { name: "New notebook" }).click();
  const dialog = page.getByRole("dialog", { name: "Name your notebook" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Title").fill(input.title);
  await dialog.getByLabel("Subject").fill(input.subject);
  await dialog.getByRole("button", { name: "Create notebook" }).click();
  await expect(page.getByTestId("focused-notebook")).toBeVisible();
  await expect(page.getByRole("heading", { name: input.title })).toBeVisible();
  await expect(page.locator('.page-surface[data-page-focused="true"]')).toBeVisible();
}

export async function expectInsideViewport(
  page: Page,
  locator: Locator,
  label: string,
): Promise<void> {
  await expect(locator, `${label} must be visible.`).toBeVisible();
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("The UX gate requires a fixed viewport.");
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${label} did not have a measurable box.`);
  expect(box.x, `${label} starts left of the viewport.`).toBeGreaterThanOrEqual(-VIEWPORT_TOLERANCE_PX);
  expect(box.y, `${label} starts above the viewport.`).toBeGreaterThanOrEqual(-VIEWPORT_TOLERANCE_PX);
  expect(box.x + box.width, `${label} extends past the right edge.`).toBeLessThanOrEqual(viewport.width + VIEWPORT_TOLERANCE_PX);
  expect(box.y + box.height, `${label} extends below the viewport.`).toBeLessThanOrEqual(viewport.height + VIEWPORT_TOLERANCE_PX);
}

export async function expectViewportCoverage(
  page: Page,
  locator: Locator,
  input: Readonly<{ label: string; minimumWidthRatio: number; minimumHeightRatio: number }>,
): Promise<void> {
  await expect(locator, `${input.label} must be visible.`).toBeVisible();
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("The UX gate requires a fixed viewport.");
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${input.label} did not have a measurable box.`);
  const visibleWidth = Math.max(0, Math.min(box.x + box.width, viewport.width) - Math.max(box.x, 0));
  const visibleHeight = Math.max(0, Math.min(box.y + box.height, viewport.height) - Math.max(box.y, 0));
  const maximumVisibleWidth = Math.min(box.width, viewport.width);
  const maximumVisibleHeight = Math.min(box.height, viewport.height);
  expect(
    visibleWidth / maximumVisibleWidth,
    `${input.label} must expose at least ${input.minimumWidthRatio * 100}% of its available width.`,
  ).toBeGreaterThanOrEqual(input.minimumWidthRatio);
  expect(
    visibleHeight / maximumVisibleHeight,
    `${input.label} must expose at least ${input.minimumHeightRatio * 100}% of its available height.`,
  ).toBeGreaterThanOrEqual(input.minimumHeightRatio);
}

export async function expectMinimumHitTarget(
  locator: Locator,
  minimumPx: number,
  label: string,
): Promise<void> {
  await expect(locator, `${label} must be visible before measuring its hit target.`).toBeVisible();
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${label} did not have a measurable hit target.`);
  expect(box.width, `${label} must be at least ${minimumPx}px wide.`).toBeGreaterThanOrEqual(minimumPx);
  expect(box.height, `${label} must be at least ${minimumPx}px tall.`).toBeGreaterThanOrEqual(minimumPx);
}

export async function effectivePageTextSizePx(page: Page): Promise<number> {
  const text = page.locator('.page-surface[data-page-focused="true"] .page-scene [data-element-kind="text"] text').first();
  await expect(text, "The inserted page text must render in the visible page scene.").toBeVisible();
  return text.evaluate((node) => {
    if (!(node instanceof SVGTextElement)) throw new Error("Expected an SVG text node.");
    const matrix = node.getScreenCTM();
    if (matrix === null) throw new Error("The visible page text did not have a screen transform.");
    const fontSize = node.getAttribute("font-size");
    if (fontSize === null) throw new Error("The visible page text did not expose its canonical font size.");
    const canonicalSize = Number.parseFloat(fontSize);
    if (!Number.isFinite(canonicalSize)) throw new Error("The visible page text font size was invalid.");
    return canonicalSize * Math.hypot(matrix.c, matrix.d);
  });
}

export function overlapArea(left: Rect, right: Rect): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}
