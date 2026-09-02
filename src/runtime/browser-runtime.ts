import type { CanvasSnapshotStore } from "../domain";
import {
  createIndexedDbCanvasSnapshotStore,
  createIndexedDbProjectStorage,
  IndexedDbPageStorage,
  type IndexedDbProjectStorage,
  IndexedDbWorkspaceRepository,
} from "../indexeddb";
import { createBrowserWorkspaceHistory } from "../workspace/history";
import {
  createWorkspaceController,
  type WorkspaceController,
} from "../workspace/controller";

export type BrowserWorkspaceRuntime = {
  readonly controller: WorkspaceController;
  readonly canvasSnapshotStore: CanvasSnapshotStore;
  readonly pageStorage: IndexedDbPageStorage;
  readonly projectStorage: IndexedDbProjectStorage;
  readonly cleanup: () => Promise<void>;
};

export function createBrowserWorkspaceRuntime(): BrowserWorkspaceRuntime {
  const workspacePersistence = new IndexedDbWorkspaceRepository();
  const canvasSnapshotStore = createIndexedDbCanvasSnapshotStore();
  const pageStorage = new IndexedDbPageStorage();
  const projectStorage = createIndexedDbProjectStorage();
  const controller = createWorkspaceController(
    workspacePersistence,
    createBrowserWorkspaceHistory(),
    { projectStorage },
  );

  return {
    controller,
    canvasSnapshotStore,
    pageStorage,
    projectStorage,
    cleanup: async (): Promise<void> => {
      await controller.dispose();
      await Promise.all([
        workspacePersistence.close(),
        canvasSnapshotStore.close(),
        pageStorage.close(),
        projectStorage.close(),
      ]);
    },
  };
}
