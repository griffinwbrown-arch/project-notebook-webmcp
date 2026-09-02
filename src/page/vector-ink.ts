import { z } from "zod";

/** Hard limits for portable, editable vector ink. */
export const VECTOR_INK_LIMITS = {
  minViewBoxDimension: 1,
  maxViewBoxDimension: 4096,
  maxPaths: 256,
  maxCommands: 20_000,
  maxSerializedBytes: 512 * 1024,
  minStrokeWidth: 0.25,
  maxStrokeWidth: 16,
} as const;

export type VectorInkLinecap = "butt" | "round" | "square";
export type VectorInkLinejoin = "miter" | "round" | "bevel";

const vectorInkMoveSchema = z.object({
  kind: z.literal("move"),
  x: z.number().finite(),
  y: z.number().finite(),
}).strict();
const vectorInkLineSchema = z.object({
  kind: z.literal("line"),
  x: z.number().finite(),
  y: z.number().finite(),
}).strict();
const vectorInkCubicSchema = z.object({
  kind: z.literal("cubic"),
  x1: z.number().finite(),
  y1: z.number().finite(),
  x2: z.number().finite(),
  y2: z.number().finite(),
  x: z.number().finite(),
  y: z.number().finite(),
}).strict();
const vectorInkQuadSchema = z.object({
  kind: z.literal("quad"),
  x1: z.number().finite(),
  y1: z.number().finite(),
  x: z.number().finite(),
  y: z.number().finite(),
}).strict();
const vectorInkCloseSchema = z.object({ kind: z.literal("close") }).strict();

const vectorInkCommandSchema = z.discriminatedUnion("kind", [
  vectorInkMoveSchema,
  vectorInkLineSchema,
  vectorInkCubicSchema,
  vectorInkQuadSchema,
  vectorInkCloseSchema,
]);

export type VectorInkCommand = z.infer<typeof vectorInkCommandSchema>;

export const VECTOR_INK_COLORS = ["ink", "red", "blue", "green", "gray"] as const;
export type VectorInkColor = (typeof VECTOR_INK_COLORS)[number] | null;
export type VectorInkPaint = Readonly<{
  stroke: VectorInkColor;
  strokeWidth: number;
  fill: VectorInkColor;
  linecap: VectorInkLinecap;
  linejoin: VectorInkLinejoin;
}>;

const vectorInkPaintSchema = z.object({
  stroke: z.enum(VECTOR_INK_COLORS).nullable(),
  strokeWidth: z.number().finite(),
  fill: z.enum(VECTOR_INK_COLORS).nullable(),
  linecap: z.enum(["butt", "round", "square"]),
  linejoin: z.enum(["miter", "round", "bevel"]),
}).strict();

const vectorInkPathSchema = z.object({
  commands: z.array(vectorInkCommandSchema).min(1),
  paint: vectorInkPaintSchema,
}).strict();

export const VectorInkDocumentSchema = z.object({
  version: z.literal(1),
  viewBox: z.object({
    width: z.number().finite(),
    height: z.number().finite(),
  }).strict(),
  paths: z.array(vectorInkPathSchema).min(1).max(VECTOR_INK_LIMITS.maxPaths),
}).strict();

const vectorInkDocumentSchema = VectorInkDocumentSchema;

export type VectorInkPath = Readonly<{
  commands: readonly VectorInkCommand[];
  paint: VectorInkPaint;
}>;
export type VectorInkDocument = Readonly<{
  version: 1;
  viewBox: Readonly<{ width: number; height: number }>;
  paths: readonly VectorInkPath[];
}>;

/** Portable trace metadata. Filesystem paths are deliberately not part of this type. */
export type VectorInkProvenance = Readonly<{
  kind: string;
  sourceLabel: string;
  sourceFormat?: string;
  tool?: string;
  toolVersion?: string;
}>;

export const VectorInkProvenanceSchema = z.object({
  kind: z.string().trim().min(1).max(80),
  sourceLabel: z.string().trim().min(1).max(160),
  sourceFormat: z.string().trim().min(1).max(160).optional(),
  tool: z.string().trim().min(1).max(160).optional(),
  toolVersion: z.string().trim().min(1).max(160).optional(),
}).strict();

function validationError(message: string): Error {
  return new Error(`Vector ink ${message}`);
}

function isPortableMetadataString(value: string, maxLength: number): boolean {
  return value.length > 0 &&
    value.length <= maxLength &&
    !/[\\/]/.test(value) &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function validatePaint(paint: VectorInkPaint): void {
  if (paint.stroke === null && paint.fill === null) {
    throw validationError("paint must include a stroke or fill");
  }
  if (!Number.isFinite(paint.strokeWidth) ||
    paint.strokeWidth < VECTOR_INK_LIMITS.minStrokeWidth ||
    paint.strokeWidth > VECTOR_INK_LIMITS.maxStrokeWidth) {
    throw validationError(`stroke width must be between ${VECTOR_INK_LIMITS.minStrokeWidth} and ${VECTOR_INK_LIMITS.maxStrokeWidth}`);
  }
}

function coordinateInsideViewBox(value: number, maximum: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= maximum;
}

function validateCoordinate(value: number, axis: "x" | "y", maximum: number): void {
  if (!coordinateInsideViewBox(value, maximum)) {
    throw validationError(`${axis} coordinate must be finite and inside the viewBox`);
  }
}

function validateCommand(command: VectorInkCommand, width: number, height: number): void {
  switch (command.kind) {
    case "move":
    case "line":
      validateCoordinate(command.x, "x", width);
      validateCoordinate(command.y, "y", height);
      return;
    case "cubic":
      validateCoordinate(command.x1, "x", width);
      validateCoordinate(command.y1, "y", height);
      validateCoordinate(command.x2, "x", width);
      validateCoordinate(command.y2, "y", height);
      validateCoordinate(command.x, "x", width);
      validateCoordinate(command.y, "y", height);
      return;
    case "quad":
      validateCoordinate(command.x1, "x", width);
      validateCoordinate(command.y1, "y", height);
      validateCoordinate(command.x, "x", width);
      validateCoordinate(command.y, "y", height);
      return;
    case "close":
      return;
    default: {
      const exhaustive: never = command;
      throw validationError(`contains unsupported command ${exhaustive}`);
    }
  }
}

function validateCommandSequence(commands: readonly VectorInkCommand[]): void {
  let openSubpath = false;
  let currentSubpathDrewGeometry = false;
  let drewGeometry = false;
  for (const command of commands) {
    if (command.kind === "move") {
      if (openSubpath && !currentSubpathDrewGeometry) {
        throw validationError("each subpath must contain visible geometry");
      }
      openSubpath = true;
      currentSubpathDrewGeometry = false;
      continue;
    }
    if (command.kind === "close") {
      if (!openSubpath || !currentSubpathDrewGeometry) {
        throw validationError("path close must follow visible geometry in an open subpath");
      }
      openSubpath = false;
      continue;
    }
    if (!openSubpath) {
      throw validationError("path geometry must begin with a move command");
    }
    currentSubpathDrewGeometry = true;
    drewGeometry = true;
  }
  if (openSubpath && !currentSubpathDrewGeometry) {
    throw validationError("each subpath must contain visible geometry");
  }
  if (!drewGeometry) throw validationError("path must contain visible geometry");
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Validate an untrusted document at the page-command boundary. */
export function validateVectorInkDocument(value: unknown): VectorInkDocument {
  const parsed = vectorInkDocumentSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.join(".");
    throw validationError(`${location ? `${location}: ` : ""}${issue?.message ?? "document is malformed"}`);
  }
  const document = parsed.data;
  if (document.viewBox.width < VECTOR_INK_LIMITS.minViewBoxDimension ||
    document.viewBox.width > VECTOR_INK_LIMITS.maxViewBoxDimension ||
    document.viewBox.height < VECTOR_INK_LIMITS.minViewBoxDimension ||
    document.viewBox.height > VECTOR_INK_LIMITS.maxViewBoxDimension) {
    throw validationError("viewBox dimensions must be between 1 and 4096");
  }
  const commandCount = document.paths.reduce((total, path) => total + path.commands.length, 0);
  if (commandCount > VECTOR_INK_LIMITS.maxCommands) {
    throw validationError(`command count cannot exceed ${VECTOR_INK_LIMITS.maxCommands}`);
  }
  for (const path of document.paths) {
    validatePaint(path.paint);
    for (const command of path.commands) validateCommand(command, document.viewBox.width, document.viewBox.height);
    validateCommandSequence(path.commands);
  }
  const serialized = JSON.stringify(document);
  if (utf8ByteLength(serialized) > VECTOR_INK_LIMITS.maxSerializedBytes) {
    throw validationError(`serialized document exceeds ${VECTOR_INK_LIMITS.maxSerializedBytes} bytes`);
  }
  return document;
}

export function vectorInkPaint(input: VectorInkPaint): VectorInkPaint {
  const parsed = vectorInkPaintSchema.safeParse(input);
  if (!parsed.success) throw validationError("paint is malformed");
  const paint = parsed.data;
  validatePaint(paint);
  return paint;
}

function numberData(value: number): string {
  return String(value);
}

const VECTOR_INK_CSS_COLORS: Readonly<Record<Exclude<VectorInkColor, null>, string>> = {
  ink: "#403c31",
  red: "#b85e47",
  blue: "#2f67b1",
  green: "#28785d",
  gray: "#6b706d",
};

export function vectorInkColorValue(color: VectorInkColor): string | undefined {
  return color === null ? undefined : VECTOR_INK_CSS_COLORS[color];
}

/** Convert typed commands to a constrained SVG path-data string. */
export function vectorInkPathData(commands: readonly VectorInkCommand[]): string {
  return commands.map((command) => {
    switch (command.kind) {
      case "move": return `M ${numberData(command.x)} ${numberData(command.y)}`;
      case "line": return `L ${numberData(command.x)} ${numberData(command.y)}`;
      case "cubic": return `C ${numberData(command.x1)} ${numberData(command.y1)} ${numberData(command.x2)} ${numberData(command.y2)} ${numberData(command.x)} ${numberData(command.y)}`;
      case "quad": return `Q ${numberData(command.x1)} ${numberData(command.y1)} ${numberData(command.x)} ${numberData(command.y)}`;
      case "close": return "Z";
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  }).join(" ");
}

export function validateVectorInkProvenance(value: unknown): VectorInkProvenance {
  const parsed = VectorInkProvenanceSchema.safeParse(value);
  if (!parsed.success) throw validationError("provenance must be a portable metadata object");
  const record = parsed.data;
  if (!isPortableMetadataString(record.kind, 80) || !isPortableMetadataString(record.sourceLabel, 160)) {
    throw validationError("provenance kind and sourceLabel must be bounded strings");
  }
  for (const [key, field] of Object.entries(record)) {
    if (typeof field !== "string" || !isPortableMetadataString(field, 160)) {
      throw validationError(`provenance ${key} must be a portable bounded string`);
    }
  }
  return {
    kind: record.kind,
    sourceLabel: record.sourceLabel,
    ...(record.sourceFormat !== undefined ? { sourceFormat: record.sourceFormat } : {}),
    ...(record.tool !== undefined ? { tool: record.tool } : {}),
    ...(record.toolVersion !== undefined ? { toolVersion: record.toolVersion } : {}),
  };
}
