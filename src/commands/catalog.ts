import { z } from "zod";

import {
  assertNotebookFound,
  createNotebook,
  createNotebookId,
  createReceiptId,
  createRevision,
  generateNotebookId,
  nowIsoInstant,
  updateNotebook,
  type IsoInstant,
  type Notebook,
  type NotebookId,
  type NotebookRepository,
  type NotebookUpdateInput,
  type Revision,
} from "../domain";
import type { WorkspaceOperationResult } from "../workspace/model";

export type CommandSource = "manual" | "webmcp";

export type CommandExposure = Readonly<Record<CommandSource, boolean>>;

export type ManualFieldType = "text" | "textarea" | "number";

export type ManualFieldDescriptor = {
  readonly name: string;
  readonly label: string;
  readonly type: ManualFieldType;
  readonly required: boolean;
  readonly description?: string;
};

export type CommandContext = {
  readonly repository: NotebookRepository;
  readonly lifecycle?: {
    trashNotebook(
      notebookId: NotebookId,
      expectedRevision: Revision,
    ): Promise<WorkspaceOperationResult>;
    restoreNotebook(
      notebookId: NotebookId,
      expectedRevision: Revision,
    ): Promise<WorkspaceOperationResult>;
  };
  readonly now?: () => IsoInstant;
  readonly createId?: () => NotebookId;
};

export const NotebookCreateInputSchema = z
  .object({
    title: z.string(),
    subject: z.string(),
  })
  .strict();

export const NotebookIdInputSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();

export const NotebookUpdateInputSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().optional(),
    subject: z.string().optional(),
    expectedRevision: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (input) => input.title !== undefined || input.subject !== undefined,
    "At least one notebook field must be supplied for update.",
  );

export const NotebookLifecycleInputSchema = z
  .object({
    id: z.string().min(1),
    expectedRevision: z.number().int().positive(),
  })
  .strict();

export const EmptyInputSchema = z.object({}).strict();

export const NotebookOutputSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    subject: z.string(),
    revision: z.number().int().positive(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const NotebookListOutputSchema = z.array(NotebookOutputSchema);
export const OperationReceiptOutputSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
  })
  .catchall(z.unknown());

export type NotebookCreateInput = z.output<typeof NotebookCreateInputSchema>;
export type NotebookGetInput = z.output<typeof NotebookIdInputSchema>;
export type NotebookListInput = z.output<typeof EmptyInputSchema>;
export type NotebookUpdateCommandInput = z.output<typeof NotebookUpdateInputSchema>;
export type NotebookLifecycleCommandInput = z.output<
  typeof NotebookLifecycleInputSchema
>;
export type NotebookOutput = z.output<typeof NotebookOutputSchema>;
export type NotebookListOutput = z.output<typeof NotebookListOutputSchema>;

type CommandDefinition<
  Name extends string,
  Input,
  Output,
  InputSchema extends z.ZodType<Input>,
  OutputSchema extends z.ZodType<Output>,
> = {
  readonly name: Name;
  readonly description: string;
  readonly readOnly: boolean;
  readonly untrustedContent: boolean;
  readonly exposure: CommandExposure;
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
  readonly manualFields: readonly ManualFieldDescriptor[];
  readonly handler: (input: Input) => Promise<Output>;
};

function defineCommand<
  const Name extends string,
  Input,
  Output,
  InputSchema extends z.ZodType<Input>,
  OutputSchema extends z.ZodType<Output>,
>(
  definition: CommandDefinition<Name, Input, Output, InputSchema, OutputSchema>,
): CommandDefinition<Name, Input, Output, InputSchema, OutputSchema> {
  return definition;
}

function userAndWebMcp(): CommandExposure {
  return { manual: true, webmcp: true };
}

function manualOnly(): CommandExposure {
  return { manual: true, webmcp: false };
}

function hidden(): CommandExposure {
  return { manual: false, webmcp: false };
}

function createNotebookOutput(notebook: Notebook): NotebookOutput {
  return notebook;
}

export function createCommandCatalog(context: CommandContext) {
  const now = context.now ?? nowIsoInstant;
  const createId = context.createId ?? generateNotebookId;
  const repository = context.repository;

  const notebookCreate = defineCommand({
    name: "notebook_create",
    description: "Create a notebook with a title and subject.",
    readOnly: false,
    untrustedContent: true,
    exposure: userAndWebMcp(),
    inputSchema: NotebookCreateInputSchema,
    outputSchema: NotebookOutputSchema,
    manualFields: [
      {
        name: "title",
        label: "Title",
        type: "text",
        required: true,
      },
      {
        name: "subject",
        label: "Subject",
        type: "textarea",
        required: true,
      },
    ],
    handler: async (input: NotebookCreateInput): Promise<NotebookOutput> => {
      const createdAt = now();
      const notebook = createNotebook({
        id: createId(),
        title: input.title,
        subject: input.subject,
        createdAt,
      });
      return createNotebookOutput(await repository.create(notebook));
    },
  });

  const notebookGet = defineCommand({
    name: "notebook_get",
    description: "Read one notebook by id.",
    readOnly: true,
    untrustedContent: true,
    exposure: userAndWebMcp(),
    inputSchema: NotebookIdInputSchema,
    outputSchema: NotebookOutputSchema,
    manualFields: [
      {
        name: "id",
        label: "Notebook id",
        type: "text",
        required: true,
      },
    ],
    handler: async (input: NotebookGetInput): Promise<NotebookOutput> => {
      const id = createNotebookId(input.id);
      return createNotebookOutput(assertNotebookFound(await repository.get(id), id));
    },
  });

  const notebookList = defineCommand({
    name: "notebook_list",
    description: "List all notebooks.",
    readOnly: true,
    untrustedContent: true,
    exposure: userAndWebMcp(),
    inputSchema: EmptyInputSchema,
    outputSchema: NotebookListOutputSchema,
    manualFields: [],
    handler: async (): Promise<NotebookListOutput> => {
      const notebooks = await repository.list();
      return notebooks.map((notebook) => createNotebookOutput(notebook));
    },
  });

  const notebookUpdate = defineCommand({
    name: "notebook_update",
    description: "Update a notebook title or subject using optimistic revision checks.",
    readOnly: false,
    untrustedContent: true,
    exposure: userAndWebMcp(),
    inputSchema: NotebookUpdateInputSchema,
    outputSchema: NotebookOutputSchema,
    manualFields: [
      {
        name: "id",
        label: "Notebook id",
        type: "text",
        required: true,
      },
      {
        name: "title",
        label: "Title",
        type: "text",
        required: false,
      },
      {
        name: "subject",
        label: "Subject",
        type: "textarea",
        required: false,
      },
      {
        name: "expectedRevision",
        label: "Expected revision",
        type: "number",
        required: false,
      },
    ],
    handler: async (
      input: NotebookUpdateCommandInput,
    ): Promise<NotebookOutput> => {
      const id = createNotebookId(input.id);
      const current = assertNotebookFound(await repository.get(id), id);
      const expectedRevision =
        input.expectedRevision === undefined
          ? undefined
          : createRevision(input.expectedRevision);
      const changes: NotebookUpdateInput =
        input.title === undefined
          ? input.subject === undefined
            ? {}
            : { subject: input.subject }
          : input.subject === undefined
            ? { title: input.title }
            : { title: input.title, subject: input.subject };
      const options =
        expectedRevision === undefined ? {} : { expectedRevision };
      const updated = updateNotebook(
        current,
        changes,
        now(),
        options,
      );
      return createNotebookOutput(await repository.update(updated, expectedRevision));
    },
  });

  const lifecycleCommand = (
    kind: "notebook_trash" | "notebook_restore",
  ) =>
    defineCommand({
      name: kind,
      description:
        kind === "notebook_trash"
          ? "Move a notebook to Trash using an optimistic revision check."
          : "Restore a notebook from Trash using an optimistic revision check.",
      readOnly: false,
      untrustedContent: false,
      exposure: context.lifecycle === undefined ? hidden() : manualOnly(),
      inputSchema: NotebookLifecycleInputSchema,
      outputSchema: OperationReceiptOutputSchema,
      manualFields: [
        {
          name: "id",
          label: "Notebook id",
          type: "text",
          required: true,
        },
        {
          name: "expectedRevision",
          label: "Expected revision",
          type: "number",
          required: true,
        },
      ],
      handler: async (
        input: NotebookLifecycleCommandInput,
      ): Promise<z.output<typeof OperationReceiptOutputSchema>> => {
        if (context.lifecycle === undefined) {
          throw new Error("Notebook lifecycle commands are unavailable.");
        }
        const notebookId = createNotebookId(input.id);
        const expectedRevision = createRevision(input.expectedRevision);
        const result =
          kind === "notebook_trash"
            ? await context.lifecycle.trashNotebook(
                notebookId,
                expectedRevision,
              )
            : await context.lifecycle.restoreNotebook(
                notebookId,
                expectedRevision,
              );
        if (!result.ok) {
          throw new Error(`Notebook lifecycle operation failed: ${result.code}.`);
        }
        return {
          ...result.receipt,
          id: createReceiptId(result.receipt.id),
          kind: result.receipt.kind,
        };
      },
    });

  const notebookTrash = lifecycleCommand("notebook_trash");
  const notebookRestore = lifecycleCommand("notebook_restore");

  return {
    notebook_create: notebookCreate,
    notebook_get: notebookGet,
    notebook_list: notebookList,
    notebook_update: notebookUpdate,
    notebook_trash: notebookTrash,
    notebook_restore: notebookRestore,
  };
}

export type CommandCatalog = ReturnType<typeof createCommandCatalog>;
export type CommandName = keyof CommandCatalog;

export function commandNames(catalog: CommandCatalog): CommandName[] {
  return Object.keys(catalog).filter(
    (name): name is CommandName => name in catalog,
  );
}

export type CommandInput<Name extends CommandName> = z.input<CommandCatalog[Name]["inputSchema"]>;
export type CommandOutput<Name extends CommandName> = z.output<CommandCatalog[Name]["outputSchema"]>;

export function commandCatalogFor(repository: NotebookRepository): CommandCatalog {
  return createCommandCatalog({ repository });
}

export function parseCommandId(value: string): NotebookId {
  return createNotebookId(value);
}

export function parseCommandRevision(value: number): Revision {
  return createRevision(value);
}
