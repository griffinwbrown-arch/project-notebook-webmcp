import type { CommandRegistry } from "../../commands";
import type { CommandName } from "../../commands/catalog";
import type { WebMcpModelContext } from "../../types/webmcp";

export type { WebMcpModelContext, WebMcpTool } from "../../types/webmcp";

export type WebMcpRegistrationState =
  | {
      readonly status: "unsupported";
      readonly reason: "missing_model_context";
    }
  | {
      readonly status: "registered";
      readonly toolNames: readonly CommandName[];
    }
  | {
      readonly status: "error";
      readonly toolNames: readonly CommandName[];
      readonly message: string;
    };

export type WebMcpDocument = Pick<Document, "modelContext">;

export type WebMcpRegistrationOptions = {
  readonly registry: CommandRegistry;
  readonly modelContext?: WebMcpModelContext | null;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "WebMCP registration failed.";
}

function currentDocument(): WebMcpDocument | undefined {
  if (typeof document === "undefined") {
    return undefined;
  }
  return document;
}

export function registerWebMcpTools(
  registry: CommandRegistry,
  targetDocument?: WebMcpDocument,
): Promise<WebMcpRegistrationState>;
export function registerWebMcpTools(
  options: WebMcpRegistrationOptions,
): Promise<WebMcpRegistrationState>;
export async function registerWebMcpTools(
  first: CommandRegistry | WebMcpRegistrationOptions,
  targetDocument: WebMcpDocument | undefined = currentDocument(),
): Promise<WebMcpRegistrationState> {
  let registry: CommandRegistry;
  let modelContext: WebMcpModelContext | null | undefined;
  if ("registry" in first) {
    registry = first.registry;
    modelContext = first.modelContext;
  } else {
    registry = first;
    modelContext = targetDocument?.modelContext;
  }
  if (modelContext === undefined) {
    return { status: "unsupported", reason: "missing_model_context" };
  }
  if (modelContext === null) {
    return { status: "unsupported", reason: "missing_model_context" };
  }

  const descriptors = registry.describe("webmcp");
  const registered: CommandName[] = [];
  try {
    for (const descriptor of descriptors) {
      const name = descriptor.name;
      const tool = {
        name,
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
        outputSchema: descriptor.outputSchema,
        annotations: {
          readOnlyHint: descriptor.readOnly,
          untrustedContentHint: descriptor.untrustedContent,
        },
        execute: async (input: unknown): Promise<unknown> => {
          const result = await registry.executeExternal(name, input, "webmcp");
          if (result.outcome === "error") {
            throw new Error(result.error.message);
          }
          return result.output;
        },
      };
      await modelContext.registerTool(tool);
      registered.push(name);
    }
  } catch (error: unknown) {
    return {
      status: "error",
      toolNames: registered,
      message: describeError(error),
    };
  }

  return { status: "registered", toolNames: registered };
}

export async function installWebMcpTools(
  modelContext: WebMcpModelContext | undefined,
  registry: CommandRegistry,
): Promise<WebMcpRegistrationState> {
  if (modelContext === undefined) {
    return { status: "unsupported", reason: "missing_model_context" };
  }
  return registerWebMcpTools(registry, { modelContext });
}
