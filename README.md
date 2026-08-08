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
npm run typecheck              # all three packages
npm run lint
npm test
npm run contrast
npm run build:verify           # NOT `npm run build` while a dev server is up
```

`build:verify` builds into `.next-verify`. `next build` and `next dev` share
`.next` by default, so a production build run against a live dev server wipes
the dev server's output and every request 500s until it recompiles — which is
indistinguishable from an intermittent smoke-test failure, and was in fact the
cause of one. Deployment leaves `NEXT_DIST_DIR` unset and builds into `.next`.

## Cron

Schedules live in [vercel.json](vercel.json). Every `/api/v1/cron/*` route is
protected by `CRON_SECRET`, compared in constant time — these are not
user-authenticated but must never be publicly callable, since
`poll-video-status` hits the paid vendor API on every request.

Sub-daily cron requires **Vercel Pro**, which Section 20 already budgets for
(Hobby also forbids commercial use). On Hobby the 5-minute poll silently becomes
daily, which looks like "uploads never finish processing".

## Database connections — read this before changing DATABASE_URL

Supabase gives you three hosts. Only two are usable, and they are not
interchangeable.

| Host | Port | Use for | Why |
|---|---|---|---|
| `db.<ref>.supabase.co` | 5432 | **nothing** | **IPv6-only.** Unreachable from any IPv4-only network. |
| `aws-0-<region>.pooler.supabase.com` | 5432 (session) | app runtime **and** migrations | Pins one backend per connection. Transactions work. |
| `aws-0-<region>.pooler.supabase.com` | 6543 (transaction) | not currently used | Cannot hold a multi-statement transaction on one backend. |

The transaction pooler is the usual serverless advice and it is wrong for this
app. Login revokes the previous session and inserts the new one in a single
transaction (Section 6.3). Under transaction-mode pooling the `INSERT` lands on
a different backend from the `UPDATE`, blocks on the row lock the `UPDATE` still
holds, and the `COMMIT` arrives at a backend with no open transaction —
`25P01: there is no transaction in progress`. The request then hangs until
`statement_timeout` and strands an idle-in-transaction backend. Payment
approval (Section 8.2) has the same shape and would fail identically.

`MIGRATION_DATABASE_URL` exists because DDL runs in transactions too; it points
at the same session pooler.

Also: `max: 1` on the connection pool starves transactions. An un-awaited query
— `guardRequest`'s throttled `touchSession`, for instance — competes for the
same single connection an open transaction is holding. Pool size is 5, override
with `DATABASE_POOL_MAX`.

## Scripts

```bash
npm test                  # 199 unit/integration tests against the DB
npm run db:check          # tables, RLS, policies, sessions, stuck backends
npm run audit:rls         # what the PUBLISHED anon key can actually read
npm run smoke:devices     # credential lifecycle over HTTP
npm run smoke:builder     # teacher course builder end to end
npm run smoke:payments    # purchase loop, settings, verification queue
npm run smoke:catalog     # public catalog, lock flags, progress, account
npm run smoke:assessment  # quizzes, answer-key leak, assignments, certificates
npm run contrast          # design tokens vs WCAG (no server needed)

# DEV ONLY flags, no npm alias on purpose — reach for these deliberately
node scripts/db-check.mjs --kill-idle      # clear idle-in-transaction backends
node scripts/db-check.mjs --reset-devices  # clear the device-switch budget
```

`audit:rls` earns its own script because RLS is not cosmetic here. Supabase's
default template grants `anon` and `authenticated` SELECT on tables in the public
schema, and the anon key ships in the client bundle — so a public-schema table
without RLS is readable by anyone on the internet, through PostgREST, without
ever touching this API. The script checks both halves: which tables have RLS off,
and what the published anon key can *actually* read. Before migration 0006 the
answer to the second question included `courses`, `modules` and `lessons`.

All five HTTP suites share ONE cookie jar (`dev-web`). That is deliberate:
each jar is a distinct device fingerprint, and three separate jars burned the
4-per-30-days budget in a single sitting. Sharing one makes them all "the same
browser", which is what they actually are. `two-device-test.mjs` still exercises
a second device via its android fingerprint.

`contrast-check.mjs` parses the tokens out of `globals.css` and asserts every
documented pair, in **both** themes. The palette is deliberately bright, and
bright colours fail as text — this is what stops a future tweak from quietly
making a label unreadable. It also asserts the *inverse*: the vivid hues must
stay **below** 4.5:1 on the page background, because a vivid token that became
readable has stopped being vivid and the palette has drifted back to muted.

The smoke suites need the dev server. All persist cookies to
`scripts/.dev-cookies.json`, which is **load-bearing**: the web device
fingerprint is derived from an httpOnly cookie plus the UA (Section 6.3), so a
script that discards cookies presents a new device on every run and exhausts the
4-per-30-days switch budget in four runs. `--reset-devices` unblocks a test
account; in production that unblock is a deliberate manual step after asking the
student a question, never a bulk clear.

`builder-smoke.mjs` skips `/auth/otp/request` on purpose — a Supabase test
number accepts its fixed code directly, and requesting one would consume the
3-per-phone-per-15-min budget that `two-device-test.mjs` also draws on.

`npm test` compiles first, then runs `packages/core/dist/**/*.test.js`. The glob
is deliberate — passing the directory alone silently discovers nothing and
reports a vacuous pass.

The tests use the **real database**, not mocks. Every bug found while getting
Phase 0 running lived in SQL or connection behaviour — a partial unique index,
a CHECK constraint, RLS recursion, transaction pooling — and a mocked `db` would
have passed all of them. Fixtures create real Supabase auth users via the Admin
API and tear them down in `after()`.

`--kill-idle` earns its place: an HMR reload or a killed dev server can drop a
client mid-transaction, and the orphaned backend keeps its row locks. The
symptom is the next login hanging on `one_live_session_per_user`.

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

**Exit criteria met.** Section 21.2 defines Phase 0 as ending when "you can log
in on two devices and watch the first kick out the second". `two-device-test.mjs`
passes all 14 checks against the live Supabase project, and the `active_sessions`
audit trail shows the expected `revoked_reason` values (`new_device`, then
`user_logout`).

Applied and verified against the database:

- Monorepo, TypeScript project references, ESLint boundary rules
- Drizzle schema — 26 tables, all partial indexes and CHECK constraints
- RLS: enabled on 16 tables, 10 policies, `auth.users` FK present
- Session guard — JWT + `X-Session-Id`, rejects a forged token/session pairing
- Single live session enforced by `one_live_session_per_user`
- Device-switch policy — 4 distinct fingerprints per rolling 30 days
- Entitlement engine — `checkLessonAccess` / `checkCourseAccess` (compiled, not
  yet exercised: needs course and lesson rows, which arrive in Phase 1)
- `/api/v1/auth/{otp/request, otp/verify, me, logout}`
- Design tokens with verified contrast ratios, light and dark

Phase 0 follow-ups, also done:

- **Refresh-token rotation** — single-use, SHA-256 hashed, grouped into
  families. Replaying a burned token revokes the family and kills the session;
  a token cannot outlive its session or survive a new-device login.
- **Rate limiting** — Upstash Redis REST when configured, in-process counters
  otherwise (with a warning, because the fallback does not limit a
  multi-instance deployment). Fails **open**: an Upstash outage must not lock
  out students who paid.
- **FCM revoke-push** — `notifySessionRevoked` pushes a silent logout to the
  device just kicked, scoped to that session's tokens so the device that
  legitimately signed in is not logged out too. No-ops with a warning when
  `FCM_SERVICE_ACCOUNT_JSON` is unset. Push is a latency optimisation, never a
  security control — the guarantee is that the revoked device fails on its next
  request regardless.
- **Sentry** — server, edge, and browser, with `beforeSend` scrubbing phone
  numbers, JWTs, bearer tokens, presigned-URL signatures, and every secret env
  name. Session Replay deliberately **off**: it would record the watermarked
  player and payment proof screenshots.
- **Section 19.4 tests 1 and 3** — 51 tests, all passing.

Credentials still needed (each degrades gracefully until then):
`UPSTASH_REDIS_REST_URL` / `_TOKEN`, `FCM_SERVICE_ACCOUNT_JSON`, `SENTRY_DSN`.

Section 19.4 tests still to write, each blocked on a feature that does not
exist yet:

- **Test 2** payment approval — entitlement issuance, renewal stacking,
  duplicate transaction ID. Arrives with Phase 2.
- **Test 4** quiz grading — auto-score, time limit, attempt limits. Phase 7.

## Phase 1 status (Content spine)

Done, 81 tests passing:

- **Vendor boundary** — `VideoProvider` in `packages/core/src/media/types.ts`.
  VdoCipher is one adapter file; Bunny.net is a live alternative pending a quote
  (Section 3.4). No vendor status string or payload shape escapes the adapter.
- **R2** via `aws4fetch`, not the AWS SDK. Presigned PUT signs Content-Type and
  Content-Length (`allHeaders: true`) — without that flag Section 9.2's "pinned
  in the signature" is decoration.
- **Gated issuance** — `/lessons/:id/{playback,asset,note-pages}`. Rate limits
  live in `packages/core`, not the route handlers, so a new endpoint cannot
  forget them. Desktop web is capped to 720p (Section 17.2 L3 exposure, and
  Section 20.5's biggest cost lever).
- **Section 19.4 test 5** — asserts no grant is minted on denial, not merely
  that a 403 came back. An OTP alone plays the video.
- **Teacher CRUD** — courses, modules, lessons, drag-and-drop reorder at both
  levels, upload flows for video / documents / multi-page notes.
- **Price-change audit** (ADR 0002) with before/after diffs, and no row written
  when nothing audited actually changed.
- **`/cron/poll-video-status`** — batched to 25 lessons per run, notifies the
  owning teacher on ready and on failure.

Two deliberate deviations from the specification:

1. **Section 18 lists only `POST /teacher/modules/:id/reorder`**, which is
   ambiguous about which level it reorders, while Section 2.2 requires
   drag-and-drop at both. Split into
   `/teacher/courses/:id/reorder-modules` (modules) and
   `/teacher/modules/:id/reorder` (lessons).
2. **Ownership failures return 404, not 403.** A 403 confirms the id exists,
   which lets one teacher enumerate the catalog's internal ids.

### Teacher UI

Sign-in at `/login` (phone + OTP), portal at `/teacher`, builder at
`/teacher/courses/:id`. Verified end to end by `builder-smoke.mjs`.

Design decisions, all traceable to the design-system pass:

- **Style is Flat Design with subtle elevation**, not the generated
  recommendation (Claymorphism + Comic Neue), which is children's-app styling
  and wrong for paid exam prep with an admin console.
- **Reordering is exposed three ways**: move up/down buttons as the primary
  control, native HTML5 drag as a mouse enhancement, and an `aria-live` region
  announcing every move. Drag-only reordering excludes keyboard users entirely
  and does not work on touch at all — so the buttons are the real feature and
  drag is the garnish.
- **No icon library and no browser Sentry.** First-load JS is 103 kB shared,
  128 kB on the builder. Section 1.4 names uneven Bangladeshi bandwidth as a
  constraint, so bytes are spent deliberately.
- **Reorder is optimistic with rollback.** The server rejects any order that is
  not exactly the current children, so a stale client gets a 422 and the
  previous order is restored rather than the screen disagreeing with the
  database.
- **Move buttons are disabled at the ends, not hidden**, so a row's control
  count does not change as items move.
- **Delete confirms inline** and states what will be lost, with Cancel placed
  before Delete.

`/auth/refresh` prefers the httpOnly cookie over the request body. That is
correct for the browser — the cookie is authoritative and unreadable to page
scripts — and means the body path is exercised only by mobile, which has no
cookies. Tests must pass `noCookies` to drive it.

### Theme

**Light is the default and is not negotiable by the OS.** The dark palette is
gated on `[data-theme='dark']`, not `@media (prefers-color-scheme: dark)` —
with the media query, anyone whose machine was in dark mode saw a navy product
and never saw the intended off-white ground. `color-scheme: light` on `:root`
carries that through to native controls and scrollbars, which is the part that
usually gets missed.

The dark tokens are kept rather than deleted, and are contrast-verified, so
adding a theme switcher later means setting an attribute, not redoing colours.

### Student viewer

`/learn/lessons/:id` renders all three content types. Teachers resolve as
`owner` in `checkLessonAccess`, so **Preview as student** in the builder opens
the real viewer with real DRM and a real watermark — which is the Phase 1 exit
criterion from Section 21.2.

- **Video** — the page never receives a video id, only a single-use OTP and
  playbackInfo, minted immediately before playback. The vendor player runs in
  its own iframe; that is what lets the browser mark the decoded surface
  non-capturable, so it is not an implementation detail to optimise away.
- **PDF / images / note pages** — rendered to `<canvas>` with the watermark
  **composited into the bitmap**, not laid over it in CSS. A DOM overlay is
  removed with two clicks in devtools and any canvas export would come out
  clean; stamping the pixels means a save, a `toDataURL`, or a screenshot all
  carry the attribution.
- **pdf.js is dynamically imported**, so a student opening a video or a
  photographed note never downloads the PDF engine. It is the heaviest
  dependency here and `/learn/lessons/:id` stays at 114 kB because of it.
- `GET /lessons/:id` returns metadata with **no media handle** — no video id, no
  R2 key. Asserted by `builder-smoke.mjs`, because a metadata response carrying
  a video id would be a durable identifier for paid content.

Honest limit, unchanged from ADR 0001 and Section 17.3: on web this is
**deterrence, not prevention**. Print Screen captures a canvas like anything
else. On mobile `FLAG_SECURE` genuinely blocks it, which is the argument for
putting the highest-value notes there.

Not built yet in Phase 1:

- `GET /courses`, `/courses/:slug`, `/courses/:slug/curriculum`, `/free-resources`
  (the public catalog is Phase 3)
- Progress tracking and resume position (Phase 3)

## Phase 2 status (Money)

Backend complete, 26 payment tests passing. See
[ADR 0003](docs/adr/0003-teacher-collected-payments.md) for the money model —
teachers collect and verify their own course payments, and funds never transit
the platform.

Teacher UI done:

- `/teacher/payment-methods` — bKash / Nagad / Rocket numbers, normalised to the
  local `01XXXXXXXXX` form a wallet app accepts. Deactivated, never deleted: a
  payment references the method it was shown against, and a student disputing
  "you told me to send here" needs that record.
- `/teacher/payments` — the verification queue. Built phone-first because
  Section 8.2 says plainly when it gets used: at 11pm, from bed. Cards not
  tables, amount and reference code large enough to check against a wallet SMS
  at a glance, and **Approve sits alone with Reject below it** so a half-awake
  thumb cannot confuse them. Pending is oldest-first.
- The proof screenshot is fetched **per view**, not with the queue: a signed URL
  shipped with the list would stay live for every row the teacher never opened,
  and these images carry a student's name, number and balance.

Student UI done:

- `/purchase/:courseId` — instructions, submission, pending confirmation. Every
  value the student must reproduce in a wallet app (number, amount, reference
  code) is one tap to copy and rendered in tabular figures, because a mistyped
  number is an unrecoverable transfer and a mistyped reference is a payment the
  teacher cannot match.
- `/account/payments` — status per payment, written to answer "what do I do
  now?" rather than to name the database state.
- The locked-lesson screen now names and prices the course and links to the
  purchase page. A 403 for a *published* course carries the paywall facts in
  `error.details` for exactly that; withheld for unpublished and revoked, where
  there is nothing to sell.

`payments-smoke.mjs` now drives the whole loop over HTTP — teacher publishes a
number and a course, student creates an intent and submits proof, teacher
approves, student gains access. The student's session is minted directly
(`scripts/lib/student-session.mjs`) because only one Supabase test phone number
exists and the teacher holds it; everything after authentication is real, and
the auth path itself is covered by `two-device-test.mjs`.

Roster and manual grants:

- `/teacher/courses/:id/students` — who bought the course or was given access,
  with the source, dates and any note. Revoking asks for a reason and takes
  effect on the student's next playback request.
- Granting is two steps: **exact-phone lookup**, then confirm. Exact match only
  — a fuzzy search would let any teacher browse the whole platform's student
  list, including other teachers' customers. It is still an "is this number
  registered?" oracle, so it is rate limited and returns only what is needed to
  confirm the right person. `POST`, not `GET`, so the number stays out of server
  logs and browser history.
- The roster states plainly that platform-wide plan holders can also watch and
  are **not** listed. A teacher seeing an empty roster while subscribers watch
  would otherwise draw the wrong conclusion about their course.

Not built yet in Phase 2:

- Expiry reminders and the grace period (Section 8.3)
- Plan purchase UI (single-course only so far; `plans` has no admin screen)

## Phase 3 status (Student experience)

The first **public** surface in the codebase. That changes the rules: there is
no session to scope a query by, so every catalog read has to be safe for a
stranger to make. Two invariants run through it, both tested:

- Only `state = 'published'` is ever visible. A draft course answers **404,
  identical to a course that does not exist** — any other response confirms to a
  stranger that a teacher is preparing something.
- Nothing returns a media handle, and a locked lesson's **duration is withheld**.
  Titles are public on purpose: the curriculum is the sales pitch, and a paywall
  that hides what it is selling does not convert. Runtime has value on its own.

Done:

- `/` catalog with search and level/subject facets, derived from live data
- `/courses/:slug` detail with the full curriculum and per-lesson lock flags
  (`optionalGuard` — a stranger sees everything locked, a student sees what they
  can open)
- `/free` Free Resource Center, watchable signed out
- `/my-courses` with progress bars and continue-where-you-left-off
- Progress tracking with the Section 14 anti-gaming rule, reported from both
  the video player and the document viewer
- `/account` with the signed-in device, the device-switch budget and
  entitlement status
- `/account/notifications` plus an unread badge in the header

**Anti-gaming** is the substantive part. A heartbeat whose position advanced
faster than wall-clock x playback rate x 1.2 earns no watch credit, so seeking
to the end cannot fake completion — and the same behaviour is what a catalog
ripper looks like (Section 17.5). The comparison uses the **server's** clock
delta; a client that could supply its own elapsed time could claim any amount of
it. 2x playback is explicitly still legitimate.

That delta is also **clamped** two ways, both of which were holes until the
client started reporting for real:

- The gap between reports is capped at `MAX_PROGRESS_GAP_SECONDS` (120). Left
  uncapped, a lesson opened and abandoned overnight would let one seek to the
  end sit inside an allowance of 86400 seconds and credit the whole video.
- A **first** report is measured against one flush interval rather than credited
  at face value. Otherwise a single request completes any lesson: open, seek to
  90%, done.

Videos complete at **90% watched, not 100%** — students skip outros, and
requiring 100% strands them one lesson short of a certificate. Documents
complete on dwell instead, which is why the viewer reports accumulated dwell
seconds as `position`: a page number would make the anti-gaming comparison
meaningless.

Progress reporting batches two heartbeats per request (Section 18) and flushes
on pause, on `ended`, and on `visibilitychange`. The last one uses `fetch`
with `keepalive`, not `sendBeacon` — a beacon sends cookies but no custom
headers, and every endpoint here needs `Authorization` and `X-Session-Id`.

A teacher previewing their own lesson reports **nothing**. Writing
`lesson_progress` rows for them would corrupt every completion figure the course
reports.

Not built yet in Phase 3:

- The DOM-level playback wiring is verified only by typecheck, lint and build.
  The heartbeat interval, the visibility flush and the VdoCipher event names
  have never run in a browser, and the vendor event surface cannot be exercised
  at all without credentials. It is read defensively — an unexpected shape stops
  progress reporting rather than breaking playback — but it is unproven.

**Never executed against the real vendors.** VdoCipher and R2 have no
credentials yet, so both adapters are unit-tested behind a fake and verified
only by compilation. Every integration in this project has surfaced at least one
surprise on first real contact; expect the same, particularly for the presigned
PUT, where signed-header pinning either works exactly or fails opaquely.

## Phase 4 status (Assessment)

Quizzes, assignments and certificates. Backend and the public verification page;
the teacher builder and student attempt UIs are not built yet.

**The rule this phase is organised around:** `is_correct` never leaves the server
before submission. Section 10 calls it out as the mistake most quiz
implementations make — the answer key sits in the network response for the whole
attempt, and any student who opens devtools has a perfect score. It is invisible
in a UI review, because the key is in the payload rather than on the screen.

Two structural choices enforce it:

- The teacher path (`quiz-builder.ts`) and the student path (`quiz-attempt.ts`)
  are **separate modules**. The builder returns the key freely, because a builder
  cannot author without it. The attempt module never selects `is_correct` into a
  returned value. One shared "get quiz" helper with an `includeAnswers` flag is
  how this eventually gets called with the default from a student route.
- `assessment-smoke.mjs` asserts on the **raw response body**, not the parsed
  object — `attempt.raw.includes('isCorrect')` is false, and so is the
  explanation text. That is the bytes the browser receives, which is where a leak
  would actually be.

Time is server-owned. `started_at` is written by the database, the limit is
checked against it on submit with a 30-second grace, and the countdown the
student sees is decoration. Answers arriving after the grace window count as
unanswered rather than voiding the attempt — discarding it would be
indistinguishable from losing it to a bad connection, and Section 1.4 names
uneven connectivity as a constraint.

Marks are integer hundredths end to end (`packages/shared/src/marks.ts`). A quiz
totalling 12.3 that computes 12.299999 fails a pass mark it should clear, and
pass/fail decides whether a certificate is issued.

Certificate numbers carry **32 random bits**, not a sequence. The verification
page is public and unauthenticated — that is the point of a certificate — so a
sequential number turns it into an enumeration endpoint that leaks every
student's name and course. Revocation reports `revoked` rather than 404ing: "this
was revoked" and "this never existed" are different claims and an employer needs
the right one.

An attempt with outstanding written answers reports `passed: null`, not `false`.
Showing a student a fail computed from half a score and then changing it is worse
than showing "being graded".

Not built yet in Phase 4:

- Teacher quiz builder UI, student attempt UI, grading queue UI, certificate list
- Certificate PDF generation (Section 13 wants pdf-lib into R2; no R2
  credentials yet, so there is no PDF and `pdf_r2_key` stays null)
- `CRON_SECRET` is unset in `.env.local`, so every `/cron/*` route answers 503
  (`assertCronRequest` fails closed). Certificates will not issue automatically
  until it is set. `smoke:assessment` reports this as a SKIP rather than passing
  quietly.

## Row level security was not doing anything for ten tables

Found while surveying for Phase 4, fixed in
[migration 0006](packages/db/migrations/0006_rls_assessment.sql).

`courses`, `modules`, `notifications`, `quiz_questions`, `quiz_attempts`,
`quiz_answers`, `assignment_submissions`, `course_completion_rules`, `plans` and
`doubt_replies` had RLS switched off entirely. Supabase grants `anon` SELECT on
public-schema tables by default and the anon key ships in the client bundle, so
`npm run audit:rls` confirmed the published key could read `courses`, `modules`
and `lessons` directly through PostgREST.

The Phase 3 invariant that a draft course answers 404 was being enforced **only
by the API**, and PostgREST goes around the API. `lessons_read` also allowed any
free lesson, including free lessons of an unreleased course. Both are closed, and
`audit:rls` now asserts the draft rule at the database rather than at the API.

## Decisions

Answered — see [docs/adr/](docs/adr/). These override the specification where
they conflict:

- **[ADR 0001](docs/adr/0001-notes-are-uploaded-files.md)** — notes are
  uploaded PDFs and phone photos, not rendered from an editor. Deletes the
  Section 9.3 pipeline and collapses roadmap Phase 5 into Phase 1.
- **[ADR 0002](docs/adr/0002-teacher-controlled-pricing.md)** — teachers set
  their own course prices, no approval. Promo codes deferred to the first
  post-launch phase.
- **[ADR 0003](docs/adr/0003-teacher-collected-payments.md)** — teachers publish
  their own bKash/Nagad/Rocket numbers, verify their own course payments, and
  grant access by hand. Money never transits the platform.
- **[ADR 0004](docs/adr/0004-assignment-resubmission-locks-on-grading.md)** —
  assignment resubmission is open until a teacher awards a mark, then locked.
  Takes Section 11's stated default rather than overriding it.

Still open, from Section 22.1:

1. Bangladeshi business entity for SSLCommerz? (long lead time — start now)
2. Mac access for iOS builds? (blocks Phase 8)
3. Assignment resubmission — until graded, or unlimited? (blocks Phase 7)
4. Subscription price point in BDT (drives the Bunny.net evaluation)
5. Do lapsed subscribers keep access to completed courses?

## Known gap

A course with `price_poisha = 0` still requires an entitlement — the
entitlement engine checks `lessons.is_free` but not a zero course price. Close
this in Phase 2 (ADR 0002).
