import type { Config } from 'drizzle-kit';

export default {
  // Built output, not src. drizzle-kit loads the schema through a CJS esbuild
  // shim that does not honour NodeNext's .js -> .ts specifier mapping, so it
  // cannot read the ESM source directly. `npm run generate` builds first.
  schema: './dist/schema/index.js',
  out: './migrations',
  dialect: 'postgresql',
  casing: 'snake_case',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  // Supabase owns these schemas. Never let drizzle-kit try to drop them.
  schemaFilter: ['public'],
  verbose: true,
  strict: true,
} satisfies Config;
