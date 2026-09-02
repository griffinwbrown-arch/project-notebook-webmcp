import { z } from "zod";

import {
  createIsoInstant,
  createNotebookId,
  createRevision,
  type IsoInstant,
  type NotebookId,
  type Revision,
} from "./notebook";
import { createNoteId, type NoteId } from "./note";

export type ReceiptId = string & { readonly __brand: "ReceiptId" };
export type OperationSource = "person" | "assistant";

export type ReceiptUndo =
  | Readonly<{
      kind: "available";
      effect:
        | "withdraw_capture"
        | "move_back"
        | "restore_note"
        | "trash_note"
        | "restore_notebook"
        | "trash_notebook";
    }>
  | Readonly<{ kind: "consumed"; by: ReceiptId }>
  | Readonly<{ kind: "unavailable"; reason: "undo_is_final" }>;

type ReceiptBase = Readonly<{
  id: ReceiptId;
  source: OperationSource;
  completedAt: IsoInstant;
  undo: ReceiptUndo;
}>;

export type CaptureReceipt = ReceiptBase &
  Readonly<{
    kind: "capture_note";
    noteId: NoteId;
    targetNotebookId: NotebookId;
    resultingRevision: Revision;
  }>;

export type MoveReceipt = ReceiptBase &
  Readonly<{
    kind: "move_note";
    noteId: NoteId;
    fromNotebookId: NotebookId;
    toNotebookId: NotebookId;
    resultingRevision: Revision;
  }>;

export type NoteLifecycleReceipt = ReceiptBase &
  Readonly<{
    kind: "trash_note" | "restore_note";
    noteId: NoteId;
    priorLifecycle: "active" | "trashed";
    resultingLifecycle: "active" | "trashed";
    resultingRevision: Revision;
  }>;

export type NotebookLifecycleReceipt = ReceiptBase &
  Readonly<{
    kind: "trash_notebook" | "restore_notebook";
    notebookId: NotebookId;
    priorLifecycle: "active" | "trashed";
    resultingLifecycle: "active" | "trashed";
    resultingRevision: Revision;
    priorCurrentTargetNotebookId?: NotebookId;
    resultingWorkspaceRevision?: Revision;
  }>;

export type UndoReceipt = ReceiptBase &
  Readonly<{
    kind: "undo";
    undoOf: ReceiptId;
    affectedId: NoteId | NotebookId;
    resultingRevision: Revision;
  }>;

export type DurableReceipt =
  | CaptureReceipt
  | MoveReceipt
  | NoteLifecycleReceipt
  | NotebookLifecycleReceipt
  | UndoReceipt;

const ReceiptIdSchema = z.string().trim().min(1).pipe(z.custom<ReceiptId>());
const UndoSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("available"),
      effect: z.enum([
        "withdraw_capture",
        "move_back",
        "restore_note",
        "trash_note",
        "restore_notebook",
        "trash_notebook",
      ]),
    })
    .strict(),
  z.object({ kind: z.literal("consumed"), by: z.string() }).strict(),
  z
    .object({ kind: z.literal("unavailable"), reason: z.literal("undo_is_final") })
    .strict(),
]);
const ReceiptBaseSchema = {
  id: z.string(),
  source: z.enum(["person", "assistant"]),
  completedAt: z.string(),
  undo: UndoSchema,
};
const CaptureReceiptSchema = z
  .object({
    ...ReceiptBaseSchema,
    kind: z.literal("capture_note"),
    noteId: z.string(),
    targetNotebookId: z.string(),
    resultingRevision: z.number(),
  })
  .strict();
const MoveReceiptSchema = z
  .object({
    ...ReceiptBaseSchema,
    kind: z.literal("move_note"),
    noteId: z.string(),
    fromNotebookId: z.string(),
    toNotebookId: z.string(),
    resultingRevision: z.number(),
  })
  .strict();
const NoteLifecycleReceiptSchema = z
  .object({
    ...ReceiptBaseSchema,
    kind: z.enum(["trash_note", "restore_note"]),
    noteId: z.string(),
    priorLifecycle: z.enum(["active", "trashed"]),
    resultingLifecycle: z.enum(["active", "trashed"]),
    resultingRevision: z.number(),
  })
  .strict();
const NotebookLifecycleReceiptSchema = z
  .object({
    ...ReceiptBaseSchema,
    kind: z.enum(["trash_notebook", "restore_notebook"]),
    notebookId: z.string(),
    priorLifecycle: z.enum(["active", "trashed"]),
    resultingLifecycle: z.enum(["active", "trashed"]),
    resultingRevision: z.number(),
    priorCurrentTargetNotebookId: z.string().optional(),
    resultingWorkspaceRevision: z.number().optional(),
  })
  .strict();
const UndoReceiptSchema = z
  .object({
    ...ReceiptBaseSchema,
    kind: z.literal("undo"),
    undoOf: z.string(),
    affectedId: z.string(),
    resultingRevision: z.number(),
  })
  .strict();
const DurableReceiptSchema = z.discriminatedUnion("kind", [
  CaptureReceiptSchema,
  MoveReceiptSchema,
  NoteLifecycleReceiptSchema,
  NotebookLifecycleReceiptSchema,
  UndoReceiptSchema,
]);

export function createReceiptId(value: string): ReceiptId {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("Receipt id must not be empty.");
  }
  return ReceiptIdSchema.parse(normalized);
}

export function generateReceiptId(): ReceiptId {
  const value = globalThis.crypto?.randomUUID?.() ??
    `receipt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return createReceiptId(value);
}

function parseUndo(value: z.output<typeof UndoSchema>): ReceiptUndo {
  if (value.kind === "consumed") {
    return { kind: "consumed", by: createReceiptId(value.by) };
  }
  return value;
}

export function parseReceipt(value: unknown): DurableReceipt {
  const row = DurableReceiptSchema.parse(value);
  const base = {
    id: createReceiptId(row.id),
    source: row.source,
    completedAt: createIsoInstant(row.completedAt),
    undo: parseUndo(row.undo),
  };
  switch (row.kind) {
    case "capture_note":
      return {
        ...base,
        kind: row.kind,
        noteId: createNoteId(row.noteId),
        targetNotebookId: createNotebookId(row.targetNotebookId),
        resultingRevision: createRevision(row.resultingRevision),
      };
    case "move_note":
      return {
        ...base,
        kind: row.kind,
        noteId: createNoteId(row.noteId),
        fromNotebookId: createNotebookId(row.fromNotebookId),
        toNotebookId: createNotebookId(row.toNotebookId),
        resultingRevision: createRevision(row.resultingRevision),
      };
    case "trash_note":
    case "restore_note":
      return {
        ...base,
        kind: row.kind,
        noteId: createNoteId(row.noteId),
        priorLifecycle: row.priorLifecycle,
        resultingLifecycle: row.resultingLifecycle,
        resultingRevision: createRevision(row.resultingRevision),
      };
    case "trash_notebook":
    case "restore_notebook":
      return {
        ...base,
        kind: row.kind,
        notebookId: createNotebookId(row.notebookId),
        priorLifecycle: row.priorLifecycle,
        resultingLifecycle: row.resultingLifecycle,
        resultingRevision: createRevision(row.resultingRevision),
        ...(row.priorCurrentTargetNotebookId === undefined
          ? {}
          : {
              priorCurrentTargetNotebookId: createNotebookId(
                row.priorCurrentTargetNotebookId,
              ),
            }),
        ...(row.resultingWorkspaceRevision === undefined
          ? {}
          : {
              resultingWorkspaceRevision: createRevision(
                row.resultingWorkspaceRevision,
              ),
            }),
      };
    case "undo":
      return {
        ...base,
        kind: row.kind,
        undoOf: createReceiptId(row.undoOf),
        affectedId: createNoteId(row.affectedId),
        resultingRevision: createRevision(row.resultingRevision),
      };
  }
}
