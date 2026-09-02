"use client";

import { useEffect, useRef, useState } from "react";

import type { ProjectItemKind, ProjectItemStatus } from "../../projects";

export type ProjectMarginItemKind = ProjectItemKind;
export type ProjectMarginItemStatus = ProjectItemStatus;

export type ProjectMarginItem = Readonly<{
  id: string;
  kind: ProjectMarginItemKind;
  title: string;
  status: ProjectMarginItemStatus;
  author: Readonly<{
    kind: "user" | "agent";
    label: string;
  }>;
}>;

export type ProjectMarginProps = Readonly<{
  projectName: string;
  items: readonly ProjectMarginItem[];
  onCreateReviewed: (request: Readonly<{
    kind: ProjectMarginItemKind;
    title: string;
  }>) => void;
  onStatusUpdateReviewed: (request: Readonly<{
    itemId: string;
    status: ProjectMarginItemStatus;
  }>) => void;
}>;

type ProjectReview =
  | Readonly<{ kind: "create"; itemKind: ProjectMarginItemKind; title: string }>
  | Readonly<{
      kind: "status";
      itemId: string;
      itemKind: ProjectMarginItemKind;
      title: string;
      from: ProjectMarginItemStatus;
      to: ProjectMarginItemStatus;
    }>;

const ITEM_KINDS: readonly Readonly<{ value: ProjectMarginItemKind; label: string }>[] = [
  { value: "task", label: "Task" },
  { value: "milestone", label: "Milestone" },
  { value: "decision", label: "Decision" },
];

const ITEM_STATUSES: readonly Readonly<{ value: ProjectMarginItemStatus; label: string }>[] = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
  { value: "superseded", label: "Superseded" },
];

function kindLabel(kind: ProjectMarginItemKind): string {
  return ITEM_KINDS.find((candidate) => candidate.value === kind)?.label ?? kind;
}

function statusLabel(status: ProjectMarginItemStatus): string {
  return ITEM_STATUSES.find((candidate) => candidate.value === status)?.label ?? status;
}

export function ProjectMargin({
  projectName,
  items,
  onCreateReviewed,
  onStatusUpdateReviewed,
}: ProjectMarginProps): React.JSX.Element {
  const [newKind, setNewKind] = useState<ProjectMarginItemKind>("task");
  const [newTitle, setNewTitle] = useState("");
  const [selectedStatuses, setSelectedStatuses] = useState<Readonly<Record<string, ProjectMarginItemStatus>>>({});
  const [review, setReview] = useState<ProjectReview | null>(null);
  const newTitleRef = useRef<HTMLInputElement | null>(null);
  const statusSelectRefs = useRef(new Map<string, HTMLSelectElement>());
  const reviewDialogRef = useRef<HTMLDialogElement | null>(null);
  const reviewCancelRef = useRef<HTMLButtonElement | null>(null);
  const reviewReturnFocusRef = useRef<HTMLElement | null>(null);
  const pendingFocusRef = useRef<HTMLElement | null>(null);
  const trimmedTitle = newTitle.trim();

  useEffect(() => {
    if (review === null) {
      const focusTarget = pendingFocusRef.current;
      pendingFocusRef.current = null;
      focusTarget?.focus();
      return;
    }
    const dialog = reviewDialogRef.current;
    if (dialog === null || dialog.open) return;
    dialog.showModal();
    reviewCancelRef.current?.focus();
  }, [review]);

  function openReview(nextReview: ProjectReview): void {
    reviewReturnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setReview(nextReview);
  }

  function closeReview(returnFocus = reviewReturnFocusRef.current): void {
    pendingFocusRef.current = returnFocus;
    reviewReturnFocusRef.current = null;
    const dialog = reviewDialogRef.current;
    if (dialog?.open) dialog.close();
    setReview(null);
  }

  function submitReview(): void {
    if (review === null) return;
    const returnFocus = review.kind === "create"
      ? newTitleRef.current
      : statusSelectRefs.current.get(review.itemId) ?? null;
    if (review.kind === "create") {
      onCreateReviewed({ kind: review.itemKind, title: review.title });
      setNewTitle("");
    } else {
      onStatusUpdateReviewed({ itemId: review.itemId, status: review.to });
      setSelectedStatuses((current) => {
        const next = { ...current };
        delete next[review.itemId];
        return next;
      });
    }
    closeReview(returnFocus);
  }

  return (
    <aside
      className="project-margin"
      aria-label={`${projectName} project index`}
      data-notebook-index="ruled"
      data-phase11-tracking="true"
    >
      <details>
        <summary>Project index</summary>
        <div className="project-margin-sheet">
          <p className="project-margin-project">{projectName}</p>
          <ol aria-label="Project items" className="project-margin-items">
            {items.length === 0 ? <li className="project-margin-empty">No project items yet.</li> : null}
            {items.map((item) => {
              const selectedStatus = selectedStatuses[item.id] ?? item.status;
              return (
                <li
                  key={item.id}
                  className="project-margin-line"
                  data-phase11-project-item-id={item.id}
                  data-phase11-authored-by={item.author.label}
                  data-phase11-item-kind={item.kind}
                >
                  <div>
                    <span>{kindLabel(item.kind)}</span>
                    <strong>{item.title}</strong>
                    <small>{item.author.kind === "agent" ? "Agent" : "Person"}: {item.author.label}</small>
                    <span>{statusLabel(item.status)}</span>
                  </div>
                  <label>
                    Status for {item.title}
                    <select
                      ref={(node) => {
                        if (node === null) statusSelectRefs.current.delete(item.id);
                        else statusSelectRefs.current.set(item.id, node);
                      }}
                      aria-label={`Status for ${item.title}`}
                      value={selectedStatus}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        if (
                          value === "open" || value === "in_progress" || value === "blocked" ||
                          value === "done" || value === "superseded"
                        ) {
                          setSelectedStatuses((current) => ({ ...current, [item.id]: value }));
                        }
                      }}
                    >
                      {ITEM_STATUSES.map((status) => (
                        <option key={status.value} value={status.value}>{status.label}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={selectedStatus === item.status}
                    aria-label={`Review status for ${item.title}`}
                    onClick={() => openReview({
                      kind: "status",
                      itemId: item.id,
                      itemKind: item.kind,
                      title: item.title,
                      from: item.status,
                      to: selectedStatus,
                    })}
                  >
                    Review status
                  </button>
                </li>
              );
            })}
          </ol>

          <form
            className="project-margin-create"
            onSubmit={(event) => {
              event.preventDefault();
              if (trimmedTitle.length === 0) return;
              openReview({ kind: "create", itemKind: newKind, title: trimmedTitle });
            }}
          >
            <label>
              Item kind
              <select
                aria-label="Item kind"
                value={newKind}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (value === "task" || value === "milestone" || value === "decision") setNewKind(value);
                }}
              >
                {ITEM_KINDS.map((kind) => (
                  <option key={kind.value} value={kind.value}>{kind.label}</option>
                ))}
              </select>
            </label>
            <label>
              Item title
              <input
                ref={newTitleRef}
                aria-label="Item title"
                value={newTitle}
                maxLength={240}
                onChange={(event) => setNewTitle(event.currentTarget.value)}
              />
            </label>
            <button type="submit" disabled={trimmedTitle.length === 0}>Review new item</button>
          </form>
        </div>
      </details>

      {review === null ? null : (
        <dialog
          ref={reviewDialogRef}
          className="review-dialog project-margin-review"
          aria-labelledby="project-review-title"
          onCancel={(event) => {
            event.preventDefault();
            closeReview();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            closeReview();
          }}
        >
          <h3 id="project-review-title">{review.kind === "create" ? `Create ${kindLabel(review.itemKind).toLowerCase()}` : `Update ${kindLabel(review.itemKind).toLowerCase()} status`}</h3>
          <p>{review.title}</p>
          {review.kind === "status" ? <p>{statusLabel(review.from)} to {statusLabel(review.to)}</p> : null}
          <div className="review-dialog-actions">
            <button ref={reviewCancelRef} type="button" onClick={() => closeReview()}>Cancel review</button>
            <button type="button" onClick={submitReview}>
              {review.kind === "create"
                ? `Create ${kindLabel(review.itemKind).toLowerCase()}`
                : `Update ${kindLabel(review.itemKind).toLowerCase()} status`}
            </button>
          </div>
        </dialog>
      )}
    </aside>
  );
}
