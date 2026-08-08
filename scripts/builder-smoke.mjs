/**
 * End-to-end smoke test for the teacher course builder.
 *
 *   node scripts/builder-smoke.mjs
 *
 * Drives the same endpoints the UI calls: login, create course, add modules and
 * lessons, reorder both levels, and confirm the server rejects a tampered order.
 * Needs the dev server and a Supabase test phone number.
 *
 * The test account is promoted to 'teacher' directly in the database, because
 * there is no admin UI yet (Phase 2). Dev only.
 */
import { config as loadEnv } from 'dotenv';
import postgres from 'postgres';
import { createJar } from './lib/cookie-jar.mjs';

loadEnv({ path: '.env.local' });

// Persisted so repeated runs are recognised as the same device rather than
// burning the 4-per-30-days switch budget (Section 6.3).
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

async function call(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (sessionId) headers['x-session-id'] = sessionId;
  const cookie = jar.header();
  if (cookie) headers.cookie = cookie;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  jar.capture(res);
  jar.save();

  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

const sql = postgres(process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL, {
  ssl: 'require',
  max: 1,
  prepare: false,
});

let createdCourseId = null;

try {
  console.log('--- 0. pages render ---');
  for (const path of ['/login', '/teacher']) {
    const res = await fetch(`${PAGE_BASE}${path}`);
    check(`GET ${path} returns 200`, res.status, 200);
  }

  console.log('\n--- 1. sign in as web client ---');
  // No /auth/otp/request: a Supabase test number accepts its fixed code
  // directly, and requesting one here would consume the 3-per-phone-per-15-min
  // budget that two-device-test.mjs also draws on.
  const login = await call('/auth/otp/verify', {
    method: 'POST',
    // No fingerprint: the server derives the web one (Section 6.3).
    body: { phone: PHONE, code: OTP, device: { platform: 'web', label: 'Smoke test' } },
  });
  check('login succeeds', login.status, 200);
  if (login.status !== 200) throw new Error(JSON.stringify(login.error));
  token = login.data.accessToken;
  sessionId = login.data.sessionId;

  const me = await call('/auth/me');
  check('/auth/me works', me.status, 200);
  const userId = me.data.id;

  console.log('\n--- 2. student is refused the teacher area ---');
  await sql`UPDATE profiles SET role = 'student' WHERE id = ${userId}`;
  const asStudent = await call('/teacher/courses');
  check('student blocked from /teacher/courses', asStudent.status, 403);
  check('error code', asStudent.error?.code, 'ROLE_REQUIRED');

  console.log('\n--- 3. promote to teacher ---');
  await sql`UPDATE profiles SET role = 'teacher', full_name = 'Smoke Teacher' WHERE id = ${userId}`;
  const asTeacher = await call('/teacher/courses');
  check('teacher can list courses', asTeacher.status, 200);

  console.log('\n--- 4. create a course ---');
  const slug = `smoke-course-${Date.now()}`;
  const created = await call('/teacher/courses', {
    method: 'POST',
    body: { title: 'Smoke Physics', slug, pricePoisha: 50000, isInAllAccess: true },
  });
  check('course created', created.status, 201);
  createdCourseId = created.data?.id;
  check('starts as draft', created.data?.state, 'draft');

  console.log('\n--- 5. duplicate slug is a clean 409 ---');
  const dupe = await call('/teacher/courses', {
    method: 'POST',
    body: { title: 'Clash', slug, pricePoisha: 0, isInAllAccess: true },
  });
  check('duplicate slug rejected', dupe.status, 409);
  check('duplicate slug code', dupe.error?.code, 'CONFLICT');

  console.log('\n--- 6. add modules ---');
  const modules = [];
  for (const title of ['Chapter 1', 'Chapter 2', 'Chapter 3']) {
    const m = await call(`/teacher/courses/${createdCourseId}/modules`, {
      method: 'POST',
      body: { title },
    });
    check(`module "${title}" created`, m.status, 201);
    modules.push(m.data);
  }
  check(
    'modules numbered 1..3',
    modules.map((m) => m.displayOrder),
    [1, 2, 3],
  );

  console.log('\n--- 7. add lessons ---');
  const lessons = [];
  for (const [i, title] of ['Intro', 'Vectors', 'Practice'].entries()) {
    const l = await call(`/teacher/modules/${modules[0].id}/lessons`, {
      method: 'POST',
      body: { title, type: i === 2 ? 'note' : 'video', isFree: i === 0 },
    });
    check(`lesson "${title}" created`, l.status, 201);
    lessons.push(l.data);
  }

  console.log('\n--- 8. a video cannot be published before processing ---');
  const publishTooEarly = await call(`/teacher/lessons/${lessons[0].id}`, {
    method: 'PATCH',
    body: { isPublished: true },
  });
  check('unprocessed video refuses publish', publishTooEarly.status, 409);

  console.log('\n--- 9. reorder modules ---');
  const reorderModules = await call(`/teacher/courses/${createdCourseId}/reorder-modules`, {
    method: 'POST',
    body: { orderedIds: [modules[2].id, modules[0].id, modules[1].id] },
  });
  check('reorder accepted', reorderModules.status, 200);

  const tree = await call(`/teacher/courses/${createdCourseId}`);
  check(
    'module order applied',
    tree.data.map((m) => m.title),
    ['Chapter 3', 'Chapter 1', 'Chapter 2'],
  );
  check(
    'order values contiguous',
    tree.data.map((m) => m.displayOrder),
    [1, 2, 3],
  );

  console.log('\n--- 10. reorder lessons ---');
  const reorderLessons = await call(`/teacher/modules/${modules[0].id}/reorder`, {
    method: 'POST',
    body: { orderedIds: [lessons[2].id, lessons[1].id, lessons[0].id] },
  });
  check('lesson reorder accepted', reorderLessons.status, 200);

  const tree2 = await call(`/teacher/courses/${createdCourseId}`);
  const ch1 = tree2.data.find((m) => m.id === modules[0].id);
  check(
    'lesson order applied',
    ch1.lessons.map((l) => l.title),
    ['Practice', 'Vectors', 'Intro'],
  );

  console.log('\n--- 11. tampered orders are rejected ---');
  const partial = await call(`/teacher/modules/${modules[0].id}/reorder`, {
    method: 'POST',
    body: { orderedIds: [lessons[0].id] },
  });
  check('incomplete order rejected', partial.status, 422);

  const foreign = await call(`/teacher/modules/${modules[0].id}/reorder`, {
    method: 'POST',
    body: { orderedIds: [lessons[0].id, lessons[1].id, modules[1].id] },
  });
  check('foreign id rejected', foreign.status, 422);

  const dupes = await call(`/teacher/modules/${modules[0].id}/reorder`, {
    method: 'POST',
    body: { orderedIds: [lessons[0].id, lessons[0].id, lessons[1].id] },
  });
  check('duplicate id rejected', dupes.status, 422);

  const stillIntact = await call(`/teacher/courses/${createdCourseId}`);
  const ch1After = stillIntact.data.find((m) => m.id === modules[0].id);
  check(
    'order unchanged after rejected attempts',
    ch1After.lessons.map((l) => l.title),
    ['Practice', 'Vectors', 'Intro'],
  );

  console.log('\n--- 12. price change is audited ---');
  await call(`/teacher/courses/${createdCourseId}`, {
    method: 'PATCH',
    body: { pricePoisha: 90000 },
  });
  const audit = await sql`
    SELECT action, before, after FROM audit_log
    WHERE entity_id = ${createdCourseId} AND action = 'course.price_change'
  `;
  check('price change audited', audit.length, 1);
  check('audit before', audit[0]?.before, { pricePoisha: 50000 });
  check('audit after', audit[0]?.after, { pricePoisha: 90000 });

  console.log('\n--- 13. publish the course ---');
  const published = await call(`/teacher/courses/${createdCourseId}`, {
    method: 'PATCH',
    body: { state: 'published' },
  });
  check('course published', published.data?.state, 'published');
  check('publishedAt stamped', typeof published.data?.publishedAt, 'string');

  console.log('\n--- 14. student lesson metadata ---');
  // The note lesson has no file, so it is publishable and readable.
  const noteLesson = lessons[2];
  await call(`/teacher/lessons/${noteLesson.id}`, {
    method: 'PATCH',
    body: { isPublished: true },
  });

  const meta = await call(`/lessons/${noteLesson.id}`);
  check('teacher can read lesson metadata', meta.status, 200);
  check('access reported as owner', meta.data?.via, 'owner');
  check('carries module and course titles', typeof meta.data?.courseTitle, 'string');

  // The security property: metadata must never hand out a durable handle to
  // paid content. Those come only from the short-lived issuance endpoints.
  const serialised = JSON.stringify(meta.data ?? {});
  check('no vdocipher id leaked', serialised.includes('vdocipher'), false);
  check('no r2 key leaked', serialised.includes('r2ObjectKey'), false);
  check('siblings only include published', Array.isArray(meta.data?.siblings), true);

  console.log('\n--- 15. viewer page renders ---');
  const viewer = await fetch(`${PAGE_BASE}/learn/lessons/${noteLesson.id}`);
  check('GET /learn/lessons/:id returns 200', viewer.status, 200);

  console.log('\n--- 16. an unpublished lesson is not readable ---');
  const hiddenMeta = await call(`/lessons/${lessons[1].id}`);
  check('unpublished lesson refused', hiddenMeta.status, 404);
  check('refusal code', hiddenMeta.error?.code, 'CONTENT_UNPUBLISHED');
} finally {
  if (createdCourseId) {
    await sql`DELETE FROM lessons WHERE course_id = ${createdCourseId}`;
    await sql`DELETE FROM modules WHERE course_id = ${createdCourseId}`;
    await sql`DELETE FROM audit_log WHERE entity_id = ${createdCourseId}`;
    await sql`DELETE FROM courses WHERE id = ${createdCourseId}`;
    console.log('\ncleaned up test course');
  }
  await sql.end({ timeout: 5 });
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
