'use client';

import { useState } from 'react';
import { QUESTION_TYPES, isAutoGraded, type QuestionType } from '@edtech/shared';
import { api } from '@/lib/client/api-client';
import { Button, Card, ErrorNote, Field, Input, Select, Textarea } from '@/components/ui';
import { CheckIcon, PlusIcon, TrashIcon } from '@/components/icons';

export type QuestionOption = { id: string; label: string; isCorrect: boolean };

export type Question = {
  id: string;
  type: QuestionType;
  prompt: string;
  marks: string;
  explanation: string | null;
  displayOrder: number;
  options: QuestionOption[];
};

const TYPE_LABEL: Record<QuestionType, string> = {
  mcq_single: 'Multiple choice (one answer)',
  mcq_multi: 'Multiple choice (several answers)',
  true_false: 'True or false',
  short_answer: 'Short written answer',
  long_answer: 'Long written answer',
};

/** Draft state for the option rows. Ids are absent until the server assigns
 *  them, so the editor keys on index. */
type DraftOption = { label: string; isCorrect: boolean };

function defaultOptions(type: QuestionType, existing: DraftOption[]): DraftOption[] {
  if (!isAutoGraded(type)) return [];
  if (type === 'true_false') {
    return [
      { label: 'True', isCorrect: existing[0]?.isCorrect ?? true },
      { label: 'False', isCorrect: existing[1]?.isCorrect ?? false },
    ];
  }
  if (existing.length >= 2) return existing;
  return [
    { label: '', isCorrect: true },
    { label: '', isCorrect: false },
  ];
}

/**
 * Adds or edits one question.
 *
 * The correct-answer control is a radio for single-answer types and a checkbox
 * for multi, because the input itself should make the rule obvious before the
 * server has to state it. The server still enforces both — see
 * assertOptionsMatchType — since a form control is a hint, not a constraint.
 */
export function QuestionEditor({
  quizId,
  question,
  onSaved,
  onCancel,
}: {
  quizId: string;
  question?: Question;
  onSaved: (saved: Question) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<QuestionType>(question?.type ?? 'mcq_single');
  const [prompt, setPrompt] = useState(question?.prompt ?? '');
  const [marks, setMarks] = useState(question?.marks ?? '1');
  const [explanation, setExplanation] = useState(question?.explanation ?? '');
  const [options, setOptions] = useState<DraftOption[]>(() =>
    defaultOptions(
      question?.type ?? 'mcq_single',
      question?.options.map((o) => ({ label: o.label, isCorrect: o.isCorrect })) ?? [],
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isChoice = isAutoGraded(type);

  function changeType(next: QuestionType) {
    setType(next);
    setOptions(defaultOptions(next, options));
  }

  function setCorrect(index: number, value: boolean) {
    setOptions((current) =>
      current.map((option, i) => {
        if (i === index) return { ...option, isCorrect: value };
        // Single-answer: selecting one clears the rest, so the form cannot
        // produce a state the server will reject.
        if (type !== 'mcq_multi' && value) return { ...option, isCorrect: false };
        return option;
      }),
    );
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const body = {
      type,
      prompt: prompt.trim(),
      marks: marks.trim(),
      ...(explanation.trim() ? { explanation: explanation.trim() } : {}),
      ...(isChoice
        ? { options: options.map((o) => ({ label: o.label.trim(), isCorrect: o.isCorrect })) }
        : { options: [] }),
    };

    try {
      const saved = question
        ? await api.patch<Question>(`/teacher/questions/${question.id}`, body)
        : await api.post<Question>(`/teacher/quizzes/${quizId}/questions`, body);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the question.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-3 p-4">
      <form onSubmit={save} className="flex flex-col gap-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <Field label="Question type">
            {(props) => (
              <Select
                {...props}
                value={type}
                onChange={(e) => changeType(e.target.value as QuestionType)}
              >
                {QUESTION_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {TYPE_LABEL[value]}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label="Marks" hint="Up to two decimal places.">
            {(props) => (
              <Input
                {...props}
                inputMode="decimal"
                value={marks}
                onChange={(e) => setMarks(e.target.value)}
                className="tabular"
              />
            )}
          </Field>
        </div>

        <Field label="Question" required>
          {(props) => (
            <Textarea
              {...props}
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What is the SI unit of force?"
            />
          )}
        </Field>

        {isChoice && (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-[var(--color-foreground)]">
              Options
              <span className="ml-2 font-normal text-[var(--color-muted-foreground)]">
                {type === 'mcq_multi'
                  ? 'Tick every correct option.'
                  : 'Select the one correct option.'}
              </span>
            </legend>

            {options.map((option, index) => (
              <div key={index} className="flex items-center gap-2">
                <label className="flex min-h-11 shrink-0 items-center gap-2 px-1 text-sm">
                  <input
                    type={type === 'mcq_multi' ? 'checkbox' : 'radio'}
                    name={`correct-${question?.id ?? 'new'}`}
                    checked={option.isCorrect}
                    onChange={(e) => setCorrect(index, e.target.checked)}
                    className="size-4"
                  />
                  <span className="sr-only">Option {index + 1} is correct</span>
                  {option.isCorrect && (
                    <CheckIcon className="size-4 text-[var(--color-success)]" aria-hidden="true" />
                  )}
                </label>

                <Input
                  aria-label={`Option ${index + 1}`}
                  value={option.label}
                  disabled={type === 'true_false'}
                  onChange={(e) =>
                    setOptions((current) =>
                      current.map((o, i) => (i === index ? { ...o, label: e.target.value } : o)),
                    )
                  }
                  placeholder={`Option ${index + 1}`}
                />

                {type !== 'true_false' && options.length > 2 && (
                  <button
                    type="button"
                    aria-label={`Remove option ${index + 1}`}
                    onClick={() =>
                      setOptions((current) => current.filter((_, i) => i !== index))
                    }
                    className="inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-muted-foreground)] transition-colors duration-150 hover:bg-[var(--color-muted)] hover:text-[var(--color-destructive)]"
                  >
                    <TrashIcon className="size-4" />
                  </button>
                )}
              </div>
            ))}

            {type !== 'true_false' && options.length < 10 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="self-start"
                onClick={() =>
                  setOptions((current) => [...current, { label: '', isCorrect: false }])
                }
              >
                <PlusIcon className="size-4" />
                Add option
              </Button>
            )}
          </fieldset>
        )}

        <Field
          label="Explanation"
          hint={
            isChoice
              ? 'Shown after submission, only if this quiz reveals answers. It usually gives the answer away, so it is gated on the same setting as the key.'
              : 'A note to yourself while marking. Not shown to the student unless the quiz reveals answers.'
          }
        >
          {(props) => (
            <Textarea
              {...props}
              rows={2}
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
            />
          )}
        </Field>

        {error && <ErrorNote>{error}</ErrorNote>}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={busy} disabled={!prompt.trim()}>
            {question ? 'Save question' : 'Add question'}
          </Button>
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
