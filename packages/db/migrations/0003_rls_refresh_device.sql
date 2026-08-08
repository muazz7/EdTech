-- refresh_tokens and device_tokens are server-only. RLS enabled with zero
-- policies denies every read and write that is not the service role.
--
-- A refresh token hash reachable from a browser session would defeat the point
-- of hashing it, and an FCM token roster is a device-enumeration list.
--
-- ASCII, no BOM, one statement per breakpoint. See 0001 for why.

ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY;
