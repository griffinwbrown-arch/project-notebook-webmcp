export class PageStorageError extends Error {
  public constructor(
    public readonly code:
      | "not_found"
      | "revision_conflict"
      | "page_busy"
      | "mutation_reuse"
      | "stale_undo"
      | "already_undone"
      | "no_op"
      | "page_not_visible"
      | "invalid_page",
    message: string,
  ) {
    super(message);
    this.name = "PageStorageError";
  }
}
