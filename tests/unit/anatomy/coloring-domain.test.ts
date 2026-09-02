import { describe, expect, it } from "vitest";

import {
  COLORING_BRUSH_MODES,
  COLORING_LABEL_MODES,
  COLORING_LABS,
  COLORING_PALETTE,
  SURFACE_BARYCENTRIC_QUANTIZATION,
  SURFACE_PRESSURE_QUANTIZATION,
  applyAnatomyPaintEdit,
  coloringCompletion,
  coloringLabelPresentation,
  createColoringBaseFillLookup,
  parseColoringBaseFills,
  parseSurfacePaintStrokes,
  quantizeSurfaceBarycentric,
  quantizeSurfacePressure,
  surfacePaintStateFingerprint,
  type SurfacePaintAnchor,
  type SurfacePaintStroke,
} from "../../../src/anatomy/coloring-domain";

const femurAnchor: SurfacePaintAnchor = {
  sourceObject: "Femur.l",
  faceIndex: 42,
  barycentric: [16_384, 32_768],
  pressure: 32_768,
};

const femurStroke: SurfacePaintStroke = {
  id: "surface-stroke-1",
  boneId: "left-femur",
  brush: { kind: "paint", colorId: "aqua", radiusBps: 850, hardnessBps: 7_500 },
  anchors: [femurAnchor],
};

describe("anatomy coloring domain", () => {
  it("defines all six learning sections and all 206 logical bones exactly once", () => {
    expect(COLORING_LABS.map((lab) => [lab.section, lab.boneCount])).toEqual([
      ["skull", 29],
      ["vertebral-column", 26],
      ["thorax", 25],
      ["upper-limb", 64],
      ["pelvis", 2],
      ["lower-limb", 60],
    ]);
    expect(COLORING_LABS.reduce((total, lab) => total + lab.boneCount, 0)).toBe(206);
    expect(COLORING_BRUSH_MODES.map((brush) => brush.id)).toEqual(["sweep", "eraser"]);
    expect(COLORING_LABEL_MODES.map((mode) => mode.id)).toEqual(["guided", "recall"]);
    expect(new Set(COLORING_PALETTE.map((color) => color.id)).size).toBe(COLORING_PALETTE.length);
    expect(COLORING_PALETTE.every((color) => /^#[0-9A-F]{6}$/.test(color.hex))).toBe(true);
  });

  it("parses old whole-bone colors as canonical base fills without losing them", () => {
    const baseFills = parseColoringBaseFills({
      section: "pelvis",
      value: [["right-hip-bone", "cobalt"], ["left-hip-bone", "carmine"]],
    });
    expect(baseFills).toEqual([["left-hip-bone", "carmine"], ["right-hip-bone", "cobalt"]]);
    expect([...createColoringBaseFillLookup({ section: "pelvis", baseFills }).entries()]).toEqual(baseFills);

    expect(() => parseColoringBaseFills({ section: "pelvis", value: {} })).toThrow(/must be an array/i);
    expect(() => parseColoringBaseFills({ section: "pelvis", value: [["left-hip-bone"]] })).toThrow(/exactly one bone id/i);
    expect(() => parseColoringBaseFills({ section: "pelvis", value: [[42, "carmine"]] })).toThrow(/must be strings/i);
    expect(() => parseColoringBaseFills({ section: "pelvis", value: [["made-up-bone", "carmine"]] })).toThrow(/unknown anatomy bone/i);
    expect(() => parseColoringBaseFills({ section: "pelvis", value: [["left-femur", "carmine"]] })).toThrow(/does not belong/i);
    expect(() => parseColoringBaseFills({ section: "pelvis", value: [["left-hip-bone", "neon"]] })).toThrow(/unknown anatomy color/i);
    expect(() => parseColoringBaseFills({
      section: "pelvis",
      value: [["left-hip-bone", "carmine"], ["left-hip-bone", "amber"]],
    })).toThrow(/more than one base fill/i);
  });

  it("accepts exact ordered source anchors and rejects cross-bone or unquantized data", () => {
    expect(parseSurfacePaintStrokes({ section: "lower-limb", value: [femurStroke] })).toEqual([femurStroke]);
    expect(() => parseSurfacePaintStrokes({
      section: "lower-limb",
      value: [{ ...femurStroke, anchors: [{ ...femurAnchor, sourceObject: "Femur.r" }] }],
    })).toThrow(/verified source objects/i);
    expect(() => parseSurfacePaintStrokes({
      section: "lower-limb",
      value: [{ ...femurStroke, anchors: [{ ...femurAnchor, barycentric: [50_000, 20_000] }] }],
    })).toThrow(/cannot exceed/i);
    expect(() => parseSurfacePaintStrokes({
      section: "lower-limb",
      value: [{ ...femurStroke, anchors: [{ ...femurAnchor, faceIndex: 1.5 }] }],
    })).toThrow(/must be an integer/i);
    expect(() => parseSurfacePaintStrokes({
      section: "lower-limb",
      value: [femurStroke, femurStroke],
    })).toThrow(/duplicated/i);
  });

  it("appends one-bone paint and erase strokes and clears only the requested scope", () => {
    const painted = applyAnatomyPaintEdit({
      section: "lower-limb",
      baseFills: [["right-femur", "amber"]],
      surfaceStrokes: [],
      mutationId: "surface-stroke-1",
      edit: {
        kind: "surface-stroke",
        boneId: "left-femur",
        brush: femurStroke.brush,
        anchors: femurStroke.anchors,
      },
    });
    expect(painted).toEqual({
      baseFills: [["right-femur", "amber"]],
      surfaceStrokes: [femurStroke],
    });

    const erased = applyAnatomyPaintEdit({
      section: "lower-limb",
      ...painted,
      mutationId: "surface-erase-1",
      edit: {
        kind: "surface-stroke",
        boneId: "left-femur",
        brush: { kind: "erase", radiusBps: 600, hardnessBps: 10_000 },
        anchors: [femurAnchor],
      },
    });
    expect(erased.surfaceStrokes.map((stroke) => [stroke.id, stroke.boneId, stroke.brush.kind])).toEqual([
      ["surface-stroke-1", "left-femur", "paint"],
      ["surface-erase-1", "left-femur", "erase"],
    ]);

    const clearedBone = applyAnatomyPaintEdit({
      section: "lower-limb",
      ...erased,
      mutationId: "clear-left-femur",
      edit: { kind: "clear-bone", boneId: "left-femur" },
    });
    expect(clearedBone).toEqual({ baseFills: [["right-femur", "amber"]], surfaceStrokes: [] });
    expect(applyAnatomyPaintEdit({
      section: "lower-limb",
      ...clearedBone,
      mutationId: "clear-lower-limb",
      edit: { kind: "clear-section" },
    })).toEqual({ baseFills: [], surfaceStrokes: [] });
  });

  it("reports base and local surface completion with a stable persistence fingerprint", () => {
    const completion = coloringCompletion({
      section: "lower-limb",
      baseFills: [["right-femur", "amber"]],
      surfaceStrokes: [femurStroke],
    });
    expect(completion).toEqual({
      baseFilledBoneCount: 1,
      surfacePaintedBoneCount: 1,
      completedBoneCount: 2,
      surfaceStrokeCount: 1,
      surfaceAnchorCount: 1,
    });
    const first = surfacePaintStateFingerprint({ section: "lower-limb", surfaceStrokes: [femurStroke] });
    const second = surfacePaintStateFingerprint({ section: "lower-limb", surfaceStrokes: [femurStroke] });
    expect(first).toMatch(/^fnv1a32:[0-9a-f]{8}$/);
    expect(second).toBe(first);
  });

  it("quantizes barycentric coordinates and pressure inside exact integer bounds", () => {
    const barycentric = quantizeSurfaceBarycentric([0.2, 0.3, 0.5]);
    expect(barycentric[0] + barycentric[1]).toBeLessThanOrEqual(SURFACE_BARYCENTRIC_QUANTIZATION);
    expect(barycentric.every(Number.isSafeInteger)).toBe(true);
    expect(quantizeSurfacePressure(0)).toBe(0);
    expect(quantizeSurfacePressure(0.5)).toBe(Math.round(SURFACE_PRESSURE_QUANTIZATION / 2));
    expect(quantizeSurfacePressure(2)).toBe(SURFACE_PRESSURE_QUANTIZATION);
  });

  it("shows source names in guided mode without leaking them in recall presentation", () => {
    expect(coloringLabelPresentation({
      section: "pelvis",
      boneId: "left-hip-bone",
      mode: "guided",
    })).toEqual({ kind: "guided", text: "Left hip bone" });
    expect(coloringLabelPresentation({
      section: "pelvis",
      boneId: "left-hip-bone",
      mode: "recall",
    })).toEqual({ kind: "recall", questionNumber: 1 });
    expect(() => coloringLabelPresentation({
      section: "lower-limb",
      boneId: "left-hip-bone",
      mode: "guided",
    })).toThrow(/does not belong/i);
  });
});
