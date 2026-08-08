/**
 * End-to-end smoke test for teacher payment settings and the verification
 * queue.
 *
 *   node scripts/payments-smoke.mjs
 *
 * Covers the whole loop over HTTP: the teacher publishes a receiving number and
 * a course, the student creates an intent and submits proof, the teacher
 * approves, and the student gains access.
 *
 * The student's session is minted directly (scripts/lib/student-session.mjs)
 * because only one Supabase test phone number exists and the teacher holds it.
 * Everything after authentication is real; the auth path itself is covered by
 * two-device-test.mjs.
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

/** Seeds a student through the Supabase Admin API, as the test fixtures do. */
async function seedStudent(name) {
  const phone = `+88017${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ phone, phone_confirm: true }),
  });
  if (!res.ok) throw new Error(`seedStudent failed: ${await res.text()}`);
  const { id } = await res.json();
  await sql`INSERT INTO profiles (id, full_name, phone, role)
            VALUES (${id}, ${name}, ${phone}, 'student')`;
  return { id, phone };
}

let courseId = null;
let studentId = null;
let methodId = null;

try {
  console.log('--- 0. pages render ---');
  for (const path of ['/teacher/payments', '/teacher/payment-methods', '/account/payments']) {
    const res = await fetch(`${PAGE_BASE}${path}`);
    check(`GET ${path} returns 200`, res.status, 200);
  }

  console.log('\n--- 1. sign in and become a teacher ---');
  const login = await call('/auth/otp/verify', {
    method: 'POST',
    body: { phone: PHONE, code: OTP, device: { platform: 'web', label: 'Payments smoke' } },
  });
  check('login succeeds', login.status, 200);
  if (login.status !== 200) throw new Error(JSON.stringify(login.error));
  token = login.data.accessToken;
  sessionId = login.data.sessionId;

  const me = await call('/auth/me');
  const teacherId = me.data.id;
  await sql`UPDATE profiles SET role = 'teacher', full_name = 'Payments Smoke Teacher'
            WHERE id = ${teacherId}`;

  console.log('\n--- 2. add a receiving number ---');
  const created = await call('/teacher/payment-methods', {
    method: 'POST',
    body: { channel: 'bkash', accountNumber: '+8801711223344', accountType: 'Personal' },
  });
  check('payment method created', created.status, 201);
  // Normalised to the local form a wallet app expects.
  check('number normalised', created.data?.accountNumber, '01711223344');
  methodId = created.data?.id;

  const duplicate = await call('/teacher/payment-methods', {
    method: 'POST',
    body: { channel: 'bkash', accountNumber: '01711223344' },
  });
  check('duplicate number rejected', duplicate.status, 409);

  const bad = await call('/teacher/payment-methods', {
    method: 'POST',
    body: { channel: 'nagad', accountNumber: '999' },
  });
  check('invalid number rejected', bad.status, 422);

  console.log('\n--- 3. publish a course ---');
  const course = await call('/teacher/courses', {
    method: 'POST',
    body: {
      title: 'Payments Smoke Course',
      slug: `payments-smoke-${Date.now()}`,
      pricePoisha: 75_000,
      isInAllAccess: true,
    },
  });
  check('course created', course.status, 201);
  courseId = course.data?.id;
  await call(`/teacher/courses/${courseId}`, { method: 'PATCH', body: { state: 'published' } });

  const purchasePage = await fetch(`${PAGE_BASE}/purchase/${courseId}`);
  check('purchase page renders', purchasePage.status, 200);

  console.log('\n--- 4. student buys the course, for real ---');
  const student = await seedStudent('Smoke Student');
  studentId = student.id;
  const studentAuth = await createStudentSession(sql, student.id);

  /** Calls as the student rather than the teacher. */
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

  const intent = await asStudent('/payments/intent', {
    method: 'POST',
    body: { courseId },
  });
  check('intent created', intent.status, 200);
  check('reference code shape', /^PAY-[A-Z0-9]{6}$/.test(intent.data?.referenceCode ?? ''), true);
  check('amount locked from the course price', intent.data?.amountPoisha, 75_000);
  check(
    "student is shown the teacher's number",
    intent.data?.methods?.map((m) => m.accountNumber),
    ['01711223344'],
  );

  const reloaded = await asStudent('/payments/intent', { method: 'POST', body: { courseId } });
  check(
    'reloading reuses the same reference code',
    reloaded.data?.referenceCode,
    intent.data.referenceCode,
  );

  const reference = intent.data.referenceCode;
  const trx = `TRXSMK${Date.now().toString().slice(-4)}`;

  const submitted = await asStudent('/payments', {
    method: 'POST',
    body: {
      referenceCode: reference,
      channel: 'bkash',
      senderNumber: '01755667788',
      transactionId: trx,
      // Which of the teacher's numbers the student was shown. Without it the
      // queue cannot display what the transfer should be checked against.
      paymentMethodId: intent.data.methods[0].id,
      studentNote: 'Sent from my brother phone',
    },
  });
  check('proof submitted', submitted.status, 200);

  const duplicateTrx = await asStudent('/payments', {
    method: 'POST',
    body: {
      referenceCode: reference,
      channel: 'bkash',
      senderNumber: '01755667788',
      transactionId: trx,
    },
  });
  // Same payment resubmitted: the reference is still pending, so this is a
  // legitimate correction rather than a duplicate claim.
  check('resubmitting the same payment is allowed', duplicateTrx.status, 200);

  // The second submission omitted paymentMethodId and proofKey. Those must
  // survive: a student fixing a typo must not lose the screenshot they already
  // uploaded.
  const preserved = await sql`
    SELECT payment_method_id, student_note FROM payments WHERE reference_code = ${reference}`;
  check('method reference survives a resubmission', preserved[0]?.payment_method_id, methodId);
  check(
    'student note survives a resubmission',
    preserved[0]?.student_note,
    'Sent from my brother phone',
  );

  const history = await asStudent('/payments');
  check('student sees it in their history', history.status, 200);
  check(
    'status shown as pending',
    history.data?.find((p) => p.referenceCode === reference)?.status,
    'pending',
  );

  console.log('\n--- 5. the queue shows it ---');
  const queue = await call('/teacher/payments?status=pending');
  check('queue loads', queue.status, 200);
  const row = queue.data?.find((p) => p.referenceCode === reference);
  check('payment appears in the queue', Boolean(row), true);
  check('amount carried through', row?.amountPoisha, 75_000);
  check('student name joined', row?.studentName, 'Smoke Student');
  check('course title joined', row?.courseTitle, 'Payments Smoke Course');
  check('receiving number joined', row?.methodNumber, '01711223344');

  console.log('\n--- 6. approving grants access ---');
  const beforeEnt = await sql`SELECT id FROM entitlements WHERE student_id = ${studentId}`;
  check('student has no access before approval', beforeEnt.length, 0);

  const approved = await call(`/teacher/payments/${row.id}/approve`, { method: 'POST' });
  check('approve succeeds', approved.status, 200);
  check('entitlement kind', approved.data?.kind, 'single_course');

  const afterEnt = await sql`
    SELECT kind, course_id, revoked_at FROM entitlements WHERE student_id = ${studentId}`;
  check('exactly one entitlement issued', afterEnt.length, 1);
  check('scoped to the course', afterEnt[0]?.course_id, courseId);

  console.log('\n--- 7. the student can now see it as approved ---');
  const historyAfter = await asStudent('/payments');
  check(
    'student sees approved status',
    historyAfter.data?.find((p) => p.referenceCode === reference)?.status,
    'verified',
  );

  // Buying it again must be refused rather than taking a second payment.
  const rebuy = await asStudent('/payments/intent', { method: 'POST', body: { courseId } });
  check('cannot buy a course already owned', rebuy.status, 409);

  console.log('\n--- 8. approving twice is refused ---');
  const secondApprove = await call(`/teacher/payments/${row.id}/approve`, { method: 'POST' });
  check('second approve refused', secondApprove.status, 409);
  check('refusal code', secondApprove.error?.code, 'PAYMENT_NOT_PENDING');

  const stillOne = await sql`SELECT id FROM entitlements WHERE student_id = ${studentId}`;
  check('still exactly one entitlement', stillOne.length, 1);

  console.log('\n--- 9. it moved to the verified tab ---');
  const verified = await call('/teacher/payments?status=verified');
  check(
    'appears under verified',
    verified.data?.some((p) => p.referenceCode === reference),
    true,
  );
  const pendingNow = await call('/teacher/payments?status=pending');
  check(
    'gone from pending',
    pendingNow.data?.some((p) => p.referenceCode === reference),
    false,
  );

  console.log('\n--- 10. rejection requires a note when reason is "other" ---');
  const second = await seedStudent('Reject Student');
  const ref2 = `PAY-RJK${Date.now().toString().slice(-3)}`;
  await sql`
    INSERT INTO payments (id, reference_code, student_id, course_id, reviewer_id,
                          amount_poisha, channel, transaction_id, status)
    VALUES (gen_random_uuid(), ${ref2}, ${second.id}, ${courseId}, ${teacherId},
            75000, 'bkash', ${`TRXRJ${Date.now().toString().slice(-4)}`}, 'pending')`;

  const queue2 = await call('/teacher/payments?status=pending');
  const row2 = queue2.data?.find((p) => p.referenceCode === ref2);

  const noNote = await call(`/teacher/payments/${row2.id}/reject`, {
    method: 'POST',
    body: { reason: 'other' },
  });
  check('"other" without a note refused', noNote.status, 422);

  const rejected = await call(`/teacher/payments/${row2.id}/reject`, {
    method: 'POST',
    body: { reason: 'wrong_amount', note: 'Send the remaining 200 BDT.' },
  });
  check('rejection succeeds', rejected.status, 200);

  const noEnt = await sql`SELECT id FROM entitlements WHERE student_id = ${second.id}`;
  check('rejection issues nothing', noEnt.length, 0);

  studentId = [studentId, second.id];
} finally {
  const ids = Array.isArray(studentId) ? studentId : studentId ? [studentId] : [];

  // FK order: entitlements reference payments and courses, payments reference
  // courses, audit_log blocks profile deletion.
  if (courseId) {
    await sql`DELETE FROM entitlements WHERE course_id = ${courseId}`;
    await sql`DELETE FROM payments WHERE course_id = ${courseId}`;
    await sql`DELETE FROM audit_log WHERE entity_id = ${courseId}`;
    await sql`DELETE FROM courses WHERE id = ${courseId}`;
  }
  if (methodId) {
    await sql`DELETE FROM audit_log WHERE entity_id = ${methodId}`;
    await sql`DELETE FROM payment_methods WHERE id = ${methodId}`;
  }
  for (const id of ids) {
    await sql`DELETE FROM entitlements WHERE student_id = ${id}`;
    await sql`DELETE FROM payments WHERE student_id = ${id}`;
    await sql`DELETE FROM profiles WHERE id = ${id}`;
    await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${id}`, {
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
