import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FIXTURE,
  SELECTORS,
} from "../../helpers/phase11-contracts";
import { createNotebookId } from "../../../src/domain";
import { FocusedNotebook } from "../../../src/entries/desk/FocusedNotebook";
import { Shelf } from "../../../src/entries/desk/Shelf";
import type {
  FocusedNotebookViewModel,
  NotebookCoverViewModel,
  ShelfViewModel,
  WorkspaceResult,
} from "../../../src/workspace/model";

const notebookHostCapture = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
}));

vi.mock("../../../src/entries/desk/NotebookEditorHost", () => ({
  NotebookEditorHost: (props: Record<string, unknown>) => {
    notebookHostCapture.props = props;
    return <div data-testid="phase11-notebook-editor-host" />;
  },
}));

afterEach(() => {
  cleanup();
  notebookHostCapture.props = null;
});

function cover(
  id: string,
  title: string,
  subject: string,
  extras: Readonly<Record<string, unknown>> = {},
): NotebookCoverViewModel {
  return {
    kind: "notebook",
    id: createNotebookId(id),
    title,
    subject,
    ...extras,
  } as unknown as NotebookCoverViewModel;
}

function createResult(
  notebook: NotebookCoverViewModel,
): WorkspaceResult<NotebookCoverViewModel> {
  return { ok: true, value: notebook };
}

function okResult(): WorkspaceResult<unknown> {
  return { ok: true, value: null };
}

function renderShelf() {
  const view = {
    kind: "shelf",
    inbox: cover("inbox", "Inbox", "Quick notes"),
    notebooks: [
      cover(
        FIXTURE.userWorkbookId,
        "Legacy field notebook",
        "Populated version 3 acceptance",
        { projectBinding: { kind: "unbound" } },
      ),
      cover(
        "phase11:workbook:agent",
        "Accepted project direction",
        "Project work",
        {
          shelfKind: "agent",
          projectId: FIXTURE.projectId,
        },
      ),
    ],
    notice: null,
  } as unknown as ShelfViewModel;
  const onCreate = vi.fn<
    (input: { title: string; subject: string }) => Promise<WorkspaceResult<NotebookCoverViewModel>>
  >(async ({ title, subject }) => createResult(cover(`created:${title}`, title, subject)));
  const onOpen = vi.fn();
  return render(
    <Shelf
      view={view}
      notice={null}
      onCreate={onCreate}
      onOpen={onOpen}
      onBind={vi.fn(async () => okResult())}
      onCreateProjectAndBind={vi.fn(async () => okResult())}
    />,
  );
}

describe("Phase 11 desk UI integration", () => {
  it("renders distinct user and Agent Workbook shelf rails in reading order and stamps agent workbooks with the project id", () => {
    const { container } = renderShelf();
    const userShelf = container.querySelector<HTMLElement>(SELECTORS.userShelf);
    const agentShelf = container.querySelector<HTMLElement>(SELECTORS.agentShelf);

    if (userShelf === null || agentShelf === null) {
      throw new Error("The shelf must render separate user and Agent Workbook rails.");
    }

    expect(userShelf.compareDocumentPosition(agentShelf) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(userShelf).getByText("Legacy field notebook", { exact: true })).toBeVisible();
    expect(within(userShelf).getByRole("button", { name: /^New notebook$/ })).toBeVisible();
    expect(within(agentShelf).getByRole("heading", { name: /^Agent Workbooks$/ })).toBeVisible();
    expect(
      agentShelf.querySelector(
        `${SELECTORS.projectStamp}[data-phase11-project-id="${FIXTURE.projectId}"]`,
      ),
    ).not.toBeNull();
  });

  it("keeps legacy user notebooks unbound until a person uses an explicit project-binding affordance", () => {
    renderShelf();

    expect(screen.getByText("Legacy field notebook", { exact: true })).toBeVisible();
    expect(screen.getByRole("button", { name: /bind .*project/i })).toBeVisible();
  });

  it("passes project storage into the focused notebook host for project-bound workbooks", () => {
    const projectStorage = {
      bindUserWorkbook: vi.fn(),
      listItems: vi.fn(),
    };
    const view = {
      kind: "notebook",
      notebook: cover(
        FIXTURE.userWorkbookId,
        "Legacy field notebook",
        "Populated version 3 acceptance",
        {
          projectId: FIXTURE.projectId,
          workbookIdentity: {
            kind: "user",
            workbookId: FIXTURE.userWorkbookId,
            projectId: FIXTURE.projectId,
          },
        },
      ),
    } as unknown as FocusedNotebookViewModel;
    const FocusedNotebookAny = FocusedNotebook as unknown as (props: Record<string, unknown>) => React.JSX.Element;

    render(
      <FocusedNotebookAny
        view={view}
        pageStorage={{}}
        projectStorage={projectStorage}
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByTestId("phase11-notebook-editor-host")).toBeVisible();
    expect(notebookHostCapture.props).toMatchObject({
      notebook: expect.objectContaining({ id: createNotebookId(FIXTURE.userWorkbookId) }),
      projectStorage,
    });
  });
});
