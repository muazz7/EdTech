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

  // Serverless: one connection per function instance, no pooling in-process.
  // Point DATABASE_URL at Supabase's transaction pooler (port 6543) in
  // production; prepared statements must be off for the pooler to work.
  const client = postgres(url, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
  });

  return drizzle(client, { schema, casing: 'snake_case' });
}

let cached: ReturnType<typeof createClient> | undefined;

/** Lazily created so importing this module does not require env at build time. */
export function getDb() {
  cached ??= createClient();
  return cached;
}

export type Database = ReturnType<typeof createClient>;
