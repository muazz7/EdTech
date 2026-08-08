-- Hand-written migration. Runs after the drizzle-kit generated 0000 baseline.
--
-- Three things drizzle-kit cannot express:
--   1. The FK from profiles.id to Supabase's auth.users -- drizzle does not
--      model tables in the `auth` schema, which Supabase owns.
--   2. The circular entitlements <-> payments reference.
--   3. The RLS baseline (Section 7.1).
--
-- Migration discipline (Section 19.3): forward-only, never edited after merge.
--
-- NOTE ON FORMAT: this file must be ASCII without a BOM, and every statement
-- must be separated by the breakpoint marker below. drizzle-kit sends each
-- chunk as one statement; a BOM or a missing marker produces a Postgres
-- syntax error at position 1.

ALTER TABLE profiles
  ADD CONSTRAINT profiles_id_auth_users_fk
  FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE entitlements
  ADD CONSTRAINT fk_entitlement_payment
  FOREIGN KEY (payment_id) REFERENCES payments(id);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Role lookup
-- ---------------------------------------------------------------------------
--
-- Every policy below needs "is the caller an admin?". Asking that with an
-- inline EXISTS (SELECT 1 FROM profiles ...) is a trap: once profiles itself
-- has RLS enabled, that subquery re-enters the profiles policy and Postgres
-- aborts with "infinite recursion detected in policy for relation profiles".
--
-- SECURITY DEFINER runs the lookup as the function owner, which is not subject
-- to RLS, breaking the cycle. search_path is pinned so the function cannot be
-- hijacked by a caller-controlled schema.
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS public.user_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid()
$$;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION public.current_user_role() FROM public;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- RLS baseline (Section 7.1)
-- ---------------------------------------------------------------------------
--
-- This is the SECOND layer. The primary access control is checkLessonAccess in
-- packages/core, which runs on the server on every protected request. RLS is
-- what stops the data walking out if the API ever has a bug that leaks a
-- query. The service role key bypasses all of this by design.
--
-- The dependent tables below deliberately express entitlement as "is the
-- parent lesson visible to me?" rather than repeating the join. Postgres
-- applies lessons' own policy to that subquery, so there is exactly one
-- definition of "entitled" to keep in step.

ALTER TABLE lessons ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY lessons_read ON lessons FOR SELECT USING (
  is_free
  OR public.current_user_role() = 'admin'
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
--> statement-breakpoint

ALTER TABLE note_pages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY note_pages_read ON note_pages FOR SELECT USING (
  EXISTS (SELECT 1 FROM lessons l WHERE l.id = note_pages.lesson_id)
);
--> statement-breakpoint

ALTER TABLE quizzes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY quizzes_read ON quizzes FOR SELECT USING (
  EXISTS (SELECT 1 FROM lessons l WHERE l.id = quizzes.lesson_id)
);
--> statement-breakpoint

ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY assignments_read ON assignments FOR SELECT USING (
  EXISTS (SELECT 1 FROM lessons l WHERE l.id = assignments.lesson_id)
);
--> statement-breakpoint

ALTER TABLE doubt_threads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY doubt_threads_read ON doubt_threads FOR SELECT USING (
  (is_public AND EXISTS (SELECT 1 FROM lessons l WHERE l.id = doubt_threads.lesson_id))
  OR doubt_threads.student_id = auth.uid()
);
--> statement-breakpoint

ALTER TABLE entitlements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY entitlements_own ON entitlements FOR SELECT USING (
  student_id = auth.uid() OR public.current_user_role() = 'admin'
);
--> statement-breakpoint

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY payments_own ON payments FOR SELECT USING (
  student_id = auth.uid() OR public.current_user_role() = 'admin'
);
--> statement-breakpoint

ALTER TABLE lesson_progress ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY lesson_progress_own ON lesson_progress FOR SELECT USING (
  student_id = auth.uid()
);
--> statement-breakpoint

ALTER TABLE certificates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY certificates_own ON certificates FOR SELECT USING (
  student_id = auth.uid() OR public.current_user_role() = 'admin'
);
--> statement-breakpoint

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY profiles_self ON profiles FOR SELECT USING (
  id = auth.uid() OR public.current_user_role() = 'admin'
);
--> statement-breakpoint

-- No policies at all on these: they are server-only, so RLS enabled with zero
-- policies denies every read that is not the service role.
ALTER TABLE active_sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE device_switch_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE watch_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- quiz_options holds is_correct. Never readable by a student under any policy.
ALTER TABLE quiz_options ENABLE ROW LEVEL SECURITY;
