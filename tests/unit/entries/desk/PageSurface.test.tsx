import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createIsoInstant, createNotebookId } from "../../../../src/domain";
import { PageSurface } from "../../../../src/entries/desk/PageSurface";
import {
  createElementId,
  createEmptyPage,
  createPageRevision,
  createTextBlockId,
  richTextFromPlainText,
  validateDiagramDocument,
  type AnnotationElement,
  type DiagramElement,
  type PageVectorInkElement,
  type ShapeElement,
  type TextElement,
} from "../../../../src/page";

const at = createIsoInstant("2026-08-26T12:00:00.000Z");

function pageFixture() {
  const page = createEmptyPage(createNotebookId("surface-workbook"), 1, at);
  const text: TextElement = {
    kind: "text",
    id: createElementId("surface-text"),
    label: "Visible phrase",
    frame: { x: 96, y: 92, width: 380, height: 160 },
    content: richTextFromPlainText("A visible phrase on ruled paper.", createTextBlockId("surface-block")),
  };
  const shape: ShapeElement = {
    kind: "shape",
    id: createElementId("surface-shape"),
    label: "Green ellipse",
    frame: { x: 520, y: 180, width: 120, height: 80 },
    shape: "ellipse",
    fill: null,
    stroke: "#28785d",
  };
  const annotation: AnnotationElement = {
    kind: "annotation",
    id: createElementId("surface-annotation"),
    label: "Circle visible phrase",
    frame: { x: 96, y: 92, width: 140, height: 28 },
    annotation: "circle",
    anchor: {
      kind: "text-range",
      elementId: text.id,
      blockId: text.content.blocks[0]!.id,
      start: 2,
      end: 16,
    },
  };
  return { ...page, elements: [text, shape, annotation] };
}

describe("PageSurface", () => {
  it("renders one app-owned ruled scene and focuses the sheet", () => {
    const onFocus = vi.fn();
    const page = pageFixture();
    const { container } = render(
      <PageSurface
        page={page}
        notebookTitle="Inbox"
        focused={false}
        writingStyle="typed"
        onFocus={onFocus}
      />,
    );

    const surface = container.querySelector<HTMLElement>("article")!;
    expect(surface).toHaveAttribute("data-page-paper", "lined");
    expect(surface).toHaveAttribute("tabindex", "0");
    expect(surface.querySelectorAll("[data-paper-rule]").length).toBeGreaterThan(10);
    expect(surface.querySelector('[data-element-kind="text"]')).toHaveTextContent("A visible phrase on ruled paper.");
    expect(surface.querySelector('[data-element-kind="shape"]')).toBeInTheDocument();
    expect(surface.querySelector('[data-element-kind="annotation"] path')).toBeInTheDocument();
    expect(surface.querySelector(".tl-container")).not.toBeInTheDocument();

    fireEvent.click(surface);
    expect(onFocus).toHaveBeenCalledOnce();
  });

  it("keeps blank paper blank", () => {
    const page = { ...pageFixture(), paper: "blank" as const };
    const { container } = render(
      <PageSurface
        page={page}
        notebookTitle="Inbox"
        focused
        writingStyle="typed"
        onFocus={vi.fn()}
      />,
    );

    const surface = container.querySelector<HTMLElement>("article")!;
    expect(surface.querySelectorAll("[data-paper-rule]")).toHaveLength(0);
  });

  it("fits vector ink inside its frame without changing its aspect ratio", () => {
    const page = { ...createEmptyPage(createNotebookId("vector-fit"), 1, at), paper: "blank" as const };
    const vectorInk: PageVectorInkElement = {
      kind: "vector-ink",
      version: 1,
      id: createElementId("vector-fit-art"),
      label: "Square trace",
      description: "A square trace inside a wide frame.",
      frame: { x: 100, y: 300, width: 400, height: 100 },
      document: {
        version: 1,
        viewBox: { width: 100, height: 100 },
        paths: [{
          commands: [
            { kind: "move", x: 0, y: 0 },
            { kind: "line", x: 100, y: 0 },
            { kind: "line", x: 100, y: 100 },
            { kind: "line", x: 0, y: 100 },
            { kind: "close" },
          ],
          paint: { stroke: "ink", strokeWidth: 1, fill: null, linecap: "round", linejoin: "round" },
        }],
      },
    };
    const { container } = render(
      <PageSurface
        page={{ ...page, elements: [vectorInk] }}
        notebookTitle="Vector fit"
        focused
        writingStyle="typed"
        onFocus={vi.fn()}
      />,
    );

    expect(container.querySelector('[data-element-kind="vector-ink"]'))
      .toHaveAttribute("transform", "translate(250 300) scale(1)");
  });

  it("renders diagrams inside the shared page SVG without a framed diagram layer", () => {
    const page = { ...createEmptyPage(createNotebookId("diagram-surface"), 1, at), paper: "blank" as const };
    const diagram: DiagramElement = {
      kind: "diagram",
      id: createElementId("surface-diagram"),
      label: "Shared canvas flow",
      frame: { x: 92, y: 196, width: 632, height: 520 },
      engine: "native",
      engineVersion: 1,
      document: validateDiagramDocument({
        version: 1,
        layout: "flow",
        nodes: [
          { id: "request", label: "Describe the result", tone: "accent" },
          { id: "format", label: "Create and format notebook text", tone: "positive" },
        ],
        edges: [{ from: "request", to: "format" }],
      }),
    };
    const onDiagramNodeMove = vi.fn();
    const { container } = render(
      <PageSurface
        page={{ ...page, elements: [diagram] }}
        notebookTitle="Shared canvas"
        focused
        writingStyle="typed"
        onFocus={vi.fn()}
        diagrams={[diagram]}
        onDiagramNodeMove={onDiagramNodeMove}
      />,
    );

    const scene = container.querySelector(".page-scene")!;
    const renderedDiagram = scene.querySelector('[data-element-kind="diagram"]');
    expect(renderedDiagram).toBeInTheDocument();
    expect(renderedDiagram?.parentElement).toBe(scene);
    expect(renderedDiagram).toHaveAttribute("x", "92");
    expect(renderedDiagram).toHaveAttribute("width", "632");
    expect(container.querySelector(".page-native-diagram-layer")).not.toBeInTheDocument();
    expect(renderedDiagram?.querySelectorAll("tspan").length).toBeGreaterThan(2);
    const requestNode = renderedDiagram?.querySelector('[data-diagram-node="request"]');
    expect(requestNode).toHaveAttribute("role", "button");
    expect(requestNode).toHaveAttribute("tabindex", "0");
    fireEvent.pointerDown(requestNode!, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(renderedDiagram!, { pointerId: 1, clientX: 102, clientY: 101 });
    fireEvent.pointerUp(renderedDiagram!, { pointerId: 1, clientX: 102, clientY: 101 });
    expect(onDiagramNodeMove).not.toHaveBeenCalled();
    fireEvent.keyDown(requestNode!, { key: "ArrowRight" });
    expect(onDiagramNodeMove).toHaveBeenCalledWith(
      diagram.id,
      "request",
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    );
  });

  it("keeps text graphics mounted when an unrelated page mutation advances the revision", () => {
    const page = pageFixture();
    const { container, rerender } = render(
      <PageSurface
        page={page}
        notebookTitle="Stable text"
        focused
        writingStyle="typed"
        onFocus={vi.fn()}
      />,
    );
    const before = container.querySelector('[data-element-kind="text"]');

    rerender(
      <PageSurface
        page={{ ...page, revision: createPageRevision(page.revision + 1) }}
        notebookTitle="Stable text"
        focused
        writingStyle="typed"
        onFocus={vi.fn()}
      />,
    );

    expect(container.querySelector('[data-element-kind="text"]')).toBe(before);
  });

  it("can yield the whole page surface while a modal editor owns interaction", () => {
    const { container } = render(
      <PageSurface
        page={pageFixture()}
        notebookTitle="Inbox"
        focused
        writingStyle="typed"
        onFocus={vi.fn()}
        interactionDisabled
      />,
    );

    expect(container.querySelector("article")).toHaveAttribute("inert");
  });

  it("preserves list structure, text marks, and concise non-text descriptions in semantic copy", () => {
    const page = pageFixture();
    const text = page.elements[0];
    if (text?.kind !== "text") throw new Error("Expected fixture text.");
    const semanticPage = {
      ...page,
      elements: [
        {
          ...text,
          content: {
            format: "rich_text" as const,
            blocks: [
              { id: createTextBlockId("semantic-heading"), kind: "heading" as const, runs: [{ text: "Plan", marks: [] }] },
              { id: createTextBlockId("semantic-bullet-1"), kind: "bullet-list-item" as const, runs: [{ text: "First", marks: ["bold" as const] }] },
              { id: createTextBlockId("semantic-bullet-2"), kind: "bullet-list-item" as const, runs: [{ text: "Second", marks: ["italic" as const] }] },
              { id: createTextBlockId("semantic-order-1"), kind: "ordered-list-item" as const, runs: [{ text: "Then", marks: ["code" as const] }] },
            ],
          },
        },
        ...page.elements.slice(1),
      ],
    };
    const { container } = render(
      <PageSurface
        page={semanticPage}
        notebookTitle="Inbox"
        focused
        writingStyle="typed"
        onFocus={vi.fn()}
      />,
    );

    const semanticCopy = container.querySelector(".page-semantic-copy")!;
    expect(semanticCopy.querySelectorAll("ul > li")).toHaveLength(2);
    expect(semanticCopy.querySelectorAll("ol > li")).toHaveLength(1);
    expect(semanticCopy.querySelector("strong")).toHaveTextContent("First");
    expect(semanticCopy.querySelector("em")).toHaveTextContent("Second");
    expect(semanticCopy.querySelector("code")).toHaveTextContent("Then");
    expect(semanticCopy).toHaveTextContent("Green ellipse: ellipse shape.");
    expect(semanticCopy).toHaveTextContent("Circle visible phrase: circle annotation.");
  });

  it("exposes visible move and resize handles with bounded keyboard preview steps", () => {
    const page = pageFixture();
    const target = page.elements[1]!;
    const onFrameChange = vi.fn();
    const { container, getByRole } = render(
      <PageSurface
        page={page}
        notebookTitle="Arrangement handles"
        focused
        writingStyle="typed"
        onFocus={vi.fn()}
        arrangement={{
          elementId: target.id,
          kind: target.kind,
          label: target.label,
          frame: target.frame,
          onFrameChange,
        }}
      />,
    );

    const preview = container.querySelector(".page-element-placement-preview");
    expect(preview).toHaveAttribute("data-element-id", target.id);
    const move = getByRole("button", { name: `Move ${target.label}` });
    const resize = getByRole("button", { name: `Resize ${target.label}` });
    fireEvent.keyDown(move, { key: "ArrowRight" });
    expect(onFrameChange).toHaveBeenLastCalledWith({ ...target.frame, x: target.frame.x + 8 });
    fireEvent.keyDown(resize, { key: "ArrowDown", shiftKey: true });
    expect(onFrameChange).toHaveBeenLastCalledWith({ ...target.frame, height: target.frame.height + 24 });
  });

  it("redraws a connected arrow when its source note moves", () => {
    const page = pageFixture();
    const source = page.elements[0]!;
    const target = page.elements[1]!;
    const arrow: AnnotationElement = {
      kind: "annotation",
      id: createElementId("connected-arrow"),
      label: "Why this matters",
      frame: { x: 96, y: 92, width: 544, height: 168 },
      annotation: "arrow",
      sourceElementId: source.id,
      anchor: { kind: "element", elementId: target.id },
    };
    const connected = { ...page, elements: [...page.elements, arrow] };
    const { container, rerender } = render(
      <PageSurface
        page={connected}
        notebookTitle="Inbox"
        focused
        writingStyle="handwritten"
        onFocus={vi.fn()}
      />,
    );
    const selector = `[data-element-id="${arrow.id}"] path`;
    const before = container.querySelector(selector)?.getAttribute("d");

    const moved = {
      ...connected,
      elements: connected.elements.map((element) => element.id === source.id
        ? { ...element, frame: { ...element.frame, x: 96, y: 420 } }
        : element),
    };
    rerender(
      <PageSurface
        page={moved}
        notebookTitle="Inbox"
        focused
        writingStyle="handwritten"
        onFocus={vi.fn()}
      />,
    );
    const after = container.querySelector(selector)?.getAttribute("d");

    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });

  it("renders a readable review callout and reconnects it after movement and text reflow", () => {
    const page = pageFixture();
    const text = page.elements[0]!;
    if (text.kind !== "text") throw new Error("Expected a text target.");
    const callout: AnnotationElement = {
      kind: "annotation",
      id: createElementId("review-callout"),
      label: "Suggested replacement",
      frame: { x: 96, y: 280, width: 220, height: 86 },
      annotation: "label",
      anchor: {
        kind: "text-range",
        elementId: text.id,
        blockId: text.content.blocks[0]!.id,
        start: 2,
        end: 16,
      },
      reviewKind: "replacement",
      text: "Use the approved wording instead.",
    };
    const reviewed = { ...page, elements: [...page.elements, callout] };
    const { container, rerender } = render(
      <PageSurface
        page={reviewed}
        notebookTitle="Inbox"
        focused
        writingStyle="typed"
        onFocus={vi.fn()}
      />,
    );
    const graphic = container.querySelector(`[data-element-id="${callout.id}"]`)!;
    expect(graphic.querySelector(".page-review-callout")).toBeInTheDocument();
    expect(graphic).toHaveTextContent("Suggested replacement");
    expect(graphic).toHaveTextContent("Use the approved wording instead.");
    const before = graphic.querySelector("path")?.getAttribute("d");

    const movedAndReflowed = {
      ...reviewed,
      elements: reviewed.elements.map((element) => {
        if (element.id === callout.id) return { ...element, frame: { ...element.frame, x: 460, y: 420 } };
        if (element.id === text.id && element.kind === "text") {
          return { ...element, frame: { ...element.frame, width: 240 } };
        }
        return element;
      }),
    };
    rerender(
      <PageSurface
        page={movedAndReflowed}
        notebookTitle="Inbox"
        focused
        writingStyle="typed"
        onFocus={vi.fn()}
      />,
    );
    const after = container.querySelector(`[data-element-id="${callout.id}"] path`)?.getAttribute("d");
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    expect(container.querySelector(".page-semantic-copy")).toHaveTextContent("Suggested replacement");
    expect(container.querySelector(".page-semantic-copy")).toHaveTextContent("Use the approved wording instead.");
  });
});
