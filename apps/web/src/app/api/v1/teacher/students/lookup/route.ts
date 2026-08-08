import { z } from 'zod';
import { findStudentByPhone } from '@edtech/core';
import { phoneSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const lookupSchema = z.object({ phone: phoneSchema });

/**
 * POST /api/v1/teacher/students/lookup  { phone }
 *
 * Exact phone match only. A fuzzy search here would let any teacher browse the
 * whole platform's student list, including every other teacher's customers.
 *
 * POST rather than GET so the number does not land in server logs, proxy logs
 * or the browser history as a query string.
 */
export const POST = route(async (req: Request) => {
  const actor = await teacherActor(req);
  const { phone } = await parseBody(req, lookupSchema);
  return ok(await findStudentByPhone(actor, phone));
});
