import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ANATOMY_CATALOG_VERSION,
  COLORING_PALETTE_VERSION,
  VERIFIED_ATLAS_ASSET_ID,
  VERIFIED_ATLAS_LOGICAL_BONE_COUNT,
  VERIFIED_ATLAS_SEMANTIC_MESH_COUNT,
  VERIFIED_ATLAS_VERSION,
  type AnatomyColoringProps,
  type AnatomyPaintEdit,
  type SurfacePaintStroke,
} from "../../../src/anatomy";
import { AnatomyColoringLab } from "../../../src/entries/desk/AnatomyColoringLab";

const atlas = vi.hoisted(() => ({
  create: vi.fn(),
  fitSection: vi.fn(),
  focusBone: vi.fn(),
  setBoneColor: vi.fn(),
  setBoneColors: vi.fn(),
  setCameraPreset: vi.fn(),
  setSurfaceBrush: vi.fn(),
  setSurfaceStrokes: vi.fn(),
  clearSurfacePreview: vi.fn(),
  setHoveredBone: vi.fn(),
  setInteractionMode: vi.fn(),
  setIsolatedBone: vi.fn(),
  setSelectedBone: vi.fn(),
  setVisibleSection: vi.fn(),
}));

vi.mock("../../../src/anatomy/atlas-scene", () => ({
  createAnatomyAtlasScene: atlas.create,
}));

const props: AnatomyColoringProps = {
  kind: "anatomy-coloring-lab",
  assetId: VERIFIED_ATLAS_ASSET_ID,
  catalogVersion: ANATOMY_CATALOG_VERSION,
  atlasVersion: VERIFIED_ATLAS_VERSION,
  logicalBoneCount: VERIFIED_ATLAS_LOGICAL_BONE_COUNT,
  semanticMeshCount: VERIFIED_ATLAS_SEMANTIC_MESH_COUNT,
  section: "skull",
  paletteVersion: COLORING_PALETTE_VERSION,
  baseFills: [],
  surfaceStrokes: [],
};

let commitSurfaceStroke: ((stroke: SurfacePaintStroke) => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  commitSurfaceStroke = null;
  atlas.create.mockImplementation(async (
    host: HTMLElement,
    options: Readonly<{ onSurfaceStrokeCommit?: (stroke: SurfacePaintStroke) => void }>,
  ) => {
    const canvas = document.createElement("canvas");
    host.append(canvas);
    commitSurfaceStroke = options.onSurfaceStrokeCommit ?? null;
    return {
      canvas,
      fitSection: atlas.fitSection,
      focusBone: atlas.focusBone,
      setBoneColor: atlas.setBoneColor,
      setBoneColors: atlas.setBoneColors,
      setCameraPreset: atlas.setCameraPreset,
      setSurfaceBrush: atlas.setSurfaceBrush,
      setSurfaceStrokes: atlas.setSurfaceStrokes,
      clearSurfacePreview: atlas.clearSurfacePreview,
      setHoveredBone: atlas.setHoveredBone,
      setInteractionMode: atlas.setInteractionMode,
      setIsolatedBone: atlas.setIsolatedBone,
      setSelectedBone: atlas.setSelectedBone,
      setVisibleSection: atlas.setVisibleSection,
      projectBone: vi.fn(() => ({ x: 120, y: 160, visible: true })),
      requestRender: vi.fn(),
      getIdentity: vi.fn(() => ({
        logicalBoneCount: VERIFIED_ATLAS_LOGICAL_BONE_COUNT,
        semanticMeshCount: VERIFIED_ATLAS_SEMANTIC_MESH_COUNT,
        upright: true,
        normalizedDimensions: [1.2, 3.62, 0.8],
      })),
      getCamera: vi.fn(() => ({ view: "anterior", position: [0, 0.08, 6.9], distance: 6.9 })),
      dispose: vi.fn(),
    };
  });
});

afterEach(() => cleanup());

async function renderLab(input: Readonly<{
  props?: AnatomyColoringProps;
  onPaint?: (edit: AnatomyPaintEdit) => Promise<boolean> | boolean;
}> = {}): Promise<Readonly<{
  onPaint: ReturnType<typeof vi.fn>;
  rerenderProps: (nextProps: AnatomyColoringProps) => void;
}>> {
  const onPaint = vi.fn(input.onPaint ?? (async () => true));
  const onSubmit = vi.fn(async () => true);
  const rendered = render(
    <AnatomyColoringLab
      props={input.props ?? props}
      onPaint={onPaint}
      onSubmit={onSubmit}
    />,
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Orbit" })).toBeEnabled());
  return {
    onPaint,
    rerenderProps: (nextProps) => rendered.rerender(
      <AnatomyColoringLab props={nextProps} onPaint={onPaint} onSubmit={onSubmit} />,
    ),
  };
}

describe("AnatomyColoringLab isolated bone workspace", () => {
  it("opens one verified bone for brush work and returns to the fitted section", async () => {
    await renderLab();
    expect(screen.getByRole("button", { name: "Paint" })).toBeDisabled();

    fireEvent.click(screen.getByRole("option", { name: /Frontal bone/ }));
    await waitFor(() => expect(screen.getByLabelText("Bone workspace for Frontal bone")).toBeVisible());
    expect(atlas.setVisibleSection).toHaveBeenCalledWith("skull");
    expect(atlas.setIsolatedBone).toHaveBeenCalledWith("frontal-bone");
    expect(atlas.focusBone).toHaveBeenCalledWith("frontal-bone");
    expect(screen.getByRole("button", { name: "Paint" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("option")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Back to section" }));
    expect(screen.queryByLabelText("Bone workspace for Frontal bone")).not.toBeInTheDocument();
    expect(atlas.setVisibleSection).toHaveBeenLastCalledWith("skull");
    expect(atlas.setCameraPreset).toHaveBeenLastCalledWith("anterior", false);
    expect(atlas.fitSection).toHaveBeenLastCalledWith("skull");
    expect(screen.getByRole("button", { name: "Paint" })).toBeDisabled();
  });

  it("keeps one recall field visible and Enter isolates the next unanswered bone", async () => {
    await renderLab();
    fireEvent.click(screen.getByRole("button", { name: "Label yourself" }));
    const first = screen.getByRole("textbox", { name: "Coloring answer for question 1" });
    await waitFor(() => expect(first).toHaveFocus());
    expect(screen.getAllByRole("textbox")).toHaveLength(1);

    fireEvent.input(first, { target: { value: "Frontal bone" } });
    await act(async () => fireEvent.keyDown(first, { key: "Enter", code: "Enter" }));

    const second = screen.getByRole("textbox", { name: "Coloring answer for question 2" });
    await waitFor(() => expect(second).toHaveFocus());
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(atlas.setIsolatedBone).toHaveBeenLastCalledWith("left-parietal-bone");
  });

  it("keeps the active bone answer out of the DOM until recall is scored", async () => {
    await renderLab();
    fireEvent.click(screen.getByRole("button", { name: "Label yourself" }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Coloring answer for question 1" })).toHaveFocus());
    expect(document.body).not.toHaveTextContent(/frontal bone/i);
    expect(document.querySelector('[data-workspace-bone="frontal-bone"]')).not.toBeInTheDocument();
    expect(screen.getByLabelText("Question 1 bone workspace")).toBeVisible();
  });

  it("resets the camera around the isolated bone without restoring the full section", async () => {
    await renderLab();
    fireEvent.click(screen.getByRole("option", { name: /Frontal bone/ }));
    vi.clearAllMocks();

    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));

    expect(atlas.setVisibleSection).toHaveBeenCalledWith("skull");
    expect(atlas.setIsolatedBone).toHaveBeenCalledWith("frontal-bone");
    expect(atlas.setCameraPreset).toHaveBeenCalledWith("anterior", false);
    expect(atlas.focusBone).toHaveBeenCalledWith("frontal-bone");
    expect(atlas.fitSection).not.toHaveBeenCalled();
  });

  it("commits one multi-anchor local surface stroke after the renderer previews a drag", async () => {
    let resolveSave: (saved: boolean) => void = () => {
      throw new Error("The paint save promise was not initialized.");
    };
    const save = new Promise<boolean>((resolve) => {
      resolveSave = resolve;
    });
    const { onPaint, rerenderProps } = await renderLab({ onPaint: () => save });
    fireEvent.click(screen.getByRole("option", { name: /Frontal bone/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cobalt" }));
    const stroke: AnatomyColoringProps["surfaceStrokes"][number] = {
      id: "surface-preview-1",
      boneId: "frontal-bone",
      brush: { kind: "paint", colorId: "cobalt", radiusBps: 500, hardnessBps: 8_200 },
      anchors: [
        { sourceObject: "Frontal bone", faceIndex: 10, barycentric: [20_000, 20_000], pressure: 50_000 },
        { sourceObject: "Frontal bone", faceIndex: 11, barycentric: [21_000, 19_000], pressure: 51_000 },
        { sourceObject: "Frontal bone", faceIndex: 12, barycentric: [22_000, 18_000], pressure: 52_000 },
      ],
    };
    if (commitSurfaceStroke === null) throw new Error("The surface commit callback was not registered.");

    await act(async () => commitSurfaceStroke?.(stroke));

    await waitFor(() => expect(onPaint).toHaveBeenCalledTimes(1));
    expect(onPaint).toHaveBeenCalledWith({
      kind: "surface-stroke",
      boneId: "frontal-bone",
      brush: stroke.brush,
      anchors: stroke.anchors,
    });
    expect(atlas.setSurfaceStrokes).toHaveBeenLastCalledWith([stroke]);
    expect(atlas.setBoneColor).not.toHaveBeenCalled();
    expect(document.querySelector("[data-surface-anchors='3']")).toBeInTheDocument();

    rerenderProps({ ...props, baseFills: [], surfaceStrokes: [] });
    expect(document.querySelector("[data-surface-strokes='1'][data-surface-anchors='3']")).toBeInTheDocument();
    expect(atlas.setSurfaceStrokes).toHaveBeenLastCalledWith([stroke]);

    await act(async () => resolveSave(true));
    expect(document.querySelector("[data-paint-state='saving'][data-surface-strokes='1']")).toBeInTheDocument();

    const landed = { ...stroke, id: "manual-anatomy-paint:stored" };
    rerenderProps({ ...props, baseFills: [], surfaceStrokes: [landed] });
    await waitFor(() => expect(document.querySelector("[data-paint-state='idle'][data-surface-strokes='1']")).toBeInTheDocument());
    expect(atlas.setSurfaceStrokes).toHaveBeenLastCalledWith([landed]);
  });

  it("replays persisted surface strokes when one app-owned save fails", async () => {
    const persisted: AnatomyColoringProps["surfaceStrokes"][number] = {
      id: "persisted-stroke",
      boneId: "frontal-bone",
      brush: { kind: "paint", colorId: "sage", radiusBps: 500, hardnessBps: 8_200 },
      anchors: [{ sourceObject: "Frontal bone", faceIndex: 8, barycentric: [20_000, 20_000], pressure: 45_000 }],
    };
    await renderLab({
      props: { ...props, surfaceStrokes: [persisted] },
      onPaint: async () => false,
    });
    fireEvent.click(screen.getByRole("option", { name: /Frontal bone/ }));
    const rejected: AnatomyColoringProps["surfaceStrokes"][number] = {
      ...persisted,
      id: "rejected-stroke",
      anchors: [{ sourceObject: "Frontal bone", faceIndex: 9, barycentric: [21_000, 20_000], pressure: 46_000 }],
    };
    if (commitSurfaceStroke === null) throw new Error("The surface commit callback was not registered.");

    await act(async () => commitSurfaceStroke?.(rejected));

    await waitFor(() => expect(screen.getByText(/save failed\. saved paint restored/i)).toBeVisible());
    expect(atlas.clearSurfacePreview).toHaveBeenCalled();
    expect(atlas.setSurfaceStrokes).toHaveBeenLastCalledWith([persisted]);
    expect(document.querySelector("[data-surface-strokes='1']")).toBeInTheDocument();
  });

  it("fails closed before persistence when a renderer stroke has an unverified source object", async () => {
    const { onPaint } = await renderLab();
    fireEvent.click(screen.getByRole("option", { name: /Frontal bone/ }));
    const invalidStroke: SurfacePaintStroke = {
      id: "invalid-renderer-stroke",
      boneId: "frontal-bone",
      brush: { kind: "paint", colorId: "cobalt", radiusBps: 500, hardnessBps: 8_200 },
      anchors: [{
        sourceObject: "bonefrontal-bone1",
        faceIndex: 10,
        barycentric: [20_000, 20_000],
        pressure: 50_000,
      }],
    };
    if (commitSurfaceStroke === null) throw new Error("The surface commit callback was not registered.");

    await act(async () => commitSurfaceStroke?.(invalidStroke));

    expect(onPaint).not.toHaveBeenCalled();
    expect(atlas.clearSurfacePreview).toHaveBeenCalled();
    expect(atlas.setSurfaceStrokes).toHaveBeenLastCalledWith([]);
    expect(screen.getByText(/paint sample could not be verified\. saved paint restored/i)).toBeVisible();
    expect(document.querySelector("[data-paint-state='idle'][data-surface-strokes='0']")).toBeInTheDocument();
  });

  it("clears only the isolated bone and preserves paint progress on other bones", async () => {
    const { onPaint, rerenderProps } = await renderLab({
      props: {
        ...props,
        baseFills: [["frontal-bone", "carmine"], ["left-parietal-bone", "cobalt"]],
      },
    });
    fireEvent.click(screen.getByRole("option", { name: /Frontal bone/ }));

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Clear bone" })));

    await waitFor(() => expect(onPaint).toHaveBeenCalledWith({ kind: "clear-bone", boneId: "frontal-bone" }));
    expect(atlas.setBoneColors).toHaveBeenLastCalledWith({ "left-parietal-bone": 0x4e78b5 });
    expect(document.querySelector("[data-started-bones='1']")).toBeInTheDocument();
    rerenderProps({ ...props, baseFills: [["left-parietal-bone", "cobalt"]], surfaceStrokes: [] });
    await waitFor(() => expect(document.querySelector("[data-paint-state='idle'][data-started-bones='1']")).toBeInTheDocument());
  });
});
