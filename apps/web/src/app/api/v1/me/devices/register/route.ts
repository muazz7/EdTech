import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { guardRequest, registerDeviceToken } from '@edtech/core';
import { platformSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  fcmToken: z.string().min(20).max(4096),
  platform: platformSchema,
});

/**
 * POST /api/v1/me/devices/register
 *
 * The mobile client calls this after login and whenever FCM rotates its token.
 * Without a registered token the new-device logout push in Section 15 has
 * nowhere to send, and the kicked device only discovers the revocation on its
 * next request.
 *
 * Upserts on (user, token): the same physical device re-registers periodically,
 * and a shared phone can carry tokens for more than one account.
 */
export const POST = route(async (req: Request) => {
  const { user, session } = await guardRequest(req.headers);
  const { fcmToken, platform } = await parseBody(req, bodySchema);

  await registerDeviceToken({
    id: uuidv7(),
    userId: user.sub,
    sessionId: session.id,
    fcmToken,
    platform,
    deviceFingerprint: session.deviceFingerprint,
  });

  return ok({ registered: true });
});
