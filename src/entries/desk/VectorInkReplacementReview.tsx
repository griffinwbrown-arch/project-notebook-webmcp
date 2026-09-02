"use client";

import { useEffect, useId, useRef } from "react";

import type {
  PageRect,
  VectorInkDocument,
  VectorInkProvenance,
} from "../../page";
import { VectorInkDocumentGraphic } from "./PageSurface";

export type VectorInkReplacementReviewState =
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "applying" }>
  | Readonly<{ kind: "failed"; message: string }>;

export type VectorInkReplacementReviewTarget = Readonly<{
  proposalId: string;
  pageId: string;
  pageNumber: number;
  elementId: string;
  label: string;
  description: string;
  frame: PageRect;
  priorDocument: VectorInkDocument;
  newDocument: VectorInkDocument;
  priorProvenance?: VectorInkProvenance;
  newProvenance: VectorInkProvenance;
}>;

export type VectorInkReplacementReviewProps = Readonly<{
  target: VectorInkReplacementReviewTarget;
  state: VectorInkReplacementReviewState;
  onApply: () => void;
  onCancel: () => void;
  onEscape: () => void;
}>;

type ProvenanceDetailsProps = Readonly<{
  provenance: VectorInkProvenance | undefined;
}>;

function ProvenanceDetails({ provenance }: ProvenanceDetailsProps): React.JSX.Element {
  if (provenance === undefined) {
    return <p className="vector-ink-review-empty">No prior provenance recorded.</p>;
  }
  return (
    <dl className="vector-ink-review-provenance">
      <div>
        <dt>Kind</dt>
        <dd>{provenance.kind}</dd>
      </div>
      <div>
        <dt>Source</dt>
        <dd>{provenance.sourceLabel}</dd>
      </div>
      {provenance.sourceFormat === undefined ? null : (
        <div>
          <dt>Format</dt>
          <dd>{provenance.sourceFormat}</dd>
        </div>
      )}
      {provenance.tool === undefined ? null : (
        <div>
          <dt>Tool</dt>
          <dd>{provenance.tool}</dd>
        </div>
      )}
      {provenance.toolVersion === undefined ? null : (
        <div>
          <dt>Tool version</dt>
          <dd>{provenance.toolVersion}</dd>
        </div>
      )}
    </dl>
  );
}

type DocumentPreviewProps = Readonly<{
  side: "prior" | "new";
  title: string;
  document: VectorInkDocument;
  provenance: VectorInkProvenance | undefined;
}>;

function DocumentPreview({
  side,
  title,
  document,
  provenance,
}: DocumentPreviewProps): React.JSX.Element {
  return (
    <section className="vector-ink-review-version" data-vector-ink-review-preview={side}>
      <h3>{title}</h3>
      <div className="vector-ink-review-art" aria-hidden="true">
        <svg
          viewBox={`0 0 ${document.viewBox.width} ${document.viewBox.height}`}
          preserveAspectRatio="xMidYMid meet"
          focusable="false"
        >
          <VectorInkDocumentGraphic document={document} pathKeyPrefix={`replacement-review:${side}`} />
        </svg>
      </div>
      <ProvenanceDetails provenance={provenance} />
    </section>
  );
}

function frameValue(frame: PageRect): string {
  return `${frame.x}, ${frame.y}, ${frame.width} x ${frame.height}`;
}

export function VectorInkReplacementReview({
  target,
  state,
  onApply,
  onCancel,
  onEscape,
}: VectorInkReplacementReviewProps): React.JSX.Element {
  const headingId = useId();
  const descriptionId = useId();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const applying = state.kind === "applying";

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape" || applying) return;
      event.preventDefault();
      event.stopPropagation();
      onEscape();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [applying, onEscape]);

  return (
    <section
      className="vector-ink-replacement-review"
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      aria-busy={applying}
      data-vector-ink-replacement-review
      data-proposal-id={target.proposalId}
      data-target-page-id={target.pageId}
      data-target-page-number={target.pageNumber}
      data-target-element-id={target.elementId}
      data-target-frame={frameValue(target.frame)}
      data-review-state={state.kind}
    >
      <header className="vector-ink-review-heading">
        <div>
          <p className="vector-ink-review-eyebrow">Reviewed vector replacement</p>
          <h2 id={headingId} ref={headingRef} tabIndex={-1}>Review replacement</h2>
        </div>
        <button
          className="vector-ink-review-close"
          type="button"
          aria-label="Cancel vector replacement"
          onClick={onCancel}
          disabled={applying}
        >
          Close
        </button>
      </header>

      <div className="vector-ink-review-target" data-vector-ink-review-target>
        <div>
          <span>Target</span>
          <strong>{target.label}</strong>
          <small>{target.description}</small>
        </div>
        <dl>
          <div>
            <dt>Element ID</dt>
            <dd><code>{target.elementId}</code></dd>
          </div>
          <div>
            <dt>Page</dt>
            <dd>{target.pageNumber} <code>{target.pageId}</code></dd>
          </div>
          <div>
            <dt>Frame</dt>
            <dd><code>{frameValue(target.frame)}</code></dd>
          </div>
        </dl>
      </div>

      <p id={descriptionId} className="vector-ink-review-preservation" data-vector-ink-review-preservation>
        Apply changes only the typed vector document, provenance, and replacement history. The element ID, frame, page placement, annotations, relationships, and other page content stay fixed.
      </p>

      <div className="vector-ink-review-comparison">
        <DocumentPreview
          side="prior"
          title="Current version"
          document={target.priorDocument}
          provenance={target.priorProvenance}
        />
        <DocumentPreview
          side="new"
          title="Proposed version"
          document={target.newDocument}
          provenance={target.newProvenance}
        />
      </div>

      {state.kind === "failed" ? (
        <p className="vector-ink-review-error" role="alert" data-vector-ink-review-error>
          {state.message}
        </p>
      ) : null}
      {applying ? (
        <p className="visually-hidden" role="status" data-vector-ink-review-status>
          Applying the reviewed vector replacement.
        </p>
      ) : null}

      <footer className="vector-ink-review-actions">
        <button
          type="button"
          className="vector-ink-review-cancel"
          onClick={onCancel}
          disabled={applying}
          data-vector-ink-review-cancel
        >
          Cancel
        </button>
        <button
          type="button"
          className="vector-ink-review-apply"
          onClick={onApply}
          disabled={applying}
          data-vector-ink-review-apply
        >
          {applying ? "Applying replacement..." : "Apply replacement"}
        </button>
      </footer>
    </section>
  );
}
