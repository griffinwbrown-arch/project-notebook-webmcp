import { describe, expect, it } from "vitest";

import { createNotebookId } from "../../../../src/domain";
import { coverToneFor } from "../../../../src/entries/desk/cover-templates";

describe("cover templates", () => {
  it("assigns a stable tone from the complete notebook id", () => {
    const id = createNotebookId("field-notes-forest");
    const first = coverToneFor(id);
    const second = coverToneFor(id);

    expect(first).toBe("claret");
    expect(second).toBe(first);
  });

  it("uses all four tones in the deterministic palette", () => {
    const ids = [
      createNotebookId("a"),
      createNotebookId("b"),
      createNotebookId("c"),
      createNotebookId("d"),
    ];

    expect(ids.map(coverToneFor)).toEqual(["navy", "claret", "umber", "forest"]);
  });

  it("handles unicode code points without changing the return contract", () => {
    const tone = coverToneFor(createNotebookId("field-📝"));

    expect(tone).toBe("claret");
  });
});
