'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { isAutoGraded } from '@edtech/shared';
import { ApiClientError, api } from '@/lib/client/api-client';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Skeleton,
} from '@/components/ui';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  PlusIcon,
  QuizIcon,
  TrashIcon,
} from '@/components/icons';
import { QuestionEditor, type Question } from './question-editor';

type Quiz = {
  id: string;
  lessonId: string | null;
  courseId: string;
  title: string;
  instructions: string | null;
  timeLimitMinutes: number | null;
  passPercentage: number;
  maxAttempts: number;
  shuffleQuestions: boolean;
  showAnswersAfter: boolean;
  isPublished: boolean;
  questions: Question[];
};

/**
 * Teacher quiz builder (Section 10).
 *
 * This screen shows the answer key, and that is correct: a teacher cannot
 * author a quiz without seeing which option is right. The key comes from
 * /teacher/quizzes/:id, which is a different endpoint and a different core
 * module from the one students hit — see packages/core/src/assessment for why
 * those are kept apart.
 */
function QuizBuilderScreen() {
  const params = useParams<{ id: string }>();
  const lessonId = params.id;

  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      setQuiz(await api.get<Quiz | null>(`/teacher/lessons/${lessonId}/quiz`));
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) {
        setError('That lesson does not exist, or it belongs to another teacher.');
      } else {
        setError(err instanceof Error ? err.message : 'Could not load the quiz.');
      }
    } finally {
      setLoaded(true);
    }
  }, [lessonId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createQuiz() {
    setError(null);
    try {
      await api.post<Quiz>(`/teacher/lessons/${lessonId}/quiz`, {
        title: 'New quiz',
        passPercentage: 40,
        maxAttempts: 1,
        shuffleQuestions: true,
        showAnswersAfter: true,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the quiz.');
    }
  }

  async function moveQuestion(index: number, direction: -1 | 1) {
    if (!quiz) return;
    const target = index + direction;
    if (target < 0 || target >= quiz.questions.length) return;

    const next = [...quiz.questions];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(target, 0, moved);

    const previous = quiz.questions;
    setQuiz({ ...quiz, questions: next });
    setAnnouncement(`Moved question to position ${target + 1} of ${next.length}.`);

    try {
      await api.post(`/teacher/quizzes/${quiz.id}/reorder`, {
        orderedIds: next.map((q) => q.id),
      });
    } catch (err) {
      // Roll back rather than leave the screen disagreeing with the database.
      setQuiz({ ...quiz, questions: previous });
      setError(err instanceof Error ? err.message : 'Could not save the new order.');
    }
  }

  if (!loaded) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-8 sm:px-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-32 w-full" />
        <span className="sr-only" role="status">
          Loading quiz
        </span>
      </div>
    );
  }

  const totalMarks = quiz?.questions.reduce((sum, q) => sum + Number(q.marks || 0), 0) ?? 0;
  const writtenCount = quiz?.questions.filter((q) => !isAutoGraded(q.type)).length ?? 0;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link
          href={quiz ? `/teacher/courses/${quiz.courseId}` : '/teacher'}
          className="rounded-[var(--radius-sm)] text-[var(--color-primary)] hover:underline"
        >
          Back to the course
        </Link>
      </nav>

      {error && (
        <div className="mt-4">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      {loaded && !quiz && !error && (
        <div className="mt-6">
          <EmptyState
            title="No quiz on this lesson yet"
            body="Create one, then add questions. Students see nothing until you publish it."
            action={
              <Button variant="primary" onClick={() => void createQuiz()}>
                <QuizIcon className="size-4" />
                Create quiz
              </Button>
            }
          />
        </div>
      )}

      {quiz && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">{quiz.title}</h1>
            {quiz.isPublished ? (
              <Badge tone="success">Published</Badge>
            ) : (
              <Badge tone="info">Draft</Badge>
            )}
          </div>

          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            <span className="tabular">{quiz.questions.length}</span> question
            {quiz.questions.length === 1 ? '' : 's'} ·{' '}
            <span className="tabular">{totalMarks}</span> mark{totalMarks === 1 ? '' : 's'}
            {writtenCount > 0 && (
              <>
                {' · '}
                <span className="tabular">{writtenCount}</span> need marking by hand
              </>
            )}
          </p>

          <QuizSettings quiz={quiz} onSaved={setQuiz} />

          <section className="mt-8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-[var(--color-foreground)]">Questions</h2>
              <Button
                onClick={() => {
                  setAdding((v) => !v);
                  setEditingId(null);
                }}
                aria-expanded={adding}
              >
                <PlusIcon className="size-4" />
                Add question
              </Button>
            </div>

            {/* Reorder results are announced, not conveyed by visual position
                alone. */}
            <p role="status" aria-live="polite" className="sr-only">
              {announcement}
            </p>

            {adding && (
              <QuestionEditor
                quizId={quiz.id}
                onCancel={() => setAdding(false)}
                onSaved={(created) => {
                  setAdding(false);
                  setQuiz({ ...quiz, questions: [...quiz.questions, created] });
                }}
              />
            )}

            {quiz.questions.length === 0 && !adding && (
              <p className="mt-4 text-sm text-[var(--color-muted-foreground)]">
                No questions yet. A quiz cannot be published until it has at least one.
              </p>
            )}

            <ol className="mt-4 flex flex-col gap-3">
              {quiz.questions.map((question, index) => (
                <li key={question.id}>
                  {editingId === question.id ? (
                    <QuestionEditor
                      quizId={quiz.id}
                      question={question}
                      onCancel={() => setEditingId(null)}
                      onSaved={(saved) => {
                        setEditingId(null);
                        setQuiz({
                          ...quiz,
                          questions: quiz.questions.map((q) => (q.id === saved.id ? saved : q)),
                        });
                      }}
                    />
                  ) : (
                    <QuestionRow
                      question={question}
                      index={index}
                      total={quiz.questions.length}
                      onEdit={() => {
                        setEditingId(question.id);
                        setAdding(false);
                      }}
                      onMove={(direction) => void moveQuestion(index, direction)}
                      onDeleted={() =>
                        setQuiz({
                          ...quiz,
                          questions: quiz.questions.filter((q) => q.id !== question.id),
                        })
                      }
                    />
                  )}
                </li>
              ))}
            </ol>
          </section>

          <PublishPanel quiz={quiz} onSaved={setQuiz} />
        </>
      )}
    </div>
  );
}

function QuestionRow({
  question,
  index,
  total,
  onEdit,
  onMove,
  onDeleted,
}: {
  question: Question;
  index: number;
  total: number;
  onEdit: () => void;
  onMove: (direction: -1 | 1) => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <span className="tabular mt-0.5 text-sm text-[var(--color-muted-foreground)]">
          {index + 1}.
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-[var(--color-foreground)]">{question.prompt}</p>
          <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
            <span className="tabular">{question.marks}</span> mark
            {Number(question.marks) === 1 ? '' : 's'}
            {' · '}
            {isAutoGraded(question.type) ? 'graded automatically' : 'marked by hand'}
          </p>

          {question.options.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {question.options.map((option) => (
                <li key={option.id} className="flex items-center gap-2 text-sm">
                  {/* The key is visible here on purpose — this is the builder.
                      The word "correct" carries it, not the colour alone. */}
                  {option.isCorrect ? (
                    <Badge tone="success">Correct</Badge>
                  ) : (
                    <span className="inline-block w-[4.5rem]" aria-hidden="true" />
                  )}
                  <span className="text-[var(--color-foreground)]">{option.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label={`Move question ${index + 1} up`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
            className="inline-flex size-11 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-muted-foreground)] transition-colors duration-150 hover:bg-[var(--color-muted)] disabled:opacity-30"
          >
            <ChevronUpIcon className="size-4" />
          </button>
          <button
            type="button"
            aria-label={`Move question ${index + 1} down`}
            disabled={index === total - 1}
            onClick={() => onMove(1)}
            className="inline-flex size-11 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-muted-foreground)] transition-colors duration-150 hover:bg-[var(--color-muted)] disabled:opacity-30"
          >
            <ChevronDownIcon className="size-4" />
          </button>

          <Button size="sm" onClick={onEdit}>
            Edit
          </Button>

          <button
            type="button"
            aria-label={`Delete question ${index + 1}`}
            onClick={() => setConfirming(true)}
            className="inline-flex size-11 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-muted-foreground)] transition-colors duration-150 hover:bg-[var(--color-muted)] hover:text-[var(--color-destructive)]"
          >
            <TrashIcon className="size-4" />
          </button>
        </div>
      </div>

      {/* Destructive actions confirm first. Deleting a question a student has
          already answered changes a result they were shown. */}
      {confirming && (
        <div className="mt-3 rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-3">
          <p className="text-sm text-[var(--color-foreground)]">
            Delete this question? Any answers students have already given to it are deleted too.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="danger"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.del(`/teacher/questions/${question.id}`);
                  onDeleted();
                } finally {
                  setBusy(false);
                }
              }}
            >
              Delete
            </Button>
            <Button size="sm" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function QuizSettings({ quiz, onSaved }: { quiz: Quiz; onSaved: (next: Quiz) => void }) {
  const [title, setTitle] = useState(quiz.title);
  const [timeLimit, setTimeLimit] = useState(
    quiz.timeLimitMinutes === null ? '' : String(quiz.timeLimitMinutes),
  );
  const [passPercentage, setPassPercentage] = useState(String(quiz.passPercentage));
  const [maxAttempts, setMaxAttempts] = useState(String(quiz.maxAttempts));
  const [shuffle, setShuffle] = useState(quiz.shuffleQuestions);
  const [showAnswers, setShowAnswers] = useState(quiz.showAnswersAfter);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await api.patch<Quiz>(`/teacher/quizzes/${quiz.id}`, {
        title: title.trim(),
        timeLimitMinutes: timeLimit.trim() === '' ? null : Number(timeLimit),
        passPercentage: Number(passPercentage),
        maxAttempts: Number(maxAttempts),
        shuffleQuestions: shuffle,
        showAnswersAfter: showAnswers,
      });
      onSaved({ ...next, questions: quiz.questions });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the settings.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6 p-5">
      <h2 className="text-base font-semibold text-[var(--color-foreground)]">Quiz settings</h2>

      <form onSubmit={save} className="mt-4 flex flex-col gap-4" noValidate>
        <Field label="Title" required>
          {(props) => (
            <Input {...props} value={title} onChange={(e) => setTitle(e.target.value)} />
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Time limit (minutes)"
            hint="Leave empty for no limit. Enforced on the server; the student's countdown is only a display."
          >
            {(props) => (
              <Input
                {...props}
                inputMode="numeric"
                value={timeLimit}
                onChange={(e) => setTimeLimit(e.target.value)}
                className="tabular"
                placeholder="No limit"
              />
            )}
          </Field>

          <Field label="Pass mark (%)">
            {(props) => (
              <Input
                {...props}
                inputMode="numeric"
                value={passPercentage}
                onChange={(e) => setPassPercentage(e.target.value)}
                className="tabular"
              />
            )}
          </Field>

          <Field label="Attempts allowed" hint="The best attempt counts.">
            {(props) => (
              <Input
                {...props}
                inputMode="numeric"
                value={maxAttempts}
                onChange={(e) => setMaxAttempts(e.target.value)}
                className="tabular"
              />
            )}
          </Field>
        </div>

        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={shuffle}
            onChange={(e) => setShuffle(e.target.checked)}
            className="mt-1 size-4"
          />
          <span>
            <span className="font-medium text-[var(--color-foreground)]">Shuffle questions</span>
            <span className="block text-[var(--color-muted-foreground)]">
              Each student gets a different order. The order is fixed per attempt, so a reload does
              not move their place.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={showAnswers}
            onChange={(e) => setShowAnswers(e.target.checked)}
            className="mt-1 size-4"
          />
          <span>
            <span className="font-medium text-[var(--color-foreground)]">
              Show answers after submitting
            </span>
            <span className="block text-[var(--color-muted-foreground)]">
              Reveals the correct options and your explanations once the attempt is in. Turn this
              off if you allow reattempts and do not want the key circulating.
            </span>
          </span>
        </label>

        {error && <ErrorNote>{error}</ErrorNote>}

        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" loading={busy}>
            Save settings
          </Button>
          {saved && (
            <span role="status" className="text-sm text-[var(--color-success)]">
              Saved
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

function PublishPanel({ quiz, onSaved }: { quiz: Quiz; onSaved: (next: Quiz) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unanswerable = quiz.questions.filter(
    (q) => isAutoGraded(q.type) && !q.options.some((o) => o.isCorrect),
  );

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const next = await api.patch<Quiz>(`/teacher/quizzes/${quiz.id}`, {
        isPublished: !quiz.isPublished,
      });
      onSaved({ ...next, questions: quiz.questions });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the quiz state.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-8 p-5">
      <h2 className="text-base font-semibold text-[var(--color-foreground)]">Visibility</h2>
      <p className="prose-measure mt-1 text-sm text-[var(--color-muted-foreground)]">
        {quiz.isPublished
          ? 'Students with access to this course can attempt this quiz. Unpublishing hides it; attempts already made are kept.'
          : 'Only you can see this quiz. Publish it when the questions are ready.'}
      </p>

      {/* Surfaced before the server refuses, so the teacher can fix it in place
          rather than reading a 409. */}
      {unanswerable.length > 0 && (
        <p className="mt-3 rounded-[var(--radius-md)] bg-[var(--color-coral-tint)] p-3 text-sm text-[var(--color-foreground)]">
          {unanswerable.length} multiple-choice question
          {unanswerable.length === 1 ? ' has' : 's have'} no correct option marked. A student who
          answers correctly would score zero.
        </p>
      )}

      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <Button
        className="mt-4"
        size="sm"
        variant={quiz.isPublished ? 'secondary' : 'primary'}
        loading={busy}
        disabled={!quiz.isPublished && (quiz.questions.length === 0 || unanswerable.length > 0)}
        onClick={() => void toggle()}
      >
        {quiz.isPublished ? 'Unpublish quiz' : 'Publish quiz'}
      </Button>
    </Card>
  );
}

/** The teacher layout already supplies AuthProvider and RequireTeacher. */
export default function QuizBuilderPage() {
  return <QuizBuilderScreen />;
}
