import type { IsoInstant, NotebookId } from "./notebook";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export type CanvasSnapshotEnvelope = {
  readonly version: 1;
  readonly notebookId: NotebookId;
  readonly savedAt: IsoInstant;
  readonly snapshot: JsonValue;
};

export interface CanvasSnapshotStore {
  save(snapshot: CanvasSnapshotEnvelope): Promise<CanvasSnapshotEnvelope>;
  get(notebookId: NotebookId): Promise<CanvasSnapshotEnvelope | null>;
}
