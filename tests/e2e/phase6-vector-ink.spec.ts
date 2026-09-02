import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

import { createDetailedVectorInkFixture } from "../helpers/detailed-vector-ink-fixture";

const DATABASE_NAME = "project-notebook-phase0-v1";
const BROWSER_EVIDENCE_DIR = ".audit/phase-6/vector-ink/browser";
const VECTOR_ELEMENT_ID = "phase3:vector-ink:phase6-vector-ink-add";

type RecordedPageTool = {
  readonly name: string;
  readonly execute: (input: unknown) => unknown | Promise<unknown>;
};

declare global {
  interface Window {
    __phase6VectorInkRecordedPageTools: RecordedPageTool[];
  }
}

type BrowserObservations = {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
};

type CanonicalPageState = Readonly<{
  readonly document: unknown;
  readonly pages: readonly unknown[];
}>;

test.use({ deviceScaleFactor: 2 });

function observeBrowser(page: Page): BrowserObservations {
  const observations: BrowserObservations = { consoleErrors: [], pageErrors: [] };
  page.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location();
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
    window.__phase6VectorInkRecordedPageTools = [];
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool(tool: RecordedPageTool): void {
          window.__phase6VectorInkRecordedPageTools.push(tool);
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
      const tool = window.__phase6VectorInkRecordedPageTools.find((candidate) => candidate.name === toolName);
      if (tool === undefined) throw new Error(`Page tool ${toolName} was not registered.`);
      return tool.execute(toolInput);
    },
    { toolName: name, toolInput: input },
  );
}

function focusedPage(page: Page) {
  return page.locator('.page-surface[data-page-focused="true"]');
}

function vectorGraphic(page: Page) {
  return focusedPage(page).locator('.page-scene [data-element-kind="vector-ink"]');
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
  await dialog.getByLabel("Subject").fill("Portable vector ink acceptance");
  await dialog.getByRole("button", { name: "Create notebook" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(focusedPage(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__phase6VectorInkRecordedPageTools.length)).toBeGreaterThan(0);
}

async function captureEvidence(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${BROWSER_EVIDENCE_DIR}/${name}.png`, fullPage: true });
}

async function readCanonicalPageState(page: Page): Promise<CanonicalPageState> {
  return page.evaluate(async (databaseName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("page database open failed"));
    });
    const transaction = database.transaction(["pageDocuments", "pages"], "readonly");
    const documentRequest = transaction.objectStore("pageDocuments").getAll();
    const pagesRequest = transaction.objectStore("pages").getAll();
    const result = await new Promise<CanonicalPageState>((resolve, reject) => {
      transaction.oncomplete = () => {
        const rawDocument = documentRequest.result[0];
        if (rawDocument === undefined) {
          reject(new Error("The canonical page document was not persisted."));
          return;
        }
        const document = Object.fromEntries(Object.entries(rawDocument).filter(([key]) => key !== "updatedAt"));
        const pages = pagesRequest.result.map((rawPage) => Object.fromEntries(
          Object.entries(rawPage).filter(([key]) => key !== "revision" && key !== "updatedAt"),
        ));
        resolve({ document, pages });
      };
      transaction.onerror = () => reject(transaction.error ?? new Error("page state read failed"));
    });
    database.close();
    return result;
  }, DATABASE_NAME);
}

test.describe("Phase 6 generic vector ink", () => {
  test("adds, moves, undoes, rejects unsafe placement, and survives reloads", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "The high-resolution vector-ink proof uses the desktop viewport.");
    test.setTimeout(120_000);
    await mkdir(BROWSER_EVIDENCE_DIR, { recursive: true });
    const vectorInkDocument = createDetailedVectorInkFixture();
    const observations = observeBrowser(page);
    await installPageWebMcpRecorder(page);
    await openShelf(page);
    await createNotebook(page, "Phase 6 vector ink");

    const toolNames = await page.evaluate(() => window.__phase6VectorInkRecordedPageTools.map((tool) => tool.name));
    expect(toolNames).toContain("page_vector_ink_add");

    const text = await executePageTool(page, "page_text_insert", {
      mutationId: "phase6-vector-ink-readable-text",
      actorId: "assistant:phase6-vector-ink",
      expectedRevision: 1,
      text: "Readable source text stays above the vector figure.",
      label: "Readable source text",
      frame: { x: 96, y: 96, width: 600, height: 96 },
    });
    expect(text).toMatchObject({
      context: { pageRevision: 2, plainText: "Readable source text stays above the vector figure." },
      receipt: { kind: "page_text_insert", resultingPageRevisions: expect.any(Object) },
    });
    await expect(focusedPage(page).locator(".page-semantic-copy")).toContainText("Readable source text stays above the vector figure.");
    await captureEvidence(page, "before-vector");

    const afterTextState = await readCanonicalPageState(page);
    const added = await executePageTool(page, "page_vector_ink_add", {
      mutationId: "phase6-vector-ink-add",
      actorId: "assistant:phase6-vector-ink",
      expectedRevision: 2,
      label: "Detailed vector fixture",
      description: "A bounded editable vector fixture generated deterministically for browser acceptance.",
      provenance: {
        kind: "test-fixture",
        sourceLabel: "deterministic-detailed-vector",
        sourceFormat: "generated commands",
        tool: "Project Notebook test helper",
        toolVersion: "1",
      },
      frame: { x: 72, y: 260, width: 670, height: 154 },
      document: vectorInkDocument,
    });
    expect(added).toMatchObject({
      context: {
        pageRevision: 3,
        elements: expect.arrayContaining([
          expect.objectContaining({
            id: VECTOR_ELEMENT_ID,
            kind: "vector-ink",
            description: "A bounded editable vector fixture generated deterministically for browser acceptance.",
            frame: { x: 72, y: 260, width: 670, height: 154 },
          }),
        ]),
      },
      receipt: {
        kind: "page_vector_ink_add",
        mutationId: "phase6-vector-ink-add",
        resultingPageRevisions: expect.any(Object),
        undo: { kind: "available" },
      },
    });
    const addReceiptId = await page.locator(".page-navigation").getAttribute("data-recent-receipt-id");
    expect(addReceiptId).not.toBeNull();
    await expect(vectorGraphic(page)).toHaveCount(1);
    await expect(vectorGraphic(page)).toHaveAttribute("data-element-id", VECTOR_ELEMENT_ID);
    await expect(vectorGraphic(page).locator("path")).toHaveCount(1);
    await expect(focusedPage(page).locator('.page-semantic-copy figure[aria-label="Detailed vector fixture"]')).toContainText("A bounded editable vector fixture generated deterministically for browser acceptance.");
    await expect(focusedPage(page).locator('.page-semantic-copy figure')).toHaveCount(1);
    const originalTransform = await vectorGraphic(page).getAttribute("transform");
    const originalPathData = await vectorGraphic(page).locator("path").getAttribute("d");
    expect(originalTransform).toBe("translate(72 260) scale(1 1)");
    expect(originalPathData).not.toBeNull();
    await captureEvidence(page, "after-vector");

    const afterAddState = await readCanonicalPageState(page);
    expect(afterAddState).not.toEqual(afterTextState);

    const moved = await executePageTool(page, "page_element_move", {
      mutationId: "phase6-vector-ink-move",
      actorId: "assistant:phase6-vector-ink",
      expectedRevision: 3,
      elementId: VECTOR_ELEMENT_ID,
      frame: { x: 72, y: 480, width: 670, height: 154 },
    });
    expect(moved).toMatchObject({
      context: {
        pageRevision: 4,
        elements: expect.arrayContaining([
          expect.objectContaining({ id: VECTOR_ELEMENT_ID, frame: { x: 72, y: 480, width: 670, height: 154 } }),
        ]),
      },
      receipt: { kind: "page_element_move", undo: { kind: "available" } },
    });
    await expect(vectorGraphic(page)).toHaveAttribute("transform", "translate(72 480) scale(1 1)");
    expect(await vectorGraphic(page).locator("path").getAttribute("d")).toBe(originalPathData);
    await captureEvidence(page, "moved-vector");

    const moveReceiptId = await page.locator(".page-navigation").getAttribute("data-recent-receipt-id");
    if (moveReceiptId === null) throw new Error("The move receipt id was not rendered.");
    const restored = await executePageTool(page, "page_undo", {
      mutationId: "phase6-vector-ink-move-undo",
      actorId: "assistant:phase6-vector-ink",
      receiptId: moveReceiptId,
    });
    expect(restored).toMatchObject({
      context: {
        pageRevision: 5,
        elements: expect.arrayContaining([
          expect.objectContaining({ id: VECTOR_ELEMENT_ID, frame: { x: 72, y: 260, width: 670, height: 154 } }),
        ]),
      },
      receipt: { kind: "page_undo", undo: { kind: "unavailable" } },
    });
    await expect(vectorGraphic(page)).toHaveAttribute("transform", originalTransform ?? "");
    expect(await vectorGraphic(page).locator("path").getAttribute("d")).toBe(originalPathData);
    const restoredState = await readCanonicalPageState(page);
    expect(restoredState).toEqual(afterAddState);
    await captureEvidence(page, "restored-vector");

    const restoredRevision = await focusedPage(page).getAttribute("data-page-revision");
    const restoredReceiptId = await page.locator(".page-navigation").getAttribute("data-recent-receipt-id");
    expect(restoredRevision).toBe("5");
    expect(restoredReceiptId).not.toBeNull();
    const unsafe = await executePageTool(page, "page_vector_ink_add", {
      mutationId: "phase6-vector-ink-unsafe-add",
      actorId: "assistant:phase6-vector-ink",
      expectedRevision: 5,
      label: "Unsafe overlap",
      description: "This vector figure must be rejected because it overlaps readable text.",
      frame: { x: 120, y: 120, width: 600, height: 150 },
      document: vectorInkDocument,
    });
    expect(unsafe).toMatchObject({
      outcome: "error",
      command: "page_vector_ink_add",
      error: { code: "SAFE_PLACEMENT_UNAVAILABLE" },
    });
    await expect(focusedPage(page)).toHaveAttribute("data-page-revision", restoredRevision ?? "");
    expect(await page.locator(".page-navigation").getAttribute("data-recent-receipt-id")).toBe(restoredReceiptId);
    expect(await readCanonicalPageState(page)).toEqual(restoredState);
    await expect(vectorGraphic(page)).toHaveCount(1);
    await captureEvidence(page, "before-reload-vector");

    await page.reload();
    await expect(focusedPage(page)).toHaveAttribute("data-page-revision", "5");
    await expect(vectorGraphic(page)).toHaveCount(1);
    await expect(vectorGraphic(page)).toHaveAttribute("data-element-id", VECTOR_ELEMENT_ID);
    await expect(focusedPage(page).locator('.page-semantic-copy figure[aria-label="Detailed vector fixture"]')).toHaveCount(1);
    await captureEvidence(page, "reload-vector");

    await page.evaluate(async () => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    try {
      await page.context().setOffline(true);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(focusedPage(page)).toHaveAttribute("data-page-revision", "5");
      await expect(vectorGraphic(page)).toHaveCount(1);
      await expect(focusedPage(page).locator('.page-semantic-copy figure[aria-label="Detailed vector fixture"]')).toContainText("A bounded editable vector fixture generated deterministically for browser acceptance.");
      await captureEvidence(page, "offline-reload-vector");
    } finally {
      await page.context().setOffline(false);
    }

    await focusedPage(page).focus();
    await expect(focusedPage(page)).toBeFocused();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
    const axe = await new AxeBuilder({ page })
      .include('.page-surface[data-page-focused="true"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(axe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
    expectNoBrowserErrors(observations);
  });
});
