import { z } from "zod";

import type { IsoInstant } from "../domain";
import type {
  PageDocument,
  PageElement,
  PageRecord,
  PageRevision,
  PageVectorInkElement,
} from "./domain";
import {
  VectorInkDocumentSchema,
  VectorInkProvenanceSchema,
  validateVectorInkDocument,
  validateVectorInkProvenance,
} from "./vector-ink";

export const VECTOR_INK_REPLACEMENT_LIMITS = {
  maxHistoryEntries: 32,
  maxHistoryBytes: 64 * 1024,
  maxProposalIdLength: 160,
} as const;

const ReplacementProvenanceSchema = VectorInkProvenanceSchema
  .transform((value) => validateVectorInkProvenance(value));

export const VectorInkReplacementRecordSchema = z.object({
  kind: z.literal("typed-vector-document-replacement"),
  version: z.literal(1),
  priorProvenance: ReplacementProvenanceSchema.optional(),
  newProvenance: ReplacementProvenanceSchema,
}).strict();

export type VectorInkReplacementRecord = Readonly<z.infer<typeof VectorInkReplacementRecordSchema>>;

export const VectorInkReplacementHistorySchema = z.array(VectorInkReplacementRecordSchema)
  .max(VECTOR_INK_REPLACEMENT_LIMITS.maxHistoryEntries);

const ReplacementProposalIdSchema = z.string()
  .trim()
  .min(1)
  .max(VECTOR_INK_REPLACEMENT_LIMITS.maxProposalIdLength)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "contains control characters");

const ReplacementTargetFrameSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
}).strict();

export const VectorInkReplacementProposalSchema = z.object({
  kind: z.literal("vector-ink-replacement-proposal"),
  version: z.literal(1),
  proposalId: ReplacementProposalIdSchema,
  pageId: z.string().trim().min(1),
  pageNumber: z.number().int().safe().positive(),
  pageRevision: z.number().int().safe().positive(),
  elementId: z.string().trim().min(1),
  targetLabel: z.string(),
  targetFrame: ReplacementTargetFrameSchema,
  priorDocument: VectorInkDocumentSchema,
  priorProvenance: ReplacementProvenanceSchema.optional(),
  priorReplacementHistory: VectorInkReplacementHistorySchema,
  newDocument: VectorInkDocumentSchema,
  newProvenance: ReplacementProvenanceSchema,
  replacementRecord: VectorInkReplacementRecordSchema,
}).strict();

export type VectorInkReplacementProposal = Readonly<z.infer<typeof VectorInkReplacementProposalSchema>>;

export type VectorInkReplacementErrorCode =
  | "TARGET_NOT_FOUND"
  | "AMBIGUOUS_TARGET"
  | "NON_VECTOR_TARGET"
  | "STALE_REPLACEMENT"
  | "NO_OP_REPLACEMENT"
  | "INVALID_REPLACEMENT";

export class VectorInkReplacementError extends Error {
  public constructor(
    public readonly code: VectorInkReplacementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VectorInkReplacementError";
  }
}

type PageVectorInkElementWithHistory = PageVectorInkElement & Readonly<{
  replacementHistory?: readonly VectorInkReplacementRecord[];
}>;

export type VectorInkReplacementTarget = Readonly<{
  page: PageRecord;
  element: PageVectorInkElementWithHistory;
}>;

export type CurrentVectorInkReplacement = VectorInkReplacementTarget & Readonly<{
  proposal: VectorInkReplacementProposal;
}>;

function replacementError(code: VectorInkReplacementErrorCode, message: string): VectorInkReplacementError {
  return new VectorInkReplacementError(code, message);
}

function normalizedProvenance(value: unknown): object | null {
  if (value === undefined) return null;
  const provenance = validateVectorInkProvenance(value);
  return {
    kind: provenance.kind,
    sourceLabel: provenance.sourceLabel,
    ...(provenance.sourceFormat !== undefined ? { sourceFormat: provenance.sourceFormat } : {}),
    ...(provenance.tool !== undefined ? { tool: provenance.tool } : {}),
    ...(provenance.toolVersion !== undefined ? { toolVersion: provenance.toolVersion } : {}),
  };
}

function normalizedReplacementRecord(record: VectorInkReplacementRecord): object {
  return {
    kind: record.kind,
    version: record.version,
    ...(record.priorProvenance !== undefined
      ? { priorProvenance: normalizedProvenance(record.priorProvenance) }
      : {}),
    newProvenance: normalizedProvenance(record.newProvenance),
  };
}

function normalizedHistoryJson(history: readonly VectorInkReplacementRecord[]): string {
  return JSON.stringify(history.map(normalizedReplacementRecord));
}

function historyByteLength(history: readonly VectorInkReplacementRecord[]): number {
  return new TextEncoder().encode(normalizedHistoryJson(history)).byteLength;
}

function sameProvenance(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizedProvenance(left)) === JSON.stringify(normalizedProvenance(right));
}

function sameDocument(left: unknown, right: unknown): boolean {
  return JSON.stringify(validateVectorInkDocument(left)) === JSON.stringify(validateVectorInkDocument(right));
}

function sameHistory(
  left: readonly VectorInkReplacementRecord[],
  right: readonly VectorInkReplacementRecord[],
): boolean {
  return normalizedHistoryJson(left) === normalizedHistoryJson(right);
}

function sameFrame(
  left: Readonly<{ x: number; y: number; width: number; height: number }>,
  right: Readonly<{ x: number; y: number; width: number; height: number }>,
): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

/** Validate persisted replacement history, including its exact normalized byte bound. */
export function validateVectorInkReplacementHistory(value: unknown): readonly VectorInkReplacementRecord[] {
  const parsed = VectorInkReplacementHistorySchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.join(".");
    throw replacementError(
      "INVALID_REPLACEMENT",
      `Vector ink replacement history ${location ? `${location}: ` : ""}${issue?.message ?? "is malformed"}.`,
    );
  }
  const history = parsed.data;
  if (historyByteLength(history) > VECTOR_INK_REPLACEMENT_LIMITS.maxHistoryBytes) {
    throw replacementError(
      "INVALID_REPLACEMENT",
      `Vector ink replacement history exceeds ${VECTOR_INK_REPLACEMENT_LIMITS.maxHistoryBytes} bytes.`,
    );
  }
  return history;
}

function elementHistory(element: PageVectorInkElement): readonly VectorInkReplacementRecord[] {
  if (!("replacementHistory" in element) || element.replacementHistory === undefined) return [];
  return validateVectorInkReplacementHistory(element.replacementHistory);
}

/** Resolve one exact element id, optionally narrowed to one exact page id. */
export function resolveVectorInkReplacementTarget(input: Readonly<{
  document: PageDocument;
  elementId: string;
  pageId?: string;
}>): VectorInkReplacementTarget {
  const elementId = input.elementId.trim();
  if (elementId.length === 0) {
    throw replacementError("TARGET_NOT_FOUND", "The exact vector ink element id is required.");
  }
  const pages = input.pageId === undefined
    ? input.document.pages
    : input.document.pages.filter((page) => page.id === input.pageId);
  if (pages.length === 0) {
    throw replacementError("TARGET_NOT_FOUND", "The exact vector ink page was not found.");
  }
  if (input.pageId !== undefined && pages.length > 1) {
    throw replacementError("AMBIGUOUS_TARGET", "The exact vector ink page id is ambiguous.");
  }
  const matches = pages.flatMap((page) => page.elements
    .filter((element) => element.id === elementId)
    .map((element) => ({ page, element })));
  if (matches.length === 0) {
    throw replacementError("TARGET_NOT_FOUND", "The exact vector ink element was not found.");
  }
  if (matches.length > 1) {
    throw replacementError("AMBIGUOUS_TARGET", "The exact vector ink element id appears on more than one page.");
  }
  const match = matches[0];
  if (match === undefined) {
    throw replacementError("TARGET_NOT_FOUND", "The exact vector ink element was not found.");
  }
  if (match.element.kind !== "vector-ink") {
    throw replacementError("NON_VECTOR_TARGET", "The exact target is not a vector ink element.");
  }
  const replacementHistory = elementHistory(match.element);
  return {
    page: match.page,
    element: {
      ...match.element,
      ...(replacementHistory.length > 0 ? { replacementHistory } : {}),
    },
  };
}

function validateExpectedRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw replacementError("INVALID_REPLACEMENT", "The expected page revision must be a positive integer.");
  }
  return value;
}

/** Construct the validated review proposal from freshly read page authority. */
export async function createVectorInkReplacementProposal(input: Readonly<{
  document: PageDocument;
  proposalId: string;
  elementId: string;
  pageId?: string;
  expectedPageRevision: number;
  newDocument: unknown;
  newProvenance: unknown;
}>): Promise<VectorInkReplacementProposal> {
  const proposalId = ReplacementProposalIdSchema.parse(input.proposalId);
  const target = resolveVectorInkReplacementTarget(input);
  const expectedRevision = validateExpectedRevision(input.expectedPageRevision);
  if (target.page.revision !== expectedRevision) {
    throw replacementError("STALE_REPLACEMENT", "The target page revision changed before review.");
  }
  const newDocument = validateVectorInkDocument(input.newDocument);
  if (sameDocument(newDocument, target.element.document)) {
    throw replacementError("NO_OP_REPLACEMENT", "The replacement vector document is identical to the current document.");
  }
  const newProvenance = validateVectorInkProvenance(input.newProvenance);
  const priorProvenance = target.element.provenance === undefined
    ? undefined
    : validateVectorInkProvenance(target.element.provenance);
  const priorReplacementHistory = elementHistory(target.element);
  const replacementRecord: VectorInkReplacementRecord = {
    kind: "typed-vector-document-replacement",
    version: 1,
    ...(priorProvenance !== undefined ? { priorProvenance } : {}),
    newProvenance,
  };
  validateVectorInkReplacementHistory([...priorReplacementHistory, replacementRecord]);
  return VectorInkReplacementProposalSchema.parse({
    kind: "vector-ink-replacement-proposal",
    version: 1,
    proposalId,
    pageId: target.page.id,
    pageNumber: target.page.number,
    pageRevision: target.page.revision,
    elementId: target.element.id,
    targetLabel: target.element.label,
    targetFrame: target.element.frame,
    priorDocument: target.element.document,
    ...(priorProvenance !== undefined ? { priorProvenance } : {}),
    priorReplacementHistory,
    newDocument,
    newProvenance,
    replacementRecord,
  });
}

/** Revalidate a proposal and its exact typed content before Apply. */
export async function validateVectorInkReplacementProposal(value: unknown): Promise<VectorInkReplacementProposal> {
  const parsed = VectorInkReplacementProposalSchema.safeParse(value);
  if (!parsed.success) {
    throw replacementError("INVALID_REPLACEMENT", "The vector ink replacement proposal is malformed or unsupported.");
  }
  const proposal = parsed.data;
  const priorReplacementHistory = validateVectorInkReplacementHistory(proposal.priorReplacementHistory);
  validateVectorInkReplacementHistory([...priorReplacementHistory, proposal.replacementRecord]);
  const priorDocument = validateVectorInkDocument(proposal.priorDocument);
  const newDocument = validateVectorInkDocument(proposal.newDocument);
  if (!sameProvenance(proposal.replacementRecord.priorProvenance, proposal.priorProvenance) ||
    !sameProvenance(proposal.replacementRecord.newProvenance, proposal.newProvenance)) {
    throw replacementError("INVALID_REPLACEMENT", "The vector ink replacement proposal metadata does not match its content.");
  }
  if (sameDocument(newDocument, priorDocument)) {
    throw replacementError("NO_OP_REPLACEMENT", "The replacement vector document is identical to the current document.");
  }
  return proposal;
}

/** Fresh-read and compare every persisted field that the reviewed proposal depends on. */
export async function assertVectorInkReplacementProposalCurrent(input: Readonly<{
  document: PageDocument;
  proposal: unknown;
}>): Promise<CurrentVectorInkReplacement> {
  const proposal = await validateVectorInkReplacementProposal(input.proposal);
  const target = resolveVectorInkReplacementTarget({
    document: input.document,
    pageId: proposal.pageId,
    elementId: proposal.elementId,
  });
  if (target.page.revision !== proposal.pageRevision) {
    throw replacementError("STALE_REPLACEMENT", "The target page revision changed after review.");
  }
  const currentHistory = elementHistory(target.element);
  if (target.page.number !== proposal.pageNumber ||
    target.element.label !== proposal.targetLabel ||
    !sameFrame(target.element.frame, proposal.targetFrame) ||
    !sameDocument(target.element.document, proposal.priorDocument) ||
    !sameProvenance(target.element.provenance, proposal.priorProvenance) ||
    !sameHistory(currentHistory, proposal.priorReplacementHistory)) {
    throw replacementError("STALE_REPLACEMENT", "The target vector ink state changed after review.");
  }
  return { ...target, proposal };
}

/**
 * Apply only the reviewed document, provenance, and append-only history to one page.
 * Callers supply branded boundary values; this function verifies one revision step.
 */
export function applyVectorInkReplacement(input: Readonly<{
  current: CurrentVectorInkReplacement;
  nextRevision: PageRevision;
  updatedAt: IsoInstant;
}>): PageRecord {
  if (input.current.page.revision + 1 !== input.nextRevision) {
    throw replacementError("INVALID_REPLACEMENT", "Apply must advance the page by exactly one revision.");
  }
  const replacementHistory = validateVectorInkReplacementHistory([
    ...input.current.proposal.priorReplacementHistory,
    input.current.proposal.replacementRecord,
  ]);
  let replacementCount = 0;
  const elements: readonly PageElement[] = input.current.page.elements.map((element) => {
    if (element.id !== input.current.proposal.elementId) return element;
    if (element.kind !== "vector-ink") {
      throw replacementError("NON_VECTOR_TARGET", "The exact target is not a vector ink element.");
    }
    replacementCount += 1;
    const replacement: PageVectorInkElementWithHistory = {
      ...element,
      document: validateVectorInkDocument(input.current.proposal.newDocument),
      provenance: validateVectorInkProvenance(input.current.proposal.newProvenance),
      replacementHistory,
    };
    return replacement;
  });
  if (replacementCount === 0) {
    throw replacementError("TARGET_NOT_FOUND", "The exact vector ink element was not found at Apply.");
  }
  if (replacementCount > 1) {
    throw replacementError("AMBIGUOUS_TARGET", "The exact vector ink element id is ambiguous at Apply.");
  }
  return {
    ...input.current.page,
    revision: input.nextRevision,
    updatedAt: input.updatedAt,
    elements,
  };
}
