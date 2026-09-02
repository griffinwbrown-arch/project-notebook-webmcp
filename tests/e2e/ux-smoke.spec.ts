import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  createNotebook,
  executePageTool,
  expectInsideViewport,
  expectMinimumHitTarget,
  expectNoBrowserIssues,
  installPageWebMcpRecorder,
  observeBrowser,
  parsePageContextResult,
  overlapArea,
  waitForPageWebMcp,
} from "../helpers/ux-browser";

function minimumTargetSize(projectName: string): number {
  return projectName === "ux-desktop-1280" ? 32 : 44;
}

async function expectNoScopedAxeViolations(page: Page, selector: string, label: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .include(selector)
    .withTags(["wcag2a", "wcag2aa", "wcag2aaa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.flatMap((node) => node.target),
    })),
    `${label} must have no scoped Axe violations.`,
  ).toEqual([]);
}

async function expectReachableMenuItems(
  page: Page,
  menu: Locator,
  minimumTargetPx: number,
): Promise<void> {
  await expectInsideViewport(page, menu, "The Add menu");
  const actions = menu.locator("button:visible");
  const count = await actions.count();
  expect(count, "The Add menu must expose its page actions.").toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const action = actions.nth(index);
    const name = (await action.textContent())?.trim() || `Add action ${index + 1}`;
    await expectInsideViewport(page, action, name);
    await expectMinimumHitTarget(action, minimumTargetPx, name);
    await action.click({ trial: true });
  }
}

test.describe("UI/UX smoke lane", () => {
  test("keeps the page command bar and every Add action reachable", async ({ page }, testInfo) => {
    const issues = observeBrowser(page);
    await installPageWebMcpRecorder(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await createNotebook(page, {
      title: "UX command reachability",
      subject: "Primary page actions stay in view",
    });
    await waitForPageWebMcp(page);

    const controls = page.locator(".page-controls");
    const add = page.getByLabel("Add to page");
    await expectInsideViewport(page, controls, "The page command bar");
    await expectMinimumHitTarget(add, minimumTargetSize(testInfo.project.name), "Add to page");
    await add.click();

    const menu = page.locator(".page-add-popover");
    await expectReachableMenuItems(page, menu, minimumTargetSize(testInfo.project.name));
    await expectNoScopedAxeViolations(page, ".page-add-popover", "The open Add menu");
    await menu.evaluate((element) => { element.scrollTop = 0; });
    await expect(page).toHaveScreenshot("ux-add-menu-reachable.png", {
      animations: "disabled",
      caret: "hide",
    });

    await menu.getByRole("button", { name: "Bold latest text" }).click();
    await expect(menu, "A failed Add action must close the popover so its explanation is not covered.").toBeHidden();
    const alert = page.locator(".page-command-error");
    await expect(alert).toHaveText("Add text before formatting it.");
    await expectInsideViewport(page, alert, "The Add failure explanation");
    const alertBox = await alert.boundingBox();
    const controlsBox = await controls.boundingBox();
    if (alertBox === null || controlsBox === null) throw new Error("The Add failure geometry was not measurable.");
    expect(overlapArea(alertBox, controlsBox), "The Add failure explanation must not cover the command dock.").toBe(0);
    expectNoBrowserIssues(issues);
  });

  test("contains the structured editor, traps focus, and restores the edit target", async ({ page }, testInfo) => {
    const issues = observeBrowser(page);
    await installPageWebMcpRecorder(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await createNotebook(page, {
      title: "UX structured editor",
      subject: "Modal editing stays reachable",
    });
    await waitForPageWebMcp(page);

    const initial = parsePageContextResult(await executePageTool(page, "page_context_read", {}));
    parsePageContextResult(await executePageTool(page, "page_text_insert", {
      mutationId: "ux-smoke-editable-copy",
      actorId: "assistant:ux-gate",
      expectedRevision: initial.pageRevision,
      label: "UX editable paragraph",
      text: "Readable editing copy for a bounded modal test.",
    }));

    const editTarget = page.getByRole("button", { name: "Edit UX editable paragraph" });
    await expect(editTarget).toBeVisible();
    await editTarget.click();

    const dialog = page.getByRole("dialog", { name: "Edit UX editable paragraph" });
    const cancel = dialog.getByRole("button", { name: "Cancel" });
    const save = dialog.getByRole("button", { name: "Save page text" });
    const input = dialog.getByRole("textbox").first();
    await expectInsideViewport(page, dialog, "The structured editor");
    await expectInsideViewport(page, cancel, "The structured editor Cancel action");
    await expectInsideViewport(page, save, "The structured editor Save action");
    await expectMinimumHitTarget(cancel, minimumTargetSize(testInfo.project.name), "Structured editor Cancel");
    await expectMinimumHitTarget(save, minimumTargetSize(testInfo.project.name), "Structured editor Save");
    await expect(dialog, "The editor must announce itself as modal while it owns keyboard focus.").toHaveAttribute("aria-modal", "true");
    await expectNoScopedAxeViolations(page, "[data-structured-text-editor]", "The structured-text editor");

    await input.fill("Edited copy stays visible, reachable, and contained.");
    const focusable = dialog.locator('button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    const focusableCount = await focusable.count();
    expect(focusableCount, "The structured editor must have keyboard controls.").toBeGreaterThan(1);
    await focusable.last().focus();
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((element) => element.contains(document.activeElement)),
      "Tab from the last editor control must remain inside the modal.",
    ).toBe(true);
    await focusable.first().focus();
    await page.keyboard.press("Shift+Tab");
    expect(
      await dialog.evaluate((element) => element.contains(document.activeElement)),
      "Shift+Tab from the first editor control must remain inside the modal.",
    ).toBe(true);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(editTarget, "Closing the editor must restore focus to the exact edit target.").toBeFocused();

    await editTarget.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox").first().fill("Edited copy stays visible, reachable, and contained.");
    await expect(page).toHaveScreenshot("ux-structured-editor.png", {
      animations: "disabled",
      caret: "hide",
    });
    await page.keyboard.press("Escape");
    expectNoBrowserIssues(issues);
  });

  test("keeps failed-save correction usable on a short landscape screen", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "ux-mobile-landscape-short", "This regression targets the shortest supported editor viewport.");
    const issues = observeBrowser(page);
    await installPageWebMcpRecorder(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await createNotebook(page, {
      title: "UX short editor recovery",
      subject: "A failed save must leave the correction field usable",
    });
    await waitForPageWebMcp(page);

    const initial = parsePageContextResult(await executePageTool(page, "page_context_read", {}));
    parsePageContextResult(await executePageTool(page, "page_text_insert", {
      mutationId: "ux-short-editor-copy",
      actorId: "assistant:ux-gate",
      expectedRevision: initial.pageRevision,
      label: "UX short editable paragraph",
      text: "This copy stays correctable after a failed save.",
    }));

    await page.getByRole("button", { name: "Edit UX short editable paragraph" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit UX short editable paragraph" });
    const input = dialog.getByRole("textbox").first();
    await input.fill("The corrected copy remains reachable on a short screen.");
    await page.evaluate(() => {
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function injectedUxWriteFailure(...args: Parameters<IDBObjectStore["put"]>) {
        IDBObjectStore.prototype.put = originalPut;
        void args;
        throw new DOMException("Injected UX save failure.", "InvalidStateError");
      };
    });
    await dialog.getByRole("button", { name: "Save page text" }).click();

    const alert = dialog.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Save page text" })).toBeEnabled();
    await input.scrollIntoViewIfNeeded();
    await expectInsideViewport(page, input, "The failed-save correction field");
    const inputBox = await input.boundingBox();
    if (inputBox === null) throw new Error("The failed-save correction field was not measurable.");
    expect(inputBox.height, "The short-screen correction field must retain a usable editing area.").toBeGreaterThanOrEqual(96);
    expectNoBrowserIssues(issues);
  });
});
