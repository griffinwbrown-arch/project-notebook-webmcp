import {
  ADULT_SKELETON_BONES,
  ANATOMY_SECTIONS,
  type AnatomySection,
  type BoneEntry,
  bonesForSection,
} from "./catalog";

export const COLORING_PALETTE_VERSION = "anatomy-study-palette-v1";
export const SURFACE_BARYCENTRIC_QUANTIZATION = 65_535;
export const SURFACE_PRESSURE_QUANTIZATION = 65_535;
export const SURFACE_BRUSH_BASIS_POINTS = 10_000;
export const MAX_SURFACE_PAINT_STROKES = 512;
export const MAX_SURFACE_PAINT_ANCHORS_PER_STROKE = 256;
export const MAX_SURFACE_PAINT_ANCHORS = 16_384;
export const MAX_SURFACE_FACE_INDEX = 1_000_000;

export const COLORING_PALETTE = [
  { id: "carmine", label: "Carmine", hex: "#D66565" },
  { id: "amber", label: "Amber", hex: "#D4A448" },
  { id: "sage", label: "Sage", hex: "#6F966C" },
  { id: "aqua", label: "Aqua", hex: "#4D9998" },
  { id: "cobalt", label: "Cobalt", hex: "#4E78B5" },
  { id: "iris", label: "Iris", hex: "#7467AE" },
  { id: "rose", label: "Rose", hex: "#C46E9A" },
  { id: "graphite", label: "Graphite", hex: "#626E79" },
] as const satisfies readonly Readonly<{
  id: string;
  label: string;
  hex: `#${string}`;
}>[];

export type ColoringColorId = typeof COLORING_PALETTE[number]["id"];
export type ColoringLabelMode = "guided" | "recall";
export type ColoringBrushMode = "sweep" | "eraser";

export const COLORING_LABEL_MODES = [
  {
    id: "guided",
    label: "Labels on",
    description: "Show each anatomical name while you paint.",
  },
  {
    id: "recall",
    label: "Label yourself",
    description: "Replace names with question numbers for active recall.",
  },
] as const satisfies readonly Readonly<{
  id: ColoringLabelMode;
  label: string;
  description: string;
}>[];

export const COLORING_BRUSH_MODES = [
  {
    id: "sweep",
    label: "Sweep",
    description: "Use a wider brush while staying on the selected bone.",
  },
  {
    id: "eraser",
    label: "Eraser",
    description: "Erase only the surface under the brush.",
  },
] as const satisfies readonly Readonly<{
  id: ColoringBrushMode;
  label: string;
  description: string;
}>[];

export type ColoringLabDefinition = Readonly<{
  section: AnatomySection;
  label: string;
  shortLabel: string;
  boneCount: number;
}>;

export const COLORING_LABS: readonly ColoringLabDefinition[] = ANATOMY_SECTIONS.map((section) => ({
  section: section.id,
  label: section.label,
  shortLabel: section.shortLabel,
  boneCount: bonesForSection(section.id).length,
}));

export type ColoringBaseFill = readonly [boneId: string, colorId: ColoringColorId];
export type ColoringBaseFills = readonly ColoringBaseFill[];

export type SurfacePaintBrush =
  | Readonly<{
      kind: "paint";
      colorId: ColoringColorId;
      radiusBps: number;
      hardnessBps: number;
    }>
  | Readonly<{
      kind: "erase";
      radiusBps: number;
      hardnessBps: number;
    }>;

export type SurfacePaintAnchor = Readonly<{
  sourceObject: string;
  faceIndex: number;
  /** Quantized triangle weights B and C. Weight A is 65,535 - B - C. */
  barycentric: readonly [b: number, c: number];
  pressure: number;
}>;

export type SurfacePaintStroke = Readonly<{
  id: string;
  boneId: string;
  brush: SurfacePaintBrush;
  anchors: readonly SurfacePaintAnchor[];
}>;

export type SurfacePaintStrokes = readonly SurfacePaintStroke[];

export type AnatomyPaintEdit =
  | Readonly<{
      kind: "surface-stroke";
      boneId: string;
      brush: SurfacePaintBrush;
      anchors: readonly SurfacePaintAnchor[];
    }>
  | Readonly<{ kind: "clear-bone"; boneId: string }>
  | Readonly<{ kind: "clear-section" }>;

export type ColoringSurfaceState = Readonly<{
  baseFills: ColoringBaseFills;
  surfaceStrokes: SurfacePaintStrokes;
}>;

export type ColoringCompletion = Readonly<{
  baseFilledBoneCount: number;
  surfacePaintedBoneCount: number;
  completedBoneCount: number;
  surfaceStrokeCount: number;
  surfaceAnchorCount: number;
}>;

export type ColoringLabelPresentation =
  | Readonly<{ kind: "guided"; text: string }>
  | Readonly<{ kind: "recall"; questionNumber: number }>;

const boneById = new Map(ADULT_SKELETON_BONES.map((bone) => [bone.id, bone]));
const catalogIndexById = new Map(ADULT_SKELETON_BONES.map((bone, index) => [bone.id, index]));
const paletteIds = new Set<string>(COLORING_PALETTE.map((color) => color.id));

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function requireBone(boneId: string): BoneEntry {
  const bone = boneById.get(boneId);
  if (bone === undefined) throw new Error(`Unknown anatomy bone id: ${boneId}.`);
  return bone;
}

function requireSectionBone(section: AnatomySection, boneId: string): BoneEntry {
  const bone = requireBone(boneId);
  if (bone.section !== section) {
    throw new Error(`Bone ${boneId} does not belong to the ${section} coloring lab.`);
  }
  return bone;
}

function requireCatalogIndex(boneId: string): number {
  const index = catalogIndexById.get(boneId);
  if (index === undefined) throw new Error(`Unknown anatomy bone id: ${boneId}.`);
  return index;
}

function isColoringColorId(value: string): value is ColoringColorId {
  return paletteIds.has(value);
}

function requireBoundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function canonicalizeBaseFills(baseFills: ColoringBaseFill[]): ColoringBaseFills {
  baseFills.sort((left, right) => requireCatalogIndex(left[0]) - requireCatalogIndex(right[0]));
  return baseFills;
}

export function parseColoringBaseFills(input: Readonly<{
  section: AnatomySection;
  value: unknown;
}>): ColoringBaseFills {
  if (!isUnknownArray(input.value)) throw new Error("Base fills must be an array of [bone id, color id] pairs.");
  if (input.value.length > 64) throw new Error("A coloring section cannot contain more than 64 base fills.");

  const seenBoneIds = new Set<string>();
  const parsed: ColoringBaseFill[] = [];
  for (const rawBaseFill of input.value) {
    if (!isUnknownArray(rawBaseFill) || rawBaseFill.length !== 2) {
      throw new Error("Each base fill must contain exactly one bone id and one color id.");
    }
    const boneId = rawBaseFill[0];
    const colorId = rawBaseFill[1];
    if (typeof boneId !== "string" || typeof colorId !== "string") {
      throw new Error("Base fill ids must be strings.");
    }

    requireSectionBone(input.section, boneId);
    if (!isColoringColorId(colorId)) throw new Error(`Unknown anatomy color id: ${colorId}.`);
    if (seenBoneIds.has(boneId)) throw new Error(`Bone ${boneId} has more than one base fill.`);

    seenBoneIds.add(boneId);
    parsed.push([boneId, colorId]);
  }

  return canonicalizeBaseFills(parsed);
}

function parseSurfacePaintBrush(value: unknown): SurfacePaintBrush {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("A surface stroke brush must be a paint or erase brush.");
  }
  const radiusBps = requireBoundedInteger(value.radiusBps, "Brush radius", 1, SURFACE_BRUSH_BASIS_POINTS);
  const hardnessBps = requireBoundedInteger(value.hardnessBps, "Brush hardness", 0, SURFACE_BRUSH_BASIS_POINTS);
  if (value.kind === "paint") {
    if (!hasOnlyKeys(value, ["kind", "colorId", "radiusBps", "hardnessBps"]) ||
      typeof value.colorId !== "string" || !isColoringColorId(value.colorId)) {
      throw new Error("A paint brush must contain one verified anatomy color.");
    }
    return { kind: "paint", colorId: value.colorId, radiusBps, hardnessBps };
  }
  if (value.kind === "erase") {
    if (!hasOnlyKeys(value, ["kind", "radiusBps", "hardnessBps"])) {
      throw new Error("An erase brush cannot contain paint-only fields.");
    }
    return { kind: "erase", radiusBps, hardnessBps };
  }
  throw new Error("A surface stroke brush must be a paint or erase brush.");
}

function parseSurfacePaintAnchor(value: unknown, bone: BoneEntry): SurfacePaintAnchor {
  if (!isRecord(value) || !hasOnlyKeys(value, ["sourceObject", "faceIndex", "barycentric", "pressure"])) {
    throw new Error("A surface anchor must contain its exact source object, face, barycentric weights, and pressure.");
  }
  if (typeof value.sourceObject !== "string" || !bone.sourceObjects.includes(value.sourceObject)) {
    throw new Error(`A surface anchor for ${bone.id} must belong to one of that bone's verified source objects.`);
  }
  const faceIndex = requireBoundedInteger(value.faceIndex, "Surface face index", 0, MAX_SURFACE_FACE_INDEX);
  if (!isUnknownArray(value.barycentric) || value.barycentric.length !== 2) {
    throw new Error("Surface barycentric weights must contain quantized B and C integers.");
  }
  const b = requireBoundedInteger(value.barycentric[0], "Surface barycentric B", 0, SURFACE_BARYCENTRIC_QUANTIZATION);
  const c = requireBoundedInteger(value.barycentric[1], "Surface barycentric C", 0, SURFACE_BARYCENTRIC_QUANTIZATION);
  if (b + c > SURFACE_BARYCENTRIC_QUANTIZATION) {
    throw new Error("Surface barycentric B and C weights cannot exceed the quantized triangle total.");
  }
  const pressure = requireBoundedInteger(value.pressure, "Surface pressure", 0, SURFACE_PRESSURE_QUANTIZATION);
  return { sourceObject: value.sourceObject, faceIndex, barycentric: [b, c], pressure };
}

export function parseSurfacePaintStrokes(input: Readonly<{
  section: AnatomySection;
  value: unknown;
}>): SurfacePaintStrokes {
  if (!isUnknownArray(input.value)) throw new Error("Surface strokes must be an ordered array.");
  if (input.value.length > MAX_SURFACE_PAINT_STROKES) {
    throw new Error(`A coloring section cannot contain more than ${MAX_SURFACE_PAINT_STROKES} surface strokes.`);
  }

  const seenIds = new Set<string>();
  const parsed: SurfacePaintStroke[] = [];
  let anchorCount = 0;
  for (const rawStroke of input.value) {
    if (!isRecord(rawStroke) || !hasOnlyKeys(rawStroke, ["id", "boneId", "brush", "anchors"]) ||
      typeof rawStroke.id !== "string" || rawStroke.id.trim().length === 0 || rawStroke.id.length > 180 ||
      typeof rawStroke.boneId !== "string") {
      throw new Error("Each surface stroke must contain one bounded id, bone, brush, and anchor list.");
    }
    if (seenIds.has(rawStroke.id)) throw new Error(`Surface stroke id ${rawStroke.id} is duplicated.`);
    const bone = requireSectionBone(input.section, rawStroke.boneId);
    const brush = parseSurfacePaintBrush(rawStroke.brush);
    if (!isUnknownArray(rawStroke.anchors) || rawStroke.anchors.length === 0 ||
      rawStroke.anchors.length > MAX_SURFACE_PAINT_ANCHORS_PER_STROKE) {
      throw new Error(`A surface stroke must contain 1 through ${MAX_SURFACE_PAINT_ANCHORS_PER_STROKE} anchors.`);
    }
    const anchors = rawStroke.anchors.map((anchor) => parseSurfacePaintAnchor(anchor, bone));
    anchorCount += anchors.length;
    if (anchorCount > MAX_SURFACE_PAINT_ANCHORS) {
      throw new Error(`A coloring section cannot contain more than ${MAX_SURFACE_PAINT_ANCHORS} surface anchors.`);
    }
    seenIds.add(rawStroke.id);
    parsed.push({ id: rawStroke.id, boneId: bone.id, brush, anchors });
  }
  return parsed;
}

export function applyAnatomyPaintEdit(input: Readonly<{
  section: AnatomySection;
  baseFills: ColoringBaseFills;
  surfaceStrokes: SurfacePaintStrokes;
  edit: AnatomyPaintEdit;
  mutationId: string;
}>): ColoringSurfaceState {
  const baseFills = parseColoringBaseFills({ section: input.section, value: input.baseFills });
  const surfaceStrokes = parseSurfacePaintStrokes({ section: input.section, value: input.surfaceStrokes });
  switch (input.edit.kind) {
    case "surface-stroke": {
      const stroke = parseSurfacePaintStrokes({
        section: input.section,
        value: [{
          id: input.mutationId,
          boneId: input.edit.boneId,
          brush: input.edit.brush,
          anchors: input.edit.anchors,
        }],
      })[0];
      if (stroke === undefined) throw new Error("The surface stroke did not contain any paint data.");
      if (surfaceStrokes.some((candidate) => candidate.id === stroke.id)) {
        throw new Error(`Surface stroke id ${stroke.id} already exists.`);
      }
      return {
        baseFills,
        surfaceStrokes: parseSurfacePaintStrokes({ section: input.section, value: [...surfaceStrokes, stroke] }),
      };
    }
    case "clear-bone": {
      const boneId = input.edit.boneId;
      requireSectionBone(input.section, boneId);
      return {
        baseFills: baseFills.filter(([candidateBoneId]) => candidateBoneId !== boneId),
        surfaceStrokes: surfaceStrokes.filter((stroke) => stroke.boneId !== boneId),
      };
    }
    case "clear-section":
      return { baseFills: [], surfaceStrokes: [] };
    default: {
      const exhaustive: never = input.edit;
      return exhaustive;
    }
  }
}

export function coloringCompletion(input: Readonly<{
  section: AnatomySection;
  baseFills: ColoringBaseFills;
  surfaceStrokes: SurfacePaintStrokes;
}>): ColoringCompletion {
  const baseFills = parseColoringBaseFills({ section: input.section, value: input.baseFills });
  const surfaceStrokes = parseSurfacePaintStrokes({ section: input.section, value: input.surfaceStrokes });
  const baseFilledIds = new Set(baseFills.map(([boneId]) => boneId));
  const surfacePaintedIds = new Set(surfaceStrokes
    .filter((stroke) => stroke.brush.kind === "paint")
    .map((stroke) => stroke.boneId));
  return {
    baseFilledBoneCount: baseFilledIds.size,
    surfacePaintedBoneCount: surfacePaintedIds.size,
    completedBoneCount: new Set([...baseFilledIds, ...surfacePaintedIds]).size,
    surfaceStrokeCount: surfaceStrokes.length,
    surfaceAnchorCount: surfaceStrokes.reduce((count, stroke) => count + stroke.anchors.length, 0),
  };
}

export function createColoringBaseFillLookup(input: Readonly<{
  section: AnatomySection;
  baseFills: ColoringBaseFills;
}>): ReadonlyMap<string, ColoringColorId> {
  return new Map(parseColoringBaseFills({ section: input.section, value: input.baseFills }));
}

export function surfacePaintStateFingerprint(input: Readonly<{
  section: AnatomySection;
  surfaceStrokes: SurfacePaintStrokes;
}>): string {
  const canonical = JSON.stringify(parseSurfacePaintStrokes({ section: input.section, value: input.surfaceStrokes }));
  let hash = 2_166_136_261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function quantizeSurfaceBarycentric(input: readonly [a: number, b: number, c: number]): readonly [b: number, c: number] {
  const [a, b, c] = input;
  if (![a, b, c].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error("Surface barycentric weights must be finite non-negative numbers.");
  }
  const total = a + b + c;
  if (total <= 0) throw new Error("Surface barycentric weights must contain a positive total.");
  let quantizedB = Math.round(b / total * SURFACE_BARYCENTRIC_QUANTIZATION);
  let quantizedC = Math.round(c / total * SURFACE_BARYCENTRIC_QUANTIZATION);
  const overflow = quantizedB + quantizedC - SURFACE_BARYCENTRIC_QUANTIZATION;
  if (overflow > 0) {
    if (quantizedB >= quantizedC) quantizedB -= overflow;
    else quantizedC -= overflow;
  }
  return [quantizedB, quantizedC];
}

export function quantizeSurfacePressure(pressure: number): number {
  if (!Number.isFinite(pressure)) throw new Error("Surface pressure must be finite.");
  return Math.round(Math.min(1, Math.max(0, pressure)) * SURFACE_PRESSURE_QUANTIZATION);
}

export function coloringLabelPresentation(input: Readonly<{
  section: AnatomySection;
  boneId: string;
  mode: ColoringLabelMode;
}>): ColoringLabelPresentation {
  const bones = bonesForSection(input.section);
  const index = bones.findIndex((bone) => bone.id === input.boneId);
  if (index < 0) {
    requireBone(input.boneId);
    throw new Error(`Bone ${input.boneId} does not belong to the ${input.section} coloring lab.`);
  }
  const bone = bones[index];
  if (bone === undefined) throw new Error(`Bone ${input.boneId} is missing from its coloring lab.`);

  switch (input.mode) {
    case "guided":
      return { kind: "guided", text: bone.name };
    case "recall":
      return { kind: "recall", questionNumber: index + 1 };
    default: {
      const exhaustive: never = input.mode;
      return exhaustive;
    }
  }
}
