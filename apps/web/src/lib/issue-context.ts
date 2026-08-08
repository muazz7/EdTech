import type { GuardResult, IssueContext } from '@edtech/core';
import type { Platform } from '@edtech/shared';
import { clientIp } from './api';

/**
 * Builds the media issuance context from an authenticated request.
 *
 * Platform comes from the session row, not a client-supplied header: it decides
 * whether desktop-web resolution capping applies (Section 17.2), so a client
 * that could claim 'android' would opt itself out of the cap.
 */
export function issueContext(req: Request, guard: GuardResult): IssueContext {
  return {
    userId: guard.user.sub,
    sessionId: guard.session.id,
    ip: clientIp(req),
    platform: guard.session.platform as Platform,
  };
}
