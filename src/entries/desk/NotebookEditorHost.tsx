"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { parseAnatomyComponent, type AnatomyPaintEdit, type AnatomySection } from "../../anatomy";
import type { DemoSessionContext } from "../../demo/session-runtime";
import { bindDemoNotebookAgentSession } from "../../demo/webmcp-workspace-tools";
import type { IndexedDbProjectStorage, PageStorage } from "../../indexeddb";
import { parseLearningActivity, type ColoringEdit } from "../../learning/activities";
import {
  createPageCommandRegistry,
  visiblePageIds,
  type PageCommandName,
  type PageCommandRegistry,
} from "../../page";
import type { NotebookCoverViewModel } from "../../workspace/model";
import { AnatomyColoringLab } from "./AnatomyColoringLab";
import { AnatomySkeletonStudy } from "./AnatomySkeletonStudy";
import { CalculusPractice } from "./CalculusPractice";
import { ColoringBookPage } from "./ColoringBookPage";
import { PageSurface } from "./PageSurface";
import type { NotebookPageAction, NotebookPageState } from "./notebook-page-state";
import { NOTEBOOK_SCALES, type NotebookScale } from "./notebook-page-state";

export type NotebookEditorHostProps = Readonly<{
  notebook: NotebookCoverViewModel;
  pageStorage: PageStorage;
  projectStorage?: IndexedDbProjectStorage;
  demoSession?: DemoSessionContext;
  state: NotebookPageState;
  onAction: (action: NotebookPageAction) => void;
}>;

function mutationId(prefix: string): string {
  return `${prefix}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

function useNarrowNotebookViewport(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 940px)");
    const update = (): void => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

export function NotebookEditorHost({
  notebook,
  pageStorage,
  demoSession,
  state,
  onAction,
}: NotebookEditorHostProps): React.JSX.Element {
  const [registry, setRegistry] = useState<PageCommandRegistry | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void createPageCommandRegistry(pageStorage, notebook.id)
      .then((nextRegistry) => {
        if (!active) return;
        setRegistry(nextRegistry);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : "The notebook could not be opened.");
      });
    return () => {
      active = false;
    };
  }, [demoSession, notebook.id, pageStorage]);

  if (loadError !== null) return <p className="page-load-error" role="alert">{loadError}</p>;
  if (registry === null) return <div className="page-loading" aria-busy="true">Opening the notebook…</div>;

  return <AgentNotebookViewer
    notebook={notebook}
    registry={registry}
    state={state}
    onAction={onAction}
    agentSessionEnabled={demoSession !== undefined}
  />;
}

type AgentNotebookViewerProps = Readonly<{
  notebook: NotebookCoverViewModel;
  registry: PageCommandRegistry;
  state: NotebookPageState;
  onAction: (action: NotebookPageAction) => void;
  agentSessionEnabled: boolean;
}>;

type NotebookPanDrag = Readonly<{
  pointerId: number;
  clientX: number;
  clientY: number;
  offsetX: number;
  offsetY: number;
}>;

function AgentNotebookViewer({ notebook, registry, state, onAction, agentSessionEnabled }: AgentNotebookViewerProps): React.JSX.Element {
  const context = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panActive, setPanActive] = useState(false);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [cameraScale, setCameraScale] = useState(Number(state.scale) / 100);
  const diagramMoveQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  const panViewportRef = useRef<HTMLDivElement | null>(null);
  const openNotebookRef = useRef<HTMLDivElement | null>(null);
  const panDragRef = useRef<NotebookPanDrag | null>(null);
  const panOffsetRef = useRef(panOffset);
  const cameraScaleRef = useRef(cameraScale);
  const narrowViewport = useNarrowNotebookViewport();
  const documentModel = registry.getDocument();
  const currentPage = documentModel.pages.find((page) => page.id === context.focusedPageId) ?? documentModel.pages[0]!;
  const effectiveLayout = narrowViewport ? "single" : state.requestedLayout;
  const visibleIds = visiblePageIds(documentModel, currentPage.id, effectiveLayout);
  const visiblePages = visibleIds.flatMap((pageId) => {
    const page = documentModel.pages.find((candidate) => candidate.id === pageId);
    return page === undefined ? [] : [page];
  });
  const renderedLayout = visiblePages.length === 2 ? "spread" : "single";
  const currentScalePercent = cameraScale * 100;
  const smallerScale = [...NOTEBOOK_SCALES].reverse().find((scale) => Number(scale) < currentScalePercent - 1);
  const largerScale = NOTEBOOK_SCALES.find((scale) => Number(scale) > currentScalePercent + 1);

  const selectScale = (scale: NotebookScale | undefined): void => {
    if (scale === undefined) return;
    const nextScale = Number(scale) / 100;
    cameraScaleRef.current = nextScale;
    setCameraScale(nextScale);
    onAction({ type: "scale-selected", scale });
  };

  const notebookTransform = (offset: Readonly<{ x: number; y: number }>, scale: number): string =>
    `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})`;

  const resetView = useCallback((): void => {
    const centered = { x: 0, y: 0 };
    panDragRef.current = null;
    panOffsetRef.current = centered;
    cameraScaleRef.current = 1;
    setPanActive(false);
    setPanOffset(centered);
    setCameraScale(1);
    onAction({ type: "scale-selected", scale: "100" });
    if (openNotebookRef.current !== null) {
      openNotebookRef.current.style.transform = notebookTransform(centered, 1);
    }
  }, [onAction]);

  useEffect(() => {
    if (!agentSessionEnabled) return undefined;
    return bindDemoNotebookAgentSession(document.modelContext, notebook.id, registry, resetView);
  }, [agentSessionEnabled, notebook.id, registry, resetView]);

  useEffect(() => {
    registry.setViewContext({ presentation: effectiveLayout, visiblePageIds: visibleIds });
  }, [effectiveLayout, registry, visibleIds]);

  const executeIntrinsicAction = async (name: PageCommandName, input: unknown): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await registry.executeManual(name, input);
      if (result.outcome === "error") {
        setError(result.error.message);
        return false;
      }
      setError(null);
      return true;
    } finally {
      setBusy(false);
    }
  };

  const previousPage = (): void => {
    if (context.previousPageId !== null) registry.focusPage(context.previousPageId);
  };

  const nextPage = async (): Promise<void> => {
    if (context.nextPageId !== null) {
      registry.focusPage(context.nextPageId);
      return;
    }
    await executeIntrinsicAction("page_advance", {
      mutationId: mutationId("page-advance"),
      expectedDocumentRevision: registry.getSnapshot().documentRevision,
    });
  };

  return (
    <section className="page-stage agent-notebook-viewer" aria-label={notebook.title} data-testid="notebook-page" data-agent-controlled="true">
      <header className="agent-notebook-header" data-layout={renderedLayout} data-notebook-scale={state.scale}>
        <div className="notebook-header-actions">
          <nav className="page-navigation agent-page-navigation" aria-label="Page navigation">
            <button type="button" aria-label="Previous" onClick={previousPage} disabled={context.previousPageId === null}>Previous</button>
            <span>Page {context.focusedPageNumber} of {context.pageCount}</span>
            <button
              type="button"
              onClick={() => { void nextPage(); }}
              disabled={busy || (context.nextPageId === null && context.pageCount >= 8)}
            >Next</button>
          </nav>
          <div className="notebook-view-controls" aria-label="Notebook view controls">
            <div className="layout-switch" role="group" aria-label="Pages shown">
              <button
                type="button"
                aria-pressed={state.requestedLayout === "single"}
                onClick={() => onAction({ type: "layout-selected", layout: "single" })}
              >1 page</button>
              <button
                type="button"
                aria-pressed={state.requestedLayout === "spread"}
                aria-describedby={narrowViewport ? "two-page-narrow-note" : undefined}
                disabled={narrowViewport}
                onClick={() => onAction({ type: "layout-selected", layout: "spread" })}
              >2 pages</button>
            </div>
            <div className="notebook-scale-control" role="group" aria-label="Notebook size">
              <button type="button" aria-label="Make notebook smaller" disabled={smallerScale === undefined} onClick={() => selectScale(smallerScale)}>−</button>
              <output aria-live="polite">{Math.round(currentScalePercent)}%</output>
              <button type="button" aria-label="Make notebook larger" disabled={largerScale === undefined} onClick={() => selectScale(largerScale)}>+</button>
              <button
                type="button"
                aria-label="Pan notebook"
                aria-pressed={panActive}
                title="Turn on, then drag the notebook to pan"
                onClick={() => setPanActive((active) => !active)}
              >Pan</button>
              <button
                type="button"
                aria-label="Reset notebook view"
                title="Center the notebook and return to 100%"
                onClick={resetView}
              >Reset</button>
            </div>
            {narrowViewport ? <span className="visually-hidden" id="two-page-narrow-note">Two-page view is available on wider screens.</span> : null}
          </div>
        </div>
      </header>

      <div
        ref={panViewportRef}
        className="notebook-pan-viewport"
        data-page-scale-contract="readable-pan-zoom"
        data-layout={renderedLayout}
        data-notebook-scale={state.scale}
        data-pan-active={panActive || undefined}
        onPointerDownCapture={(event) => {
          if (!panActive || event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          panDragRef.current = {
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
            offsetX: panOffsetRef.current.x,
            offsetY: panOffsetRef.current.y,
          };
        }}
        onPointerMoveCapture={(event) => {
          const drag = panDragRef.current;
          if (drag === null || drag.pointerId !== event.pointerId) return;
          event.preventDefault();
          event.stopPropagation();
          const nextOffset = {
            x: drag.offsetX + event.clientX - drag.clientX,
            y: drag.offsetY + event.clientY - drag.clientY,
          };
          panOffsetRef.current = nextOffset;
          if (openNotebookRef.current !== null) {
            openNotebookRef.current.style.transform = notebookTransform(nextOffset, cameraScaleRef.current);
          }
        }}
        onPointerUpCapture={(event) => {
          if (panDragRef.current?.pointerId !== event.pointerId) return;
          panDragRef.current = null;
          setPanOffset(panOffsetRef.current);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancelCapture={(event) => {
          if (panDragRef.current?.pointerId !== event.pointerId) return;
          panDragRef.current = null;
        }}
        onWheel={(event) => {
          if (event.target instanceof Element && event.target.closest("button, input, textarea, select") !== null) return;
          event.preventDefault();
          const oldScale = cameraScaleRef.current;
          const wheelDelta = Math.max(-120, Math.min(120, event.deltaY));
          const nextScale = Math.max(.6, Math.min(2.5, oldScale * Math.exp(-wheelDelta * .0008)));
          if (Math.abs(nextScale - oldScale) < .001) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const centerX = bounds.left + bounds.width / 2;
          const centerY = bounds.top + bounds.height / 2;
          const ratio = nextScale / oldScale;
          const oldOffset = panOffsetRef.current;
          const nextOffset = {
            x: event.clientX - centerX - ratio * (event.clientX - centerX - oldOffset.x),
            y: event.clientY - centerY - ratio * (event.clientY - centerY - oldOffset.y),
          };
          cameraScaleRef.current = nextScale;
          panOffsetRef.current = nextOffset;
          setCameraScale(nextScale);
          setPanOffset(nextOffset);
        }}
      >
        <div
          ref={openNotebookRef}
          className="open-notebook"
          data-editor-host
          data-layout={renderedLayout}
          data-notebook-scale={state.scale}
          data-paper={state.paper}
          data-writing-style={state.writingStyle}
          style={{ transform: notebookTransform(panOffset, cameraScale) }}
        >
          <div className="under-cover" aria-hidden="true" />
          <div className="notebook-workspace">
          <div className="notebook-pages" data-visible-page-count={visiblePages.length}>
            {visiblePages.map((page, index) => (
              <div
                className="notebook-page-slot"
                data-page-position={visiblePages.length === 2 ? index === 0 ? "left" : "right" : "single"}
                data-page-focused={page.id === currentPage.id || undefined}
                key={page.id}
              >
                <PageSurface
                  page={page}
                  notebookTitle={notebook.title}
                  focused={page.id === currentPage.id}
                  writingStyle={state.writingStyle}
                  onFocus={() => registry.focusPage(page.id)}
                  graphics={{ kind: "svg" }}
                  diagrams={page.elements.filter((element) => element.kind === "diagram")}
                  onDiagramNodeMove={(diagramId, nodeId, position) => {
                    const queued = diagramMoveQueue.current.then(async () => {
                      const latestPage = registry.getDocument().pages.find((candidate) => candidate.id === page.id);
                      if (latestPage === undefined) return false;
                      return executeIntrinsicAction("page_diagram_nodes_set", {
                        mutationId: mutationId("diagram-node-move"),
                        pageId: page.id,
                        expectedRevision: latestPage.revision,
                        elementId: diagramId,
                        positions: [{ id: nodeId, x: position.x, y: position.y }],
                      });
                    });
                    diagramMoveQueue.current = queued.catch(() => false);
                    return queued;
                  }}
                  embeddedComponents={page.elements.flatMap((element) => {
                    if (element.kind !== "embedded-frame") return [];
                    const component = parseAnatomyComponent(element);
                    if (component?.kind === "skeleton") {
                      return [{
                        elementId: element.id,
                        label: element.label,
                        frame: element.frame,
                        layer: (
                          <AnatomySkeletonStudy
                            props={component.props}
                            disabled={busy}
                            webMcpEnabled={false}
                            onSubmit={async (section: AnatomySection, answers: Readonly<Record<string, string>>) => executeIntrinsicAction("page_anatomy_quiz_submit", {
                              mutationId: mutationId("anatomy-quiz"),
                              pageId: page.id,
                              expectedRevision: page.revision,
                              elementId: element.id,
                              section,
                              answers,
                            })}
                          />
                        ),
                      }];
                    }
                    if (component?.kind === "coloring") {
                      return [{
                        elementId: element.id,
                        label: element.label,
                        frame: element.frame,
                        layer: (
                          <AnatomyColoringLab
                            props={component.props}
                            disabled={busy}
                            onPaint={async (edit: AnatomyPaintEdit) => executeIntrinsicAction("page_anatomy_paint_apply", {
                              mutationId: mutationId("anatomy-paint"),
                              pageId: page.id,
                              expectedRevision: page.revision,
                              elementId: element.id,
                              edit,
                            })}
                            onSubmit={async (answers: Readonly<Record<string, string>>) => executeIntrinsicAction("page_anatomy_quiz_submit", {
                              mutationId: mutationId("anatomy-coloring-quiz"),
                              pageId: page.id,
                              expectedRevision: page.revision,
                              elementId: element.id,
                              section: component.props.section,
                              answers,
                            })}
                          />
                        ),
                      }];
                    }
                    const learningActivity = parseLearningActivity(element);
                    if (learningActivity?.kind === "calculus") {
                      return [{
                        elementId: element.id,
                        label: element.label,
                        frame: element.frame,
                        layer: (
                          <CalculusPractice
                            key={learningActivity.props.latestSubmission?.attemptId ?? "new"}
                            props={learningActivity.props}
                            disabled={busy}
                            onSubmit={async (answers: Readonly<Record<string, string>>) => executeIntrinsicAction("page_calc_practice_submit", {
                              mutationId: mutationId("calculus-practice"),
                              pageId: page.id,
                              expectedRevision: page.revision,
                              elementId: element.id,
                              answers,
                            })}
                          />
                        ),
                      }];
                    }
                    if (learningActivity?.kind === "coloring") {
                      return [{
                        elementId: element.id,
                        label: element.label,
                        frame: element.frame,
                        presentation: "page" as const,
                        layer: (
                          <ColoringBookPage
                            props={learningActivity.props}
                            disabled={busy}
                            onEdit={async (edit: ColoringEdit) => executeIntrinsicAction("page_coloring_edit", {
                              mutationId: mutationId("coloring-edit"),
                              pageId: page.id,
                              expectedRevision: page.revision,
                              elementId: element.id,
                              edit,
                            })}
                          />
                        ),
                      }];
                    }
                    return [];
                  })}
                />
              </div>
            ))}
          </div>
          </div>

          {error === null ? null : <p className="page-command-error" role="alert">{error}</p>}
        </div>
      </div>
    </section>
  );
}
