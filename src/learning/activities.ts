import { z } from "zod";

import type { JsonValue } from "../domain";
import {
  createPageRevision,
  validatePage,
  type ElementId,
  type EmbeddedFrameElement,
  type PageRecord,
} from "../page/domain";
import { PagePlacementError } from "../page/placement";

export const CALCULUS_PRACTICE_COMPONENT = "calculus-practice";
export const COLORING_BOOK_COMPONENT = "coloring-book-page";
export const LEARNING_ACTIVITY_VERSION = 1;

const CalculusQuestionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(500),
  acceptedAnswers: z.array(z.string().trim().min(1).max(180)).min(1).max(12),
  answerLabel: z.string().trim().min(1).max(80),
  hint: z.string().trim().min(1).max(300),
  explanation: z.string().trim().min(1).max(500),
}).strict();

const CalculusFeedbackSchema = z.object({
  questionId: z.string().trim().min(1).max(80),
  correct: z.boolean(),
  message: z.string().trim().min(1).max(500),
}).strict();

const CalculusSubmissionSchema = z.object({
  attemptId: z.string().trim().min(1).max(180),
  answers: z.record(z.string().trim().min(1).max(80), z.string().max(1_000)),
  score: z.number().int().min(0),
  total: z.number().int().positive(),
  feedback: z.array(CalculusFeedbackSchema).max(8),
  submittedAt: z.string().datetime(),
}).strict();

export const CalculusPracticePropsSchema = z.object({
  kind: z.literal(CALCULUS_PRACTICE_COMPONENT),
  title: z.string().trim().min(1).max(140),
  directions: z.string().trim().min(1).max(500),
  questions: z.array(CalculusQuestionSchema).min(1).max(5),
  latestSubmission: CalculusSubmissionSchema.optional(),
}).strict();

const ColoringPointSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
}).strict();

export const ColoringStrokeSchema = z.object({
  id: z.string().trim().min(1).max(180),
  tool: z.enum(["pen", "eraser"]),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  width: z.number().finite().min(2).max(28),
  points: z.array(ColoringPointSchema).min(1).max(900),
}).strict();

export const ColoringBookPropsSchema = z.object({
  kind: z.literal(COLORING_BOOK_COMPONENT),
  scene: z.enum(["garden", "tide-pool", "night-moths"]),
  title: z.string().trim().min(1).max(140),
  prompt: z.string().trim().min(1).max(300),
  strokes: z.array(ColoringStrokeSchema).max(250),
}).strict();

export const ColoringEditSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("append"), stroke: ColoringStrokeSchema }).strict(),
  z.object({ kind: z.literal("undo") }).strict(),
  z.object({ kind: z.literal("clear") }).strict(),
]);

export type CalculusPracticeProps = z.infer<typeof CalculusPracticePropsSchema>;
export type CalculusSubmission = z.infer<typeof CalculusSubmissionSchema>;
export type ColoringBookProps = z.infer<typeof ColoringBookPropsSchema>;
export type ColoringStroke = z.infer<typeof ColoringStrokeSchema>;
export type ColoringEdit = z.infer<typeof ColoringEditSchema>;

export type LearningActivity =
  | Readonly<{ kind: "calculus"; props: CalculusPracticeProps }>
  | Readonly<{ kind: "coloring"; props: ColoringBookProps }>;

function normalizeAnswer(value: string): string {
  return value
    .toLowerCase()
    .replaceAll("−", "-")
    .replaceAll("×", "*")
    .replaceAll("÷", "/")
    .replace(/\s+/g, "")
    .replace(/[{}]/g, "")
    .replace(/\bplus\b/g, "+")
    .replace(/\bminus\b/g, "-");
}

export function scoreCalculusPractice(
  props: CalculusPracticeProps,
  answers: Readonly<Record<string, string>>,
  attemptId: string,
  submittedAt: string,
): CalculusSubmission {
  const allowedIds = new Set(props.questions.map((question) => question.id));
  if (Object.keys(answers).some((questionId) => !allowedIds.has(questionId))) {
    throw new Error("The submission contains an answer outside this practice set.");
  }
  const feedback = props.questions.map((question) => {
    const answer = answers[question.id] ?? "";
    const normalized = normalizeAnswer(answer);
    const correct = normalized.length > 0 && question.acceptedAnswers.some(
      (accepted) => normalizeAnswer(accepted) === normalized,
    );
    return {
      questionId: question.id,
      correct,
      message: correct
        ? `Correct. ${question.explanation}`
        : answer.trim().length === 0
          ? `Add an answer first. Hint: ${question.hint}`
          : `Try again. ${question.hint}`,
    };
  });
  return CalculusSubmissionSchema.parse({
    attemptId,
    answers,
    score: feedback.filter((item) => item.correct).length,
    total: props.questions.length,
    feedback,
    submittedAt,
  });
}

export function parseLearningActivity(element: EmbeddedFrameElement): LearningActivity | null {
  if (element.componentVersion !== LEARNING_ACTIVITY_VERSION) return null;
  if (element.componentType === CALCULUS_PRACTICE_COMPONENT) {
    const parsed = CalculusPracticePropsSchema.safeParse(element.props);
    return parsed.success ? { kind: "calculus", props: parsed.data } : null;
  }
  if (element.componentType === COLORING_BOOK_COMPONENT) {
    const parsed = ColoringBookPropsSchema.safeParse(element.props);
    return parsed.success ? { kind: "coloring", props: parsed.data } : null;
  }
  return null;
}

function activityPropsJson(props: CalculusPracticeProps | ColoringBookProps): JsonValue {
  return JSON.parse(JSON.stringify(props)) as JsonValue;
}

export function updateLearningActivity(
  page: PageRecord,
  elementId: ElementId,
  props: CalculusPracticeProps | ColoringBookProps,
  updatedAt: PageRecord["updatedAt"],
): PageRecord {
  const target = page.elements.find((element) => element.id === elementId);
  if (target?.kind !== "embedded-frame" || parseLearningActivity(target) === null) {
    throw new PagePlacementError("The learning activity was not found on this page.");
  }
  const nextElement: EmbeddedFrameElement = {
    ...target,
    componentType: props.kind,
    componentVersion: LEARNING_ACTIVITY_VERSION,
    props: activityPropsJson(props),
  };
  return validatePage({
    ...page,
    revision: createPageRevision(page.revision + 1),
    elements: page.elements.map((element) => element.id === elementId ? nextElement : element),
    updatedAt,
  });
}

export function applyColoringEdit(props: ColoringBookProps, edit: ColoringEdit): ColoringBookProps {
  if (edit.kind === "clear") return ColoringBookPropsSchema.parse({ ...props, strokes: [] });
  if (edit.kind === "undo") return ColoringBookPropsSchema.parse({ ...props, strokes: props.strokes.slice(0, -1) });
  if (props.strokes.some((stroke) => stroke.id === edit.stroke.id)) return props;
  return ColoringBookPropsSchema.parse({ ...props, strokes: [...props.strokes, edit.stroke] });
}
