import { beforeEach, describe, expect, it, vi } from "vitest";

import { createNotebookId } from "../../../src/domain";
import {
  createBrowserWorkspaceHistory,
  parseWorkspacePlace,
  workspacePlaceHref,
} from "../../../src/workspace/history";
import type { WorkspacePlace } from "../../../src/workspace/model";

describe("workspace place URL boundary", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/desk");
  });

  it("round trips the exact shelf and focused notebook URLs", () => {
    const notebookId = createNotebookId("ideas/one");
    const places: readonly WorkspacePlace[] = [
      { kind: "shelf" },
      { kind: "notebook", notebookId },
    ];

    expect(places.map(workspacePlaceHref)).toEqual([
      "/desk",
      "/desk?notebook=ideas%2Fone",
    ]);

    for (const place of places) {
      expect(
        parseWorkspacePlace(new URL(workspacePlaceHref(place), "https://notebook.test")),
      ).toEqual({ kind: "canonical", place });
    }
  });

  it("repairs valid focused places to their exact canonical URL", () => {
    const notebookId = createNotebookId("ideas/one");
    const examples: readonly {
      readonly href: string;
      readonly place: WorkspacePlace;
    }[] = [
      {
        href: "/desk?view=write&notebook=ideas%2Fone",
        place: { kind: "notebook", notebookId },
      },
      {
        href: "/desk?notebook=ideas/one&view=sketch",
        place: { kind: "notebook", notebookId },
      },
    ];

    for (const example of examples) {
      expect(
        parseWorkspacePlace(new URL(example.href, "https://notebook.test")),
      ).toEqual({ kind: "repair", place: example.place });
    }
  });

  it.each([
    "/",
    "/desk#paper",
    "/desk?view=write",
    "/desk?notebook=one&view=write&extra=1",
    "/desk?notebook=one&notebook=two&view=write",
    "/desk?notebook=one&view=write&view=sketch",
    "/desk?notebook=one&view=paint",
    "/desk?notebook=%20one%20&view=write",
    "/desk?notebook=%20%20&view=write",
  ])("repairs noncanonical product URLs to the shelf: %s", (href) => {
    expect(parseWorkspacePlace(new URL(href, "https://notebook.test"))).toEqual({
      kind: "repair",
      place: { kind: "shelf" },
    });
  });

  it("uses native history and emits restored place on popstate", () => {
    const history = createBrowserWorkspaceHistory();
    const listener = vi.fn();
    const unsubscribe = history.subscribe(listener);
    const notebook: WorkspacePlace = {
      kind: "notebook",
      notebookId: createNotebookId("history-notebook"),
    };

    history.push(notebook);
    expect(window.location.pathname + window.location.search).toBe(
      "/desk?notebook=history-notebook",
    );
    expect(listener).not.toHaveBeenCalled();

    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(listener).toHaveBeenCalledWith({ kind: "canonical", place: notebook });

    history.replace({ kind: "shelf" });
    expect(window.location.pathname + window.location.search).toBe("/desk");
    unsubscribe();
    listener.mockClear();
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(listener).not.toHaveBeenCalled();
  });
});
