/**
 * End-to-end smoke test for the public catalog and student progress (Phase 3).
 *
 *   node scripts/catalog-smoke.mjs
 *
 * The catalog is the first API that answers to strangers, so the important
 * assertions here are negative: a draft course must be invisible, an
 * unpublished lesson must not appear, and a paid lesson's runtime must not be
 * readable without paying.
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
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

const sql = postgres(process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL, {
  ssl: 'require',
  max: 1,
  prepare: false,
});

let publishedId = null;
let draftId = null;
let studentId = null;

try {
  console.log('--- 0. pages render ---');
  for (const path of ['/', '/free', '/my-courses', '/account', '/account/notifications']) {
    const res = await fetch(`${PAGE_BASE}${path}`);
    check(`GET ${path} returns 200`, res.status, 200);
  }

  console.log('\n--- 1. teacher publishes a course ---');
  const login = await call('/auth/otp/verify', {
    method: 'POST',
    body: { phone: PHONE, code: OTP, device: { platform: 'web', label: 'Catalog smoke' } },
  });
  check('login succeeds', login.status, 200);
  if (login.status !== 200) throw new Error(JSON.stringify(login.error));
  token = login.data.accessToken;
  sessionId = login.data.sessionId;

  const me = await call('/auth/me');
  const teacherId = me.data.id;
  await sql`UPDATE profiles SET role = 'teacher', full_name = 'Catalog Smoke Teacher'
            WHERE id = ${teacherId}`;

  const stamp = Date.now();
  const published = await call('/teacher/courses', {
    method: 'POST',
    body: {
      title: 'Catalog Smoke Physics',
      slug: `catalog-smoke-${stamp}`,
      pricePoisha: 60_000,
      isInAllAccess: true,
      level: 'HSC',
      subject: 'Physics',
    },
  });
  publishedId = published.data.id;

  const draft = await call('/teacher/courses', {
    method: 'POST',
    body: { title: 'Secret Draft', slug: `catalog-draft-${stamp}`, pricePoisha: 1000 },
  });
  draftId = draft.data.id;

  const mod = await call(`/teacher/courses/${publishedId}/modules`, {
    method: 'POST',
    body: { title: 'Chapter 1' },
  });

  const freeLesson = await call(`/teacher/modules/${mod.data.id}/lessons`, {
    method: 'POST',
    body: { title: 'Free intro', type: 'note', isFree: true },
  });
  const paidLesson = await call(`/teacher/modules/${mod.data.id}/lessons`, {
    method: 'POST',
    body: { title: 'Paid lecture', type: 'note', isFree: false },
  });
  const hiddenLesson = await call(`/teacher/modules/${mod.data.id}/lessons`, {
    method: 'POST',
    body: { title: 'Not finished yet', type: 'note', isFree: false },
  });

  for (const id of [freeLesson.data.id, paidLesson.data.id]) {
    await call(`/teacher/lessons/${id}`, { method: 'PATCH', body: { isPublished: true } });
  }
  // hiddenLesson stays unpublished on purpose.
  await sql`UPDATE lessons SET duration_seconds = 600 WHERE id = ${paidLesson.data.id}`;
  await call(`/teacher/courses/${publishedId}`, { method: 'PATCH', body: { state: 'published' } });

  console.log('\n--- 2. the catalog answers strangers ---');
  const catalog = await call('/courses', { anonymous: true });
  check('catalog loads without a session', catalog.status, 200);

  const ids = catalog.data.courses.map((c) => c.id);
  check('published course is listed', ids.includes(publishedId), true);
  check('draft course is NOT listed', ids.includes(draftId), false);

  const listed = catalog.data.courses.find((c) => c.id === publishedId);
  check('counts only published lessons', listed?.lessonCount, 2);
  check('reports the free lesson count', listed?.freeLessonCount, 1);
  check('facets include the level', catalog.data.facets.levels.includes('HSC'), true);

  console.log('\n--- 3. a draft course is a 404, not a hint ---');
  const draftDetail = await call(`/courses/catalog-draft-${stamp}`, { anonymous: true });
  check('draft detail is 404', draftDetail.status, 404);
  const missing = await call('/courses/no-such-course-anywhere', { anonymous: true });
  check('missing detail is also 404', missing.status, 404);

  console.log('\n--- 4. curriculum lock flags, signed out ---');
  const anon = await call(`/courses/catalog-smoke-${stamp}/curriculum`, { anonymous: true });
  check('curriculum loads for a stranger', anon.status, 200);
  check('not entitled', anon.data.entitled, false);

  const anonLessons = anon.data.modules.flatMap((m) => m.lessons);
  check('unpublished lesson is absent', anonLessons.length, 2);
  const anonPaid = anonLessons.find((l) => l.id === paidLesson.data.id);
  const anonFree = anonLessons.find((l) => l.id === freeLesson.data.id);
  check('paid lesson locked', anonPaid?.locked, true);
  // Titles are public on purpose: the curriculum is the sales pitch.
  check('paid lesson title still shown', anonPaid?.title, 'Paid lecture');
  // Runtime is not.
  check('paid lesson duration hidden', anonPaid?.durationSeconds, null);
  check('free lesson unlocked', anonFree?.locked, false);

  console.log('\n--- 5. free resource centre ---');
  const free = await call('/free-resources', { anonymous: true });
  const freeIds = free.data.map((r) => r.lessonId);
  check('free lesson listed', freeIds.includes(freeLesson.data.id), true);
  check('paid lesson NOT listed', freeIds.includes(paidLesson.data.id), false);
  check('unpublished lesson NOT listed', freeIds.includes(hiddenLesson.data.id), false);

  console.log('\n--- 6. an entitled student sees it unlocked ---');
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
  await sql`INSERT INTO profiles (id, full_name, role) VALUES (${studentId}, 'Catalog Student', 'student')`;
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

  const beforeBuy = await asStudent(`/courses/catalog-smoke-${stamp}/curriculum`);
  check('signed-in but unentitled is still locked', beforeBuy.data.entitled, false);

  await call('/teacher/access', {
    method: 'POST',
    body: { studentId, courseId: publishedId, note: 'Catalog smoke' },
  });

  const afterBuy = await asStudent(`/courses/catalog-smoke-${stamp}/curriculum`);
  check('entitled after the grant', afterBuy.data.entitled, true);
  const boughtPaid = afterBuy.data.modules
    .flatMap((m) => m.lessons)
    .find((l) => l.id === paidLesson.data.id);
  check('paid lesson unlocked', boughtPaid?.locked, false);
  check('duration now visible', boughtPaid?.durationSeconds, 600);

  console.log('\n--- 7. my courses and progress ---');
  const mine = await asStudent('/me/courses');
  check('course appears in my courses', mine.data.courses.some((c) => c.id === publishedId), true);
  check('progress starts at zero', mine.data.courses.find((c) => c.id === publishedId)?.percent, 0);

  const firstBeat = await asStudent(`/lessons/${paidLesson.data.id}/progress`, {
    method: 'POST',
    body: { position: 30, events: [{ event: 'heartbeat', position: 30 }] },
  });
  check('progress recorded', firstBeat.status, 200);
  check('resume position stored', firstBeat.data.lastPosition, 30);

  // An impossible jump immediately after: seconds of wall clock, minutes of
  // claimed playback.
  const jump = await asStudent(`/lessons/${paidLesson.data.id}/progress`, {
    method: 'POST',
    body: { position: 590 },
  });
  check('impossible jump discarded', jump.data.discarded, 1);
  // The property that matters: the seek earns no watch credit. Completion is
  // NOT asserted here because this is a `note` lesson, and Section 14 completes
  // documents on dwell rather than on watched duration — the 90% video rule is
  // covered by the unit tests, where the lesson type can be set freely.
  check('seeking earns no watch credit', jump.data.secondsWatched, firstBeat.data.secondsWatched);
  // The resume position still moves: seeking forward is legitimate.
  check('resume position still follows the seek', jump.data.lastPosition, 590);

  const courseProgress = await asStudent(`/me/progress/${publishedId}`);
  check('progress endpoint works', courseProgress.status, 200);
  check('resume points at the watched lesson', courseProgress.data.resume?.lessonId, paidLesson.data.id);

  // The same trick on a lesson with no stored row at all. A first report has no
  // earlier timestamp to measure against, so if it were credited at face value
  // one request would complete any lesson. Run last: it moves the resume point
  // to this lesson.
  const openAndSeek = await asStudent(`/lessons/${freeLesson.data.id}/progress`, {
    method: 'POST',
    body: { position: 590 },
  });
  check('first-ever report cannot claim the whole lesson', openAndSeek.data.discarded, 1);
  check('first-ever seek earns no credit', openAndSeek.data.secondsWatched, 0);
  check('first-ever seek does not complete', openAndSeek.data.isComplete, false);

  console.log('\n--- 8. account screen data ---');
  const account = await asStudent('/me/account');
  check('account endpoint works', account.status, 200);
  check('reports the live session', account.data.session?.isCurrent, true);
  check('device budget has a limit', typeof account.data.devices?.limit === 'number', true);
  // Fingerprints are internal hashes. Returning one tells anyone probing the
  // account exactly which value to replay.
  check(
    'no device fingerprint leaked',
    JSON.stringify(account.data).toLowerCase().includes('fingerprint'),
    false,
  );

  const inbox = await asStudent('/me/notifications');
  check('notifications endpoint works', inbox.status, 200);
  check('unread count present', typeof inbox.data.unread === 'number', true);

  const ents = await asStudent('/me/entitlements');
  check('entitlements listed', ents.data.length >= 1, true);
  check('entitlement names the course', ents.data[0].courseTitle, 'Catalog Smoke Physics');

  console.log('\n--- 9. private endpoints refuse strangers ---');
  for (const path of ['/me/account', '/me/notifications', '/me/entitlements']) {
    const anon = await call(path, { anonymous: true });
    check(`anonymous ${path} rejected`, anon.status, 401);
  }

  console.log('\n--- 10. progress is refused without a session ---');
  const noAccess = await call(`/lessons/${paidLesson.data.id}/progress`, {
    method: 'POST',
    body: { position: 10 },
    anonymous: true,
  });
  check('anonymous progress rejected', noAccess.status, 401);
} finally {
  for (const id of [publishedId, draftId].filter(Boolean)) {
    await sql`DELETE FROM lesson_progress WHERE course_id = ${id}`;
    await sql`DELETE FROM watch_events WHERE lesson_id IN (SELECT id FROM lessons WHERE course_id = ${id})`;
    await sql`DELETE FROM entitlements WHERE course_id = ${id}`;
    await sql`DELETE FROM payments WHERE course_id = ${id}`;
    await sql`DELETE FROM audit_log WHERE entity_id = ${id}`;
    await sql`DELETE FROM lessons WHERE course_id = ${id}`;
    await sql`DELETE FROM modules WHERE course_id = ${id}`;
    await sql`DELETE FROM courses WHERE id = ${id}`;
  }
  if (studentId) {
    await sql`DELETE FROM lesson_progress WHERE student_id = ${studentId}`;
    await sql`DELETE FROM watch_events WHERE student_id = ${studentId}`;
    await sql`DELETE FROM entitlements WHERE student_id = ${studentId}`;
    await sql`DELETE FROM notifications WHERE user_id = ${studentId}`;
    await sql`DELETE FROM device_switch_log WHERE user_id = ${studentId}`;
    await sql`DELETE FROM active_sessions WHERE user_id = ${studentId}`;
    await sql`DELETE FROM profiles WHERE id = ${studentId}`;
    await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${studentId}`, {
      method: 'DELETE',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }).catch(() => undefined);
  }
  console.log('\ncleaned up');
  await sql.end({ timeout: 5 });
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
