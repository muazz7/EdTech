# ADR 0004 — Assignment resubmission is allowed until grading, then locked

**Date:** 2026-08-09
**Status:** Accepted
**Resolves:** Section 11's `[CONFIRM]` ("Resubmission: allowed until graded,
then locked — reasonable default, tell me if you want unlimited resubmission").

## Decision

A student may replace their submission as many times as they like **until a
teacher awards a mark**. Once `graded_at` is set, the submission is frozen and
further uploads are refused with `SUBMISSION_LOCKED`.

The specification's stated default is taken, not overridden.

## Why

Unlimited resubmission after grading breaks the mark. The teacher awarded 80/100
against a specific piece of work; if the student can then swap the files, the
record says 80 but the stored work is something the teacher never read. Anyone
auditing a certificate later — and certificates are exactly what these marks
feed (Section 13) — cannot tell which is which.

Locking before grading would be worse in the opposite direction. Students
photograph handwritten work on a phone (ADR 0001 established that is the normal
medium here); the first upload is regularly blurry, upside down, or missing a
page. Refusing a replacement turns a two-second fix into a support message, and
the teacher would rather grade the legible copy.

So the lock is placed at the moment the work stops being the student's draft and
starts being evidence.

## Consequences

- A teacher who grades early cannot be talked into "just let them resubmit"
  without an explicit unlock. There is no unlock endpoint today. If teachers ask
  for one it should clear `graded_at`, `marks` and `teacher_feedback` together
  and be audited — a partial unlock leaves a mark attached to replaced work,
  which is the thing this ADR exists to prevent.
- `is_late` is computed per submission, so a student who submits on time and
  then replaces the file after the due date is correctly marked late on the
  replacement.
- The teacher is notified on the **first** submission only. Pinging them on
  every re-upload trains them to ignore the notification, and the queue already
  shows what is ungraded.
