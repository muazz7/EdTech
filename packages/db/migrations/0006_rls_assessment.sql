-- Row level security for the tables that had none.
--
-- Why this is not cosmetic: Supabase's default template grants `anon` and
-- `authenticated` SELECT on tables in the public schema, and the anon key ships
-- in the client bundle. A public-schema table without RLS is therefore readable
-- by anyone on the internet, through PostgREST, without ever touching our API.
--
-- scripts/rls-audit.mjs confirmed this empirically before this migration:
-- `courses`, `modules` and `lessons` were all readable with the published anon
-- key. The API-level rule that a draft course answers 404 (Phase 3) was being
-- enforced only by the API, and PostgREST goes around the API entirely.
--
-- The service role bypasses every policy here by design. packages/core does the
-- real authorization; this is the layer that holds if packages/core ever leaks
-- a query.

-- ── Catalog ────────────────────────────────────────────────────────────────
-- Published courses only. A draft is a teacher's unreleased work and, per
-- Section 2.3, must be invisible rather than merely unlisted.

ALTER TABLE courses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY courses_read ON courses FOR SELECT USING (
  state = 'published'
  OR teacher_id = auth.uid()
  OR public.current_user_role() = 'admin'
);
--> statement-breakpoint

ALTER TABLE modules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Expressed as "is the parent course visible to me?" so there is exactly one
-- definition of visible to keep in step. Postgres applies courses' own policy
-- to this subquery.
CREATE POLICY modules_read ON modules FOR SELECT USING (
  EXISTS (SELECT 1 FROM courses c WHERE c.id = modules.course_id)
);
--> statement-breakpoint

-- lessons_read previously allowed any free lesson, including free lessons of a
-- course still in draft. Replaced so the parent course must also be visible.
DROP POLICY IF EXISTS lessons_read ON lessons;
--> statement-breakpoint

CREATE POLICY lessons_read ON lessons FOR SELECT USING (
  public.current_user_role() = 'admin'
  OR EXISTS (SELECT 1 FROM courses c
             WHERE c.id = lessons.course_id AND c.teacher_id = auth.uid())
  OR (
    is_published
    AND EXISTS (SELECT 1 FROM courses c
                WHERE c.id = lessons.course_id AND c.state = 'published')
    AND (
      is_free
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
    )
  )
);
--> statement-breakpoint

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY plans_read ON plans FOR SELECT USING (is_active);
--> statement-breakpoint

-- ── Assessment ─────────────────────────────────────────────────────────────
-- quiz_questions carries the prompts, and the student-facing shape is built by
-- packages/core (shuffled per attempt, options stripped of is_correct). There
-- is no correct direct read, so there is no policy.

ALTER TABLE quiz_questions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE quiz_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY quiz_attempts_own ON quiz_attempts FOR SELECT USING (
  student_id = auth.uid() OR public.current_user_role() = 'admin'
);
--> statement-breakpoint

-- quiz_answers holds awarded marks and, joined to quiz_options, would give away
-- which selections scored. Server-only.
ALTER TABLE quiz_answers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE assignment_submissions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY assignment_submissions_own ON assignment_submissions FOR SELECT USING (
  student_id = auth.uid() OR public.current_user_role() = 'admin'
);
--> statement-breakpoint

ALTER TABLE course_completion_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY course_completion_rules_read ON course_completion_rules FOR SELECT USING (
  EXISTS (SELECT 1 FROM courses c WHERE c.id = course_completion_rules.course_id)
);
--> statement-breakpoint

-- ── Everything else that was open ──────────────────────────────────────────

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY notifications_own ON notifications FOR SELECT USING (
  user_id = auth.uid() OR public.current_user_role() = 'admin'
);
--> statement-breakpoint

ALTER TABLE doubt_replies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY doubt_replies_read ON doubt_replies FOR SELECT USING (
  EXISTS (SELECT 1 FROM doubt_threads t WHERE t.id = doubt_replies.thread_id)
);
--> statement-breakpoint

-- ── Indexes the assessment queries need ────────────────────────────────────

CREATE INDEX IF NOT EXISTS quiz_attempts_student_quiz_idx
  ON quiz_attempts (student_id, quiz_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS quiz_attempts_grading_idx
  ON quiz_attempts (grading_status)
  WHERE submitted_at IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS quiz_answers_attempt_idx
  ON quiz_answers (attempt_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS assignment_submissions_ungraded_idx
  ON assignment_submissions (assignment_id)
  WHERE graded_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS certificates_student_idx
  ON certificates (student_id);
