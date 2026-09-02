import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NativeDiagram } from "../../../src/entries/desk/NativeDiagram";
import {
  DIAGRAM_MAX_NODES,
  createElementId,
  parsePageElement,
  validateDiagramDocument,
  type DiagramDocument,
  type DiagramElement,
} from "../../../src/page/domain";
import {
  DIAGRAM_TEMPLATE_INPUTS,
  DIAGRAM_TEMPLATE_PICKER,
  resolveDiagramTemplate,
} from "../../../src/page/diagram-templates";

function diagramElement(document: DiagramDocument): DiagramElement {
  return {
    kind: "diagram",
    id: createElementId("diagram-native-test"),
    label: "Native planning diagram",
    frame: { x: 92, y: 196, width: 632, height: 520 },
    engine: "native",
    engineVersion: 1,
    document,
  };
}

describe("native semantic diagram domain", () => {
  it("keeps every existing template name and resolves it to a semantic document", () => {
    expect(DIAGRAM_TEMPLATE_INPUTS).toEqual([
      "relationship-map",
      "process-map",
      "visual-study",
      "signal-flow",
    ]);
    expect(DIAGRAM_TEMPLATE_PICKER.map(({ template }) => template)).toEqual([
      "relationship-map",
      "process-map",
      "visual-study",
    ]);

    for (const name of DIAGRAM_TEMPLATE_INPUTS) {
      const definition = resolveDiagramTemplate(name);
      expect(validateDiagramDocument(definition.document)).toEqual(definition.document);
      expect(definition.document).toEqual({
        version: 1,
        layout: expect.stringMatching(/^(flow|mind-map|cycle)$/u),
        nodes: expect.any(Array),
        edges: expect.any(Array),
      });
    }
    expect(resolveDiagramTemplate("signal-flow")).toBe(resolveDiagramTemplate("visual-study"));
  });

  it("accepts only bounded semantic nodes and valid directed edges", () => {
    const valid = resolveDiagramTemplate("relationship-map").document;
    expect(validateDiagramDocument(valid)).toEqual(valid);
    expect(() => validateDiagramDocument({
      ...valid,
      nodes: [...valid.nodes, { ...valid.nodes[0] }],
    })).toThrow(/unique/iu);
    expect(() => validateDiagramDocument({
      ...valid,
      edges: [...valid.edges, { from: "subject", to: "missing" }],
    })).toThrow(/existing nodes/iu);
    expect(() => validateDiagramDocument({
      ...valid,
      nodes: Array.from({ length: DIAGRAM_MAX_NODES + 1 }, (_, index) => ({
        id: `node-${index}`,
        label: `Node ${index}`,
      })),
      edges: [],
    })).toThrow(/too big|elements/iu);
  });

  it("rejects renderer payloads, URLs, raw markup, snapshots, and legacy engines", () => {
    const valid = resolveDiagramTemplate("process-map").document;
    expect(() => validateDiagramDocument({ ...valid, renderer: { type: "svg" } })).toThrow();
    expect(() => validateDiagramDocument({
      ...valid,
      nodes: [{ id: "unsafe", label: "https://example.com" }],
      edges: [],
    })).toThrow();
    expect(() => validateDiagramDocument({
      ...valid,
      nodes: [{ id: "unsafe", label: "<svg>raw</svg>" }],
      edges: [],
    })).toThrow();
    expect(() => validateDiagramDocument({ kind: "snapshot", version: 1, snapshot: {} })).toThrow();
    expect(() => parsePageElement({
      ...diagramElement(valid),
      engine: "tldraw",
    })).toThrow(/persisted diagram/iu);
  });

  it("parses a native element and renders stable, labelled SVG arrows", () => {
    const element = diagramElement(resolveDiagramTemplate("visual-study").document);
    expect(parsePageElement(element)).toEqual(element);

    const first = renderToStaticMarkup(createElement(NativeDiagram, { diagram: element }));
    const second = renderToStaticMarkup(createElement(NativeDiagram, { diagram: element }));
    expect(second).toBe(first);
    expect(first).toContain("<svg");
    expect(first).toContain('role="img"');
    expect(first).toContain('data-diagram-engine="native"');
    expect(first).toContain('data-diagram-layout="cycle"');
    expect(first.match(/data-diagram-node=/gu)).toHaveLength(element.document.nodes.length);
    expect(first.match(/data-diagram-edge=/gu)).toHaveLength(element.document.edges.length);
    expect(first.match(/data-arrowhead="true"/gu)).toHaveLength(element.document.edges.length);
    for (const node of element.document.nodes) expect(first).toContain(node.label);
  });
});
