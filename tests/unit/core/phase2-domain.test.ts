import { describe, expect, it } from "vitest";

import {
  createIsoInstant,
  createNotebookId,
  createNoteEntry,
  createNoteId,
  createReceiptId,
  moveNote,
  parseNote,
  parseReceipt,
  restoreNote,
  sortNoteEntries,
  trashNote,
  type NoteEntry,
} from "../../../src/domain";

const createdAt = createIsoInstant("2026-08-25T12:00:00.000Z");
const movedAt = createIsoInstant("2026-08-25T12:01:00.000Z");
const trashedAt = createIsoInstant("2026-08-25T12:02:00.000Z");
const restoredAt = createIsoInstant("2026-08-25T12:03:00.000Z");
const sourceNotebookId = createNotebookId("notebook-source");
const destinationNotebookId = createNotebookId("notebook-destination");

function makeNote(id: string, text: string, timestamp = createdAt): NoteEntry {
  return createNoteEntry({
    id: createNoteId(id),
    targetNotebookId: sourceNotebookId,
    content: { format: "plain_text", text },
    createdAt: timestamp,
  });
}

describe("Phase 2 note and receipt domain", () => {
  it("parses branded note and receipt identifiers at the boundary", () => {
    const note = parseNote({
      id: " note-1 ",
      targetNotebookId: " notebook-source ",
      revision: 1,
      contentVersion: 1,
      content: { format: "plain_text", text: "Call Casey Friday" },
      lifecycle: "active",
      createdAt,
      updatedAt: createdAt,
    });
    const receipt = parseReceipt({
      id: " receipt-1 ",
      kind: "capture_note",
      source: "assistant",
      completedAt: createdAt,
      noteId: " note-1 ",
      targetNotebookId: " notebook-source ",
      resultingRevision: 1,
      undo: { kind: "available", effect: "withdraw_capture" },
    });

    expect(note.id).toBe(createNoteId("note-1"));
    expect(note.targetNotebookId).toBe(sourceNotebookId);
    expect(receipt.id).toBe(createReceiptId("receipt-1"));
    expect(receipt.kind).toBe("capture_note");
    if (receipt.kind !== "capture_note") {
      throw new Error("Expected a capture receipt.");
    }
    expect(receipt.noteId).toBe(note.id);
    expect(() => createNoteId("   ")).toThrow();
    expect(() => createReceiptId("   ")).toThrow();
  });

  it("keeps the note content in the exact versioned plain-text envelope", () => {
    const note = makeNote("note-content", "  Call Casey Friday  ");

    expect(note).toMatchObject({
      revision: 1,
      contentVersion: 1,
      content: { format: "plain_text", text: "  Call Casey Friday  " },
      lifecycle: "active",
    });
    expect(Object.keys(note.content)).toEqual(["format", "text"]);
  });

  it("moves, trashes, and restores an entry with one revision per transition", () => {
    const active = makeNote("note-lifecycle", "Keep the meeting short");
    const moved = moveNote(active, destinationNotebookId, movedAt);
    const trashed = trashNote(moved, trashedAt);
    const restored = restoreNote(trashed, restoredAt);

    expect(active).toMatchObject({
      targetNotebookId: sourceNotebookId,
      revision: 1,
      lifecycle: "active",
      updatedAt: createdAt,
    });
    expect(moved).toMatchObject({
      targetNotebookId: destinationNotebookId,
      revision: 2,
      lifecycle: "active",
      updatedAt: movedAt,
    });
    expect(trashed).toMatchObject({
      targetNotebookId: destinationNotebookId,
      revision: 3,
      lifecycle: "trashed",
      updatedAt: trashedAt,
    });
    expect(restored).toMatchObject({
      targetNotebookId: destinationNotebookId,
      revision: 4,
      lifecycle: "active",
      updatedAt: restoredAt,
    });
    expect(restored.content).toEqual(active.content);
  });

  it("orders equal timestamps by stable note ID", () => {
    const laterId = makeNote("note-z", "Second");
    const earlierId = makeNote("note-a", "First");

    expect(sortNoteEntries([laterId, earlierId])).toEqual([earlierId, laterId]);
  });

  it("parses a body-free receipt without copying note text into the audit row", () => {
    const receipt = parseReceipt({
      id: "receipt-body-free",
      kind: "capture_note",
      source: "person",
      completedAt: createdAt,
      noteId: "note-body-free",
      targetNotebookId: "notebook-source",
      resultingRevision: 1,
      undo: { kind: "available", effect: "withdraw_capture" },
    });

    expect(receipt).toMatchObject({
      id: createReceiptId("receipt-body-free"),
      noteId: createNoteId("note-body-free"),
      kind: "capture_note",
    });
    expect(receipt).not.toHaveProperty("body");
    expect(receipt).not.toHaveProperty("content");
    expect(receipt).not.toHaveProperty("text");
    expect(JSON.stringify(receipt)).not.toContain("Call Casey Friday");
  });
});
