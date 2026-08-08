-- RLS for payment_methods.
--
-- A student must be able to read the numbers they are told to pay, so this is
-- readable rather than server-only. Only ACTIVE rows are exposed: a teacher
-- deactivating an old number must not leave it visible to be paid into.
--
-- Writes are not covered by any policy, so with RLS enabled only the service
-- role can insert or update. Teachers manage their numbers through /api/v1,
-- which is where ownership is enforced.
--
-- ASCII, no BOM, one statement per breakpoint. See 0001 for why.

ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY payment_methods_read ON payment_methods FOR SELECT USING (
  is_active
);
