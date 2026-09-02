import { describe, expect, it } from "vitest";

import {
  createIsoInstant,
  createNotebook,
  createNotebookId,
  createRevision,
  type Notebook,
} from "../../../src/domain";
import {
  IndexedDbCanvasSnapshotStore,
  IndexedDbNotebookRepository,
  PHASE0_DATABASE_NAME,
  PHASE0_DATABASE_VERSION,
} from "../../../src/indexeddb";

const instant = createIsoInstant("2026-08-25T12:00:00.000Z");
const notebook = (id: string): Notebook =>
  createNotebook({
    id: createNotebookId(id),
    title: "Notebook",
    subject: "Subject",
    createdAt: instant,
  });

describe("IndexedDB core stores", () => {
  it("persists notebook create and update across close and reopen", async () => {
    const first = new IndexedDbNotebookRepository();
    const created = await first.create(notebook("idb-crud"));
    expect(await first.get(created.id)).toEqual(created);

    const updated: Notebook = {
      ...created,
      title: "Updated",
      revision: createRevision(2),
      updatedAt: instant,
    };
    await first.update(updated, createRevision(1));
    expect((await first.list()).map((item) => item.title)).toContain("Updated");
    await first.close();

    const reopened = new IndexedDbNotebookRepository();
    expect(await reopened.get(created.id)).toEqual(updated);
    await reopened.close();
  });

  it("keeps created and updated notebooks after independent reopen operations", async () => {
    const first = new IndexedDbNotebookRepository();
    const created = await first.create(notebook("idb-reopen"));
    await first.close();

    const second = new IndexedDbNotebookRepository();
    expect(await second.get(created.id)).toEqual(created);
    const updated: Notebook = {
      ...created,
      title: "Reopened",
      revision: createRevision(2),
      updatedAt: createIsoInstant("2026-08-25T12:01:00.000Z"),
    };
    await second.update(updated, createRevision(1));
    await second.close();

    const third = new IndexedDbNotebookRepository();
    expect(await third.get(created.id)).toEqual(updated);
    await third.close();
  });

  it("rejects malformed notebook rows at the read boundary", async () => {
    const request = indexedDB.open(
      PHASE0_DATABASE_NAME,
      PHASE0_DATABASE_VERSION,
    );
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("open failed"));
    });
    const transaction = database.transaction("notebooks", "readwrite");
    transaction.objectStore("notebooks").put({
      id: "bad-row",
      title: "Bad",
      subject: "Bad",
      revision: 0,
      createdAt: "not-an-instant",
      updatedAt: "not-an-instant",
    });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("write failed"));
    });
    database.close();

    const repository = new IndexedDbNotebookRepository();
    await expect(repository.list()).rejects.toThrow();
    await repository.close();
  });

  it("stores versioned JSON-safe canvas envelopes by notebook id", async () => {
    const store = new IndexedDbCanvasSnapshotStore();
    const id = createNotebookId("canvas-id");
    const saved = await store.save({
      version: 1,
      notebookId: id,
      savedAt: instant,
      snapshot: { shapes: [{ type: "note", x: 1, selected: false }] },
    });
    expect(saved.version).toBe(1);
    expect(await store.get(id)).toEqual(saved);
    await store.close();
  });
});
