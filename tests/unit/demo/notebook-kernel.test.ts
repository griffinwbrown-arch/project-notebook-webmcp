import { afterEach, describe, expect, it, vi } from "vitest";

import { createNotebookId } from "../../../src/domain";
import { DemoNotebookKernel } from "../../../src/demo/notebook-kernel";
import { createDemoWorkspaceRuntime, INSTRUCTION_NOTEBOOK_ID, type DemoWorkspaceRuntime } from "../../../src/demo/session-runtime";
import { createPageCommandRegistry, layoutPage } from "../../../src/page";

describe("DemoNotebookKernel", () => {
  let runtime: DemoWorkspaceRuntime | null = null;

  afterEach(async () => {
    await runtime?.cleanup();
    runtime = null;
  });

  async function fixture(): Promise<Readonly<{
    kernel: DemoNotebookKernel;
    inboxRegistry: Awaited<ReturnType<typeof createPageCommandRegistry>>;
    resetView: ReturnType<typeof vi.fn>;
  }>> {
    runtime = createDemoWorkspaceRuntime();
    await runtime.controller.start();
    const inboxId = createNotebookId("demo-inbox");
    const opened = await runtime.controller.openNotebook(inboxId);
    if (!opened.ok) throw new Error(opened.issue.message);
    const inboxRegistry = await createPageCommandRegistry(runtime.session.pageStorage, inboxId);
    const kernel = new DemoNotebookKernel(runtime.controller, runtime.session.pageStorage);
    const resetView = vi.fn();
    kernel.bindActiveNotebook({ notebookId: inboxId, registry: inboxRegistry, resetView });
    return { kernel, inboxRegistry, resetView };
  }

  it("reads, opens exact pages, writes with internal mechanics, and undoes the latest write", async () => {
    const { kernel, inboxRegistry, resetView } = await fixture();

    await expect(kernel.open({ kind: "view.reset" })).resolves.toMatchObject({
      ok: true,
      data: { view: "reset", scale: 100, pan: { x: 0, y: 0 }, panEnabled: false },
    });
    expect(resetView).toHaveBeenCalledOnce();

    await expect(kernel.read({ kind: "notebooks" })).resolves.toMatchObject({
      ok: true,
      data: { notebooks: expect.arrayContaining([expect.objectContaining({ title: "Instruction Notebook", pages: 3 })]) },
    });
    await expect(kernel.read({ kind: "agent-guide" })).resolves.toMatchObject({
      ok: true,
      data: { tracing: { skill: "trace-detailed-art", sourceKinds: ["user-supplied", "agent-generated", "agent-searched"] } },
    });
    await expect(kernel.read({ kind: "page", notebook: "Calculus I test prep", page: 1 })).resolves.toMatchObject({
      ok: true,
      data: {
        pageCount: 4,
        content: expect.arrayContaining([expect.objectContaining({
          componentType: "calculus-practice",
          questions: expect.arrayContaining([expect.objectContaining({ id: "limit-factor", response: "" })]),
        })]),
      },
    });
    await expect(kernel.read({ kind: "page", notebook: "Field Notes Coloring Book", page: 1 })).resolves.toMatchObject({
      ok: true,
      data: {
        pageCount: 3,
        content: expect.arrayContaining([expect.objectContaining({
          componentType: "coloring-book-page",
          scene: "garden",
          strokeCount: 0,
          controls: ["pen", "eraser", "color", "stroke-size", "undo", "clear"],
        })]),
      },
    });
    await expect(kernel.apply({
      kind: "text.write",
      content: { kind: "blocks", blocks: [{ kind: "heading", text: "Agent notes" }, { kind: "bullet", text: "Fresh registry write" }] },
    })).resolves.toMatchObject({ ok: true, data: { change: "text.write", pages: [1], undo: "available" } });
    await inboxRegistry.refresh();
    expect(inboxRegistry.getSnapshot().plainText).toContain("Agent notes");
    expect(inboxRegistry.getSnapshot().plainText).toContain("Fresh registry write");

    await expect(kernel.read({ kind: "receipts" })).resolves.toMatchObject({
      ok: true,
      data: { receipts: [expect.objectContaining({ latest: true, action: "text.write" })] },
    });
    await expect(kernel.apply({ kind: "undo" })).resolves.toMatchObject({ ok: true, data: { change: "undo" } });
    await inboxRegistry.refresh();
    expect(inboxRegistry.getSnapshot().plainText).toBe("");

    const traced = await kernel.apply({
      kind: "figure.trace",
      page: 1,
      placement: { left: 10, top: 10, width: 40, height: 40 },
      label: "Scanned fern",
      description: "Visible ink traced from a supplied fern scan.",
      sourceKind: "user-supplied",
      sourceLabel: "fern scan",
      sourceFormat: "png",
      document: {
        version: 1,
        viewBox: { width: 10, height: 10 },
        paths: [{
          commands: [
            { kind: "move", x: 1, y: 1 },
            { kind: "line", x: 9, y: 1 },
            { kind: "line", x: 9, y: 9 },
            { kind: "close" },
          ],
          paint: { stroke: "ink", strokeWidth: 1, fill: null, linecap: "round", linejoin: "round" },
        }],
      },
    });
    if (!traced.ok) throw new Error(`${traced.code}: ${traced.message}`);
    expect(traced).toMatchObject({ ok: true, data: { change: "figure.trace", editable: "path-geometry" } });
    await inboxRegistry.refresh();
    expect(inboxRegistry.getDocument().pages[0]?.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "vector-ink",
        label: "Scanned fern",
        provenance: expect.objectContaining({ kind: "user-supplied", tool: "trace-detailed-art" }),
      }),
    ]));
    const replacedTrace = await kernel.apply({
      kind: "figure.trace",
      page: 1,
      replaceTarget: "Scanned fern",
      label: "Searched fern trace",
      description: "Visible ink traced from a reusable searched reference.",
      sourceKind: "agent-searched",
      sourceLabel: "public domain fern plate",
      sourceFormat: "jpeg",
      document: {
        version: 1,
        viewBox: { width: 10, height: 10 },
        paths: [{
          commands: [
            { kind: "move", x: 1, y: 1 },
            { kind: "line", x: 9, y: 1 },
            { kind: "line", x: 9, y: 9 },
            { kind: "close" },
          ],
          paint: { stroke: "ink", strokeWidth: 1, fill: null, linecap: "round", linejoin: "round" },
        }],
      },
    });
    if (!replacedTrace.ok) throw new Error(`${replacedTrace.code}: ${replacedTrace.message}`);
    expect(replacedTrace).toMatchObject({ ok: true, data: { change: "figure.trace", replaced: "Scanned fern" } });
    await inboxRegistry.refresh();
    expect(inboxRegistry.getDocument().pages[0]?.elements.filter((element) => element.kind === "vector-ink")).toEqual([
      expect.objectContaining({ label: "Searched fern trace", provenance: expect.objectContaining({ kind: "agent-searched" }) }),
    ]);
    await expect(kernel.apply({ kind: "undo" })).resolves.toMatchObject({ ok: true, data: { change: "undo" } });

    await expect(kernel.apply({ kind: "page.add" })).resolves.toMatchObject({ ok: true, data: { change: "page.add", page: 2, pageCount: 2 } });
    await inboxRegistry.refresh();
    expect(inboxRegistry.getDocument().pages).toHaveLength(2);
    await expect(kernel.apply({ kind: "undo" })).resolves.toMatchObject({ ok: true, data: { change: "undo" } });
    await inboxRegistry.refresh();
    expect(inboxRegistry.getDocument().pages).toHaveLength(1);

    const instructionRegistry = await createPageCommandRegistry(runtime!.session.pageStorage, INSTRUCTION_NOTEBOOK_ID);
    const release = kernel.bindActiveNotebook({
      notebookId: INSTRUCTION_NOTEBOOK_ID,
      registry: instructionRegistry,
      resetView: vi.fn(),
    });
    await expect(kernel.open({ kind: "notebook", notebook: "Instruction Notebook", page: 3 })).resolves.toMatchObject({
      ok: true,
      data: { page: 3, pageCount: 3 },
    });
    expect(instructionRegistry.getSnapshot().focusedPageNumber).toBe(3);
    await expect(kernel.open({ kind: "relative-page", direction: "previous" })).resolves.toMatchObject({ ok: true, data: { page: 2 } });
    release();
  });

  it("creates a notebook with formatted content in one call and rejects unsafe figure content", async () => {
    const { kernel } = await fixture();
    const before = await runtime!.controller.listNotebooks();
    if (!before.ok) throw new Error(before.issue.message);

    await expect(kernel.apply({ kind: "notebook.create", title: "Agent draft", content: "# First page\n\nA complete note." })).resolves.toMatchObject({
      ok: true,
      data: { change: "notebook.create", pages: [1] },
    });
    const after = await runtime!.controller.listNotebooks();
    if (!after.ok) throw new Error(after.issue.message);
    expect(after.value).toHaveLength(before.value.length + 1);
    const created = after.value.find((notebook) => notebook.title === "Agent draft");
    if (created === undefined) throw new Error("The created notebook was not listed.");
    const document = await runtime!.session.pageStorage.read(created.id);
    expect(document.pages[0]?.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "text", content: expect.objectContaining({ format: "rich_text" }) }),
    ]));

    await expect(kernel.apply({
      kind: "figure.add",
      figure: {
        kind: "semantic-diagram",
        label: "https://unsafe.example",
        nodes: [{ id: "one", label: "One" }],
        edges: [],
      },
    })).resolves.toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("paginates long notes, replaces page text, and commits a custom semantic diagram", async () => {
    const { kernel, inboxRegistry } = await fixture();
    const longNotes = Array.from({ length: 28 }, (_, index) => `## Topic ${index + 1}\n\n${"Detailed note ".repeat(18)}`).join("\n\n");

    const written = await kernel.apply({ kind: "text.write", mode: "replace-notebook", content: longNotes });
    expect(written).toMatchObject({ ok: true, data: { change: "text.write", pages: expect.any(Array) } });
    const writtenPages = (written as { data: { pages: readonly number[] } }).data.pages;
    expect(writtenPages.length).toBeGreaterThan(1);

    await expect(kernel.apply({ kind: "text.write", page: 1, mode: "replace-page", content: "Replacement summary" })).resolves.toMatchObject({
      ok: true,
      data: { mode: "replace-page", pages: [1] },
    });
    await inboxRegistry.refresh();
    expect(inboxRegistry.getDocument().pages[0]?.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "text", label: "Replacement summary" }),
    ]));

    const diagramAdded = await kernel.apply({ kind: "figure.add", figure: {
      kind: "semantic-diagram",
      label: "Release flow",
      layout: "flow",
      nodes: [
        { id: "draft", label: "Draft", tone: "accent" },
        { id: "review", label: "Review", tone: "warning" },
        { id: "ship", label: "Ship", tone: "positive" },
      ],
      edges: [
        { from: "draft", to: "review" },
        { from: "review", to: "ship", label: "approved" },
      ],
    } });
    expect(diagramAdded).toMatchObject({ ok: true, data: { figure: "semantic-diagram", page: expect.any(Number) } });
    await inboxRegistry.refresh();
    const diagramPage = inboxRegistry.getDocument().pages.at(-1)!;
    expect(diagramPage.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "diagram", label: "Release flow", engine: "native" }),
    ]));

    await expect(kernel.apply({
      kind: "layout.arrange",
      page: diagramPage.number,
      target: "Release flow",
      placement: { left: 4, top: 6, width: 72, height: 68 },
    })).resolves.toMatchObject({ ok: true, data: { change: "layout.arrange", target: "Release flow", undo: "available" } });
    await inboxRegistry.refresh();
    const arranged = inboxRegistry.getDocument().pages[diagramPage.number - 1]!.elements.find((element) => element.label === "Release flow");
    const bounds = layoutPage(diagramPage).metrics.contentRect;
    expect(arranged?.frame).toMatchObject({
      x: expect.closeTo(bounds.x + bounds.width * 0.04, 2),
      y: expect.closeTo(bounds.y + bounds.height * 0.06, 2),
      width: expect.closeTo(bounds.width * 0.72, 2),
      height: expect.closeTo(bounds.height * 0.68, 2),
    });
    await expect(kernel.read({ kind: "page", page: diagramPage.number })).resolves.toMatchObject({
      ok: true,
      data: { content: expect.arrayContaining([expect.objectContaining({ label: "Release flow", placement: { left: 4, top: 6, width: 72, height: 68 } })]) },
    });
    await expect(kernel.apply({
      kind: "diagram.arrange",
      page: diagramPage.number,
      target: "Release flow",
      nodes: [{ id: "draft", x: 12, y: 24 }],
    })).resolves.toMatchObject({ ok: true, data: { change: "diagram.arrange", nodes: [{ id: "draft", x: 12, y: 24 }] } });
    await expect(kernel.read({ kind: "page", page: diagramPage.number })).resolves.toMatchObject({
      ok: true,
      data: { content: expect.arrayContaining([expect.objectContaining({
        label: "Release flow",
        nodes: expect.arrayContaining([expect.objectContaining({ id: "draft", position: { x: 12, y: 24 } })]),
      })]) },
    });

    await expect(kernel.apply({ kind: "figure.add", figure: {
      kind: "drawing",
      label: "Simple house",
      shapes: [
        { shape: "rectangle", x: 25, y: 45, width: 50, height: 40, fill: null },
        { shape: "line", x1: 20, y1: 45, x2: 50, y2: 15 },
        { shape: "line", x1: 50, y1: 15, x2: 80, y2: 45 },
        { shape: "arrow", x1: 10, y1: 92, x2: 90, y2: 92, stroke: "blue" },
      ],
    } })).resolves.toMatchObject({ ok: true, data: { figure: "drawing" } });
    await inboxRegistry.refresh();
    expect(inboxRegistry.getDocument().pages.at(-1)?.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "vector-ink", label: "Simple house" }),
    ]));
  });

  it("places a diagram in free page space alongside arranged text", async () => {
    const { kernel } = await fixture();
    const pageAdded = await kernel.apply({ kind: "page.add" });
    if (!pageAdded.ok) throw new Error(`${pageAdded.code}: ${pageAdded.message}`);
    const pageNumber = (pageAdded.data as { page: number }).page;
    await expect(kernel.apply({ kind: "text.write", page: pageNumber, content: "Fern field notes" })).resolves.toMatchObject({ ok: true });
    const arrangedText = await kernel.apply({
      kind: "layout.arrange",
      page: pageNumber,
      target: "Fern field notes",
      placement: { left: 0, top: 0, width: 100, height: 36 },
    });
    if (!arrangedText.ok) throw new Error(`${arrangedText.code}: ${arrangedText.message}`);
    await expect(kernel.apply({
      kind: "figure.add",
      page: pageNumber,
      placement: { left: 4, top: 48, width: 92, height: 48 },
      figure: {
        kind: "semantic-diagram",
        label: "Fern life cycle",
        layout: "cycle",
        nodes: [{ id: "spore", label: "Spore" }, { id: "frond", label: "Frond" }],
        edges: [{ from: "spore", to: "frond" }],
      },
    })).resolves.toMatchObject({ ok: true, data: { page: pageNumber, figure: "semantic-diagram" } });
    await expect(kernel.read({ kind: "page", page: pageNumber })).resolves.toMatchObject({
      ok: true,
      data: {
        pageCount: pageNumber,
        content: [
          expect.objectContaining({ kind: "text" }),
          expect.objectContaining({ kind: "diagram", label: "Fern life cycle" }),
        ],
      },
    });
  });
});
