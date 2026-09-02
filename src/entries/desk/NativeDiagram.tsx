import type { JSX } from "react";

import { useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import type {
  DiagramDocument,
  DiagramEdge,
  DiagramElement,
  DiagramNode,
  DiagramNodePosition,
  DiagramNodeTone,
} from "../../page/domain";

export type NativeDiagramProps = Readonly<{
  diagram: DiagramElement;
  className?: string;
  onNodeMove?: (nodeId: string, position: DiagramNodePosition) => Promise<boolean>;
}>;

type Point = Readonly<{ x: number; y: number }>;
type NodeBox = Readonly<{
  node: DiagramNode;
  x: number;
  y: number;
  width: number;
  height: number;
}>;
type EdgeGeometry = Readonly<{
  start: Point;
  end: Point;
  arrowPoints: string;
  label: Point;
  length: number;
}>;
type DiagramMetrics = Readonly<{
  width: number;
  height: number;
  nodeWidth: number;
  nodeHeight: number;
  margin: number;
  fontSize: number;
  lineHeight: number;
}>;
type DiagramDrag = {
  nodeId: string;
  pointerId: number;
  moved: boolean;
  startClientX: number;
  startClientY: number;
  offsetX: number;
  offsetY: number;
};

const ARROW_LENGTH = 13;
const ARROW_HALF_WIDTH = 6;

const NODE_COLORS: Readonly<Record<DiagramNodeTone, Readonly<{ fill: string; stroke: string; text: string }>>> = {
  neutral: { fill: "#fffdf7", stroke: "#4a514b", text: "#202521" },
  accent: { fill: "#e5efe9", stroke: "#315e49", text: "#173b2c" },
  positive: { fill: "#eaf3dc", stroke: "#567039", text: "#2f431f" },
  warning: { fill: "#faedcf", stroke: "#8a6529", text: "#563f18" },
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function diagramMetrics(diagram: DiagramElement): DiagramMetrics {
  const width = diagram.frame.width;
  const height = diagram.frame.height;
  const fontSize = clamp(width / 42, 11, 15);
  return {
    width,
    height,
    nodeWidth: clamp(width * 0.24, 86, 150),
    nodeHeight: clamp(height * 0.16, 62, 84),
    margin: clamp(Math.min(width, height) * 0.035, 10, 18),
    fontSize,
    lineHeight: fontSize * 1.18,
  };
}

function flowLayout(nodes: readonly DiagramNode[], metrics: DiagramMetrics): readonly NodeBox[] {
  const columns = Math.min(4, nodes.length);
  const rows = Math.ceil(nodes.length / columns);
  const horizontalStep = columns === 1
    ? 0
    : (metrics.width - metrics.margin * 2 - metrics.nodeWidth) / (columns - 1);
  const verticalStep = rows === 1
    ? 0
    : (metrics.height - metrics.margin * 2 - metrics.nodeHeight) / (rows - 1);

  return nodes.map((node, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      node,
      x: columns === 1 ? (metrics.width - metrics.nodeWidth) / 2 : metrics.margin + column * horizontalStep,
      y: rows === 1 ? (metrics.height - metrics.nodeHeight) / 2 : metrics.margin + row * verticalStep,
      width: metrics.nodeWidth,
      height: metrics.nodeHeight,
    };
  });
}

function radialLayout(nodes: readonly DiagramNode[], centerFirst: boolean, metrics: DiagramMetrics): readonly NodeBox[] {
  if (centerFirst && nodes.length === 1) {
    return [{
      node: nodes[0]!,
      x: (metrics.width - metrics.nodeWidth) / 2,
      y: (metrics.height - metrics.nodeHeight) / 2,
      width: metrics.nodeWidth,
      height: metrics.nodeHeight,
    }];
  }

  const firstRingIndex = centerFirst ? 1 : 0;
  const ringCount = nodes.length - firstRingIndex;
  return nodes.map((node, index) => {
    if (centerFirst && index === 0) {
      return {
        node,
        x: (metrics.width - metrics.nodeWidth) / 2,
        y: (metrics.height - metrics.nodeHeight) / 2,
        width: metrics.nodeWidth,
        height: metrics.nodeHeight,
      };
    }
    const ringIndex = index - firstRingIndex;
    const angle = -Math.PI / 2 + (Math.PI * 2 * ringIndex) / ringCount;
    return {
      node,
      x: metrics.width / 2 + Math.cos(angle) * ((metrics.width - metrics.nodeWidth) / 2 - metrics.margin) - metrics.nodeWidth / 2,
      y: metrics.height / 2 + Math.sin(angle) * ((metrics.height - metrics.nodeHeight) / 2 - metrics.margin) - metrics.nodeHeight / 2,
      width: metrics.nodeWidth,
      height: metrics.nodeHeight,
    };
  });
}

function positionedBox(box: NodeBox, position: DiagramNodePosition, metrics: DiagramMetrics): NodeBox {
  return {
    ...box,
    x: (position.x / 100) * Math.max(0, metrics.width - box.width),
    y: (position.y / 100) * Math.max(0, metrics.height - box.height),
  };
}

function layoutNodes(
  document: DiagramDocument,
  metrics: DiagramMetrics,
  overrides: Readonly<Record<string, DiagramNodePosition>> = {},
): readonly NodeBox[] {
  let automatic: readonly NodeBox[];
  switch (document.layout) {
    case "flow":
      automatic = flowLayout(document.nodes, metrics);
      break;
    case "mind-map":
      automatic = radialLayout(document.nodes, true, metrics);
      break;
    case "cycle":
      automatic = radialLayout(document.nodes, false, metrics);
      break;
    default: {
      const exhaustive: never = document.layout;
      return exhaustive;
    }
  }
  return automatic.map((box) => {
    const position = overrides[box.node.id] ?? box.node.position;
    return position === undefined ? box : positionedBox(box, position, metrics);
  });
}

function center(box: NodeBox): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function boundaryPoint(box: NodeBox, toward: Point): Point {
  const origin = center(box);
  const dx = toward.x - origin.x;
  const dy = toward.y - origin.y;
  if (dx === 0 && dy === 0) return origin;
  const scale = 1 / Math.max(Math.abs(dx) / (box.width / 2), Math.abs(dy) / (box.height / 2));
  return { x: origin.x + dx * scale, y: origin.y + dy * scale };
}

function edgeGeometry(source: NodeBox, target: NodeBox): EdgeGeometry {
  const sourceCenter = center(source);
  const targetCenter = center(target);
  const start = boundaryPoint(source, targetCenter);
  const end = boundaryPoint(target, sourceCenter);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  const ux = length === 0 ? 1 : dx / length;
  const uy = length === 0 ? 0 : dy / length;
  const baseX = end.x - ux * ARROW_LENGTH;
  const baseY = end.y - uy * ARROW_LENGTH;
  const left = { x: baseX - uy * ARROW_HALF_WIDTH, y: baseY + ux * ARROW_HALF_WIDTH };
  const right = { x: baseX + uy * ARROW_HALF_WIDTH, y: baseY - ux * ARROW_HALF_WIDTH };
  const labelOffset = clamp(length * 0.18, 18, 34);
  return {
    start,
    end,
    arrowPoints: `${end.x},${end.y} ${left.x},${left.y} ${right.x},${right.y}`,
    label: {
      x: (start.x + end.x) / 2 - uy * labelOffset,
      y: (start.y + end.y) / 2 + ux * labelOffset,
    },
    length,
  };
}

function labelLines(label: string, maximum: number): readonly string[] {
  const words = label.split(" ").flatMap((word) => {
    if (word.length <= maximum) return [word];
    const parts: string[] = [];
    for (let index = 0; index < word.length; index += maximum) {
      parts.push(word.slice(index, index + maximum));
    }
    return parts;
  });
  const lines: string[] = [];
  for (const word of words) {
    const last = lines.at(-1);
    if (last !== undefined && `${last} ${word}`.length <= maximum) {
      lines[lines.length - 1] = `${last} ${word}`;
    } else {
      lines.push(word);
    }
  }
  return lines;
}

function fittedLabelLines(label: string, maximum: number, maximumLines: number): readonly string[] {
  const lines = labelLines(label, maximum);
  if (lines.length <= maximumLines) return lines;
  const fitted = lines.slice(0, maximumLines);
  const last = fitted.at(-1) ?? "";
  fitted[fitted.length - 1] = `${last.slice(0, Math.max(1, maximum - 1))}…`;
  return fitted;
}

function EdgeGraphic({ edge, boxes, fontSize }: Readonly<{
  edge: DiagramEdge;
  boxes: ReadonlyMap<string, NodeBox>;
  fontSize: number;
}>): JSX.Element | null {
  const source = boxes.get(edge.from);
  const target = boxes.get(edge.to);
  if (source === undefined || target === undefined) return null;
  const geometry = edgeGeometry(source, target);
  const edgeLabelLines = edge.label === undefined || geometry.length < Math.max(source.width, target.width) * 0.65
    ? []
    : fittedLabelLines(edge.label, 14, 2);
  const edgeLineHeight = Math.max(12, fontSize * 1.08);
  const edgeFirstBaseline = geometry.label.y - ((edgeLabelLines.length - 1) * edgeLineHeight) / 2;
  return (
    <g data-diagram-edge={`${edge.from}:${edge.to}`}>
      <line
        x1={geometry.start.x}
        y1={geometry.start.y}
        x2={geometry.end.x}
        y2={geometry.end.y}
        stroke="#4a514b"
        strokeWidth="2.5"
        vectorEffect="non-scaling-stroke"
      />
      <polygon data-arrowhead="true" points={geometry.arrowPoints} fill="#4a514b" />
      {edgeLabelLines.length === 0 ? null : (
        <text
          x={geometry.label.x}
          y={edgeFirstBaseline}
          textAnchor="middle"
          fontSize={Math.max(10, fontSize - 2)}
          fontWeight="600"
          fill="#303630"
          stroke="#ffffff"
          strokeWidth="5"
          paintOrder="stroke"
        >
          {edgeLabelLines.map((line, index) => (
            <tspan key={`${edge.from}:${edge.to}:label:${index}`} x={geometry.label.x} dy={index === 0 ? 0 : edgeLineHeight}>
              {line}
            </tspan>
          ))}
        </text>
      )}
    </g>
  );
}

function NodeGraphic({ box, metrics, interactive, selected, onPointerDown, onKeyDown }: Readonly<{
  box: NodeBox;
  metrics: DiagramMetrics;
  interactive: boolean;
  selected: boolean;
  onPointerDown: (event: ReactPointerEvent<SVGGElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<SVGGElement>) => void;
}>): JSX.Element {
  const colors = NODE_COLORS[box.node.tone ?? "neutral"];
  const charactersPerLine = Math.max(10, Math.floor(box.width / (metrics.fontSize * 0.58)));
  const maximumLines = Math.max(1, Math.floor((box.height - metrics.fontSize) / metrics.lineHeight));
  const lines = fittedLabelLines(box.node.label, charactersPerLine, maximumLines);
  const firstBaseline = box.y + box.height / 2 - ((lines.length - 1) * metrics.lineHeight) / 2 + metrics.fontSize * 0.34;
  return (
    <g
      data-diagram-node={box.node.id}
      data-selected={selected || undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? `Move ${box.node.label}` : undefined}
      onPointerDown={interactive ? onPointerDown : undefined}
      onKeyDown={interactive ? onKeyDown : undefined}
    >
      <rect
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        rx="15"
        fill={colors.fill}
        stroke={colors.stroke}
        strokeWidth="2.5"
        vectorEffect="non-scaling-stroke"
      />
      <text
        x={box.x + box.width / 2}
        y={firstBaseline}
        textAnchor="middle"
        fontFamily="system-ui, sans-serif"
        fontSize={metrics.fontSize}
        fontWeight="650"
        fill={colors.text}
      >
        {lines.map((line, index) => (
          <tspan key={`${box.node.id}:${index}`} x={box.x + box.width / 2} dy={index === 0 ? 0 : metrics.lineHeight}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
}

function positionForBox(box: NodeBox, metrics: DiagramMetrics): DiagramNodePosition {
  return {
    x: (box.x / Math.max(1, metrics.width - box.width)) * 100,
    y: (box.y / Math.max(1, metrics.height - box.height)) * 100,
  };
}

export function NativeDiagram({ diagram, className, onNodeMove }: NativeDiagramProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DiagramDrag | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [previewPositions, setPreviewPositions] = useState<Readonly<Record<string, DiagramNodePosition>>>({});
  const metrics = diagramMetrics(diagram);
  const boxes = layoutNodes(diagram.document, metrics, previewPositions);
  const boxesById = new Map(boxes.map((box) => [box.node.id, box]));
  const interactive = onNodeMove !== undefined;
  const clearPreview = (nodeId: string, position?: DiagramNodePosition): void => {
    setPreviewPositions((current) => {
      const preview = current[nodeId];
      if (preview === undefined || (position !== undefined && (preview.x !== position.x || preview.y !== position.y))) return current;
      const next = { ...current };
      delete next[nodeId];
      return next;
    });
  };
  const commitPosition = (nodeId: string, position: DiagramNodePosition): void => {
    const committed = onNodeMove?.(nodeId, position);
    if (committed === undefined) return;
    void committed.then(() => clearPreview(nodeId, position)).catch(() => clearPreview(nodeId, position));
  };
  const moveFromPointer = (event: ReactPointerEvent<SVGSVGElement>): DiagramNodePosition | null => {
    const drag = dragRef.current;
    const box = drag === null ? undefined : boxesById.get(drag.nodeId);
    const rect = svgRef.current?.getBoundingClientRect();
    if (drag === null || box === undefined || rect === undefined || rect.width <= 0 || rect.height <= 0) return null;
    const x = ((event.clientX - rect.left) / rect.width) * metrics.width - drag.offsetX;
    const y = ((event.clientY - rect.top) / rect.height) * metrics.height - drag.offsetY;
    return {
      x: clamp((x / Math.max(1, metrics.width - box.width)) * 100, 0, 100),
      y: clamp((y / Math.max(1, metrics.height - box.height)) * 100, 0, 100),
    };
  };
  return (
    <svg
      ref={svgRef}
      className={["native-semantic-diagram", className].filter(Boolean).join(" ")}
      x={diagram.frame.x}
      y={diagram.frame.y}
      width={diagram.frame.width}
      height={diagram.frame.height}
      viewBox={`0 0 ${metrics.width} ${metrics.height}`}
      role={interactive ? "group" : "img"}
      aria-label={diagram.label}
      aria-hidden={interactive ? undefined : "true"}
      overflow="hidden"
      data-element-id={diagram.id}
      data-element-kind="diagram"
      data-diagram-engine={diagram.engine}
      data-diagram-version={diagram.engineVersion}
      data-diagram-layout={diagram.document.layout}
      data-interactive={interactive || undefined}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (drag === null || event.pointerId !== drag.pointerId) return;
        if (!drag.moved && Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY) < 4) return;
        const position = moveFromPointer(event);
        if (position === null) return;
        drag.moved = true;
        setPreviewPositions((current) => ({ ...current, [drag.nodeId]: position }));
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        if (drag === null || event.pointerId !== drag.pointerId) return;
        const position = moveFromPointer(event);
        dragRef.current = null;
        if (drag.moved && position !== null) {
          setPreviewPositions((current) => ({ ...current, [drag.nodeId]: position }));
          commitPosition(drag.nodeId, position);
        }
      }}
      onPointerCancel={() => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (drag?.moved) clearPreview(drag.nodeId);
      }}
    >
      <title>{diagram.label}</title>
      <g data-diagram-edges="true">
        {diagram.document.edges.map((edge) => (
          <EdgeGraphic key={`${edge.from}:${edge.to}`} edge={edge} boxes={boxesById} fontSize={metrics.fontSize} />
        ))}
      </g>
      <g data-diagram-nodes="true">
        {boxes.map((box) => (
          <NodeGraphic
            key={box.node.id}
            box={box}
            metrics={metrics}
            interactive={interactive}
            selected={box.node.id === selectedNodeId}
            onPointerDown={(event) => {
              event.stopPropagation();
              setSelectedNodeId(box.node.id);
              const rect = svgRef.current?.getBoundingClientRect();
              const localX = rect === undefined || rect.width <= 0 ? box.x + box.width / 2 : ((event.clientX - rect.left) / rect.width) * metrics.width;
              const localY = rect === undefined || rect.height <= 0 ? box.y + box.height / 2 : ((event.clientY - rect.top) / rect.height) * metrics.height;
              dragRef.current = {
                nodeId: box.node.id,
                pointerId: event.pointerId,
                moved: false,
                startClientX: event.clientX,
                startClientY: event.clientY,
                offsetX: localX - box.x,
                offsetY: localY - box.y,
              };
              event.currentTarget.setPointerCapture?.(event.pointerId);
            }}
            onKeyDown={(event) => {
              if (!interactive || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
              event.preventDefault();
              event.stopPropagation();
              const current = previewPositions[box.node.id] ?? box.node.position ?? positionForBox(box, metrics);
              const step = event.shiftKey ? 8 : 2;
              const position = {
                x: clamp(current.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0), 0, 100),
                y: clamp(current.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0), 0, 100),
              };
              setSelectedNodeId(box.node.id);
              setPreviewPositions((positions) => ({ ...positions, [box.node.id]: position }));
              commitPosition(box.node.id, position);
            }}
          />
        ))}
      </g>
    </svg>
  );
}
