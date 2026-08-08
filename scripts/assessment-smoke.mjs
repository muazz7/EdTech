/**
 * End-to-end smoke test for quizzes, assignments and certificates (Phase 4).
 *
 *   node scripts/assessment-smoke.mjs
 *
 * The assertion this file exists for is section 3: the attempt payload the
 * student actually receives over HTTP must not contain the answer key. The unit
 * tests check the function's return value; this checks the bytes on the wire,
 * which is where the key would actually leak.
 */
import { config as loadEnv } from 'dotenv';
import postgres from 'postgres';
import { createJar } from './lib/cookie-jar.mjs';
import { createStudentSession } from './lib/student-session.mjs';

loadEnv({ path: '.env.local' });

const jar = createJar('dev-web');
const BASE = process.env.BASE_URL ?? 'http://localhost:3001/api/v1';
const PAGE_BASE = BASE.replace('/api/v1', '');
const PHONE = process.env.TEST_PHONE ?? '8801700000000';
const OTP = process.env.TEST_OTP ?? '123321';

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`,
  );
}

let token = null;
let sessionId = null;

async function call(path, { method = 'GET', body, anonymous = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (!anonymous && token) headers.authorization = `Bearer ${token}`;
  if (!anonymous && sessionId) headers['x-session-id'] = sessionId;
  const cookie = jar.header();
  if (cookie && !anonymous) headers.cookie = cookie;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!anonymous) {
    jar.capture(res);
    jar.save();
  }
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON body: keep the raw text so a 500 page is visible in the failure.
  }
  return { status: res.status, raw: text, ...json };
}

const sql = postgres(process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL, {
  ssl: 'require',
  max: 1,
  prepare: false,
});

let courseId = null;
let studentId = null;

try {
  console.log('--- 1. teacher builds a quiz ---');
  const login = await call('/auth/otp/verify', {
    method: 'POST',
    body: { phone: PHONE, code: OTP, device: { platform: 'web', label: 'Assessment smoke' } },
  });
  check('login succeeds', login.status, 200);
  if (login.status !== 200) throw new Error(JSON.stringify(login.error ?? login.raw));
  token = login.data.accessToken;
  sessionId = login.data.sessionId;

  const me = await call('/auth/me');
  const teacherId = me.data.id;
  await sql`UPDATE profiles SET role = 'teacher', full_name = 'Assessment Smoke Teacher'
            WHERE id = ${teacherId}`;

  const stamp = Date.now();
  const course = await call('/teacher/courses', {
    method: 'POST',
    body: {
      title: 'Assessment Smoke Chemistry',
      slug: `assessment-smoke-${stamp}`,
      pricePoisha: 50_000,
      isInAllAccess: true,
    },
  });
  courseId = course.data.id;

  const mod = await call(`/teacher/courses/${courseId}/modules`, {
    method: 'POST',
    body: { title: 'Chapter 1' },
  });
  const lesson = await call(`/teacher/modules/${mod.data.id}/lessons`, {
    method: 'POST',
    body: { title: 'Intro', type: 'note', isFree: false },
  });
  await call(`/teacher/lessons/${lesson.data.id}`, {
    method: 'PATCH',
    body: { isPublished: true },
  });
  await call(`/teacher/courses/${courseId}`, { method: 'PATCH', body: { state: 'published' } });

  const quiz = await call(`/teacher/courses/${courseId}/quizzes`, {
    method: 'POST',
    body: {
      title: 'Chapter 1 test',
      passPercentage: 50,
      maxAttempts: 2,
      shuffleQuestions: false,
      showAnswersAfter: true,
    },
  });
  check('quiz created', quiz.status, 201);
  const quizId = quiz.data.id;

  const mcq = await call(`/teacher/quizzes/${quizId}/questions`, {
    method: 'POST',
    body: {
      type: 'mcq_single',
      prompt: 'Which gas do plants absorb?',
      marks: '10',
      explanation: 'Photosynthesis consumes carbon dioxide.',
      options: [
        { label: 'Oxygen', isCorrect: false },
        { label: 'Carbon dioxide', isCorrect: true },
        { label: 'Nitrogen', isCorrect: false },
      ],
    },
  });
  check('question created', mcq.status, 201);

  const written = await call(`/teacher/quizzes/${quizId}/questions`, {
    method: 'POST',
    body: { type: 'short_answer', prompt: 'Describe the process.', marks: '10' },
  });

  const brokenPublish = await call(`/teacher/quizzes/${quizId}`, {
    method: 'PATCH',
    body: { isPublished: true },
  });
  check('quiz publishes once it has questions', brokenPublish.status, 200);

  console.log('\n--- 2. a student without access is refused ---');
  const created = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      phone: `+88017${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      phone_confirm: true,
    }),
  });
  const studentUser = await created.json();
  studentId = studentUser.id;
  await sql`INSERT INTO profiles (id, full_name, role)
            VALUES (${studentId}, 'Assessment Student', 'student')`;
  const studentAuth = await createStudentSession(sql, studentId);

  async function asStudent(path, init = {}) {
    const saved = { token, sessionId };
    token = studentAuth.token;
    sessionId = studentAuth.sessionId;
    try {
      return await call(path, init);
    } finally {
      token = saved.token;
      sessionId = saved.sessionId;
    }
  }

  const unentitled = await asStudent(`/quizzes/${quizId}/attempts`, { method: 'POST' });
  check('unentitled student refused', unentitled.status, 403);

  await call('/teacher/access', {
    method: 'POST',
    body: { studentId, courseId, note: 'Assessment smoke' },
  });

  console.log('\n--- 3. the answer key never reaches the wire ---');
  const attempt = await asStudent(`/quizzes/${quizId}/attempts`, { method: 'POST' });
  check('attempt starts', attempt.status, 200);

  // The raw response body, not the parsed object. This is the bytes the browser
  // receives, which is exactly where a leaked key would sit.
  check('no isCorrect in the response body', attempt.raw.includes('isCorrect'), false);
  check('no is_correct in the response body', attempt.raw.includes('is_correct'), false);
  check('no explanation in the response body', attempt.raw.includes('explanation'), false);
  check(
    'the explanation text itself is absent',
    attempt.raw.includes('Photosynthesis consumes'),
    false,
  );

  const mcqInAttempt = attempt.data.questions.find((q) => q.id === mcq.data.id);
  check('options are still present', mcqInAttempt.options.length, 3);
  check(
    'options carry only id and label',
    Object.keys(mcqInAttempt.options[0]).sort(),
    ['id', 'label'],
  );

  const answerKeyEarly = await asStudent(`/attempts/${attempt.data.attemptId}/answer-key`);
  check('answer key refused before submission', answerKeyEarly.status, 404);

  console.log('\n--- 4. autosave and submit ---');
  const correctId = mcq.data.options.find((o) => o.isCorrect).id;
  const saved = await asStudent(`/attempts/${attempt.data.attemptId}/answers`, {
    method: 'POST',
    body: { questionId: mcq.data.id, selectedOptionIds: [correctId] },
  });
  check('autosave accepted', saved.status, 200);
  check('autosave reveals nothing', saved.raw.includes('correct'), false);

  await asStudent(`/attempts/${attempt.data.attemptId}/answers`, {
    method: 'POST',
    body: { questionId: written.data.id, textAnswer: 'Plants take in CO2 and release O2.' },
  });

  const submitted = await asStudent(`/attempts/${attempt.data.attemptId}/submit`, {
    method: 'POST',
    body: {},
  });
  check('submit succeeds', submitted.status, 200);
  check('MCQ auto-scored', submitted.data.autoScore, '10.00');
  check('written answer waits for a human', submitted.data.gradingStatus, 'partial');
  check('pass/fail withheld until complete', submitted.data.passed, null);

  const resubmit = await asStudent(`/attempts/${attempt.data.attemptId}/submit`, {
    method: 'POST',
    body: {},
  });
  check('a second submit is refused', resubmit.status, 409);

  console.log('\n--- 5. teacher grades the written answer ---');
  const queue = await call('/teacher/grading');
  check('queue loads', queue.status, 200);
  check(
    'the attempt is queued',
    queue.data.quizAttempts.some((row) => row.attemptId === attempt.data.attemptId),
    true,
  );

  const graded = await call(`/teacher/attempts/${attempt.data.attemptId}/grade`, {
    method: 'POST',
    body: { questionId: written.data.id, awardedMarks: '8', teacherFeedback: 'Good.' },
  });
  check('grading succeeds', graded.status, 200);
  check('total re-computed', graded.data.totalScore, '18.00');
  check('now complete', graded.data.gradingStatus, 'complete');
  check('passed', graded.data.passed, true);

  const overMax = await call(`/teacher/attempts/${attempt.data.attemptId}/grade`, {
    method: 'POST',
    body: { questionId: written.data.id, awardedMarks: '99' },
  });
  check('marks above the maximum refused', overMax.status, 422);

  console.log('\n--- 6. the result screen ---');
  const result = await asStudent(`/attempts/${attempt.data.attemptId}/result`);
  check('result loads', result.status, 200);
  check('explanation released after submission', result.raw.includes('Photosynthesis'), true);

  const key = await asStudent(`/attempts/${attempt.data.attemptId}/answer-key`);
  check('answer key released after submission', key.status, 200);
  check(
    'key names the right option',
    key.data.find((row) => row.questionId === mcq.data.id).correctOptionIds,
    [correctId],
  );

  console.log('\n--- 7. assignments ---');
  const assignment = await call(`/teacher/courses/${courseId}/assignments`, {
    method: 'POST',
    body: {
      title: 'Lab report',
      instructions: 'Upload a photo of your write-up.',
      maxMarks: '50',
      maxFileMb: 5,
      allowedMime: ['application/pdf'],
      allowLate: true,
    },
  });
  check('assignment created', assignment.status, 201);
  await call(`/teacher/assignments/${assignment.data.id}`, {
    method: 'PATCH',
    body: { isPublished: true },
  });

  const badMime = await asStudent(`/assignments/${assignment.data.id}/upload-url`, {
    method: 'POST',
    body: { filename: 'virus.exe', mime: 'application/x-msdownload', size: 1000 },
  });
  check('disallowed MIME refused at presign', badMime.status, 422);

  const oversize = await asStudent(`/assignments/${assignment.data.id}/upload-url`, {
    method: 'POST',
    body: { filename: 'big.pdf', mime: 'application/pdf', size: 50 * 1024 * 1024 },
  });
  check('oversize file refused at presign', oversize.status, 422);

  // Submitting with a key minted for somebody else must be refused. Written
  // directly rather than via presign because R2 credentials are not configured.
  const foreignKey = await asStudent(`/assignments/${assignment.data.id}/submit`, {
    method: 'POST',
    body: {
      files: [
        {
          key: `assignments/${assignment.data.id}/00000000-0000-0000-0000-000000000000/x.pdf`,
          name: 'x.pdf',
          size: 100,
          mime: 'application/pdf',
        },
      ],
    },
  });
  check("another student's key refused", foreignKey.status, 422);

  const submit = await asStudent(`/assignments/${assignment.data.id}/submit`, {
    method: 'POST',
    body: {
      files: [
        {
          key: `assignments/${assignment.data.id}/${studentId}/report.pdf`,
          name: 'report.pdf',
          size: 100,
          mime: 'application/pdf',
        },
      ],
      studentNote: 'Done.',
    },
  });
  check('submission accepted', submit.status, 201);

  const view = await asStudent(`/assignments/${assignment.data.id}`);
  check('R2 keys are not sent to the student', view.raw.includes('assignments/'), false);

  const submissions = await call(`/teacher/assignments/${assignment.data.id}/submissions`);
  check('teacher sees the submission', submissions.data.length, 1);

  await call(`/teacher/submissions/${submissions.data[0].id}/grade`, {
    method: 'POST',
    body: { marks: '45', teacherFeedback: 'Neat work.' },
  });

  const locked = await asStudent(`/assignments/${assignment.data.id}/submit`, {
    method: 'POST',
    body: {
      files: [
        {
          key: `assignments/${assignment.data.id}/${studentId}/redo.pdf`,
          name: 'redo.pdf',
          size: 100,
          mime: 'application/pdf',
        },
      ],
    },
  });
  check('resubmission locked after grading (ADR 0004)', locked.status, 409);

  console.log('\n--- 8. certificates ---');
  // Complete the one published lesson so the default 90% rule is met.
  await sql`
    INSERT INTO lesson_progress (student_id, lesson_id, course_id, seconds_watched,
                                 last_position, is_complete, completed_at)
    VALUES (${studentId}, ${lesson.data.id}, ${courseId}, 600, 600, true, now())
    ON CONFLICT (student_id, lesson_id)
    DO UPDATE SET is_complete = true, completed_at = now()`;

  const completion = await asStudent(`/me/completion/${courseId}`);
  check('completion evaluates', completion.status, 200);
  check('eligible once the work is done', completion.data.eligible, true);

  const openSweep = await call('/cron/issue-certificates', { method: 'POST', anonymous: true });
  // 503 means CRON_SECRET is unset, and assertCronRequest fails closed rather
  // than treating "no secret configured" as "allow everyone". Either answer
  // proves the endpoint is not open; only 200 would be a failure.
  check('the certificate cron is not publicly callable', openSweep.status !== 200, true);

  if (process.env.CRON_SECRET) {
    // Driven with the real secret, exactly as Vercel Cron would.
    const sweep = await fetch(`${BASE}/cron/issue-certificates`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    const sweepJson = await sweep.json().catch(() => ({}));
    check('the sweep runs with the secret', sweep.status, 200);
    check('it issued a certificate', (sweepJson.data?.issued ?? 0) >= 1, true);
  } else {
    console.log('SKIP  cron-driven issuance (CRON_SECRET not set in .env.local)');
    console.log('      issuing directly so the public verification checks below still run');
    // The issuance rule itself is covered by the unit tests. What section 9
    // exercises is the public verification endpoint, which only needs a row.
    const year = new Date().getUTCFullYear();
    const suffix = Array.from({ length: 8 }, () =>
      '0123456789ABCDEF'[Math.floor(Math.random() * 16)],
    ).join('');
    await sql`
      INSERT INTO certificates (id, certificate_no, student_id, course_id, student_name,
                                course_title, teacher_name)
      VALUES (gen_random_uuid(), ${`CERT-${year}-${suffix}`}, ${studentId}, ${courseId},
              'Assessment Student', 'Assessment Smoke Chemistry', 'Assessment Smoke Teacher')`;
  }

  const [certificate] = await sql`
    SELECT certificate_no FROM certificates WHERE student_id = ${studentId}`;
  check('a certificate row exists', Boolean(certificate), true);
  check(
    'the number is not sequential',
    /^CERT-\d{4}-[0-9A-F]{8}$/.test(certificate?.certificate_no ?? ''),
    true,
  );

  const mine = await asStudent('/me/certificates');
  check('the student can see it', mine.data.length, 1);

  console.log('\n--- 9. public certificate verification ---');
  const verified = await call(`/verify/${certificate.certificate_no}`, { anonymous: true });
  check('verifies without a session', verified.status, 200);
  check('reports valid', verified.data.status, 'valid');
  check('carries the student name', verified.data.studentName, 'Assessment Student');
  // Readable by anyone on the internet who has the number, so nothing that
  // identifies the account or the course record may be in it.
  check('no student id leaked', verified.raw.includes(studentId), false);
  check('no course id leaked', verified.raw.includes(courseId), false);

  const certId = (
    await sql`SELECT id FROM certificates WHERE student_id = ${studentId}`
  )[0].id;
  await call(`/teacher/certificates/${certId}/revoke`, {
    method: 'POST',
    body: { reason: 'Smoke test revocation' },
  });

  const afterRevoke = await call(`/verify/${certificate.certificate_no}`, { anonymous: true });
  // Revoked, not missing. An employer checking a revoked certificate must be
  // told it was revoked rather than that it never existed.
  check('a revoked certificate still verifies', afterRevoke.status, 200);
  check('and reports revoked', afterRevoke.data.status, 'revoked');

  const bogus = await call('/verify/CERT-2026-DEADBEEF', { anonymous: true });
  check('unknown certificate is a 404', bogus.status, 404);

  const malformed = await call('/verify/not-a-certificate', { anonymous: true });
  check('a malformed number gets the same answer', malformed.status, 404);

  const verifyPage = await fetch(`${PAGE_BASE}/verify/${certificate.certificate_no}`);
  check('the verification page renders for a stranger', verifyPage.status, 200);

  console.log('\n--- 10. private endpoints refuse strangers ---');
  for (const path of [
    `/quizzes/${quizId}/attempts`,
    `/attempts/${attempt.data.attemptId}/result`,
    `/teacher/grading`,
    `/teacher/quizzes/${quizId}`,
  ]) {
    const anon = await call(path, { anonymous: true });
    check(`anonymous ${path} rejected`, anon.status, 401);
  }
} finally {
  if (studentId) {
    await sql`DELETE FROM certificates WHERE student_id = ${studentId}`;
    await sql`DELETE FROM assignment_submissions WHERE student_id = ${studentId}`;
    await sql`DELETE FROM quiz_answers WHERE attempt_id IN (
                SELECT id FROM quiz_attempts WHERE student_id = ${studentId})`;
    await sql`DELETE FROM quiz_attempts WHERE student_id = ${studentId}`;
    await sql`DELETE FROM lesson_progress WHERE student_id = ${studentId}`;
    await sql`DELETE FROM watch_events WHERE student_id = ${studentId}`;
    await sql`DELETE FROM notifications WHERE user_id = ${studentId}`;
    await sql`DELETE FROM entitlements WHERE student_id = ${studentId}`;
    await sql`DELETE FROM device_switch_log WHERE user_id = ${studentId}`;
    await sql`DELETE FROM active_sessions WHERE user_id = ${studentId}`;
  }

  if (courseId) {
    await sql`DELETE FROM certificates WHERE course_id = ${courseId}`;
    await sql`DELETE FROM entitlements WHERE course_id = ${courseId}`;
    await sql`DELETE FROM payments WHERE course_id = ${courseId}`;
    await sql`DELETE FROM audit_log WHERE entity_id = ${courseId}`;
    await sql`DELETE FROM lesson_progress WHERE course_id = ${courseId}`;
    await sql`DELETE FROM lessons WHERE course_id = ${courseId}`;
    await sql`DELETE FROM modules WHERE course_id = ${courseId}`;
    await sql`DELETE FROM courses WHERE id = ${courseId}`;
  }

  if (studentId) {
    // audit_log.actor_id has no ON DELETE rule — the trail is immutable by
    // design, so the student's own audited actions (certificate.issue) block
    // the profile delete until they are cleared.
    await sql`DELETE FROM audit_log WHERE actor_id = ${studentId}`;
    await sql`DELETE FROM profiles WHERE id = ${studentId}`;
    await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${studentId}`, {
      method: 'DELETE',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }).catch(() => undefined);
  }

  await sql.end();
  console.log('\ncleaned up');
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
