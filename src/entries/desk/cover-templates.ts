import type { NotebookId } from "../../domain";

export type CoverTone = "forest" | "navy" | "claret" | "umber";

const COVER_TONES: readonly CoverTone[] = [
  "forest",
  "navy",
  "claret",
  "umber",
];

export function coverToneFor(notebookId: NotebookId): CoverTone {
  let value = 0;
  for (const character of notebookId) {
    value = (value + (character.codePointAt(0) ?? 0)) % COVER_TONES.length;
  }
  return COVER_TONES[value] ?? "forest";
}
