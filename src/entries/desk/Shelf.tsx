"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import type {
  CreateNotebookInput,
  NotebookCoverViewModel,
  ShelfViewModel,
  WorkspaceResult,
} from "../../workspace/model";
import type { ProjectId } from "../../projects";

import { coverToneFor } from "./cover-templates";

export type ShelfProps = {
  readonly view: ShelfViewModel;
  readonly notice: string | null;
  readonly allowCreation?: boolean;
  readonly onCreate: (
    input: CreateNotebookInput,
  ) => Promise<WorkspaceResult<NotebookCoverViewModel>>;
  readonly onOpen: (notebookId: NotebookCoverViewModel["id"]) => void;
  readonly onBind?: (
    notebookId: NotebookCoverViewModel["id"],
    projectId: ProjectId,
  ) => Promise<WorkspaceResult<unknown>>;
  readonly onCreateProjectAndBind?: (
    notebookId: NotebookCoverViewModel["id"],
    input: Readonly<{ projectId: string; name: string }>,
  ) => Promise<WorkspaceResult<unknown>>;
  readonly backupPanel?: ReactNode;
};

export function Shelf({
  view,
  notice,
  allowCreation = true,
  onCreate,
  onOpen,
  onBind,
  onCreateProjectAndBind,
  backupPanel,
}: ShelfProps): React.JSX.Element {
  const [creationOpen, setCreationOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [bindingNotebook, setBindingNotebook] = useState<NotebookCoverViewModel | null>(null);
  const [bindingProjectId, setBindingProjectId] = useState<ProjectId | null>(null);
  const [binding, setBinding] = useState(false);
  const [bindingError, setBindingError] = useState<string | null>(null);
  const [newProjectId, setNewProjectId] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const bindingDialogRef = useRef<HTMLDialogElement | null>(null);
  const creationOpenerRef = useRef<HTMLButtonElement | null>(null);
  const bindingOpenerRef = useRef<HTMLButtonElement | null>(null);
  const userNotebooks = view.userNotebooks ?? view.notebooks.filter((notebook) => notebook.shelfKind !== "agent");
  const agentNotebooks = view.agentNotebooks ?? view.notebooks.filter((notebook) => notebook.shelfKind === "agent");
  const projects = view.projects ?? [];

  useEffect(() => {
    const dialog = dialogRef.current;
    if (creationOpen && dialog !== null && !dialog.open) {
      dialog.showModal();
      const titleInput = dialog.querySelector<HTMLInputElement>(
        "#new-notebook-title",
      );
      titleInput?.focus();
    }
    if (!creationOpen) {
      const opener = creationOpenerRef.current;
      if (opener !== null && opener.isConnected) opener.focus();
      creationOpenerRef.current = null;
    }
    return () => {
      if (dialog !== null && dialog.open) {
        dialog.close();
      }
    };
  }, [creationOpen]);

  useEffect(() => {
    const dialog = bindingDialogRef.current;
    if (bindingNotebook !== null && dialog !== null && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLSelectElement>("select")?.focus();
    }
    if (bindingNotebook === null) {
      const opener = bindingOpenerRef.current;
      if (opener !== null && opener.isConnected) opener.focus();
      bindingOpenerRef.current = null;
    }
    return () => {
      if (dialog !== null && dialog.open) dialog.close();
    };
  }, [bindingNotebook]);

  const openCreation = (event: MouseEvent<HTMLButtonElement>): void => {
    creationOpenerRef.current = event.currentTarget;
    setTitle("");
    setSubject("");
    setFormError(null);
    setCreationOpen(true);
  };

  const closeCreation = (): void => {
    if (!submitting) {
      setCreationOpen(false);
      setFormError(null);
    }
  };

  const submitCreation = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      const result = await onCreate({ title, subject });
      if (!result.ok) {
        setFormError(result.issue.message);
        return;
      }
      setCreationOpen(false);
    } catch {
      setFormError("The notebook could not be created. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const openBinding = (
    notebook: NotebookCoverViewModel,
    event: MouseEvent<HTMLButtonElement>,
  ): void => {
    bindingOpenerRef.current = event.currentTarget;
    setBindingNotebook(notebook);
    setBindingProjectId(projects[0]?.id ?? null);
    setBindingError(null);
    setNewProjectId("");
    setNewProjectName("");
  };

  const closeBinding = (): void => {
    if (binding) return;
    setBindingNotebook(null);
    setBindingProjectId(null);
    setBindingError(null);
  };

  const submitBinding = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (bindingNotebook === null || bindingProjectId === null || onBind === undefined) return;
    setBinding(true);
    setBindingError(null);
    try {
      const result = await onBind(bindingNotebook.id, bindingProjectId);
      if (!result.ok) {
        setBindingError(result.issue.message);
        return;
      }
      setBindingNotebook(null);
    } catch {
      setBindingError("The notebook could not be bound. Try again.");
    } finally {
      setBinding(false);
    }
  };

  const createProjectAndBind = async (): Promise<void> => {
    if (
      bindingNotebook === null ||
      onCreateProjectAndBind === undefined ||
      newProjectId.trim().length === 0 ||
      newProjectName.trim().length === 0
    ) return;
    setBinding(true);
    setBindingError(null);
    try {
      const result = await onCreateProjectAndBind(bindingNotebook.id, {
        projectId: newProjectId.trim(),
        name: newProjectName.trim(),
      });
      if (!result.ok) {
        setBindingError(result.issue.message);
        return;
      }
      setBindingNotebook(null);
    } catch {
      setBindingError("The project could not be created and bound. Try again.");
    } finally {
      setBinding(false);
    }
  };

  return (
    <main className="shelf-desk" data-testid="notebook-shelf">
      <header className="shelf-heading">
        <div>
          <p className="desk-kicker">Project Notebook</p>
          <h1>Notebook shelf</h1>
        </div>
        <p className="shelf-order">In the order you added them</p>
      </header>

      {notice === null ? null : (
        <p className="desk-notice" role="alert">
          {notice}
        </p>
      )}

      <section className="shelf-rail" data-phase11-shelf="user" aria-labelledby="user-notebooks-heading">
        <h2 id="user-notebooks-heading">Your notebooks</h2>
        <ul className="cover-grid" aria-label="Your notebooks">
        <li>
          <button
            className="composition-cover composition-cover--inbox"
            type="button"
            aria-label="Open Inbox notebook"
            onClick={() => onOpen(view.inbox.id)}
            data-testid="inbox-cover"
          >
            <span className="cover-label">Inbox</span>
            <span className="cover-caption">Quick notes</span>
          </button>
        </li>
        {userNotebooks.map((notebook) => (
          <li key={notebook.id}>
            <button
              className={`composition-cover composition-cover--${coverToneFor(notebook.id)}`}
              type="button"
              aria-label={`Open ${notebook.title} notebook`}
              data-workbook-id={notebook.id}
              onClick={() => onOpen(notebook.id)}
            >
              <span className="cover-label">{notebook.title}</span>
            </button>
            {notebook.projectBinding !== undefined && notebook.projectBinding.kind !== "unbound" ? (
              <span className="project-stamp" data-phase11-project-id={notebook.projectBinding.projectId}>
                {notebook.projectBinding.projectName}
              </span>
            ) : onBind !== undefined && onCreateProjectAndBind !== undefined ? (
              <button
                className="project-bind-trigger"
                type="button"
                aria-haspopup="dialog"
                onClick={(event) => openBinding(notebook, event)}
              >
                Bind {notebook.title} to project
              </button>
            ) : null}
          </li>
        ))}
        {allowCreation ? <li>
          <button
            className="composition-cover composition-cover--create"
            type="button"
            aria-haspopup="dialog"
            onClick={openCreation}
            data-testid="create-notebook-cover"
          >
            <span className="create-mark" aria-hidden="true">+</span>
            <span className="create-label">New notebook</span>
          </button>
        </li> : null}
        </ul>
      </section>

      <section className="shelf-rail shelf-rail--agent" data-phase11-shelf="agent" aria-labelledby="agent-workbooks-heading">
        <h2 id="agent-workbooks-heading">Agent Workbooks</h2>
        {agentNotebooks.length === 0 ? <p className="shelf-rail-empty">Assigned agents will share their project workbook here.</p> : null}
        <ul className="cover-grid cover-grid--agent" aria-label="Agent Workbooks">
          {agentNotebooks.map((notebook) => (
            <li key={notebook.id}>
              <button
                className={`composition-cover composition-cover--${coverToneFor(notebook.id)}`}
                type="button"
                aria-label={`Open ${notebook.title} Agent Workbook`}
                data-workbook-id={notebook.id}
                onClick={() => onOpen(notebook.id)}
              >
                <span className="cover-label">{notebook.title}</span>
                <span className="cover-caption">Agent Workbook</span>
                <span
                  className="project-stamp"
                  data-phase11-project-id={notebook.projectId}
                >
                  {notebook.projectBinding?.kind === "agent"
                    ? notebook.projectBinding.projectName
                    : "Assigned project"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {backupPanel}

      {creationOpen ? (
        <dialog
          ref={dialogRef}
          className="creation-dialog"
          aria-labelledby="creation-title"
          onCancel={(event) => {
            event.preventDefault();
            closeCreation();
          }}
          data-testid="create-notebook-dialog"
        >
          <form onSubmit={(event) => void submitCreation(event)}>
            <div className="creation-heading">
              <div>
                <p className="desk-kicker">Blank cover</p>
                <h2 id="creation-title">Name your notebook</h2>
              </div>
              <button
                className="quiet-icon-button"
                type="button"
                aria-label="Close new notebook"
                onClick={closeCreation}
                disabled={submitting}
              >
                ×
              </button>
            </div>
            <label htmlFor="new-notebook-title">Title</label>
            <input
              id="new-notebook-title"
              name="title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={120}
              required
              autoFocus
            />
            <label htmlFor="new-notebook-subject">Subject</label>
            <textarea
              id="new-notebook-subject"
              name="subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              maxLength={240}
              rows={3}
              required
            />
            {formError === null ? null : (
              <p className="creation-error" role="alert">{formError}</p>
            )}
            <button className="create-submit" type="submit" disabled={submitting}>
              {submitting ? "Making the cover…" : "Create notebook"}
            </button>
          </form>
        </dialog>
      ) : null}

      {bindingNotebook === null ? null : (
        <dialog
          ref={bindingDialogRef}
          className="creation-dialog"
          aria-labelledby="binding-title"
          onCancel={(event) => {
            event.preventDefault();
            closeBinding();
          }}
        >
          <form onSubmit={(event) => void submitBinding(event)}>
            <div className="creation-heading">
              <div>
                <p className="desk-kicker">Explicit assignment</p>
                <h2 id="binding-title">Bind {bindingNotebook.title} to a project</h2>
              </div>
              <button className="quiet-icon-button" type="button" aria-label="Close project binding" onClick={closeBinding} disabled={binding}>×</button>
            </div>
            {projects.length === 0 ? (
              <p>No existing projects are available.</p>
            ) : (
              <label>
                Project
                <select
                  value={bindingProjectId ?? ""}
                  onChange={(event) => {
                    const project = projects.find((candidate) => candidate.id === event.currentTarget.value);
                    setBindingProjectId(project?.id ?? null);
                  }}
                >
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </label>
            )}
            {bindingError === null ? null : <p className="creation-error" role="alert">{bindingError}</p>}
            <button className="create-submit" type="submit" disabled={binding || bindingProjectId === null || onBind === undefined}>
              {binding ? "Binding…" : "Bind to project"}
            </button>
            <fieldset className="project-create-binding">
              <legend>Create a project and bind this notebook</legend>
              <label>
                Stable project ID
                <input
                  value={newProjectId}
                  maxLength={180}
                  onChange={(event) => setNewProjectId(event.currentTarget.value)}
                  placeholder="project:field-notes"
                />
              </label>
              <label>
                Project name
                <input
                  value={newProjectName}
                  maxLength={120}
                  onChange={(event) => setNewProjectName(event.currentTarget.value)}
                />
              </label>
              <button
                type="button"
                onClick={() => void createProjectAndBind()}
                disabled={binding || onCreateProjectAndBind === undefined || newProjectId.trim().length === 0 || newProjectName.trim().length === 0}
              >
                Create project and bind
              </button>
            </fieldset>
          </form>
        </dialog>
      )}
    </main>
  );
}
