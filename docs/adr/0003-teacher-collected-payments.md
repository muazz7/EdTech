# ADR 0003 — Teachers collect and verify their own course payments

**Date:** 2026-08-08
**Status:** Accepted
**Supersedes:** Section 1.3 ("Teacher ... cannot verify payments"), Section 2.1
(payment verification queue listed as an Owner-only feature), and Section 8.2
("Admin verification").

## Decision

Teachers publish their own bKash / Nagad / Rocket numbers, review the payments
for their own courses, and can grant a student access by hand.

Money moves **student → teacher directly** and never transits the platform.
SSLCommerz is not planned.

Platform-wide plans (`subscription`, `lifetime_all`) remain the Owner's, because
they grant access across every teacher's catalog and no single teacher can
collect for them. Admin retains full reach over everything.

## The consequence that is not a code problem

The specification assumed the Owner collected all revenue, which is why
Section 1.2 could say "no teacher payout system, no revenue splits" — there was
nothing to pay out.

Inverting that removes the payout problem and creates a different one: **the
platform now carries the Section 20 bill (VdoCipher, Supabase, Vercel, SMS —
roughly $82–486/month depending on tier) with no revenue attached to it.**
Section 20.4's break-even maths assumed platform-collected subscriptions.

That needs a commercial answer before launch. Options, none of which are code:
a platform fee invoiced to teachers, a listing fee, keeping all-access
subscriptions as the Owner's revenue line, or funding it personally. Recording
it here so it is a decision rather than a surprise.

## The boundary that must not move

A teacher's manual grant is forced to `single_course`, on a course they own.

`lifetime_all` and `subscription` both resolve against `courses.is_in_all_access`
in `checkLessonAccess`. A teacher able to issue either would be handing out
**every other teacher's catalog**, for free, from their own account, with no
payment attached. This is one missing check away, so:

- the kind is not a parameter a teacher can influence — a teacher sending
  `kind: 'lifetime_all'` is **refused**, not silently downgraded, because a
  teacher who believes they granted all-access has a wrong model of what their
  students can see;
- revoking a plan entitlement is likewise Owner-only, since pulling a
  subscription would cut a student off from teachers who had nothing to do with
  it;
- both are covered by tests in `packages/core/src/payments/payments.test.ts`.

## Other decisions worth keeping

**The amount is locked at intent time**, not read at approval. Teachers change
prices whenever they like (ADR 0002); a student quoted 500 BDT who transfers 500
BDT must be approved for 500 even if the price moved to 900 while they walked to
the shop.

**A pending intent is reused rather than re-minted.** A student reloading the
instructions page must not end up holding two reference codes with no idea which
one they wrote on the transfer.

**Reference codes exclude ambiguous characters** (no O/0, no I/1). The code is
read off a screen and typed into a phone keypad under time pressure.

**Approval is one transaction** — verify, issue entitlement, write audit — and
re-checks `status = 'pending'` inside it. A payment marked verified without its
entitlement is a student who paid and cannot watch, which is the worst outcome
this product has. Two reviewers pressing approve at once must not produce two
entitlements.

**Queue isolation returns 404, not 403**, for a payment belonging to another
teacher. A 403 confirms the row exists and lets one teacher probe another's
revenue.

**Payment methods are deactivated, never deleted.** A payment references the
method it was shown against, and a student disputing "you told me to send here"
needs that record to survive.

## Known gap

`audit_log.actor_id` has no `ON DELETE` rule, which makes the trail immutable but
also means a profile that has performed an audited action can never be deleted.
Fine for now; removing a real user later will need a decision — most likely
`ON DELETE SET NULL` plus a denormalised actor name on the audit row, so the
record outlives the person.
