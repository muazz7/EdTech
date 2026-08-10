-- Row level security for doubt_reports, and a tightened read policy for threads
-- and replies now that they can be hidden.
--
-- doubt_reports has no policy: server-only. A report names a student and says
-- what they were accused of, and the only party who needs to read it is the
-- teacher, through the API.

ALTER TABLE doubt_reports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- A hidden thread must stop being visible. The previous policy predated
-- moderation and would have kept showing a thread a teacher had just taken
-- down.
DROP POLICY IF EXISTS doubt_threads_read ON doubt_threads;
--> statement-breakpoint

CREATE POLICY doubt_threads_read ON doubt_threads FOR SELECT USING (
  hidden_at IS NULL
  AND (
    (is_public AND EXISTS (SELECT 1 FROM lessons l WHERE l.id = doubt_threads.lesson_id))
    OR doubt_threads.student_id = auth.uid()
    OR public.current_user_role() = 'admin'
  )
);
--> statement-breakpoint

DROP POLICY IF EXISTS doubt_replies_read ON doubt_replies;
--> statement-breakpoint

CREATE POLICY doubt_replies_read ON doubt_replies FOR SELECT USING (
  hidden_at IS NULL
  AND EXISTS (SELECT 1 FROM doubt_threads t WHERE t.id = doubt_replies.thread_id)
);
