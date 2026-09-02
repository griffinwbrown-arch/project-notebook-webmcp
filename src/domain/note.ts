import { z } from "zod";

import {
  createIsoInstant,
  createNotebookId,
  createRevision,
  type IsoInstant,
  type NotebookId,
  type Revision,
} from "./notebook";

export type NoteId = string & { readonly __brand: "NoteId" };
export type NoteLifecycle = "active" | "trashed";

export type PlainTextNoteContent = Readonly<{
  format: "plain_text";
  text: string;
}>;

export type NoteEntry = Readonly<{
  id: NoteId;
  targetNotebookId: NotebookId;
  revision: Revision;
  contentVersion: 1;
  content: PlainTextNoteContent;
  lifecycle: NoteLifecycle;
  createdAt: IsoInstant;
  updatedAt: IsoInstant;
}>;

export type CreateNoteEntryInput = Readonly<{
  id: NoteId;
  targetNotebookId: NotebookId;
  content: PlainTextNoteContent;
  createdAt: IsoInstant;
}>;

export class NoteDomainError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_NOTE"
      | "NOTE_ALREADY_TRASHED"
      | "NOTE_NOT_TRASHED",
    message: string,
  ) {
    super(message);
    this.name = "NoteDomainError";
  }
}

const NoteIdSchema = z.string().trim().min(1).pipe(z.custom<NoteId>());
const PlainTextContentSchema = z
  .object({
    format: z.literal("plain_text"),
    text: z.string(),
  })
  .strict();
const NoteRowSchema = z
  .object({
    id: z.string(),
    targetNotebookId: z.string(),
    revision: z.number(),
    contentVersion: z.literal(1),
    content: PlainTextContentSchema,
    lifecycle: z.enum(["active", "trashed"]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export function createNoteId(value: string): NoteId {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new NoteDomainError("INVALID_NOTE", "Note id must not be empty.");
  }
  return NoteIdSchema.parse(normalized);
}

export function generateNoteId(): NoteId {
  const value = globalThis.crypto?.randomUUID?.() ??
    `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return createNoteId(value);
}

function parseContent(value: PlainTextNoteContent): PlainTextNoteContent {
  return PlainTextContentSchema.parse(value);
}

export function createNoteEntry(input: CreateNoteEntryInput): NoteEntry {
  return {
    id: createNoteId(input.id),
    targetNotebookId: createNotebookId(input.targetNotebookId),
    revision: createRevision(1),
    contentVersion: 1,
    content: parseContent(input.content),
    lifecycle: "active",
    createdAt: createIsoInstant(input.createdAt),
    updatedAt: createIsoInstant(input.createdAt),
  };
}

export function parseNote(value: unknown): NoteEntry {
  const row = NoteRowSchema.parse(value);
  return {
    id: createNoteId(row.id),
    targetNotebookId: createNotebookId(row.targetNotebookId),
    revision: createRevision(row.revision),
    contentVersion: 1,
    content: parseContent(row.content),
    lifecycle: row.lifecycle,
    createdAt: createIsoInstant(row.createdAt),
    updatedAt: createIsoInstant(row.updatedAt),
  };
}

export function moveNote(
  note: NoteEntry,
  targetNotebookId: NotebookId,
  updatedAt: IsoInstant,
): NoteEntry {
  if (note.lifecycle !== "active") {
    throw new NoteDomainError("NOTE_ALREADY_TRASHED", "A trashed note cannot be moved.");
  }
  return {
    ...note,
    targetNotebookId: createNotebookId(targetNotebookId),
    revision: createRevision(note.revision + 1),
    updatedAt: createIsoInstant(updatedAt),
  };
}

export function trashNote(note: NoteEntry, updatedAt: IsoInstant): NoteEntry {
  if (note.lifecycle === "trashed") {
    throw new NoteDomainError("NOTE_ALREADY_TRASHED", "The note is already in Trash.");
  }
  return {
    ...note,
    lifecycle: "trashed",
    revision: createRevision(note.revision + 1),
    updatedAt: createIsoInstant(updatedAt),
  };
}

export function restoreNote(note: NoteEntry, updatedAt: IsoInstant): NoteEntry {
  if (note.lifecycle !== "trashed") {
    throw new NoteDomainError("NOTE_NOT_TRASHED", "The note is not in Trash.");
  }
  return {
    ...note,
    lifecycle: "active",
    revision: createRevision(note.revision + 1),
    updatedAt: createIsoInstant(updatedAt),
  };
}

export function sortNoteEntries(notes: readonly NoteEntry[]): NoteEntry[] {
  return [...notes].sort((left, right) => {
    const timeOrder = left.createdAt.localeCompare(right.createdAt);
    return timeOrder === 0 ? left.id.localeCompare(right.id) : timeOrder;
  });
}
