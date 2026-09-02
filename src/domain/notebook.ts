import { z } from "zod";

export type NotebookId = string & { readonly __brand: "NotebookId" };
export type Revision = number & { readonly __brand: "Revision" };
export type IsoInstant = string & { readonly __brand: "IsoInstant" };

export const NOTEBOOK_TITLE_MAX_LENGTH = 120;
export const NOTEBOOK_SUBJECT_MAX_LENGTH = 240;

export type Notebook = {
  readonly id: NotebookId;
  readonly title: string;
  readonly subject: string;
  readonly revision: Revision;
  readonly createdAt: IsoInstant;
  readonly updatedAt: IsoInstant;
};

export type NotebookCreateInput = {
  readonly id: NotebookId;
  readonly title: string;
  readonly subject: string;
  readonly createdAt: IsoInstant;
};

export type NotebookUpdateInput = {
  readonly title?: string;
  readonly subject?: string;
};

export type NotebookUpdateOptions = {
  readonly expectedRevision?: Revision;
};

export type NotebookErrorCode =
  | "INVALID_NOTEBOOK"
  | "NOTEBOOK_NOT_FOUND"
  | "NOTEBOOK_CONFLICT";

export class NotebookDomainError extends Error {
  public readonly code: NotebookErrorCode;

  public constructor(code: NotebookErrorCode, message: string) {
    super(message);
    this.name = "NotebookDomainError";
    this.code = code;
  }
}

export class NotebookValidationError extends NotebookDomainError {
  public constructor(message: string) {
    super("INVALID_NOTEBOOK", message);
    this.name = "NotebookValidationError";
  }
}

export class NotebookNotFoundError extends NotebookDomainError {
  public constructor(id: NotebookId) {
    super("NOTEBOOK_NOT_FOUND", `Notebook ${id} was not found.`);
    this.name = "NotebookNotFoundError";
  }
}

export class NotebookConflictError extends NotebookDomainError {
  public constructor(id: NotebookId, expected: Revision, actual: Revision) {
    super(
      "NOTEBOOK_CONFLICT",
      `Notebook ${id} changed from revision ${expected} to revision ${actual}.`,
    );
    this.name = "NotebookConflictError";
  }
}

const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const NotebookIdParser = z
  .string()
  .trim()
  .min(1)
  .pipe(z.custom<NotebookId>());
const RevisionParser = z
  .number()
  .int()
  .safe()
  .min(1)
  .pipe(z.custom<Revision>());
const IsoInstantParser = z
  .string()
  .regex(ISO_INSTANT_PATTERN)
  .refine((value) => !Number.isNaN(Date.parse(value)))
  .pipe(z.custom<IsoInstant>());

export function createNotebookId(value: string): NotebookId {
  if (value.trim().length === 0) {
    throw new NotebookValidationError("Notebook id must not be empty.");
  }
  return NotebookIdParser.parse(value);
}

export function createRevision(value: number): Revision {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new NotebookValidationError("Revision must be a positive safe integer.");
  }
  return RevisionParser.parse(value);
}

export function createIsoInstant(value: string): IsoInstant {
  if (!ISO_INSTANT_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new NotebookValidationError("Instant must be an ISO-8601 UTC timestamp.");
  }
  return IsoInstantParser.parse(value);
}

export function nowIsoInstant(): IsoInstant {
  return createIsoInstant(new Date().toISOString());
}

export function generateNotebookId(): NotebookId {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) {
    return createNotebookId(cryptoApi.randomUUID());
  }
  const random = Math.random().toString(36).slice(2);
  return createNotebookId(`notebook-${Date.now().toString(36)}-${random}`);
}

function validateText(value: string, field: "title" | "subject", maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new NotebookValidationError(`Notebook ${field} must not be empty.`);
  }
  if (normalized.length > maximum) {
    throw new NotebookValidationError(
      `Notebook ${field} must be ${maximum} characters or fewer.`,
    );
  }
  return normalized;
}

export function validateNotebookTitle(value: string): string {
  return validateText(value, "title", NOTEBOOK_TITLE_MAX_LENGTH);
}

export function validateNotebookSubject(value: string): string {
  return validateText(value, "subject", NOTEBOOK_SUBJECT_MAX_LENGTH);
}

export function createNotebook(input: NotebookCreateInput): Notebook {
  const title = validateNotebookTitle(input.title);
  const subject = validateNotebookSubject(input.subject);
  return {
    id: createNotebookId(input.id),
    title,
    subject,
    revision: createRevision(1),
    createdAt: createIsoInstant(input.createdAt),
    updatedAt: createIsoInstant(input.createdAt),
  };
}

export function updateNotebook(
  notebook: Notebook,
  input: NotebookUpdateInput,
  updatedAt: IsoInstant,
  options: NotebookUpdateOptions = {},
): Notebook {
  if (
    options.expectedRevision !== undefined &&
    options.expectedRevision !== notebook.revision
  ) {
    throw new NotebookConflictError(
      notebook.id,
      options.expectedRevision,
      notebook.revision,
    );
  }

  const title =
    input.title === undefined ? notebook.title : validateNotebookTitle(input.title);
  const subject =
    input.subject === undefined
      ? notebook.subject
      : validateNotebookSubject(input.subject);

  return {
    ...notebook,
    title,
    subject,
    revision: createRevision(notebook.revision + 1),
    updatedAt: createIsoInstant(updatedAt),
  };
}

export function assertNotebookFound(
  notebook: Notebook | null,
  id: NotebookId,
): Notebook {
  if (notebook === null) {
    throw new NotebookNotFoundError(id);
  }
  return notebook;
}
