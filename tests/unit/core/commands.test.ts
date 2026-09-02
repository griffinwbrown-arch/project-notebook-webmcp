import { describe, expect, it } from "vitest";

import {
  createNotebookId,
  type Notebook,
  type NotebookId,
  type NotebookRepository,
} from "../../../src/domain";
import {
  commandNames,
  createCommandCatalog,
  createCommandRegistry,
  isCommandFailure,
  isCommandSuccess,
} from "../../../src/commands";

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

describe("command catalog and registry", () => {
  it("derives names and JSON Schema descriptors from one catalog", () => {
    const catalog = createCommandCatalog({ repository: new MemoryRepository() });
    const registry = createCommandRegistry(catalog);
    const names = commandNames(catalog);
    expect(Object.keys(catalog)).toEqual(names);
    expect(registry.describe("webmcp").map((item) => item.name)).toEqual([
      "notebook_create",
      "notebook_get",
      "notebook_list",
      "notebook_update",
    ]);
  });

  it("runs all handlers, validates boundaries, receipts, and subscriptions", async () => {
    const repository = new MemoryRepository();
    let id: NotebookId | undefined;
    const registry = createCommandRegistry({ repository });
    const completions: string[] = [];
    const unsubscribe = registry.subscribe((completion) => {
      completions.push(`${completion.source}:${completion.outcome}`);
    });

    const created = await registry.executeManual("notebook_create", {
      title: "Title",
      subject: "Subject",
    });
    expect(isCommandSuccess(created)).toBe(true);
    if (
      isCommandSuccess(created) &&
      typeof created.output === "object" &&
      created.output !== null &&
      "id" in created.output &&
      typeof created.output.id === "string"
    ) {
      id = createNotebookId(created.output.id);
      expect(created.source).toBe("manual");
      expect(created.command).toBe("notebook_create");
    }
    expect(id).toBeDefined();

    const notebookId = id ?? createNotebookId("missing");
    const got = await registry.executeExternal(
      "notebook_get",
      { id: notebookId },
      "webmcp",
    );
    expect(isCommandSuccess(got)).toBe(true);
    const updated = await registry.executeExternal(
      "notebook_update",
      { id: notebookId, title: "Updated", expectedRevision: 1 },
      "webmcp",
    );
    expect(isCommandSuccess(updated)).toBe(true);
    expect(isCommandSuccess(await registry.executeExternal("notebook_list", {}, "webmcp"))).toBe(true);
    const invalid = await registry.executeExternal("notebook_create", { title: 42 }, "webmcp");
    expect(isCommandFailure(invalid)).toBe(true);
    if (isCommandFailure(invalid)) {
      expect(invalid.error.code).toBe("INPUT_VALIDATION_ERROR");
    }
    const unknown = await registry.executeExternal("missing_command", {}, "webmcp");
    expect(isCommandFailure(unknown)).toBe(true);
    expect(completions).toHaveLength(6);
    unsubscribe();
  });
});
