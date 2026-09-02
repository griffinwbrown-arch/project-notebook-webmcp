import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

type RecordedPageTool = {
  readonly name: string;
  readonly execute: (input: unknown) => unknown | Promise<unknown>;
};

declare global {
  interface Window {
    __phase5RecordedPageTools: RecordedPageTool[];
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
    if (message.type() === "error" && !location.url.includes("cdn.tldraw.com")) {
      observations.consoleErrors.push(`${message.text()} (${location.url}:${location.lineNumber})`);
    }
  });
  page.on("pageerror", (error) => {
    if (error.message !== "NetworkError: A network error occurred.") {
      observations.pageErrors.push(error.message);
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
    window.__phase5RecordedPageTools = [];
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool(tool: RecordedPageTool): void {
          window.__phase5RecordedPageTools.push(tool);
        },
      },
    });
  });
}

function focusedPage(page: Page) {
  return page.locator('.page-surface[data-page-focused="true"]');
}

async function executePageTool(
  page: Page,
  name: string,
  input: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  return page.evaluate(
    ({ toolName, toolInput }) => {
      const tool = window.__phase5RecordedPageTools.find((candidate) => candidate.name === toolName);
      if (tool === undefined) throw new Error(`Page tool ${toolName} was not registered.`);
      return tool.execute(toolInput);
    },
    { toolName: name, toolInput: input },
  );
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
  await dialog.getByLabel("Subject").fill("Phase 5 review markup");
  await dialog.getByRole("button", { name: "Create notebook" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(focusedPage(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__phase5RecordedPageTools.length)).toBeGreaterThan(0);
}

test.describe("Phase 5 review callouts", () => {
  test("creates, transforms, undoes, reloads, and offline-reloads one exact callout", async ({ page }) => {
    test.setTimeout(90_000);
    const observations = observeBrowser(page);
    await installPageWebMcpRecorder(page);
    await openShelf(page);
    await createNotebook(page, "Review callout proof");

    const inserted = await executePageTool(page, "page_text_insert", {
      mutationId: "phase5-source-text",
      actorId: "assistant:phase5",
      expectedRevision: 1,
      text: "The draft uses source wording that needs review.",
      label: "Draft statement",
      frame: { x: 96, y: 96, width: 360, height: 96 },
    });
    expect(inserted).toMatchObject({ context: { pageRevision: 2 } });

    const reviewed = await executePageTool(page, "page_review_callout_add", {
      mutationId: "phase5-review-callout",
      actorId: "assistant:phase5",
      expectedRevision: 2,
      target: { kind: "phrase", phrase: "source wording" },
      reviewKind: "replacement",
      text: "Use the approved wording instead.",
    });
    expect(reviewed).toMatchObject({
      context: {
        pageRevision: 3,
        elements: expect.arrayContaining([
          expect.objectContaining({
            id: "phase3:mutation:phase5-review-callout",
            relationship: expect.objectContaining({
              kind: "review-callout",
              reviewKind: "replacement",
              target: expect.objectContaining({ kind: "text-range", start: 15, end: 29 }),
            }),
          }),
        ]),
      },
      receipt: {
        kind: "page_review_callout_add",
        mutationId: "phase5-review-callout",
        undo: { kind: "available" },
      },
    });
    const firstCallout = focusedPage(page).locator('[data-review-kind="replacement"]');
    await expect(firstCallout).toContainText("Suggested replacement");
    await expect(firstCallout).toContainText("Use the approved wording instead.");
    const initialConnector = await firstCallout.locator("path").getAttribute("d");

    const receiptId = (reviewed as { receipt: { id: string } }).receipt.id;
    expect(await executePageTool(page, "page_undo", {
      mutationId: "phase5-review-callout-undo",
      actorId: "assistant:phase5",
      receiptId,
    })).toMatchObject({ context: { pageRevision: 4 } });
    await expect(firstCallout).toHaveCount(0);

    expect(await executePageTool(page, "page_review_callout_add", {
      mutationId: "phase5-review-callout-restored",
      actorId: "assistant:phase5",
      expectedRevision: 4,
      target: { kind: "phrase", phrase: "source wording" },
      reviewKind: "replacement",
      text: "Use the approved wording instead.",
    })).toMatchObject({ context: { pageRevision: 5 } });
    const callout = focusedPage(page).locator('[data-review-kind="replacement"]');
    await expect(callout).toBeVisible();

    expect(await executePageTool(page, "page_element_move", {
      mutationId: "phase5-move-callout",
      actorId: "assistant:phase5",
      expectedRevision: 5,
      elementId: "phase3:mutation:phase5-review-callout-restored",
      frame: { x: 96, y: 260, width: 220, height: 86 },
    })).toMatchObject({ context: { pageRevision: 6 } });
    const movedConnector = await callout.locator("path").getAttribute("d");
    expect(movedConnector).not.toBe(initialConnector);

    expect(await executePageTool(page, "page_element_move", {
      mutationId: "phase5-move-target",
      actorId: "assistant:phase5",
      expectedRevision: 6,
      elementId: "phase3:mutation:phase5-source-text",
      frame: { x: 360, y: 500, width: 360, height: 96 },
    })).toMatchObject({ context: { pageRevision: 7 } });
    const movedTargetConnector = await callout.locator("path").getAttribute("d");
    expect(movedTargetConnector).not.toBe(movedConnector);

    expect(await executePageTool(page, "page_element_resize", {
      mutationId: "phase5-reflow-target",
      actorId: "assistant:phase5",
      expectedRevision: 7,
      elementId: "phase3:mutation:phase5-source-text",
      frame: { x: 360, y: 500, width: 240, height: 160 },
    })).toMatchObject({ context: { pageRevision: 8 } });
    const reflowedConnector = await callout.locator("path").getAttribute("d");
    expect(reflowedConnector).not.toBe(movedTargetConnector);

    await page.reload();
    await expect(focusedPage(page)).toHaveAttribute("data-page-revision", "8");
    await expect(focusedPage(page).locator('[data-review-kind="replacement"]')).toContainText("Use the approved wording instead.");
    await page.evaluate(async () => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    try {
      await page.context().setOffline(true);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(focusedPage(page).locator('[data-review-kind="replacement"]')).toContainText("Use the approved wording instead.");
      await expect(focusedPage(page)).toHaveAttribute("data-page-revision", "8");
    } finally {
      await page.context().setOffline(false);
    }

    await focusedPage(page).focus();
    await expect(focusedPage(page)).toBeFocused();
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(axe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
    expectNoBrowserErrors(observations);
  });

  test("leaves the page unchanged for ambiguous targets and unsafe placement", async ({ page }) => {
    const observations = observeBrowser(page);
    await installPageWebMcpRecorder(page);
    await openShelf(page);
    await createNotebook(page, "Review no-op proof");

    await executePageTool(page, "page_text_insert", {
      mutationId: "phase5-ambiguous-a",
      expectedRevision: 1,
      text: "Repeated review phrase",
    });
    await executePageTool(page, "page_text_insert", {
      mutationId: "phase5-ambiguous-b",
      expectedRevision: 2,
      text: "Repeated review phrase",
    });
    expect(await executePageTool(page, "page_review_callout_add", {
      mutationId: "phase5-ambiguous-callout",
      expectedRevision: 3,
      target: { kind: "phrase", phrase: "Repeated review phrase" },
      reviewKind: "explanation",
      text: "Clarify this statement.",
    })).toMatchObject({ outcome: "error", error: { code: "TARGET_AMBIGUOUS" } });
    await expect(focusedPage(page)).toHaveAttribute("data-page-revision", "3");
    await expect(focusedPage(page).locator("[data-review-kind]")).toHaveCount(0);

    await page.getByRole("button", { name: /Shelf/ }).click();
    await createNotebook(page, "Unsafe placement proof");
    await executePageTool(page, "page_text_insert", {
      mutationId: "phase5-full-page",
      expectedRevision: 1,
      text: "No safe margin remains.",
      frame: { x: 72, y: 64, width: 672, height: 928 },
    });
    expect(await executePageTool(page, "page_review_callout_add", {
      mutationId: "phase5-unsafe-callout",
      expectedRevision: 2,
      target: { kind: "phrase", phrase: "safe margin" },
      reviewKind: "explanation",
      text: "This cannot cover the document.",
    })).toMatchObject({ outcome: "error", error: { code: "SAFE_PLACEMENT_UNAVAILABLE" } });
    await expect(focusedPage(page)).toHaveAttribute("data-page-revision", "2");
    await expect(focusedPage(page).locator("[data-review-kind]")).toHaveCount(0);
    expectNoBrowserErrors(observations);
  });
});
