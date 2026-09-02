import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createNotebookId } from "../../../../src/domain";
import { DeskDocument } from "../../../../src/entries/desk/DeskDocument";

const harness = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    snapshot: {
      status: "loading",
      requestedPlace: { kind: "shelf" },
    } as unknown,
  };
  const controller = {
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    getSnapshot: vi.fn(() => state.snapshot),
    start: vi.fn(async () => undefined),
    refreshProjectAssignments: vi.fn(async () => undefined),
    cleanup: vi.fn(async () => undefined),
    createNotebook: vi.fn(async () => ({ ok: true, value: {} })),
    openNotebook: vi.fn(async () => undefined),
    showShelf: vi.fn(),
    bindNotebookToProject: vi.fn(async () => ({ ok: true, value: {} })),
    createProjectAndBindNotebook: vi.fn(async () => ({ ok: true, value: {} })),
  };
  const runtime = {
    controller,
    pageStorage: {},
    projectStorage: {},
    canvasSnapshotStore: {},
    cleanup: controller.cleanup,
  };
  return {
    listeners,
    state,
    controller,
    runtime,
    createRuntime: vi.fn(() => runtime),
    registerOfflineShell: vi.fn(async () => ({ status: "registered" })),
    shelfProps: null as Record<string, unknown> | null,
    focusedProps: null as Record<string, unknown> | null,
  };
});

vi.mock("../../../../src/runtime", () => ({
  createBrowserWorkspaceRuntime: harness.createRuntime,
}));

vi.mock("../../../../src/pwa/offline-shell", () => ({
  registerOfflineShell: harness.registerOfflineShell,
}));

vi.mock("../../../../src/entries/desk/Shelf", () => ({
  Shelf: (props: Record<string, unknown>) => {
    harness.shelfProps = props;
    const onOpen = props.onOpen;
    const onCreate = props.onCreate;
    const onBind = props.onBind;
    const onCreateProjectAndBind = props.onCreateProjectAndBind;
    return (
      <section data-testid="desk-shelf">
        <button type="button" onClick={() => typeof onOpen === "function" && onOpen(createNotebookId("opened"))}>
          Open mocked notebook
        </button>
        <button type="button" onClick={() => typeof onCreate === "function" && void onCreate({ title: "Created", subject: "Subject" })}>
          Create mocked notebook
        </button>
        <button type="button" onClick={() => typeof onBind === "function" && void onBind(createNotebookId("bound"), "project:bound")}>
          Bind mocked notebook
        </button>
        <button type="button" onClick={() => typeof onCreateProjectAndBind === "function" && void onCreateProjectAndBind(createNotebookId("created-bound"), { projectId: "project:new", name: "New project" })}>
          Create and bind mocked notebook
        </button>
      </section>
    );
  },
}));

vi.mock("../../../../src/entries/desk/FocusedNotebook", () => ({
  FocusedNotebook: (props: Record<string, unknown>) => {
    harness.focusedProps = props;
    const onBack = props.onBack;
    return (
      <section data-testid="desk-focused">
        <button type="button" onClick={() => typeof onBack === "function" && onBack()}>
          Back to mocked shelf
        </button>
      </section>
    );
  },
}));

afterEach(() => {
  cleanup();
  harness.listeners.clear();
  harness.state.snapshot = {
    status: "loading",
    requestedPlace: { kind: "shelf" },
  };
  harness.controller.start.mockClear();
  harness.controller.refreshProjectAssignments.mockClear();
  harness.controller.cleanup.mockClear();
  harness.registerOfflineShell.mockClear();
  harness.shelfProps = null;
  harness.focusedProps = null;
});

function publish(snapshot: unknown): void {
  harness.state.snapshot = snapshot;
  for (const listener of harness.listeners) listener();
}

describe("DeskDocument", () => {
  it("starts the controller and offline shell after mounting, then cleans up and removes its change listener", async () => {
    const addEventListener = vi.spyOn(document, "addEventListener");
    const removeEventListener = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(<DeskDocument />);

    expect(screen.getByText("Opening your desk…")).toBeVisible();
    await waitFor(() => {
      expect(harness.controller.start).toHaveBeenCalledOnce();
      expect(harness.registerOfflineShell).toHaveBeenCalledOnce();
    });
    expect(addEventListener).toHaveBeenCalledWith(
      "project-notebook-workspace-changed",
      expect.any(Function),
    );

    document.dispatchEvent(new Event("project-notebook-workspace-changed"));
    expect(harness.controller.refreshProjectAssignments).toHaveBeenCalledOnce();

    unmount();
    await waitFor(() => expect(harness.controller.cleanup).toHaveBeenCalledOnce());
    expect(removeEventListener).toHaveBeenCalledWith(
      "project-notebook-workspace-changed",
      expect.any(Function),
    );
    addEventListener.mockRestore();
    removeEventListener.mockRestore();
  });

  it("renders failed, shelf, and focused snapshots with the correct callback wiring", async () => {
    render(<DeskDocument />);
    await waitFor(() => expect(harness.controller.start).toHaveBeenCalledOnce());

    const inbox = { kind: "notebook", id: createNotebookId("inbox"), title: "Inbox", subject: "Quick notes" };
    const shelf = {
      kind: "shelf",
      inbox,
      notebooks: [],
      notice: null,
    };
    await act(async () => {
      publish({ status: "failed", fallback: shelf, message: "Could not open the desk." });
    });
    expect(screen.getByTestId("desk-shelf")).toBeVisible();
    expect(harness.shelfProps?.notice).toBe("Could not open the desk.");

    await act(async () => {
      publish({ status: "ready", view: shelf });
    });
    expect(screen.getByTestId("desk-shelf")).toBeVisible();
    expect(harness.shelfProps?.notice).toBeNull();

    const notebook = { ...inbox, id: createNotebookId("focused"), title: "Focused" };
    await act(async () => {
      publish({ status: "ready", view: { kind: "notebook", notebook } });
    });
    expect(screen.getByTestId("desk-focused")).toBeVisible();
    expect(harness.focusedProps?.pageStorage).toBe(harness.runtime.pageStorage);
    expect(harness.focusedProps?.projectStorage).toBe(harness.runtime.projectStorage);

    fireEvent.click(screen.getByRole("button", { name: "Back to mocked shelf" }));
    expect(harness.controller.showShelf).toHaveBeenCalledOnce();
  });

  it("delegates shelf actions to the controller", async () => {
    render(<DeskDocument />);
    await waitFor(() => expect(harness.controller.start).toHaveBeenCalledOnce());
    await act(async () => {
      publish({
        status: "ready",
        view: {
          kind: "shelf",
          inbox: { kind: "notebook", id: createNotebookId("inbox"), title: "Inbox", subject: "Quick notes" },
          notebooks: [],
          notice: null,
        },
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Open mocked notebook" }));
    fireEvent.click(screen.getByRole("button", { name: "Create mocked notebook" }));
    fireEvent.click(screen.getByRole("button", { name: "Bind mocked notebook" }));
    fireEvent.click(screen.getByRole("button", { name: "Create and bind mocked notebook" }));

    expect(harness.controller.openNotebook).toHaveBeenCalledWith(createNotebookId("opened"));
    expect(harness.controller.createNotebook).toHaveBeenCalledWith({ title: "Created", subject: "Subject" });
    expect(harness.controller.bindNotebookToProject).toHaveBeenCalledWith(
      createNotebookId("bound"),
      "project:bound",
    );
    expect(harness.controller.createProjectAndBindNotebook).toHaveBeenCalledWith(
      createNotebookId("created-bound"),
      { projectId: "project:new", name: "New project" },
    );
    await act(async () => undefined);
  });
});
