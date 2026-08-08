import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Service-role Supabase client. SERVER ONLY.
 *
 * Section 3.3: do not let the Supabase client SDK become the data layer.
 * Students never query the database from the browser or the app — all reads
 * and writes go through /api/v1, which holds this key. Importing this module
 * from a Client Component is a content-library-level security bug.
 *
 * Supabase Auth is used for the credential lifecycle only (phone OTP,
 * email/password). Sessions and entitlements are ours, in active_sessions and
 * entitlements.
 */
let cached: SupabaseClient | undefined;

export function supabaseAdmin(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.');
  }

  cached = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cached;
}
