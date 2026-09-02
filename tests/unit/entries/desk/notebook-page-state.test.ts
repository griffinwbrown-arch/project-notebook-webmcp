import { describe, expect, it } from "vitest";

import {
  INITIAL_NOTEBOOK_PAGE_STATE,
  reduceNotebookPageState,
  type NotebookPageAction,
} from "../../../../src/entries/desk/notebook-page-state";

describe("notebook page session", () => {
  it("changes paper, page size, writing style, layout, and narrow-screen mode locally", () => {
    const grid = reduceNotebookPageState(INITIAL_NOTEBOOK_PAGE_STATE, {
      type: "paper-selected",
      paper: "grid",
    });
    const handwritten = reduceNotebookPageState(grid, {
      type: "writing-style-selected",
      writingStyle: "handwritten",
    });
    const a4 = reduceNotebookPageState(handwritten, {
      type: "page-size-selected",
      pageSize: "a4",
    });
    const spread = reduceNotebookPageState(a4, {
      type: "layout-selected",
      layout: "spread",
    });
    const overview = reduceNotebookPageState(spread, {
      type: "narrow-mode-selected",
      mode: "overview",
    });
    const compact = reduceNotebookPageState(overview, {
      type: "scale-selected",
      scale: "75",
    });

    expect(compact).toEqual({
      paper: "grid",
      pageSize: "a4",
      writingStyle: "handwritten",
      requestedLayout: "spread",
      narrowMode: "overview",
      scale: "75",
    });
  });

  it.each<NotebookPageAction>([
    { type: "paper-selected", paper: "lined" },
    { type: "page-size-selected", pageSize: "letter" },
    { type: "writing-style-selected", writingStyle: "typed" },
    { type: "layout-selected", layout: "spread" },
    { type: "narrow-mode-selected", mode: "edit" },
    { type: "scale-selected", scale: "100" },
  ])("keeps object identity for an already selected option", (action) => {
    expect(reduceNotebookPageState(INITIAL_NOTEBOOK_PAGE_STATE, action)).toBe(
      INITIAL_NOTEBOOK_PAGE_STATE,
    );
  });
});
