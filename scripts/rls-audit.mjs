/**
 * RLS audit.
 *
 *   node scripts/rls-audit.mjs
 *
 * Two questions, because either one alone is misleading:
 *
 *   1. Which public tables have row level security switched off?
 *   2. Can the PUBLISHED anon key actually read them through PostgREST?
 *
 * Question 2 is the one that matters. Supabase's default template grants
 * `anon` and `authenticated` SELECT on tables in the public schema, so a table
 * without RLS is readable by anyone holding the anon key — and the anon key
 * ships in the client bundle. RLS is the only thing standing between a missing
 * policy and a public table.
 *
 * Prints statuses and row counts. Never prints row contents or the key.
 */
import { config as loadEnv } from 'dotenv';
import postgres from 'postgres';

loadEnv({ path: '.env.local' });

const sql = postgres(process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL, {
  ssl: 'require',
  max: 1,
  prepare: false,
});

/** Tables that hold one user's data and must never be readable by another. */
const SENSITIVE = new Set([
  'assignment_submissions',
  'quiz_answers',
  'quiz_attempts',
  'quiz_questions',
  'notifications',
  'payments',
  'entitlements',
  'profiles',
  'lesson_progress',
  'certificates',
  'quiz_options',
]);

let failures = 0;

try {
  const tables = await sql`
    SELECT c.relname AS name,
           c.relrowsecurity AS rls,
           (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname`;

  console.log('--- 1. row level security by table ---');
  const unprotected = [];
  for (const table of tables) {
    const mark = table.rls ? 'RLS' : 'OFF';
    if (!table.rls) unprotected.push(table.name);
    console.log(`${mark}  policies=${table.policies}  ${table.name}`);
  }

  console.log('\n--- 2. tables with RLS off ---');
  if (unprotected.length === 0) {
    console.log('none');
  } else {
    for (const name of unprotected) {
      const severe = SENSITIVE.has(name);
      if (severe) failures++;
      console.log(`${severe ? 'FAIL' : 'warn'}  ${name}`);
    }
  }

  const url = process.env.SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;

  if (!url || !anon) {
    console.log('\n--- 3. anon reachability: SKIPPED (no anon key in .env.local) ---');
  } else {
    console.log('\n--- 3. what the published anon key can actually read ---');
    for (const table of tables) {
      const res = await fetch(`${url}/rest/v1/${table.name}?select=*&limit=1`, {
        headers: { apikey: anon, authorization: `Bearer ${anon}` },
      });

      // 200 with rows means the table is readable by the whole internet.
      if (res.status !== 200) continue;
      const rows = await res.json().catch(() => []);
      if (!Array.isArray(rows) || rows.length === 0) continue;

      const severe = SENSITIVE.has(table.name);
      if (severe) failures++;
      console.log(
        `${severe ? 'FAIL' : 'warn'}  ${table.name} is readable with the anon key (${rows.length} row visible)`,
      );
    }

    // The catalog IS public, so `courses` being readable is correct. What must
    // not be readable is a draft. This is the Phase 3 invariant checked at the
    // database rather than at the API, because PostgREST does not go through
    // the API.
    console.log('\n--- 4. draft courses stay invisible to anon ---');
    const drafts = await fetch(
      `${url}/rest/v1/courses?select=state&state=neq.published&limit=5`,
      { headers: { apikey: anon, authorization: `Bearer ${anon}` } },
    );
    const draftRows = drafts.status === 200 ? await drafts.json().catch(() => []) : [];
    const leaked = Array.isArray(draftRows) ? draftRows.length : 0;
    if (leaked > 0) failures++;
    console.log(
      leaked > 0
        ? `FAIL  ${leaked} non-published course(s) readable with the anon key`
        : 'PASS  no unpublished course is readable',
    );
  }
} finally {
  await sql.end();
}

console.log(
  failures === 0
    ? '\nNO SENSITIVE TABLE IS EXPOSED'
    : `\n${failures} SENSITIVE EXPOSURE(S) — fix before launch`,
);
process.exit(failures === 0 ? 0 : 1);
