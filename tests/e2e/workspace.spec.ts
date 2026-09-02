import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const DATABASE_NAME = "project-notebook-phase0-v1";

type BrowserObservations = {
  readonly consoleProblems: string[];
  readonly pageErrors: string[];
  readonly forbiddenRequests: string[];
  readonly sameDocumentViolations: string[];
};

function observeBrowser(page: Page): BrowserObservations {
  const observations: BrowserObservations = {
    consoleProblems: [],
    pageErrors: [],
    forbiddenRequests: [],
    sameDocumentViolations: [],
  };
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      observations.consoleProblems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => observations.pageErrors.push(error.message));
  page.on("request", (request) => {
    const requestUrl = request.url();
    if (
      request.resourceType() === "document" ||
      new URL(requestUrl).searchParams.has("_rsc")
    ) {
      observations.sameDocumentViolations.push(requestUrl);
    }
    if (
      /openai|credential|microphone|deployment/i.test(
        requestUrl,
      )
    ) {
      observations.forbiddenRequests.push(requestUrl);
    }
  });
  return observations;
}

async function openShelf(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page).toHaveURL(/\/desk$/);
  await expect(
    page.getByRole("heading", { name: "Notebook shelf" }),
  ).toBeVisible();
  await expect(page.locator("[data-desk-host]")).toHaveCount(1);
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
  await expect(page.locator('.page-surface[data-page-focused="true"]')).toBeVisible();
}

async function seedPreservedRows(page: Page): Promise<void> {
  await page.evaluate(async (databaseName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onupgradeneeded = () => {
        const opened = request.result;
        if (!opened.objectStoreNames.contains("notebooks")) {
          opened.createObjectStore("notebooks", { keyPath: "id" });
        }
        if (!opened.objectStoreNames.contains("canvasSnapshots")) {
          opened.createObjectStore("canvasSnapshots", { keyPath: "notebookId" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("open failed"));
    });
    const transaction = database.transaction(
      ["notebooks", "canvasSnapshots"],
      "readwrite",
    );
    transaction.objectStore("notebooks").put({
      id: "preserved-e2e",
      title: "Preserved field notes",
      subject: "Existing local notebook",
      revision: 1,
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
    });
    transaction.objectStore("canvasSnapshots").put({
      notebookId: "preserved-e2e",
      version: 1,
      savedAt: "2026-08-25T12:30:00.000Z",
      snapshot: { shapes: [{ id: "existing-shape", type: "note" }] },
    });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("seed failed"));
    });
    database.close();
  }, DATABASE_NAME);
}

async function readPreservedRows(page: Page): Promise<{
  readonly notebook: unknown;
  readonly canvas: unknown;
  readonly notebookCount: number;
}> {
  return page.evaluate(async (databaseName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("open failed"));
    });
    const transaction = database.transaction(
      ["notebooks", "canvasSnapshots"],
      "readonly",
    );
    const notebookRequest = transaction
      .objectStore("notebooks")
      .get("preserved-e2e");
    const canvasRequest = transaction
      .objectStore("canvasSnapshots")
      .get("preserved-e2e");
    const countRequest = transaction.objectStore("notebooks").count();
    const result = await new Promise<{
      readonly notebook: unknown;
      readonly canvas: unknown;
      readonly notebookCount: number;
    }>((resolve, reject) => {
      transaction.oncomplete = () =>
        resolve({
          notebook: notebookRequest.result,
          canvas: canvasRequest.result,
          notebookCount: countRequest.result,
        });
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("read failed"));
    });
    database.close();
    return result;
  }, DATABASE_NAME);
}

test.describe("clean notebook desk", () => {
  test("opens the stable Inbox through history, reload, and the fixed origin", async ({
    page,
  }) => {
    const observations = observeBrowser(page);
    await openShelf(page);
    expect(new URL(page.url()).origin).toBe("http://127.0.0.1:3211");

    await page.getByTestId("inbox-cover").click();
    await expect(page).toHaveURL(/\/desk\?notebook=inbox$/);
    await expect(page.getByTestId("focused-notebook")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await expect(page.locator("[data-desk-host]")).toHaveCount(1);

    await page.goBack();
    await expect(page).toHaveURL(/\/desk$/);
    await expect(
      page.getByRole("heading", { name: "Notebook shelf" }),
    ).toBeVisible();

    await page.goForward();
    await expect(page).toHaveURL(/\/desk\?notebook=inbox$/);
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();

    await page.reload();
    await expect(page).toHaveURL(/\/desk\?notebook=inbox$/);
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    expect(observations.forbiddenRequests).toEqual([]);
    expect(observations.consoleProblems).toEqual([]);
    expect(observations.pageErrors).toEqual([]);
  });

  test("repairs a missing focused notebook visibly to Inbox", async ({ page }) => {
    await page.goto("/desk?notebook=missing");
    await expect(page).toHaveURL(/\/desk\?notebook=inbox$/);
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await expect(page.locator("[data-desk-host]")).toHaveCount(1);
  });

  test("keeps one document and one page host while the quiet page view changes locally", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(document, "modelContext", {
        configurable: true,
        value: {
          registerTool: () => {
            const count = Number(
              document.documentElement.dataset.toolRegistrations ?? "0",
            );
            document.documentElement.dataset.toolRegistrations = String(count + 1);
          },
        },
      });
    });
    const observations = observeBrowser(page);
    await openShelf(page);
    const deskHost = page.locator("[data-desk-host]");
    await deskHost.evaluate((element) =>
      element.setAttribute("data-host-sentinel", "stable"),
    );
    observations.sameDocumentViolations.length = 0;

    await createNotebook(page, "Workshop notes", "Ideas from the workshop");
    await expect(page).toHaveURL(/\/desk\?notebook=[^&]+$/);
    await expect(deskHost).toHaveAttribute("data-host-sentinel", "stable");

    // A Phase 3 spread is finite: create an adjacent page before asserting
    // that the two-page view renders its ordered right-hand sheet.
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.locator('.page-surface[data-page-focused="true"]')).toHaveAttribute("data-page-number", "2");
    await page.getByRole("button", { name: "Previous" }).click();
    await expect(page.locator('.page-surface[data-page-focused="true"]')).toHaveAttribute("data-page-number", "1");

    const editorHost = page.locator("[data-editor-host]");
    const currentPage = page.locator('.page-surface[data-page-focused="true"]');
    await editorHost.evaluate((element) =>
      element.setAttribute("data-editor-sentinel", "stable"),
    );
    await currentPage.evaluate((element) =>
      element.setAttribute("data-page-sentinel", "stable"),
    );
    const canonicalUrl = page.url();
    const historyLength = await page.evaluate(() => history.length);

    await expect(page.locator('[data-page-renderer="tldraw"]')).toHaveCount(0);
    await expect(page.locator("[data-active-tool], .page-agent-status, .page-command-status")).toHaveCount(0);
    await page.getByLabel("Add to page").click();
    await page.getByRole("button", { name: "Draw", exact: true }).click();
    await expect(page.locator('[data-page-renderer="tldraw"]')).toBeVisible();
    await page.getByRole("button", { name: "Cancel drawing", exact: true }).click();
    await expect(page.locator('[data-page-renderer="tldraw"]')).toHaveCount(0);
    await expect(page).toHaveURL(canonicalUrl);
    expect(await page.evaluate(() => history.length)).toBe(historyLength);

    await page.getByLabel("Page settings").click();
    await page.getByRole("button", { name: "Grid" }).click();
    await page.getByRole("button", { name: "Handwritten" }).click();
    await expect(editorHost).toHaveAttribute("data-paper", "grid");
    await expect(editorHost).toHaveAttribute(
      "data-writing-style",
      "handwritten",
    );
    await expect(editorHost).toHaveAttribute("data-editor-sentinel", "stable");
    await expect(currentPage).toHaveAttribute("data-page-sentinel", "stable");
    await expect(page).toHaveURL(canonicalUrl);

    await page.setViewportSize({ width: 1200, height: 800 });
    await page.getByRole("button", { name: "2 pages" }).click();
    await expect(editorHost).toHaveAttribute("data-layout", "spread");
    await expect(page.locator('.notebook-page-slot[data-page-position="right"] .page-surface')).toBeVisible();
    await expect(currentPage).toHaveAttribute("data-page-sentinel", "stable");

    await page.setViewportSize({ width: 720, height: 450 });
    await expect(page.locator('.notebook-page-slot[data-page-position="right"] .page-surface')).toBeHidden();
    await expect(editorHost).toHaveAttribute("data-requested-layout", "spread");
    await expect(editorHost).toHaveAttribute("data-layout", "single");
    await expect(page.locator(".notebook-pages")).toHaveAttribute("data-visible-page-count", "1");
    await expect(editorHost).toHaveAttribute("data-editor-sentinel", "stable");

    await page.setViewportSize({ width: 1200, height: 800 });
    await expect(page.locator('.notebook-page-slot[data-page-position="right"] .page-surface')).toBeVisible();
    await expect(currentPage).toHaveAttribute("data-page-sentinel", "stable");

    await page.goBack();
    await expect(
      page.getByRole("heading", { name: "Notebook shelf" }),
    ).toBeVisible();
    await page.goForward();
    await expect(
      page.getByRole("heading", { name: "Workshop notes" }),
    ).toBeVisible();
    await expect(deskHost).toHaveAttribute("data-host-sentinel", "stable");

    expect(observations.sameDocumentViolations).toEqual([]);
    expect(
      await page.locator("html").getAttribute("data-tool-registrations"),
    ).toBe("22");
    expect(observations.forbiddenRequests).toEqual([]);
    expect(observations.consoleProblems).toEqual([]);
    expect(observations.pageErrors).toEqual([]);
  });

  test("repairs a legacy tool URL and preserves exact notebook and canvas rows", async ({
    page,
  }) => {
    const observations = observeBrowser(page);
    await page.goto("/favicon.ico");
    await seedPreservedRows(page);
    await page.goto("/desk?notebook=preserved-e2e&view=sketch");
    await expect(
      page.getByRole("heading", { name: "Preserved field notes" }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/desk\?notebook=preserved-e2e$/);
    await expect(page.locator('.page-surface[data-page-focused="true"]')).toBeVisible();
    await expect(page.locator('[data-page-renderer="tldraw"], [data-active-tool]')).toHaveCount(0);

    await page.getByRole("button", { name: /Shelf/ }).click();
    await createNotebook(page, "Fresh notebook", "New local work");
    const preserved = await readPreservedRows(page);
    expect(preserved).toEqual({
      notebook: {
        id: "preserved-e2e",
        title: "Preserved field notes",
        subject: "Existing local notebook",
        revision: 1,
        createdAt: "2026-08-25T12:00:00.000Z",
        updatedAt: "2026-08-25T12:00:00.000Z",
      },
      canvas: {
        notebookId: "preserved-e2e",
        version: 1,
        savedAt: "2026-08-25T12:30:00.000Z",
        snapshot: { shapes: [{ id: "existing-shape", type: "note" }] },
      },
      notebookCount: 3,
    });
    expect(observations.forbiddenRequests).toEqual([]);
    expect(observations.consoleProblems).toEqual([]);
    expect(observations.pageErrors).toEqual([]);
  });

  test("uses generated cover material and keeps creation order stable", async ({
    page,
  }) => {
    await openShelf(page);
    await page.goto("/desk?notebook=missing&view=paint");
    await expect(page).toHaveURL(/\/desk$/);
    await expect(
      page.getByRole("heading", { name: "Notebook shelf" }),
    ).toBeVisible();

    await createNotebook(page, "First notebook", "Created first");
    await page.getByRole("button", { name: /Shelf/ }).click();
    await createNotebook(page, "Second notebook", "Created second");
    await page.getByRole("button", { name: /Shelf/ }).click();
    const covers = page.locator(
      "button.composition-cover:not(.composition-cover--inbox):not(.composition-cover--create)",
    );
    await expect(covers).toHaveCount(2);
    await expect(covers.nth(0)).toContainText("First notebook");
    await expect(covers.nth(1)).toContainText("Second notebook");
    const coverArtwork = await covers.nth(0).evaluate((element) =>
      getComputedStyle(element, "::before").backgroundImage,
    );
    expect(coverArtwork).toContain("composition-marble-template.png");
  });

  test("keeps the paper background owned by the page surface", async ({
    page,
  }) => {
    await openShelf(page);
    await createNotebook(page, "Ruled page", "Baseline alignment");
    const ruledPage = page.locator('.page-surface[data-page-focused="true"]');
    await expect(ruledPage).toHaveAttribute("data-page-paper", "lined");
    await expect(ruledPage.locator(".page-scene")).toBeVisible();
    expect(await ruledPage.locator("[data-paper-rule]").count()).toBeGreaterThan(10);
    await expect(ruledPage.locator(".page-paper-margin")).toHaveCount(1);
    await expect(ruledPage.locator(".page-semantic-copy")).toBeAttached();
    await expect(page.locator(".open-notebook[data-paper] .page-surface")).toHaveCount(1);

    await page.getByLabel("Page settings").click();
    await page.getByRole("button", { name: "Handwritten" }).click();
    await expect(page.locator("[data-editor-host]")).toHaveAttribute("data-writing-style", "handwritten");
    await expect(ruledPage.locator(".page-scene")).toBeVisible();
  });

  test("supports keyboard focus, 200 percent reflow, reduced motion, and axe", async ({
    page,
  }) => {
    const observations = observeBrowser(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openShelf(page);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(
      page.getByRole("heading", { level: 1, name: "Notebook shelf" }),
    ).toBeVisible();
    const shelfAxe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      shelfAxe.violations.filter(
        (violation) =>
          violation.impact === "serious" || violation.impact === "critical",
      ),
    ).toEqual([]);

    await page.keyboard.press("Tab");
    const inboxCover = page.getByRole("button", { name: "Open Inbox" });
    await expect(inboxCover).toBeFocused();
    await page.keyboard.press("Tab");
    const createCover = page.getByRole("button", { name: "New notebook" });
    await expect(createCover).toBeFocused();
    const focusStyle = await createCover.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      };
    });
    expect(focusStyle).toEqual({ outlineStyle: "solid", outlineWidth: "3px" });
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Title")).toBeFocused();
    await page.getByLabel("Title").fill("Accessible notebook");
    await page
      .getByLabel("Subject")
      .fill("Keyboard and screen reader checks");
    await page.getByRole("button", { name: "Create notebook" }).click();
    await expect(
      page.getByRole("navigation", { name: "Notebook navigation" }),
    ).toBeVisible();
    await expect(page.getByRole("toolbar", { name: "Notebook tools" })).toHaveCount(0);
    await expect(page.locator('[data-page-renderer="tldraw"], [data-active-tool], .page-agent-status, .page-command-status')).toHaveCount(0);

    const focusedAxe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      focusedAxe.violations.filter(
        (violation) =>
          violation.impact === "serious" || violation.impact === "critical",
      ),
    ).toEqual([]);

    await page.setViewportSize({ width: 720, height: 450 });
    const reflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(reflow.scrollWidth).toBeLessThanOrEqual(reflow.clientWidth);
    await expect(page.locator('.notebook-page-slot[data-page-position="right"] .page-surface')).toHaveCount(0);
    const transitionSeconds = await page.locator(".open-notebook").evaluate(
      (element) => Number.parseFloat(getComputedStyle(element).transitionDuration),
    );
    expect(transitionSeconds).toBeLessThanOrEqual(0.01);
    expect(observations.forbiddenRequests).toEqual([]);
    expect(observations.consoleProblems).toEqual([]);
    expect(observations.pageErrors).toEqual([]);
  });

  test("reloads the canonical focused notebook from the service worker offline", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openShelf(page);
    await createNotebook(
      page,
      "Offline notebook",
      "Available without a connection",
    );
    await page.getByLabel("Add to page").click();
    await page.getByLabel("Text").fill("Offline notebook content");
    await page.getByRole("button", { name: "Add text", exact: true }).click();
    await expect(page.locator('.page-surface[data-page-focused="true"] .page-semantic-copy')).toContainText("Offline notebook content");
    await page.evaluate(async () => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await expect(page.locator('.page-surface[data-page-focused="true"]')).toBeVisible();

    try {
      await page.context().setOffline(true);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(
        page.getByRole("heading", { name: "Offline notebook" }),
      ).toBeVisible();
      await expect(page).toHaveURL(/\/desk\?notebook=[^&]+$/);
      await expect(page.locator('.page-surface[data-page-focused="true"]')).toBeVisible();
      await expect(page.locator('.page-surface[data-page-focused="true"] .page-semantic-copy')).toContainText("Offline notebook content");
    } finally {
      await page.context().setOffline(false);
    }
  });
});
