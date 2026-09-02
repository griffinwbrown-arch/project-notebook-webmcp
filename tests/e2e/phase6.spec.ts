import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

type RecordedPageTool = {
  readonly name: string;
  readonly execute: (input: unknown) => unknown | Promise<unknown>;
};

declare global {
  interface Window {
    __phase6RecordedPageTools: RecordedPageTool[];
  }
}

type BrowserObservations = {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
};

function observeBrowser(page: Page): BrowserObservations {
  const observations: BrowserObservations = { consoleErrors: [], pageErrors: [] };
  page.on("console", (message) => {
    const location = message.location();
    if (message.type() === "error") {
      observations.consoleErrors.push(`${message.text()} (${location.url}:${location.lineNumber})`);
    }
  });
  page.on("pageerror", (error) => observations.pageErrors.push(error.message));
  return observations;
}

function expectNoBrowserErrors(observations: BrowserObservations): void {
  expect(observations.consoleErrors).toEqual([]);
  expect(observations.pageErrors).toEqual([]);
}

async function installPageWebMcpRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__phase6RecordedPageTools = [];
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool(tool: RecordedPageTool): void {
          window.__phase6RecordedPageTools.push(tool);
        },
      },
    });
  });
}

async function executePageTool(
  page: Page,
  name: string,
  input: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  return page.evaluate(
    ({ toolName, toolInput }) => {
      const tool = window.__phase6RecordedPageTools.find((candidate) => candidate.name === toolName);
      if (tool === undefined) throw new Error(`Page tool ${toolName} was not registered.`);
      return tool.execute(toolInput);
    },
    { toolName: name, toolInput: input },
  );
}

function focusedPage(page: Page) {
  return page.locator('.page-surface[data-page-focused="true"]');
}

async function openShelf(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page).toHaveURL(/\/desk$/);
  await expect(page.getByRole("heading", { name: "Notebook shelf" })).toBeVisible();
}

async function createNotebook(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "New notebook" }).click();
  const dialog = page.getByRole("dialog", { name: "Name your notebook" });
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByLabel("Subject").fill("Phase 6 camera isolation");
  await dialog.getByRole("button", { name: "Create notebook" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(focusedPage(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__phase6RecordedPageTools.length)).toBeGreaterThan(0);
}

function diagram(page: Page, index: number) {
  return focusedPage(page).locator(".page-native-diagram-layer").nth(index);
}

async function cameraTransform(page: Page, index: number): Promise<string> {
  return diagram(page, index).locator(".tl-shapes").evaluate((node) => (node as HTMLElement).style.transform);
}

function rectanglesIntersect(left: DOMRect, right: DOMRect): boolean {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}

test.describe("Phase 6 native diagram interaction safety", () => {
  test("isolates two WebMCP diagrams, cameras, focus, and notebook history", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "Two bounded diagrams require the desktop proof viewport.");
    test.setTimeout(90_000);
    const observations = observeBrowser(page);
    await installPageWebMcpRecorder(page);
    await openShelf(page);
    await createNotebook(page, "Phase 6 diagram isolation");

    const readinessStartedAt = await page.evaluate(() => performance.now());
    expect(await executePageTool(page, "page_diagram_add", {
      mutationId: "phase6-diagram-a",
      expectedRevision: 1,
      template: "signal-flow",
      label: "Signal flow A",
      frame: { x: 72, y: 80, width: 320, height: 300 },
    })).toMatchObject({ context: { pageRevision: 2 }, receipt: { kind: "page_diagram_add" } });
    expect(await executePageTool(page, "page_diagram_add", {
      mutationId: "phase6-diagram-b",
      expectedRevision: 2,
      template: "signal-flow",
      label: "Signal flow B",
      frame: { x: 416, y: 80, width: 320, height: 300 },
    })).toMatchObject({ context: { pageRevision: 3 }, receipt: { kind: "page_diagram_add" } });

    await expect(focusedPage(page).locator(".page-native-diagram-layer")).toHaveCount(2);
    await expect.poll(() => diagram(page, 0).locator(".native-diagram").getAttribute("data-native-shape-count")).toMatch(/^(1[0-9]{2}|[2-9][0-9]{2,})$/);
    await expect(diagram(page, 0).locator(".native-diagram")).toHaveAttribute("data-native-binding-count", "4");
    await expect(diagram(page, 1).locator(".native-diagram")).toHaveAttribute("data-native-binding-count", "4");
    const readinessMs = await page.evaluate((startedAt) => performance.now() - startedAt, readinessStartedAt);
    expect(readinessMs).toBeLessThan(4_000);
    testInfo.annotations.push({ type: "two-diagram-readiness-ms", description: readinessMs.toFixed(1) });
    const diagramIds = await focusedPage(page).locator(".native-diagram").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-native-diagram-id")));
    expect(new Set(diagramIds).size).toBe(2);
    await expect(focusedPage(page).locator(".tl-container")).toHaveCount(2);
    await expect(page.getByRole("link", { name: "made with tldraw", exact: true })).toHaveCount(2);

    const pageRevision = await focusedPage(page).getAttribute("data-page-revision");
    const receiptId = await page.locator(".page-navigation").getAttribute("data-recent-receipt-id");
    const undo = page.getByRole("button", { name: "Undo", exact: true });
    const undoDisabled = await undo.isDisabled();
    expect(pageRevision).toBe("3");
    expect(receiptId).not.toBeNull();
    expect(undoDisabled).toBe(false);

    await diagram(page, 0).locator(".tl-canvas").click({ position: { x: 80, y: 150 } });
    await expect(diagram(page, 0).getByRole("toolbar", { name: "tldraw diagram tools" })).toHaveCount(1);
    await expect(diagram(page, 1).getByRole("toolbar", { name: "tldraw diagram tools" })).toHaveCount(0);
    await expect(diagram(page, 0).getByRole("button", { name: "Reset view", exact: true })).toBeVisible();
    await expect(diagram(page, 0).getByRole("button", { name: "Pan", exact: true })).toBeVisible();
    const resetA = diagram(page, 0).getByRole("button", { name: "Reset view", exact: true });
    await resetA.focus();
    await expect(resetA).toBeFocused();

    const initialA = await cameraTransform(page, 0);
    const initialB = await cameraTransform(page, 1);
    const panA = diagram(page, 0).getByRole("button", { name: "Pan", exact: true });
    await panA.focus();
    await page.keyboard.press("Enter");
    const firstCanvas = diagram(page, 0).locator(".tl-canvas");
    const firstCanvasBox = await firstCanvas.boundingBox();
    if (firstCanvasBox === null) throw new Error("Expected the first diagram canvas bounds.");
    await page.mouse.move(firstCanvasBox.x + 120, firstCanvasBox.y + 170);
    await page.mouse.down();
    await page.mouse.move(firstCanvasBox.x + 170, firstCanvasBox.y + 200, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => cameraTransform(page, 0)).not.toBe(initialA);
    expect(await cameraTransform(page, 1)).toBe(initialB);
    expect(await focusedPage(page).getAttribute("data-page-revision")).toBe(pageRevision);
    expect(await page.locator(".page-navigation").getAttribute("data-recent-receipt-id")).toBe(receiptId);
    expect(await undo.isDisabled()).toBe(undoDisabled);

    await diagram(page, 1).locator(".tl-canvas").click({ position: { x: 80, y: 150 } });
    await expect(diagram(page, 1).getByRole("toolbar", { name: "tldraw diagram tools" })).toHaveCount(1);
    await expect(diagram(page, 0).getByRole("toolbar", { name: "tldraw diagram tools" })).toHaveCount(0);
    expect(await cameraTransform(page, 0)).not.toBe(initialA);
    expect(await cameraTransform(page, 1)).toBe(initialB);
    await diagram(page, 0).locator(".tl-canvas").click({ position: { x: 80, y: 150 } });
    await expect(diagram(page, 0).getByRole("toolbar", { name: "tldraw diagram tools" })).toHaveCount(1);
    await diagram(page, 0).getByRole("button", { name: "Reset view", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => cameraTransform(page, 0)).toBe(initialA);
    expect(await cameraTransform(page, 1)).toBe(initialB);
    expect(await focusedPage(page).getAttribute("data-page-revision")).toBe(pageRevision);
    expect(await page.locator(".page-navigation").getAttribute("data-recent-receipt-id")).toBe(receiptId);
    expect(await undo.isDisabled()).toBe(undoDisabled);

    const selectA = diagram(page, 0).getByRole("button", { name: "Select", exact: true });
    await selectA.focus();
    await page.keyboard.press("Enter");
    await page.mouse.move(firstCanvasBox.x + 150, firstCanvasBox.y + 270);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(firstCanvasBox.x + 190, firstCanvasBox.y + 250, { steps: 4 });
    await page.mouse.up({ button: "middle" });
    await expect.poll(() => cameraTransform(page, 0)).not.toBe(initialA);
    await resetA.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => cameraTransform(page, 0)).toBe(initialA);

    expect(await cameraTransform(page, 1)).toBe(initialB);
    expect(await focusedPage(page).getAttribute("data-page-revision")).toBe(pageRevision);
    expect(await page.locator(".page-navigation").getAttribute("data-recent-receipt-id")).toBe(receiptId);
    expect(await undo.isDisabled()).toBe(undoDisabled);

    const controls = page.locator(".page-controls");
    await expect(controls).toBeVisible();
    expect(await controls.evaluate((node) => getComputedStyle(node).position)).not.toMatch(/^(fixed|sticky)$/);
    await page.getByLabel("Add to page").click();
    const addPopover = page.locator(".page-add-popover");
    await expect(addPopover).toBeVisible();
    const hitAreas = await focusedPage(page).locator(".page-native-diagram-layer").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
    const controlRect = await controls.evaluate((node) => node.getBoundingClientRect().toJSON());
    const popoverRect = await addPopover.evaluate((node) => node.getBoundingClientRect().toJSON());
    for (const hitArea of hitAreas) {
      expect(rectanglesIntersect(hitArea as DOMRect, controlRect as DOMRect)).toBe(false);
      expect(rectanglesIntersect(hitArea as DOMRect, popoverRect as DOMRect)).toBe(false);
    }
    await page.screenshot({ path: ".audit/phase-6/visual/two-native-diagrams-reset-controls.png", fullPage: true });
    await page.getByLabel("Add to page").click();

    await page.reload();
    await expect(focusedPage(page).locator(".page-native-diagram-layer")).toHaveCount(2);
    await expect(focusedPage(page)).toHaveAttribute("data-page-revision", "3");
    await expect.poll(() => cameraTransform(page, 0)).toBe(initialA);
    await expect.poll(() => cameraTransform(page, 1)).toBe(initialB);
    await page.evaluate(async () => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    try {
      await page.context().setOffline(true);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(focusedPage(page).locator(".page-native-diagram-layer")).toHaveCount(2);
      await expect(focusedPage(page)).toHaveAttribute("data-page-revision", "3");
      await expect(page.locator(".page-controls")).toHaveCSS("position", "relative");
      await page.screenshot({ path: ".audit/phase-6/visual/two-native-diagrams-offline.png", fullPage: true });
    } finally {
      await page.context().setOffline(false);
    }

    const axe = await new AxeBuilder({ page })
      .include('.page-surface[data-page-focused="true"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(axe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
    expectNoBrowserErrors(observations);
  });
});
