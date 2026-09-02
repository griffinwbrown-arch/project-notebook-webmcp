import { describe, expect, it } from "vitest";

import { createIsoInstant, createNotebookId } from "../../../src/domain";
import {
  createElementId,
  createEmptyPage,
  createTextBlockId,
  findReviewCalloutFrame,
  nearestRelationshipTarget,
  richTextFromPlainText,
  wrapReviewCalloutText,
  type TextElement,
} from "../../../src/page";

const at = createIsoInstant("2026-08-27T12:00:00.000Z");

describe("Phase 5 review callout layout", () => {
  it("breaks long unspaced text before it can escape the callout", () => {
    const lines = wrapReviewCalloutText("x".repeat(180), 220);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length <= 27)).toBe(true);
    expect(lines.join("")).toBe("x".repeat(180));
  });

  it("fails placement when readable content occupies the complete page content area", () => {
    const page = createEmptyPage(createNotebookId("full-review-page"), 1, at);
    const text: TextElement = {
      kind: "text",
      id: createElementId("full-review-text"),
      label: "Full page source",
      frame: { x: 72, y: 64, width: 672, height: 928 },
      content: richTextFromPlainText("Full page", createTextBlockId("full-review-block")),
    };

    expect(findReviewCalloutFrame({ ...page, elements: [text] }, text.frame, "Explain this.")).toBeNull();
  });

  it("chooses the target rectangle closest to the callout source", () => {
    const source = { x: 500, y: 300, width: 220, height: 80 };
    const near = { x: 420, y: 300, width: 40, height: 28 };
    const far = { x: 80, y: 120, width: 100, height: 28 };

    expect(nearestRelationshipTarget(source, [far, near])).toBe(near);
  });
});
