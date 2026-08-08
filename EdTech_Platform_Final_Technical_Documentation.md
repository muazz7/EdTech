# Master EdTech Platform — Final Technical Documentation

**Version:** 1.0 (final)
**Supersedes:** *Master EdTech Platform Architecture & Financial Blueprint* (draft)
**Owner:** Muaz
**Build model:** Solo developer
**Target scale:** 100 → 500 active students, a small number of teachers under one brand

---

## 0. How to read this document

This is the complete build specification. It is written to be executed in order — Section 21 is the roadmap, and every other section is reference material that roadmap points into.

Three things changed materially from your draft, and you should read these before anything else:

1. **Video self-hosting is out, and that was the right call.** Your memory of this project still had "self-host all video from own servers." That is not achievable with real DRM — Widevine and FairPlay require licensed key servers that Google and Apple do not hand to individual developers. VdoCipher (or a peer) is not a convenience choice, it is the only realistic path to hardware DRM. Section 3.4.
2. **The cost model in your draft understates video bandwidth by roughly 2×, and VdoCipher does not bill monthly.** It sells annual prepaid bandwidth+storage credits. Section 20 rebuilds the model with the arithmetic shown.
3. **"100% blocked" is not a claim you can defend.** The draft's anti-piracy summary overstates what DRM does. Section 17 gives you the honest matrix — what is hard-blocked, what is deterred, and what is simply not preventable. You need this precision when a teacher asks you directly.

Anything marked **[CONFIRM]** is an assumption I made to keep the document complete. Correct me and I will revise.

---

## 1. Product definition

### 1.1 What this is

A single-brand, closed online course platform for Bangladesh. A small group of teachers publish recorded video lectures, PDFs, and written notes under one brand. Students buy access — by subscription, by lifetime all-access, or by individual course — and consume that content inside a piracy-hardened player on web, Android, and iOS.

### 1.2 What this is not

- **Not a marketplace.** Teachers are invited by you, not self-registered. No teacher payout system, no revenue splits, no teacher onboarding funnel. This removes an enormous amount of scope.
- **Not live.** No live classes, no scheduled sessions, no video conferencing. Recorded content only.
- **Not automated commerce.** v1 has no payment gateway. Payments are confirmed by a human.

### 1.3 Actors

| Role | Who | Capabilities |
|---|---|---|
| **Owner / Admin** | You | Everything. Creates teacher accounts, verifies payments, manages plans and pricing, sees all analytics, revokes access. |
| **Teacher** | Invited instructors | Creates and publishes own courses, uploads content, authors quizzes and assignments, grades submissions, answers doubts, sees own course analytics. Cannot see other teachers' courses, cannot verify payments, cannot change pricing. |
| **Student** | Paying and free users | Browses catalog, consumes free resources, submits payment proof, consumes entitled content, takes quizzes, submits assignments, asks doubts, earns certificates. |

**[CONFIRM]** Should teachers be able to set their own course prices, or does the Owner control all pricing centrally? I have specified **Owner controls pricing**, teacher proposes. This is the safer default for a single brand.

### 1.4 The four constraints that shaped every decision

1. **Solo developer.** Every choice below optimizes for one person shipping and maintaining it. This is why there is no microservice architecture, no Kubernetes, no separate API repo, and no self-managed database.
2. **Bangladesh market.** Manual mobile-money payment is normal here and expected by students. Bandwidth is uneven, so adaptive bitrate and low-quality fallbacks matter. Android dominates; iOS is a minority but a prestige signal.
3. **Piracy is the existential risk.** Course content leaking to Telegram groups is the failure mode that kills this business. Security is not a feature layer, it is the spine.
4. **Three client platforms at launch.** This is the single largest cost in your plan and Section 21 pushes back on it.

### 1.5 Non-goals for v1.0 (explicitly deferred)

Live classes · teacher payouts · affiliate/referral system · coupon codes · multi-language UI · offline video download · AI features · course reviews and ratings · public teacher profiles · student-to-student messaging.

---

## 2. Feature inventory

### 2.1 Owner / Admin console

| Feature | Detail |
|---|---|
| Payment verification queue | The operational heart of v1. List of pending payment submissions with proof screenshot, transaction ID, amount, student, target plan/course. One-click approve or reject-with-reason. |
| Teacher management | Create teacher accounts, deactivate, reset access. |
| Plan & pricing management | Define subscription plans, lifetime all-access price, per-course prices. Set currency (BDT), effective dates. |
| Student management | Search students, view entitlements, manually grant or revoke access, view device history, force-logout. |
| Content oversight | Publish/unpublish any course, feature courses on the catalog, curate the Free Resource Center. |
| Platform analytics | Revenue by period, active entitlements, expiring subscriptions, watch hours consumed (against VdoCipher credit), storage used, top courses. |
| Piracy signals dashboard | Accounts flagged for device-switch abuse, concurrent-IP anomalies, abnormal watch patterns. Section 17.5. |
| Audit log | Every privileged action, immutable. |

### 2.2 Teacher portal

| Feature | Detail |
|---|---|
| Course builder | Create course → modules → lessons. Drag-and-drop reordering at both levels. Draft/published state per course and per lesson. |
| Video upload | Resumable, direct-to-VdoCipher using short-lived upload credentials issued by your API. The file never touches your server. Progress bar, retry on network drop, transcoding status polling. |
| Document upload | PDFs and images uploaded direct-to-R2 via presigned PUT. Same principle: no server relay. |
| Note authoring | Rich-text editor. On save, the note is rendered server-side to page images and stored in R2. Section 9.3. |
| Free-preview toggle | Per lesson. Marks content as publicly readable without entitlement. |
| Quiz builder | MCQ (single/multi answer), true-false, short answer, long answer. Per-question marks, explanation text, optional time limit, pass mark, attempt limit. |
| Assignment builder | Title, instructions, attachment, due date, max marks, accepted file types. |
| Grading workspace | Queue of ungraded submissions and written quiz answers. Marks + feedback. |
| Doubt inbox | Threaded questions from students on their lessons. Answer, pin, mark resolved. |
| Course analytics | Enrollment count, completion rate, per-lesson drop-off, average quiz score, most-asked doubts. |

### 2.3 Student experience (web + mobile, feature-identical)

| Feature | Detail |
|---|---|
| Signup / login | Phone number + OTP as primary (this is what Bangladeshi students actually have), email + password as secondary. |
| Catalog | All courses, with clear price and access-type badges. |
| Free Resource Center | Curated free lessons, sample PDFs, intro notes. Accessible without payment — this is your conversion funnel. |
| Purchase flow | Select plan or course → see payment instructions → submit transaction ID + proof screenshot → pending state with clear expectation of verification time. Section 8. |
| My Courses | Entitled courses with progress bars, continue-where-you-left-off, module checklists. |
| Video player | DRM player with dynamic watermark, speed control, quality selector, resume position, keyboard shortcuts. |
| Document viewer | Canvas-rendered PDF and image viewer with watermark overlay. |
| Quizzes | Timed attempts, autosave, instant MCQ results, pending state for written answers. |
| Assignments | Upload submission, view marks and teacher feedback. |
| Doubts | Ask on a lesson, see teacher replies, see other students' resolved doubts on the same lesson. |
| Certificates | Auto-issued on course completion criteria. Downloadable PDF with a public verification URL. |
| Account | Profile, active device, entitlement status with expiry date, payment history. |

---

## 3. Technology stack — final selection

### 3.1 The stack

| Layer | Choice | Version target |
|---|---|---|
| Web frontend | **Next.js (App Router) + TypeScript** | 15.x |
| Web styling | **Tailwind CSS + shadcn/ui** | Tailwind 4.x |
| Web state/data | **TanStack Query** + React Server Components | 5.x |
| Forms & validation | **react-hook-form + Zod** (Zod schemas shared with API) | — |
| Backend API | **Next.js Route Handlers** at `/api/v1/*` — one API serving both web and mobile | — |
| Database | **PostgreSQL via Supabase** | PG 15+ |
| ORM / query layer | **Drizzle ORM** | latest |
| Auth identity | **Supabase Auth** (phone OTP + email/password) | — |
| Session enforcement | **Custom `active_sessions` table + API middleware** | Section 6 |
| Video DRM | **VdoCipher** | — |
| Object storage | **Cloudflare R2** + presigned URLs | — |
| Mobile | **Flutter** (single codebase → Android + iOS) | 3.2x |
| Mobile state | **Riverpod** + **dio** + **go_router** | — |
| Mobile video | **`vdocipher_flutter` official SDK** | — |
| Background jobs | **Vercel Cron + a Postgres job table** (`jobs`), upgraded to **Upstash QStash** if throughput demands | — |
| Transactional email | **Resend** | — |
| SMS / OTP | **Local BD gateway** (Alpha Net SMS, BulkSMSBD, or MIM SMS) | — |
| Push notifications | **Firebase Cloud Messaging** | — |
| PDF generation (certificates) | **pdf-lib** with a pre-built template PDF | — |
| Note → image rendering | **Satori + resvg-js** (pure JS, serverless-safe) | — |
| Error monitoring | **Sentry** (web, API, and Flutter) | — |
| Logs & uptime | **Better Stack** free tier | — |
| Hosting (web + API) | **Vercel** | — |
| DNS, CDN, WAF | **Cloudflare** | — |
| Repo | **Single monorepo**, `apps/web`, `apps/mobile`, `packages/shared` | — |

### 3.2 Why a single Next.js app is the backend

The instinct is to build a separate Node API for the mobile app to talk to. For a solo developer, that is the wrong trade. Route Handlers give you:

- One deployment, one set of environment variables, one CI pipeline.
- Zod schemas defined once in `packages/shared`, used for validation on the server, typed client calls on web, and code-generated Dart models for Flutter.
- No CORS, no service-to-service auth, no version skew between two codebases you maintain alone.

The Flutter app calls exactly the same `/api/v1/*` endpoints the web app does. The web app is a client of its own API, not a special case.

**The honest limits.** Vercel serverless functions have execution ceilings (10s on Hobby, 60s on Pro) and cold starts. This matters for three operations: certificate PDF generation, note-to-image rendering, and bulk exports. All three are pushed to the job queue and run asynchronously. Nothing in the request path is allowed to be slow.

**The escape hatch.** If you outgrow this, the Route Handlers lift almost unchanged into a Hono or Fastify service on Render or Fly.io. Keep business logic in `packages/core` (framework-agnostic functions) and the Route Handlers as thin adapters, and this migration is a weekend, not a rewrite. Do this from day one — it costs nothing and buys you the option.

### 3.3 Why Supabase and not raw Postgres or Firebase

**Against Firebase:** your entire access model is relational. "Does this student have a valid entitlement for this lesson, via a subscription, a lifetime pass, or a single-course purchase, and is that entitlement unexpired?" is a join. Firestore makes this a denormalization nightmare with consistency bugs you will not find until a student sees content they did not pay for.

**Against raw managed Postgres (Neon, Render, DigitalOcean):** those are also fine, and marginally cheaper. Supabase wins on bundled Auth (phone OTP is otherwise real work), Row Level Security as a second line of defense behind your API, a usable admin table editor for your own operational needs, and instant Postgres backups. As a solo dev, the operational savings exceed the price delta.

**One warning:** do not let Supabase's client-side SDK become your data layer. Students must never query the database directly from the browser or app. All reads and writes go through your API, which holds the service role key. RLS is a safety net for when you make a mistake, not the primary access control. Section 7.

### 3.4 Why VdoCipher, and what the alternatives actually are

Hardware DRM (Widevine L1, FairPlay) requires a licensed key server. Google and Apple license these to companies with contractual and infrastructure commitments; you cannot obtain one as an individual developer in Dhaka. Every "secure self-hosted video" tutorial you will find implements AES-128 HLS encryption, which is trivially defeated — the key is fetched over HTTP by the player and can be captured with browser devtools in under a minute. **AES-128 HLS is not DRM.** This is the single most important technical fact in the document.

So the real choice is which DRM vendor:

| Vendor | Position |
|---|---|
| **VdoCipher** ✅ | Purpose-built for the exact use case (Indian/South Asian edtech), Flutter SDK, dynamic watermarking built in, OTP playback API, priced for SMB. Chosen. |
| **Bunny.net Stream** | Substantially cheaper delivery, DRM available as a paid add-on. **Worth getting a quote before you commit** — at Tier 3–4 volumes the difference could be several hundred dollars a year. Weaker Flutter DRM story than VdoCipher. |
| **Gumlet** | Comparable to VdoCipher, similar market. Reasonable second quote. |
| **Mux** | Excellent engineering, but DRM sits behind enterprise pricing. Too expensive here. |
| **Cloudflare Stream** | Cheap and good, but **no Widevine/FairPlay DRM** — signed URLs only. Does not meet your requirement. |

**Recommendation:** get written quotes from VdoCipher *and* Bunny before purchasing your first annual credit, using the bandwidth numbers in Section 20. Build against an internal `VideoProvider` interface so the vendor is one adapter file, not a hundred call sites.

---

## 4. System architecture

```
┌─────────────────┐   ┌─────────────────┐
│   Next.js Web   │   │   Flutter App   │
│  (browser, PWA) │   │  (Android/iOS)  │
└────────┬────────┘   └────────┬────────┘
         │                     │
         │   HTTPS, JWT + X-Session-Id
         └──────────┬──────────┘
                    ▼
      ┌──────────────────────────────┐
      │   API  /api/v1/*             │  ← Vercel, edge-cached where safe
      │   ┌────────────────────────┐ │
      │   │ auth & session guard   │ │
      │   │ entitlement engine     │ │  ← the security control point
      │   │ rate limiter           │ │
      │   └────────────────────────┘ │
      └───┬───────┬───────┬──────┬───┘
          │       │       │      │
          ▼       ▼       ▼      ▼
   ┌──────────┐ ┌──────┐ ┌────┐ ┌──────────┐
   │ Postgres │ │ Vdo  │ │ R2 │ │ Resend / │
   │(Supabase)│ │Cipher│ │    │ │ SMS / FCM│
   └──────────┘ └──────┘ └────┘ └──────────┘
                    │       │
                    ▼       ▼
              Global CDN delivery
              direct to client
```

**The one rule that defines this architecture:** no media byte ever passes through your server. Uploads go client → VdoCipher/R2 directly using short-lived credentials your API issues. Downloads go CDN → client directly using short-lived OTPs or signed URLs your API issues. Your server only ever issues and revokes permission. This is what keeps a $12/month backend able to serve 500 students.

### 4.1 The three canonical request flows

**A. Student plays a video**
```
1. Client → GET /api/v1/lessons/:id/playback
2. API: validate JWT → validate X-Session-Id against active_sessions
3. API: resolve entitlement (subscription | lifetime | course | is_free)
4. API: build watermark payload (name, phone, IP, timestamp)
5. API → VdoCipher: POST /videos/:id/otp  { annotate: watermark, ttl: 300 }
6. API → Client: { otp, playbackInfo }          ← never the video ID alone
7. Client player → VdoCipher CDN: fetch manifest + encrypted segments
8. Client CDM → license server: request decryption key
9. Playback. API logs a watch_event.
```
The OTP is single-use and short-lived. Even if intercepted, it grants one playback session on one device.

**B. Student opens a PDF or note**
```
1. Client → GET /api/v1/lessons/:id/asset
2. API: same auth + session + entitlement checks
3. API → R2: generate presigned GET, TTL 900s, response-content-disposition: inline
4. API → Client: { url, watermark: { name, phone, issuedAt } }
5. Client: fetch bytes → render to <canvas> via PDF.js → overlay watermark
```

**C. Teacher uploads a video**
```
1. Client → POST /api/v1/teacher/lessons/:id/upload-credentials
2. API: verify caller is the owning teacher
3. API → VdoCipher: PUT /videos?title=...     → returns clientPayload
4. API → Client: { clientPayload }              (valid ~6 hours)
5. Client → VdoCipher storage: multipart resumable upload
6. Client → POST /api/v1/teacher/lessons/:id/upload-complete { videoId }
7. API: store vdocipher_video_id, set status = 'transcoding'
8. Cron job polls VdoCipher status → flips to 'ready', notifies teacher
```

---

## 5. Data model

PostgreSQL. All IDs are UUID v7 (time-sortable, index-friendly). All timestamps `timestamptz`. Money stored as `integer` in **poisha** (1 BDT = 100 poisha) — never floats.

### 5.1 Identity & access

```sql
-- Supabase auth.users holds credentials. This is your application profile.
CREATE TYPE user_role AS ENUM ('student', 'teacher', 'admin');

CREATE TABLE profiles (
  id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name       text NOT NULL,
  phone           text UNIQUE,
  email           text UNIQUE,
  role            user_role NOT NULL DEFAULT 'student',
  avatar_url      text,
  institution     text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON profiles (role) WHERE is_active;

CREATE TABLE active_sessions (
  id                  uuid PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  device_fingerprint  text NOT NULL,
  device_label        text,              -- "Redmi Note 12", "Chrome on Windows"
  platform            text NOT NULL,     -- 'web' | 'android' | 'ios'
  ip_address          inet,
  user_agent          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_active_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at          timestamptz,
  revoked_reason      text
);
CREATE UNIQUE INDEX one_live_session_per_user
  ON active_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX ON active_sessions (user_id, created_at DESC);
```

That partial unique index is the single-device rule expressed in the schema itself. The database will not permit two live sessions for one user, regardless of application bugs.

### 5.2 Content

```sql
CREATE TYPE lesson_type AS ENUM ('video', 'pdf', 'note', 'image', 'quiz', 'assignment');
CREATE TYPE publish_state AS ENUM ('draft', 'published', 'archived');

CREATE TABLE courses (
  id              uuid PRIMARY KEY,
  slug            text UNIQUE NOT NULL,
  title           text NOT NULL,
  subtitle        text,
  description     text,
  thumbnail_key   text,                  -- R2 object key
  teacher_id      uuid NOT NULL REFERENCES profiles(id),
  subject         text,
  level           text,                  -- 'HSC', 'SSC', 'Admission', ...
  price_poisha    integer NOT NULL DEFAULT 0,   -- single-course lifetime price
  is_in_all_access boolean NOT NULL DEFAULT true, -- included in subscription/lifetime-all
  state           publish_state NOT NULL DEFAULT 'draft',
  display_order   integer NOT NULL DEFAULT 0,
  published_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON courses (state, display_order);
CREATE INDEX ON courses (teacher_id);

CREATE TABLE modules (
  id              uuid PRIMARY KEY,
  course_id       uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title           text NOT NULL,
  description     text,
  display_order   integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON modules (course_id, display_order);

CREATE TABLE lessons (
  id                  uuid PRIMARY KEY,
  module_id           uuid NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  course_id           uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE, -- denormalized
  title               text NOT NULL,
  description         text,
  type                lesson_type NOT NULL,
  display_order       integer NOT NULL,
  is_free             boolean NOT NULL DEFAULT false,
  is_published        boolean NOT NULL DEFAULT false,

  -- video
  vdocipher_video_id  text,
  duration_seconds    integer,
  video_status        text,              -- 'uploading'|'transcoding'|'ready'|'failed'
  is_short_form       boolean NOT NULL DEFAULT false,

  -- document / image / note
  r2_object_key       text,
  page_count          integer,
  file_size_bytes     bigint,
  mime_type           text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON lessons (module_id, display_order);
CREATE INDEX ON lessons (course_id) WHERE is_published;
CREATE INDEX ON lessons (course_id) WHERE is_free AND is_published;

-- Notes render to N page images; this holds them.
CREATE TABLE note_pages (
  id            uuid PRIMARY KEY,
  lesson_id     uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  page_number   integer NOT NULL,
  r2_object_key text NOT NULL,
  width         integer,
  height        integer,
  UNIQUE (lesson_id, page_number)
);

-- Source of truth for the note editor, so teachers can re-edit.
CREATE TABLE note_sources (
  lesson_id     uuid PRIMARY KEY REFERENCES lessons(id) ON DELETE CASCADE,
  content_json  jsonb NOT NULL,        -- Tiptap document
  render_status text NOT NULL DEFAULT 'pending',
  rendered_at   timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
```

### 5.3 Commerce & entitlements

This is the part your draft's schema did not cover, and it is where the three access models you chose live.

```sql
CREATE TYPE plan_kind AS ENUM ('subscription', 'lifetime_all', 'single_course');

CREATE TABLE plans (
  id              uuid PRIMARY KEY,
  kind            plan_kind NOT NULL,
  name            text NOT NULL,          -- "Monthly All-Access"
  description     text,
  price_poisha    integer NOT NULL,
  duration_days   integer,                -- 30 for monthly; NULL = forever
  is_active       boolean NOT NULL DEFAULT true,
  display_order   integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE entitlement_source AS ENUM ('purchase', 'manual_grant', 'promo', 'migration');

-- ONE table for all three access models. This is deliberate.
CREATE TABLE entitlements (
  id              uuid PRIMARY KEY,
  student_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind            plan_kind NOT NULL,
  course_id       uuid REFERENCES courses(id) ON DELETE CASCADE, -- only for single_course
  plan_id         uuid REFERENCES plans(id),
  payment_id      uuid,                   -- FK added after payments table
  source          entitlement_source NOT NULL DEFAULT 'purchase',
  granted_by      uuid REFERENCES profiles(id),
  starts_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,            -- NULL = lifetime
  revoked_at      timestamptz,
  revoked_reason  text,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT single_course_needs_course
    CHECK ((kind = 'single_course') = (course_id IS NOT NULL)),
  CONSTRAINT lifetime_has_no_expiry
    CHECK (kind = 'subscription' OR expires_at IS NULL)
);
CREATE INDEX ON entitlements (student_id) WHERE revoked_at IS NULL;
CREATE INDEX ON entitlements (expires_at) WHERE revoked_at IS NULL AND expires_at IS NOT NULL;
CREATE INDEX ON entitlements (course_id) WHERE kind = 'single_course';
```

Modelling all three as rows in one table means the entitlement check is a single query with no branching, and a student can hold several simultaneously (an expired subscription plus a lifetime single-course purchase, for example) without any special-case code.

### 5.4 Manual payments

```sql
CREATE TYPE payment_channel AS ENUM ('bkash', 'nagad', 'rocket', 'bank', 'cash', 'other');
CREATE TYPE payment_status  AS ENUM ('pending', 'verified', 'rejected', 'expired');

CREATE TABLE payments (
  id                  uuid PRIMARY KEY,
  reference_code      text UNIQUE NOT NULL,   -- "PAY-8FK2QX", shown to the student
  student_id          uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  plan_id             uuid REFERENCES plans(id),
  course_id           uuid REFERENCES courses(id),
  amount_poisha       integer NOT NULL,
  currency            char(3) NOT NULL DEFAULT 'BDT',

  -- manual submission
  channel             payment_channel NOT NULL,
  sender_number       text,
  transaction_id      text,
  proof_r2_key        text,
  student_note        text,
  submitted_at        timestamptz NOT NULL DEFAULT now(),

  -- verification
  status              payment_status NOT NULL DEFAULT 'pending',
  reviewed_by         uuid REFERENCES profiles(id),
  reviewed_at         timestamptz,
  rejection_reason    text,

  -- reserved for a future gateway; nullable today, no migration later
  gateway             text,
  gateway_tx_id       text,
  gateway_payload     jsonb,

  created_at          timestamptz NOT NULL DEFAULT now()
);
-- Same transaction ID cannot be claimed twice on the same channel.
CREATE UNIQUE INDEX uniq_channel_txid
  ON payments (channel, transaction_id)
  WHERE transaction_id IS NOT NULL AND status <> 'rejected';
CREATE INDEX ON payments (status, submitted_at) WHERE status = 'pending';
CREATE INDEX ON payments (student_id, created_at DESC);

ALTER TABLE entitlements
  ADD CONSTRAINT fk_entitlement_payment
  FOREIGN KEY (payment_id) REFERENCES payments(id);
```

The nullable `gateway_*` columns are the cheapest insurance in this document. When you add SSLCommerz or bKash Merchant in v1.5, the payments table does not change — you write a webhook handler that inserts a row with `status = 'verified'` and skips the review step.

### 5.5 Progress, assessment, and everything else

```sql
CREATE TABLE lesson_progress (
  student_id        uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  lesson_id         uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  course_id         uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  seconds_watched   integer NOT NULL DEFAULT 0,
  last_position     integer NOT NULL DEFAULT 0,
  is_complete       boolean NOT NULL DEFAULT false,
  completed_at      timestamptz,
  first_opened_at   timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, lesson_id)
);
CREATE INDEX ON lesson_progress (student_id, course_id);

-- Append-only, used for analytics AND piracy signals. Partition by month.
CREATE TABLE watch_events (
  id            bigserial PRIMARY KEY,
  student_id    uuid NOT NULL,
  lesson_id     uuid NOT NULL,
  session_id    uuid,
  event         text NOT NULL,   -- 'play'|'pause'|'seek'|'heartbeat'|'ended'
  position      integer,
  playback_rate numeric(3,1),
  ip_address    inet,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON watch_events (student_id, created_at DESC);

-- QUIZZES
CREATE TYPE question_type AS ENUM ('mcq_single','mcq_multi','true_false','short_answer','long_answer');

CREATE TABLE quizzes (
  id                 uuid PRIMARY KEY,
  lesson_id          uuid UNIQUE REFERENCES lessons(id) ON DELETE CASCADE,
  course_id          uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title              text NOT NULL,
  instructions       text,
  time_limit_minutes integer,
  pass_percentage    integer NOT NULL DEFAULT 40,
  max_attempts       integer NOT NULL DEFAULT 1,
  shuffle_questions  boolean NOT NULL DEFAULT true,
  show_answers_after boolean NOT NULL DEFAULT true,
  is_published       boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quiz_questions (
  id             uuid PRIMARY KEY,
  quiz_id        uuid NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  type           question_type NOT NULL,
  prompt         text NOT NULL,
  image_r2_key   text,
  marks          numeric(5,2) NOT NULL DEFAULT 1,
  explanation    text,
  display_order  integer NOT NULL
);

CREATE TABLE quiz_options (
  id             uuid PRIMARY KEY,
  question_id    uuid NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
  label          text NOT NULL,
  is_correct     boolean NOT NULL DEFAULT false,
  display_order  integer NOT NULL
);

CREATE TABLE quiz_attempts (
  id                uuid PRIMARY KEY,
  quiz_id           uuid NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  student_id        uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  attempt_number    integer NOT NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  submitted_at      timestamptz,
  auto_score        numeric(6,2),
  manual_score      numeric(6,2),
  total_score       numeric(6,2),
  max_score         numeric(6,2),
  passed            boolean,
  grading_status    text NOT NULL DEFAULT 'pending', -- 'pending'|'partial'|'complete'
  UNIQUE (quiz_id, student_id, attempt_number)
);

CREATE TABLE quiz_answers (
  id              uuid PRIMARY KEY,
  attempt_id      uuid NOT NULL REFERENCES quiz_attempts(id) ON DELETE CASCADE,
  question_id     uuid NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
  selected_options uuid[],
  text_answer     text,
  awarded_marks   numeric(5,2),
  teacher_feedback text,
  graded_by       uuid REFERENCES profiles(id),
  graded_at       timestamptz,
  UNIQUE (attempt_id, question_id)
);

-- ASSIGNMENTS
CREATE TABLE assignments (
  id                uuid PRIMARY KEY,
  lesson_id         uuid UNIQUE REFERENCES lessons(id) ON DELETE CASCADE,
  course_id         uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title             text NOT NULL,
  instructions      text NOT NULL,
  attachment_r2_key text,
  due_at            timestamptz,
  max_marks         numeric(5,2) NOT NULL DEFAULT 100,
  allowed_mime      text[] NOT NULL DEFAULT ARRAY['application/pdf','image/jpeg','image/png'],
  max_file_mb       integer NOT NULL DEFAULT 10,
  allow_late        boolean NOT NULL DEFAULT true,
  is_published      boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assignment_submissions (
  id               uuid PRIMARY KEY,
  assignment_id    uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  files            jsonb NOT NULL,        -- [{r2_key, name, size, mime}]
  student_note     text,
  submitted_at     timestamptz NOT NULL DEFAULT now(),
  is_late          boolean NOT NULL DEFAULT false,
  marks            numeric(5,2),
  teacher_feedback text,
  graded_by        uuid REFERENCES profiles(id),
  graded_at        timestamptz,
  UNIQUE (assignment_id, student_id)
);

-- DOUBTS / DISCUSSION
CREATE TABLE doubt_threads (
  id            uuid PRIMARY KEY,
  lesson_id     uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  course_id     uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  student_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title         text NOT NULL,
  body          text NOT NULL,
  is_resolved   boolean NOT NULL DEFAULT false,
  is_pinned     boolean NOT NULL DEFAULT false,
  is_public     boolean NOT NULL DEFAULT true,   -- visible to other enrolled students
  reply_count   integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON doubt_threads (lesson_id, created_at DESC) WHERE is_public;
CREATE INDEX ON doubt_threads (course_id) WHERE NOT is_resolved;

CREATE TABLE doubt_replies (
  id             uuid PRIMARY KEY,
  thread_id      uuid NOT NULL REFERENCES doubt_threads(id) ON DELETE CASCADE,
  author_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  body           text NOT NULL,
  image_r2_key   text,
  is_teacher_answer boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- CERTIFICATES
CREATE TABLE certificates (
  id              uuid PRIMARY KEY,
  certificate_no  text UNIQUE NOT NULL,   -- "CERT-2026-000418"
  student_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course_id       uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  student_name    text NOT NULL,          -- snapshot at issue time
  course_title    text NOT NULL,          -- snapshot
  teacher_name    text NOT NULL,          -- snapshot
  final_score     numeric(5,2),
  issued_at       timestamptz NOT NULL DEFAULT now(),
  pdf_r2_key      text,
  revoked_at      timestamptz,
  UNIQUE (student_id, course_id)
);

CREATE TABLE course_completion_rules (
  course_id            uuid PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
  min_lessons_percent  integer NOT NULL DEFAULT 90,
  require_all_quizzes  boolean NOT NULL DEFAULT true,
  min_quiz_average     integer NOT NULL DEFAULT 40,
  require_assignments  boolean NOT NULL DEFAULT false,
  issues_certificate   boolean NOT NULL DEFAULT true
);

-- OPS
CREATE TABLE notifications (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type        text NOT NULL,
  title       text NOT NULL,
  body        text,
  link        text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;

CREATE TABLE jobs (
  id            uuid PRIMARY KEY,
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'queued',
  attempts      integer NOT NULL DEFAULT 0,
  run_after     timestamptz NOT NULL DEFAULT now(),
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
CREATE INDEX ON jobs (status, run_after) WHERE status IN ('queued','failed');

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  actor_id     uuid REFERENCES profiles(id),
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    uuid,
  before       jsonb,
  after        jsonb,
  ip_address   inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (entity_type, entity_id, created_at DESC);
```

---

## 6. Authentication & single-device sessions

### 6.1 Identity

**Primary: phone + OTP.** Bangladeshi students reliably have a phone number and unreliably have an email they check. Supabase Auth handles the OTP lifecycle; you plug in a local SMS gateway as the provider (Supabase's default Twilio path is expensive for BD numbers — configure a custom SMS hook pointing at Alpha Net or BulkSMSBD).

**Secondary: email + password.** For teachers and admins, and as a student fallback.

Both paths land in the same `auth.users` row and the same `profiles` row.

### 6.2 The token model

| Token | Lifetime | Storage (web) | Storage (mobile) |
|---|---|---|---|
| Access JWT | 15 min | in-memory only | in-memory only |
| Refresh token | 30 days, rotating | httpOnly, Secure, SameSite=Lax cookie | `flutter_secure_storage` (Keychain / EncryptedSharedPreferences) |
| Session ID | until revoked | httpOnly cookie | secure storage |

Never put the access token in `localStorage`. An XSS bug there hands an attacker a working session.

### 6.3 Single-device enforcement — and why "last login wins" is not enough

Every authenticated request carries `X-Session-Id`. Middleware runs on every `/api/v1/*` call:

```ts
// packages/core/auth/guard.ts
export async function guardRequest(req: Request) {
  const claims = await verifyAccessToken(req);            // signature + exp
  const sessionId = req.headers.get('x-session-id');
  if (!sessionId) throw new ApiError(401, 'SESSION_MISSING');

  const session = await db.query.activeSessions.findFirst({
    where: and(
      eq(activeSessions.id, sessionId),
      eq(activeSessions.userId, claims.sub),
      isNull(activeSessions.revokedAt),
    ),
  });
  if (!session) throw new ApiError(401, 'SESSION_REVOKED');

  // throttled write — once per 60s, not on every request
  void touchSession(session.id, req);
  return { user: claims, session };
}
```

On login, inside one transaction: revoke any existing live session for that user with `revoked_reason = 'new_device'`, insert the new one, push an FCM message to the old device so it logs out immediately rather than on next request.

**Now the part your draft missed.** Last-login-wins does not stop credential sharing. Two students sharing one account simply take turns — each login kicks the other out, and both still get the full course. The countermeasure is switching *friction*:

```sql
-- Rolling 30-day device-switch budget
CREATE TABLE device_switch_log (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  from_fingerprint   text,
  to_fingerprint     text NOT NULL,
  ip_address         inet,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON device_switch_log (user_id, created_at DESC);
```

Policy: **4 distinct device fingerprints per rolling 30 days.** Switching between already-seen devices is free. A fifth new device blocks login with a message directing the student to support, where you unblock it manually after asking a question. Legitimate students hit this roughly never — a phone, a laptop, maybe a college computer. Sharers hit it constantly.

Add **device binding on mobile**: the Flutter app registers a stable install ID at first launch and sends it as the fingerprint. On web, use a coarse fingerprint (a random ID persisted in an httpOnly cookie plus a UA hash) — deliberately coarse, because aggressive browser fingerprinting is fragile and generates false positives that punish real students.

### 6.4 Rate limits

| Endpoint class | Limit |
|---|---|
| OTP request | 3 / phone / 15 min, 10 / IP / hour |
| Login attempt | 10 / IP / 15 min |
| Playback OTP | 60 / user / hour |
| Signed asset URL | 120 / user / hour |
| Payment submission | 5 / user / day |
| Everything else | 300 / user / min |

Implement with Upstash Redis (free tier is sufficient) or Cloudflare Rate Limiting rules at the edge. Do both: edge rules stop volumetric abuse before it costs you a function invocation.

---

## 7. Entitlement engine

Everything gated flows through one function. Not two, not a helper per feature — one.

```ts
type AccessResult =
  | { allowed: true;  via: 'free' | 'subscription' | 'lifetime_all' | 'single_course' | 'manual' | 'owner' }
  | { allowed: false; reason: 'no_entitlement' | 'expired' | 'revoked' | 'unpublished' };

export async function checkLessonAccess(
  userId: string,
  lessonId: string,
): Promise<AccessResult> {
  const lesson = await getLessonWithCourse(lessonId);
  if (!lesson || lesson.course.state !== 'published' || !lesson.isPublished) {
    return { allowed: false, reason: 'unpublished' };
  }

  const profile = await getProfile(userId);
  if (profile.role === 'admin') return { allowed: true, via: 'owner' };
  if (profile.role === 'teacher' && lesson.course.teacherId === userId) {
    return { allowed: true, via: 'owner' };
  }

  if (lesson.isFree) return { allowed: true, via: 'free' };

  const now = new Date();
  const ents = await db.query.entitlements.findMany({
    where: and(
      eq(entitlements.studentId, userId),
      isNull(entitlements.revokedAt),
      lte(entitlements.startsAt, now),
      or(isNull(entitlements.expiresAt), gt(entitlements.expiresAt, now)),
    ),
  });

  for (const e of ents) {
    if (e.kind === 'single_course' && e.courseId === lesson.courseId)
      return { allowed: true, via: 'single_course' };
    if (e.kind === 'lifetime_all' && lesson.course.isInAllAccess)
      return { allowed: true, via: 'lifetime_all' };
    if (e.kind === 'subscription' && lesson.course.isInAllAccess)
      return { allowed: true, via: 'subscription' };
    if (e.source === 'manual_grant' &&
        (!e.courseId || e.courseId === lesson.courseId))
      return { allowed: true, via: 'manual' };
  }

  const hadExpired = ents.length === 0 && await hasExpiredEntitlement(userId);
  return { allowed: false, reason: hadExpired ? 'expired' : 'no_entitlement' };
}
```

**Rules that are not negotiable:**

- This runs on the **server**, on **every** protected request. Never trust a client-side `hasAccess` flag — it exists only to decide whether to grey out a button.
- It runs immediately before issuing a VdoCipher OTP or an R2 signed URL, not at page load. A student whose subscription expires mid-session loses access on their next play, not at next login.
- Cache the result for at most **60 seconds** per `(user, course)` in Redis. Longer, and a revocation takes too long to bite.
- RLS policies mirror these rules in the database as a second layer. If your API ever has a bug that leaks a query, RLS is what stops the data walking out.

### 7.1 Row Level Security baseline

```sql
ALTER TABLE lessons ENABLE ROW LEVEL SECURITY;

CREATE POLICY lessons_read ON lessons FOR SELECT USING (
  is_free
  OR EXISTS (SELECT 1 FROM profiles p
             WHERE p.id = auth.uid() AND p.role IN ('admin'))
  OR EXISTS (SELECT 1 FROM courses c
             WHERE c.id = lessons.course_id AND c.teacher_id = auth.uid())
  OR EXISTS (
    SELECT 1 FROM entitlements e
    JOIN courses c ON c.id = lessons.course_id
    WHERE e.student_id = auth.uid()
      AND e.revoked_at IS NULL
      AND (e.expires_at IS NULL OR e.expires_at > now())
      AND (
        (e.kind = 'single_course' AND e.course_id = lessons.course_id)
        OR (e.kind IN ('lifetime_all','subscription') AND c.is_in_all_access)
      )
  )
);
```

Apply the same pattern to `note_pages`, `quizzes`, `assignments`, and `doubt_threads`.

---

## 8. Manual payment workflow

This is the operationally heaviest part of v1 and deserves real design attention, because it is where students will get stuck and where you will lose sales.

### 8.1 Student flow

```
Catalog / paywall
   └─> Choose plan (Monthly | Lifetime All-Access | This Course Only)
        └─> Payment instructions screen
             • bKash / Nagad number, shown as copyable text
             • Exact amount in BDT
             • A unique reference code (PAY-8FK2QX) to put in the reference field
             • Plain-language steps with screenshots
        └─> Submission form
             • Channel (bKash / Nagad / Rocket / Bank)
             • Sender number
             • Transaction ID
             • Screenshot upload (direct to R2 via presigned PUT, max 5 MB)
        └─> Pending screen
             • "Usually verified within 6 hours"
             • Status visible under Account → Payments
             • SMS + push when approved or rejected
```

Design details that matter:

- **Generate the reference code before the student pays**, and instruct them to put it in the mobile-money reference field. It turns your reconciliation from guesswork into a lookup.
- **Validate the transaction ID format client-side** (bKash TrxIDs are 10 alphanumeric characters). Catching a typo before submission saves a rejection cycle.
- **Never allow re-use.** The partial unique index in Section 5.4 rejects a duplicate transaction ID at the database level. Surface a clear error, not a 500.
- **Auto-expire.** A `pending` payment older than 7 days moves to `expired` via cron and notifies the student.

### 8.2 Admin verification

The queue is a single screen and should be usable on a phone, because you will be verifying payments at 11pm from bed.

Each row shows: student name and phone, amount, plan, channel, transaction ID, and the proof screenshot inline. Two buttons: **Approve** and **Reject**. Reject requires selecting a reason (wrong amount / unreadable proof / duplicate / not received / other + note).

Approve runs in one transaction:

```ts
await db.transaction(async (tx) => {
  await tx.update(payments).set({
    status: 'verified', reviewedBy: adminId, reviewedAt: new Date(),
  }).where(eq(payments.id, paymentId));

  const plan = await getPlan(payment.planId);
  const existing = await findActiveSubscription(tx, payment.studentId);

  await tx.insert(entitlements).values({
    id: uuidv7(),
    studentId: payment.studentId,
    kind: plan.kind,
    courseId: plan.kind === 'single_course' ? payment.courseId : null,
    planId: plan.id,
    paymentId: payment.id,
    source: 'purchase',
    grantedBy: adminId,
    // renewals stack onto the existing expiry, they do not restart the clock
    startsAt: existing?.expiresAt ?? new Date(),
    expiresAt: plan.durationDays
      ? addDays(existing?.expiresAt ?? new Date(), plan.durationDays)
      : null,
  });

  await tx.insert(auditLog).values({ /* ... */ });
  await enqueue(tx, 'notify.payment_approved', { paymentId: payment.id });
});
```

The stacking behaviour is important: a student who renews on day 25 of a 30-day subscription should get 35 days remaining, not 30. Getting this wrong generates support messages you do not have time for.

### 8.3 Subscription renewal without a gateway

Manual payment plus recurring subscriptions is the awkward combination in your model. There is no auto-charge, so every renewal is a fresh manual cycle. Mitigations:

| Timing | Action |
|---|---|
| T−7 days | Push + in-app banner: "Your access expires in 7 days" |
| T−3 days | Push + SMS with a one-tap deep link into the renewal screen, reference code pre-generated |
| T−1 day | Push + SMS, final |
| T+0 | Access ends. Content locks, but progress, certificates, and submissions are preserved |
| T+0 to T+3 | **Grace period** — content still accessible, prominent renewal banner. This is worth the small revenue leakage; it prevents the "I paid and got locked out while you were asleep" complaint, which is your worst support scenario |
| T+3 | Hard lock |
| T+30 | Winback SMS |

**My honest read:** manual verification is correct for your first 100–150 students and becomes a genuine bottleneck somewhere around 200 active subscribers renewing monthly. That is roughly 7 verifications a day, every day, forever. Plan to integrate **SSLCommerz** (supports bKash, Nagad, cards, ~2.5–3% per transaction, straightforward for a BD-registered business) at v1.5. The schema is already ready for it.

**[CONFIRM]** Do you have a business entity registered in Bangladesh? SSLCommerz and bKash Merchant both require trade licence and TIN. If not, that is a several-week lead time and should start now, in parallel with development — it is the long pole on your payment automation, not the code.

---

## 9. Content pipelines

### 9.1 Video

```
Teacher browser/app
   │ 1. request upload credentials  ──> API ──> VdoCipher obtainCredentials
   │ 2. resumable multipart PUT     ──────────> VdoCipher storage
   │ 3. notify complete             ──> API: lesson.video_status = 'transcoding'
   ▼
VdoCipher transcoding
   • HLS ladder: 1080p / 720p / 480p / 360p / 240p
   • 240p matters — rural BD connections are real
   • Widevine + FairPlay key wrapping
   ▼
Cron (every 5 min) polls VdoCipher for status
   • 'ready'  → lesson.video_status = 'ready', duration stored, teacher notified
   • 'failed' → teacher notified with the vendor error
   ▼
Student playback  (Section 4.1 flow A)
```

Watermark payload sent with every OTP request:

```json
{
  "annotate": "[{\"type\":\"rtext\",\"text\":\"{name} · {phone}\",\"alpha\":\"0.45\",\"color\":\"0xFFFFFF\",\"size\":\"14\",\"interval\":\"6000\"},{\"type\":\"rtext\",\"text\":\"{ip} · {timestamp}\",\"alpha\":\"0.35\",\"color\":\"0xFFFFFF\",\"size\":\"11\",\"interval\":\"9000\"}]",
  "ttl": 300
}
```

Two independent moving watermarks at different intervals are much harder to crop or blur out than one. Keep alpha high enough to survive re-encoding — 0.45 is readable in a camera recording, 0.15 is not.

**Storage sizing warning:** VdoCipher stores every rendition, so your billed storage is a multiple of your source file size, not equal to it. Users report multipliers in the range of 3–5×. **Confirm the exact multiplier with VdoCipher sales before buying your first plan** — it is the difference between a 100 GB plan and a 400 GB plan, and it is the single largest uncertainty in the cost model.

### 9.2 PDFs and images (R2)

Bucket layout, one private bucket:

```
/courses/{courseId}/lessons/{lessonId}/doc.pdf
/courses/{courseId}/lessons/{lessonId}/notes/page-001.webp
/courses/{courseId}/thumb.webp
/payments/{paymentId}/proof.jpg
/submissions/{submissionId}/{filename}
/certificates/{certificateNo}.pdf
```

- Bucket is **private**; no public access, no custom public domain.
- Uploads: presigned PUT, 15-minute TTL, `Content-Length` and `Content-Type` pinned in the signature so a client cannot upload something other than what it declared.
- Downloads: presigned GET, 15-minute TTL, issued only after `checkLessonAccess` passes.
- Images converted to WebP on upload for bandwidth (Cloudflare Images or a `sharp` job).
- R2 has **zero egress fees**, which is why it beats S3 here by a wide margin.

**Do not use the same signed URL for a whole session.** Issue a fresh one per document open. A 15-minute URL that gets pasted into a group chat is a 15-minute leak; a permanent one is a permanent leak.

### 9.3 Note-to-image converter

**[CONFIRM] — I need your input on this one.** Your draft said "written notes with note-to-image converter" and I have interpreted it as: *the teacher writes notes inside the platform using a rich-text editor, and the system converts them into protected page images so they cannot be copy-pasted as text.* That is what I have specified.

If you instead meant *teachers photograph handwritten notes and upload them*, or *teachers draw on a canvas with a stylus*, tell me — the implementation differs completely.

As specified:

```
Teacher writes in Tiptap editor (headings, bold, lists, images, LaTeX via KaTeX, tables)
   ▼ save
note_sources.content_json  +  render job enqueued
   ▼ background worker
Tiptap JSON → HTML → Satori → SVG → resvg-js → PNG, paginated at A4 @ 144 DPI
   ▼
Each page uploaded to R2, rows inserted into note_pages
   ▼
note_sources.render_status = 'rendered'
```

Satori + resvg-js is chosen over headless Chrome because it runs inside a serverless function without a 200 MB Chromium binary. The trade-off is a restricted CSS subset — no floats, limited flexbox. For notes that is acceptable; for arbitrary HTML it would not be.

Students receive page images, never the source JSON. Text is not selectable, so it cannot be bulk-copied into a competing PDF.

---

## 10. Quizzes & exams

**Attempt lifecycle:** `started → in_progress → submitted → grading → graded`

- Server generates the question set on `start`, stores the shuffled order on the attempt, and **never sends `is_correct` to the client** before submission. This is the mistake most quiz implementations make — the answers sit in the network response the whole time.
- The server records `started_at`. Time limit is enforced server-side; the client countdown is decoration. On submit, if `now > started_at + limit + 30s grace`, mark late-submitted answers as unanswered.
- Autosave each answer as the student moves through, so a dropped connection does not lose the attempt.
- MCQ and true/false auto-grade instantly. Short and long answers go to the teacher's grading queue and the attempt sits at `grading_status = 'partial'`.
- Results screen shows score, pass/fail, and per-question explanations only if `show_answers_after` is true.
- Reattempts are governed by `max_attempts`; the best attempt counts toward course completion.

---

## 11. Assignments

- Student uploads via presigned PUT direct to R2. Validate MIME against `allowed_mime` **server-side** on the presign request, not just in the file picker.
- `is_late` computed at submission against `due_at`. Late submissions accepted if `allow_late`, flagged visibly to the teacher.
- Teacher downloads via short-lived signed URL, enters marks and feedback.
- Student is notified on grading, sees marks and feedback in the lesson.
- Resubmission: allowed until graded, then locked. **[CONFIRM]** — reasonable default, tell me if you want unlimited resubmission.

---

## 12. Doubt-solving

Threaded, scoped to a lesson, visible to everyone entitled to that course when `is_public`. Public-by-default is deliberate: the same question gets asked forty times, and a searchable answered thread cuts your teachers' workload dramatically.

- Student posts a doubt on a lesson (title + body + optional image).
- Teacher sees a per-course inbox sorted by unanswered-first.
- Teacher replies; the reply is flagged `is_teacher_answer` and rendered distinctly.
- Teacher can mark resolved and pin the best threads to the top of the lesson.
- Students can reply to public threads. **Moderation:** report button, teacher/admin can hide a post. Rate-limit posting to 10/day per student.
- Notification on reply via push and in-app.

No realtime infrastructure. Polling on thread open plus push notifications is entirely sufficient and saves you a whole subsystem.

---

## 13. Certificates

Trigger: a cron job evaluates `course_completion_rules` for any student whose progress changed in the last hour.

```
lessons completed ≥ min_lessons_percent
  AND (all published quizzes attempted, if require_all_quizzes)
  AND quiz average ≥ min_quiz_average
  AND (all assignments graded, if require_assignments)
  ⟹ issue certificate
```

Generation runs as a background job: load a pre-designed A4 landscape template PDF, stamp student name, course title, teacher name, date, certificate number, and a QR code pointing at `https://yourdomain.com/verify/{certificate_no}` using pdf-lib. Store in R2, notify the student.

The verification page is **public and unauthenticated** — that is the entire point of a certificate. It shows the certificate number, student name, course, issue date, and validity status. Nothing else, and no way to enumerate: certificate numbers include a random component so `CERT-2026-000418` cannot be walked to `000419`.

Revocation sets `revoked_at`; the verification page then shows the certificate as revoked rather than 404ing.

---

## 14. Progress & analytics

**Progress signal.** A video lesson completes at **90% watched**, not 100% — students skip end credits and outros, and requiring 100% strands them one lesson short of a certificate. Track via `heartbeat` events every 15 seconds while playing. Documents and notes complete on open plus a 10-second dwell. Quizzes complete on submission.

**Anti-gaming.** Discard heartbeats where playback position advances faster than wall-clock time × playback rate × 1.2. This catches seek-scrubbing to fake completion, and it doubles as a piracy signal (Section 17.5).

**Dashboards.**

*Teacher, per course:* enrollments over time, completion funnel by lesson (the drop-off cliff tells them which lecture is too long), average quiz score per quiz, ungraded queue size, unanswered doubts.

*Admin:* revenue by period and plan, new vs renewed entitlements, churn (subscriptions that lapsed without renewal), watch hours consumed this month against annual VdoCipher credit — **this one is critical, because running out of prepaid bandwidth mid-month takes your platform down** — R2 storage used, pending payment queue depth and median verification time.

Build these as SQL views plus a nightly `daily_metrics` rollup table. Do not query `watch_events` live from a dashboard.

---

## 15. Notifications

| Event | Channels |
|---|---|
| OTP | SMS |
| Payment submitted | In-app |
| Payment approved / rejected | Push + SMS + in-app |
| Subscription expiring (7/3/1 day) | Push + SMS + in-app |
| Assignment graded | Push + in-app |
| Doubt answered | Push + in-app |
| Certificate issued | Push + email + in-app |
| New lesson in an entitled course | Push + in-app |
| Session revoked (new device login) | Push to the old device |

SMS costs real money per message in BD. Restrict it to OTP, payment outcomes, and expiry warnings — the three where failure costs you revenue. Everything else is push and in-app.

---

## 16. Mobile application (Flutter)

**One codebase, both stores.** Architecture: feature-first folders, Riverpod for state, `dio` with an interceptor that attaches the JWT and `X-Session-Id` and handles 401 `SESSION_REVOKED` by clearing storage and routing to login, `go_router` for navigation with deep links, `drift` for the local cache of course structure and progress.

**Platform security configuration:**

```dart
// Android — blocks screenshots and screen recording app-wide
// android/app/src/main/kotlin/.../MainActivity.kt
override fun onCreate(savedInstanceState: Bundle?) {
  window.setFlags(
    WindowManager.LayoutParams.FLAG_SECURE,
    WindowManager.LayoutParams.FLAG_SECURE
  )
  super.onCreate(savedInstanceState)
}
```

On iOS there is no direct FLAG_SECURE equivalent. DRM-protected video played through AVPlayer is excluded from screen capture by the OS automatically. For PDFs and notes you must implement the `UITextField.isSecureTextEntry` layer trick, and additionally observe `UIScreen.capturedDidChangeNotification` to blur content while recording is active and `userDidTakeScreenshotNotification` to log the event against the account.

**This is a real advantage of the mobile app:** FLAG_SECURE protects *everything* in the app — PDFs, notes, images, quiz papers — not just video. The web can never match that. Consider making your highest-value PDF content mobile-only and using the web for video and free material. It is a product decision, not a technical one, but it materially changes your leak surface.

Also add: `flutter_jailbreak_detection` at launch (warn and degrade to lower-quality streams on compromised devices rather than hard-blocking, which generates false positives), certificate pinning on `dio` for your API domain, and `flutter_secure_storage` for tokens.

**Store submission notes.** Google Play: Data Safety form, privacy policy URL, and — because you sell course access — a clear statement of your payment model. Since payment happens outside the app via bKash, you are in the "physical goods / services outside the app" grey zone. **Read Play's payments policy carefully.** Apple is stricter: Apple generally requires In-App Purchase (30% / 15%) for digital content consumed in the app. The common workaround used by edtech apps is to ship the iOS app as a **content viewer only** — no purchase flow, no pricing, no link to purchase — with students buying on the web. Design your iOS build for this from the start; it is the most common cause of edtech app rejection.

---

## 17. Security model — the honest assessment

This section replaces the "Summary of Anti-Piracy Protections" in your draft. That table claimed 100% blocking. Here is what is actually true.

### 17.1 What is genuinely hard-blocked

| Attack | Status | Why |
|---|---|---|
| IDM, JDownloader, `yt-dlp`, browser download extensions | **Blocked** | Segments are DRM-encrypted; without a CDM-issued key the downloaded bytes are unusable garbage. This is real and reliable. |
| Direct URL sharing of video | **Blocked** | Playback requires a single-use, short-lived, server-issued OTP. |
| Direct URL sharing of PDFs | **Blocked beyond 15 minutes** | Signed URLs expire. |
| Right-click save, "Save Page As", copy text from notes | **Blocked** | Canvas rendering, no text layer, no source file exposed. |
| Screen recording on Android (in-app) | **Blocked** | FLAG_SECURE is enforced by the OS compositor. Recordings capture black. |
| Screen recording of DRM video on iOS (in-app) | **Blocked** | AVPlayer excludes protected content from capture. |
| Screen recording of DRM video in Chrome/Edge/Safari desktop | **Blocked in the common case** | The browser marks the protected surface non-capturable. |

### 17.2 What is partially blocked

| Attack | Reality |
|---|---|
| Widevine **L3** key extraction on desktop | Publicly documented tooling exists that extracts L3 CDM keys and decrypts streams. Desktop browsers commonly run L3, not hardware-backed L1. This is the most credible real threat, and no vendor can eliminate it. **Mitigation:** VdoCipher's Play Integrity / device-check features, forcing lower maximum resolution on L3 playback (a 480p leak is much less valuable than 1080p), and behavioural detection. |
| Rooted Android / jailbroken iOS | FLAG_SECURE and DRM level checks can be bypassed. **Mitigation:** jailbreak detection, degrade to 360p, flag the account. |
| HDMI capture with an HDCP stripper | Works, costs about $30 of hardware. Nothing prevents it. Watermarking survives it. |
| Virtual machines and sandboxed browsers | Sometimes defeat capture blocking. Detectable heuristically, not reliably. |

### 17.3 What is not blocked at all — say this plainly to your teachers

| Attack | Reality |
|---|---|
| **Pointing a second phone at the screen** | Completely unpreventable by any technology at any price. Quality is poor and the watermark is captured along with the content, which is exactly why watermarking is the primary defence, not a garnish. |
| **Screenshotting canvas-rendered PDFs on web** | Print Screen captures a canvas exactly like anything else. Disabling right-click stops a curious student, not a determined one. On **mobile, FLAG_SECURE does block this** — another argument for the app. |
| **Retyping or paraphrasing notes** | Obviously. |
| **A student simply sharing their password** | Addressed by session and device-switch limits (Section 6.3), not by DRM. |

### 17.4 Therefore: watermarking is the actual product

Because the camera attack is unpreventable, your real defence is **attribution**. Every leaked frame must carry the identity of the account that leaked it, so that:

1. Students know they will be identified, which deters the vast majority before they try.
2. When a leak surfaces in a Telegram group, you can identify and terminate the source account within minutes.

Concretely: dual moving watermarks on video (Section 9.1), diagonal repeating watermark on PDF and note canvases showing name + phone + a short session hash, and watermarks on quiz papers and assignment PDFs too — those get shared as often as video.

Put the deterrent in the product copy, not just the code. A line on the payment screen — *"Your name and phone number appear on all content you access. Sharing course material will terminate your access permanently"* — is worth more than a week of engineering.

### 17.5 Detection: the piracy signals dashboard

Cheap to build, high value. Flag accounts where:

| Signal | Threshold |
|---|---|
| Distinct IPs in 24h | > 4 |
| Distinct device fingerprints in 30d | > 4 |
| Impossible travel | two IPs > 400 km apart within 1 hour |
| Watch velocity | > 20 lesson-hours in 24h |
| Systematic sequential access | every lesson in a course opened once, in order, in under 2 hours — the signature of someone ripping a catalog |
| Signed-URL request rate | > 60 asset URLs in 10 minutes |

Surface these as a review queue with the same approve/dismiss ergonomics as the payment queue. Do not auto-ban — false positives will cost you paying students.

### 17.6 General application security

- All secrets in environment variables. Never in the repo, never in the Flutter bundle. **The VdoCipher API secret and the R2 credentials must exist only server-side** — if either reaches a client, your entire content library is exposed.
- Zod validation on every endpoint boundary.
- Drizzle parameterizes everything; never build SQL by concatenation.
- CSP, HSTS, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`.
- Cloudflare WAF and Bot Fight Mode in front of everything.
- Nightly Postgres backups (Supabase automatic) plus a weekly `pg_dump` to R2 that you have **actually tested restoring**. An untested backup is not a backup.
- Sentry on web, API, and Flutter, with PII scrubbing configured.

---

## 18. API surface

All routes under `/api/v1`. All authenticated routes require `Authorization: Bearer <jwt>` and `X-Session-Id`. All responses are `{ data, error, meta }`.

**Auth**
```
POST   /auth/otp/request            { phone }
POST   /auth/otp/verify             { phone, code, device }        → tokens + sessionId
POST   /auth/login                  { email, password, device }
POST   /auth/refresh                { refreshToken }
POST   /auth/logout
GET    /auth/me
```

**Catalog (public / partially public)**
```
GET    /courses                     ?level&subject&teacher&page
GET    /courses/:slug
GET    /courses/:slug/curriculum    → modules + lessons, each with { locked: bool }
GET    /free-resources
GET    /plans
```

**Student**
```
GET    /me/courses
GET    /me/entitlements
GET    /me/progress/:courseId
GET    /lessons/:id                 → metadata; 403 if not entitled
GET    /lessons/:id/playback        → { otp, playbackInfo }
GET    /lessons/:id/asset           → { url, watermark }
GET    /lessons/:id/note-pages      → [{ url, page, watermark }]
POST   /lessons/:id/progress        { position, secondsWatched }
POST   /lessons/:id/events          { event, position }            (batched heartbeats)

POST   /quizzes/:id/attempts
GET    /attempts/:id
PATCH  /attempts/:id/answers        { questionId, selectedOptions?, textAnswer? }
POST   /attempts/:id/submit
GET    /attempts/:id/result

GET    /assignments/:id
POST   /assignments/:id/upload-url  { filename, mime, size }
POST   /assignments/:id/submit      { files, note }
GET    /assignments/:id/submission

GET    /lessons/:id/doubts
POST   /lessons/:id/doubts          { title, body, imageKey? }
POST   /doubts/:id/replies          { body, imageKey? }

GET    /me/certificates
GET    /certificates/:no/download
GET    /me/notifications
POST   /me/notifications/:id/read
POST   /me/devices/register         { fcmToken, platform }
```

**Payments**
```
POST   /payments/intent             { planId, courseId? }   → { referenceCode, amount, instructions }
POST   /payments/proof-upload-url   { mime, size }
POST   /payments                    { referenceCode, channel, senderNumber, transactionId, proofKey }
GET    /me/payments
```

**Teacher** (`/teacher/*`, role-gated)
```
GET    /teacher/courses
POST   /teacher/courses
PATCH  /teacher/courses/:id
POST   /teacher/courses/:id/modules
PATCH  /teacher/modules/:id
POST   /teacher/modules/:id/reorder          { orderedIds }
POST   /teacher/modules/:id/lessons
PATCH  /teacher/lessons/:id
DELETE /teacher/lessons/:id
POST   /teacher/lessons/:id/video-credentials
POST   /teacher/lessons/:id/video-complete   { videoId }
POST   /teacher/lessons/:id/asset-upload-url { mime, size }
PUT    /teacher/lessons/:id/note             { contentJson }       → enqueues render
POST   /teacher/quizzes  …  (CRUD for quizzes, questions, options)
POST   /teacher/assignments … (CRUD)
GET    /teacher/grading/queue
POST   /teacher/grading/quiz-answers/:id     { marks, feedback }
POST   /teacher/grading/submissions/:id      { marks, feedback }
GET    /teacher/doubts/inbox
POST   /teacher/doubts/:id/resolve
GET    /teacher/courses/:id/analytics
```

**Admin** (`/admin/*`)
```
GET    /admin/payments?status=pending
POST   /admin/payments/:id/approve
POST   /admin/payments/:id/reject            { reason, note }
GET    /admin/students?q=
POST   /admin/students/:id/entitlements      { kind, courseId?, expiresAt?, note }
POST   /admin/entitlements/:id/revoke        { reason }
POST   /admin/students/:id/sessions/revoke
GET    /admin/students/:id/devices
POST   /admin/teachers                       { name, phone, email }
GET    /admin/plans   POST /admin/plans   PATCH /admin/plans/:id
GET    /admin/analytics/overview
GET    /admin/piracy-signals
GET    /admin/audit-log
```

**Cron** (`/cron/*`, protected by a bearer secret Vercel sends)
```
POST   /cron/poll-video-status          every 5 min
POST   /cron/process-jobs               every 1 min
POST   /cron/expire-entitlements        hourly
POST   /cron/expiry-reminders           daily 10:00 Asia/Dhaka
POST   /cron/expire-stale-payments      daily
POST   /cron/evaluate-certificates      hourly
POST   /cron/rollup-metrics             daily 02:00
POST   /cron/compute-piracy-signals     every 6 hours
```

---

## 19. Infrastructure, environments, deployment

### 19.1 Environments

| | Development | Staging | Production |
|---|---|---|---|
| Web/API | localhost:3000 | Vercel preview | Vercel production |
| Database | local Postgres (Docker) | Supabase free project | Supabase Pro project |
| VdoCipher | trial account | trial account | paid account |
| R2 | `edtech-dev` bucket | `edtech-staging` | `edtech-prod` |
| Flutter | debug flavor → localhost | profile flavor → staging | release flavor → prod |

Never point a staging build at production media credentials. Flutter build flavors make this enforceable rather than a matter of discipline.

### 19.2 Repository layout

```
edtech/
├── apps/
│   ├── web/                 Next.js — UI + /api/v1 route handlers
│   └── mobile/              Flutter
├── packages/
│   ├── core/                framework-agnostic business logic
│   │   ├── auth/            guards, session, device policy
│   │   ├── entitlements/    checkLessonAccess and friends
│   │   ├── media/           VideoProvider interface + VdoCipher adapter, R2 client
│   │   ├── payments/        approve/reject, entitlement issuance
│   │   ├── grading/
│   │   └── jobs/            handlers keyed by job type
│   ├── db/                  Drizzle schema + migrations
│   └── shared/              Zod schemas, types, constants
├── tools/
│   └── dart-gen/            generates Dart models from Zod schemas
└── docs/                    this document, ADRs, runbooks
```

Keeping `packages/core` free of Next.js imports is what makes the escape hatch in Section 3.2 real. Enforce it with an ESLint boundary rule so it does not decay.

### 19.3 CI/CD

GitHub Actions:
- **On PR:** typecheck, lint, unit tests, Drizzle migration dry-run, `flutter analyze` and `flutter test`.
- **On merge to `main`:** Vercel deploys web/API; migrations run via a deploy hook *before* the new build goes live.
- **On tag `mobile-v*`:** Fastlane builds and uploads to Play internal testing and TestFlight.

Migration discipline: forward-only, never edit a shipped migration, and every migration must be safe to run against the currently-live application version (add columns nullable first, backfill, then constrain in a second migration). With a mobile app in the wild you cannot assume all clients updated.

### 19.4 Minimum test coverage

Do not aim for a coverage percentage. Aim for these specific tests, which are the ones that protect revenue:

1. `checkLessonAccess` — every entitlement kind × expired/active/revoked × free/paid lesson.
2. Payment approval — entitlement created correctly, renewal stacking correct, duplicate transaction ID rejected.
3. Session guard — revoked session returns 401; concurrent login revokes the old one.
4. Quiz grading — auto-score correctness, time-limit enforcement, attempt limits.
5. Signed-URL issuance — refuses without entitlement.

Everything else can be tested by using the product.

---

## 20. Cost model, rebuilt

### 20.1 Why your draft's numbers are low

Two structural errors:

**Error 1 — VdoCipher does not bill monthly.** Plans are annual prepaid credits: <cite index="14-1">all plans are on an annual basis, and the bandwidth and storage included are yearly figures</cite>. <cite index="15-1">A plan ends when the bandwidth credit is consumed or after one year, whichever comes first</cite>. So there is no "$29/month" — there is a lump sum once a year, and **if you burn the bandwidth in month seven, your platform stops streaming.** Your admin dashboard must track consumption against credit as a first-class metric.

**Error 2 — the bandwidth figures are roughly 2–6× too low.** VdoCipher estimates <cite index="14-1">about 270 MB per hour at 600 kbps, which they consider reasonable for lecture content</cite>. Real-world adaptive delivery to a mix of phones and laptops averages closer to 350–450 MB/hour once 720p is in the ladder. The arithmetic:

| Your tier | Watch hrs/month | Bandwidth/year @ 270 MB/hr | @ 400 MB/hr | Your draft claimed |
|---|---|---|---|---|
| Tier 1 (100 students) | 1,000 | **3.24 TB** | **4.8 TB** | 750 GB |
| Tier 2 (200 students) | 2,000 | **6.5 TB** | **9.6 TB** | 1.5 TB |
| Tier 3 (300 students) | 3,000 | **9.7 TB** | **14.4 TB** | 2.25 TB |
| Tier 4 (500 students) | 5,000 | **16.2 TB** | **24 TB** | 3.75 TB |

Tier 1's 750 GB is under three months of streaming, not a year.

**Third uncertainty — storage multiplier.** VdoCipher stores every rendition of every video, so billed storage is a multiple of your source library. Reported multipliers cluster around 3–5×. <cite index="11-1">One long-term customer reports that a 1 GB source file ends up consuming roughly 5 GB of plan storage because the platform splits it into segments and produces multiple copies at different resolutions</cite>. If your 500 GB figure is source video, you may need 1.5–2.5 TB of plan storage. **Confirm this number with VdoCipher before purchasing anything.** It is the largest single unknown in this model.

### 20.2 Rebuilt monthly operating cost

Vendor list pricing is sales-led and moves; treat these as planning figures and get written quotes. Published anchors: <cite index="11-1">a $149/year entry plan carrying 1,000 GB bandwidth and 100 GB storage</cite>, and <cite index="18-1">an Express tier at $699/year for 5,000 GB of bandwidth</cite>, with overage bandwidth reported in the $0.09–$0.29/GB range depending on plan size.

| Line item | Tier 1 (100) | Tier 2 (200) | Tier 3 (300) | Tier 4 (500) |
|---|---|---|---|---|
| VdoCipher (annual ÷ 12) | $58 – $75 | $85 – $130 | $130 – $210 | $180 – $290 |
| Cloudflare R2 | $1 | $1 – $2 | $2 – $3 | $3 – $5 |
| Supabase | $0 (free) – $25 | $25 | $25 – $35 | $25 – $50 |
| Vercel Pro *(required — Hobby forbids commercial use)* | $20 | $20 | $20 | $20 – $40 |
| Resend | $0 | $0 – $20 | $20 | $20 |
| SMS gateway (BD, ~0.30 BDT/SMS) | $2 – $4 | $4 – $8 | $7 – $12 | $12 – $20 |
| Upstash Redis, Sentry, Better Stack | $0 (free tiers) | $0 | $0 – $26 | $26 – $40 |
| Domain + Cloudflare | $1 | $1 | $1 – $21 | $21 |
| **Monthly total** | **$82 – $126** | **$136 – $206** | **$205 – $347** | **$307 – $486** |
| **Annualised** | **$984 – $1,512** | **$1,632 – $2,472** | **$2,460 – $4,164** | **$3,684 – $5,832** |

Roughly **2 to 2.5× your draft** at every tier. This is a healthier number to plan against than a pleasant one to quote.

### 20.3 One-time and periodic costs

| Item | Cost |
|---|---|
| Google Play developer account | $25 one-time |
| Apple Developer Program | $99/year |
| Mac for iOS builds | $0 if you have one; ~$600 used Mac mini M1, or ~$25/month cloud Mac (MacStadium, Codemagic) |
| Domain | ~$12/year |
| Trade licence + TIN (for SSLCommerz later) | ~3,000–15,000 BDT depending on category |
| Development | $0 — you are building it |

### 20.4 Break-even

At Tier 1 (100 students, ~$100/month ≈ 12,000 BDT), your floor is about **120 BDT per student per month**. At Tier 4 (500 students, ~$400/month ≈ 48,000 BDT), it is about **96 BDT per student per month**. If your subscription price is 500–1,000 BDT/month, infrastructure runs 10–25% of revenue, which is sustainable. If you price at 200 BDT/month, margins get thin fast and Bunny.net becomes worth serious evaluation.

### 20.5 Cost levers, in order of impact

1. **Cap default playback quality at 480p, let students opt up to 720p.** For talking-head lecture content the quality difference is small and the bandwidth difference is 40–50%. This is the single biggest lever you have, and it also improves playback on weak connections.
2. **Get a Bunny.net Stream + DRM quote.** At Tier 3–4 volumes the delivery cost difference could exceed $1,000/year.
3. **Encode at 24–30 fps, not 60.** Nobody needs 60 fps for a whiteboard.
4. **Archive old course videos.** Cold storage or deletion after a cohort ends; storage is charged continuously.
5. **Delete failed and duplicate uploads.** Teachers re-upload constantly and every orphan costs storage all year.

---

## 21. Build roadmap for one developer

### 21.1 The honest assessment first

Your v1 as scoped — web + Android + iOS, video DRM, PDFs, notes, quizzes, assignments, discussions, certificates, manual payments, three access models — is a **6 to 9 month full-time build for one experienced developer.** As a student building around coursework, plan for longer.

That is not a reason to cut ambition. It is a reason to sequence so that you have something earning revenue in month three instead of nothing until month nine. Two specific recommendations:

**Cut iOS from launch.** Android is the overwhelming majority of the Bangladeshi student market. iOS adds the Apple account, a Mac, App Store review cycles, and — the real problem — the IAP policy question in Section 16 that will likely get your first submission rejected. Ship web + Android, get students paying, then do iOS in month two of operations when you have revenue and no launch-date pressure.

**Cut discussions and certificates from v1.0.** Both are genuinely valuable and neither is required for a student to pay you money. They are the natural first post-launch features, and shipping them into a live product with real users is more motivating than shipping them into an empty one.

### 21.2 Sequence

| Phase | Weeks | Deliverable |
|---|---|---|
| **0 — Foundations** | 2 | Monorepo, Drizzle schema and migrations, Supabase project, auth with phone OTP, session guard, device-switch policy, RLS baseline, Sentry. **Ends with:** you can log in on two devices and watch the first kick out the second. |
| **1 — Content spine** | 4 | Teacher course/module/lesson CRUD, drag-and-drop ordering, VdoCipher upload + status polling, R2 presigned uploads, DRM player on web with watermark, canvas PDF viewer. **Ends with:** a teacher uploads a lecture and you watch it protected. |
| **2 — Money** | 3 | Plans, entitlement engine, `checkLessonAccess` wired into every gate, payment intent + proof submission, admin verification queue, entitlement issuance, expiry cron, renewal reminders. **Ends with:** a real person pays you 500 BDT via bKash and gets access. |
| **3 — Student experience** | 3 | Catalog, Free Resource Center, My Courses, progress tracking, resume position, notifications, account screens. **Ends with:** the web product is complete and shippable. |
| **4 — Android** | 5 | Flutter shell, auth, catalog, VdoCipher SDK player, PDF/note viewer, FLAG_SECURE, progress sync, FCM, Play internal testing. **Ends with:** app in internal testing with real students. |
| **5 — Notes pipeline** | 2 | Tiptap editor, Satori render job, note page viewer on both clients. |
| **6 — 🚀 LAUNCH** | 1 | Soft launch: one teacher, one course, 20–30 students. Fix what breaks. |
| **7 — Assessment** | 3 | Quiz builder, attempt engine, auto-grading, grading queue, assignment upload and grading. |
| **8 — iOS** | 3 | Flutter iOS build, screen-capture handling, viewer-only configuration, TestFlight, App Store submission. Budget two rejection cycles. |
| **9 — Community & credentials** | 3 | Doubt threads, teacher inbox, certificate rules and PDF generation, public verification page. |
| **10 — Hardening** | 2 | Piracy signals dashboard, admin analytics, rate limiting, load test at 100 concurrent streams, backup restore drill. |

**Revenue starts at week 18.** Everything after that is built with money coming in, which is a completely different psychological and financial position from building for nine months on hope.

### 21.3 Week-one checklist

1. Register the domain and point it at Cloudflare.
2. Create the VdoCipher trial account — <cite index="15-1">5 GB of bandwidth and up to 4 videos, valid 30 days, no credit card</cite>. Upload one real lecture *today* and measure the actual storage multiplier on your own file. This single measurement de-risks the largest unknown in Section 20.
3. Email VdoCipher sales with the Tier 2 and Tier 3 bandwidth numbers from the table in 20.1 and request a quote. Do the same with Bunny.net.
4. Create Supabase and Cloudflare R2 projects.
5. Buy the Google Play developer account ($25) — there is a verification delay, so start it early.
6. Start the trade licence process if you intend to add a payment gateway later.
7. Scaffold the monorepo and get the Drizzle schema from Section 5 migrating cleanly.

---

## 22. Risks and open decisions

| Risk | Impact | Mitigation |
|---|---|---|
| **Bandwidth credit exhausted mid-year** | Platform goes dark. Catastrophic. | Consumption tracking on the admin dashboard, alerts at 50/75/90%, cap default quality at 480p, keep a top-up budget reserved. |
| **Storage multiplier is 5× not 3×** | Costs jump ~60% | Measure on a real file in week one. Non-negotiable. |
| **Apple rejects the iOS app over IAP** | Weeks lost | Ship iOS as viewer-only, no purchase flow, no pricing, no purchase links. |
| **Manual verification becomes a bottleneck** | Lost sales, bad reviews | Verify twice daily at fixed times, publish the SLA on the pending screen, integrate SSLCommerz by ~200 subscribers. |
| **A determined student extracts L3 keys and leaks the library** | Revenue damage | Watermarking, resolution cap on L3, piracy signals dashboard, fast revocation, and a visible policy that terminates accounts. |
| **Solo-developer burnout / semester collision** | Project stalls | The phased roadmap exists for this. Revenue at week 18 is the checkpoint that keeps you going. |
| **Vercel function limits on heavy operations** | Timeouts | All heavy work already in the job queue. If it still bites, move `packages/core` to a Render worker — the architecture already permits it. |
| **Teacher drops out mid-course** | Students stranded | Content and courses belong to the platform, not the teacher account. Owner can reassign `teacher_id`. |

### 22.1 Decisions I need from you

1. **[CONFIRM]** Does the Owner control all pricing, or can teachers set their own course prices?
2. **[CONFIRM]** What exactly is the "note-to-image converter"? Rich-text editor rendered to images (what I specified), photographed handwritten notes, or a stylus drawing canvas?
3. **[CONFIRM]** Do you have — or can you register — a Bangladeshi business entity? This gates SSLCommerz and bKash Merchant.
4. **[CONFIRM]** Do you have access to a Mac for iOS builds?
5. **[CONFIRM]** Assignment resubmission: allowed until graded (my default), or unlimited?
6. **Open:** Subscription price point in BDT. It drives the break-even maths in 20.4 and determines whether Bunny.net evaluation is urgent or optional.
7. **Open:** Do subscription students keep access to courses they completed after their subscription lapses? My spec says no — access ends, but progress and certificates persist. This is worth deciding deliberately, because it affects churn.

---

## 23. Appendices

### A. Environment variables

```bash
# Database
DATABASE_URL=
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=      # server only — never in any client bundle

# VdoCipher
VDOCIPHER_API_SECRET=           # server only
VDOCIPHER_PLAYBACK_TTL=300

# Cloudflare R2
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=               # server only
R2_SECRET_ACCESS_KEY=           # server only
R2_BUCKET=
R2_SIGNED_URL_TTL=900

# Auth
JWT_SECRET=
ACCESS_TOKEN_TTL=900
REFRESH_TOKEN_TTL=2592000
MAX_DEVICE_SWITCHES_PER_30D=4

# Messaging
RESEND_API_KEY=
SMS_GATEWAY_URL=
SMS_GATEWAY_KEY=
FCM_SERVICE_ACCOUNT_JSON=

# Ops
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
SENTRY_DSN=
CRON_SECRET=

# Payments
PAYMENT_BKASH_NUMBER=
PAYMENT_NAGAD_NUMBER=
PAYMENT_VERIFICATION_SLA_HOURS=6
PAYMENT_GRACE_PERIOD_DAYS=3
```

### B. Conventions

- **Money:** integer poisha. Never float, never store BDT as a decimal.
- **Time:** `timestamptz` everywhere, UTC in the database, `Asia/Dhaka` at render time only.
- **IDs:** UUID v7.
- **API errors:** `{ error: { code: 'SESSION_REVOKED', message: '…' } }`. Machine-readable `code`, human `message`. The Flutter app switches on `code`, never on `message`.
- **Naming:** `snake_case` in Postgres, `camelCase` in TypeScript, `camelCase` in Dart. Drizzle handles the boundary.
- **Migrations:** forward-only, never edited after merge.

### C. Glossary

| Term | Meaning |
|---|---|
| **CDM** | Content Decryption Module. The browser or OS component that holds DRM keys and decrypts protected streams in isolated memory. |
| **Widevine L1 / L3** | Google DRM security levels. L1 uses a hardware trusted execution environment and resists extraction. L3 is software-only and has publicly documented bypasses. Most desktop browsers are L3. |
| **FairPlay** | Apple's equivalent, used on Safari and iOS. |
| **HLS** | HTTP Live Streaming. Video split into short encrypted segments with a manifest listing available bitrates. |
| **OTP (VdoCipher sense)** | A single-use, short-lived playback token. Unrelated to login OTP. |
| **Presigned URL** | A time-limited URL granting access to one private object without credentials. |
| **RLS** | Row Level Security. Postgres access rules enforced by the database itself. |
| **Entitlement** | A row granting a student access to content, by subscription, lifetime pass, single-course purchase, or manual grant. |
| **FLAG_SECURE** | Android window flag that makes the OS compositor refuse to include the window in screenshots or recordings. |

---

