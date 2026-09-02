"use client";

import { useState } from "react";

import type { CalculusPracticeProps } from "../../learning/activities";

export type CalculusPracticeViewProps = Readonly<{
  props: CalculusPracticeProps;
  disabled: boolean;
  onSubmit: (answers: Readonly<Record<string, string>>) => Promise<boolean>;
}>;

export function CalculusPractice({
  props,
  disabled,
  onSubmit,
}: CalculusPracticeViewProps): React.JSX.Element {
  const [answers, setAnswers] = useState<Record<string, string>>(props.latestSubmission?.answers ?? {});

  const feedbackByQuestion = new Map(
    props.latestSubmission?.feedback.map((feedback) => [feedback.questionId, feedback]) ?? [],
  );

  return (
    <article className="calculus-practice-card">
      <header className="calculus-practice-header">
        <div>
          <span>CALCULUS I · PRACTICE</span>
          <h3>{props.title}</h3>
          <p>{props.directions}</p>
        </div>
        {props.latestSubmission === undefined ? (
          <output className="calculus-score" aria-live="polite">Ready</output>
        ) : (
          <output className="calculus-score" aria-live="polite">
            <strong>{props.latestSubmission.score}/{props.latestSubmission.total}</strong>
            checked
          </output>
        )}
      </header>

      <form
        className="calculus-question-list"
        onSubmit={(event) => {
          event.preventDefault();
          void onSubmit(answers);
        }}
      >
        {props.questions.map((question, index) => {
          const feedback = feedbackByQuestion.get(question.id);
          return (
            <label className="calculus-question" data-correct={feedback?.correct || undefined} key={question.id}>
              <span className="calculus-question-number">{index + 1}</span>
              <span className="calculus-question-body">
                <strong>{question.prompt}</strong>
                <textarea
                  aria-label={`${question.answerLabel} for question ${index + 1}`}
                  disabled={disabled}
                  placeholder={question.answerLabel}
                  rows={2}
                  value={answers[question.id] ?? ""}
                  onChange={(event) => setAnswers((current) => ({
                    ...current,
                    [question.id]: event.target.value,
                  }))}
                />
                {feedback === undefined ? (
                  <small>Hint available after checking your work.</small>
                ) : (
                  <small className="calculus-feedback" data-correct={feedback.correct}>{feedback.message}</small>
                )}
              </span>
            </label>
          );
        })}
        <footer className="calculus-practice-footer">
          <span>Write a final expression or a short line of reasoning.</span>
          <button type="submit" disabled={disabled}>Check my work</button>
        </footer>
      </form>
    </article>
  );
}
