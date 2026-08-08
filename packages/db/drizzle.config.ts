import { config as loadEnv } from 'dotenv';
import type { Config } from 'drizzle-kit';

// drizzle-kit does not read .env.local the way Next.js does.
loadEnv({ path: '../../.env.local' });

export default {
  // Built output, not src. drizzle-kit loads the schema through a CJS esbuild
  // shim that does not honour NodeNext's .js -> .ts specifier mapping, so it
  // cannot read the ESM source directly. `npm run generate` builds first.
  schema: './dist/schema/index.js',
  out: './migrations',
  dialect: 'postgresql',
  casing: 'snake_case',
  dbCredentials: {
    // Migrations run DDL in transactions, which the TRANSACTION pooler (6543)
    // cannot do. Supabase's direct host (db.<ref>.supabase.co) is IPv6-only,
    // so it is unreachable from any IPv4-only network. The SESSION pooler
    // (port 5432 on aws-N-<region>.pooler.supabase.com) is IPv4 and behaves
    // like a direct connection — that is what MIGRATION_DATABASE_URL is for.
    url: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
  },
  // Supabase owns these schemas. Never let drizzle-kit try to drop them.
  schemaFilter: ['public'],
  verbose: true,
  strict: true,
} satisfies Config;
