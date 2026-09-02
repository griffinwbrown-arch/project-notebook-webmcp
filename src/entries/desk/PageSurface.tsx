"use client";

import { useMemo, useRef } from "react";

import {
  arrowGeometry,
  connectedArrowGeometry,
  circleGeometry,
  highlightGeometry,
  layoutPage,
  labelGeometry,
  nearestRelationshipTarget,
  textRangeRects,
  underlineGeometry,
  wrapReviewCalloutText,
  type AnnotationElement,
  type DiagramElement,
  type DiagramNodePosition,
  type PageLayoutSnapshot,
  type PageElement,
  type PagePoint,
  type PageRecord,
  type PageRect,
  type PageVectorInkElement,
  type RichTextBlock,
  type RichTextMark,
  type ShapeElement,
  type StrokeElement,
  type TextElement,
  type TextLineLayout,
  type VectorInkDocument,
} from "../../page";
import { vectorInkColorValue, vectorInkPaint, vectorInkPathData } from "../../page/vector-ink";
import { NativeDiagram } from "./NativeDiagram";
import type { WritingStyle } from "./notebook-page-state";

export type PageSurfaceProps = Readonly<{
  page: PageRecord;
  notebookTitle: string;
  focused: boolean;
  writingStyle: WritingStyle;
  onFocus: () => void;
  onTextEdit?: (elementId: string) => void;
  interactionDisabled?: boolean;
  graphics?: PageSurfaceGraphics;
  diagrams?: readonly DiagramElement[];
  onDiagramNodeMove?: (diagramId: string, nodeId: string, position: DiagramNodePosition) => Promise<boolean>;
  embeddedComponents?: readonly PageSurfaceEmbeddedComponent[];
  arrangement?: PageSurfaceArrangement;
}>;

export type PageSurfaceGraphics = Readonly<{ kind: "svg" }>;

export type PageSurfaceEmbeddedComponent = Readonly<{
  elementId: string;
  label: string;
  frame: PageRect;
  presentation?: "framed" | "page";
  layer: React.ReactNode;
}>;

export type PageSurfaceArrangement = Readonly<{
  elementId: string;
  kind: PageElement["kind"];
  label: string;
  frame: PageRect;
  onFrameChange: (frame: PageRect) => void;
}>;

type ArrangementDrag = Readonly<{
  pointerId: number;
  mode: "move" | "resize";
  clientX: number;
  clientY: number;
  frame: PageRect;
  surfaceWidth: number;
  surfaceHeight: number;
}>;

type LineSegment = Readonly<{
  key: string;
  text: string;
  marks: readonly RichTextMark[];
  x: number;
  width: number;
  start: number;
  end: number;
}>;

function pathData(points: readonly PagePoint[]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
}

function lineOffsetX(line: TextLineLayout, offset: number): number {
  const first = line.advances.at(0);
  if (first === undefined) return line.rect.x;
  if (offset <= first.start) return first.x;
  for (const advance of line.advances) {
    if (offset <= advance.end) {
      const span = Math.max(1, advance.end - advance.start);
      const fraction = Math.max(0, Math.min(1, (offset - advance.start) / span));
      return advance.x + advance.width * fraction;
    }
  }
  const last = line.advances.at(-1)!;
  return last.x + last.width;
}

function lineSegments(block: RichTextBlock, line: TextLineLayout): readonly LineSegment[] {
  const segments: LineSegment[] = [];
  let runStart = 0;
  block.runs.forEach((run, runIndex) => {
    const runEnd = runStart + run.text.length;
    const start = Math.max(runStart, line.start);
    const end = Math.min(runEnd, line.end);
    if (end > start) {
      const x = lineOffsetX(line, start);
      const right = lineOffsetX(line, end);
      segments.push({
        key: `${block.id}:${runIndex}:${start}:${end}`,
        text: run.text.slice(start - runStart, end - runStart),
        marks: run.marks,
        x,
        width: Math.max(1, right - x),
        start,
        end,
      });
    }
    runStart = runEnd;
  });
  return segments;
}

function textStyle(
  marks: readonly RichTextMark[],
  writingStyle: WritingStyle,
  blockKind: RichTextBlock["kind"],
): React.CSSProperties {
  return {
    fontFamily: marks.includes("code")
      ? "ui-monospace, SFMono-Regular, Consolas, monospace"
      : writingStyle === "handwritten"
        ? '"Segoe Print", "Bradley Hand", cursive'
        : 'Aptos, "Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
    fill: blockKind === "quote" ? "#46544d" : "#20231f",
    fontStyle: marks.includes("italic") || blockKind === "quote" ? "italic" : "normal",
    fontWeight: marks.includes("bold") || blockKind === "heading" ? 700 : 400,
  };
}

function PaperRules({ snapshot }: Readonly<{ snapshot: PageLayoutSnapshot }>): React.JSX.Element | null {
  if (snapshot.paper === "blank") return null;
  const { pageBounds, contentRect, firstBaselineY, ruleSpacing } = snapshot.metrics;
  const horizontal = Array.from(
    { length: Math.max(0, Math.ceil((pageBounds.height - firstBaselineY) / ruleSpacing) + 1) },
    (_, index) => firstBaselineY + index * ruleSpacing,
  ).filter((y) => y <= pageBounds.height);
  const vertical = snapshot.paper === "grid"
    ? Array.from({ length: Math.ceil(pageBounds.width / ruleSpacing) + 1 }, (_, index) => index * ruleSpacing)
    : [];
  return (
    <g className="page-paper-rules" aria-hidden="true">
      {horizontal.map((y) => (
        <line key={`h:${y}`} data-paper-rule x1={0} x2={pageBounds.width} y1={y} y2={y} />
      ))}
      {vertical.map((x) => (
        <line key={`v:${x}`} data-paper-rule x1={x} x2={x} y1={0} y2={pageBounds.height} />
      ))}
      {snapshot.paper === "lined" ? (
        <line className="page-paper-margin" x1={contentRect.x - 20} x2={contentRect.x - 20} y1={0} y2={pageBounds.height} />
      ) : null}
    </g>
  );
}

function RichTextGraphic({
  element,
  snapshot,
  writingStyle,
}: Readonly<{
  element: TextElement;
  snapshot: PageLayoutSnapshot;
  writingStyle: WritingStyle;
}>): React.JSX.Element {
  const layout = snapshot.elements.get(element.id);
  const blocks = new Map(element.content.blocks.map((block) => [block.id, block]));
  const numberedOrdinals = new Map<RichTextBlock["id"], number>();
  let numberedOrdinal = 0;
  for (const block of element.content.blocks) {
    if (block.kind !== "ordered-list-item") continue;
    numberedOrdinal += 1;
    numberedOrdinals.set(block.id, numberedOrdinal);
  }
  const underlinePaths: React.JSX.Element[] = [];
  return (
    <g className="page-text-reveal" data-element-id={element.id} data-element-kind="text" aria-hidden="true">
      {layout?.textLines.flatMap((line, lineIndex) => {
        const block = blocks.get(line.blockId);
        if (block === undefined) return [];
        const fontSize = block.kind === "heading" ? snapshot.metrics.fontSize * 1.42 : snapshot.metrics.fontSize;
        const firstLine = line.start === 0;
        const decoration: React.JSX.Element[] = [];
        if (block.kind === "quote") {
          decoration.push(
            <line
              key={`quote:${line.blockId}:${line.start}`}
              className="page-quote-rule"
              x1={line.rect.x - 16}
              x2={line.rect.x - 16}
              y1={line.baseline - snapshot.metrics.lineHeight + 4}
              y2={line.baseline + 5}
              style={{ animationDelay: `${Math.min(160, lineIndex * 18)}ms` }}
            />,
          );
        } else if (firstLine && (block.kind === "bullet-list-item" || block.kind === "ordered-list-item")) {
          const marker = block.kind === "bullet-list-item" ? "•" : `${numberedOrdinals.get(block.id) ?? 1}.`;
          decoration.push(
            <text
              key={`marker:${line.blockId}`}
              className="page-list-marker"
              x={line.rect.x - 20}
              y={line.baseline}
              fontSize={snapshot.metrics.fontSize}
              style={{ animationDelay: `${Math.min(160, lineIndex * 18)}ms` }}
            >
              {marker}
            </text>,
          );
        }
        const segments = lineSegments(block, line).map((segment) => {
          if (segment.marks.includes("underline")) {
            const geometry = underlineGeometry({
              target: {
                x: segment.x,
                y: line.baseline - fontSize,
                width: segment.width,
                height: fontSize,
              },
              seed: `${element.id}:${line.blockId}:${segment.start}`,
              pageBounds: snapshot.metrics.pageBounds,
            });
            underlinePaths.push(
              <path key={`underline:${segment.key}`} className="page-ink-underline" d={pathData(geometry.path)} />,
            );
          }
          return (
            <text
              key={segment.key}
              className={`page-rich-text page-rich-text--${block.kind}`}
              x={segment.x}
              y={line.baseline}
              data-baseline={line.baseline}
              fontSize={fontSize}
              style={{
                ...textStyle(segment.marks, writingStyle, block.kind),
                animationDelay: `${Math.min(160, lineIndex * 18)}ms`,
              }}
              textLength={block.kind === "heading" ? undefined : segment.width}
              lengthAdjust={block.kind === "heading" ? undefined : "spacingAndGlyphs"}
              xmlSpace="preserve"
            >
              {segment.text}
            </text>
          );
        });
        return [...decoration, ...segments];
      })}
      {underlinePaths}
    </g>
  );
}

function StrokeGraphic({ element }: Readonly<{ element: StrokeElement }>): React.JSX.Element {
  return (
    <path
      data-element-id={element.id}
      data-element-kind="stroke"
      d={pathData(element.points)}
      fill="none"
      stroke={element.color}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={element.width}
    />
  );
}

export function VectorInkDocumentGraphic({
  document,
  pathKeyPrefix,
}: Readonly<{
  document: VectorInkDocument;
  pathKeyPrefix: string;
}>): React.JSX.Element {
  return (
    <>
      {document.paths.map((path, index) => {
        const paint = vectorInkPaint(path.paint);
        return (
          <path
            key={`${pathKeyPrefix}:path:${index}`}
            d={vectorInkPathData(path.commands)}
            fill={vectorInkColorValue(paint.fill) ?? "none"}
            stroke={vectorInkColorValue(paint.stroke) ?? "none"}
            strokeLinecap={paint.linecap}
            strokeLinejoin={paint.linejoin}
            strokeWidth={paint.strokeWidth}
          />
        );
      })}
    </>
  );
}

export function VectorInkGraphic({ element }: Readonly<{ element: PageVectorInkElement }>): React.JSX.Element {
  const { frame, document } = element;
  const scale = Math.min(
    frame.width / document.viewBox.width,
    frame.height / document.viewBox.height,
  );
  const x = frame.x + (frame.width - document.viewBox.width * scale) / 2;
  const y = frame.y + (frame.height - document.viewBox.height * scale) / 2;
  return (
    <g
      data-element-id={element.id}
      data-element-kind="vector-ink"
      aria-hidden="true"
      transform={`translate(${x} ${y}) scale(${scale})`}
    >
      <VectorInkDocumentGraphic document={document} pathKeyPrefix={element.id} />
    </g>
  );
}

function ShapeGraphic({ element, arrowMarkerId }: Readonly<{ element: ShapeElement; arrowMarkerId: string }>): React.JSX.Element {
  const common = {
    "data-element-id": element.id,
    "data-element-kind": "shape",
    fill: element.fill ?? "none",
    stroke: element.stroke,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 2.25,
  };
  if (element.shape === "ellipse") {
    return <ellipse {...common} cx={element.frame.x + element.frame.width / 2} cy={element.frame.y + element.frame.height / 2} rx={element.frame.width / 2} ry={element.frame.height / 2} />;
  }
  if (element.shape === "arrow") {
    return <line {...common} x1={element.frame.x} y1={element.frame.y + element.frame.height} x2={element.frame.x + element.frame.width} y2={element.frame.y} markerEnd={`url(#${arrowMarkerId})`} />;
  }
  return <rect {...common} x={element.frame.x} y={element.frame.y} width={element.frame.width} height={element.frame.height} rx={5} />;
}

function annotationTargets(annotation: AnnotationElement, snapshot: PageLayoutSnapshot): readonly PageRect[] {
  if (annotation.anchor.kind === "text-range") return textRangeRects(snapshot, annotation.anchor);
  const target = snapshot.elements.get(annotation.anchor.elementId);
  return target === undefined ? [] : [target.frame];
}

function AnnotationGraphic({ annotation, snapshot }: Readonly<{ annotation: AnnotationElement; snapshot: PageLayoutSnapshot }>): React.JSX.Element {
  const targets = annotationTargets(annotation, snapshot);
  if (annotation.reviewKind !== undefined && annotation.text !== undefined) {
    const target = nearestRelationshipTarget(annotation.frame, targets);
    const connector = target === null
      ? null
      : connectedArrowGeometry({
          source: annotation.frame,
          target,
          seed: annotation.id,
          pageBounds: snapshot.metrics.pageBounds,
        });
    const lines = wrapReviewCalloutText(annotation.text, annotation.frame.width);
    return (
      <g
        data-element-id={annotation.id}
        data-element-kind="annotation"
        data-review-kind={annotation.reviewKind}
        aria-label={`${annotation.label}: ${annotation.text}`}
      >
        {connector === null ? null : (
          <path
            className="page-ink-annotation page-ink-annotation--arrow page-review-callout-connector"
            d={pathData(connector.path)}
          />
        )}
        <rect
          className="page-review-callout"
          x={annotation.frame.x}
          y={annotation.frame.y}
          width={annotation.frame.width}
          height={annotation.frame.height}
          rx={8}
        />
        <text
          className="page-review-callout-heading"
          x={annotation.frame.x + 12}
          y={annotation.frame.y + 22}
        >
          {annotation.label}
        </text>
        <text
          className="page-review-callout-body"
          x={annotation.frame.x + 12}
          y={annotation.frame.y + 44}
        >
          {lines.map((line, index) => (
            <tspan key={`${annotation.id}:line:${index}`} x={annotation.frame.x + 12} dy={index === 0 ? 0 : 17}>
              {line}{index < lines.length - 1 ? " " : ""}
            </tspan>
          ))}
        </text>
      </g>
    );
  }
  const source = annotation.annotation === "arrow" && annotation.sourceElementId !== undefined
    ? snapshot.elements.get(annotation.sourceElementId)?.frame
    : undefined;
  return (
    <g data-element-id={annotation.id} data-element-kind="annotation" aria-label={annotation.label}>
      {targets.map((target, index) => {
        const input = { target, seed: `${annotation.id}:${index}`, pageBounds: snapshot.metrics.pageBounds } as const;
        const geometry = annotation.annotation === "circle"
          ? circleGeometry(input)
          : annotation.annotation === "highlight"
            ? highlightGeometry(input)
            : annotation.annotation === "arrow"
              ? source === undefined
                ? arrowGeometry(input)
                : connectedArrowGeometry({ source, target, seed: `${annotation.id}:${index}`, pageBounds: snapshot.metrics.pageBounds })
              : labelGeometry(input);
        return (
          <path
            key={`${annotation.id}:${index}`}
            className={`page-ink-annotation page-ink-annotation--${annotation.annotation}`}
            d={pathData(geometry.path)}
          />
        );
      })}
      {annotation.annotation === "label" && annotation.text !== undefined ? (
        <text className="page-annotation-label" x={annotation.frame.x} y={annotation.frame.y + 16}>{annotation.text}</text>
      ) : null}
    </g>
  );
}

function SemanticRun({ run }: Readonly<{ run: RichTextBlock["runs"][number] }>): React.JSX.Element {
  let content: React.ReactNode = run.text;
  if (run.marks.includes("code")) content = <code>{content}</code>;
  if (run.marks.includes("underline")) content = <u>{content}</u>;
  if (run.marks.includes("italic")) content = <em>{content}</em>;
  if (run.marks.includes("bold")) content = <strong>{content}</strong>;
  return <>{content}</>;
}

function SemanticBlockContent({ block }: Readonly<{ block: RichTextBlock }>): React.JSX.Element {
  return (
    <>
      {block.runs.map((run, index) => (
        <SemanticRun key={`${block.id}:run:${index}`} run={run} />
      ))}
    </>
  );
}

function SemanticBlocks({ blocks }: Readonly<{ blocks: readonly RichTextBlock[] }>): React.JSX.Element {
  const rendered: React.JSX.Element[] = [];
  let index = 0;
  while (index < blocks.length) {
    const block = blocks[index];
    if (block === undefined) break;
    if (block.kind === "bullet-list-item" || block.kind === "ordered-list-item") {
      const listKind = block.kind;
      const items: RichTextBlock[] = [];
      while (blocks[index]?.kind === listKind) {
        const item = blocks[index];
        if (item !== undefined) items.push(item);
        index += 1;
      }
      const listItems = items.map((item) => (
        <li key={item.id}><SemanticBlockContent block={item} /></li>
      ));
      rendered.push(listKind === "bullet-list-item"
        ? <ul key={`list:${block.id}`}>{listItems}</ul>
        : <ol key={`list:${block.id}`}>{listItems}</ol>);
      continue;
    }
    if (block.kind === "heading") {
      rendered.push(<h3 key={block.id}><SemanticBlockContent block={block} /></h3>);
    } else if (block.kind === "quote") {
      rendered.push(<blockquote key={block.id}><SemanticBlockContent block={block} /></blockquote>);
    } else {
      rendered.push(<p key={block.id}><SemanticBlockContent block={block} /></p>);
    }
    index += 1;
  }
  return <>{rendered}</>;
}

type NonTextPageElement = Exclude<PageElement, TextElement>;

function nonTextDescription(element: NonTextPageElement): string {
  switch (element.kind) {
    case "stroke":
      return `${element.label}: freehand stroke.`;
    case "shape":
      return `${element.label}: ${element.shape} shape.`;
    case "annotation":
      return element.text === undefined
        ? `${element.label}: ${element.annotation} annotation.`
        : `${element.label}: ${element.text}`;
    case "diagram":
      return `${element.label}: diagram.`;
    case "vector-ink":
      return `${element.label}: ${element.description}`;
    case "embedded-frame":
      return `${element.label}: embedded interactive item.`;
    default: {
      const exhaustive: never = element;
      return exhaustive;
    }
  }
}

function SemanticNonText({ element }: Readonly<{ element: NonTextPageElement }>): React.JSX.Element {
  const description = nonTextDescription(element);
  if (element.kind === "annotation") {
    return (
      <aside aria-label={element.label}>
        {element.reviewKind === undefined ? description : <><strong>{element.label}</strong> {element.text}</>}
      </aside>
    );
  }
  return (
    <figure aria-label={element.label}>
      <figcaption>{description}</figcaption>
    </figure>
  );
}

function SemanticText({ page }: Readonly<{ page: PageRecord }>): React.JSX.Element {
  const textElements = page.elements.filter((element): element is TextElement => element.kind === "text");
  const nonTextElements = page.elements.filter((element): element is NonTextPageElement => element.kind !== "text");
  return (
    <div className="visually-hidden page-semantic-copy">
      {textElements.map((element) => (
        <section key={element.id} aria-label={element.label}>
          <SemanticBlocks blocks={element.content.blocks} />
        </section>
      ))}
      {nonTextElements.map((element) => <SemanticNonText key={element.id} element={element} />)}
    </div>
  );
}

export function PageSurface({ page, notebookTitle, focused, writingStyle, onFocus, onTextEdit, interactionDisabled = false, graphics = { kind: "svg" }, diagrams = [], onDiagramNodeMove, embeddedComponents = [], arrangement }: PageSurfaceProps): React.JSX.Element {
  const snapshot = useMemo(() => layoutPage(page), [page]);
  const arrangementDragRef = useRef<ArrangementDrag | null>(null);
  const arrowMarkerId = `page-arrowhead-${page.number}`;
  const textElements = page.elements.filter((element): element is TextElement => element.kind === "text");
  const vectorInkElements = page.elements.filter((element): element is PageVectorInkElement => element.kind === "vector-ink");
  const strokes = page.elements.filter((element): element is StrokeElement => element.kind === "stroke");
  const shapes = page.elements.filter((element): element is ShapeElement => element.kind === "shape");
  const annotations = page.elements.filter((element): element is AnnotationElement => element.kind === "annotation");
  const updateArrangementFromKeyboard = (mode: ArrangementDrag["mode"], event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (arrangement === undefined || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 24 : 8;
    if (mode === "move") {
      arrangement.onFrameChange({
        ...arrangement.frame,
        x: arrangement.frame.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
        y: arrangement.frame.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0),
      });
      return;
    }
    arrangement.onFrameChange({
      ...arrangement.frame,
      width: Math.max(1, arrangement.frame.width + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0)),
      height: Math.max(1, arrangement.frame.height + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0)),
    });
  };
  const beginArrangementDrag = (mode: ArrangementDrag["mode"], event: React.PointerEvent<HTMLButtonElement>): void => {
    if (arrangement === undefined) return;
    const surface = event.currentTarget.closest<HTMLElement>(".page-surface");
    if (surface === null) return;
    const bounds = surface.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    arrangementDragRef.current = {
      pointerId: event.pointerId,
      mode,
      clientX: event.clientX,
      clientY: event.clientY,
      frame: arrangement.frame,
      surfaceWidth: bounds.width,
      surfaceHeight: bounds.height,
    };
  };
  const continueArrangementDrag = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const drag = arrangementDragRef.current;
    if (arrangement === undefined || drag === null || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const dx = (event.clientX - drag.clientX) * (page.size.width / drag.surfaceWidth);
    const dy = (event.clientY - drag.clientY) * (page.size.height / drag.surfaceHeight);
    arrangement.onFrameChange(drag.mode === "move"
      ? { ...drag.frame, x: drag.frame.x + dx, y: drag.frame.y + dy }
      : { ...drag.frame, width: Math.max(1, drag.frame.width + dx), height: Math.max(1, drag.frame.height + dy) });
  };
  const endArrangementDrag = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (arrangementDragRef.current?.pointerId !== event.pointerId) return;
    arrangementDragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  return (
    <article
      className="notebook-sheet page-surface"
      aria-label={`${notebookTitle}, page ${page.number}`}
      data-page-id={page.id}
      data-page-number={page.number}
      data-page-paper={snapshot.paper}
      data-page-revision={page.revision}
      data-page-focused={focused || undefined}
      data-graphics-renderer={graphics.kind}
      inert={interactionDisabled || undefined}
      style={{ aspectRatio: `${page.size.width} / ${page.size.height}` }}
      tabIndex={interactionDisabled ? -1 : 0}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest(".page-embedded-component-layer, .page-element-placement-preview") !== null) return;
        onFocus();
      }}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onFocus();
      }}
    >
      <h2 className="visually-hidden">{notebookTitle}, page {page.number}</h2>
      <svg
        className="page-scene"
        viewBox={`0 0 ${page.size.width} ${page.size.height}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <marker id={arrowMarkerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
            <path d="M0 0 L8 4 L0 8" fill="none" stroke="context-stroke" />
          </marker>
        </defs>
        <PaperRules snapshot={snapshot} />
        <text aria-hidden="true" className="page-title-ink" x={snapshot.metrics.contentRect.x} y={snapshot.metrics.contentRect.y - 18}>{notebookTitle}</text>
        {textElements.map((element) => <RichTextGraphic key={element.id} element={element} snapshot={snapshot} writingStyle={writingStyle} />)}
        {diagrams.map((diagram) => (
          <NativeDiagram
            key={diagram.id}
            diagram={diagram}
            {...(onDiagramNodeMove === undefined ? {} : {
              onNodeMove: (nodeId: string, position: DiagramNodePosition) => onDiagramNodeMove(diagram.id, nodeId, position),
            })}
          />
        ))}
        {vectorInkElements.map((element) => <VectorInkGraphic key={element.id} element={element} />)}
        {shapes.map((element) => <ShapeGraphic key={element.id} element={element} arrowMarkerId={arrowMarkerId} />)}
        {strokes.map((element) => <StrokeGraphic key={element.id} element={element} />)}
        {annotations.map((annotation) => <AnnotationGraphic key={annotation.id} annotation={annotation} snapshot={snapshot} />)}
      </svg>
      {focused && onTextEdit !== undefined ? textElements.map((element) => (
        <button
          key={`edit-${element.id}`}
          className="page-text-edit-target"
          type="button"
          aria-label={`Edit ${element.label}`}
          data-text-edit-element-id={element.id}
          style={{
            left: `${(element.frame.x / page.size.width) * 100}%`,
            top: `${(element.frame.y / page.size.height) * 100}%`,
            width: `${(element.frame.width / page.size.width) * 100}%`,
            height: `${(element.frame.height / page.size.height) * 100}%`,
          }}
          onClick={(event) => {
            event.stopPropagation();
            onFocus();
            onTextEdit(element.id);
          }}
        >
          <span className="visually-hidden">Edit {element.label}</span>
        </button>
      )) : null}
      {embeddedComponents.map((component) => (
        <section
          key={component.elementId}
          className="page-embedded-component-layer"
          aria-label={component.label}
          data-element-id={component.elementId}
          data-element-kind="embedded-frame"
          data-presentation={component.presentation ?? "framed"}
          style={{
            left: `${(component.frame.x / page.size.width) * 100}%`,
            top: `${(component.frame.y / page.size.height) * 100}%`,
            width: `${(component.frame.width / page.size.width) * 100}%`,
            height: `${(component.frame.height / page.size.height) * 100}%`,
          }}
        >
          {component.layer}
        </section>
      ))}
      {arrangement === undefined ? null : (
        <div
          className="page-element-placement-preview"
          role="group"
          aria-label={`Placement preview for ${arrangement.label}`}
          data-element-id={arrangement.elementId}
          data-element-kind={arrangement.kind}
          style={{
            left: `${(arrangement.frame.x / page.size.width) * 100}%`,
            top: `${(arrangement.frame.y / page.size.height) * 100}%`,
            width: `${(arrangement.frame.width / page.size.width) * 100}%`,
            height: `${(arrangement.frame.height / page.size.height) * 100}%`,
          }}
        >
          <span className="page-element-placement-label" aria-hidden="true">{arrangement.label}</span>
          <button
            type="button"
            className="page-element-move-handle"
            aria-label={`Move ${arrangement.label}`}
            title="Drag to move. Arrow keys move by 8; Shift and an arrow move by 24."
            onKeyDown={(event) => updateArrangementFromKeyboard("move", event)}
            onPointerDown={(event) => beginArrangementDrag("move", event)}
            onPointerMove={continueArrangementDrag}
            onPointerUp={endArrangementDrag}
            onPointerCancel={endArrangementDrag}
          >
            <span aria-hidden="true">↕</span>
          </button>
          <button
            type="button"
            className="page-element-resize-handle"
            aria-label={`Resize ${arrangement.label}`}
            title="Drag to resize. Arrow keys change size by 8; Shift and an arrow change it by 24."
            onKeyDown={(event) => updateArrangementFromKeyboard("resize", event)}
            onPointerDown={(event) => beginArrangementDrag("resize", event)}
            onPointerMove={continueArrangementDrag}
            onPointerUp={endArrangementDrag}
            onPointerCancel={endArrangementDrag}
          >
            <span aria-hidden="true">↘</span>
          </button>
        </div>
      )}
      <SemanticText page={page} />
      <span className="page-number" aria-hidden="true">{page.number}</span>
    </article>
  );
}
