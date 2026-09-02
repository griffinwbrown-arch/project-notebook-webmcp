"use client";

import { useRef, useState, type ChangeEvent } from "react";

import {
  createWorkspaceBackup,
  parseWorkspaceBackupJson,
  restoreWorkspaceBackup,
  serializeWorkspaceBackup,
} from "../../indexeddb";

function backupFilename(exportedAt: string): string {
  return `project-notebook-backup-${exportedAt.replaceAll(":", "-")}.json`;
}

export function WorkspaceBackupPanel(): React.JSX.Element {
  const [busy, setBusy] = useState<"export" | "restore" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const exportBackup = async (): Promise<void> => {
    setBusy("export");
    setMessage(null);
    try {
      const backup = await createWorkspaceBackup();
      const blob = new Blob([serializeWorkspaceBackup(backup)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = backupFilename(backup.exportedAt);
      link.click();
      URL.revokeObjectURL(url);
      setMessage("Backup downloaded.");
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "The backup could not be created.");
    } finally {
      setBusy(null);
    }
  };

  const restoreBackup = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined) return;
    setBusy("restore");
    setMessage(null);
    try {
      const backup = parseWorkspaceBackupJson(await file.text());
      const confirmed = window.confirm(
        "Restore this backup? It will replace every notebook and saved project in this browser.",
      );
      if (!confirmed) {
        setMessage("Restore canceled. Nothing changed.");
        return;
      }
      await restoreWorkspaceBackup(backup);
      window.location.reload();
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "The backup could not be restored.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="workspace-backup" aria-labelledby="workspace-backup-heading">
      <div>
        <h2 id="workspace-backup-heading">Keep a local backup</h2>
        <p>Download every saved notebook and project, or restore a Project Notebook backup.</p>
      </div>
      <div className="workspace-backup-actions">
        <button type="button" onClick={() => void exportBackup()} disabled={busy !== null}>
          {busy === "export" ? "Preparing…" : "Download backup"}
        </button>
        <button type="button" onClick={() => inputRef.current?.click()} disabled={busy !== null}>
          {busy === "restore" ? "Restoring…" : "Restore backup"}
        </button>
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          accept="application/json,.json"
          aria-label="Choose a Project Notebook backup"
          onChange={(event) => void restoreBackup(event)}
        />
      </div>
      {message === null ? null : <p className="workspace-backup-message" role="status">{message}</p>}
    </section>
  );
}
