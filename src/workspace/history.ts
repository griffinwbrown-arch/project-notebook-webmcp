import { createNotebookId } from "../domain";

import { SHELF_PLACE, type WorkspacePlace } from "./model";

export type WorkspaceHistoryRead =
  | { readonly kind: "canonical"; readonly place: WorkspacePlace }
  | { readonly kind: "repair"; readonly place: WorkspacePlace };

export interface WorkspaceHistory {
  readonly read: () => WorkspaceHistoryRead;
  readonly push: (place: WorkspacePlace) => void;
  readonly replace: (place: WorkspacePlace) => void;
  readonly subscribe: (
    listener: (read: WorkspaceHistoryRead) => void,
  ) => () => void;
}

function isLegacyNotebookView(value: unknown): value is "write" | "sketch" {
  return value === "write" || value === "sketch";
}

export function parseWorkspacePlace(url: URL): WorkspaceHistoryRead {
  if (url.pathname !== "/desk" || url.hash !== "") {
    return { kind: "repair", place: SHELF_PLACE };
  }

  const notebookValues = url.searchParams.getAll("notebook");
  const viewValues = url.searchParams.getAll("view");
  const keys = [...url.searchParams.keys()];

  if (keys.length === 0) {
    return { kind: "canonical", place: SHELF_PLACE };
  }

  const hasOnlyKnownKeys = keys.every(
    (key) => key === "notebook" || key === "view",
  );
  const hasValidLegacyView =
    viewValues.length === 0 ||
    (viewValues.length === 1 && isLegacyNotebookView(viewValues[0]));

  if (
    !hasOnlyKnownKeys ||
    notebookValues.length !== 1 ||
    !hasValidLegacyView
  ) {
    return { kind: "repair", place: SHELF_PLACE };
  }

  const rawNotebookId = notebookValues[0];
  if (rawNotebookId === undefined) {
    return { kind: "repair", place: SHELF_PLACE };
  }

  try {
    const notebookId = createNotebookId(rawNotebookId);
    if (notebookId !== rawNotebookId) {
      return { kind: "repair", place: SHELF_PLACE };
    }
    const place: WorkspacePlace = {
      kind: "notebook",
      notebookId,
    };
    return url.pathname + url.search === workspacePlaceHref(place)
      ? { kind: "canonical", place }
      : { kind: "repair", place };
  } catch {
    return { kind: "repair", place: SHELF_PLACE };
  }
}

export function workspacePlaceHref(place: WorkspacePlace): string {
  switch (place.kind) {
    case "shelf":
      return "/desk";
    case "notebook": {
      const parameters = new URLSearchParams();
      parameters.set("notebook", place.notebookId);
      return `/desk?${parameters.toString()}`;
    }
    default: {
      const exhaustive: never = place;
      return exhaustive;
    }
  }
}

export function createBrowserWorkspaceHistory(): WorkspaceHistory {
  const target = (): Window => {
    if (typeof window === "undefined") {
      throw new Error("Browser history is unavailable outside the browser.");
    }
    return window;
  };
  const read = (): WorkspaceHistoryRead =>
    parseWorkspacePlace(new URL(target().location.href));

  return {
    read,
    push: (place): void => {
      target().history.pushState(null, "", workspacePlaceHref(place));
    },
    replace: (place): void => {
      target().history.replaceState(null, "", workspacePlaceHref(place));
    },
    subscribe: (listener): (() => void) => {
      const handlePopState = (): void => listener(read());
      const browserWindow = target();
      browserWindow.addEventListener("popstate", handlePopState);
      return (): void => {
        browserWindow.removeEventListener("popstate", handlePopState);
      };
    },
  };
}
