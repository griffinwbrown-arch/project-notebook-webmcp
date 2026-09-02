import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceBackupPanel } from "../../../../src/entries/desk/WorkspaceBackupPanel";

const backupApi = vi.hoisted(() => ({
  value: {
    format: "project-notebook-workspace-backup",
    version: 1,
    databaseVersion: 4,
    exportedAt: "2026-08-30T13:14:15.000Z",
    stores: {},
  },
  create: vi.fn(),
  parse: vi.fn(),
  restore: vi.fn(async (): Promise<void> => {}),
  serialize: vi.fn(() => "{\"backup\":true}"),
}));

const backupValue = backupApi.value;
const nativeLocation = window.location;

vi.mock("../../../../src/indexeddb", () => ({
  createWorkspaceBackup: backupApi.create,
  parseWorkspaceBackupJson: backupApi.parse,
  restoreWorkspaceBackup: backupApi.restore,
  serializeWorkspaceBackup: backupApi.serialize,
}));

afterEach(() => {
  cleanup();
  if (window.location !== nativeLocation) {
    Object.defineProperty(window, "location", { configurable: true, value: nativeLocation });
  }
  vi.restoreAllMocks();
});

beforeEach(() => {
  backupApi.create.mockReset();
  backupApi.create.mockResolvedValue(backupValue);
  backupApi.parse.mockReset();
  backupApi.parse.mockReturnValue(backupValue);
  backupApi.restore.mockReset();
  backupApi.restore.mockResolvedValue(undefined);
  backupApi.serialize.mockReset();
  backupApi.serialize.mockReturnValue("{\"backup\":true}");
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(() => "blob:project-notebook"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

function fileInput(): HTMLInputElement {
  return screen.getByLabelText("Choose a Project Notebook backup") as HTMLInputElement;
}

describe("WorkspaceBackupPanel", () => {
  it("downloads a serialized backup with a timestamped filename and clears busy state", async () => {
    let resolveCreate: ((value: typeof backupValue) => void) | undefined;
    backupApi.create.mockImplementation(() => new Promise((resolve) => { resolveCreate = resolve; }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click");
    render(<WorkspaceBackupPanel />);

    const download = screen.getByRole("button", { name: "Download backup" });
    const restore = screen.getByRole("button", { name: "Restore backup" });
    fireEvent.click(download);
    expect(screen.getByRole("button", { name: "Preparing…" })).toBeDisabled();
    expect(restore).toBeDisabled();

    resolveCreate?.(backupValue);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Backup downloaded."));
    expect(backupApi.serialize).toHaveBeenCalledWith(backupValue);
    expect(click).toHaveBeenCalledOnce();
    expect(click.mock.instances[0]).toHaveProperty("href", "blob:project-notebook");
    expect(click.mock.instances[0]).toHaveProperty("download", "project-notebook-backup-2026-08-30T13-14-15.000Z.json");
    expect(screen.getByRole("button", { name: "Download backup" })).toBeEnabled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:project-notebook");
  });

  it.each([
    [new Error("Disk unavailable"), "Disk unavailable"],
    ["unexpected failure", "The backup could not be created."],
  ])("shows a useful export error for %s", async (failure, message) => {
    backupApi.create.mockRejectedValue(failure);
    render(<WorkspaceBackupPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Download backup" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(message));
    expect(screen.getByRole("button", { name: "Download backup" })).toBeEnabled();
  });

  it("resets the file input before parsing, asks for confirmation, and reloads after restore", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const reload = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { reload } });
    render(<WorkspaceBackupPanel />);
    const input = fileInput();
    const file = new File(["backup"], "backup.json", { type: "application/json" });

    Object.defineProperty(input, "value", { configurable: true, writable: true, value: "backup.json" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(backupApi.restore).toHaveBeenCalledWith(backupValue));

    expect(input.value).toBe("");
    expect(backupApi.parse).toHaveBeenCalledWith("backup");
    expect(confirm).toHaveBeenCalledWith(
      "Restore this backup? It will replace every notebook and saved project in this browser.",
    );
    expect(reload).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Restore backup" })).toBeEnabled();
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  });

  it("leaves storage untouched when restore is canceled", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const reload = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { reload } });
    render(<WorkspaceBackupPanel />);
    const input = fileInput();
    fireEvent.change(input, { target: { files: [new File(["backup"], "backup.json")] } });

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Restore canceled. Nothing changed."));
    expect(input.value).toBe("");
    expect(confirm).toHaveBeenCalledOnce();
    expect(backupApi.restore).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  });

  it.each([
    [new Error("Backup is invalid"), "Backup is invalid"],
    ["unexpected parse failure", "The backup could not be restored."],
  ])("shows a useful restore error for %s", async (failure, message) => {
    backupApi.parse.mockImplementation(() => { throw failure; });
    render(<WorkspaceBackupPanel />);

    fireEvent.change(fileInput(), { target: { files: [new File(["bad"], "bad.json")] } });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(message));
    expect(backupApi.restore).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Restore backup" })).toBeEnabled();
  });

  it.each([
    [new Error("Database is locked"), "Database is locked"],
    ["unexpected restore failure", "The backup could not be restored."],
  ])("shows a useful restore error when replacing storage fails for %s", async (failure, message) => {
    backupApi.restore.mockRejectedValue(failure);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<WorkspaceBackupPanel />);

    fireEvent.change(fileInput(), { target: { files: [new File(["backup"], "backup.json")] } });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(message));
    expect(backupApi.restore).toHaveBeenCalledWith(backupValue);
    expect(screen.getByRole("button", { name: "Restore backup" })).toBeEnabled();
  });

  it("keeps both actions disabled during a pending restore", async () => {
    let resolveRestore: (() => void) | undefined;
    backupApi.restore.mockImplementation(() => new Promise<void>((resolve) => { resolveRestore = resolve; }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<WorkspaceBackupPanel />);

    fireEvent.change(fileInput(), { target: { files: [new File(["backup"], "backup.json")] } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Restoring…" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Download backup" })).toBeDisabled();
    resolveRestore?.();
    await waitFor(() => expect(screen.getByRole("button", { name: "Restore backup" })).toBeEnabled());
  });

  it("ignores a change event with no selected file", async () => {
    render(<WorkspaceBackupPanel />);
    fireEvent.change(fileInput(), { target: { files: [] } });
    await actTick();

    expect(backupApi.parse).not.toHaveBeenCalled();
    expect(backupApi.restore).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

async function actTick(): Promise<void> {
  await Promise.resolve();
}
