"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { registerOfflineShell } from "../../pwa/offline-shell";
import {
  createBrowserWorkspaceRuntime,
  type BrowserWorkspaceRuntime,
} from "../../runtime";
import {
  INITIAL_WORKSPACE_SNAPSHOT,
  type CreateNotebookInput,
  type WorkspaceResult,
  type NotebookCoverViewModel,
} from "../../workspace/model";
import type { ProjectId } from "../../projects";

import { FocusedNotebook } from "./FocusedNotebook";
import { Shelf } from "./Shelf";
import { WorkspaceBackupPanel } from "./WorkspaceBackupPanel";

export function DeskDocument(): React.JSX.Element {
  const [runtime] = useState<BrowserWorkspaceRuntime>(
    createBrowserWorkspaceRuntime,
  );
  const snapshot = useSyncExternalStore(
    runtime.controller.subscribe,
    runtime.controller.getSnapshot,
    () => INITIAL_WORKSPACE_SNAPSHOT,
  );

  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => {
      if (mounted) {
        void runtime.controller.start();
        void registerOfflineShell();
      }
    });
    return () => {
      mounted = false;
      void runtime.cleanup();
    };
  }, [runtime]);

  useEffect(() => {
    const refresh = (): void => { void runtime.controller.refreshProjectAssignments(); };
    document.addEventListener("project-notebook-workspace-changed", refresh);
    return () => document.removeEventListener("project-notebook-workspace-changed", refresh);
  }, [runtime]);

  const createNotebook = useCallback(
    (
      input: CreateNotebookInput,
    ): Promise<WorkspaceResult<NotebookCoverViewModel>> =>
      runtime.controller.createNotebook(input),
    [runtime],
  );
  const openNotebook = useCallback(
    (notebookId: NotebookCoverViewModel["id"]): void => {
      void runtime.controller.openNotebook(notebookId);
    },
    [runtime],
  );
  const showShelf = useCallback((): void => {
    runtime.controller.showShelf();
  }, [runtime]);
  const bindNotebook = useCallback(
    (notebookId: NotebookCoverViewModel["id"], projectId: ProjectId) =>
      runtime.controller.bindNotebookToProject(notebookId, projectId),
    [runtime],
  );
  const createProjectAndBind = useCallback(
    (notebookId: NotebookCoverViewModel["id"], input: Readonly<{ projectId: string; name: string }>) =>
      runtime.controller.createProjectAndBindNotebook(notebookId, input),
    [runtime],
  );
  let content: React.JSX.Element;
  if (snapshot.status === "loading") {
    content = (
      <main className="desk-loading" aria-busy="true">
        <p>Opening your desk…</p>
      </main>
    );
  } else if (snapshot.status === "failed") {
    content = (
      <Shelf
        view={snapshot.fallback}
        notice={snapshot.message}
        onCreate={createNotebook}
        onOpen={openNotebook}
        onBind={bindNotebook}
        onCreateProjectAndBind={createProjectAndBind}
        backupPanel={<WorkspaceBackupPanel />}
      />
    );
  } else if (snapshot.view.kind === "shelf") {
    content = (
      <Shelf
        view={snapshot.view}
        notice={snapshot.view.notice}
        onCreate={createNotebook}
        onOpen={openNotebook}
        onBind={bindNotebook}
        onCreateProjectAndBind={createProjectAndBind}
        backupPanel={<WorkspaceBackupPanel />}
      />
    );
  } else {
    content = (
      <FocusedNotebook
        view={snapshot.view}
        pageStorage={runtime.pageStorage}
        projectStorage={runtime.projectStorage}
        onBack={showShelf}
      />
    );
  }

  return <div data-desk-host>{content}</div>;
}
