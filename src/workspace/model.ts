import type {
  NoteId,
  NotebookId,
  OperationSource,
  ReceiptId,
  Revision,
} from "../domain";
import type { ProjectId, ProjectWorkbookId } from "../projects";

export type ProjectSummaryViewModel = Readonly<{
  id: ProjectId;
  name: string;
}>;

export type WorkbookIdentityViewModel =
  | Readonly<{
      kind: "unbound";
    }>
  | Readonly<{
      kind: "user" | "agent";
      workbookId: ProjectWorkbookId;
      projectId: ProjectId;
      projectName: string;
    }>;

export type WorkspacePlace =
  | { readonly kind: "shelf" }
  | {
      readonly kind: "notebook";
      readonly notebookId: NotebookId;
    };

export type NotebookCoverViewModel = {
  readonly kind: "notebook";
  readonly id: NotebookId;
  readonly title: string;
  readonly subject: string;
  readonly shelfKind?: "user" | "agent";
  readonly projectId?: ProjectId;
  readonly projectBinding?: WorkbookIdentityViewModel;
  readonly workbookIdentity?: Exclude<WorkbookIdentityViewModel, { kind: "unbound" }>;
};

export type ShelfViewModel = {
  readonly kind: "shelf";
  readonly inbox: NotebookCoverViewModel;
  readonly notebooks: readonly NotebookCoverViewModel[];
  readonly userNotebooks?: readonly NotebookCoverViewModel[];
  readonly agentNotebooks?: readonly NotebookCoverViewModel[];
  readonly projects?: readonly ProjectSummaryViewModel[];
  readonly notice: string | null;
};

export type FocusedNotebookViewModel = {
  readonly kind: "notebook";
  readonly notebook: NotebookCoverViewModel;
  readonly projects?: readonly ProjectSummaryViewModel[];
};

export type WorkspaceSnapshot =
  | { readonly status: "loading"; readonly requestedPlace: WorkspacePlace }
  | {
      readonly status: "ready";
      readonly view: ShelfViewModel | FocusedNotebookViewModel;
    }
  | {
      readonly status: "failed";
      readonly fallback: ShelfViewModel;
      readonly message: string;
    };

export type WorkspaceIssue =
  | { readonly kind: "busy"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

export type WorkspaceResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly issue: WorkspaceIssue };

export type CreateNotebookInput = {
  readonly title: string;
  readonly subject: string;
};

export type CreateProjectBindingInput = Readonly<{
  projectId: string;
  name: string;
}>;

export type NoteTarget =
  | Readonly<{ kind: "current" }>
  | Readonly<{ kind: "inbox" }>
  | Readonly<{ kind: "notebook"; notebookId: NotebookId }>;

export type PlainTextCaptureInput = Readonly<{
  target: NoteTarget;
  content: Readonly<{ format: "plain_text"; text: string }>;
  initiatedBy?: OperationSource;
}>;

export type WorkspaceOperation =
  | Readonly<{
      kind: "capture_note";
      target: Readonly<{ kind: "notebook"; notebookId: NotebookId }>;
      content: Readonly<{ format: "plain_text"; text: string }>;
      initiatedBy: OperationSource;
    }>
  | Readonly<{
      kind: "move_note";
      noteId: NoteId;
      to: Readonly<{ kind: "notebook"; notebookId: NotebookId }>;
      expectedRevision: Revision;
      initiatedBy: OperationSource;
    }>
  | Readonly<{
      kind: "trash_note" | "restore_note";
      noteId: NoteId;
      expectedRevision: Revision;
      initiatedBy: OperationSource;
    }>
  | Readonly<{
      kind: "trash_notebook" | "restore_notebook";
      notebookId: NotebookId;
      expectedRevision: Revision;
      initiatedBy: OperationSource;
    }>
  | Readonly<{
      kind: "undo";
      receiptId: ReceiptId;
      initiatedBy: OperationSource;
    }>;

export type WorkspaceOperationResult =
  | Readonly<{
      ok: true;
      receipt: Readonly<{ id: string; kind: string; [key: string]: unknown }>;
    }>
  | Readonly<{
      ok: false;
      code:
        | "already_undone"
        | "stale_undo"
        | "not_found"
        | "conflict"
        | "invalid_target";
    }>;

export const SHELF_PLACE: WorkspacePlace = { kind: "shelf" };

export const INITIAL_WORKSPACE_SNAPSHOT: WorkspaceSnapshot = {
  status: "loading",
  requestedPlace: SHELF_PLACE,
};
