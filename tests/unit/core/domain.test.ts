import { describe, expect, it, vi } from "vitest";

import {
  NotebookConflictError,
  NotebookValidationError,
  NOTEBOOK_SUBJECT_MAX_LENGTH,
  NOTEBOOK_TITLE_MAX_LENGTH,
  assertNotebookFound,
  createIsoInstant,
  createNotebook,
  createNotebookId,
  createRevision,
  generateNotebookId,
  validateNotebookSubject,
  validateNotebookTitle,
  updateNotebook,
} from "../../../src/domain";

const instant = createIsoInstant("2026-08-25T12:00:00.000Z");
const nextInstant = createIsoInstant("2026-08-25T12:01:00.000Z");

describe("notebook domain transitions", () => {
  it("creates a normalized first revision", () => {
    const notebook = createNotebook({
      id: createNotebookId("domain-create"),
      title: "  Project Notebook  ",
      subject: "  A subject  ",
      createdAt: instant,
    });

    expect(notebook.title).toBe("Project Notebook");
    expect(notebook.subject).toBe("A subject");
    expect(notebook.revision).toBe(1);
    expect(notebook.createdAt).toBe(instant);
    expect(notebook.updatedAt).toBe(instant);
  });

  it("updates one field and advances revision", () => {
    const notebook = createNotebook({
      id: createNotebookId("domain-update"),
      title: "Original",
      subject: "Subject",
      createdAt: instant,
    });

    const updated = updateNotebook(
      notebook,
      { title: "  Updated  " },
      nextInstant,
      { expectedRevision: createRevision(1) },
    );

    expect(updated.title).toBe("Updated");
    expect(updated.subject).toBe("Subject");
    expect(updated.revision).toBe(2);
    expect(updated.updatedAt).toBe(nextInstant);
  });

  it("rejects invalid text and stale updates", () => {
    const notebook = createNotebook({
      id: createNotebookId("domain-invalid"),
      title: "Original",
      subject: "Subject",
      createdAt: instant,
    });

    expect(() =>
      updateNotebook(notebook, { title: "   " }, nextInstant),
    ).toThrow(/title must not be empty/);
    expect(() =>
      updateNotebook(notebook, {}, nextInstant, {
        expectedRevision: createRevision(2),
      }),
    ).toThrow(NotebookConflictError);
    expect(() =>
      updateNotebook(notebook, {}, nextInstant, {
        expectedRevision: createRevision(2),
      }),
    ).toThrow("Notebook domain-invalid changed from revision 2 to revision 1.");
  });

  it("rejects empty identifiers, invalid instants, and non-positive revisions", () => {
    expect(() => createNotebookId("   ")).toThrow(
      "Notebook id must not be empty.",
    );
    expect(() => createIsoInstant("2026-08-25")).toThrow(NotebookValidationError);
    expect(() => createRevision(0)).toThrow(NotebookValidationError);
  });

  it("normalizes identifiers and rejects unsafe revision and timestamp boundaries", () => {
    expect(createNotebookId("  padded-id  ")).toBe("padded-id");
    expect(createRevision(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => createRevision(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      "Revision must be a positive safe integer.",
    );
    expect(() => createRevision(1.5)).toThrow(
      "Revision must be a positive safe integer.",
    );
    expect(() => createIsoInstant("2026-08-25T12:00:00Z")).toThrow(
      "Instant must be an ISO-8601 UTC timestamp.",
    );
    expect(() => createIsoInstant("2026-08-25T12:00:00.000Zextra")).toThrow(
      "Instant must be an ISO-8601 UTC timestamp.",
    );
  });

  it("accepts exact text limits and rejects values one character over", () => {
    const title = "t".repeat(NOTEBOOK_TITLE_MAX_LENGTH);
    const subject = "s".repeat(NOTEBOOK_SUBJECT_MAX_LENGTH);
    expect(validateNotebookTitle(title)).toBe(title);
    expect(validateNotebookSubject(subject)).toBe(subject);
    expect(() => validateNotebookTitle(`${title}x`)).toThrow(
      "Notebook title must be 120 characters or fewer.",
    );
    expect(() => validateNotebookSubject(`${subject}x`)).toThrow(
      "Notebook subject must be 240 characters or fewer.",
    );
  });

  it("uses a UUID when available and a deterministic fallback when it is not", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "crypto-id" });
    expect(generateNotebookId()).toBe("crypto-id");

    vi.stubGlobal("crypto", {});
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.spyOn(Date, "now").mockReturnValue(123456);
    expect(generateNotebookId()).toBe("notebook-2n9c-i");

    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("preserves omitted update fields and applies subject-only and both-field changes", () => {
    const notebook = createNotebook({
      id: createNotebookId("domain-shapes"),
      title: "Original title",
      subject: "Original subject",
      createdAt: instant,
    });

    const subjectOnly = updateNotebook(notebook, { subject: "Subject only" }, nextInstant);
    expect(subjectOnly).toMatchObject({
      title: "Original title",
      subject: "Subject only",
      revision: 2,
    });

    const both = updateNotebook(
      subjectOnly,
      { title: "Both title", subject: "Both subject" },
      nextInstant,
      { expectedRevision: createRevision(2) },
    );
    expect(both).toMatchObject({ title: "Both title", subject: "Both subject", revision: 3 });

    const omitted = updateNotebook(both, {}, nextInstant);
    expect(omitted).toMatchObject({ title: "Both title", subject: "Both subject", revision: 4 });
    expect(assertNotebookFound(omitted, omitted.id)).toBe(omitted);
    expect(() => assertNotebookFound(null, omitted.id)).toThrow(
      `Notebook ${omitted.id} was not found.`,
    );
  });
});
