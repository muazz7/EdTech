import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { ApiError, ERROR_CODES, type ApiEnvelope } from '@edtech/shared';

/** All responses are { data, error, meta } (Section 18). */
export function ok<T>(data: T, meta?: Record<string, unknown>, status = 200) {
  const body: ApiEnvelope<T> = { data, error: null, ...(meta ? { meta } : {}) };
  return NextResponse.json(body, { status });
}

export function fail(error: ApiError) {
  const body: ApiEnvelope<never> = {
    data: null,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
  return NextResponse.json(body, { status: error.status });
}

/**
 * Wraps a route handler so every thrown ApiError becomes the documented
 * envelope and every unexpected throw becomes a 500 with no internals leaked.
 *
 * Anything unrecognised is logged for Sentry and returned as INTERNAL — a
 * stack trace or a Postgres error string in an API response is an information
 * leak, and the Flutter app switches on `code` anyway.
 */
export function route<A extends unknown[]>(
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof ApiError) return fail(err);

      if (err instanceof ZodError) {
        return fail(
          new ApiError(
            422,
            ERROR_CODES.VALIDATION_FAILED,
            undefined,
            err.flatten().fieldErrors,
          ),
        );
      }

      // Expected ApiErrors above are not reported — a 403 NO_ENTITLEMENT is
      // normal traffic, and reporting it would bury real faults. Only genuine
      // unhandled throws reach here. beforeSend in lib/sentry-shared scrubs
      // phone numbers, tokens and signed URLs.
      Sentry.captureException(err);
      console.error('[api] unhandled', err);
      return fail(new ApiError(500, ERROR_CODES.INTERNAL));
    }
  };
}

/**
 * Parses and validates a JSON body, throwing VALIDATION_FAILED with per-field
 * errors so the client can place each message next to its own input.
 *
 * Generic over the schema, not over a single T: a field with `.default()` is
 * optional on input and guaranteed on output, and `ZodSchema<T>` collapses the
 * two so callers receive the input type with the defaults still optional.
 */
export async function parseBody<S extends ZodTypeAny>(
  req: Request,
  schema: S,
): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, ERROR_CODES.VALIDATION_FAILED, 'Request body must be valid JSON.');
  }
  return schema.parse(raw);
}

/** Client IP behind Cloudflare then Vercel. */
export function clientIp(req: Request): string | null {
  return (
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-real-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    null
  );
}
