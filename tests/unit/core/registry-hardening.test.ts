import { describe, expect, it, vi } from "vitest";

import {
  createCommandCatalog,
  createCommandRegistry,
  isCommandFailure,
  isCommandSuccess,
  type CommandCatalog,
} from "../../../src/commands";
import {
  createNotebookId,
  type Notebook,
  type NotebookId,
  type NotebookRepository,
} from "../../../src/domain";

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

function failureCode(result: Awaited<ReturnType<ReturnType<typeof createCommandRegistry>["execute"]>>): string {
  if (!isCommandFailure(result)) {
    throw new Error("Expected a failed command.");
  }
  return result.error.code;
}

describe("command registry hardening", () => {
  it("emits receipts for unknown and invalid commands, then stops after unsubscribe", async () => {
    const registry = createCommandRegistry({ repository: new MemoryRepository() });
    const completions: string[] = [];
    const listener = vi.fn((completion) => {
      completions.push(`${completion.source}:${completion.command}:${completion.outcome}`);
    });
    const unsubscribe = registry.subscribe(listener);
    const manualUnknown = await registry.execute("missing_manual", {}, "manual");

    expect(isCommandFailure(manualUnknown)).toBe(true);
    if (isCommandFailure(manualUnknown)) {
      expect(manualUnknown).toMatchObject({
        command: "missing_manual",
        source: "manual",
        outcome: "error",
        error: {
          code: "UNKNOWN_COMMAND",
          message: "Unknown command missing_manual.",
        },
      });
      expect(Number.isNaN(Date.parse(manualUnknown.completedAt))).toBe(false);
    }

    const invalid = await registry.execute(
      "notebook_create",
      { title: 42, subject: "Subject" },
      "manual",
    );
    expect(failureCode(invalid)).toBe("INPUT_VALIDATION_ERROR");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    await registry.executeExternal("missing_external", {}, "webmcp");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(completions).toEqual([
      "manual:missing_manual:error",
      "manual:notebook_create:error",
    ]);
  });

  it("validates handler output and maps domain and unknown thrown errors safely", async () => {
    const outputRepository = new MemoryRepository();
    const outputBase = createCommandCatalog({ repository: outputRepository });
    const invalidOutputCatalog = {
      ...outputBase,
      notebook_get: {
        ...outputBase.notebook_get,
        handler: async () => ({ invalid: true }),
      },
    } as unknown as CommandCatalog;
    const outputResult = await createCommandRegistry(invalidOutputCatalog).executeExternal(
      "notebook_get",
      { id: "known-id" },
      "webmcp",
    );
    expect(failureCode(outputResult)).toBe("OUTPUT_VALIDATION_ERROR");

    const domainRegistry = createCommandRegistry({ repository: new MemoryRepository() });
    const missing = await domainRegistry.executeExternal(
      "notebook_get",
      { id: "missing-id" },
      "webmcp",
    );
    expect(isCommandFailure(missing)).toBe(true);
    if (isCommandFailure(missing)) {
      expect(missing.error).toMatchObject({
        code: "COMMAND_ERROR",
        message: "Notebook missing-id was not found.",
      });
    }

    const errorBase = createCommandCatalog({ repository: new MemoryRepository() });
    const errorCatalog = {
      ...errorBase,
      notebook_list: {
        ...errorBase.notebook_list,
        handler: async () => {
          throw new Error("repository unavailable");
        },
      },
      notebook_get: {
        ...errorBase.notebook_get,
        handler: async () => {
          throw "non-error failure";
        },
      },
    } as unknown as CommandCatalog;
    const errorRegistry = createCommandRegistry(errorCatalog);
    const thrownError = await errorRegistry.executeExternal("notebook_list", {}, "webmcp");
    const nonError = await errorRegistry.executeExternal(
      "notebook_get",
      { id: "known-id" },
      "webmcp",
    );
    expect(isCommandFailure(thrownError)).toBe(true);
    expect(isCommandFailure(nonError)).toBe(true);
    if (isCommandFailure(thrownError) && isCommandFailure(nonError)) {
      expect(thrownError.error).toEqual({ code: "COMMAND_ERROR", message: "repository unavailable" });
      expect(nonError.error).toEqual({ code: "COMMAND_ERROR", message: "The command failed." });
    }
  });

  it("selects every update change shape and enforces revisions before deleting", async () => {
    const repository = new MemoryRepository();
    const registry = createCommandRegistry({ repository });
    const created = await registry.executeManual("notebook_create", {
      title: "Initial title",
      subject: "Initial subject",
    });
    expect(isCommandSuccess(created)).toBe(true);
    if (!isCommandSuccess(created) || typeof created.output !== "object" || created.output === null || !("id" in created.output) || typeof created.output.id !== "string") {
      throw new Error("Expected the created notebook id.");
    }
    const id = createNotebookId(created.output.id);

    const subjectOnly = await registry.executeManual("notebook_update", {
      id,
      subject: "Subject only",
      expectedRevision: 1,
    });
    expect(isCommandSuccess(subjectOnly)).toBe(true);
    if (isCommandSuccess(subjectOnly)) {
      expect(subjectOnly.output).toMatchObject({
        id,
        title: "Initial title",
        subject: "Subject only",
        revision: 2,
      });
    }

    const bothFields = await registry.executeManual("notebook_update", {
      id,
      title: "Both title",
      subject: "Both subject",
      expectedRevision: 2,
    });
    expect(isCommandSuccess(bothFields)).toBe(true);
    if (isCommandSuccess(bothFields)) {
      expect(bothFields.output).toMatchObject({
        title: "Both title",
        subject: "Both subject",
        revision: 3,
      });
    }

    const noFields = await registry.executeManual("notebook_update", { id });
    expect(failureCode(noFields)).toBe("INPUT_VALIDATION_ERROR");
    if (isCommandFailure(noFields)) {
      expect(noFields.error.message).toBe("At least one notebook field must be supplied for update.");
    }

    const noRevision = await registry.executeManual("notebook_update", {
      id,
      title: "No revision check",
    });
    expect(isCommandSuccess(noRevision)).toBe(true);
    if (isCommandSuccess(noRevision)) {
      expect(noRevision.output).toMatchObject({ title: "No revision check", revision: 4 });
    }

    const staleUpdate = await registry.executeManual("notebook_update", {
      id,
      title: "Stale",
      expectedRevision: 1,
    });
    expect(failureCode(staleUpdate)).toBe("COMMAND_ERROR");

  });
});
