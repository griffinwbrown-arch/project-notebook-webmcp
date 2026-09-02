import { describe, expect, it } from "vitest";

import {
  createNotebookId,
  type Notebook,
  type NotebookId,
  type NotebookRepository,
} from "../../../src/domain";
import {
  createCommandRegistry,
} from "../../../src/commands";
import {
  registerWebMcpTools,
  type WebMcpModelContext,
  type WebMcpTool,
} from "../../../src/entries/webmcp";

class MemoryRepository implements NotebookRepository {
  private readonly records = new Map<NotebookId, Notebook>();

  public async create(notebook: Notebook): Promise<Notebook> {
    this.records.set(notebook.id, notebook);
    return notebook;
  }

  public async get(id: NotebookId): Promise<Notebook | null> {
    return this.records.get(id) ?? null;
  }

  public async list(): Promise<Notebook[]> {
    return [...this.records.values()];
  }

  public async update(notebook: Notebook): Promise<Notebook> {
    this.records.set(notebook.id, notebook);
    return notebook;
  }

}

class FakeModelContext implements WebMcpModelContext {
  public readonly tools: WebMcpTool[] = [];

  public registerTool(tool: WebMcpTool): void {
    this.tools.push(tool);
  }
}

describe("WebMCP registry adapter", () => {
  it("registers only webmcp descriptors and returns the advertised output", async () => {
    const registry = createCommandRegistry({ repository: new MemoryRepository() });
    const modelContext = new FakeModelContext();

    const state = await registerWebMcpTools(registry, { modelContext });

    expect(state.status).toBe("registered");
    expect(modelContext.tools.map((tool) => tool.name)).toEqual([
      "notebook_create",
      "notebook_get",
      "notebook_list",
      "notebook_update",
    ]);
    const createTool = modelContext.tools.find(
      (tool) => tool.name === "notebook_create",
    );
    expect(createTool?.annotations?.readOnlyHint).toBe(false);
    expect(createTool?.annotations?.untrustedContentHint).toBe(true);
    const listTool = modelContext.tools.find(
      (tool) => tool.name === "notebook_list",
    );
    expect(listTool?.annotations?.readOnlyHint).toBe(true);
    expect(listTool?.annotations?.untrustedContentHint).toBe(true);

    const rawResult = await createTool?.execute({
      title: "WebMCP notebook",
      subject: "Integration proof",
    });
    expect(rawResult).toBeDefined();
    if (
      typeof rawResult !== "object" ||
      rawResult === null ||
      !("id" in rawResult) ||
      typeof rawResult.id !== "string"
    ) {
      throw new Error("Expected the created notebook id.");
    }
    expect(rawResult).toMatchObject({ revision: 1 });
    expect(createNotebookId(rawResult.id)).toBe(rawResult.id);
  });

  it("reports missing browser support and synchronous or asynchronous registration errors", async () => {
    const registry = createCommandRegistry({ repository: new MemoryRepository() });
    await expect(registerWebMcpTools(registry, {})).resolves.toEqual({
      status: "unsupported",
      reason: "missing_model_context",
    });

    const errorContext: WebMcpModelContext = {
      registerTool: () => {
        throw new Error("registration denied");
      },
    };
    await expect(registerWebMcpTools(registry, { modelContext: errorContext })).resolves.toMatchObject({
      status: "error",
      message: "registration denied",
    });

    const rejectedContext: WebMcpModelContext = {
      registerTool: async () => Promise.reject(new Error("async registration denied")),
    };
    await expect(registerWebMcpTools(registry, { modelContext: rejectedContext })).resolves.toMatchObject({
      status: "error",
      message: "async registration denied",
    });
  });
});
