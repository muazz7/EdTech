import * as Sentry from '@sentry/nextjs';
import { beforeSend, sentryShared } from '@/lib/sentry-shared';

/**
 * Server and edge runtime Sentry init. Next.js calls register() once per
 * runtime before any other code.
 */
export async function register() {
  Sentry.init({
    ...sentryShared,
    beforeSend,
    beforeSendTransaction: beforeSend,
  });
}

export const onRequestError = Sentry.captureRequestError;
