import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const DATABASE_NAME = "project-notebook-phase0-v1";

type RecordedPageTool = {
  readonly name: string;
  readonly execute: (input: unknown) => unknown | Promise<unknown>;
};

declare global {
  interface Window {
    __phase3RecordedPageTools: RecordedPageTool[];
  }
}

type BrowserObservations = {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
};

function observeBrowser(page: Page): BrowserObservations {
  const observations: BrowserObservations = {
    consoleErrors: [],
    pageErrors: [],
  };
  page.on("console", (message) => {
    const location = message.location();
    // The sandbox blocks tldraw's optional hosted assets. Keep application errors visible.
    if (message.type() === "error" && !location.url.includes("cdn.tldraw.com")) {
      observations.consoleErrors.push(`${message.text()} (${location.url}:${location.lineNumber})`);
    }
  });
  page.on("pageerror", (error) => {
    if (error.message !== "NetworkError: A network error occurred.") {
      observations.pageErrors.push(`${error.message}${error.stack === undefined ? "" : ` (${error.stack})`}`);
    }
  });
  return observations;
}

function expectNoBrowserErrors(observations: BrowserObservations): void {
  expect(observations.consoleErrors).toEqual([]);
  expect(observations.pageErrors).toEqual([]);
}

async function installPageWebMcpRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__phase3RecordedPageTools = [];
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool(tool: RecordedPageTool): void {
          window.__phase3RecordedPageTools.push(tool);
        },
      },
    });
  });
}

async function waitForPageReady(page: Page): Promise<void> {
  await expect(page.locator('.page-surface[data-page-focused="true"]')).toBeVisible();
}

async function waitForPageWebMcp(page: Page): Promise<void> {
  await expect.poll(
    () => page.evaluate(() => window.__phase3RecordedPageTools.length),
    { timeout: 10_000 },
  ).toBeGreaterThan(0);
}

function focusedPage(page: Page) {
  return page.locator('.page-surface[data-page-focused="true"]');
}

function pageAtPosition(page: Page, position: "left" | "right") {
  return page.locator(`.notebook-page-slot[data-page-position="${position}"] .page-surface`);
}

async function executePageTool(
  page: Page,
  name: string,
  input: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  return page.evaluate(
    ({ toolName, toolInput }) => {
      const tool = window.__phase3RecordedPageTools.find(
        (candidate) => candidate.name === toolName,
      );
      if (tool === undefined) {
        throw new Error(`Page tool ${toolName} was not registered.`);
      }
      return tool.execute(toolInput);
    },
    { toolName: name, toolInput: input },
  );
}

async function openShelf(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page).toHaveURL(/\/desk$/);
  await expect(
    page.getByRole("heading", { name: "Notebook shelf" }),
  ).toBeVisible();
}

async function createNotebook(
  page: Page,
  title: string,
  subject: string,
): Promise<void> {
  await page.getByRole("button", { name: "New notebook" }).click();
  const dialog = page.getByRole("dialog", { name: "Name your notebook" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByLabel("Subject").fill(subject);
  await dialog.getByRole("button", { name: "Create notebook" }).click();
  await expect(page.getByTestId("focused-notebook")).toBeVisible();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await waitForPageReady(page);
}

async function seedLegacyNotebook(
  page: Page,
  notebookId: string,
  title: string,
  subject: string,
): Promise<void> {
  await page.goto("/favicon.ico");
  await page.evaluate(
    async ({ databaseName, targetNotebookId, notebookTitle, notebookSubject }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName, 2);
        request.onupgradeneeded = () => {
          const opened = request.result;
          if (!opened.objectStoreNames.contains("notebooks")) {
            opened.createObjectStore("notebooks", { keyPath: "id" });
          }
          if (!opened.objectStoreNames.contains("canvasSnapshots")) {
            opened.createObjectStore("canvasSnapshots", { keyPath: "notebookId" });
          }
          if (!opened.objectStoreNames.contains("notes")) {
            const notes = opened.createObjectStore("notes", { keyPath: "id" });
            notes.createIndex("byNotebookLifecycleCreatedAtId", [
              "targetNotebookId",
              "lifecycle",
              "createdAt",
              "id",
            ]);
          }
          if (!opened.objectStoreNames.contains("receipts")) {
            const receipts = opened.createObjectStore("receipts", { keyPath: "id" });
            receipts.createIndex("byCompletedAt", "completedAt");
            receipts.createIndex("byUndoOf", "undoOf", { unique: true });
          }
          if (!opened.objectStoreNames.contains("notebookLifecycle")) {
            opened.createObjectStore("notebookLifecycle", { keyPath: "notebookId" });
          }
          if (!opened.objectStoreNames.contains("workspaceMetadata")) {
            opened.createObjectStore("workspaceMetadata", { keyPath: "id" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("legacy database open failed"));
      });
      const transaction = database.transaction(
        ["notebooks", "notes", "canvasSnapshots"],
        "readwrite",
      );
      const at = "2026-08-26T11:00:00.000Z";
      transaction.objectStore("notebooks").put({
        id: targetNotebookId,
        title: notebookTitle,
        subject: notebookSubject,
        revision: 1,
        createdAt: at,
        updatedAt: at,
      });
      transaction.objectStore("notes").put({
        id: `${targetNotebookId}:note-a`,
        targetNotebookId,
        revision: 1,
        contentVersion: 1,
        content: { format: "plain_text", text: "Migrated field note" },
        lifecycle: "active",
        createdAt: at,
        updatedAt: at,
      });
      transaction.objectStore("notes").put({
        id: `${targetNotebookId}:note-b`,
        targetNotebookId,
        revision: 1,
        contentVersion: 1,
        content: { format: "plain_text", text: "Second migrated note" },
        lifecycle: "active",
        createdAt: "2026-08-26T11:01:00.000Z",
        updatedAt: "2026-08-26T11:01:00.000Z",
      });
      transaction.objectStore("canvasSnapshots").put({
        notebookId: targetNotebookId,
        version: 1,
        savedAt: "2026-08-26T11:02:00.000Z",
        snapshot: { shapes: [{ id: "legacy-mark", type: "ellipse" }] },
      });
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("legacy seed failed"));
        transaction.onabort = () => reject(transaction.error ?? new Error("legacy seed aborted"));
      });
      database.close();
    },
    {
      databaseName: DATABASE_NAME,
      targetNotebookId: notebookId,
      notebookTitle: title,
      notebookSubject: subject,
    },
  );
}

type StoredPageState = Readonly<{
  readonly document: unknown;
  readonly pages: readonly unknown[];
}>;

async function readPageState(page: Page): Promise<StoredPageState> {
  return page.evaluate(async (databaseName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("page database open failed"));
    });
    const transaction = database.transaction(["pageDocuments", "pages"], "readonly");
    const documentRequest = transaction.objectStore("pageDocuments").getAll();
    const pagesRequest = transaction.objectStore("pages").getAll();
    const result = await new Promise<StoredPageState>((resolve, reject) => {
      transaction.oncomplete = () => resolve({
        document: documentRequest.result[0],
        pages: pagesRequest.result,
      });
      transaction.onerror = () => reject(transaction.error ?? new Error("page state read failed"));
    });
    database.close();
    return result;
  }, DATABASE_NAME);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordString(record: unknown, key: string): string | undefined {
  if (!isRecord(record)) return undefined;
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function recordNumber(record: unknown, key: string): number | undefined {
  if (!isRecord(record)) return undefined;
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function requiredValue(value: string | null, label: string): string {
  if (value === null) throw new Error(`Expected ${label} to be present.`);
  return value;
}

function hasElementKind(page: unknown, kind: string): boolean {
  if (!isRecord(page) || !Array.isArray(page.elements)) return false;
  return page.elements.some(
    (element) => isRecord(element) && element.kind === kind,
  );
}

function textElements(page: unknown): readonly unknown[] {
  if (!isRecord(page) || !Array.isArray(page.elements)) return [];
  return page.elements.filter(
    (element) => isRecord(element) && element.kind === "text",
  );
}

async function seedPageClaim(
  page: Page,
  workbookId: string,
  pageId: string,
): Promise<void> {
  await page.evaluate(
    async ({ databaseName, targetWorkbookId, targetPageId }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("claim database open failed"));
      });
      const transaction = database.transaction("pageWriterClaims", "readwrite");
      const now = new Date().toISOString();
      transaction.objectStore("pageWriterClaims").put({
        pageId: targetPageId,
        workbookId: targetWorkbookId,
        actorId: "assistant:already-editing",
        claimId: "e2e-held-claim",
        acquiredAt: now,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("claim seed failed"));
      });
      database.close();
    },
    { databaseName: DATABASE_NAME, targetWorkbookId: workbookId, targetPageId: pageId },
  );
}

test.describe("Phase 3 notebook pages", () => {
  test("opens an existing migrated notebook and retains its page content", async ({ page }) => {
    const observations = observeBrowser(page);
    const notebookId = "phase3-migrated-e2e";
    await seedLegacyNotebook(
      page,
      notebookId,
      "Migrated field notes",
      "Notes carried forward from the previous notebook format",
    );

    await page.goto(`/desk?notebook=${notebookId}`);
    await expect(page.getByRole("heading", { name: "Migrated field notes" })).toBeVisible();
    await waitForPageReady(page);
    const current = focusedPage(page);
    await expect(current.locator(".page-semantic-copy section")).toHaveCount(2);
    await expect(current.locator(".page-semantic-copy section").nth(0)).toContainText("Migrated field note");
    await expect(current.locator(".page-semantic-copy section").nth(1)).toContainText("Second migrated note");
    await expect(current).toHaveAttribute("data-page-number", "1");

    const state = await readPageState(page);
    expect(state.pages).toHaveLength(1);
    expect(hasElementKind(state.pages[0], "embedded-frame")).toBe(true);
    expect(textElements(state.pages[0])).toHaveLength(2);
    expect(recordNumber(state.document, "documentRevision")).toBe(1);
    expectNoBrowserErrors(observations);
  });

  test("creates structured text and a shape through manual page controls", async ({ page }) => {
    const observations = observeBrowser(page);
    await openShelf(page);
    await createNotebook(page, "Manual page", "Structured text and shapes");

    await page.getByLabel("Add to page").click();
    await page.getByLabel("Text").fill("A structured paragraph");
    await page.getByRole("button", { name: "Add text", exact: true }).click();
    await expect(focusedPage(page).locator(".page-semantic-copy")).toContainText("A structured paragraph");

    await page.getByRole("button", { name: "Add shape", exact: true }).click();
    await expect(focusedPage(page)).toHaveAttribute("data-graphics-renderer", "tldraw");
    await expect(focusedPage(page).locator('[data-page-renderer="tldraw"]')).toBeVisible();
    await expect(focusedPage(page).locator('.page-scene [data-element-kind="shape"]')).toHaveCount(0);

    const currentPageId = await focusedPage(page).getAttribute("data-page-id");
    expect(currentPageId).not.toBeNull();
    const state = await readPageState(page);
    const currentPage = state.pages.find((candidate) => recordString(candidate, "id") === currentPageId);
    expect(currentPage).toBeDefined();
    expect(hasElementKind(currentPage, "text")).toBe(true);
    expect(hasElementKind(currentPage, "shape")).toBe(true);
    expect(recordNumber(currentPage, "revision")).toBe(3);
    const focusedAxe = await new AxeBuilder({ page })
      .include('.page-surface[data-page-focused="true"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(focusedAxe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
    expectNoBrowserErrors(observations);
  });

  test("keeps tldraw out of normal reading and mounts it only for a drawing session", async ({ page }) => {
    const observations = observeBrowser(page);
    await openShelf(page);
    await createNotebook(page, "Transient drawing", "A temporary graphics editor");

    await expect(page.locator('[data-page-renderer="tldraw"]')).toHaveCount(0);
    await expect(page.getByText("Get a license for production", { exact: true })).toHaveCount(0);
    await expect(page.locator(".page-agent-status, .page-command-status, [data-active-tool]")).toHaveCount(0);

    const revision = await focusedPage(page).getAttribute("data-page-revision");
    await page.getByLabel("Add to page").click();
    await page.getByRole("button", { name: "Draw", exact: true }).click();
    await expect(page.locator('[data-page-renderer="tldraw"]')).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Drawing editor" })).toBeVisible();
    await expect(page.getByRole("link", { name: "made with tldraw", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Cancel drawing", exact: true }).click();
    await expect(page.locator('[data-page-renderer="tldraw"]')).toHaveCount(0);
    await expect(focusedPage(page)).toHaveAttribute("data-page-revision", revision ?? "1");
    expectNoBrowserErrors(observations);
  });

  test("persists the selected paper and supported page size", async ({ page }) => {
    await openShelf(page);
    await createNotebook(page, "Presentation settings", "Canonical paper and size");
    await page.getByLabel("Page settings").click();
    await page.getByRole("button", { name: "Grid" }).click();
    await page.getByRole("button", { name: "A4" }).click();
    await expect(page.locator("[data-editor-host]")).toHaveAttribute("data-paper", "grid");
    await expect(page.locator("[data-editor-host]")).toHaveAttribute("data-page-size", "a4");

    await page.reload();
    await expect(page.getByRole("heading", { name: "Presentation settings" })).toBeVisible();
    await expect(page.locator("[data-editor-host]")).toHaveAttribute("data-paper", "grid");
    await expect(page.locator("[data-editor-host]")).toHaveAttribute("data-page-size", "a4");
    await expect(focusedPage(page)).toHaveCSS("aspect-ratio", "794 / 1123");
    await expect.poll(async () => focusedPage(page).evaluate((sheet) => {
      const box = sheet.getBoundingClientRect();
      return box.height / box.width;
    })).toBeCloseTo(1123 / 794, 2);
  });

  test("registers page-scoped WebMCP tools and rejects ambiguous and stale mutations", async ({ page }) => {
    const observations = observeBrowser(page);
    await installPageWebMcpRecorder(page);
    await openShelf(page);
    await createNotebook(page, "Page tools", "Canonical browser command path");
    await waitForPageWebMcp(page);

    const toolNames = await page.evaluate(() =>
      window.__phase3RecordedPageTools.map((tool) => tool.name),
    );
    expect(toolNames).toEqual(expect.arrayContaining([
      "page_context_read",
      "page_text_insert",
      "page_text_format",
      "page_annotation_add",
      "page_shape_add",
      "page_advance",
      "page_text_continue",
      "page_undo",
    ]));

    const first = await executePageTool(page, "page_text_insert", {
      mutationId: "ambiguous-a",
      expectedRevision: 1,
      text: "Repeated phrase",
    });
    expect(first).toMatchObject({ context: { plainText: "Repeated phrase", pageRevision: 2 } });
    const second = await executePageTool(page, "page_text_insert", {
      mutationId: "ambiguous-b",
      expectedRevision: 2,
      text: "Repeated phrase",
    });
    expect(second).toMatchObject({ context: { pageRevision: 3 } });

    const ambiguous = await executePageTool(page, "page_annotation_add", {
      mutationId: "ambiguous-annotation",
      actorId: "assistant:ambiguous",
      expectedRevision: 3,
      target: { kind: "phrase", phrase: "Repeated phrase" },
      annotation: "highlight",
    });
    expect(ambiguous).toMatchObject({ outcome: "error", error: { code: "TARGET_AMBIGUOUS" } });

    const stale = await executePageTool(page, "page_shape_add", {
      mutationId: "stale-shape",
      expectedRevision: 1,
      shape: "ellipse",
    });
    expect(stale).toMatchObject({ outcome: "error", error: { code: "REVISION_CONFLICT" } });
    await expect(focusedPage(page)).toHaveAttribute("data-page-revision", "3");
    expectNoBrowserErrors(observations);
  });

  test("resolves an exact visible phrase through the registered WebMCP tool", async ({ page }) => {
    const observations = observeBrowser(page);
    await installPageWebMcpRecorder(page);
    await openShelf(page);
    await createNotebook(page, "Exact target", "Stable text-range targeting");
    await waitForPageWebMcp(page);

    const focusedPageId = requiredValue(
      await focusedPage(page).getAttribute("data-page-id"),
      "the focused page id",
    );
    const inserted = await executePageTool(page, "page_text_insert", {
      mutationId: "exact-target-source",
      expectedRevision: 1,
      text: "An agent can find this visible phrase exactly.",
      label: "Exact target proof",
    });
    expect(inserted).toMatchObject({ context: { focusedPageId, pageRevision: 2 } });

    const resolved = await executePageTool(page, "page_target_resolve", {
      target: { kind: "phrase", value: "visible phrase" },
    });
    expect(resolved).toMatchObject({
      context: { focusedPageId, pageRevision: 2 },
      resolution: {
        kind: "text-range",
        pageId: focusedPageId,
        elementId: "phase3:mutation:exact-target-source",
        blockId: "phase3:block:exact-target-source",
        start: 23,
        end: 37,
        preview: "visible phrase",
        boxes: [expect.objectContaining({
          x: expect.any(Number),
          y: expect.any(Number),
          width: expect.any(Number),
          height: expect.any(Number),
        })],
      },
    });
    await expect(focusedPage(page)).toHaveAttribute("data-page-id", focusedPageId);
    expectNoBrowserErrors(observations);
  });

  test("continues finite text at a word boundary and displays a two-page spread", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile-chromium", "The mobile layout intentionally hides the two-page control.");
    const observations = observeBrowser(page);
    await installPageWebMcpRecorder(page);
    await openShelf(page);
    await createNotebook(page, "Continuation", "Finite page flow");
    await waitForPageWebMcp(page);

    const sourceText = "First page text continues cleanly before the next finite page.";
    const splitAt = sourceText.indexOf("before");
    expect(splitAt).toBeGreaterThan(0);
    const inserted = await executePageTool(page, "page_text_insert", {
      mutationId: "continuation-source",
      expectedRevision: 1,
      text: sourceText,
    });
    expect(inserted).toMatchObject({ context: { pageRevision: 2, pageCount: 1 } });

    const continued = await executePageTool(page, "page_text_continue", {
      mutationId: "continuation-edit",
      expectedRevision: 2,
      expectedDocumentRevision: 1,
      elementId: "phase3:mutation:continuation-source",
      blockId: "phase3:block:continuation-source",
      splitAt,
    });
    expect(continued).toMatchObject({ context: { pageRevision: 2, pageCount: 2, focusedPageNumber: 2 } });
    await expect(focusedPage(page)).toHaveAttribute("data-page-number", "2");
    await expect(focusedPage(page).locator(".page-semantic-copy")).toContainText("before the next finite page.");

    await page.setViewportSize({ width: 1200, height: 800 });
    await page.getByRole("button", { name: "2 pages", exact: true }).click();
    await expect(page.locator("[data-editor-host]")).toHaveAttribute("data-layout", "spread");
    const leftPage = pageAtPosition(page, "left");
    const rightPage = pageAtPosition(page, "right");
    await expect(leftPage).toBeVisible();
    await expect(rightPage).toBeVisible();
    await expect(leftPage).toHaveAttribute("tabindex", "0");
    await expect(rightPage).toHaveAttribute("tabindex", "0");
    await expect(leftPage.locator(".page-semantic-copy")).toContainText("First page text continues cleanly");
    await expect(rightPage.locator(".page-semantic-copy")).toContainText("before the next finite page.");
    expect(await page.locator(".notebook-page-slot[data-page-position]").evaluateAll((slots) => slots.map((slot) => slot.getAttribute("data-page-position")))).toEqual(["left", "right"]);
    expectNoBrowserErrors(observations);
  });

  test("performs exact Undo and reloads the remaining edit", async ({ page }) => {
    const observations = observeBrowser(page);
    await openShelf(page);
    await createNotebook(page, "Undo notebook", "One exact semantic edit");

    await page.getByLabel("Add to page").click();
    const textDraft = page.getByLabel("Text");
    await textDraft.fill("Keep this edit");
    await page.getByRole("button", { name: "Add text", exact: true }).click();
    await expect(focusedPage(page).locator(".page-semantic-copy")).toContainText("Keep this edit");
    await textDraft.fill("Remove only this edit");
    await page.getByRole("button", { name: "Add text", exact: true }).click();
    await expect(focusedPage(page).locator(".page-semantic-copy section")).toHaveCount(2);

    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(focusedPage(page).locator(".page-semantic-copy section")).toHaveCount(1);
    await expect(focusedPage(page).locator(".page-semantic-copy")).toContainText("Keep this edit");
    await expect(focusedPage(page).locator(".page-semantic-copy")).not.toContainText("Remove only this edit");

    const currentPageId = await focusedPage(page).getAttribute("data-page-id");
    const state = await readPageState(page);
    const currentPage = state.pages.find((candidate) => recordString(candidate, "id") === currentPageId);
    expect(textElements(currentPage)).toHaveLength(1);
    expect(recordNumber(currentPage, "revision")).toBe(4);

    await page.reload();
    await expect(focusedPage(page).locator(".page-semantic-copy section")).toHaveCount(1);
    await expect(focusedPage(page).locator(".page-semantic-copy")).toContainText("Keep this edit");
    expectNoBrowserErrors(observations);
  });

  test("rejects a competing same-page write while allowing an independent page commit", async ({ page }) => {
    const observations = observeBrowser(page);
    await installPageWebMcpRecorder(page);
    await openShelf(page);
    await createNotebook(page, "Concurrent pages", "Independent writer claims");
    await waitForPageWebMcp(page);

    const workbookUrl = page.url();
    const workbookId = requiredValue(new URL(workbookUrl).searchParams.get("notebook"), "the workbook id");
    const firstPageId = requiredValue(
      await focusedPage(page).getAttribute("data-page-id"),
      "the first page id",
    );
    const advanced = await executePageTool(page, "page_advance", {
      mutationId: "create-second-page",
      expectedDocumentRevision: 1,
    });
    expect(advanced).toMatchObject({ context: { pageCount: 2, focusedPageNumber: 2 } });
    const secondPageId = requiredValue(
      await focusedPage(page).getAttribute("data-page-id"),
      "the second page id",
    );

    const secondPage = await page.context().newPage();
    const secondObservations = observeBrowser(secondPage);
    try {
      await installPageWebMcpRecorder(secondPage);
      await secondPage.goto(workbookUrl);
      await expect(secondPage.getByRole("heading", { name: "Concurrent pages" })).toBeVisible();
      await waitForPageReady(secondPage);
      await waitForPageWebMcp(secondPage);
      await seedPageClaim(page, workbookId, firstPageId);
      await page.getByRole("button", { name: "Previous", exact: true }).click();
      await expect(focusedPage(page)).toHaveAttribute("data-page-id", firstPageId);

      const blocked = await executePageTool(page, "page_text_insert", {
        mutationId: "blocked-same-page",
        actorId: "assistant:challenger",
        pageId: firstPageId,
        expectedRevision: 1,
        text: "Blocked on the claimed first page",
      });
      expect(blocked).toMatchObject({ outcome: "error", error: { code: "PAGE_BUSY" } });

      await secondPage.getByRole("button", { name: "Next", exact: true }).click();
      await expect(focusedPage(secondPage)).toHaveAttribute("data-page-id", secondPageId);
      const independent = await executePageTool(secondPage, "page_text_insert", {
        mutationId: "independent-page",
        actorId: "assistant:separate-page",
        pageId: secondPageId,
        expectedRevision: 1,
        text: "Independent second-page write",
      });
      expect(independent).toMatchObject({
        context: { focusedPageId: secondPageId, pageRevision: 2, pageCount: 2 },
        receipt: {
          affectedPageIds: [secondPageId],
          resultingPageRevisions: { [secondPageId]: 2 },
        },
      });
      await expect(focusedPage(secondPage)).toHaveAttribute("data-page-id", secondPageId);
      await expect(focusedPage(secondPage).locator(".page-semantic-copy")).toContainText(
        "Independent second-page write",
      );

      const state = await readPageState(page);
      const firstPage = state.pages.find((candidate) => recordString(candidate, "id") === firstPageId);
      const secondPageState = state.pages.find((candidate) => recordString(candidate, "id") === secondPageId);
      expect(hasElementKind(firstPage, "text")).toBe(false);
      expect(hasElementKind(secondPageState, "text")).toBe(true);
      expect(recordNumber(secondPageState, "revision")).toBe(2);
      expectNoBrowserErrors(observations);
      expectNoBrowserErrors(secondObservations);
    } finally {
      await secondPage.close();
    }
  });

  test("retains the focused page through an offline reload", async ({ page }) => {
    test.setTimeout(90_000);
    const observations = observeBrowser(page);
    await openShelf(page);
    await createNotebook(page, "Offline page", "Retained without a connection");
    await page.getByLabel("Add to page").click();
    await page.getByLabel("Text").fill("Offline retained content");
    await page.getByRole("button", { name: "Add text", exact: true }).click();
    await expect(focusedPage(page).locator(".page-semantic-copy")).toContainText("Offline retained content");
    await page.evaluate(async () => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

    try {
      await page.context().setOffline(true);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Offline page" })).toBeVisible();
      await expect(focusedPage(page).locator(".page-semantic-copy")).toContainText("Offline retained content");
      await expect(page.locator("[data-editor-host]")).toBeVisible();
    } finally {
      await page.context().setOffline(false);
    }
    expectNoBrowserErrors(observations);
  });

  test("keeps keyboard access and avoids serious or critical axe findings", async ({ page }) => {
    const observations = observeBrowser(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openShelf(page);
    const shelfAxe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(shelfAxe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);

    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Open Inbox" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "New notebook" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Name your notebook" })).toBeVisible();
    await page.getByLabel("Title").fill("Keyboard page");
    await page.getByLabel("Subject").fill("Accessible Phase 3 page");
    await page.getByRole("button", { name: "Create notebook" }).click();
    await waitForPageReady(page);
    const focusedAxe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(focusedAxe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
    expectNoBrowserErrors(observations);
  });

  test("renders the app-owned ruled paper at mobile width", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-chromium", "This assertion targets the mobile project viewport.");
    const observations = observeBrowser(page);
    await openShelf(page);
    await createNotebook(page, "Mobile paper", "A full-width responsive page");
    await expect(page.locator("[data-page-renderer=\"tldraw\"]")).toHaveCount(0);
    const visual = await page.evaluate(() => {
      const sheet = document.querySelector('.page-surface[data-page-focused="true"]');
      const scene = document.querySelector('.page-surface[data-page-focused="true"] .page-scene');
      if (sheet === null || scene === null) {
        throw new Error("The mobile paper surface is incomplete.");
      }
      const sheetBox = sheet.getBoundingClientRect();
      const sceneBox = scene.getBoundingClientRect();
      return {
        sheetWidth: sheetBox.width,
        sheetHeight: sheetBox.height,
        sceneWidth: sceneBox.width,
        sceneHeight: sceneBox.height,
        paper: sheet.getAttribute("data-page-paper"),
        ruleCount: scene.querySelectorAll("[data-paper-rule]").length,
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
    expect(visual.sheetWidth).toBeGreaterThan(300);
    expect(visual.sheetHeight / visual.sheetWidth).toBeCloseTo(1056 / 816, 1);
    expect(visual.sceneWidth).toBeCloseTo(visual.sheetWidth, 0);
    expect(visual.sceneHeight).toBeCloseTo(visual.sheetHeight, 0);
    expect(visual.paper).toBe("lined");
    expect(visual.ruleCount).toBeGreaterThan(10);
    expect(visual.scrollWidth).toBeLessThanOrEqual(visual.clientWidth);
    expectNoBrowserErrors(observations);
  });
});
