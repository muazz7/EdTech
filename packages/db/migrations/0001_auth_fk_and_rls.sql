-- Hand-written migration. Runs after the drizzle-kit generated 0000 baseline.
--
-- Two things drizzle-kit cannot express:
--   1. The FK from profiles.id to Supabase's auth.users â€” drizzle does not
--      model tables in the `auth` schema, which Supabase owns.
--   2. The RLS baseline (Section 7.1).
--
-- Migration discipline (Section 19.3): forward-only, never edited after merge.

-- â”€â”€ 1. Link the application profile to the Supabase identity â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ALTER TABLE profiles
  ADD CONSTRAINT profiles_id_auth_users_fk
  FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- â”€â”€ 2. Close the circular entitlements <-> payments reference â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ALTER TABLE entitlements
  ADD CONSTRAINT fk_entitlement_payment
  FOREIGN KEY (payment_id) REFERENCES payments(id);

-- â”€â”€ 3. Row Level Security baseline (Section 7.1) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
--
-- RLS mirrors checkLessonAccess in the database as a SECOND layer. It is not
-- the primary access control â€” that is the entitlement engine in
-- packages/core, which runs on every protected request. RLS is what stops the
-- data walking out if the API ever has a bug that leaks a query.
--
-- The service role key bypasses RLS by design. These policies bite for the
-- anon/authenticated roles only.

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

-- Same pattern for the other entitlement-gated tables. Each joins back to
-- lessons so there is exactly one definition of "entitled" to keep in step.

ALTER TABLE note_pages ENABLE ROW LEVEL SECURITY;

CREATE POLICY note_pages_read ON note_pages FOR SELECT USING (
  EXISTS (SELECT 1 FROM lessons l WHERE l.id = note_pages.lesson_id)
);

ALTER TABLE quizzes ENABLE ROW LEVEL SECURITY;

CREATE POLICY quizzes_read ON quizzes FOR SELECT USING (
  EXISTS (SELECT 1 FROM lessons l WHERE l.id = quizzes.lesson_id)
);

ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY assignments_read ON assignments FOR SELECT USING (
  EXISTS (SELECT 1 FROM lessons l WHERE l.id = assignments.lesson_id)
);

ALTER TABLE doubt_threads ENABLE ROW LEVEL SECURITY;

CREATE POLICY doubt_threads_read ON doubt_threads FOR SELECT USING (
  (is_public AND EXISTS (SELECT 1 FROM lessons l WHERE l.id = doubt_threads.lesson_id))
  OR doubt_threads.student_id = auth.uid()
);

-- Students read only their own rows on these.
ALTER TABLE entitlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY entitlements_own ON entitlements FOR SELECT USING (
  student_id = auth.uid()
  OR EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY payments_own ON payments FOR SELECT USING (
  student_id = auth.uid()
  OR EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
);

ALTER TABLE lesson_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY lesson_progress_own ON lesson_progress FOR SELECT USING (
  student_id = auth.uid()
);

ALTER TABLE certificates ENABLE ROW LEVEL SECURITY;
CREATE POLICY certificates_own ON certificates FOR SELECT USING (
  student_id = auth.uid()
  OR EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
);

-- profiles: a user reads their own row; admins read all.
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_self ON profiles FOR SELECT USING (
  id = auth.uid()
  OR EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
);

-- No policies at all on these: they are server-only, so the absence of a
-- policy with RLS enabled denies every non-service-role read.
ALTER TABLE active_sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_switch_log    ENABLE ROW LEVEL SECURITY;
ALTER TABLE watch_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log            ENABLE ROW LEVEL SECURITY;
ALTER TABLE quiz_options         ENABLE ROW LEVEL SECURITY;

