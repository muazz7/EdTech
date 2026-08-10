/**
 * End-to-end smoke test for plans and promo codes (Phase 5).
 *
 *   node scripts/commerce-smoke.mjs
 *
 * The assertions that matter are the boundaries: a teacher cannot reach the
 * owner console, a teacher's promo code cannot touch another teacher's course
 * or a platform-wide plan, and a limited code cannot be oversold.
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

/** Distinctive so the cleanup can remove exactly this row and nothing else. */
const SMOKE_ACCOUNT_NUMBER = '01799887766';

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
    // Non-JSON: keep the raw text so a 500 page shows up in the failure.
  }
  return { status: res.status, raw: text, ...json };
}

const sql = postgres(process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL, {
  ssl: 'require',
  max: 1,
  prepare: false,
});

let courseId = null;
let planId = null;
const studentIds = [];
const promoIds = [];

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
  const auth = await createStudentSession(sql, user.id);
  return { id: user.id, auth };
}

try {
  console.log('--- 1. teacher sets up a paid course ---');
  const login = await call('/auth/otp/verify', {
    method: 'POST',
    body: { phone: PHONE, code: OTP, device: { platform: 'web', label: 'Commerce smoke' } },
  });
  check('login succeeds', login.status, 200);
  if (login.status !== 200) throw new Error(JSON.stringify(login.error ?? login.raw));
  token = login.data.accessToken;
  sessionId = login.data.sessionId;

  const me = await call('/auth/me');
  const teacherId = me.data.id;
  await sql`UPDATE profiles SET role = 'teacher', full_name = 'Commerce Smoke Teacher'
            WHERE id = ${teacherId}`;

  const stamp = Date.now();
  const course = await call('/teacher/courses', {
    method: 'POST',
    body: {
      title: 'Commerce Smoke Course',
      slug: `commerce-smoke-${stamp}`,
      pricePoisha: 100_000,
      isInAllAccess: true,
    },
  });
  courseId = course.data.id;
  await call(`/teacher/courses/${courseId}`, { method: 'PATCH', body: { state: 'published' } });

  // A payment intent refuses to mint a reference code for a teacher with no
  // number to send money to. Removed again in the cleanup below: the shared
  // test teacher is used by payments-smoke, which asserts on exactly which
  // numbers a student is shown.
  await call('/teacher/payment-methods', {
    method: 'POST',
    body: { channel: 'bkash', accountNumber: SMOKE_ACCOUNT_NUMBER },
  });

  console.log('\n--- 2. the owner console is closed to a teacher ---');
  const teacherPeek = await call('/admin/plans');
  check('teacher refused the owner console', teacherPeek.status, 403);
  check('with a role error', teacherPeek.error?.code, 'ROLE_REQUIRED');

  const anonPeek = await call('/admin/plans', { anonymous: true });
  check('anonymous refused too', anonPeek.status, 401);

  console.log('\n--- 3. teacher issues a promo code ---');
  const promo = await call('/teacher/promo-codes', {
    method: 'POST',
    body: { courseId, discountPercent: 25, maxRedemptions: 2 },
  });
  check('code created', promo.status, 201);
  promoIds.push(promo.data.id);
  check('code avoids look-alike characters', /^[A-HJ-NP-Z2-9]{8}$/.test(promo.data.code), true);

  const listed = await call('/teacher/promo-codes');
  check('it appears in the teacher list', listed.data.some((r) => r.id === promo.data.id), true);
  check('with a usage count', listed.data.find((r) => r.id === promo.data.id).used, 0);

  console.log('\n--- 4. a student redeems it ---');
  const alice = await makeStudent('Alice Commerce');

  async function asStudent(student, path, init = {}) {
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

  const priced = await asStudent(alice, '/promo/validate', {
    method: 'POST',
    body: { code: promo.data.code, courseId },
  });
  check('validation prices the code', priced.status, 200);
  check('25% off 1000 BDT', priced.data.discountPoisha, 25_000);
  check('leaving 750 BDT', priced.data.finalPoisha, 75_000);

  const intent = await asStudent(alice, '/payments/intent', {
    method: 'POST',
    body: { courseId, promoCode: promo.data.code },
  });
  check('the intent carries the discount', intent.data.discountPoisha, 25_000);
  check('and the reduced amount', intent.data.amountPoisha, 75_000);
  check('nothing is settled yet', intent.data.settled, false);

  const reused = await asStudent(alice, '/promo/validate', {
    method: 'POST',
    body: { code: promo.data.code, courseId },
  });
  check('the same student cannot use it twice', reused.status, 409);

  console.log('\n--- 5. the quantity holds ---');
  const bob = await makeStudent('Bob Commerce');
  await asStudent(bob, '/payments/intent', {
    method: 'POST',
    body: { courseId, promoCode: promo.data.code },
  });

  const carol = await makeStudent('Carol Commerce');
  const overflow = await asStudent(carol, '/payments/intent', {
    method: 'POST',
    body: { courseId, promoCode: promo.data.code },
  });
  // Two pending payments already hold both slots — a limited code must not be
  // oversold while proofs are being checked.
  check('the third student is refused', overflow.status >= 400, true);

  console.log('\n--- 6. a code cannot cross to another teacher or a plan ---');
  const otherTeacher = await makeStudent('Rival Teacher');
  await sql`UPDATE profiles SET role = 'teacher' WHERE id = ${otherTeacher.id}`;
  const rivalCourse = await sql`
    INSERT INTO courses (id, slug, title, teacher_id, price_poisha, state, published_at)
    VALUES (gen_random_uuid(), ${`rival-${stamp}`}, 'Rival Course', ${otherTeacher.id},
            100000, 'published', now())
    RETURNING id`;

  const dave = await makeStudent('Dave Commerce');
  const crossed = await asStudent(dave, '/promo/validate', {
    method: 'POST',
    body: { code: promo.data.code, courseId: rivalCourse[0].id },
  });
  check("one teacher's code cannot discount another's course", crossed.status, 422);

  console.log('\n--- 7. the owner creates a plan ---');
  await sql`UPDATE profiles SET role = 'admin' WHERE id = ${teacherId}`;

  const plan = await call('/admin/plans', {
    method: 'POST',
    body: {
      kind: 'subscription',
      name: 'Smoke Monthly',
      pricePoisha: 60_000,
      durationDays: 30,
      displayOrder: 0,
    },
  });
  check('plan created', plan.status, 201);
  planId = plan.data.id;
  check('created off sale', plan.data.isActive, false);

  const publicBefore = await call('/plans', { anonymous: true });
  check('an off-sale plan is not public', publicBefore.data.some((p) => p.id === planId), false);

  await call(`/admin/plans/${planId}`, { method: 'PATCH', body: { isActive: true } });
  const publicAfter = await call('/plans', { anonymous: true });
  check('once on sale it is public', publicAfter.data.some((p) => p.id === planId), true);

  const planIntent = await asStudent(dave, '/payments/intent', {
    method: 'POST',
    body: { planId },
  });
  check('a student can start a plan purchase', planIntent.status, 200);
  check('at the plan price', planIntent.data.amountPoisha, 60_000);

  const promoOnPlan = await asStudent(alice, '/payments/intent', {
    method: 'POST',
    body: { planId, promoCode: promo.data.code },
  });
  check('a promo code is refused on a plan', promoOnPlan.status, 422);

  console.log('\n--- 8. a full-price code settles without a payment ---');
  const freeCode = await call('/teacher/promo-codes', {
    method: 'POST',
    body: { courseId, discountPercent: 100, maxRedemptions: 1 },
  });
  promoIds.push(freeCode.data.id);

  const erin = await makeStudent('Erin Commerce');
  const settled = await asStudent(erin, '/payments/intent', {
    method: 'POST',
    body: { courseId, promoCode: freeCode.data.code },
  });
  check('nothing to pay', settled.data.amountPoisha, 0);
  check('and it is settled on the spot', settled.data.settled, true);

  const access = await sql`
    SELECT source FROM entitlements WHERE student_id = ${erin.id} AND course_id = ${courseId}`;
  check('access granted immediately', access.length, 1);
  check('recorded as a promo', access[0].source, 'promo');

  console.log('\n--- 9. pages render ---');
  for (const path of ['/plans', '/admin/plans', '/teacher/promo-codes', `/purchase/plan?planId=${planId}`]) {
    const page = await fetch(`${PAGE_BASE}${path}`);
    check(`GET ${path} returns 200`, page.status, 200);
  }
} finally {
  for (const id of promoIds) {
    await sql`DELETE FROM entitlements WHERE payment_id IN (
                SELECT id FROM payments WHERE promo_code_id = ${id})`;
    await sql`DELETE FROM payments WHERE promo_code_id = ${id}`;
    await sql`DELETE FROM promo_codes WHERE id = ${id}`;
  }

  if (planId) {
    await sql`DELETE FROM entitlements WHERE plan_id = ${planId}`;
    await sql`DELETE FROM payments WHERE plan_id = ${planId}`;
    await sql`DELETE FROM plans WHERE id = ${planId}`;
  }

  if (courseId) {
    await sql`DELETE FROM entitlements WHERE course_id = ${courseId}`;
    await sql`DELETE FROM payments WHERE course_id = ${courseId}`;
    await sql`DELETE FROM audit_log WHERE entity_id = ${courseId}`;
    await sql`DELETE FROM courses WHERE id = ${courseId}`;
  }

  for (const id of studentIds) {
    await sql`DELETE FROM promo_codes WHERE teacher_id = ${id}`;
    await sql`DELETE FROM courses WHERE teacher_id = ${id}`;
    await sql`DELETE FROM entitlements WHERE student_id = ${id}`;
    await sql`DELETE FROM payments WHERE student_id = ${id}`;
    await sql`DELETE FROM payment_methods WHERE owner_id = ${id}`;
    await sql`DELETE FROM notifications WHERE user_id = ${id}`;
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

  // The shared test teacher is used by the other suites, so everything this
  // script did to that account is undone: the role promotion above, and the
  // payment number, which payments-smoke asserts on exactly.
  await sql`UPDATE profiles SET role = 'teacher' WHERE phone = ${`+${PHONE}`}`;
  await sql`DELETE FROM payment_methods WHERE account_number = ${SMOKE_ACCOUNT_NUMBER}`;

  await sql.end();
  console.log('\ncleaned up');
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
