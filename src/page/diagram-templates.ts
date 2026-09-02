import type { DiagramDocument } from "./domain";

export const DIAGRAM_TEMPLATE_INPUTS = [
  "relationship-map",
  "process-map",
  "visual-study",
  "signal-flow",
] as const;

export type DiagramTemplateInput = typeof DIAGRAM_TEMPLATE_INPUTS[number];
export type CanonicalDiagramTemplate = Exclude<DiagramTemplateInput, "signal-flow">;

export type DiagramTemplateDefinition = Readonly<{
  template: CanonicalDiagramTemplate;
  version: 1;
  label: string;
  description: string;
  frame: Readonly<{ x: number; y: number; width: number; height: number }>;
  aliases: readonly DiagramTemplateInput[];
  document: DiagramDocument;
}>;

export const DIAGRAM_TEMPLATE_CATALOG = {
  "relationship-map": {
    template: "relationship-map",
    version: 1,
    label: "Relationship map",
    description: "Map connected ideas, evidence, people, and risks.",
    frame: { x: 92, y: 196, width: 632, height: 520 },
    aliases: [],
    document: {
      version: 1,
      layout: "mind-map",
      nodes: [
        { id: "subject", label: "Main subject", tone: "accent" },
        { id: "people", label: "People" },
        { id: "evidence", label: "Evidence", tone: "positive" },
        { id: "questions", label: "Open questions", tone: "warning" },
        { id: "risks", label: "Risks" },
      ],
      edges: [
        { from: "subject", to: "people", label: "involves" },
        { from: "subject", to: "evidence", label: "supported by" },
        { from: "subject", to: "questions", label: "raises" },
        { from: "subject", to: "risks", label: "affected by" },
      ],
    },
  },
  "process-map": {
    template: "process-map",
    version: 1,
    label: "Process map",
    description: "Lay out ordered work and its bound handoffs.",
    frame: { x: 92, y: 196, width: 632, height: 520 },
    aliases: [],
    document: {
      version: 1,
      layout: "flow",
      nodes: [
        { id: "input", label: "Input", tone: "accent" },
        { id: "prepare", label: "Prepare" },
        { id: "review", label: "Review", tone: "warning" },
        { id: "complete", label: "Complete", tone: "positive" },
      ],
      edges: [
        { from: "input", to: "prepare" },
        { from: "prepare", to: "review" },
        { from: "review", to: "complete", label: "approved" },
      ],
    },
  },
  "visual-study": {
    template: "visual-study",
    version: 1,
    label: "Dense visual study",
    description: "Explore a dense field of paths, contours, and relationships.",
    frame: { x: 92, y: 196, width: 632, height: 520 },
    aliases: ["signal-flow"],
    document: {
      version: 1,
      layout: "cycle",
      nodes: [
        { id: "observe", label: "Observe", tone: "accent" },
        { id: "connect", label: "Connect" },
        { id: "interpret", label: "Interpret", tone: "warning" },
        { id: "refine", label: "Refine", tone: "positive" },
      ],
      edges: [
        { from: "observe", to: "connect" },
        { from: "connect", to: "interpret" },
        { from: "interpret", to: "refine" },
        { from: "refine", to: "observe", label: "repeat" },
      ],
    },
  },
} as const satisfies Record<CanonicalDiagramTemplate, DiagramTemplateDefinition>;

export const DIAGRAM_TEMPLATE_PICKER = Object.values(DIAGRAM_TEMPLATE_CATALOG);

export function resolveDiagramTemplate(input: DiagramTemplateInput): DiagramTemplateDefinition {
  return input === "signal-flow" ? DIAGRAM_TEMPLATE_CATALOG["visual-study"] : DIAGRAM_TEMPLATE_CATALOG[input];
}
