# ADR 0002 — Teachers set their own course prices

**Date:** 2026-08-08
**Status:** Accepted
**Supersedes:** Section 1.3 and Section 22.1 question 1, which specified
*Owner controls pricing, teacher proposes* as the safer default.

## Decision

A teacher sets and changes `courses.price_poisha` on their own courses
directly, with no approval step. Prices are always changeable.

Promo codes are **deferred to the first post-launch phase**, not v1.0. This
keeps Section 1.5's original position and protects the week-18 revenue date.

## Why this was not the documented default

The specification recommended teacher-proposes / owner-approves for a
single-brand platform. That was overruled deliberately. The consequences below
are real and should be managed operationally rather than pretended away.

## Consequences to manage

**Subscription cannibalisation.** A teacher can price a single course below
the monthly all-access plan. A student then buys the course outright and never
subscribes. Nothing in the schema prevents this — `courses.price_poisha` and
`plans.price_poisha` are independent.

Mitigation, in order of cost:
1. Show the teacher the current all-access price inline in the price field, so
   undercutting is a visible choice rather than an accident.
2. Surface a warning, not a block, when a course price falls below the monthly
   plan.
3. Watch the ratio of single-course to subscription purchases in the admin
   analytics of Section 14. If single-course sales climb while subscriptions
   flatten, pricing freedom is the first thing to look at.

**Price changes must be audited.** Every write to `courses.price_poisha` goes
through `audit_log` with before/after. Without it, a student disputing a price
becomes your word against a teacher's, with no record. This is not optional.

**A price change must never alter an issued entitlement.** `entitlements` rows
carry `payment_id` and the payment carries `amount_poisha` at the time of sale.
A teacher raising a price tomorrow has no effect on anyone who already bought.
The schema already gets this right; the rule is written here so it is not
"optimised away" later.

**Free is a valid price.** `price_poisha` defaults to 0. A teacher setting a
course to 0 makes it free without touching `lessons.is_free`, which is a
different mechanism (the Free Resource Center). Both paths must be handled in
the entitlement engine — currently only `is_free` is checked, so a
zero-priced course still requires an entitlement. **This is a gap to close in
Phase 2.**

## Promo codes — deferred, and what they will need

Not built now. Recorded so the eventual design is not re-derived:

- Teacher-generated, with teacher-set validity window and issue quantity.
- `promo_codes` (code, teacher, scope, discount kind and value, valid_from,
  valid_until, max_redemptions, redeemed_count) and `promo_redemptions`
  (code, student, payment).
- Redemption counting must be atomic. Two students redeeming the last unit of
  a code concurrently is a race that a read-then-write will lose.
- **The hard part is manual payment, not the codes.** A discounted payment
  means the admin verification queue in Section 8.2 must reconcile the
  transferred bKash amount against the *discounted* expected amount, not the
  list price. Getting this wrong means rejecting legitimate payments, which is
  the worst possible support outcome. Designing it against real payment traffic
  is why this waits until after soft launch.
