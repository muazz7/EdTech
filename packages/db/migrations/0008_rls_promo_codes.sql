-- Row level security for promo_codes.
--
-- No policy at all: server-only. A promo code is a bearer secret in practice —
-- anyone who can read the table can read every unredeemed code on the platform
-- and take the discount. Validation goes through the API, which checks the
-- window, the quantity and the course scope before it says anything.
--
-- Supabase grants `anon` SELECT on public-schema tables by default and the anon
-- key ships in the client bundle, so RLS is the only thing standing between a
-- new table and a public one. See scripts/rls-audit.mjs.

ALTER TABLE promo_codes ENABLE ROW LEVEL SECURITY;
