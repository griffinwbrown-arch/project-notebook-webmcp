import { describe, expect, it } from "vitest";

import {
  createCommandCatalog,
  createCommandRegistry,
  type CommandCatalog,
} from "../../../src/commands";
import type {
  Notebook,
  NotebookId,
  NotebookRepository,
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

const instantPattern =
  "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$";

const outputSchema = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
    title: { type: "string" },
    subject: { type: "string" },
    revision: {
      type: "integer",
      exclusiveMinimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    createdAt: { type: "string", format: "date-time", pattern: instantPattern },
    updatedAt: { type: "string", format: "date-time", pattern: instantPattern },
  },
  required: ["id", "title", "subject", "revision", "createdAt", "updatedAt"],
  additionalProperties: false,
};

const outputItemSchema = {
  type: outputSchema.type,
  properties: outputSchema.properties,
  required: outputSchema.required,
  additionalProperties: outputSchema.additionalProperties,
};

const createInputSchema = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    title: { type: "string" },
    subject: { type: "string" },
  },
  required: ["title", "subject"],
  additionalProperties: false,
};

const idInputSchema = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: { id: { type: "string", minLength: 1 } },
  required: ["id"],
  additionalProperties: false,
};

const listInputSchema = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {},
  additionalProperties: false,
};

const updateInputSchema = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
    title: { type: "string" },
    subject: { type: "string" },
    expectedRevision: {
      type: "integer",
      exclusiveMinimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
  },
  required: ["id"],
  additionalProperties: false,
};

const exposure = { manual: true, webmcp: true };

describe("command descriptor contract", () => {
  it("publishes the canonical names, metadata, manual fields, and generated schemas", () => {
    const registry = createCommandRegistry({ repository: new MemoryRepository() });

    expect(registry.describe().slice(0, 4)).toEqual([
      {
        name: "notebook_create",
        description: "Create a notebook with a title and subject.",
        readOnly: false,
        untrustedContent: true,
        exposure,
        inputSchema: createInputSchema,
        outputSchema,
        manualFields: [
          { name: "title", label: "Title", type: "text", required: true },
          { name: "subject", label: "Subject", type: "textarea", required: true },
        ],
      },
      {
        name: "notebook_get",
        description: "Read one notebook by id.",
        readOnly: true,
        untrustedContent: true,
        exposure,
        inputSchema: idInputSchema,
        outputSchema,
        manualFields: [
          { name: "id", label: "Notebook id", type: "text", required: true },
        ],
      },
      {
        name: "notebook_list",
        description: "List all notebooks.",
        readOnly: true,
        untrustedContent: true,
        exposure,
        inputSchema: listInputSchema,
        outputSchema: {
          "$schema": "http://json-schema.org/draft-07/schema#",
          type: "array",
          items: outputItemSchema,
        },
        manualFields: [],
      },
      {
        name: "notebook_update",
        description: "Update a notebook title or subject using optimistic revision checks.",
        readOnly: false,
        untrustedContent: true,
        exposure,
        inputSchema: updateInputSchema,
        outputSchema,
        manualFields: [
          { name: "id", label: "Notebook id", type: "text", required: true },
          { name: "title", label: "Title", type: "text", required: false },
          { name: "subject", label: "Subject", type: "textarea", required: false },
          {
            name: "expectedRevision",
            label: "Expected revision",
            type: "number",
            required: false,
          },
        ],
      },
    ]);
    expect(
      registry.describe().slice(4).map((descriptor) => ({
        name: descriptor.name,
        readOnly: descriptor.readOnly,
        untrustedContent: descriptor.untrustedContent,
        exposure: descriptor.exposure,
        required: (descriptor.inputSchema as { required?: unknown }).required,
      })),
    ).toEqual([
      {
        name: "notebook_trash",
        readOnly: false,
        untrustedContent: false,
        exposure: { manual: false, webmcp: false },
        required: ["id", "expectedRevision"],
      },
      {
        name: "notebook_restore",
        readOnly: false,
        untrustedContent: false,
        exposure: { manual: false, webmcp: false },
        required: ["id", "expectedRevision"],
      },
    ]);
  });

  it("filters descriptors by each source instead of assuming every command is exposed", () => {
    const base = createCommandCatalog({ repository: new MemoryRepository() });
    const catalog = {
      ...base,
      notebook_list: {
        ...base.notebook_list,
        exposure: { manual: false, webmcp: true },
      },
    } as CommandCatalog;
    const registry = createCommandRegistry(catalog);

    expect(registry.getCatalog()).toBe(catalog);
    expect(registry.describe().map((descriptor) => descriptor.name)).toEqual([
      "notebook_create",
      "notebook_get",
      "notebook_list",
      "notebook_update",
      "notebook_trash",
      "notebook_restore",
    ]);
    expect(registry.describe("manual").map((descriptor) => descriptor.name)).toEqual([
      "notebook_create",
      "notebook_get",
      "notebook_update",
    ]);
    expect(registry.describe("webmcp").map((descriptor) => descriptor.name)).toContain(
      "notebook_list",
    );
  });
});
