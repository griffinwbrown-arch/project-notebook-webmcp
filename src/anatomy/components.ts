import { z } from "zod";

import type { EmbeddedFrameElement } from "../page/domain";
import {
  ANATOMY_CATALOG_VERSION,
  VERIFIED_ATLAS_LOGICAL_BONE_COUNT,
  VERIFIED_ATLAS_SEMANTIC_MESH_COUNT,
  VERIFIED_ATLAS_VERSION,
} from "./catalog";
import {
  COLORING_PALETTE_VERSION,
  MAX_SURFACE_FACE_INDEX,
  MAX_SURFACE_PAINT_ANCHORS_PER_STROKE,
  MAX_SURFACE_PAINT_STROKES,
  SURFACE_BARYCENTRIC_QUANTIZATION,
  SURFACE_BRUSH_BASIS_POINTS,
  SURFACE_PRESSURE_QUANTIZATION,
  parseColoringBaseFills,
  parseSurfacePaintStrokes,
  type ColoringBaseFills,
  type SurfacePaintStrokes,
} from "./coloring-domain";

export const ANATOMY_SKELETON_COMPONENT = "anatomy-skeleton-study";
export const ANATOMY_COMPONENT_VERSION = 2;
export const ANATOMY_COLORING_COMPONENT = "anatomy-coloring-lab";
export const ANATOMY_COLORING_COMPONENT_VERSION = 2;
export const ANATOMY_COLORING_LEGACY_COMPONENT_VERSION = 1;
export const VERIFIED_ATLAS_ASSET_ID = "z-anatomy-authority-atlas-206";

export const AnatomySectionSchema = z.enum([
  "skull",
  "vertebral-column",
  "thorax",
  "upper-limb",
  "pelvis",
  "lower-limb",
]);

export const AnatomyQuizSubmissionSchema = z.object({
  attemptId: z.string().trim().min(1).max(200),
  section: AnatomySectionSchema,
  correct: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  unanswered: z.number().int().nonnegative(),
  submittedAt: z.iso.datetime(),
}).strict().refine((value) => value.correct + value.unanswered <= value.total, {
  message: "The anatomy score is internally inconsistent.",
});

export const AnatomySkeletonPropsSchema = z.object({
  kind: z.literal("anatomy-skeleton"),
  assetId: z.literal(VERIFIED_ATLAS_ASSET_ID),
  catalogVersion: z.literal(ANATOMY_CATALOG_VERSION),
  atlasVersion: z.literal(VERIFIED_ATLAS_VERSION),
  logicalBoneCount: z.literal(VERIFIED_ATLAS_LOGICAL_BONE_COUNT),
  semanticMeshCount: z.literal(VERIFIED_ATLAS_SEMANTIC_MESH_COUNT),
  latestSubmission: AnatomyQuizSubmissionSchema.optional(),
}).strict();

export const AnatomyColoringBaseFillSchema = z.tuple([
  z.string().trim().min(1).max(200),
  z.enum(["carmine", "amber", "sage", "aqua", "cobalt", "iris", "rose", "graphite"]),
]);

export const AnatomySurfacePaintBrushSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("paint"),
    colorId: z.enum(["carmine", "amber", "sage", "aqua", "cobalt", "iris", "rose", "graphite"]),
    radiusBps: z.number().int().min(1).max(SURFACE_BRUSH_BASIS_POINTS),
    hardnessBps: z.number().int().min(0).max(SURFACE_BRUSH_BASIS_POINTS),
  }).strict(),
  z.object({
    kind: z.literal("erase"),
    radiusBps: z.number().int().min(1).max(SURFACE_BRUSH_BASIS_POINTS),
    hardnessBps: z.number().int().min(0).max(SURFACE_BRUSH_BASIS_POINTS),
  }).strict(),
]);

export const AnatomySurfacePaintAnchorSchema = z.object({
  sourceObject: z.string().trim().min(1).max(240),
  faceIndex: z.number().int().min(0).max(MAX_SURFACE_FACE_INDEX),
  barycentric: z.tuple([
    z.number().int().min(0).max(SURFACE_BARYCENTRIC_QUANTIZATION),
    z.number().int().min(0).max(SURFACE_BARYCENTRIC_QUANTIZATION),
  ]),
  pressure: z.number().int().min(0).max(SURFACE_PRESSURE_QUANTIZATION),
}).strict().superRefine((value, context) => {
  if (value.barycentric[0] + value.barycentric[1] > SURFACE_BARYCENTRIC_QUANTIZATION) {
    context.addIssue({ code: "custom", message: "Surface barycentric B and C weights exceed the quantized triangle total." });
  }
});

export const AnatomySurfacePaintStrokeSchema = z.object({
  id: z.string().trim().min(1).max(180),
  boneId: z.string().trim().min(1).max(200),
  brush: AnatomySurfacePaintBrushSchema,
  anchors: z.array(AnatomySurfacePaintAnchorSchema).min(1).max(MAX_SURFACE_PAINT_ANCHORS_PER_STROKE),
}).strict();

const AnatomyColoringIdentitySchema = z.object({
  kind: z.literal("anatomy-coloring-lab"),
  assetId: z.literal(VERIFIED_ATLAS_ASSET_ID),
  catalogVersion: z.literal(ANATOMY_CATALOG_VERSION),
  atlasVersion: z.literal(VERIFIED_ATLAS_VERSION),
  logicalBoneCount: z.literal(VERIFIED_ATLAS_LOGICAL_BONE_COUNT),
  semanticMeshCount: z.literal(VERIFIED_ATLAS_SEMANTIC_MESH_COUNT),
  section: AnatomySectionSchema,
  paletteVersion: z.literal(COLORING_PALETTE_VERSION),
});

export const AnatomyColoringPropsV1Schema = AnatomyColoringIdentitySchema.extend({
  assignments: z.array(AnatomyColoringBaseFillSchema).max(64),
  latestSubmission: AnatomyQuizSubmissionSchema.optional(),
}).strict().superRefine((value, context) => {
  try {
    const canonical = parseColoringBaseFills({ section: value.section, value: value.assignments });
    if (JSON.stringify(canonical) !== JSON.stringify(value.assignments)) {
      context.addIssue({ code: "custom", message: "Color assignments must be unique and stored in canonical catalog order." });
    }
  } catch (error: unknown) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "The anatomy color assignments are invalid.",
    });
  }
  if (value.latestSubmission !== undefined && value.latestSubmission.section !== value.section) {
    context.addIssue({ code: "custom", message: "The label score must belong to this coloring section." });
  }
});

export const AnatomyColoringPropsSchema = AnatomyColoringIdentitySchema.extend({
  baseFills: z.array(AnatomyColoringBaseFillSchema).max(64),
  surfaceStrokes: z.array(AnatomySurfacePaintStrokeSchema).max(MAX_SURFACE_PAINT_STROKES),
  latestSubmission: AnatomyQuizSubmissionSchema.optional(),
}).strict().superRefine((value, context) => {
  try {
    const canonical = parseColoringBaseFills({ section: value.section, value: value.baseFills });
    if (JSON.stringify(canonical) !== JSON.stringify(value.baseFills)) {
      context.addIssue({ code: "custom", message: "Base fills must be unique and stored in canonical catalog order." });
    }
  } catch (error: unknown) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "The anatomy base fills are invalid.",
    });
  }
  try {
    parseSurfacePaintStrokes({ section: value.section, value: value.surfaceStrokes });
  } catch (error: unknown) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "The anatomy surface strokes are invalid.",
    });
  }
  if (value.latestSubmission !== undefined && value.latestSubmission.section !== value.section) {
    context.addIssue({ code: "custom", message: "The label score must belong to this coloring section." });
  }
});

export type AnatomyQuizSubmission = z.infer<typeof AnatomyQuizSubmissionSchema>;
export type AnatomySkeletonProps = z.infer<typeof AnatomySkeletonPropsSchema>;
export type AnatomyColoringPropsV1 = z.infer<typeof AnatomyColoringPropsV1Schema>;
type ParsedAnatomyColoringProps = z.infer<typeof AnatomyColoringPropsSchema>;
export type AnatomyColoringProps = Readonly<
  Omit<ParsedAnatomyColoringProps, "baseFills" | "surfaceStrokes"> & Readonly<{
    baseFills: ColoringBaseFills;
    surfaceStrokes: SurfacePaintStrokes;
  }>
>;
export type AnatomyComponent =
  | Readonly<{ kind: "skeleton"; props: AnatomySkeletonProps }>
  | Readonly<{ kind: "coloring"; props: AnatomyColoringProps }>;

export function parseAnatomyComponent(element: EmbeddedFrameElement): AnatomyComponent | null {
  if (element.componentType === ANATOMY_SKELETON_COMPONENT && element.componentVersion === ANATOMY_COMPONENT_VERSION) {
    const parsed = AnatomySkeletonPropsSchema.safeParse(element.props);
    return parsed.success ? { kind: "skeleton", props: parsed.data } : null;
  }
  if (element.componentType === ANATOMY_COLORING_COMPONENT && element.componentVersion === ANATOMY_COLORING_COMPONENT_VERSION) {
    const parsed = AnatomyColoringPropsSchema.safeParse(element.props);
    return parsed.success ? { kind: "coloring", props: parsed.data } : null;
  }
  if (element.componentType === ANATOMY_COLORING_COMPONENT && element.componentVersion === ANATOMY_COLORING_LEGACY_COMPONENT_VERSION) {
    const parsed = AnatomyColoringPropsV1Schema.safeParse(element.props);
    if (!parsed.success) return null;
    const { assignments, ...identity } = parsed.data;
    const migrated = AnatomyColoringPropsSchema.safeParse({
      ...identity,
      baseFills: assignments,
      surfaceStrokes: [],
    });
    return migrated.success ? { kind: "coloring", props: migrated.data } : null;
  }
  return null;
}
