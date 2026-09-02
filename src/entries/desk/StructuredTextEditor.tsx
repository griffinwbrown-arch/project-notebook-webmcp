"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import type {
  RichTextMark,
  RichTextRun,
  StructuredTextBlock,
} from "../../page";

type StructuredTextBlockKind = StructuredTextBlock["kind"];

export type StructuredTextEditorProps = Readonly<{
  label: string;
  blocks: readonly StructuredTextBlock[];
  saving?: boolean;
  error?: string | null;
  onSave: (blocks: readonly StructuredTextBlock[]) => void;
  onCancel: () => void;
  onReturnFocus: () => void;
}>;

type TextSelection = Readonly<{
  blockId: StructuredTextBlock["id"];
  start: number;
  end: number;
}>;

type MarkedCharacter = Readonly<{
  text: string;
  marks: readonly RichTextMark[];
}>;

const BLOCK_KINDS: readonly Readonly<{
  value: StructuredTextBlockKind;
  label: string;
}>[] = [
  { value: "paragraph", label: "Paragraph" },
  { value: "heading", label: "Heading" },
  { value: "quote", label: "Quote" },
  { value: "bullet-list-item", label: "Bullet list" },
  { value: "ordered-list-item", label: "Numbered list" },
];

const EDITOR_MARKS: readonly Readonly<{
  value: RichTextMark;
  label: string;
}>[] = [
  { value: "bold", label: "Bold" },
  { value: "italic", label: "Italic" },
  { value: "underline", label: "Underline" },
];

const FOCUSABLE_EDITOR_CONTROL = [
  "button:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function plainText(block: StructuredTextBlock): string {
  return block.runs.map((run) => run.text).join("");
}

function markedCharacters(block: StructuredTextBlock): readonly MarkedCharacter[] {
  return block.runs.flatMap((run) =>
    run.text.split("").map((text) => ({ text, marks: run.marks })),
  );
}

function sameMarks(left: readonly RichTextMark[], right: readonly RichTextMark[]): boolean {
  return left.length === right.length && left.every((mark, index) => mark === right[index]);
}

function compactRuns(characters: readonly MarkedCharacter[]): readonly RichTextRun[] {
  const runs: Array<{ text: string; marks: readonly RichTextMark[] }> = [];
  for (const character of characters) {
    const previous = runs.at(-1);
    if (previous !== undefined && sameMarks(previous.marks, character.marks)) {
      previous.text += character.text;
    } else {
      runs.push({ text: character.text, marks: [...character.marks] });
    }
  }
  return runs.length === 0 ? [{ text: "", marks: [] }] : runs;
}

function sameBlocks(
  left: readonly StructuredTextBlock[],
  right: readonly StructuredTextBlock[],
): boolean {
  return left.length === right.length && left.every((block, blockIndex) => {
    const other = right[blockIndex];
    return other !== undefined &&
      block.id === other.id &&
      block.kind === other.kind &&
      block.runs.length === other.runs.length &&
      block.runs.every((run, runIndex) => {
        const otherRun = other.runs[runIndex];
        return otherRun !== undefined &&
          run.text === otherRun.text &&
          sameMarks(run.marks, otherRun.marks);
      });
  });
}

function copyBlocks(blocks: readonly StructuredTextBlock[]): StructuredTextBlock[] {
  return blocks.map((block) => ({
    ...block,
    runs: block.runs.map((run) => ({ ...run, marks: [...run.marks] })),
  }));
}

function inheritMarks(
  characters: readonly MarkedCharacter[],
  start: number,
  typingMarks: readonly RichTextMark[],
): readonly RichTextMark[] {
  if (typingMarks.length > 0) return typingMarks;
  return characters[start]?.marks ?? characters[start - 1]?.marks ?? [];
}

function replaceText(
  block: StructuredTextBlock,
  nextText: string,
  typingMarks: readonly RichTextMark[],
): StructuredTextBlock {
  const beforeText = plainText(block);
  let prefix = 0;
  const sharedLength = Math.min(beforeText.length, nextText.length);
  while (prefix < sharedLength && beforeText[prefix] === nextText[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < beforeText.length - prefix &&
    suffix < nextText.length - prefix &&
    beforeText[beforeText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const beforeCharacters = markedCharacters(block);
  const inserted = nextText.slice(prefix, nextText.length - suffix);
  const insertedMarks = inheritMarks(beforeCharacters, prefix, typingMarks);
  const nextCharacters = [
    ...beforeCharacters.slice(0, prefix),
    ...inserted.split("").map((text) => ({ text, marks: insertedMarks })),
    ...beforeCharacters.slice(beforeCharacters.length - suffix),
  ];
  return { ...block, runs: compactRuns(nextCharacters) };
}

function toggleMark(
  block: StructuredTextBlock,
  start: number,
  end: number,
  mark: RichTextMark,
): StructuredTextBlock {
  const characters = markedCharacters(block);
  const selected = characters.slice(start, end);
  const remove = selected.length > 0 && selected.every((character) => character.marks.includes(mark));
  return {
    ...block,
    runs: compactRuns(characters.map((character, index) => {
      if (index < start || index >= end) return character;
      if (remove) {
        return { ...character, marks: character.marks.filter((candidate) => candidate !== mark) };
      }
      return character.marks.includes(mark)
        ? character
        : { ...character, marks: [...character.marks, mark] };
    })),
  };
}

function blockLabel(kind: StructuredTextBlockKind, index: number): string {
  const match = BLOCK_KINDS.find((candidate) => candidate.value === kind);
  return `${match?.label ?? "Text"} ${index + 1}`;
}

function isBlockKind(value: string): value is StructuredTextBlockKind {
  return value === "paragraph" || value === "heading" || value === "quote" ||
    value === "bullet-list-item" || value === "ordered-list-item";
}

function selectedHasMark(
  block: StructuredTextBlock | undefined,
  selection: TextSelection | null,
  mark: RichTextMark,
  typingMarks: readonly RichTextMark[],
): boolean {
  if (block === undefined || selection === null || selection.start === selection.end) {
    return typingMarks.includes(mark);
  }
  const selected = markedCharacters(block).slice(selection.start, selection.end);
  return selected.length > 0 && selected.every((character) => character.marks.includes(mark));
}

export function StructuredTextEditor({
  label,
  blocks,
  saving = false,
  error = null,
  onSave,
  onCancel,
  onReturnFocus,
}: StructuredTextEditorProps): React.JSX.Element {
  const headingId = useId();
  const statusId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState<StructuredTextBlock[]>(() => copyBlocks(blocks));
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [typingMarks, setTypingMarks] = useState<readonly RichTextMark[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const inputRefs = useRef<Array<HTMLTextAreaElement | null>>([]);
  const editorRef = useRef<HTMLDialogElement | null>(null);
  const authorityRef = useRef<readonly StructuredTextBlock[]>(copyBlocks(blocks));
  const observedSavingRef = useRef(false);
  const activeBlock = selection === null
    ? draft[0]
    : draft.find((block) => block.id === selection.blockId);
  const changed = useMemo(() => !sameBlocks(blocks, draft), [blocks, draft]);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor !== null && !editor.open) {
      if (typeof editor.showModal === "function") editor.showModal();
      else editor.setAttribute("open", "");
    }
    inputRefs.current[0]?.focus();
    return () => {
      if (!editor?.open) return;
      if (typeof editor.close === "function") editor.close();
      else editor.removeAttribute("open");
    };
  }, []);

  useEffect(() => {
    if (sameBlocks(authorityRef.current, blocks)) return;
    const nextAuthority = copyBlocks(blocks);
    authorityRef.current = nextAuthority;
    setDraft(nextAuthority);
    setSelection(null);
    setTypingMarks([]);
    setSubmitted(false);
  }, [blocks]);

  useEffect(() => {
    if (saving) {
      observedSavingRef.current = true;
      return;
    }
    if (!submitted || !observedSavingRef.current) return;
    observedSavingRef.current = false;
    setSubmitted(false);
  }, [saving, submitted]);

  function finish(action: () => void): void {
    action();
    onReturnFocus();
  }

  function cancel(): void {
    if (saving) return;
    finish(onCancel);
  }

  function save(): void {
    if (!changed || saving || submitted) return;
    setSubmitted(true);
    onSave(copyBlocks(draft));
  }

  function updateBlock(
    blockId: StructuredTextBlock["id"],
    update: (block: StructuredTextBlock) => StructuredTextBlock,
  ): void {
    setDraft((current) => current.map((block) => block.id === blockId ? update(block) : block));
  }

  function setBlockKind(kind: StructuredTextBlockKind): void {
    if (activeBlock === undefined) return;
    updateBlock(activeBlock.id, (block) => ({ ...block, kind }));
  }

  function applyMark(mark: RichTextMark): void {
    if (activeBlock === undefined || selection === null) return;
    if (selection.start === selection.end) {
      setTypingMarks((current) => current.includes(mark)
        ? current.filter((candidate) => candidate !== mark)
        : [...current, mark]);
      return;
    }
    updateBlock(activeBlock.id, (block) => toggleMark(block, selection.start, selection.end, mark));
  }

  return (
    <dialog
      ref={editorRef}
      className="structured-text-editor"
      aria-modal="true"
      aria-labelledby={headingId}
      aria-describedby={`${statusId}${error === null ? "" : ` ${errorId}`}`}
      aria-label={label}
      data-structured-text-editor
      data-phase11-structured-editor="true"
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancel();
          return;
        }
        if (event.key !== "Tab") return;
        const controls = Array.from(
          editorRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_EDITOR_CONTROL) ?? [],
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (first === undefined || last === undefined) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <header className="structured-text-editor-heading">
        <p>Page text</p>
        <h2 id={headingId}>{label}</h2>
      </header>

      <div className="structured-text-toolbar" role="toolbar" aria-label="Text formatting">
        <label>
          Block style
          <select
            aria-label="Block style"
            value={activeBlock?.kind ?? "paragraph"}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (isBlockKind(value)) setBlockKind(value);
            }}
          >
            {BLOCK_KINDS.map((kind) => (
              <option key={kind.value} value={kind.value}>{kind.label}</option>
            ))}
          </select>
        </label>
        {EDITOR_MARKS.map((mark) => (
          <button
            key={mark.value}
            type="button"
            aria-label={mark.label}
            aria-pressed={selectedHasMark(activeBlock, selection, mark.value, typingMarks)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => applyMark(mark.value)}
          >
            {mark.label}
          </button>
        ))}
      </div>

      <div className="structured-text-blocks">
        {draft.map((block, index) => (
          <label key={block.id} className={`structured-text-block structured-text-block-${block.kind}`}>
            <span>{blockLabel(block.kind, index)}</span>
            <textarea
              ref={(node) => { inputRefs.current[index] = node; }}
              aria-label={blockLabel(block.kind, index)}
              value={plainText(block)}
              rows={block.kind === "heading" ? 2 : 4}
              spellCheck="true"
              data-native-input-path="beforeinput-composition-paste-dictation"
              data-phase11-editor-input="true"
              onFocus={(event) => {
                setSelection({
                  blockId: block.id,
                  start: event.currentTarget.selectionStart,
                  end: event.currentTarget.selectionEnd,
                });
              }}
              onSelect={(event) => {
                setSelection({
                  blockId: block.id,
                  start: event.currentTarget.selectionStart,
                  end: event.currentTarget.selectionEnd,
                });
              }}
              onChange={(event) => {
                const nextText = event.currentTarget.value;
                updateBlock(block.id, (current) => replaceText(current, nextText, typingMarks));
                setSelection({
                  blockId: block.id,
                  start: event.currentTarget.selectionStart,
                  end: event.currentTarget.selectionEnd,
                });
              }}
            />
          </label>
        ))}
      </div>

      <p id={statusId} className="structured-text-editor-status" role="status">
        {changed ? "Unsaved page text." : "Page text is unchanged."}
      </p>
      {error === null ? null : (
        <p id={errorId} className="structured-text-editor-error" role="alert">
          {error}
        </p>
      )}
      <footer className="structured-text-editor-actions">
        <button
          type="button"
          onClick={cancel}
          disabled={saving}
          data-phase11-editor-cancel="true"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!changed || saving || submitted}
          aria-label="Save page text"
          data-phase11-editor-save="true"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </footer>
    </dialog>
  );
}
