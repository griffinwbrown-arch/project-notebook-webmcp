import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ANATOMY_CATALOG_VERSION,
  VERIFIED_ATLAS_ASSET_ID,
  VERIFIED_ATLAS_LOGICAL_BONE_COUNT,
  VERIFIED_ATLAS_SEMANTIC_MESH_COUNT,
  VERIFIED_ATLAS_VERSION,
  bonesForSection,
  type AnatomySkeletonProps,
} from "../../../src/anatomy";
import {
  AnatomySkeletonStudy,
  type AnatomySkeletonStudyProps,
} from "../../../src/entries/desk/AnatomySkeletonStudy";

const atlas = vi.hoisted(() => ({
  create: vi.fn(async (host: HTMLElement) => {
    const canvas = document.createElement("canvas");
    host.append(canvas);
    return {
      canvas,
      focusBone: vi.fn(),
      setIsolatedBone: atlas.setIsolatedBone,
      setCameraPreset: atlas.setCameraPreset,
      setSelectedBone: atlas.setSelectedBone,
      setHoveredBone: vi.fn(),
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
  }),
  setCameraPreset: vi.fn(),
  setIsolatedBone: vi.fn(),
  setSelectedBone: vi.fn(),
}));

vi.mock("../../../src/anatomy/atlas-scene", () => ({
  createAnatomyAtlasScene: atlas.create,
}));

const props: AnatomySkeletonProps = {
  kind: "anatomy-skeleton",
  assetId: VERIFIED_ATLAS_ASSET_ID,
  catalogVersion: ANATOMY_CATALOG_VERSION,
  atlasVersion: VERIFIED_ATLAS_VERSION,
  logicalBoneCount: VERIFIED_ATLAS_LOGICAL_BONE_COUNT,
  semanticMeshCount: VERIFIED_ATLAS_SEMANTIC_MESH_COUNT,
};

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
});

async function openPelvisTest(onSubmit: AnatomySkeletonStudyProps["onSubmit"]): Promise<readonly [HTMLElement, HTMLElement]> {
  render(<AnatomySkeletonStudy props={props} onSubmit={onSubmit} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Test" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Pelvis" }));
  fireEvent.click(screen.getByRole("button", { name: "Test" }));
  return [
    screen.getByRole("textbox", { name: "Answer for question 1" }),
    screen.getByRole("textbox", { name: "Answer for question 2" }),
  ];
}

describe("AnatomySkeletonStudy keyboard test flow", () => {
  it("keeps physical typing inside the test and advances Enter to the next unanswered field", async () => {
    const onSubmit = vi.fn(async () => true);
    const parentKeyDown = vi.fn();
    const view = render(
      <div onKeyDown={parentKeyDown}>
        <AnatomySkeletonStudy props={props} onSubmit={onSubmit} />
      </div>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Test" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Pelvis" }));
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    const first = screen.getByRole("textbox", { name: "Answer for question 1" });
    const second = screen.getByRole("textbox", { name: "Answer for question 2" });

    await waitFor(() => expect(first).toHaveFocus());
    fireEvent.keyDown(first, { key: "L", code: "KeyL" });
    fireEvent.input(first, { target: { value: "Left hip bone" } });
    fireEvent.keyDown(first, { key: "Enter", code: "Enter" });

    expect(parentKeyDown).not.toHaveBeenCalled();
    expect(first).toHaveValue("Left hip bone");
    expect(second).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();

    second.focus();
    const hotspot = screen.getByRole("button", { name: /Question 2$/ });
    hotspot.focus();
    expect(hotspot).toHaveFocus();
    fireEvent.click(hotspot);
    await waitFor(() => expect(second).toHaveFocus());

    view.unmount();
  });

  it("submits from Enter only after every bone has an answer", async () => {
    const onSubmit = vi.fn(async () => true);
    const [first, second] = await openPelvisTest(onSubmit);

    fireEvent.input(first, { target: { value: "Left hip bone" } });
    fireEvent.keyDown(first, { key: "Enter", code: "Enter" });
    fireEvent.input(second, { target: { value: "Right hip bone" } });
    fireEvent.keyDown(second, { key: "Enter", code: "Enter" });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith("pelvis", {
      "left-hip-bone": "Left hip bone",
      "right-hip-bone": "Right hip bone",
    });
  });

  it("resets to the active section's default bone, anterior camera, and full skeleton", async () => {
    render(<AnatomySkeletonStudy props={props} onSubmit={vi.fn(async () => true)} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Pelvis" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Pelvis" }));
    fireEvent.click(screen.getByRole("button", { name: "Isolate" }));
    fireEvent.click(screen.getByRole("button", { name: "Left" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));

    expect(atlas.setIsolatedBone).toHaveBeenLastCalledWith(null);
    expect(atlas.setCameraPreset).toHaveBeenLastCalledWith("anterior");
    expect(atlas.setSelectedBone).toHaveBeenLastCalledWith(bonesForSection("pelvis")[0]?.id);
  });
});
