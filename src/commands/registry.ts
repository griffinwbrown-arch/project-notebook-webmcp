import { z } from "zod";

import {
  NotebookDomainError,
  createRevision,
  type Revision,
} from "../domain";

import {
  commandNames,
  type CommandCatalog,
  type CommandName,
  type CommandSource,
  type CommandInput,
  type CommandOutput,
  createCommandCatalog,
} from "./catalog";

export type JsonSchemaDescriptor = z.core.JSONSchema.BaseSchema;

export type CommandDescriptor = {
  readonly name: CommandName;
  readonly description: string;
  readonly readOnly: boolean;
  readonly untrustedContent: boolean;
  readonly exposure: Readonly<Record<CommandSource, boolean>>;
  readonly inputSchema: JsonSchemaDescriptor;
  readonly outputSchema: JsonSchemaDescriptor;
  readonly manualFields: readonly {
    readonly name: string;
    readonly label: string;
    readonly type: "text" | "textarea" | "number";
    readonly required: boolean;
    readonly description?: string;
  }[];
};

export type CommandError = {
  readonly code:
    | "UNKNOWN_COMMAND"
    | "INPUT_VALIDATION_ERROR"
    | "OUTPUT_VALIDATION_ERROR"
    | "COMMAND_ERROR";
  readonly message: string;
};

export type CommandReceipt = {
  readonly command: string;
  readonly source: CommandSource;
  readonly completedAt: string;
};

export type CommandExecutionSuccess<
  Name extends CommandName = CommandName,
  Output = unknown,
> = CommandReceipt & {
  readonly command: Name;
  readonly outcome: "success";
  readonly output: Output;
};

export type CommandExecutionFailure = CommandReceipt & {
  readonly outcome: "error";
  readonly error: CommandError;
};

export type CommandExecutionResult =
  | CommandExecutionSuccess<CommandName, unknown>
  | CommandExecutionFailure;

export type CommandCompletion = CommandExecutionResult;
export type CompletionListener = (completion: CommandCompletion) => void;

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "The command failed.";
}

function safeError(error: unknown): CommandError {
  if (error instanceof z.ZodError) {
    return {
      code: "INPUT_VALIDATION_ERROR",
      message: error.issues.map((issue) => issue.message).join(" "),
    };
  }
  if (error instanceof NotebookDomainError) {
    return { code: "COMMAND_ERROR", message: error.message };
  }
  return { code: "COMMAND_ERROR", message: errorMessage(error) };
}

function completedAt(): string {
  return new Date().toISOString();
}

export class CommandRegistry {
  private readonly listeners = new Set<CompletionListener>();
  private readonly names: readonly CommandName[];

  public constructor(private readonly catalog: CommandCatalog) {
    this.names = commandNames(catalog);
  }

  private commandName(value: string): CommandName | null {
    return this.names.find((candidate) => candidate === value) ?? null;
  }

  public subscribe(listener: CompletionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getCatalog(): CommandCatalog {
    return this.catalog;
  }

  public describe(source?: CommandSource): CommandDescriptor[] {
    return this.names.filter((name) =>
      source === undefined ? true : this.catalog[name].exposure[source],
    ).map((name) => {
      const definition = this.catalog[name];
      return {
        name,
        description: definition.description,
        readOnly: definition.readOnly,
        untrustedContent: definition.untrustedContent,
        exposure: definition.exposure,
        inputSchema: z.toJSONSchema(definition.inputSchema, {
          target: "draft-07",
          unrepresentable: "any",
        }),
        outputSchema: z.toJSONSchema(definition.outputSchema, {
          target: "draft-07",
          unrepresentable: "any",
        }),
        manualFields: definition.manualFields,
      };
    });
  }

  public async executeManual<Name extends CommandName>(
    name: Name,
    input: CommandInput<Name>,
  ): Promise<CommandExecutionResult> {
    return this.executeKnown(name, input, "manual");
  }

  public async executeExternal(
    name: string,
    input: unknown,
    source: Exclude<CommandSource, "manual">,
  ): Promise<CommandExecutionResult> {
    const known = this.commandName(name);
    if (known === null) {
      const result: CommandExecutionFailure = {
        command: name,
        source,
        outcome: "error",
        error: {
          code: "UNKNOWN_COMMAND",
          message: `Unknown command ${name}.`,
        },
        completedAt: completedAt(),
      };
      this.notify(result);
      return result;
    }
    if (!this.catalog[known].exposure[source]) {
      const result: CommandExecutionFailure = {
        command: name,
        source,
        outcome: "error",
        error: {
          code: "UNKNOWN_COMMAND",
          message: `Unknown command ${name}.`,
        },
        completedAt: completedAt(),
      };
      this.notify(result);
      return result;
    }
    return this.executeKnown(known, input, source);
  }

  public async execute(
    name: string,
    input: unknown,
    source: CommandSource,
  ): Promise<CommandExecutionResult> {
    if (source === "manual") {
      const known = this.commandName(name);
      if (known === null) {
        const result: CommandExecutionFailure = {
          command: name,
          source,
          outcome: "error",
          error: {
            code: "UNKNOWN_COMMAND",
            message: `Unknown command ${name}.`,
          },
          completedAt: completedAt(),
        };
        this.notify(result);
        return result;
      }
      return this.executeKnown(known, input, source);
    }
    return this.executeExternal(name, input, source);
  }

  private async executeKnown(
    name: CommandName,
    input: unknown,
    source: CommandSource,
  ): Promise<CommandExecutionResult> {
    switch (name) {
      case "notebook_create":
        return this.executeDefinition(this.catalog.notebook_create, input, source);
      case "notebook_get":
        return this.executeDefinition(this.catalog.notebook_get, input, source);
      case "notebook_list":
        return this.executeDefinition(this.catalog.notebook_list, input, source);
      case "notebook_update":
        return this.executeDefinition(this.catalog.notebook_update, input, source);
      case "notebook_trash":
        return this.executeDefinition(this.catalog.notebook_trash, input, source);
      case "notebook_restore":
        return this.executeDefinition(this.catalog.notebook_restore, input, source);
      default: {
        const exhaustive: never = name;
        return exhaustive;
      }
    }
  }

  private async executeDefinition<Input, Output>(
    definition: {
      readonly name: CommandName;
      readonly inputSchema: z.ZodType<Input>;
      readonly outputSchema: z.ZodType<Output>;
      readonly handler: (input: Input) => Promise<Output>;
    },
    rawInput: unknown,
    source: CommandSource,
  ): Promise<CommandExecutionResult> {
    const receipt = {
      command: definition.name,
      source,
      completedAt: completedAt(),
    };
    const parsedInput = definition.inputSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      const result: CommandExecutionFailure = {
        ...receipt,
        outcome: "error",
        error: {
          code: "INPUT_VALIDATION_ERROR",
          message: parsedInput.error.issues.map((issue) => issue.message).join(" "),
        },
      };
      this.notify(result);
      return result;
    }

    try {
      const output = await definition.handler(parsedInput.data);
      const parsedOutput = definition.outputSchema.safeParse(output);
      if (!parsedOutput.success) {
        const result: CommandExecutionFailure = {
          ...receipt,
          outcome: "error",
          error: {
            code: "OUTPUT_VALIDATION_ERROR",
            message: parsedOutput.error.issues.map((issue) => issue.message).join(" "),
          },
        };
        this.notify(result);
        return result;
      }
      const result: CommandExecutionSuccess<CommandName, unknown> = {
        ...receipt,
        outcome: "success",
        output: parsedOutput.data,
      };
      this.notify(result);
      return result;
    } catch (error: unknown) {
      const result: CommandExecutionFailure = {
        ...receipt,
        outcome: "error",
        error: safeError(error),
      };
      this.notify(result);
      return result;
    }
  }

  private notify(result: CommandExecutionResult): void {
    for (const listener of this.listeners) {
      listener(result);
    }
  }
}

export function createCommandRegistry(
  catalogOrRepository: CommandCatalog | { readonly repository: import("../domain").NotebookRepository },
): CommandRegistry {
  const catalog =
    "repository" in catalogOrRepository
      ? createCommandCatalog(catalogOrRepository)
      : catalogOrRepository;
  return new CommandRegistry(catalog);
}

export function isCommandSuccess(
  result: CommandExecutionResult,
): result is CommandExecutionSuccess<CommandName, unknown> {
  return result.outcome === "success";
}

export function isCommandFailure(
  result: CommandExecutionResult,
): result is CommandExecutionFailure {
  return result.outcome === "error";
}

export type TypedCommandOutput<Name extends CommandName> = CommandOutput<Name>;
export type TypedRevision = Revision;
export const parseRegistryRevision = (value: number): Revision => createRevision(value);
