import { auditLog, getDb, type DbOrTransaction } from '@edtech/db';

/**
 * Immutable audit trail (Section 2.1: "Every privileged action, immutable").
 *
 * Never UPDATE or DELETE a row here. The table exists precisely so that a
 * dispute has a record neither party can edit.
 *
 * ADR 0002 makes this load-bearing for pricing: teachers set their own course
 * prices, so a student disputing what they were charged is otherwise your word
 * against a teacher's with nothing written down.
 */

export type AuditEntry = {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
};

export async function recordAudit(entry: AuditEntry, tx?: DbOrTransaction): Promise<void> {
  const db = tx ?? getDb();
  await db.insert(auditLog).values({
    actorId: entry.actorId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    before: entry.before === undefined ? null : (entry.before as never),
    after: entry.after === undefined ? null : (entry.after as never),
    ipAddress: entry.ipAddress ?? null,
  });
}

/**
 * Diffs two records down to only the changed keys.
 *
 * Storing whole rows makes the log unreadable at the moment it matters most —
 * scanning for "who changed the price" through fifty unchanged fields.
 */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { before: Partial<T>; after: Partial<T>; changed: string[] } {
  const b: Partial<T> = {};
  const a: Partial<T> = {};
  const changed: string[] = [];

  for (const key of Object.keys(after) as Array<keyof T>) {
    const next = after[key];
    if (next === undefined) continue;
    const prev = before[key];
    // Dates and scalars only; nothing in the audited tables is deeply nested.
    const same =
      prev instanceof Date && next instanceof Date
        ? prev.getTime() === next.getTime()
        : prev === next;
    if (!same) {
      b[key] = prev;
      a[key] = next as T[keyof T];
      changed.push(String(key));
    }
  }

  return { before: b, after: a, changed };
}
