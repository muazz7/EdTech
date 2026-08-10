/**
 * Launch readiness check.
 *
 *   npm run preflight
 *
 * Everything here is configuration, not code. The test suite proves the code
 * works; this proves the environment it is about to run in is real. Each of
 * these has a specific failure it prevents, named in the check itself.
 *
 * Exits non-zero if anything BLOCKING is missing. Warnings are things that
 * degrade gracefully — the platform runs without them, but something is worse.
 */
import { config as loadEnv } from 'dotenv';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

loadEnv({ path: '.env.local' });

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let blocking = 0;
let warnings = 0;

function pass(label, note) {
  console.log(`PASS  ${label}${note ? `  — ${note}` : ''}`);
}

function fail(label, why) {
  blocking++;
  console.log(`FAIL  ${label}\n      ${why}`);
}

function warn(label, why) {
  warnings++;
  console.log(`WARN  ${label}\n      ${why}`);
}

/** Env vars the platform cannot serve a single paid request without. */
const REQUIRED = [
  ['DATABASE_URL', 'No database. Nothing works.'],
  ['MIGRATION_DATABASE_URL', 'Migrations need the session pooler; DDL runs in transactions.'],
  ['SUPABASE_URL', 'Auth and the admin API both live here.'],
  ['SUPABASE_SERVICE_ROLE_KEY', 'Server-side auth admin calls fail without it.'],
  ['JWT_SECRET', 'Access tokens cannot be signed or verified.'],
];

/** Absent, these fail closed or degrade — but each has a real consequence. */
const RECOMMENDED = [
  ['CRON_SECRET', 'Every /cron/* route answers 503, so certificates never issue and expiry reminders never send.'],
  ['VDOCIPHER_API_SECRET', 'Video playback cannot be issued. The whole paid video library is unplayable.'],
  ['R2_ACCOUNT_ID', 'Part of the R2 endpoint. Signing fails without it even when the keys are set.'],
  ['R2_ACCESS_KEY_ID', 'PDFs, notes and assignment uploads cannot be signed.'],
  ['R2_SECRET_ACCESS_KEY', 'Same as above.'],
  ['R2_BUCKET', 'Same as above.'],
  ['UPSTASH_REDIS_REST_URL', 'Rate limiting falls back to in-memory, which is per-instance and therefore not a limit on serverless.'],
  ['UPSTASH_REDIS_REST_TOKEN', 'The URL alone does not authenticate. Half-configured Upstash fails closed to in-memory.'],
  ['SENTRY_DSN', 'Unhandled server errors go to the console and nowhere else.'],
  ['FCM_SERVICE_ACCOUNT_JSON', 'No push. A kicked device only finds out on its next request.'],
];

console.log('--- 1. environment ---');
for (const [name, why] of REQUIRED) {
  if (process.env[name]) pass(name);
  else fail(name, why);
}
for (const [name, why] of RECOMMENDED) {
  if (process.env[name]) pass(name);
  else warn(`${name} not set`, why);
}

console.log('\n--- 2. secrets stay server-side ---');
{
  // The single worst mistake available in this codebase: a NEXT_PUBLIC_ prefix
  // on a server secret ships it in the browser bundle, and the VdoCipher secret
  // or the R2 credentials in a client bundle exposes the entire content library
  // (Section 17.6).
  const leaked = Object.keys(process.env).filter(
    (key) =>
      key.startsWith('NEXT_PUBLIC_') &&
      /SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|_KEY$/i.test(key) &&
      // The publishable Supabase key is public by design.
      !/ANON|PUBLISHABLE/i.test(key),
  );

  if (leaked.length === 0) pass('no server secret carries a NEXT_PUBLIC_ prefix');
  else fail('a secret is exposed to the browser', `NEXT_PUBLIC_: ${leaked.join(', ')}`);
}

{
  const gitignore = await readFile(path.join(root, '.gitignore'), 'utf8').catch(() => '');
  if (gitignore.includes('.env.local')) pass('.env.local is gitignored');
  else fail('.env.local is not gitignored', 'Secrets would be committed on the next add -A.');
}

console.log('\n--- 3. migrations ---');
{
  const dir = path.join(root, 'packages/db/migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const journal = JSON.parse(
    await readFile(path.join(dir, 'meta/_journal.json'), 'utf8'),
  );
  const tags = new Set(journal.entries.map((e) => e.tag));

  // A hand-written migration that is not in the journal is silently skipped by
  // drizzle-kit. That has happened once in this project.
  const orphans = files.map((f) => f.replace(/\.sql$/, '')).filter((tag) => !tags.has(tag));

  if (orphans.length === 0) pass(`${files.length} migrations, all journalled`);
  else fail('a migration is missing from the journal', `Never applied: ${orphans.join(', ')}`);

  const indexes = journal.entries.map((e) => e.idx);
  const monotonic = indexes.every((v, i) => v === i);
  if (monotonic) pass('journal indexes are contiguous');
  else warn('journal indexes have a gap', 'Ordering may not be what you expect.');
}

console.log('\n--- 4. database ---');
const sql = postgres(process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL, {
  ssl: 'require',
  max: 1,
  prepare: false,
  connect_timeout: 15,
});

try {
  const applied = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
  const dir = path.join(root, 'packages/db/migrations');
  const onDisk = (await readdir(dir)).filter((f) => f.endsWith('.sql')).length;

  if (applied[0].n >= onDisk) pass(`${applied[0].n} migrations applied`);
  else fail('the database is behind the repo', `${applied[0].n} applied, ${onDisk} on disk. Run npm run db:migrate.`);

  const rls = await sql`
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`;

  if (rls.length === 0) pass('row level security is on for every public table');
  else fail('tables without RLS', `${rls.map((r) => r.relname).join(', ')}. Supabase grants anon SELECT by default.`);

  // The session pooler holds multi-statement transactions; the transaction
  // pooler does not, and login would hang on its own row lock.
  const url = process.env.DATABASE_URL ?? '';
  if (url.includes(':6543')) {
    fail(
      'DATABASE_URL points at the transaction pooler',
      'Login and payment approval both need a multi-statement transaction. Use port 5432.',
    );
  } else if (url.includes('.pooler.supabase.com')) {
    pass('DATABASE_URL uses the session pooler');
  } else {
    warn('DATABASE_URL is not a Supabase pooler host', 'Check it is reachable over IPv4.');
  }

  const idle = await sql`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE state = 'idle in transaction' AND now() - state_change > interval '5 minutes'`;
  if (idle[0].n === 0) pass('no stuck backends');
  else warn(`${idle[0].n} backends idle in transaction`, 'They hold row locks. See db-check.mjs --kill-idle.');

  console.log('\n--- 5. content readiness ---');
  const [courses] = await sql`
    SELECT count(*) FILTER (WHERE state = 'published')::int AS published,
           count(*)::int AS total
    FROM courses`;
  if (courses.published > 0) pass(`${courses.published} published course(s)`);
  else warn('no published course', 'The catalog is empty; visitors see nothing to buy.');

  const [methods] = await sql`
    SELECT count(*)::int AS n FROM payment_methods WHERE is_active`;
  if (methods.n > 0) pass(`${methods.n} active payment method(s)`);
  else warn('no active payment method', 'Students reach the purchase screen with nowhere to send money.');

  const [free] = await sql`
    SELECT count(*)::int AS n FROM lessons l
    JOIN courses c ON c.id = l.course_id
    WHERE l.is_free AND l.is_published AND c.state = 'published'`;
  if (free.n > 0) pass(`${free.n} free preview lesson(s)`);
  else warn('no free lessons', 'The conversion funnel asks strangers to pay before seeing anything.');
} finally {
  await sql.end();
}

console.log('\n--- 6. build output ---');
{
  // A stale .next served in production is a silent rollback to whatever was
  // built last.
  if (existsSync(path.join(root, 'apps/web/.next/BUILD_ID'))) {
    pass('a production build exists');
  } else {
    warn('no production build in apps/web/.next', 'Vercel builds on deploy, so this only matters for a self-hosted start.');
  }
}

console.log(
  blocking === 0
    ? `\nREADY${warnings > 0 ? ` — ${warnings} warning(s) to review` : ''}`
    : `\nNOT READY — ${blocking} blocking issue(s)`,
);
process.exit(blocking === 0 ? 0 : 1);
