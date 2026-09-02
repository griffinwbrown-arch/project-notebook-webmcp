import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

test("exports and restores the complete local workspace", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/desk");
  await expect(page.getByRole("heading", { name: "Notebook shelf" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Keep a local backup" })).toBeVisible();

  await page.getByTestId("create-notebook-cover").click();
  await page.getByLabel("Title").fill("Recovery source");
  await page.getByLabel("Subject").fill("Backup acceptance");
  await page.getByRole("button", { name: "Create notebook" }).click();
  await expect(page.getByRole("heading", { name: "Recovery source, page 1" })).toBeVisible();
  await page.getByRole("button", { name: "Shelf" }).click();
  await expect(page.getByRole("button", { name: "Open Recovery source notebook" })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download backup" }).click();
  const download = await downloadPromise;
  const backupPath = testInfo.outputPath("workspace-backup.json");
  await download.saveAs(backupPath);
  const backup = JSON.parse(await readFile(backupPath, "utf8")) as {
    format: string;
    version: number;
    stores: { notebooks: { title: string }[] };
  };
  expect(backup.format).toBe("project-notebook-workspace-backup");
  expect(backup.version).toBe(1);
  expect(backup.stores.notebooks.some((notebook) => notebook.title === "Recovery source")).toBe(true);

  await page.getByTestId("create-notebook-cover").click();
  await page.getByLabel("Title").fill("Remove on restore");
  await page.getByLabel("Subject").fill("Temporary notebook");
  await page.getByRole("button", { name: "Create notebook" }).click();
  await expect(page.getByRole("heading", { name: "Remove on restore, page 1" })).toBeVisible();
  await page.getByRole("button", { name: "Shelf" }).click();
  await expect(page.getByRole("button", { name: "Open Remove on restore notebook" })).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message()).toContain("replace every notebook");
    await dialog.accept();
  });
  await page.getByLabel("Choose a Project Notebook backup").setInputFiles(backupPath);
  await expect(page.getByRole("button", { name: "Open Recovery source notebook" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Remove on restore notebook" })).toHaveCount(0);

  const cacheState = await page.evaluate(async () => {
    const names = await caches.keys();
    const notebookCache = names.find((name) => name.startsWith("project-notebook-"));
    if (notebookCache === undefined) return { count: 0, sameOrigin: true };
    const keys = await (await caches.open(notebookCache)).keys();
    return {
      count: keys.length,
      sameOrigin: keys.every((request) => new URL(request.url).origin === window.location.origin),
    };
  });
  expect(cacheState.count).toBeLessThanOrEqual(80);
  expect(cacheState.sameOrigin).toBe(true);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
