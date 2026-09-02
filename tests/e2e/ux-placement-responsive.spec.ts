import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  createNotebook,
  effectivePageTextSizePx,
  executePageTool,
  expectInsideViewport,
  expectMinimumHitTarget,
  expectViewportCoverage,
  expectNoBrowserIssues,
  installPageWebMcpRecorder,
  observeBrowser,
  overlapArea,
  parsePageContextResult,
  type PageContextSnapshot,
  waitForPageWebMcp,
} from "../helpers/ux-browser";

function minimumTargetSize(projectName: string): number {
  return projectName === "ux-desktop-1280" ? 32 : 44;
}

async function setupPage(page: Page, title: string): Promise<PageContextSnapshot> {
  await installPageWebMcpRecorder(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await createNotebook(page, { title, subject: "Repeatable UI geometry checks" });
  await waitForPageWebMcp(page);
  return parsePageContextResult(await executePageTool(page, "page_context_read", {}));
}

async function addShape(
  page: Page,
  input: Readonly<{ revision: number; mutationId: string; shape: "rectangle" | "ellipse" | "arrow"; label: string }>,
): Promise<PageContextSnapshot> {
  return parsePageContextResult(await executePageTool(page, "page_shape_add", {
    mutationId: input.mutationId,
    actorId: "assistant:ux-gate",
    expectedRevision: input.revision,
    shape: input.shape,
    label: input.label,
  }));
}

async function expectTargets(
  locator: Locator,
  minimumPx: number,
  groupLabel: string,
): Promise<void> {
  const count = await locator.count();
  expect(count, `${groupLabel} must expose at least one visible control.`).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const target = locator.nth(index);
    const name = await target.evaluate((element) =>
      element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName,
    );
    await target.scrollIntoViewIfNeeded();
    await expectInsideViewport(target.page(), target, `${groupLabel}: ${name}`);
    await expectMinimumHitTarget(target, minimumPx, `${groupLabel}: ${name}`);
    if (await target.isEnabled()) {
      await target.click({ trial: true, timeout: 5_000 });
    } else {
      await expect(target, `${groupLabel}: ${name} must expose its unavailable state.`).toBeDisabled();
    }
  }
}

test.describe("UI/UX placement and responsive lane", () => {
  test("places repeated shapes without positive-area overlap", async ({ page }) => {
    const issues = observeBrowser(page);
    let context = await setupPage(page, "UX collision placement");
    context = await addShape(page, {
      revision: context.pageRevision,
      mutationId: "ux-placement-rectangle",
      shape: "rectangle",
      label: "UX rectangle",
    });
    context = await addShape(page, {
      revision: context.pageRevision,
      mutationId: "ux-placement-ellipse",
      shape: "ellipse",
      label: "UX ellipse",
    });
    context = await addShape(page, {
      revision: context.pageRevision,
      mutationId: "ux-placement-arrow",
      shape: "arrow",
      label: "UX arrow",
    });

    const shapes = context.elements.filter((element) => element.kind === "shape");
    expect(shapes, "The placement scenario must create all three shapes.").toHaveLength(3);
    for (let leftIndex = 0; leftIndex < shapes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < shapes.length; rightIndex += 1) {
        const left = shapes[leftIndex];
        const right = shapes[rightIndex];
        if (left === undefined || right === undefined) throw new Error("The shape pair was incomplete.");
        expect(
          overlapArea(left.frame, right.frame),
          `${left.label} and ${right.label} must not overlap. Frames: ${JSON.stringify(left.frame)} and ${JSON.stringify(right.frame)}.`,
        ).toBe(0);
      }
    }
    const renderedShapes = page.locator('.page-surface[data-page-focused="true"] [data-page-renderer="tldraw"] .tl-shape');
    await expect(renderedShapes).toHaveCount(3);
    const renderedBoxes = await renderedShapes.evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }));
    for (let leftIndex = 0; leftIndex < renderedBoxes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < renderedBoxes.length; rightIndex += 1) {
        const left = renderedBoxes[leftIndex];
        const right = renderedBoxes[rightIndex];
        if (left === undefined || right === undefined) throw new Error("The rendered shape pair was incomplete.");
        expect(
          overlapArea(left, right),
          `Rendered shapes ${leftIndex + 1} and ${rightIndex + 1} must not overlap.`,
        ).toBe(0);
      }
    }
    expectNoBrowserIssues(issues);
  });

  test("keeps editable page text legible and primary targets large enough", async ({ page }, testInfo) => {
    const issues = observeBrowser(page);
    const initial = await setupPage(page, "UX responsive editing");
    parsePageContextResult(await executePageTool(page, "page_text_insert", {
      mutationId: "ux-responsive-readable-copy",
      actorId: "assistant:ux-gate",
      expectedRevision: initial.pageRevision,
      label: "UX readable copy",
      text: "This copy must remain legible while the page can still be edited.",
    }));
    if (testInfo.project.name !== "ux-desktop-1280") {
      const editPageView = page.getByRole("button", { name: "Edit page view" });
      await expect(editPageView).toBeVisible();
      await editPageView.click();
      await expect(editPageView).toHaveAttribute("aria-pressed", "true");
    }

    await expect.poll(
      () => effectivePageTextSizePx(page),
      { message: "Visible editable page text must render at 14px or larger.", timeout: 10_000 },
    ).toBeGreaterThanOrEqual(14);

    const minimumPx = minimumTargetSize(testInfo.project.name);
    await expectTargets(page.locator(".notebook-toolbar button:visible"), minimumPx, "Notebook toolbar");
    await expectTargets(page.locator(".inside-cover > summary:visible"), minimumPx, "Page settings");
    await expectTargets(page.locator(".page-controls button:visible, .page-add-menu > summary:visible"), minimumPx, "Page command bar");
    const graphicsTools = page.locator(".page-graphics-tools button:visible");
    if (await graphicsTools.count() > 0) {
      await expectTargets(graphicsTools, minimumPx, "Graphics toolbar");
    }
    expectNoBrowserIssues(issues);
  });

  test("keeps an arrangement preview and its controls visible together", async ({ page }, testInfo) => {
    const issues = observeBrowser(page);
    let context = await setupPage(page, "UX arrangement workspace");
    context = await addShape(page, {
      revision: context.pageRevision,
      mutationId: "ux-arrangement-shape",
      shape: "rectangle",
      label: "UX arrangement target",
    });
    expect(context.elements.some((element) => element.label === "UX arrangement target")).toBe(true);

    const place = page.getByRole("button", { name: "Place" });
    await expect(place).toBeEnabled();
    await place.click();
    const choice = page.locator("[data-arrangement-choice]").filter({ hasText: "UX arrangement target" });
    await expect(choice).toBeVisible();
    await choice.click();

    const preview = page.getByRole("group", { name: "Placement preview for UX arrangement target" });
    const panel = page.getByRole("region", { name: "Place element" });
    const sheet = page.locator('.page-surface[data-page-focused="true"]');
    await expectInsideViewport(page, preview, "The arrangement preview");
    await expectInsideViewport(page, panel, "The arrangement controls");
    await expectViewportCoverage(page, sheet, {
      label: "The arranged notebook page",
      minimumWidthRatio: 0.95,
      minimumHeightRatio: 0.6,
    });
    const previewBox = await preview.boundingBox();
    const panelBox = await panel.boundingBox();
    const sheetBox = await sheet.boundingBox();
    if (previewBox === null || panelBox === null || sheetBox === null) {
      throw new Error("The arrangement workspace did not expose measurable page, preview, and control boxes.");
    }
    expect(previewBox.x, "The arrangement preview must stay inside the notebook page on the left.").toBeGreaterThanOrEqual(sheetBox.x);
    expect(previewBox.y, "The arrangement preview must stay inside the notebook page at the top.").toBeGreaterThanOrEqual(sheetBox.y);
    expect(previewBox.x + previewBox.width, "The arrangement preview must stay inside the notebook page on the right.").toBeLessThanOrEqual(sheetBox.x + sheetBox.width);
    expect(previewBox.y + previewBox.height, "The arrangement preview must stay inside the notebook page at the bottom.").toBeLessThanOrEqual(sheetBox.y + sheetBox.height);
    expect(
      overlapArea(previewBox, panelBox),
      `The arrangement controls must not cover the page preview. Preview: ${JSON.stringify(previewBox)}. Controls: ${JSON.stringify(panelBox)}.`,
    ).toBe(0);
    expect(
      overlapArea(sheetBox, panelBox),
      `The arrangement controls must not cover any part of the notebook page. Page: ${JSON.stringify(sheetBox)}. Controls: ${JSON.stringify(panelBox)}.`,
    ).toBe(0);
    await expect(
      page.locator(".page-controls"),
      "The command dock must stay out of the arrangement workspace.",
    ).toBeHidden();
    await expectMinimumHitTarget(
      preview.getByRole("button", { name: "Move UX arrangement target" }),
      minimumTargetSize(testInfo.project.name),
      "Arrangement move handle",
    );
    await expectMinimumHitTarget(
      preview.getByRole("button", { name: "Resize UX arrangement target" }),
      minimumTargetSize(testInfo.project.name),
      "Arrangement resize handle",
    );
    await expectTargets(
      panel.locator("button:visible"),
      minimumTargetSize(testInfo.project.name),
      "Arrangement panel",
    );
    const moveHandle = preview.getByRole("button", { name: "Move UX arrangement target" });
    await moveHandle.focus();
    await page.keyboard.press("Escape");
    await expect(panel, "Escape from a page placement handle must close Place mode.").toBeHidden();
    await expect(place, "Closing Place mode must restore focus to its trigger.").toBeFocused();
    expectNoBrowserIssues(issues);
  });
});
