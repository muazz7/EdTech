'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isAutoGraded } from '@edtech/shared';
import { ApiClientError, api } from '@/lib/client/api-client';
import { Badge, Button, Card, ErrorNote, Skeleton, Textarea } from '@/components/ui';
import { CheckCircleIcon, LockIcon } from '@/components/icons';

/**
 * Student quiz player (Section 10).
 *
 * Three states in one component because they are one flow: the start screen,
 * the attempt itself, and the result. Splitting them across routes would lose
 * the in-progress attempt on every navigation, and an attempt is the one thing
 * here that costs a student something to lose.
 *
 * The countdown shown here is DECORATION. The limit is enforced server-side
 * against `started_at`; this clock exists so the student can pace themselves,
 * and it is computed from the server's `expiresAt` rather than from a duration
 * so a reload does not silently hand back the round-trip.
 */

type AttemptQuestion = {
  id: string;
  type: string;
  prompt: string;
  marks: string;
  options?: Array<{ id: string; label: string }>;
};

type Attempt = {
  attemptId: string;
  attemptNumber: number;
  quizId: string;
  title: string;
  instructions: string | null;
  startedAt: string;
  expiresAt: string | null;
  timeLimitMinutes: number | null;
  passPercentage: number;
  maxAttempts: number;
  questions: AttemptQuestion[];
  answers: Array<{ questionId: string; selectedOptionIds: string[]; textAnswer: string | null }>;
};

type AttemptSummary = {
  id: string;
  attemptNumber: number;
  submittedAt: string | null;
  totalScore: string | null;
  maxScore: string | null;
  passed: boolean | null;
  gradingStatus: string;
};

type Answer = { selectedOptionIds: string[]; textAnswer: string };

export function QuizPanel({ quizId }: { quizId: string }) {
  const [attempts, setAttempts] = useState<AttemptSummary[] | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [resultId, setResultId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      setAttempt(await api.post<Attempt>(`/quizzes/${quizId}/attempts`));
      setResultId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start this quiz.');
    } finally {
      setStarting(false);
    }
  }, [quizId]);

  const loadAttempts = useCallback(async () => {
    setError(null);
    try {
      const rows = await api.get<AttemptSummary[]>(`/quizzes/${quizId}/attempts`);
      setAttempts(rows);

      // An attempt left open is resumed, not restarted — POST returns the same
      // attempt, the same question order and the clock still running. Resuming
      // here rather than waiting for the student to press Start means a
      // dropped connection puts them straight back where they were.
      if (rows.some((row) => row.submittedAt === null)) await start();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this quiz.');
    }
  }, [quizId, start]);

  useEffect(() => {
    void loadAttempts();
  }, [loadAttempts]);

  if (resultId) {
    return (
      <AttemptResult
        attemptId={resultId}
        onRetake={() => {
          setResultId(null);
          void loadAttempts();
        }}
      />
    );
  }

  if (attempt) {
    return (
      <AttemptPlayer
        attempt={attempt}
        onSubmitted={(id) => {
          setAttempt(null);
          setResultId(id);
          void loadAttempts();
        }}
      />
    );
  }

  if (attempts === null && !error) {
    return <Skeleton className="h-40 w-full" />;
  }

  const submitted = attempts?.filter((a) => a.submittedAt !== null) ?? [];
  const best = submitted.reduce<AttemptSummary | null>((top, row) => {
    if (!top) return row;
    return Number(row.totalScore ?? 0) > Number(top.totalScore ?? 0) ? row : top;
  }, null);

  return (
    <div className="flex flex-col gap-4">
      {error && <ErrorNote onRetry={() => void loadAttempts()}>{error}</ErrorNote>}

      {submitted.length > 0 && (
        <Card className="p-4">
          <h3 className="text-sm font-semibold text-[var(--color-foreground)]">Your attempts</h3>
          <ul className="mt-2 flex flex-col gap-2">
            {submitted.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-3 text-sm">
                <span className="tabular text-[var(--color-muted-foreground)]">
                  Attempt {row.attemptNumber}
                </span>
                <span className="tabular font-medium text-[var(--color-foreground)]">
                  {row.totalScore ?? '—'} / {row.maxScore ?? '—'}
                </span>
                <AttemptStatus attempt={row} />
                <button
                  type="button"
                  onClick={() => setResultId(row.id)}
                  className="ml-auto min-h-9 rounded-[var(--radius-md)] px-3 text-sm font-medium text-[var(--color-primary)] hover:bg-[var(--color-cyan-tint)]"
                >
                  See answers
                </button>
              </li>
            ))}
          </ul>
          {best?.passed === true && (
            <p className="mt-3 text-sm text-[var(--color-muted-foreground)]">
              Your best attempt counts towards finishing this course.
            </p>
          )}
        </Card>
      )}

      <Button variant="primary" loading={starting} onClick={() => void start()}>
        {submitted.length === 0 ? 'Start quiz' : 'Try again'}
      </Button>
    </div>
  );
}

function AttemptStatus({ attempt }: { attempt: AttemptSummary }) {
  if (attempt.gradingStatus !== 'complete') {
    // Not "failed". A pass/fail computed from half a score would be shown and
    // then change.
    return <Badge tone="warning">Being marked</Badge>;
  }
  return attempt.passed ? <Badge tone="success">Passed</Badge> : <Badge tone="neutral">Not passed</Badge>;
}

/** Live countdown from the server's absolute deadline. */
function useCountdown(expiresAt: string | null): number | null {
  const [remaining, setRemaining] = useState<number | null>(() =>
    expiresAt ? Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)) : null,
  );

  useEffect(() => {
    if (!expiresAt) return;
    const tick = () =>
      setRemaining(Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  return remaining;
}

function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function AttemptPlayer({
  attempt,
  onSubmitted,
}: {
  attempt: Attempt;
  onSubmitted: (attemptId: string) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, Answer>>(() => {
    const initial: Record<string, Answer> = {};
    for (const saved of attempt.answers) {
      initial[saved.questionId] = {
        selectedOptionIds: saved.selectedOptionIds,
        textAnswer: saved.textAnswer ?? '',
      };
    }
    return initial;
  });
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const remaining = useCountdown(attempt.expiresAt);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Every pending debounce is cancelled on unmount, or a student who navigates
  // away mid-typing fires a save against an attempt they have left.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const save = useCallback(
    async (questionId: string, answer: Answer, isChoice: boolean) => {
      setSaving((current) => new Set(current).add(questionId));
      try {
        await api.post(`/attempts/${attempt.attemptId}/answers`, {
          questionId,
          ...(isChoice
            ? { selectedOptionIds: answer.selectedOptionIds }
            : { textAnswer: answer.textAnswer }),
        });
        setError(null);
      } catch (err) {
        // Surfaced rather than swallowed: an autosave that silently fails is
        // how a student loses an answer they believe is safe.
        setError(
          err instanceof ApiClientError && err.code === 'ATTEMPT_TIME_EXPIRED'
            ? 'Time is up. Submit to see your result.'
            : 'Your last answer could not be saved. Check your connection.',
        );
      } finally {
        setSaving((current) => {
          const next = new Set(current);
          next.delete(questionId);
          return next;
        });
      }
    },
    [attempt.attemptId],
  );

  function update(question: AttemptQuestion, next: Answer) {
    setAnswers((current) => ({ ...current, [question.id]: next }));

    const isChoice = isAutoGraded(question.type);
    const existing = timers.current.get(question.id);
    if (existing) clearTimeout(existing);

    // Choices save immediately — one tap, one write. Typing is debounced so a
    // long answer is not a request per keystroke.
    const delay = isChoice ? 0 : 800;
    timers.current.set(
      question.id,
      setTimeout(() => void save(question.id, next, isChoice), delay),
    );
  }

  async function submit() {
    setSubmitting(true);
    setError(null);

    // Flush anything still debounced, so the last thing typed is not lost to a
    // race with the submit.
    for (const [questionId, timer] of timers.current) {
      clearTimeout(timer);
      const question = attempt.questions.find((q) => q.id === questionId);
      const answer = answers[questionId];
      if (question && answer) await save(questionId, answer, isAutoGraded(question.type));
    }
    timers.current.clear();

    try {
      await api.post(`/attempts/${attempt.attemptId}/submit`, {});
      onSubmitted(attempt.attemptId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit this attempt.');
      setSubmitting(false);
    }
  }

  const answered = attempt.questions.filter((q) => {
    const answer = answers[q.id];
    if (!answer) return false;
    return isAutoGraded(q.type) ? answer.selectedOptionIds.length > 0 : answer.textAnswer.trim() !== '';
  }).length;

  const outOfTime = remaining !== null && remaining <= 0;

  return (
    <div className="flex flex-col gap-4">
      <Card className="sticky top-16 z-[var(--z-sticky)] flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="text-sm font-semibold text-[var(--color-foreground)]">{attempt.title}</p>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            <span className="tabular">{answered}</span> of{' '}
            <span className="tabular">{attempt.questions.length}</span> answered · attempt{' '}
            <span className="tabular">{attempt.attemptNumber}</span> of{' '}
            <span className="tabular">{attempt.maxAttempts}</span>
          </p>
        </div>

        {remaining !== null && (
          <p
            role="timer"
            aria-live="off"
            className={`tabular text-lg font-semibold ${
              remaining <= 60 ? 'text-[var(--color-destructive)]' : 'text-[var(--color-foreground)]'
            }`}
          >
            {formatClock(remaining)}
            <span className="sr-only"> remaining</span>
          </p>
        )}
      </Card>

      {attempt.instructions && (
        <p className="prose-measure text-sm text-[var(--color-muted-foreground)]">
          {attempt.instructions}
        </p>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}

      {outOfTime && (
        <p
          role="alert"
          className="rounded-[var(--radius-md)] bg-[var(--color-coral-tint)] p-3 text-sm text-[var(--color-foreground)]"
        >
          Time is up. Submit now — answers changed after this point are not counted.
        </p>
      )}

      <ol className="flex flex-col gap-4">
        {attempt.questions.map((question, index) => (
          <Card as="li" key={question.id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm font-medium text-[var(--color-foreground)]">
                <span className="tabular text-[var(--color-muted-foreground)]">{index + 1}.</span>{' '}
                {question.prompt}
              </p>
              <span className="tabular shrink-0 text-xs text-[var(--color-muted-foreground)]">
                {question.marks} mark{Number(question.marks) === 1 ? '' : 's'}
              </span>
            </div>

            <div className="mt-3">
              {question.options ? (
                <fieldset className="flex flex-col gap-1">
                  <legend className="sr-only">
                    {question.type === 'mcq_multi'
                      ? 'Select every correct answer'
                      : 'Select one answer'}
                  </legend>
                  {question.options.map((option) => {
                    const selected =
                      answers[question.id]?.selectedOptionIds.includes(option.id) ?? false;
                    return (
                      <label
                        key={option.id}
                        className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--radius-md)] px-3 text-sm transition-colors duration-150 ${
                          selected
                            ? 'bg-[var(--color-cyan-tint)] font-medium text-[var(--color-foreground)]'
                            : 'text-[var(--color-foreground)] hover:bg-[var(--color-muted)]'
                        }`}
                      >
                        <input
                          type={question.type === 'mcq_multi' ? 'checkbox' : 'radio'}
                          name={question.id}
                          checked={selected}
                          disabled={outOfTime}
                          onChange={(e) => {
                            const current = answers[question.id]?.selectedOptionIds ?? [];
                            const next =
                              question.type === 'mcq_multi'
                                ? e.target.checked
                                  ? [...current, option.id]
                                  : current.filter((id) => id !== option.id)
                                : [option.id];
                            update(question, {
                              selectedOptionIds: next,
                              textAnswer: answers[question.id]?.textAnswer ?? '',
                            });
                          }}
                          className="size-4 shrink-0"
                        />
                        {option.label}
                      </label>
                    );
                  })}
                </fieldset>
              ) : (
                <Textarea
                  aria-label={`Answer to question ${index + 1}`}
                  rows={question.type === 'long_answer' ? 6 : 3}
                  disabled={outOfTime}
                  value={answers[question.id]?.textAnswer ?? ''}
                  onChange={(e) =>
                    update(question, {
                      selectedOptionIds: answers[question.id]?.selectedOptionIds ?? [],
                      textAnswer: e.target.value,
                    })
                  }
                  placeholder="Write your answer here."
                />
              )}
            </div>

            {/* Saved-state per question, so a student can see their work is
                safe before leaving the page. */}
            <p className="mt-2 h-4 text-xs text-[var(--color-muted-foreground)]" aria-live="polite">
              {saving.has(question.id) ? 'Saving…' : answers[question.id] ? 'Saved' : ''}
            </p>
          </Card>
        ))}
      </ol>

      {/* Submitting ends the attempt, and attempts are limited. Confirm first. */}
      {confirming ? (
        <Card className="p-4">
          <p className="text-sm text-[var(--color-foreground)]">
            Submit this attempt?{' '}
            {answered < attempt.questions.length && (
              <>
                <span className="tabular">{attempt.questions.length - answered}</span> question
                {attempt.questions.length - answered === 1 ? ' is' : 's are'} unanswered and will
                score zero.{' '}
              </>
            )}
            {attempt.attemptNumber >= attempt.maxAttempts
              ? 'This is your last attempt.'
              : `You have ${attempt.maxAttempts - attempt.attemptNumber} attempt(s) left after this.`}
          </p>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" loading={submitting} onClick={() => void submit()}>
              Submit
            </Button>
            <Button onClick={() => setConfirming(false)}>Keep working</Button>
          </div>
        </Card>
      ) : (
        <Button variant="primary" onClick={() => setConfirming(true)}>
          Submit attempt
        </Button>
      )}
    </div>
  );
}

type Result = {
  attemptId: string;
  attemptNumber: number;
  title: string;
  totalScore: string | null;
  maxScore: string | null;
  percent: number;
  passPercentage: number;
  passed: boolean | null;
  gradingStatus: string;
  showAnswers: boolean;
  questions: Array<{
    id: string;
    type: string;
    prompt: string;
    marks: string;
    awardedMarks: string | null;
    teacherFeedback: string | null;
    textAnswer: string | null;
    selectedOptionIds: string[];
    explanation?: string | null;
  }>;
};

export function AttemptResult({
  attemptId,
  onRetake,
}: {
  attemptId: string;
  onRetake?: () => void;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const [key, setKey] = useState<Array<{ questionId: string; correctOptionIds: string[] }> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get<Result>(`/attempts/${attemptId}/result`);
      setResult(data);

      // A separate call, and only when the teacher allowed answers. The result
      // screen renders fine without ever touching the key.
      if (data.showAnswers) {
        setKey(
          await api
            .get<Array<{ questionId: string; correctOptionIds: string[] }>>(
              `/attempts/${attemptId}/answer-key`,
            )
            .catch(() => null),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your result.');
    }
  }, [attemptId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>;
  if (!result) return <Skeleton className="h-48 w-full" />;

  const pending = result.gradingStatus !== 'complete';

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-6 text-center">
        {pending ? (
          <>
            <p className="text-lg font-semibold text-[var(--color-foreground)]">
              Your written answers are being marked
            </p>
            <p className="prose-measure mx-auto mt-2 text-sm text-[var(--color-muted-foreground)]">
              Multiple-choice questions are already scored. Your final result appears here once your
              teacher has marked the rest — you will get a notification.
            </p>
          </>
        ) : (
          <>
            {result.passed ? (
              <CheckCircleIcon className="mx-auto size-8 text-[var(--color-success)]" />
            ) : (
              <LockIcon className="mx-auto size-8 text-[var(--color-muted-foreground)]" />
            )}
            <p
              className={`mt-2 text-lg font-semibold ${
                result.passed ? 'text-[var(--color-success)]' : 'text-[var(--color-foreground)]'
              }`}
            >
              {result.passed ? 'Passed' : 'Not passed this time'}
            </p>
          </>
        )}

        <p className="tabular mt-3 text-3xl font-semibold text-[var(--color-foreground)]">
          {result.totalScore ?? '—'} / {result.maxScore ?? '—'}
        </p>
        <p className="tabular mt-1 text-sm text-[var(--color-muted-foreground)]">
          {result.percent}% · pass mark {result.passPercentage}%
        </p>
      </Card>

      {!result.showAnswers && (
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Your teacher has not made the answers available for this quiz.
        </p>
      )}

      <ol className="flex flex-col gap-3">
        {result.questions.map((question, index) => {
          const correct = key?.find((row) => row.questionId === question.id)?.correctOptionIds;
          const scored = Number(question.awardedMarks ?? 0);
          const full = scored >= Number(question.marks);

          return (
            <Card as="li" key={question.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-medium text-[var(--color-foreground)]">
                  <span className="tabular text-[var(--color-muted-foreground)]">{index + 1}.</span>{' '}
                  {question.prompt}
                </p>
                {/* Score in words and numbers, never colour alone. */}
                <span
                  className={`tabular shrink-0 text-xs font-medium ${
                    full ? 'text-[var(--color-success)]' : 'text-[var(--color-muted-foreground)]'
                  }`}
                >
                  {question.awardedMarks ?? '—'} / {question.marks}
                </span>
              </div>

              {question.textAnswer && (
                <p className="mt-2 whitespace-pre-line rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-3 text-sm text-[var(--color-foreground)]">
                  {question.textAnswer}
                </p>
              )}

              {correct && (
                <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
                  {question.selectedOptionIds.length > 0 &&
                  correct.length === question.selectedOptionIds.length &&
                  question.selectedOptionIds.every((id) => correct.includes(id))
                    ? 'You picked the right answer.'
                    : 'Your answer did not match the correct option.'}
                </p>
              )}

              {question.explanation && (
                <p className="prose-measure mt-2 text-sm text-[var(--color-foreground)]">
                  {question.explanation}
                </p>
              )}

              {question.teacherFeedback && (
                <p className="mt-2 rounded-[var(--radius-md)] bg-[var(--color-cyan-tint)] p-3 text-sm text-[var(--color-foreground)]">
                  <span className="font-medium">Your teacher: </span>
                  {question.teacherFeedback}
                </p>
              )}
            </Card>
          );
        })}
      </ol>

      {onRetake && (
        <Button onClick={onRetake}>Back to attempts</Button>
      )}
    </div>
  );
}
