import type {
  IsoInstant,
  Notebook,
  NotebookId,
  Revision,
} from "../domain";

import type {
  WorkspaceOperation,
  WorkspaceOperationResult,
} from "./model";

export type WorkspaceMetadata = Readonly<{
  id: "workspace";
  version: 1;
  inboxNotebookId: NotebookId;
  currentTargetNotebookId: NotebookId;
  revision: Revision;
  updatedAt: IsoInstant;
}>;

export type WorkspaceLoadIssue = Readonly<{
  kind: "malformed_notebook";
  id: string;
  message: string;
}>;

export type WorkspaceBootstrap = Readonly<{
  inbox: Notebook;
  notebooks: readonly Notebook[];
  metadata: WorkspaceMetadata;
  issues: readonly WorkspaceLoadIssue[];
}>;

export interface WorkspacePersistence {
  bootstrap(): Promise<WorkspaceBootstrap>;
  getNotebook(id: NotebookId): Promise<Notebook | null>;
  createNotebook(notebook: Notebook): Promise<Notebook>;
  updateNotebook(notebook: Notebook, expectedRevision: Revision): Promise<Notebook>;
  setCurrentTarget(id: NotebookId): Promise<WorkspaceMetadata>;
  execute(operation: WorkspaceOperation): Promise<WorkspaceOperationResult>;
  close(): Promise<void>;
}
