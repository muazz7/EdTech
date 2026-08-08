# Master EdTech Platform

Closed online course platform for Bangladesh. Single brand, invited teachers,
manual mobile-money payments, piracy-hardened content delivery.

The full specification is [EdTech_Platform_Final_Technical_Documentation.md](EdTech_Platform_Final_Technical_Documentation.md).
Section numbers referenced throughout the code point into it.

**Current state: Phase 0 (Foundations) — code complete, not yet run against a
live database.** See [Phase 0 status](#phase-0-status) below.

## Layout

```
apps/
  web/            Next.js 15 — UI + /api/v1 route handlers
packages/
  core/           framework-agnostic business logic
    auth/         tokens, session guard, device-switch policy
    entitlements/ checkLessonAccess — the single access gate
  db/             Drizzle schema + migrations
  shared/         Zod schemas, constants, error codes
```

`packages/*` must never import `next` or `react`. That boundary is what makes
the Section 3.2 escape hatch real — if `packages/core` can lift into a Hono or
Fastify service unchanged, outgrowing Vercel is a weekend rather than a
rewrite. An ESLint rule enforces it; do not add an exception.

## Prerequisites

- Node 20+ (developed against 22.21.0)
- A Supabase project (Postgres 15+, Auth with phone provider configured)

npm workspaces, not pnpm — no global install needed.

## Setup

```bash
npm install
cp .env.example .env.local     # then fill it in
npm run db:generate            # regenerate migrations after a schema change
npm run db:migrate             # apply to the database in DATABASE_URL
npm run dev
```

`db:generate` and `db:migrate` build `packages/db` first. drizzle-kit loads the
schema through a CJS shim that cannot read the ESM source directly, so the
config points at `dist/`, not `src/`.

## Verify

```bash
npx tsc --build                # all three packages
npm run build --workspace=@edtech/web
npx eslint packages apps/web/src
```

## Migrations

Forward-only. Never edit a migration after merge. Every migration must be safe
against the currently-live application version — add columns nullable, backfill,
constrain in a second migration. With a mobile app in the wild you cannot
assume all clients updated.

- `0000_*` — generated baseline, 27 tables.
- `0001_auth_fk_and_rls` — hand-written. The FK to Supabase's `auth.users`
  (drizzle does not model the `auth` schema) and the RLS baseline from
  Section 7.1.

RLS is a **second** layer. The primary access control is `checkLessonAccess`
in `packages/core`, which runs on the server on every protected request. RLS is
what stops the data walking out if the API ever has a bug that leaks a query.
The service role key bypasses it by design.

## Two invariants worth knowing before you touch the schema

**`one_live_session_per_user`** — a partial unique index on `active_sessions`.
The database will not permit two live sessions for one user regardless of
application bugs. A login that trips it means the revoke step was skipped;
that is the bug. Do not drop the index to make the error go away.

**`uniq_channel_txid`** — a partial unique index on `payments`. The same
transaction ID cannot be claimed twice on the same channel. Surface it as
`DUPLICATE_TRANSACTION_ID`, never as a 500.

## Phase 0 status

Done and verified to compile:

- Monorepo, TypeScript project references, ESLint boundary rules
- Drizzle schema — 27 tables, all partial indexes and CHECK constraints present
  in the generated SQL
- RLS baseline migration
- Session guard (`guardRequest`) — JWT + `X-Session-Id` against a live session row
- Device-switch policy — 4 distinct fingerprints per rolling 30 days
- Entitlement engine — `checkLessonAccess` / `checkCourseAccess`
- `/api/v1/auth/{otp/request, otp/verify, me, logout}`
- Design tokens with verified contrast ratios, light and dark

Not done, still Phase 0:

- **Never run against a real database.** Every migration and query above is
  compile-verified only.
- Refresh-token rotation — `/auth/otp/verify` returns a token but does not yet
  persist or rotate it
- Rate limiting (Section 6.4) — needs Upstash Redis
- FCM push to the kicked device on new-device login
- Sentry
- The five tests in Section 19.4

## Decisions still blocking later phases

From Section 22.1, unanswered:

1. Owner controls all pricing, or teachers set their own? (blocks Phase 2)
2. What is the note-to-image converter — rich-text rendered to images,
   photographed handwriting, or a stylus canvas? (blocks Phase 5; the three
   implementations share nothing)
3. Bangladeshi business entity for SSLCommerz? (long lead time — start now)
4. Mac access for iOS builds? (blocks Phase 8)
5. Assignment resubmission — until graded, or unlimited? (blocks Phase 7)
6. Subscription price point in BDT (drives the Bunny.net evaluation)
7. Do lapsed subscribers keep access to completed courses?
