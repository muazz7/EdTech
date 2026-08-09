'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { isAutoGraded } from '@edtech/shared';
import { api } from '@/lib/client/api-client';
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Skeleton,
  Textarea,
} from '@/components/ui';

type GradingQuestion = {
  questionId: string;
  type: string;
  prompt: string;
  marks: string;
  displayOrder: number;
  textAnswer: string | null;
  awardedMarks: string | null;
  teacherFeedback: string | null;
  gradedAt: string | null;
};

type AttemptForGrading = {
  attemptId: string;
  quizId: string;
  quizTitle: string;
  student: { id: string; fullName: string } | null;
  submittedAt: string | null;
  totalScore: string | null;
  maxScore: string | null;
  gradingStatus: string;
  questions: GradingQuestion[];
};

type GradeResult = {
  totalScore: string;
  maxScore: string;
  passed: boolean | null;
  gradingStatus: string;
  outstanding: number;
};

/**
 * Marking one attempt's written answers (Section 10).
 *
 * The total is recomputed by the server after every single answer, so a teacher
 * who marks three of five and goes home leaves a consistent partial state
 * rather than a total that is silently wrong until they come back.
 *
 * Multiple-choice answers are shown but not editable. Letting a teacher
 * hand-overwrite an auto-graded question makes "why is my MCQ wrong"
 * unanswerable — the key is the answer, and it is the same key for everyone.
 */
function AttemptGradingScreen() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const attemptId = params.id;

  const [attempt, setAttempt] = useState<AttemptForGrading | null>(null);
  const [summary, setSummary] = useState<GradeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setAttempt(await api.get<AttemptForGrading>(`/teacher/attempts/${attemptId}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this attempt.');
    }
  }, [attemptId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!attempt && !error) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-8 sm:px-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 w-full" />
        <span className="sr-only" role="status">
          Loading the attempt
        </span>
      </div>
    );
  }

  const written = attempt?.questions.filter((q) => !isAutoGraded(q.type)) ?? [];
  const outstanding = written.filter((q) => q.textAnswer?.trim() && !q.gradedAt).length;
  const complete = (summary?.gradingStatus ?? attempt?.gradingStatus) === 'complete';

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link
          href="/teacher/grading"
          className="rounded-[var(--radius-sm)] text-[var(--color-primary)] hover:underline"
        >
          Back to marking
        </Link>
      </nav>

      {error && (
        <div className="mt-4">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      {attempt && (
        <>
          <h1 className="mt-3 text-2xl font-semibold text-[var(--color-foreground)]">
            {attempt.student?.fullName ?? 'Student'}
          </h1>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">{attempt.quizTitle}</p>

          <Card className="mt-4 flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <p className="tabular text-2xl font-semibold text-[var(--color-foreground)]">
                {summary?.totalScore ?? attempt.totalScore ?? '—'} /{' '}
                {summary?.maxScore ?? attempt.maxScore ?? '—'}
              </p>
              <p className="text-sm text-[var(--color-muted-foreground)]">
                {complete ? 'Marking finished' : `${outstanding} answer(s) still to mark`}
              </p>
            </div>

            {complete && (
              <Badge tone={(summary?.passed ?? null) === false ? 'neutral' : 'success'}>
                {(summary?.passed ?? null) === false ? 'Not passed' : 'Passed'}
              </Badge>
            )}
          </Card>

          {complete && (
            <div className="mt-4">
              <Button variant="primary" onClick={() => router.push('/teacher/grading')}>
                Back to the queue
              </Button>
            </div>
          )}

          <ol className="mt-6 flex flex-col gap-4">
            {attempt.questions.map((question, index) => (
              <Card as="li" key={question.questionId} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium text-[var(--color-foreground)]">
                    <span className="tabular text-[var(--color-muted-foreground)]">
                      {index + 1}.
                    </span>{' '}
                    {question.prompt}
                  </p>
                  <span className="tabular shrink-0 text-xs text-[var(--color-muted-foreground)]">
                    {question.awardedMarks ?? '—'} / {question.marks}
                  </span>
                </div>

                {isAutoGraded(question.type) ? (
                  <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
                    Marked automatically from the answer key.
                  </p>
                ) : question.textAnswer?.trim() ? (
                  <AnswerGrader
                    attemptId={attemptId}
                    question={question}
                    onGraded={(result, marks, feedback) => {
                      setSummary(result);
                      setAttempt({
                        ...attempt,
                        gradingStatus: result.gradingStatus,
                        totalScore: result.totalScore,
                        maxScore: result.maxScore,
                        questions: attempt.questions.map((q) =>
                          q.questionId === question.questionId
                            ? {
                                ...q,
                                awardedMarks: marks,
                                teacherFeedback: feedback,
                                gradedAt: new Date().toISOString(),
                              }
                            : q,
                        ),
                      });
                    }}
                  />
                ) : (
                  <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
                    Left blank — scored zero without waiting for you.
                  </p>
                )}
              </Card>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function AnswerGrader({
  attemptId,
  question,
  onGraded,
}: {
  attemptId: string;
  question: GradingQuestion;
  onGraded: (result: GradeResult, marks: string, feedback: string | null) => void;
}) {
  const [marks, setMarks] = useState(question.awardedMarks ?? '');
  const [feedback, setFeedback] = useState(question.teacherFeedback ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const outOfRange =
    marks.trim() !== '' &&
    (Number.isNaN(Number(marks)) || Number(marks) < 0 || Number(marks) > Number(question.marks));

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const result = await api.post<GradeResult>(`/teacher/attempts/${attemptId}/grade`, {
        questionId: question.questionId,
        awardedMarks: marks.trim(),
        ...(feedback.trim() ? { teacherFeedback: feedback.trim() } : {}),
      });
      onGraded(result, marks.trim(), feedback.trim() || null);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the mark.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <p className="whitespace-pre-line rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-3 text-sm text-[var(--color-foreground)]">
        {question.textAnswer}
      </p>

      {question.gradedAt && !saved && (
        <p className="mt-2 text-sm text-[var(--color-success)]">
          Already marked. Saving again replaces the mark and the total.
        </p>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-[10rem_1fr]">
        <Field
          label={`Marks (of ${question.marks})`}
          error={outOfRange ? `Must be between 0 and ${question.marks}.` : undefined}
        >
          {(props) => (
            <Input
              {...props}
              inputMode="decimal"
              value={marks}
              onChange={(e) => {
                setMarks(e.target.value);
                setSaved(false);
              }}
              className="tabular"
            />
          )}
        </Field>

        <Field label="Feedback (optional)">
          {(props) => (
            <Textarea
              {...props}
              rows={2}
              value={feedback}
              onChange={(e) => {
                setFeedback(e.target.value);
                setSaved(false);
              }}
            />
          )}
        </Field>
      </div>

      {error && (
        <div className="mt-2">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-3 flex items-center gap-3">
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          disabled={marks.trim() === '' || outOfRange}
          onClick={() => void save()}
        >
          Save mark
        </Button>
        {saved && (
          <span role="status" className="text-sm text-[var(--color-success)]">
            Saved — total updated
          </span>
        )}
      </div>
    </div>
  );
}

export default function AttemptGradingPage() {
  return <AttemptGradingScreen />;
}
