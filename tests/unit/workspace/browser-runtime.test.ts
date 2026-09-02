import { beforeEach, describe, expect, it } from "vitest";

import {
  createIsoInstant,
  createNotebook,
  createNotebookId,
  type CanvasSnapshotEnvelope,
} from "../../../src/domain";
import {
  IndexedDbCanvasSnapshotStore,
  IndexedDbNotebookRepository,
  PHASE0_DATABASE_NAME,
  PHASE0_DATABASE_VERSION,
} from "../../../src/indexeddb";
import { createBrowserWorkspaceRuntime } from "../../../src/runtime";

function deletePhaseZeroDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(PHASE0_DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("delete failed"));
    request.onblocked = () => reject(new Error("database deletion was blocked"));
  });
}

describe("browser workspace runtime preservation", () => {
  beforeEach(async () => {
    await deletePhaseZeroDatabase();
    window.history.replaceState(null, "", "/desk");
  });

  it("keeps the exact database stores, existing notebook, and version-one canvas row", async () => {
    const id = createNotebookId("preserved-notebook");
    const existing = createNotebook({
      id,
      title: "Preserved notebook",
      subject: "Existing local work",
      createdAt: createIsoInstant("2026-08-25T12:00:00.000Z"),
    });
    const canvas: CanvasSnapshotEnvelope = {
      version: 1,
      notebookId: id,
      savedAt: createIsoInstant("2026-08-25T12:30:00.000Z"),
      snapshot: { shapes: [{ id: "shape-one", type: "note" }] },
    };
    const seedNotebooks = new IndexedDbNotebookRepository();
    const seedCanvas = new IndexedDbCanvasSnapshotStore();
    await seedNotebooks.create(existing);
    await seedCanvas.save(canvas);
    await Promise.all([seedNotebooks.close(), seedCanvas.close()]);

    window.history.replaceState(
      null,
      "",
      "/desk?notebook=preserved-notebook&view=sketch",
    );
    const runtime = createBrowserWorkspaceRuntime();
    await runtime.controller.start();
    expect(runtime.controller.getSnapshot()).toMatchObject({
      status: "ready",
      view: {
        kind: "notebook",
        notebook: { id, title: existing.title },
      },
    });
    expect(window.location.pathname + window.location.search).toBe(
      "/desk?notebook=preserved-notebook",
    );

    const created = await runtime.controller.createNotebook({
      title: "A new notebook",
      subject: "Created through the new controller",
    });
    expect(created).toMatchObject({ ok: true });
    await runtime.cleanup();

    const verifyNotebooks = new IndexedDbNotebookRepository();
    const verifyCanvas = new IndexedDbCanvasSnapshotStore();
    expect(await verifyNotebooks.get(id)).toEqual(existing);
    expect((await verifyNotebooks.list()).map((notebook) => notebook.title)).toContain(
      "A new notebook",
    );
    expect(await verifyCanvas.get(id)).toEqual(canvas);

    const request = indexedDB.open(
      PHASE0_DATABASE_NAME,
      PHASE0_DATABASE_VERSION,
    );
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("open failed"));
    });
    const transaction = database.transaction(
      ["notebooks", "canvasSnapshots"],
      "readonly",
    );
    expect(transaction.objectStore("notebooks").keyPath).toBe("id");
    expect(transaction.objectStore("canvasSnapshots").keyPath).toBe(
      "notebookId",
    );
    database.close();
    await Promise.all([verifyNotebooks.close(), verifyCanvas.close()]);
  });

  it("reopens lazy IndexedDB connections after cleanup and closes them again", async () => {
    const runtime = createBrowserWorkspaceRuntime();
    await runtime.controller.start();
    await runtime.cleanup();

    await runtime.controller.start();
    await expect(runtime.controller.listNotebooks()).resolves.toEqual({
      ok: true,
      value: [],
    });
    await runtime.cleanup();
  });

  it("disposes the controller before closing every independently opened database connection", async () => {
    const runtime = createBrowserWorkspaceRuntime();
    await runtime.controller.start();
    const created = await runtime.controller.createNotebook({
      title: "Cleanup target",
      subject: "The visible place must remain stable after disposal",
    });
    if (!created.ok) throw new Error("The cleanup fixture notebook was not created.");
    await runtime.controller.openNotebook(created.value.id);

    await runtime.canvasSnapshotStore.save({
      version: 1,
      notebookId: created.value.id,
      savedAt: createIsoInstant("2026-08-30T12:00:00.000Z"),
      snapshot: { shapes: [] },
    });
    await runtime.pageStorage.ensureWorkbook(createNotebookId("runtime-pages"));
    await runtime.projectStorage.listProjects();

    await runtime.cleanup();
    const disposedSnapshot = runtime.controller.getSnapshot();
    runtime.controller.showShelf();
    expect(disposedSnapshot).toMatchObject({
      status: "ready",
      view: { kind: "notebook", notebook: { id: created.value.id } },
    });
    expect(runtime.controller.getSnapshot()).toEqual(disposedSnapshot);

    await expect(deletePhaseZeroDatabase()).resolves.toBeUndefined();
  });
});
