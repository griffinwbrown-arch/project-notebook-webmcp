import { describe, expect, it } from "vitest";

import {
  CalculusPracticePropsSchema,
  ColoringBookPropsSchema,
  applyColoringEdit,
  scoreCalculusPractice,
} from "../../../src/learning/activities";

describe("learning activities", () => {
  it("scores normalized calculus answers and returns useful retry feedback", () => {
    const props = CalculusPracticePropsSchema.parse({
      kind: "calculus-practice",
      title: "Derivative rules",
      directions: "Show the key step.",
      questions: [
        {
          id: "chain-rule",
          prompt: "Differentiate sin(x²).",
          acceptedAnswers: ["2x cos(x²)"],
          answerLabel: "dy/dx",
          hint: "Differentiate the outside first.",
          explanation: "The derivative is 2x cos(x²).",
        },
        {
          id: "limit",
          prompt: "Evaluate the limit.",
          acceptedAnswers: ["4"],
          answerLabel: "Limit",
          hint: "Factor first.",
          explanation: "The factors cancel.",
        },
      ],
    });

    const result = scoreCalculusPractice(
      props,
      { "chain-rule": "2xcos(x²)", limit: "5" },
      "attempt:1",
      "2026-09-02T12:00:00.000Z",
    );

    expect(result.score).toBe(1);
    expect(result.feedback).toEqual([
      expect.objectContaining({ questionId: "chain-rule", correct: true }),
      expect.objectContaining({ questionId: "limit", correct: false, message: "Try again. Factor first." }),
    ]);
  });

  it("appends, undoes, and clears bounded coloring strokes", () => {
    const props = ColoringBookPropsSchema.parse({
      kind: "coloring-book-page",
      scene: "garden",
      title: "Garden geometry",
      prompt: "Add color.",
      strokes: [],
    });
    const stroke = {
      id: "stroke:1",
      tool: "pen" as const,
      color: "#d55b45",
      width: 8,
      points: [{ x: .25, y: .5 }, { x: .3, y: .55 }],
    };

    const drawn = applyColoringEdit(props, { kind: "append", stroke });
    expect(drawn.strokes).toEqual([stroke]);
    expect(applyColoringEdit(drawn, { kind: "undo" }).strokes).toEqual([]);
    expect(applyColoringEdit(drawn, { kind: "clear" }).strokes).toEqual([]);
  });
});
