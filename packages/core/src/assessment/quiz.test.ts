import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb, quizAttempts } from '@edtech/db';
import { ApiError } from '@edtech/shared';
import {
  addQuestion,
  createQuiz,
  getQuizForTeacher,
  updateQuiz,
} from './quiz-builder.js';
import {
  getAttemptAnswerKey,
  getAttemptResult,
  saveAnswer,
  startAttempt,
  submitAttempt,
} from './quiz-attempt.js';
import { gradeAnswer, listGradingQueue } from './quiz-grading.js';
import type { Actor } from '../content/ownership.js';
import { cleanup, createCourse, createUser, grantEntitlement } from '../testing/fixtures.js';

/**
 * The quiz engine (Section 10).
 *
 * The assertion this file exists for is the first one: `is_correct` must not
 * reach the client before submission. It is the mistake most quiz
 * implementations make, and it is invisible in a UI review because the answer
 * key sits in the network response rather than on the screen.
 */

let teacher: Actor;
let course: Awaited<ReturnType<typeof createCourse>>;

/** Ages an attempt so the server-side time limit fires without the test
 *  sleeping for real. */
async function backdateAttempt(attemptId: string, minutes: number) {
  await getDb()
    .update(quizAttempts)
    .set({ startedAt: sql`now() - interval '${sql.raw(String(minutes))} minutes'` })
    .where(eq(quizAttempts.id, attemptId));
}

/**
 * createQuiz takes a PARSED input, so every defaulted field is present by the
 * time it is called. The routes get that from Zod; the tests get it from here.
 */
function quizInput(overrides: Partial<Parameters<typeof createQuiz>[2]> = {}) {
  return {
    title: 'Test Quiz',
    passPercentage: 50,
    maxAttempts: 2,
    shuffleQuestions: false,
    showAnswersAfter: true,
    timeLimitMinutes: null,
    ...overrides,
  };
}

/** A two-question quiz: one auto-graded, one written. */
async function buildQuiz(options: { showAnswersAfter?: boolean; timeLimitMinutes?: number } = {}) {
  const quiz = await createQuiz(
    teacher,
    course.courseId,
    quizInput({
      showAnswersAfter: options.showAnswersAfter ?? true,
      timeLimitMinutes: options.timeLimitMinutes ?? null,
    }),
  );

  const mcq = await addQuestion(teacher, quiz.id, {
    type: 'mcq_single',
    prompt: 'What is 2 + 2?',
    marks: '10',
    explanation: 'Basic arithmetic.',
    options: [
      { label: '3', isCorrect: false },
      { label: '4', isCorrect: true },
      { label: '5', isCorrect: false },
    ],
  });

  const written = await addQuestion(teacher, quiz.id, {
    type: 'short_answer',
    prompt: 'Explain your reasoning.',
    marks: '10',
  });

  await updateQuiz(teacher, quiz.id, { isPublished: true });
  return { quiz, mcq, written };
}

before(async () => {
  const user = await createUser('teacher', 'Quiz Teacher');
  teacher = { userId: user.id, role: 'teacher' };
  course = await createCourse({ teacherId: user.id, isInAllAccess: true });
});

after(async () => {
  await cleanup();
  await closeDb();
});

describe('answer key confidentiality', () => {
  it('never sends is_correct to the student before submission', async () => {
    const { quiz } = await buildQuiz();
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    const attempt = await startAttempt(student.id, quiz.id);
    const serialised = JSON.stringify(attempt);

    // The whole payload, not just the fields we remembered to check. A future
    // field that carries the key would slip past a per-field assertion.
    assert.equal(serialised.includes('isCorrect'), false, 'attempt payload leaks isCorrect');
    assert.equal(serialised.includes('is_correct'), false);
    assert.equal(serialised.includes('explanation'), false, 'explanations give the answer away');

    const options = attempt.questions.find((q) => q.id !== undefined && q.options)?.options ?? [];
    assert.ok(options.length > 0, 'the MCQ should still carry its options');
    for (const option of options) {
      assert.deepEqual(Object.keys(option).sort(), ['id', 'label']);
    }
  });

  it('does not reveal correctness when autosaving', async () => {
    // A save endpoint that answered "right" or "wrong" would be a free answer
    // key: submit each option in turn and read the replies.
    const { quiz, mcq } = await buildQuiz();
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    const attempt = await startAttempt(student.id, quiz.id);
    const wrong = mcq.options.find((o) => !o.isCorrect);
    const saved = await saveAnswer(student.id, attempt.attemptId, {
      questionId: mcq.id,
      selectedOptionIds: [wrong!.id],
    });

    assert.deepEqual(saved, { saved: true });
  });

  it('withholds the key entirely when the teacher turned answers off', async () => {
    const { quiz, mcq } = await buildQuiz({ showAnswersAfter: false });
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    const attempt = await startAttempt(student.id, quiz.id);
    const correct = mcq.options.find((o) => o.isCorrect);
    await saveAnswer(student.id, attempt.attemptId, {
      questionId: mcq.id,
      selectedOptionIds: [correct!.id],
    });
    await submitAttempt(student.id, attempt.attemptId);

    const result = await getAttemptResult(student.id, attempt.attemptId);
    assert.equal(JSON.stringify(result).includes('explanation'), false);

    // 404 rather than 403: telling a student there is a key they may not see
    // invites them to go looking for it.
    await assert.rejects(
      () => getAttemptAnswerKey(student.id, attempt.attemptId),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        return true;
      },
    );
  });

  it('releases the key only after submission, when allowed', async () => {
    const { quiz, mcq } = await buildQuiz({ showAnswersAfter: true });
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    const attempt = await startAttempt(student.id, quiz.id);

    // Before submitting, there is nothing to see.
    await assert.rejects(() => getAttemptAnswerKey(student.id, attempt.attemptId));

    await saveAnswer(student.id, attempt.attemptId, {
      questionId: mcq.id,
      selectedOptionIds: [mcq.options[0]!.id],
    });
    await submitAttempt(student.id, attempt.attemptId);

    const key = await getAttemptAnswerKey(student.id, attempt.attemptId);
    const entry = key.find((row) => row.questionId === mcq.id);
    assert.deepEqual(entry?.correctOptionIds, [mcq.options.find((o) => o.isCorrect)!.id]);
  });
});

describe('attempt lifecycle', () => {
  it('resumes the open attempt instead of burning another try', async () => {
    // A dropped connection must not cost a student one of their attempts.
    const { quiz } = await buildQuiz();
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    const first = await startAttempt(student.id, quiz.id);
    const resumed = await startAttempt(student.id, quiz.id);

    assert.equal(resumed.attemptId, first.attemptId);
    assert.equal(resumed.attemptNumber, 1);
    assert.deepEqual(
      resumed.questions.map((q) => q.id),
      first.questions.map((q) => q.id),
      'the question order must survive a reload',
    );
  });

  it('enforces the attempt limit', async () => {
    const { quiz } = await buildQuiz();
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    for (let i = 0; i < 2; i++) {
      const attempt = await startAttempt(student.id, quiz.id);
      await submitAttempt(student.id, attempt.attemptId);
    }

    await assert.rejects(
      () => startAttempt(student.id, quiz.id),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 403);
        assert.equal(err.code, 'ATTEMPT_LIMIT_REACHED');
        return true;
      },
    );
  });

  it('refuses a quiz the student is not entitled to', async () => {
    const { quiz } = await buildQuiz();
    const student = await createUser();

    await assert.rejects(
      () => startAttempt(student.id, quiz.id),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 403);
        return true;
      },
    );
  });

  it('hides an unpublished quiz as a 404', async () => {
    const quiz = await createQuiz(teacher, course.courseId, quizInput({ title: 'Draft quiz' }));
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    await assert.rejects(
      () => startAttempt(student.id, quiz.id),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        return true;
      },
    );
  });
});

describe('server-side time limit', () => {
  it('stops accepting answers once the clock is up', async () => {
    const { quiz, mcq } = await buildQuiz({ timeLimitMinutes: 10 });
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    const attempt = await startAttempt(student.id, quiz.id);
    await backdateAttempt(attempt.attemptId, 11);

    await assert.rejects(
      () =>
        saveAnswer(student.id, attempt.attemptId, {
          questionId: mcq.id,
          selectedOptionIds: [mcq.options.find((o) => o.isCorrect)!.id],
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.code, 'ATTEMPT_TIME_EXPIRED');
        return true;
      },
    );
  });

  it('discards a batch that arrives with a late submit', async () => {
    // Section 10: answers arriving after the grace window count as unanswered.
    // Otherwise the grace period becomes a way to answer everything at leisure.
    const { quiz, mcq } = await buildQuiz({ timeLimitMinutes: 10 });
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    const attempt = await startAttempt(student.id, quiz.id);
    await backdateAttempt(attempt.attemptId, 11);

    const result = await submitAttempt(student.id, attempt.attemptId, {
      answers: [
        { questionId: mcq.id, selectedOptionIds: [mcq.options.find((o) => o.isCorrect)!.id] },
      ],
    });

    assert.equal(result.lateSubmission, true);
    assert.equal(result.autoScore, '0.00', 'a late answer must not score');
  });

  it('accepts a submit inside the grace window', async () => {
    const { quiz, mcq } = await buildQuiz({ timeLimitMinutes: 10 });
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    const attempt = await startAttempt(student.id, quiz.id);
    // Nine minutes in: still running, and a slow connection is not cheating.
    await backdateAttempt(attempt.attemptId, 9);

    const result = await submitAttempt(student.id, attempt.attemptId, {
      answers: [
        { questionId: mcq.id, selectedOptionIds: [mcq.options.find((o) => o.isCorrect)!.id] },
      ],
    });

    assert.equal(result.lateSubmission, false);
    assert.equal(result.autoScore, '10.00');
  });
});

describe('grading', () => {
  it('auto-grades the MCQ and waits for a human on the written answer', async () => {
    const { quiz, mcq, written } = await buildQuiz();
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    const attempt = await startAttempt(student.id, quiz.id);
    await saveAnswer(student.id, attempt.attemptId, {
      questionId: mcq.id,
      selectedOptionIds: [mcq.options.find((o) => o.isCorrect)!.id],
    });
    await saveAnswer(student.id, attempt.attemptId, {
      questionId: written.id,
      textAnswer: 'Because two twos are four.',
    });

    const submitted = await submitAttempt(student.id, attempt.attemptId);

    assert.equal(submitted.autoScore, '10.00');
    assert.equal(submitted.gradingStatus, 'partial');
    assert.equal(
      submitted.passed,
      null,
      'pass/fail must not be shown from half a score and then change',
    );

    const graded = await gradeAnswer(teacher, attempt.attemptId, written.id, {
      awardedMarks: '8',
      teacherFeedback: 'Clear enough.',
    });

    assert.equal(graded.gradingStatus, 'complete');
    assert.equal(graded.totalScore, '18.00');
    assert.equal(graded.passed, true);
  });

  it('scores an unanswered written question as zero without waiting', async () => {
    // A blank long answer is a zero, not a grading task. Otherwise every
    // abandoned attempt lands in the teacher's queue forever.
    const { quiz, mcq } = await buildQuiz();
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    const attempt = await startAttempt(student.id, quiz.id);
    await saveAnswer(student.id, attempt.attemptId, {
      questionId: mcq.id,
      selectedOptionIds: [mcq.options.find((o) => o.isCorrect)!.id],
    });

    const submitted = await submitAttempt(student.id, attempt.attemptId);
    assert.equal(submitted.gradingStatus, 'complete');
    assert.equal(submitted.passed, true, '10 of 20 is 50%, which is the pass mark');
  });

  it('refuses marks above the question maximum', async () => {
    const { quiz, written } = await buildQuiz();
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    const attempt = await startAttempt(student.id, quiz.id);
    await saveAnswer(student.id, attempt.attemptId, {
      questionId: written.id,
      textAnswer: 'Something.',
    });
    await submitAttempt(student.id, attempt.attemptId);

    await assert.rejects(
      () => gradeAnswer(teacher, attempt.attemptId, written.id, { awardedMarks: '50' }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 422);
        return true;
      },
    );
  });

  it('refuses to let a teacher hand-mark an auto-graded question', async () => {
    // "Why is my MCQ wrong" has to have one answer, and it is the key.
    const { quiz, mcq } = await buildQuiz();
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    const attempt = await startAttempt(student.id, quiz.id);
    await submitAttempt(student.id, attempt.attemptId);

    await assert.rejects(
      () => gradeAnswer(teacher, attempt.attemptId, mcq.id, { awardedMarks: '10' }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 422);
        return true;
      },
    );
  });

  it('keeps one teacher out of another teacher\'s grading', async () => {
    const { quiz, written } = await buildQuiz();
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    const attempt = await startAttempt(student.id, quiz.id);
    await saveAnswer(student.id, attempt.attemptId, {
      questionId: written.id,
      textAnswer: 'Answer.',
    });
    await submitAttempt(student.id, attempt.attemptId);

    const outsiderUser = await createUser('teacher', 'Other Teacher');
    const outsider: Actor = { userId: outsiderUser.id, role: 'teacher' };

    await assert.rejects(
      () => gradeAnswer(outsider, attempt.attemptId, written.id, { awardedMarks: '5' }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        // 404, not 403: a 403 confirms the attempt exists.
        assert.equal(err.status, 404);
        return true;
      },
    );

    const queue = await listGradingQueue(outsider);
    assert.equal(
      queue.some((row) => row.attemptId === attempt.attemptId),
      false,
      'another teacher must not see this attempt in their queue',
    );
  });

  it('puts a pending written answer in the owning teacher\'s queue', async () => {
    const { quiz, written } = await buildQuiz();
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    const attempt = await startAttempt(student.id, quiz.id);
    await saveAnswer(student.id, attempt.attemptId, {
      questionId: written.id,
      textAnswer: 'Needs marking.',
    });
    await submitAttempt(student.id, attempt.attemptId);

    const queue = await listGradingQueue(teacher);
    const row = queue.find((entry) => entry.attemptId === attempt.attemptId);
    assert.ok(row, 'the attempt should be queued');
    assert.equal(row.pending, 1);
  });
});

describe('answer tampering', () => {
  it('ignores option ids that belong to another question', async () => {
    // Grading would otherwise score against a set the teacher never wrote.
    const { quiz, mcq } = await buildQuiz();
    const other = await addQuestion(teacher, quiz.id, {
      type: 'mcq_single',
      prompt: 'Unrelated',
      marks: '5',
      options: [
        { label: 'a', isCorrect: true },
        { label: 'b', isCorrect: false },
      ],
    });

    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });
    const attempt = await startAttempt(student.id, quiz.id);

    await saveAnswer(student.id, attempt.attemptId, {
      questionId: mcq.id,
      selectedOptionIds: [other.options[0]!.id],
    });

    const submitted = await submitAttempt(student.id, attempt.attemptId);
    assert.equal(submitted.autoScore, '0.00', 'a foreign option id must not score');
  });

  it('does not award partial credit for ticking every box', async () => {
    const quiz = await createQuiz(teacher, course.courseId, quizInput({ title: 'Multi' }));
    const multi = await addQuestion(teacher, quiz.id, {
      type: 'mcq_multi',
      prompt: 'Pick the even numbers',
      marks: '10',
      options: [
        { label: '2', isCorrect: true },
        { label: '3', isCorrect: false },
        { label: '4', isCorrect: true },
      ],
    });
    await updateQuiz(teacher, quiz.id, { isPublished: true });

    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });
    const attempt = await startAttempt(student.id, quiz.id);

    await saveAnswer(student.id, attempt.attemptId, {
      questionId: multi.id,
      selectedOptionIds: multi.options.map((o) => o.id),
    });

    const submitted = await submitAttempt(student.id, attempt.attemptId);
    assert.equal(submitted.totalScore, '0.00', 'selecting everything must not score');
  });

  it('refuses a second submission of the same attempt', async () => {
    const { quiz } = await buildQuiz();
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    const attempt = await startAttempt(student.id, quiz.id);
    await submitAttempt(student.id, attempt.attemptId);

    await assert.rejects(
      () => submitAttempt(student.id, attempt.attemptId),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.code, 'ATTEMPT_ALREADY_SUBMITTED');
        return true;
      },
    );
  });

  it('will not let one student read another\'s attempt', async () => {
    const { quiz } = await buildQuiz();
    const owner = await createUser();
    const stranger = await createUser();
    await grantEntitlement({ studentId: owner.id, kind: 'lifetime_all' });
    await grantEntitlement({ studentId: stranger.id, kind: 'lifetime_all' });

    const attempt = await startAttempt(owner.id, quiz.id);
    await submitAttempt(owner.id, attempt.attemptId);

    await assert.rejects(
      () => getAttemptResult(stranger.id, attempt.attemptId),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        return true;
      },
    );
  });
});

describe('authoring guards', () => {
  it('refuses to publish a quiz with no questions', async () => {
    const quiz = await createQuiz(teacher, course.courseId, quizInput({ title: 'Empty' }));
    await assert.rejects(
      () => updateQuiz(teacher, quiz.id, { isPublished: true }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 409);
        return true;
      },
    );
  });

  it('refuses a choice question with no correct option', async () => {
    // Unanswerable: the student gets it right and scores zero.
    const quiz = await createQuiz(teacher, course.courseId, quizInput({ title: 'Broken' }));
    await assert.rejects(
      () =>
        addQuestion(teacher, quiz.id, {
          type: 'mcq_single',
          prompt: 'No key',
          marks: '1',
          options: [
            { label: 'a', isCorrect: false },
            { label: 'b', isCorrect: false },
          ],
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 422);
        return true;
      },
    );
  });

  it('refuses two correct options on a single-answer question', async () => {
    const quiz = await createQuiz(teacher, course.courseId, quizInput({ title: 'Ambiguous' }));
    await assert.rejects(() =>
      addQuestion(teacher, quiz.id, {
        type: 'mcq_single',
        prompt: 'Two keys',
        marks: '1',
        options: [
          { label: 'a', isCorrect: true },
          { label: 'b', isCorrect: true },
        ],
      }),
    );
  });

  it('gives the teacher the key they need to author with', async () => {
    const { quiz } = await buildQuiz();
    const view = await getQuizForTeacher(teacher, quiz.id);
    const mcq = view.questions.find((q) => q.type === 'mcq_single');
    assert.ok(mcq?.options.some((o) => o.isCorrect), 'the builder needs the answer key');
  });

  it('keeps one teacher out of another teacher\'s quiz', async () => {
    const { quiz } = await buildQuiz();
    const outsiderUser = await createUser('teacher', 'Nosy Teacher');
    const outsider: Actor = { userId: outsiderUser.id, role: 'teacher' };

    await assert.rejects(
      () => getQuizForTeacher(outsider, quiz.id),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        return true;
      },
    );
  });
});
