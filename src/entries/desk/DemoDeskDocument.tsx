"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { createDemoWorkspaceRuntime, type DemoWorkspaceRuntime } from "../../demo/session-runtime";
import { registerDemoDeskWebMcpTools } from "../../demo/webmcp-workspace-tools";
import {
  INITIAL_WORKSPACE_SNAPSHOT,
  type CreateNotebookInput,
  type NotebookCoverViewModel,
  type WorkspaceResult,
} from "../../workspace/model";
import { FocusedNotebook } from "./FocusedNotebook";
import { Shelf } from "./Shelf";

export function DemoDeskDocument(): React.JSX.Element {
  const [runtime] = useState<DemoWorkspaceRuntime>(createDemoWorkspaceRuntime);
  const snapshot = useSyncExternalStore(
    runtime.controller.subscribe,
    runtime.controller.getSnapshot,
    () => INITIAL_WORKSPACE_SNAPSHOT,
  );

  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => {
      if (mounted) void runtime.controller.start();
    });
    return () => {
      mounted = false;
      void runtime.cleanup();
    };
  }, [runtime]);

  useEffect(() => {
    void registerDemoDeskWebMcpTools(document.modelContext, runtime.controller, runtime.session.pageStorage).catch(() => undefined);
  }, [runtime]);

  const createNotebook = useCallback(
    (input: CreateNotebookInput): Promise<WorkspaceResult<NotebookCoverViewModel>> =>
      runtime.controller.createNotebook(input),
    [runtime],
  );
  const openNotebook = useCallback((notebookId: NotebookCoverViewModel["id"]): void => {
    void runtime.controller.openNotebook(notebookId);
  }, [runtime]);
  const showShelf = useCallback((): void => runtime.controller.showShelf(), [runtime]);

  let content: React.JSX.Element;
  if (snapshot.status === "loading") {
    content = <main className="desk-loading" aria-busy="true"><p>Opening the temporary desk…</p></main>;
  } else if (snapshot.status === "failed") {
    content = (
      <Shelf
        view={snapshot.fallback}
        notice={snapshot.message}
        allowCreation={false}
        onCreate={createNotebook}
        onOpen={openNotebook}
      />
    );
  } else if (snapshot.view.kind === "shelf") {
    content = (
      <Shelf
        view={snapshot.view}
        notice={snapshot.view.notice}
        allowCreation={false}
        onCreate={createNotebook}
        onOpen={openNotebook}
      />
    );
  } else {
    content = (
      <FocusedNotebook
        view={snapshot.view}
        pageStorage={runtime.session.pageStorage}
        demoSession={runtime.session}
        onBack={showShelf}
      />
    );
  }

  return (
    <div data-desk-host data-demo-session-only="true">
      {content}
    </div>
  );
}
