export type PaperStyle = "lined" | "grid" | "blank";
export type WritingStyle = "typed" | "handwritten";
export type PageLayout = "single" | "spread";
export type NarrowPageMode = "overview" | "edit";
export const NOTEBOOK_SCALES = ["75", "100", "125", "150", "175", "200"] as const;
export type NotebookScale = (typeof NOTEBOOK_SCALES)[number];

export type NotebookPageState = {
  readonly paper: PaperStyle;
  readonly writingStyle: WritingStyle;
  readonly pageSize: PageSizePreset;
  readonly requestedLayout: PageLayout;
  readonly narrowMode: NarrowPageMode;
  readonly scale: NotebookScale;
};

export type NotebookPageAction =
  | { readonly type: "paper-selected"; readonly paper: PaperStyle }
  | { readonly type: "page-size-selected"; readonly pageSize: PageSizePreset }
  | {
      readonly type: "writing-style-selected";
      readonly writingStyle: WritingStyle;
  }
  | { readonly type: "layout-selected"; readonly layout: PageLayout }
  | { readonly type: "narrow-mode-selected"; readonly mode: NarrowPageMode }
  | { readonly type: "scale-selected"; readonly scale: NotebookScale };

export const INITIAL_NOTEBOOK_PAGE_STATE: NotebookPageState = {
  paper: "lined",
  writingStyle: "typed",
  pageSize: "letter",
  requestedLayout: "spread",
  narrowMode: "edit",
  scale: "100",
};

export function reduceNotebookPageState(
  state: NotebookPageState,
  action: NotebookPageAction,
): NotebookPageState {
  switch (action.type) {
    case "paper-selected":
      return action.paper === state.paper
        ? state
        : { ...state, paper: action.paper };
    case "writing-style-selected":
      return action.writingStyle === state.writingStyle
        ? state
        : { ...state, writingStyle: action.writingStyle };
    case "page-size-selected":
      return action.pageSize === state.pageSize
        ? state
        : { ...state, pageSize: action.pageSize };
    case "layout-selected":
      return action.layout === state.requestedLayout
        ? state
        : { ...state, requestedLayout: action.layout };
    case "narrow-mode-selected":
      return action.mode === state.narrowMode
        ? state
        : { ...state, narrowMode: action.mode };
    case "scale-selected":
      return action.scale === state.scale
        ? state
        : { ...state, scale: action.scale };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
import type { PageSizePreset } from "../../page";
