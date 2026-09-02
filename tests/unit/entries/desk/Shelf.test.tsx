import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNotebookId } from "../../../../src/domain";
import { createProjectId, createProjectWorkbookId } from "../../../../src/projects";
import { Shelf } from "../../../../src/entries/desk/Shelf";
import type {
  NotebookCoverViewModel,
  ShelfViewModel,
  WorkspaceResult,
} from "../../../../src/workspace/model";

afterEach(cleanup);

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
});

function notebook(id: string, title = id): NotebookCoverViewModel {
  return {
    kind: "notebook",
    id: createNotebookId(id),
    title,
    subject: `${title} subject`,
  };
}

function shelfView(
  notebooks: readonly NotebookCoverViewModel[] = [],
  projects: ShelfViewModel["projects"] = [],
): ShelfViewModel {
  return {
    kind: "shelf",
    inbox: notebook("inbox", "Inbox"),
    notebooks,
    projects,
    notice: null,
  };
}

function okResult(): WorkspaceResult<unknown> {
  return { ok: true, value: null };
}

function notebookResult(value: NotebookCoverViewModel): WorkspaceResult<NotebookCoverViewModel> {
  return { ok: true, value };
}

function errorResult(message: string): WorkspaceResult<unknown> {
  return { ok: false, issue: { kind: "unavailable", message } };
}

function notebookErrorResult(message: string): WorkspaceResult<NotebookCoverViewModel> {
  return { ok: false, issue: { kind: "unavailable", message } };
}

describe("Shelf", () => {
  it("keeps user and agent rails separate, shows empty-agent copy, and uses deterministic cover tones", () => {
    const user = notebook("a", "Field notes");
    const agent = {
      ...notebook("b", "Agent brief"),
      shelfKind: "agent" as const,
      projectId: createProjectId("project:brief"),
      projectBinding: {
        kind: "agent" as const,
        workbookId: createProjectWorkbookId("workbook:brief"),
        projectId: createProjectId("project:brief"),
        projectName: "Brief project",
      },
    };
    const onOpen = vi.fn<(id: NotebookCoverViewModel["id"]) => void>();

    const { container } = render(
      <Shelf
        view={shelfView([user, agent])}
        notice="The last desk load was repaired."
        onCreate={vi.fn(async () => notebookResult(user))}
        onOpen={onOpen}
        backupPanel={<div data-testid="workspace-backup-panel" />}
      />,
    );

    const userRail = container.querySelector<HTMLElement>('[data-phase11-shelf="user"]');
    const agentRail = container.querySelector<HTMLElement>('[data-phase11-shelf="agent"]');
    if (userRail === null || agentRail === null) throw new Error("Expected both shelf rails.");

    expect(within(userRail).getByRole("heading", { name: "Your notebooks" })).toBeVisible();
    expect(within(userRail).getByRole("button", { name: "Open Field notes notebook" })).toHaveClass("composition-cover--navy");
    expect(within(userRail).queryByText("Composition book", { exact: false })).not.toBeInTheDocument();
    expect(within(agentRail).getByRole("button", { name: "Open Agent brief Agent Workbook" })).toHaveClass("composition-cover--claret");
    expect(within(agentRail).getByText("Brief project")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("The last desk load was repaired.");
    expect(screen.getByTestId("workspace-backup-panel")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Open Inbox notebook" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Field notes notebook" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Agent brief Agent Workbook" }));
    expect(onOpen.mock.calls.map(([id]) => id)).toEqual([
      createNotebookId("inbox"),
      createNotebookId("a"),
      createNotebookId("b"),
    ]);
  });

  it("renders the empty agent rail without an agent cover", () => {
    render(
      <Shelf
        view={shelfView([notebook("user", "User notebook")])}
        notice={null}
        onCreate={vi.fn(async () => notebookResult(notebook("created")))}
        onOpen={vi.fn()}
      />,
    );

    const agentRail = screen.getByRole("heading", { name: "Agent Workbooks" }).closest("section");
    if (agentRail === null) throw new Error("Expected the agent rail.");
    expect(within(agentRail).getByText("Assigned agents will share their project workbook here.")).toBeVisible();
    expect(within(agentRail).queryByRole("button")).not.toBeInTheDocument();
  });

  it("submits notebook creation and exposes a returned failure while clearing busy state", async () => {
    const onCreate = vi.fn(async () => notebookErrorResult("A notebook with that title already exists."));
    render(
      <Shelf
        view={shelfView()}
        notice={null}
        onCreate={onCreate}
        onOpen={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New notebook" }));
    const dialog = screen.getByRole("dialog", { name: "Name your notebook" });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "  Field notes  " } });
    fireEvent.change(within(dialog).getByLabelText("Subject"), { target: { value: "A subject" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create notebook" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ title: "  Field notes  ", subject: "A subject" }));
    expect(screen.getByRole("alert")).toHaveTextContent("A notebook with that title already exists.");
    expect(within(dialog).getByRole("button", { name: "Create notebook" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Close new notebook" })).toBeEnabled();
  });

  it("recovers notebook creation controls when the request rejects", async () => {
    const onCreate = vi.fn(async () => {
      throw new Error("storage unavailable");
    });
    render(
      <Shelf
        view={shelfView()}
        notice={null}
        onCreate={onCreate}
        onOpen={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New notebook" }));
    const dialog = screen.getByRole("dialog", { name: "Name your notebook" });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Field notes" } });
    fireEvent.change(within(dialog).getByLabelText("Subject"), { target: { value: "A subject" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create notebook" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The notebook could not be created. Try again."));
    expect(within(dialog).getByRole("button", { name: "Create notebook" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Close new notebook" })).toBeEnabled();
  });

  it("returns focus to the New notebook cover after closing the creation dialog", async () => {
    render(
      <Shelf
        view={shelfView()}
        notice={null}
        onCreate={vi.fn(async () => notebookResult(notebook("created")))}
        onOpen={vi.fn()}
      />,
    );

    const opener = screen.getByRole("button", { name: "New notebook" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Name your notebook" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close new notebook" }));

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it("closes a successfully created notebook dialog and returns focus to its opener", async () => {
    const onCreate = vi.fn(async () => notebookResult(notebook("created", "Field notes")));
    render(
      <Shelf
        view={shelfView()}
        notice={null}
        onCreate={onCreate}
        onOpen={vi.fn()}
      />,
    );

    const opener = screen.getByRole("button", { name: "New notebook" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Name your notebook" });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Field notes" } });
    fireEvent.change(within(dialog).getByLabelText("Subject"), { target: { value: "A subject" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create notebook" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it("binds an existing project and closes the dialog after success", async () => {
    const candidate = notebook("unbound", "Unbound notes");
    const projectId = createProjectId("project:field");
    const onBind = vi.fn(async () => okResult());
    render(
      <Shelf
        view={shelfView([candidate], [{ id: projectId, name: "Field project" }])}
        notice={null}
        onCreate={vi.fn(async () => notebookResult(candidate))}
        onOpen={vi.fn()}
        onBind={onBind}
        onCreateProjectAndBind={vi.fn(async () => okResult())}
      />,
    );

    const opener = screen.getByRole("button", { name: "Bind Unbound notes to project" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Bind Unbound notes to a project" });
    expect(within(dialog).getByRole("combobox")).toHaveValue(projectId);
    fireEvent.click(within(dialog).getByRole("button", { name: "Bind to project" }));

    await waitFor(() => expect(onBind).toHaveBeenCalledWith(createNotebookId("unbound"), projectId));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Bind Unbound notes to a project" })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it("returns focus to the exact project-binding opener after a native cancel", async () => {
    const first = notebook("first", "First notes");
    const second = notebook("second", "Second notes");
    const projectId = createProjectId("project:focus");
    render(
      <Shelf
        view={shelfView([first, second], [{ id: projectId, name: "Focus project" }])}
        notice={null}
        onCreate={vi.fn(async () => notebookResult(first))}
        onOpen={vi.fn()}
        onBind={vi.fn(async () => okResult())}
        onCreateProjectAndBind={vi.fn(async () => okResult())}
      />,
    );

    const opener = screen.getByRole("button", { name: "Bind Second notes to project" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Bind Second notes to a project" });
    fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it("reports binding failures and prevents closing while the request is pending", async () => {
    const candidate = notebook("pending", "Pending notes");
    let resolve: ((result: WorkspaceResult<unknown>) => void) | undefined;
    const onBind = vi.fn(() => new Promise<WorkspaceResult<unknown>>((complete) => { resolve = complete; }));
    const projectId = createProjectId("project:pending");
    render(
      <Shelf
        view={shelfView([candidate], [{ id: projectId, name: "Pending project" }])}
        notice={null}
        onCreate={vi.fn(async () => notebookResult(candidate))}
        onOpen={vi.fn()}
        onBind={onBind}
        onCreateProjectAndBind={vi.fn(async () => okResult())}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Bind Pending notes to project" }));
    const dialog = screen.getByRole("dialog", { name: "Bind Pending notes to a project" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Bind to project" }));
    await waitFor(() => expect(onBind).toHaveBeenCalledOnce());
    expect(within(dialog).getByRole("button", { name: "Binding…" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Close project binding" })).toBeDisabled();

    resolve?.(errorResult("Project binding failed."));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Project binding failed."));
    expect(within(dialog).getByRole("button", { name: "Bind to project" })).toBeEnabled();
  });

  it("recovers project-binding controls when the request rejects", async () => {
    const candidate = notebook("rejected", "Rejected notes");
    const projectId = createProjectId("project:rejected");
    const onBind = vi.fn(async () => {
      throw new Error("storage unavailable");
    });
    render(
      <Shelf
        view={shelfView([candidate], [{ id: projectId, name: "Rejected project" }])}
        notice={null}
        onCreate={vi.fn(async () => notebookResult(candidate))}
        onOpen={vi.fn()}
        onBind={onBind}
        onCreateProjectAndBind={vi.fn(async () => okResult())}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Bind Rejected notes to project" });
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Bind Rejected notes to a project" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Bind to project" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The notebook could not be bound. Try again."));
    expect(within(dialog).getByRole("button", { name: "Bind to project" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Close project binding" })).toBeEnabled();
  });

  it("trims create-and-bind fields and disables the action until both fields are present", async () => {
    const candidate = notebook("new-project", "New project notes");
    const onCreateProjectAndBind = vi.fn(async () => okResult());
    render(
      <Shelf
        view={shelfView([candidate], [])}
        notice={null}
        onCreate={vi.fn(async () => notebookResult(candidate))}
        onOpen={vi.fn()}
        onBind={vi.fn(async () => okResult())}
        onCreateProjectAndBind={onCreateProjectAndBind}
      />,
    );

    const opener = screen.getByRole("button", { name: "Bind New project notes to project" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Bind New project notes to a project" });
    const submit = within(dialog).getByRole("button", { name: "Create project and bind" });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Stable project ID"), { target: { value: "  project:new  " } });
    fireEvent.change(within(dialog).getByLabelText("Project name"), { target: { value: "  New project  " } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => expect(onCreateProjectAndBind).toHaveBeenCalledWith(
      createNotebookId("new-project"),
      { projectId: "project:new", name: "New project" },
    ));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Bind New project notes to a project" })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });
});
