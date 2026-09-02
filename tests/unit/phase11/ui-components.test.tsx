import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  StructuredTextEditor,
  type StructuredTextEditorProps,
} from "../../../src/entries/desk/StructuredTextEditor";
import {
  ProjectMargin,
  type ProjectMarginItem,
} from "../../../src/entries/desk/ProjectMargin";
import {
  ScrapPocket,
  type ScrapSummary,
} from "../../../src/entries/desk/ScrapPocket";
import { createTextBlockId, type StructuredTextBlock } from "../../../src/page";

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

function blocks(): readonly StructuredTextBlock[] {
  return [
    {
      id: createTextBlockId("phase11-editor-heading"),
      kind: "heading",
      runs: [{ text: "Field notes", marks: ["bold"] }],
    },
    {
      id: createTextBlockId("phase11-editor-body"),
      kind: "paragraph",
      runs: [{ text: "Keep this useful.", marks: [] }],
    },
  ];
}

function renderEditor(overrides: Partial<StructuredTextEditorProps> = {}) {
  const onSave = vi.fn<StructuredTextEditorProps["onSave"]>();
  const onCancel = vi.fn();
  const onReturnFocus = vi.fn();
  const result = render(
    <StructuredTextEditor
      label="Edit project brief"
      blocks={blocks()}
      onSave={onSave}
      onCancel={onCancel}
      onReturnFocus={onReturnFocus}
      {...overrides}
    />,
  );
  return { ...result, onSave, onCancel, onReturnFocus };
}

describe("Phase 11 notebook UI components", () => {
  it("edits existing structured blocks through native text controls and saves one complete block set", () => {
    const { onSave, onReturnFocus } = renderEditor();
    const body = screen.getByRole("textbox", { name: "Paragraph 2" });
    const save = screen.getByRole("button", { name: "Save page text" });
    const editor = screen.getByRole("dialog", { name: "Edit project brief" });

    expect(editor).toHaveAttribute("data-phase11-structured-editor", "true");
    expect(screen.getByRole("textbox", { name: "Heading 1" })).toHaveFocus();
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute("data-phase11-editor-save", "true");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveAttribute("data-phase11-editor-cancel", "true");
    expect(body).toHaveAttribute("data-native-input-path", "beforeinput-composition-paste-dictation");
    expect(body).toHaveAttribute("data-phase11-editor-input", "true");
    expect(screen.getByLabelText("Block style")).toHaveDisplayValue("Heading");
    expect(screen.getByLabelText("Block style")).toContainHTML("Bullet list");
    expect(screen.getByLabelText("Block style")).toContainHTML("Numbered list");
    expect(screen.getByRole("button", { name: "Italic" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Underline" })).toBeEnabled();

    fireEvent.focus(body);
    fireEvent.change(body, { target: { value: "Keep this notebook useful." } });
    fireEvent.select(body, { target: { selectionStart: 10, selectionEnd: 18 } });
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    fireEvent.change(screen.getByLabelText("Block style"), { target: { value: "quote" } });

    expect(save).toBeEnabled();
    fireEvent.click(save);

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]?.[0];
    if (saved === undefined) throw new Error("The editor did not return its complete block set.");
    expect(saved).toHaveLength(2);
    expect(saved[0]).toEqual(blocks()[0]);
    expect(saved[1]).toMatchObject({ kind: "quote" });
    expect(saved[1]?.runs.map((run) => run.text).join("")).toBe("Keep this notebook useful.");
    expect(saved[1]?.runs.some((run) => run.marks.includes("bold"))).toBe(true);
    expect(onReturnFocus).not.toHaveBeenCalled();
  });

  it("announces a structured-text save failure inside the modal and allows a retry", () => {
    const editor = renderEditor();
    const body = screen.getByRole("textbox", { name: "Paragraph 2" });
    fireEvent.change(body, { target: { value: "Keep this retryable." } });
    fireEvent.click(screen.getByRole("button", { name: "Save page text" }));

    expect(editor.onSave).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Save page text" })).toBeDisabled();

    editor.rerender(
      <StructuredTextEditor
        label="Edit project brief"
        blocks={blocks()}
        saving
        onSave={editor.onSave}
        onCancel={editor.onCancel}
        onReturnFocus={editor.onReturnFocus}
      />,
    );
    editor.rerender(
      <StructuredTextEditor
        label="Edit project brief"
        blocks={blocks()}
        saving={false}
        error="The page changed before the draft could be saved."
        onSave={editor.onSave}
        onCancel={editor.onCancel}
        onReturnFocus={editor.onReturnFocus}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Edit project brief" });
    const alert = within(dialog).getByRole("alert");
    expect(alert).toHaveTextContent("The page changed before the draft could be saved.");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.getAttribute("aria-describedby")).toContain(alert.id);

    const retry = within(dialog).getByRole("button", { name: "Save page text" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(editor.onSave).toHaveBeenCalledTimes(2);
  });

  it("keeps beforeinput, composition, paste, and dictation on the native draft path", () => {
    const { onSave } = renderEditor();
    const body = screen.getByRole("textbox", { name: "Paragraph 2" });
    const beforeInput = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: " dictated",
    });

    expect(body.dispatchEvent(beforeInput)).toBe(true);
    fireEvent.compositionStart(body, { data: "計" });
    fireEvent.change(body, { target: { value: "Keep this useful. 計画" } });
    fireEvent.compositionEnd(body, { data: "計画" });
    fireEvent.paste(body, {
      clipboardData: { getData: () => " pasted words" },
    });
    fireEvent.change(body, { target: { value: "Keep this useful. 計画 pasted words" } });
    fireEvent.click(screen.getByRole("button", { name: "Save page text" }));

    const saved = onSave.mock.calls[0]?.[0];
    if (saved === undefined) throw new Error("The editor did not return its complete block set.");
    expect(saved[1]?.runs.map((run) => run.text).join("")).toBe("Keep this useful. 計画 pasted words");
  });

  it("cancels on Escape and invokes the focus-return contract without saving", () => {
    const { onSave, onCancel, onReturnFocus } = renderEditor();

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Edit project brief" }), { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onReturnFocus).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("wraps Tab focus within the structured-text modal", () => {
    renderEditor();
    const dialog = screen.getByRole("dialog", { name: "Edit project brief" });
    const first = screen.getByRole("combobox", { name: "Block style" });
    const body = screen.getByRole("textbox", { name: "Paragraph 2" });
    fireEvent.change(body, { target: { value: "Keep this inside the editor." } });
    const last = screen.getByRole("button", { name: "Save page text" });

    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(first).toHaveFocus();

    first.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("keeps project tracking in a collapsible ruled index and reviews creates and status changes", () => {
    const onCreateReviewed = vi.fn();
    const onStatusUpdateReviewed = vi.fn();
    const items: readonly ProjectMarginItem[] = [
      {
        id: "task-1",
        kind: "task",
        title: "Check the page flow",
        status: "blocked",
        author: { kind: "agent", label: "Layout agent" },
      },
      {
        id: "decision-1",
        kind: "decision",
        title: "Keep the ruled margin",
        status: "done",
        author: { kind: "user", label: "Griffin" },
      },
    ];
    render(
      <ProjectMargin
        projectName="Notebook phase 11"
        items={items}
        onCreateReviewed={onCreateReviewed}
        onStatusUpdateReviewed={onStatusUpdateReviewed}
      />,
    );

    expect(screen.queryByRole("list", { name: "Project items" })).not.toBeVisible();
    fireEvent.click(screen.getByText("Project index"));
    const index = screen.getByRole("complementary", { name: "Notebook phase 11 project index" });
    expect(index).toHaveAttribute("data-phase11-tracking", "true");
    expect(within(index).getByText(/Layout agent/)).toBeVisible();
    const taskLine = within(index).getByText("Check the page flow").closest("li");
    if (taskLine === null) throw new Error("The task did not render in an index line.");
    expect(taskLine).toHaveAttribute("data-phase11-project-item-id", "task-1");
    expect(within(taskLine).getByText("Blocked", { selector: "span" })).toBeVisible();
    expect(within(taskLine).getByLabelText("Status for Check the page flow")).toContainHTML("Superseded");
    const decisionLine = within(index).getByText("Keep the ruled margin").closest("li");
    if (decisionLine === null) throw new Error("The decision did not render in an index line.");
    expect(within(decisionLine).getByText("Done", { selector: "span" })).toBeVisible();
    expect(index).toHaveAttribute("data-notebook-index", "ruled");
    expect(index.querySelector("[data-dashboard-card]")).not.toBeInTheDocument();

    fireEvent.change(within(index).getByLabelText("Item kind"), { target: { value: "milestone" } });
    fireEvent.change(within(index).getByLabelText("Item title"), { target: { value: "Production proof" } });
    fireEvent.click(within(index).getByRole("button", { name: "Review new item" }));
    expect(onCreateReviewed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create milestone" }));
    expect(onCreateReviewed).toHaveBeenCalledWith({ kind: "milestone", title: "Production proof" });

    fireEvent.change(within(index).getByLabelText("Status for Check the page flow"), { target: { value: "in_progress" } });
    fireEvent.click(within(index).getByRole("button", { name: "Review status for Check the page flow" }));
    expect(onStatusUpdateReviewed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Update task status" }));
    expect(onStatusUpdateReviewed).toHaveBeenCalledWith({ itemId: "task-1", status: "in_progress" });
  });

  it("closes project review with Escape and restores focus to its trigger", async () => {
    render(
      <ProjectMargin
        projectName="Notebook phase 11"
        items={[]}
        onCreateReviewed={vi.fn()}
        onStatusUpdateReviewed={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Project index"));
    expect(screen.getByText("No project items yet.")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Item title"), { target: { value: "Review keyboard flow" } });
    const trigger = screen.getByRole("button", { name: "Review new item" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Create task" });

    expect(screen.getByRole("button", { name: "Cancel review" })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create task" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("returns focus to enabled project controls after confirmed changes", async () => {
    const item: ProjectMarginItem = {
      id: "task-focus",
      kind: "task",
      title: "Verify confirmation focus",
      status: "open",
      author: { kind: "user", label: "Griffin" },
    };
    render(
      <ProjectMargin
        projectName="Notebook phase 11"
        items={[item]}
        onCreateReviewed={vi.fn()}
        onStatusUpdateReviewed={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Project index"));

    const title = screen.getByLabelText("Item title");
    fireEvent.change(title, { target: { value: "Keep focus stable" } });
    fireEvent.click(screen.getByRole("button", { name: "Review new item" }));
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(title).toHaveFocus());
    expect(title).toBeEnabled();
    expect(screen.getByRole("button", { name: "Review new item" })).toBeDisabled();

    const status = screen.getByLabelText("Status for Verify confirmation focus");
    fireEvent.change(status, { target: { value: "done" } });
    fireEvent.click(screen.getByRole("button", { name: "Review status for Verify confirmation focus" }));
    fireEvent.click(screen.getByRole("button", { name: "Update task status" }));

    await waitFor(() => expect(status).toHaveFocus());
    expect(status).toBeEnabled();
    expect(screen.getByRole("button", { name: "Review status for Verify confirmation focus" })).toBeDisabled();
  });

  it("reviews major rework reasons and disables stale Scrap restores", async () => {
    const onMajorReworkReviewed = vi.fn();
    const onRestoreReviewed = vi.fn();
    const scraps: readonly ScrapSummary[] = [
      {
        id: "scrap-current",
        capturedAt: "Aug 29, 2:15 PM",
        capturedBy: "Griffin",
        reason: "Reorder the field notes",
        pageCount: 2,
        restore: { kind: "available" },
      },
      {
        id: "scrap-stale",
        capturedAt: "Aug 29, 1:30 PM",
        capturedBy: "Research agent",
        reason: "Try a shorter outline",
        pageCount: 1,
        restore: { kind: "stale", reason: "The workbook changed after this rework." },
      },
    ];
    render(
      <ScrapPocket
        scraps={scraps}
        onMajorReworkReviewed={onMajorReworkReviewed}
        onRestoreReviewed={onRestoreReviewed}
      />,
    );

    expect(screen.queryByRole("list", { name: "Scrap history" })).not.toBeVisible();
    fireEvent.click(screen.getByText("Scrap pocket"));
    const pocket = screen.getByRole("complementary", { name: "Scrap history" });
    expect(pocket).toHaveAttribute("data-scrap-pocket", "torn-page");
    expect(pocket).toHaveAttribute("data-phase11-scrap-pocket", "true");
    expect(within(pocket).getByText("Research agent")).toBeVisible();
    const staleEntry = within(pocket).getByText("Try a shorter outline").closest("li");
    if (staleEntry === null) throw new Error("The stale Scrap did not render in a history entry.");
    expect(staleEntry).toHaveAttribute("data-phase11-scrap-id", "scrap-stale");
    expect(within(pocket).getByRole("button", { name: "Restore Try a shorter outline" })).toBeDisabled();
    expect(within(pocket).getByText("The workbook changed after this rework.")).toBeVisible();

    fireEvent.change(within(pocket).getByLabelText("Reason for major rework"), {
      target: { value: "Combine the duplicate sections" },
    });
    fireEvent.click(within(pocket).getByRole("button", { name: "Review major rework" }));
    expect(onMajorReworkReviewed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply major rework" }));
    expect(onMajorReworkReviewed).toHaveBeenCalledWith({ reason: "Combine the duplicate sections" });

    fireEvent.click(within(pocket).getByRole("button", { name: "Restore Reorder the field notes" }));
    expect(onRestoreReviewed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Restore 2 pages" }));
    expect(onRestoreReviewed).toHaveBeenCalledWith({ scrapId: "scrap-current" });
    await waitFor(() => expect(screen.getByText("Scrap pocket")).toHaveFocus());
  });

  it("returns focus to the enabled rework field after confirmation", async () => {
    render(
      <ScrapPocket
        scraps={[]}
        onMajorReworkReviewed={vi.fn()}
        onRestoreReviewed={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Scrap pocket"));
    const reason = screen.getByLabelText("Reason for major rework");
    fireEvent.change(reason, { target: { value: "Replace the duplicate outline" } });
    fireEvent.click(screen.getByRole("button", { name: "Review major rework" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply major rework" }));

    await waitFor(() => expect(reason).toHaveFocus());
    expect(reason).toBeEnabled();
    expect(screen.getByRole("button", { name: "Review major rework" })).toBeDisabled();
  });

  it("explains an empty Scrap pocket", () => {
    render(
      <ScrapPocket
        scraps={[]}
        onMajorReworkReviewed={vi.fn()}
        onRestoreReviewed={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Scrap pocket"));
    expect(screen.getByText("No Scrap history yet.")).toBeVisible();
  });
});
