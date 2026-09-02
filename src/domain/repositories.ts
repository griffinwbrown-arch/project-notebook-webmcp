import type { Notebook, NotebookId, Revision } from "./notebook";

export interface NotebookRepository {
  create(notebook: Notebook): Promise<Notebook>;
  get(id: NotebookId): Promise<Notebook | null>;
  list(): Promise<Notebook[]>;
  update(notebook: Notebook, expectedRevision?: Revision): Promise<Notebook>;
}
