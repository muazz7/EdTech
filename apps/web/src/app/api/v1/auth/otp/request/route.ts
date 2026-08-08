import { ApiError, ERROR_CODES, otpRequestSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { supabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/auth/otp/request
 *
 * Phone + OTP is the primary path: Bangladeshi students reliably have a phone
 * number and unreliably have an email they check.
 *
 * Supabase's default Twilio provider is expensive for BD numbers — configure a
 * custom SMS hook pointing at Alpha Net or BulkSMSBD before this goes to
 * production, or the OTP line item in Section 20 is badly understated.
 *
 * TODO(Phase 0): rate limit 3/phone/15min and 10/IP/hour (Section 6.4) once
 * Upstash Redis is provisioned. Cloudflare rate-limiting rules should carry
 * the volumetric case at the edge so abuse never costs a function invocation.
 */
export const POST = route(async (req: Request) => {
  const { phone } = await parseBody(req, otpRequestSchema);

  const { error } = await supabaseAdmin().auth.signInWithOtp({
    phone,
    options: { shouldCreateUser: true },
  });

  if (error) {
    throw new ApiError(
      502,
      ERROR_CODES.UPSTREAM_FAILED,
      'Could not send the verification code. Check the number and try again.',
    );
  }

  // Never echo whether the number was already registered — that turns this
  // endpoint into an account-enumeration oracle.
  return ok({ sent: true, phone });
});
