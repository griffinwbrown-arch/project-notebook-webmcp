import type { NotebookId } from "../domain";
import type { PageStorage } from "../indexeddb/page-storage";
import type { PageCommandRegistry } from "../page";
import type { WebMcpModelContext, WebMcpTool } from "../types/webmcp";
import type { WorkspaceController } from "../workspace/controller";
import {
  DemoNotebookKernel,
  NOTEBOOK_APPLY_INPUT_SCHEMA,
  NOTEBOOK_OPEN_INPUT_SCHEMA,
  NOTEBOOK_READ_INPUT_SCHEMA,
} from "./notebook-kernel";

type BoundEditorSession = {
  token: symbol;
  notebookId: NotebookId;
  registry: PageCommandRegistry;
  resetView: () => void;
  unbindKernel: (() => void) | null;
};

type AgentToolBinding = {
  controller: WorkspaceController | null;
  pageStorage: PageStorage | null;
  kernel: DemoNotebookKernel | null;
  editorSession: BoundEditorSession | null;
  registered: Set<string>;
  installing: Promise<void> | null;
};

const AGENT_BINDINGS = new WeakMap<WebMcpModelContext, AgentToolBinding>();

function bindingFor(modelContext: WebMcpModelContext): AgentToolBinding {
  const existing = AGENT_BINDINGS.get(modelContext);
  if (existing !== undefined) return existing;
  const binding: AgentToolBinding = {
    controller: null,
    pageStorage: null,
    kernel: null,
    editorSession: null,
    registered: new Set<string>(),
    installing: null,
  };
  AGENT_BINDINGS.set(modelContext, binding);
  return binding;
}

function unavailable(): Readonly<{ ok: false; code: string; message: string }> {
  return {
    ok: false,
    code: "NOTEBOOK_KERNEL_UNAVAILABLE",
    message: "The demo notebook kernel is not connected to page storage.",
  };
}

function bindEditorToKernel(binding: AgentToolBinding): void {
  const session = binding.editorSession;
  session?.unbindKernel?.();
  if (session === null || binding.kernel === null) return;
  session.unbindKernel = binding.kernel.bindActiveNotebook({
    notebookId: session.notebookId,
    registry: session.registry,
    resetView: session.resetView,
  });
}

function toolsFor(binding: AgentToolBinding): readonly WebMcpTool[] {
  return [
    {
      name: "notebook_read",
      description: "Read the agent guide, current notebook, notebook shelf, one exact page, or recent reversible agent changes.",
      inputSchema: NOTEBOOK_READ_INPUT_SCHEMA,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (input: unknown) => binding.kernel?.read(input) ?? unavailable(),
    },
    {
      name: "notebook_open",
      description: "Open the shelf, a notebook by unique title or id, an exact or adjacent page, or reset the notebook camera.",
      inputSchema: NOTEBOOK_OPEN_INPUT_SCHEMA,
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input: unknown) => binding.kernel?.open(input) ?? unavailable(),
    },
    {
      name: "notebook_apply",
      description: "Create a notebook, add a page, write formatted text, add or arrange page-native figures, place a validated trace-detailed-art VectorInkDocument, or undo the latest agent change. Placement values use 0-100 percentages of the writable page; diagram node x/y values use 0-100 percentages of the diagram.",
      inputSchema: NOTEBOOK_APPLY_INPUT_SCHEMA,
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: (input: unknown) => binding.kernel?.apply(input) ?? unavailable(),
    },
  ];
}

export async function registerDemoDeskWebMcpTools(
  modelContext: WebMcpModelContext | null | undefined,
  controller: WorkspaceController,
  pageStorage?: PageStorage,
): Promise<void> {
  if (modelContext === null || modelContext === undefined) return;
  const binding = bindingFor(modelContext);
  const dependenciesChanged = binding.controller !== controller
    || (pageStorage !== undefined && binding.pageStorage !== pageStorage);
  binding.controller = controller;
  if (pageStorage !== undefined) binding.pageStorage = pageStorage;
  if (dependenciesChanged || binding.kernel === null) {
    binding.kernel = new DemoNotebookKernel(
      binding.controller,
      binding.pageStorage ?? undefined,
    );
    bindEditorToKernel(binding);
  }

  if (binding.installing !== null) {
    await binding.installing;
    return;
  }
  const missing = toolsFor(binding).filter((tool) => !binding.registered.has(tool.name));
  if (missing.length === 0) return;
  binding.installing = (async () => {
    for (const tool of missing) {
      if (typeof document !== "undefined" && document.modelContext === modelContext) {
        await document.modelContext.registerTool(tool);
      } else {
        await modelContext.registerTool(tool);
      }
      binding.registered.add(tool.name);
    }
  })();
  try {
    await binding.installing;
  } finally {
    binding.installing = null;
  }
}

export function bindDemoNotebookAgentSession(
  modelContext: WebMcpModelContext | null | undefined,
  notebookId: NotebookId,
  registry: PageCommandRegistry,
  resetView: () => void,
): () => void {
  if (modelContext === null || modelContext === undefined) return () => undefined;
  const binding = bindingFor(modelContext);
  const token = Symbol(notebookId);
  binding.editorSession?.unbindKernel?.();
  binding.editorSession = { token, notebookId, registry, resetView, unbindKernel: null };
  bindEditorToKernel(binding);
  return () => {
    if (binding.editorSession?.token !== token) return;
    binding.editorSession.unbindKernel?.();
    binding.editorSession = null;
  };
}
