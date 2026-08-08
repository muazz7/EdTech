import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export * from './schema/index.js';
export { schema };

/**
 * Server-only database client.
 *
 * Section 3.3: do not let Supabase's client SDK become the data layer.
 * Students must never query the database from the browser or the app. All
 * reads and writes go through /api/v1, which holds the service role key. RLS
 * is a safety net for when the API has a bug, not the primary access control.
 */
function createClient() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.',
    );
  }

  // Supabase requires TLS on both poolers. A local Docker Postgres does not
  // have a certificate, so only require it for remote hosts.
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);

  // Serverless: one connection per function instance, no pooling in-process.
  // Point DATABASE_URL at Supabase's transaction pooler (port 6543) in
  // production; prepared statements must be off for the pooler to work.
  //
  // connect_timeout is not optional. Without it postgres-js waits forever on
  // an unreachable or TLS-refusing host, and the request hangs rather than
  // returning a 500 — which on Vercel means burning the whole function
  // execution ceiling before the client ever sees an error.
  // max:1 is tempting for serverless but it starves transactions. Any
  // un-awaited query (guardRequest's throttled touchSession, for one) competes
  // for the same single connection that an open transaction is holding, and
  // the request stalls until statement_timeout. Keep the pool small, not 1.
  const max = Number(process.env.DATABASE_POOL_MAX) || 5;

  const client = postgres(url, {
    max,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 15,
    ...(isLocal ? {} : { ssl: 'require' as const }),
  });

  cachedRaw = client;
  return drizzle(client, { schema, casing: 'snake_case' });
}

let cached: ReturnType<typeof createClient> | undefined;
let cachedRaw: ReturnType<typeof postgres> | undefined;

/** Lazily created so importing this module does not require env at build time. */
export function getDb() {
  cached ??= createClient();
  return cached;
}

/**
 * Closes the pool. Only for scripts and tests — a serverless function must
 * leave its connection alone for the next invocation to reuse.
 */
export async function closeDb(): Promise<void> {
  if (cachedRaw) await cachedRaw.end({ timeout: 5 });
  cached = undefined;
  cachedRaw = undefined;
}

export type Database = ReturnType<typeof createClient>;

/**
 * The handle passed to a `db.transaction(async (tx) => ...)` callback.
 *
 * Not the same type as Database — a transaction has no `$client` — so any
 * helper meant to run both standalone and inside a transaction must accept
 * this union rather than Database alone.
 */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export type DbOrTransaction = Database | Transaction;
