/**
 * Read-only database inspection. Reports what actually landed, rather than
 * what the migration files claim.
 *
 *   node scripts/db-check.mjs
 *
 * Uses MIGRATION_DATABASE_URL (session pooler) so it works on IPv4-only
 * networks — Supabase's direct host is IPv6-only.
 */
import { config as loadEnv } from 'dotenv';
import postgres from 'postgres';

loadEnv({ path: '.env.local' });

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL / DATABASE_URL not set in .env.local');
  process.exit(1);
}

const sql = postgres(url, { ssl: 'require', max: 1, prepare: false, connect_timeout: 15 });

try {
  const [{ version }] = await sql`select version()`;
  console.log('server:', version.split(',')[0]);

  const tables = await sql`
    select tablename, rowsecurity
    from pg_tables
    where schemaname = 'public'
    order by tablename
  `;
  console.log(`\npublic tables: ${tables.length}`);

  const rlsOn = tables.filter((t) => t.rowsecurity).map((t) => t.tablename);
  console.log(`rls enabled:   ${rlsOn.length}${rlsOn.length ? ' -> ' + rlsOn.join(', ') : ''}`);

  const policies = await sql`
    select tablename, policyname from pg_policies where schemaname = 'public'
    order by tablename, policyname
  `;
  console.log(`rls policies:  ${policies.length}`);
  for (const p of policies) console.log(`  ${p.tablename}.${p.policyname}`);

  const fk = await sql`
    select conname from pg_constraint where conname = 'profiles_id_auth_users_fk'
  `;
  console.log(`\nauth.users FK: ${fk.length ? 'present' : 'MISSING'}`);

  const applied = await sql`
    select hash, created_at from drizzle.__drizzle_migrations order by created_at
  `.catch(() => []);
  console.log(`migrations recorded: ${applied.length}`);

  const sessions = await sql`
    select id, device_label, platform, revoked_at, revoked_reason, created_at
    from active_sessions order by created_at desc limit 10
  `.catch(() => []);
  console.log(`\nactive_sessions rows: ${sessions.length}`);
  for (const s of sessions) {
    console.log(
      `  ${s.created_at.toISOString()}  ${s.platform.padEnd(8)} ` +
        `${s.revoked_at ? 'revoked:' + s.revoked_reason : 'LIVE'}  ${s.device_label ?? ''}`,
    );
  }

  // A client that disconnects mid-transaction can leave a backend idle in
  // transaction, still holding row locks. That blocks the next insert against
  // one_live_session_per_user until statement_timeout fires.
  const stuck = await sql`
    select pid, state, wait_event_type,
           now() - state_change as idle_for,
           left(coalesce(query, ''), 60) as query
    from pg_stat_activity
    where datname = current_database()
      and state in ('idle in transaction', 'idle in transaction (aborted)', 'active')
      and pid <> pg_backend_pid()
    order by state_change
  `.catch(() => []);
  console.log(`\nnon-idle backends: ${stuck.length}`);
  for (const b of stuck) {
    console.log(`  pid ${b.pid}  ${b.state}  for ${b.idle_for}  ${b.query}`);
  }

  // `node scripts/db-check.mjs --kill-idle` clears backends left idle in
  // transaction. Dev-only: an HMR reload or a killed dev server can drop a
  // client mid-transaction, and the orphaned backend keeps its row locks —
  // which shows up as the next login hanging on one_live_session_per_user
  // until statement_timeout. Never run this against production.
  if (process.argv.includes('--kill-idle')) {
    const killed = await sql`
      select pg_terminate_backend(pid) as ok, pid
      from pg_stat_activity
      where datname = current_database()
        and state in ('idle in transaction', 'idle in transaction (aborted)')
        and pid <> pg_backend_pid()
    `;
    console.log(`\nterminated ${killed.length} idle-in-transaction backend(s)`);
  }

  /**
   * `--reset-devices` clears the rolling device-switch log.
   *
   * Section 6.3 allows 4 distinct device fingerprints per 30 days. Dev scripts
   * that discard cookies derive a fresh web fingerprint each run and exhaust
   * that budget, after which login correctly returns DEVICE_LIMIT_REACHED. In
   * production this is unblocked by hand, deliberately, after asking the student
   * a question — never in bulk. DEV ONLY.
   */
  if (process.argv.includes('--reset-devices')) {
    const cleared = await sql`DELETE FROM device_switch_log RETURNING id`;
    console.log(`\ncleared ${cleared.length} device-switch record(s)`);
  }

  /**
   * `--clean-fixtures` removes leftovers from a test run that failed before its
   * teardown. The suite runs against a real database, so an aborted run strands
   * courses, payments and auth users that later runs then collide with.
   *
   * Matches only the fixture naming (`test-course-%` slugs). DEV ONLY.
   */
  if (process.argv.includes('--clean-fixtures')) {
    const stale = await sql`SELECT id FROM courses WHERE slug LIKE 'test-course-%'`;
    const ids = stale.map((r) => r.id);

    if (ids.length > 0) {
      // Order is forced by the FKs: entitlements reference payments
      // (fk_entitlement_payment) AND courses, payments reference courses.
      // Deleting payments first fails on the entitlement FK.
      await sql`DELETE FROM entitlements WHERE course_id = ANY(${ids})`;
      await sql`DELETE FROM entitlements WHERE payment_id IN (
        SELECT id FROM payments WHERE course_id = ANY(${ids})
      )`;
      await sql`DELETE FROM payments WHERE course_id = ANY(${ids})`;
      await sql`DELETE FROM audit_log WHERE entity_id = ANY(${ids})`;
      await sql`DELETE FROM courses WHERE id = ANY(${ids})`;
    }
    console.log(`\nremoved ${ids.length} stale fixture course(s)`);

    // audit_log.actor_id has no ON DELETE rule, deliberately: the trail is
    // immutable, so a profile that has performed an audited action cannot be
    // deleted. Fine in production; here it just blocks fixture teardown, so the
    // fixtures' own audit rows go first.
    //
    // NOTE for production: removing a real user with audit history will need a
    // decision — most likely ON DELETE SET NULL plus a denormalised actor label
    // on the audit row, so the record survives the person.
    const fixtureNames = [
      'Test User',
      'Test Teacher',
      'Other Teacher',
      'Test Admin',
      'Alice Teacher',
      'Bob Teacher',
      'Platform Owner',
      'Media Teacher',
      'Number Normaliser',
      'Bad Number',
      'Duplicate Number',
      'Curious Student',
      'Rahim Uddin',
    ];

    const doomed = await sql`
      SELECT id FROM profiles
      WHERE full_name = ANY(${fixtureNames})
        AND NOT EXISTS (SELECT 1 FROM courses c WHERE c.teacher_id = profiles.id)`;
    const doomedIds = doomed.map((r) => r.id);

    if (doomedIds.length > 0) {
      await sql`DELETE FROM audit_log WHERE actor_id = ANY(${doomedIds})`;
      await sql`DELETE FROM entitlements WHERE granted_by = ANY(${doomedIds})`;
      await sql`DELETE FROM payments WHERE reviewed_by = ANY(${doomedIds})`;
      await sql`DELETE FROM profiles WHERE id = ANY(${doomedIds})`;
    }
    console.log(`removed ${doomedIds.length} stale fixture profile(s)`);
  }
} finally {
  await sql.end({ timeout: 5 });
}
