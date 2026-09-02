"use client";

import { useReducer } from "react";

import type { FocusedNotebookViewModel } from "../../workspace/model";
import type { IndexedDbProjectStorage, PageStorage } from "../../indexeddb";
import type { DemoSessionContext } from "../../demo/session-runtime";
import { NotebookEditorHost } from "./NotebookEditorHost";
import {
  INITIAL_NOTEBOOK_PAGE_STATE,
  reduceNotebookPageState,
} from "./notebook-page-state";

export type FocusedNotebookProps = {
  readonly view: FocusedNotebookViewModel;
  readonly pageStorage: PageStorage;
  readonly projectStorage?: IndexedDbProjectStorage;
  readonly demoSession?: DemoSessionContext;
  readonly onBack: () => void;
};

export function FocusedNotebook({
  view,
  pageStorage,
  projectStorage,
  demoSession,
  onBack,
}: FocusedNotebookProps): React.JSX.Element {
  return (
    <FocusedNotebookPage
      key={view.notebook.id}
      view={view}
      pageStorage={pageStorage}
      {...(projectStorage === undefined ? {} : { projectStorage })}
      {...(demoSession === undefined ? {} : { demoSession })}
      onBack={onBack}
    />
  );
}

function FocusedNotebookPage({
  view,
  pageStorage,
  projectStorage,
  demoSession,
  onBack,
}: FocusedNotebookProps): React.JSX.Element {
  const [pageState, dispatch] = useReducer(
    reduceNotebookPageState,
    demoSession === undefined
      ? INITIAL_NOTEBOOK_PAGE_STATE
      : { ...INITIAL_NOTEBOOK_PAGE_STATE, narrowMode: "overview" },
  );

  return (
    <main className="focused-desk" data-testid="focused-notebook" data-notebook-id={view.notebook.id}>
      <nav className="notebook-toolbar" aria-label="Notebook navigation">
        <button className="shelf-back" type="button" onClick={onBack}>
          <span aria-hidden="true">‹</span> Shelf
        </button>
        <div className="notebook-agent-heading">
          <strong>{view.notebook.title}</strong>
          <span>{view.notebook.subject}</span>
        </div>
        <span className="notebook-agent-mode">Agent controlled</span>
      </nav>

      <NotebookEditorHost
        notebook={view.notebook}
        pageStorage={pageStorage}
        {...(projectStorage === undefined ? {} : { projectStorage })}
        {...(demoSession === undefined ? {} : { demoSession })}
        state={pageState}
        onAction={dispatch}
      />
    </main>
  );
}
