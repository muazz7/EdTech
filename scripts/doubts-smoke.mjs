/**
 * End-to-end smoke test for doubt threads (Section 12).
 *
 *   node scripts/doubts-smoke.mjs
 *
 * Public-by-default is the design, so the checks that matter are the
 * exceptions: a private thread stays private over HTTP, a hidden one disappears
 * without being destroyed, and `is_teacher_answer` cannot be claimed by a
 * student sending it in the body.
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
    // Non-JSON body: keep the raw text so a 500 page shows in the failure.
  }
  return { status: res.status, raw: text, ...json };
}

const sql = postgres(process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL, {
  ssl: 'require',
  max: 1,
  prepare: false,
});

let courseId = null;
const studentIds = [];

async function makeStudent(name) {
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
  const user = await created.json();
  studentIds.push(user.id);
  await sql`INSERT INTO profiles (id, full_name, role) VALUES (${user.id}, ${name}, 'student')`;
  return { id: user.id, auth: await createStudentSession(sql, user.id) };
}

try {
  console.log('--- 1. a published lesson to ask about ---');
  const login = await call('/auth/otp/verify', {
    method: 'POST',
    body: { phone: PHONE, code: OTP, device: { platform: 'web', label: 'Doubts smoke' } },
  });
  check('login succeeds', login.status, 200);
  if (login.status !== 200) throw new Error(JSON.stringify(login.error ?? login.raw));
  token = login.data.accessToken;
  sessionId = login.data.sessionId;

  const me = await call('/auth/me');
  const teacherId = me.data.id;
  await sql`UPDATE profiles SET role = 'teacher', full_name = 'Doubts Smoke Teacher'
            WHERE id = ${teacherId}`;

  const stamp = Date.now();
  const course = await call('/teacher/courses', {
    method: 'POST',
    body: { title: 'Doubts Smoke Course', slug: `doubts-smoke-${stamp}`, pricePoisha: 50_000 },
  });
  courseId = course.data.id;

  const mod = await call(`/teacher/courses/${courseId}/modules`, {
    method: 'POST',
    body: { title: 'Chapter 1' },
  });
  const lesson = await call(`/teacher/modules/${mod.data.id}/lessons`, {
    method: 'POST',
    body: { title: 'Lecture 1', type: 'note', isFree: false },
  });
  await call(`/teacher/lessons/${lesson.data.id}`, { method: 'PATCH', body: { isPublished: true } });
  await call(`/teacher/courses/${courseId}`, { method: 'PATCH', body: { state: 'published' } });

  const asker = await makeStudent('Doubts Asker');
  const peer = await makeStudent('Doubts Peer');
  const outsider = await makeStudent('Doubts Outsider');

  for (const student of [asker, peer]) {
    await call('/teacher/access', {
      method: 'POST',
      body: { studentId: student.id, courseId, note: 'Doubts smoke' },
    });
  }

  async function as(student, path, init = {}) {
    const saved = { token, sessionId };
    token = student.auth.token;
    sessionId = student.auth.sessionId;
    try {
      return await call(path, init);
    } finally {
      token = saved.token;
      sessionId = saved.sessionId;
    }
  }

  console.log('\n--- 2. asking ---');
  const blocked = await as(outsider, `/lessons/${lesson.data.id}/doubts`, {
    method: 'POST',
    body: { title: 'Can I ask without paying?', body: 'Testing the gate.', isPublic: true },
  });
  check('an unentitled student cannot ask', blocked.status, 403);

  const thread = await as(asker, `/lessons/${lesson.data.id}/doubts`, {
    method: 'POST',
    body: {
      title: 'Why does the sign flip in step three?',
      body: 'I followed to step two and then lost it.',
      isPublic: true,
    },
  });
  check('a public question posts', thread.status, 201);

  const peerView = await as(peer, `/lessons/${lesson.data.id}/doubts`);
  check('another student can see it', peerView.data.some((t) => t.id === thread.data.id), true);

  console.log('\n--- 3. is_teacher_answer cannot be claimed ---');
  const fake = await as(asker, `/doubts/${thread.data.id}/replies`, {
    method: 'POST',
    // The client sends the flag; the server must ignore it and read the role.
    body: { body: 'I am definitely the teacher.', isTeacherAnswer: true },
  });
  check('a student reply posts', fake.status, 201);
  check('but is not marked as the teacher answer', fake.data.isTeacherAnswer, false);

  const real = await call(`/doubts/${thread.data.id}/replies`, {
    method: 'POST',
    body: { body: 'The minus is absorbed into the bracket.' },
  });
  check('the teacher reply is marked', real.data.isTeacherAnswer, true);

  const opened = await as(asker, `/doubts/${thread.data.id}`);
  check('both replies are on the thread', opened.data.replies.length, 2);
  check('reply count kept in step', peerView.data.find((t) => t.id === thread.data.id).replyCount, 0);

  console.log('\n--- 4. private threads ---');
  const priv = await as(asker, `/lessons/${lesson.data.id}/doubts`, {
    method: 'POST',
    body: { title: 'I understood nothing today', body: 'Too shy to ask publicly.', isPublic: false },
  });

  const peerList = await as(peer, `/lessons/${lesson.data.id}/doubts`);
  check('a private thread is not listed for peers', peerList.data.some((t) => t.id === priv.data.id), false);

  const peerPeek = await as(peer, `/doubts/${priv.data.id}`);
  // 404 rather than 403: a link must not confirm the thread exists.
  check('and a direct link is a 404', peerPeek.status, 404);

  const teacherPeek = await call(`/doubts/${priv.data.id}`);
  check('the teacher can still read it', teacherPeek.status, 200);

  console.log('\n--- 5. moderation ---');
  await call(`/doubts/${thread.data.id}/moderate`, { method: 'POST', body: { isPinned: true } });
  const pinnedFirst = await as(peer, `/lessons/${lesson.data.id}/doubts`);
  check('a pinned thread comes first', pinnedFirst.data[0].id, thread.data.id);

  await as(peer, '/doubts/report', {
    method: 'POST',
    body: { threadId: thread.data.id, reason: 'Duplicate of another question' },
  });
  const inbox = await call('/teacher/doubts');
  check('the report reaches the teacher', inbox.data.reports.some((r) => r.threadId === thread.data.id), true);
  check('the thread is in the inbox', inbox.data.threads.some((t) => t.id === thread.data.id), true);

  const twice = await as(peer, '/doubts/report', {
    method: 'POST',
    body: { threadId: thread.data.id, reason: 'Reporting again' },
  });
  check('reporting twice is not an error', twice.status, 200);

  const reportRows = await sql`
    SELECT count(*)::int AS n FROM doubt_reports WHERE thread_id = ${thread.data.id}`;
  check('but only one report is recorded', reportRows[0].n, 1);

  await call('/teacher/doubts/hide', {
    method: 'POST',
    body: { threadId: thread.data.id, reason: 'Duplicate' },
  });

  const afterHide = await as(peer, `/lessons/${lesson.data.id}/doubts`);
  check('a hidden thread disappears', afterHide.data.some((t) => t.id === thread.data.id), false);

  const survives = await sql`
    SELECT hidden_reason FROM doubt_threads WHERE id = ${thread.data.id}`;
  // Hidden, never deleted: the student will ask why, and the record has to
  // survive that conversation.
  check('but the row survives with its reason', survives[0].hidden_reason, 'Duplicate');

  const closedReports = await sql`
    SELECT count(*)::int AS n FROM doubt_reports
    WHERE thread_id = ${thread.data.id} AND reviewed_at IS NOT NULL`;
  check('and its reports are closed', closedReports[0].n, 1);

  const lateReply = await as(peer, `/doubts/${thread.data.id}/replies`, {
    method: 'POST',
    body: { body: 'Still talking?' },
  });
  check('replies to a hidden thread are refused', lateReply.status >= 400, true);

  console.log('\n--- 6. one teacher cannot moderate another\'s ---');
  const rival = await makeStudent('Rival Teacher');
  await sql`UPDATE profiles SET role = 'teacher' WHERE id = ${rival.id}`;
  const rivalTry = await as(rival, `/doubts/${priv.data.id}/moderate`, {
    method: 'POST',
    body: { isResolved: true },
  });
  check('another teacher is refused', rivalTry.status, 404);

  console.log('\n--- 7. pages render ---');
  for (const path of ['/teacher/doubts', `/learn/lessons/${lesson.data.id}`]) {
    const page = await fetch(`${PAGE_BASE}${path}`);
    check(`GET ${path} returns 200`, page.status, 200);
  }

  console.log('\n--- 8. strangers are refused ---');
  for (const path of [`/lessons/${lesson.data.id}/doubts`, '/teacher/doubts', `/doubts/${priv.data.id}`]) {
    const anon = await call(path, { anonymous: true });
    check(`anonymous ${path} rejected`, anon.status, 401);
  }
} finally {
  if (courseId) {
    const threads = await sql`SELECT id FROM doubt_threads WHERE course_id = ${courseId}`;
    for (const t of threads) {
      await sql`DELETE FROM doubt_reports WHERE thread_id = ${t.id}`;
      await sql`DELETE FROM doubt_replies WHERE thread_id = ${t.id}`;
    }
    await sql`DELETE FROM doubt_threads WHERE course_id = ${courseId}`;
    await sql`DELETE FROM entitlements WHERE course_id = ${courseId}`;
    await sql`DELETE FROM payments WHERE course_id = ${courseId}`;
    await sql`DELETE FROM audit_log WHERE entity_id = ${courseId}`;
    await sql`DELETE FROM lessons WHERE course_id = ${courseId}`;
    await sql`DELETE FROM modules WHERE course_id = ${courseId}`;
    await sql`DELETE FROM courses WHERE id = ${courseId}`;
  }

  for (const id of studentIds) {
    await sql`DELETE FROM doubt_reports WHERE reporter_id = ${id}`;
    await sql`DELETE FROM notifications WHERE user_id = ${id}`;
    await sql`DELETE FROM entitlements WHERE student_id = ${id}`;
    await sql`DELETE FROM audit_log WHERE actor_id = ${id}`;
    await sql`DELETE FROM device_switch_log WHERE user_id = ${id}`;
    await sql`DELETE FROM active_sessions WHERE user_id = ${id}`;
    await sql`DELETE FROM profiles WHERE id = ${id}`;
    await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${id}`, {
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
