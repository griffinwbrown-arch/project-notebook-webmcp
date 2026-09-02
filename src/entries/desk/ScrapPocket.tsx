"use client";

import { useEffect, useRef, useState } from "react";

export type ScrapSummary = Readonly<{
  id: string;
  capturedAt: string;
  capturedBy: string;
  reason: string;
  pageCount: number;
  restore:
    | Readonly<{ kind: "available" }>
    | Readonly<{ kind: "stale"; reason: string }>;
}>;

export type ScrapPocketProps = Readonly<{
  scraps: readonly ScrapSummary[];
  onMajorReworkReviewed: (request: Readonly<{ reason: string }>) => void;
  onRestoreReviewed: (request: Readonly<{ scrapId: string }>) => void;
}>;

type ScrapReview =
  | Readonly<{ kind: "rework"; reason: string }>
  | Readonly<{ kind: "restore"; scrap: ScrapSummary }>;

export function ScrapPocket({
  scraps,
  onMajorReworkReviewed,
  onRestoreReviewed,
}: ScrapPocketProps): React.JSX.Element {
  const [reason, setReason] = useState("");
  const [review, setReview] = useState<ScrapReview | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);
  const summaryRef = useRef<HTMLElement | null>(null);
  const reviewDialogRef = useRef<HTMLDialogElement | null>(null);
  const reviewCancelRef = useRef<HTMLButtonElement | null>(null);
  const reviewReturnFocusRef = useRef<HTMLElement | null>(null);
  const pendingFocusRef = useRef<HTMLElement | null>(null);
  const trimmedReason = reason.trim();

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

  function openReview(nextReview: ScrapReview): void {
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
    const returnFocus = review.kind === "rework"
      ? reasonRef.current
      : summaryRef.current;
    if (review.kind === "rework") {
      onMajorReworkReviewed({ reason: review.reason });
      setReason("");
    } else {
      onRestoreReviewed({ scrapId: review.scrap.id });
    }
    closeReview(returnFocus);
  }

  return (
    <aside
      className="scrap-pocket"
      aria-label="Scrap history"
      data-scrap-pocket="torn-page"
      data-phase11-scrap-pocket="true"
    >
      <details>
        <summary ref={summaryRef}>Scrap pocket</summary>
        <div className="scrap-pocket-sheet">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (trimmedReason.length === 0) return;
              openReview({ kind: "rework", reason: trimmedReason });
            }}
          >
            <label>
              Reason for major rework
              <textarea
                ref={reasonRef}
                aria-label="Reason for major rework"
                value={reason}
                maxLength={600}
                rows={3}
                onChange={(event) => setReason(event.currentTarget.value)}
              />
            </label>
            <button type="submit" disabled={trimmedReason.length === 0}>Review major rework</button>
          </form>

          <ol aria-label="Scrap history" className="scrap-history-list">
            {scraps.length === 0 ? <li className="scrap-history-empty">No Scrap history yet.</li> : null}
            {scraps.map((scrap) => (
              <li
                key={scrap.id}
                className="scrap-history-entry"
                data-phase11-scrap-id={scrap.id}
              >
                <strong>{scrap.reason}</strong>
                <span>{scrap.pageCount} {scrap.pageCount === 1 ? "page" : "pages"}</span>
                <span>{scrap.capturedAt}</span>
                <small>{scrap.capturedBy}</small>
                {scrap.restore.kind === "stale" ? <p>{scrap.restore.reason}</p> : null}
                <button
                  type="button"
                  disabled={scrap.restore.kind === "stale"}
                  aria-label={`Restore ${scrap.reason}`}
                  onClick={() => openReview({ kind: "restore", scrap })}
                >
                  Review restore
                </button>
              </li>
            ))}
          </ol>
        </div>
      </details>

      {review === null ? null : (
        <dialog
          ref={reviewDialogRef}
          className="review-dialog scrap-pocket-review"
          aria-labelledby="scrap-review-title"
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
          {review.kind === "rework" ? (
            <>
              <h3 id="scrap-review-title">Review major rework</h3>
              <p>A durable Scrap copy must be saved before this rework applies.</p>
              <p>{review.reason}</p>
            </>
          ) : (
            <>
              <h3 id="scrap-review-title">Review Scrap restore</h3>
              <p>{review.scrap.reason}</p>
              <p>Restore is allowed only while the workbook still matches the post-rework state.</p>
            </>
          )}
          <div className="review-dialog-actions">
            <button ref={reviewCancelRef} type="button" onClick={() => closeReview()}>Cancel review</button>
            <button type="button" onClick={submitReview}>
              {review.kind === "rework"
                ? "Apply major rework"
                : `Restore ${review.scrap.pageCount} ${review.scrap.pageCount === 1 ? "page" : "pages"}`}
            </button>
          </div>
        </dialog>
      )}
    </aside>
  );
}
