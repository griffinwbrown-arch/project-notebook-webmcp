import { expect, test, type Page } from "@playwright/test";

type ToolResult = Readonly<Record<string, unknown>>;

async function installFakeWebMcp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const registered: Record<string, { execute: (input: unknown) => unknown }> = {};
    Object.defineProperty(window, "__demoTools", { configurable: false, value: registered });
    Object.defineProperty(document, "modelContext", {
      configurable: false,
      value: {
        registerTool(tool: { name: string; execute: (input: unknown) => unknown }): void {
          registered[tool.name] = tool;
        },
      },
    });
  });
}

async function executeTool(page: Page, name: string, input: unknown): Promise<ToolResult> {
  return page.evaluate(async ({ toolName, toolInput }) => {
    const tools = (window as typeof window & {
      __demoTools: Record<string, { execute: (value: unknown) => unknown }>;
    }).__demoTools;
    const tool = tools[toolName];
    if (tool === undefined) throw new Error(`Tool ${toolName} is not registered.`);
    return await tool.execute(toolInput) as ToolResult;
  }, { toolName: name, toolInput: input });
}

async function registeredToolNames(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => Object.keys((window as typeof window & {
    __demoTools: Record<string, unknown>;
  }).__demoTools).sort());
}

test.beforeEach(async ({ page }) => { await installFakeWebMcp(page); });

test("@desktop runs the three-tool agent writing, diagram, drawing, navigation, and Undo gauntlet", async ({ page }) => {
  const browserErrors: string[] = [];
  const requestOrigins = new Set<string>();
  page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("request", (request) => requestOrigins.add(new URL(request.url()).origin));

  await page.goto("/");
  await expect(page).toHaveURL(/\/desk$/);
  await expect(page.getByRole("heading", { name: "Notebook shelf" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New notebook" })).toHaveCount(0);
  expect(await registeredToolNames(page)).toEqual(["notebook_apply", "notebook_open", "notebook_read"]);

  const opened = await executeTool(page, "notebook_open", { kind: "notebook", notebook: "Instruction Notebook", page: 3 });
  expect(opened).toMatchObject({ ok: true, data: { page: 3, pageCount: 3 } });
  await expect(page.getByText("Page 3 of 3", { exact: true })).toBeVisible();
  await expect(page.getByTestId("notebook-page").locator("svg").getByText("Three stable notebook tools", { exact: true })).toBeVisible();

  const created = await executeTool(page, "notebook_apply", {
    kind: "notebook.create",
    title: "Agent Gauntlet",
    subject: "Direct WebMCP acceptance",
    content: {
      kind: "blocks",
      blocks: [
        { kind: "heading", text: "Release notes" },
        { kind: "paragraph", text: "The notebook formats and places this content in one call." },
        { kind: "bullet", text: "No revision, frame, page id, or receipt id supplied." },
      ],
    },
  });
  expect(created).toMatchObject({ ok: true, data: { change: "notebook.create", pages: [1] } });
  await expect(page.getByRole("navigation", { name: "Notebook navigation" }).getByText("Agent Gauntlet", { exact: true })).toBeVisible();
  await expect(page.getByTestId("notebook-page").locator("svg").getByText("Release notes", { exact: true })).toBeVisible();

  const diagram = await executeTool(page, "notebook_apply", {
    kind: "figure.add",
    figure: {
      kind: "semantic-diagram",
      label: "Release flow",
      layout: "flow",
      nodes: [
        { id: "intake", label: "Intake", tone: "accent" },
        { id: "review", label: "Review", tone: "warning" },
        { id: "ship", label: "Ship", tone: "positive" },
      ],
      edges: [{ from: "intake", to: "review" }, { from: "review", to: "ship", label: "approved" }],
    },
  });
  expect(diagram).toMatchObject({ ok: true, data: { figure: "semantic-diagram", page: 2 } });
  await expect(page.locator(".native-semantic-diagram")).toBeVisible();
  await expect(page.getByText("Intake", { exact: true })).toBeVisible();
  await expect(page.getByText("Ship", { exact: true })).toBeVisible();

  const drawing = await executeTool(page, "notebook_apply", {
    kind: "figure.add",
    figure: {
      kind: "drawing",
      label: "Simple house",
      shapes: [
        { shape: "rectangle", x: 25, y: 45, width: 50, height: 40 },
        { shape: "line", x1: 20, y1: 45, x2: 50, y2: 15 },
        { shape: "line", x1: 50, y1: 15, x2: 80, y2: 45 },
        { shape: "ellipse", cx: 50, cy: 67, rx: 8, ry: 18 },
      ],
    },
  });
  expect(drawing).toMatchObject({ ok: true, data: { figure: "drawing", page: 3, undo: "available" } });
  await expect(page.locator("[data-element-kind='vector-ink']")).toBeVisible();
  await expect(page.getByText("Page 3 of 3", { exact: true })).toBeVisible();

  const receipts = await executeTool(page, "notebook_read", { kind: "receipts" });
  expect(receipts).toMatchObject({ ok: true, data: { receipts: expect.arrayContaining([expect.objectContaining({ latest: true, action: "figure.add" })]) } });
  expect(await executeTool(page, "notebook_apply", { kind: "undo" })).toMatchObject({ ok: true, data: { change: "undo" } });
  await expect(page.locator("[data-element-kind='vector-ink']")).toHaveCount(0);

  await expect(page.getByRole("button", { name: /add text|draw|place|template|review/i })).toHaveCount(0);
  await expect(page.locator("[class*='tl-'], [data-testid*='tldraw']")).toHaveCount(0);
  const storage = await page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    indexedDb: typeof indexedDB.databases === "function" ? (await indexedDB.databases()).length : 0,
  }));
  expect(storage.local).toBe(0);
  expect(storage.session).toBeGreaterThan(0);
  expect(storage.indexedDb).toBe(0);
  expect([...requestOrigins]).toEqual([new URL(page.url()).origin]);
  expect(browserErrors).toEqual([]);
});

test("@mobile keeps page navigation readable and exposes the same three tools", async ({ page }) => {
  await page.goto("/desk");
  expect(await registeredToolNames(page)).toEqual(["notebook_apply", "notebook_open", "notebook_read"]);
  await executeTool(page, "notebook_open", { kind: "notebook", notebook: "Anatomy exam prep", page: 2 });
  await expect(page.getByText("Page 2 of 7", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Next" })).toBeEnabled();
  const overflow = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.width + 1);
});
