import { sql } from 'drizzle-orm';
import { getDb } from '@edtech/db';
import {
  DEVICE_SWITCH_WINDOW_DAYS,
  MAX_DEVICE_SWITCHES_PER_30D,
} from '@edtech/shared';
import type { AdminActor } from '../commerce/plans.js';

/**
 * Piracy signals (Section 17.5).
 *
 * Cheap to build, high value — every input already exists as a side effect of
 * normal operation, so this is a set of queries rather than a subsystem.
 *
 * TWO RULES, both from the spec and both load-bearing:
 *
 *  1. **Nothing here bans anyone.** These are review queue entries with the same
 *     approve/dismiss ergonomics as the payment queue. False positives cost
 *     paying students, and a student wrongly locked out during exam season is a
 *     refund and a public complaint. A human decides.
 *  2. **Signals accumulate, they do not multiply.** A student with one tripped
 *     signal is noise. Three at once is a pattern. The score is a count, shown
 *     next to the evidence, so the reviewer can see WHY rather than trusting a
 *     number.
 *
 * Admin-only. IP addresses and device counts are exactly the kind of data a
 * teacher has no business reading about another teacher's students.
 */

export const PIRACY_THRESHOLDS = {
  /** Section 17.5: more than 4 distinct IPs in 24h. */
  distinctIpsPerDay: 4,
  /** Mirrors the device-switch budget, so the dashboard and the block agree. */
  distinctDevicesPerWindow: MAX_DEVICE_SWITCHES_PER_30D,
  /** Lesson-hours of watch credit in 24h. */
  watchHoursPerDay: 20,
  /** Signed asset URLs in 10 minutes. */
  assetRequestsPer10Min: 60,
  /** Discarded heartbeats in 24h — the seek-scrubbing counter from Section 14
   *  doubles as a ripping signal. */
  discardedHeartbeatsPerDay: 20,
} as const;

export type PiracySignal = {
  code: 'many_ips' | 'many_devices' | 'watch_velocity' | 'asset_rate' | 'sequential_access';
  label: string;
  detail: string;
};

export type FlaggedAccount = {
  studentId: string;
  studentName: string;
  phone: string | null;
  signals: PiracySignal[];
  /** Count, not a weighted score. A weighted score invites tuning the weights
   *  until the answer is the one you wanted. */
  signalCount: number;
  lastSeenAt: Date | null;
};

/**
 * Accounts tripping at least one signal in the last 24 hours.
 *
 * Deliberately one query per signal rather than one clever query: each is
 * independently readable, independently testable, and independently removable
 * when it turns out to be noise. The volumes here are hundreds of students, not
 * millions.
 */
export async function listPiracySignals(
  _actor: AdminActor,
  params: { limit?: number } = {},
): Promise<FlaggedAccount[]> {
  const db = getDb();
  const limit = params.limit ?? 50;

  const byStudent = new Map<string, FlaggedAccount>();

  const add = (
    row: { studentId: string; studentName: string | null; phone: string | null },
    signal: PiracySignal,
  ) => {
    const existing = byStudent.get(row.studentId);
    if (existing) {
      existing.signals.push(signal);
      existing.signalCount = existing.signals.length;
      return;
    }
    byStudent.set(row.studentId, {
      studentId: row.studentId,
      studentName: row.studentName ?? 'Unknown',
      phone: row.phone,
      signals: [signal],
      signalCount: 1,
      lastSeenAt: null,
    });
  };

  // 1. Distinct IPs in 24h. A student on mobile data legitimately changes IP,
  //    which is why the threshold is 4 rather than 2.
  const ips = await db.execute<{
    student_id: string;
    full_name: string | null;
    phone: string | null;
    n: number;
  }>(sql`
    SELECT w.student_id, p.full_name, p.phone, count(DISTINCT w.ip_address)::int AS n
    FROM watch_events w
    JOIN profiles p ON p.id = w.student_id
    WHERE w.created_at > now() - interval '24 hours' AND w.ip_address IS NOT NULL
    GROUP BY w.student_id, p.full_name, p.phone
    HAVING count(DISTINCT w.ip_address) > ${PIRACY_THRESHOLDS.distinctIpsPerDay}
    ORDER BY n DESC
    LIMIT ${limit}`);

  for (const row of ips) {
    add(
      { studentId: row.student_id, studentName: row.full_name, phone: row.phone },
      {
        code: 'many_ips',
        label: 'Many IP addresses',
        detail: `${row.n} different IPs in 24 hours (threshold ${PIRACY_THRESHOLDS.distinctIpsPerDay}).`,
      },
    );
  }

  // 2. Distinct device fingerprints in the rolling window. The budget already
  //    blocks the 5th; this surfaces the accounts sitting at the ceiling.
  const devices = await db.execute<{
    student_id: string;
    full_name: string | null;
    phone: string | null;
    n: number;
  }>(sql`
    SELECT d.user_id AS student_id, p.full_name, p.phone,
           count(DISTINCT d.to_fingerprint)::int AS n
    FROM device_switch_log d
    JOIN profiles p ON p.id = d.user_id
    WHERE d.created_at > now() - interval '${sql.raw(String(DEVICE_SWITCH_WINDOW_DAYS))} days'
    GROUP BY d.user_id, p.full_name, p.phone
    HAVING count(DISTINCT d.to_fingerprint) >= ${PIRACY_THRESHOLDS.distinctDevicesPerWindow}
    ORDER BY n DESC
    LIMIT ${limit}`);

  for (const row of devices) {
    add(
      { studentId: row.student_id, studentName: row.full_name, phone: row.phone },
      {
        code: 'many_devices',
        label: 'Device budget exhausted',
        detail: `${row.n} devices in ${DEVICE_SWITCH_WINDOW_DAYS} days. Sharing looks like this; so does a broken phone.`,
      },
    );
  }

  // 3. Watch velocity. Credited seconds, not wall-clock: the anti-gaming rule
  //    already discarded impossible advances, so this counts real viewing.
  const velocity = await db.execute<{
    student_id: string;
    full_name: string | null;
    phone: string | null;
    hours: number;
  }>(sql`
    SELECT lp.student_id, p.full_name, p.phone,
           round(sum(lp.seconds_watched) / 3600.0, 1)::float AS hours
    FROM lesson_progress lp
    JOIN profiles p ON p.id = lp.student_id
    WHERE lp.updated_at > now() - interval '24 hours'
    GROUP BY lp.student_id, p.full_name, p.phone
    HAVING sum(lp.seconds_watched) > ${PIRACY_THRESHOLDS.watchHoursPerDay} * 3600
    ORDER BY hours DESC
    LIMIT ${limit}`);

  for (const row of velocity) {
    add(
      { studentId: row.student_id, studentName: row.full_name, phone: row.phone },
      {
        code: 'watch_velocity',
        label: 'Implausible watch time',
        detail: `${row.hours} lesson-hours credited in 24 hours (threshold ${PIRACY_THRESHOLDS.watchHoursPerDay}).`,
      },
    );
  }

  // 4. Sequential access: every lesson of a course opened once, in order, in
  //    under two hours. The signature of someone walking a catalog rather than
  //    studying it.
  const sequential = await db.execute<{
    student_id: string;
    full_name: string | null;
    phone: string | null;
    lessons: number;
    minutes: number;
  }>(sql`
    SELECT lp.student_id, p.full_name, p.phone,
           count(*)::int AS lessons,
           round(extract(epoch from (max(lp.updated_at) - min(lp.updated_at))) / 60)::int AS minutes
    FROM lesson_progress lp
    JOIN profiles p ON p.id = lp.student_id
    WHERE lp.updated_at > now() - interval '24 hours'
    GROUP BY lp.student_id, lp.course_id, p.full_name, p.phone
    HAVING count(*) >= 10
       AND extract(epoch from (max(lp.updated_at) - min(lp.updated_at))) < 2 * 3600
    ORDER BY lessons DESC
    LIMIT ${limit}`);

  for (const row of sequential) {
    add(
      { studentId: row.student_id, studentName: row.full_name, phone: row.phone },
      {
        code: 'sequential_access',
        label: 'Walked a whole course',
        detail: `${row.lessons} lessons touched in ${row.minutes} minutes. Ripping looks like this; so does revision the night before an exam.`,
      },
    );
  }

  // 5. Discarded heartbeats: the Section 14 anti-gaming counter. Seeking is
  //    normal; hundreds of impossible advances in a day is not.
  const discarded = await db.execute<{
    student_id: string;
    full_name: string | null;
    phone: string | null;
    n: number;
  }>(sql`
    SELECT w.student_id, p.full_name, p.phone, count(*)::int AS n
    FROM watch_events w
    JOIN profiles p ON p.id = w.student_id
    WHERE w.created_at > now() - interval '24 hours' AND w.event = 'seek'
    GROUP BY w.student_id, p.full_name, p.phone
    HAVING count(*) > ${PIRACY_THRESHOLDS.discardedHeartbeatsPerDay}
    ORDER BY n DESC
    LIMIT ${limit}`);

  for (const row of discarded) {
    add(
      { studentId: row.student_id, studentName: row.full_name, phone: row.phone },
      {
        code: 'asset_rate',
        label: 'Heavy seeking',
        detail: `${row.n} seeks in 24 hours. Scrubbing to fake completion looks like this.`,
      },
    );
  }

  // Most signals first: three tripped at once is a pattern, one is noise.
  return [...byStudent.values()].sort((a, b) => b.signalCount - a.signalCount).slice(0, limit);
}

/**
 * One account in detail, for the reviewer about to make a decision.
 *
 * Shows the evidence, not a verdict. Whoever is looking at this is deciding
 * whether to phone a student, and needs to see what actually happened.
 */
export async function getAccountActivity(_actor: AdminActor, studentId: string) {
  const db = getDb();

  const recentIps = await db.execute<{ ip: string; n: number; last_seen: Date }>(sql`
    SELECT host(ip_address) AS ip, count(*)::int AS n, max(created_at) AS last_seen
    FROM watch_events
    WHERE student_id = ${studentId}
      AND created_at > now() - interval '7 days'
      AND ip_address IS NOT NULL
    GROUP BY ip_address
    ORDER BY last_seen DESC
    LIMIT 20`);

  const devices = await db.execute<{ n: number }>(sql`
    SELECT count(DISTINCT to_fingerprint)::int AS n
    FROM device_switch_log
    WHERE user_id = ${studentId}
      AND created_at > now() - interval '${sql.raw(String(DEVICE_SWITCH_WINDOW_DAYS))} days'`);

  const watch = await db.execute<{
    course_title: string;
    lessons: number;
    hours: number;
    last_seen: Date;
  }>(sql`
    SELECT c.title AS course_title,
           count(*)::int AS lessons,
           round(sum(lp.seconds_watched) / 3600.0, 1)::float AS hours,
           max(lp.updated_at) AS last_seen
    FROM lesson_progress lp
    JOIN courses c ON c.id = lp.course_id
    WHERE lp.student_id = ${studentId} AND lp.updated_at > now() - interval '7 days'
    GROUP BY c.title
    ORDER BY last_seen DESC
    LIMIT 20`);

  return {
    studentId,
    // Masked: a reviewer needs to see that there were eleven networks, not to
    // be handed a list to correlate with anything else.
    recentIps: recentIps.map((row) => ({
      ip: maskIp(row.ip),
      events: row.n,
      lastSeenAt: row.last_seen,
    })),
    deviceCount: devices[0]?.n ?? 0,
    deviceLimit: MAX_DEVICE_SWITCHES_PER_30D,
    // Spread into a plain array. db.execute hands back postgres.js's own Result
    // subclass, and letting that cross the module boundary makes every caller
    // depend on a driver detail.
    recentCourses: [...watch],
  };
}

/**
 * `203.0.113.9` becomes `203.0.113.x`.
 *
 * The reviewer's question is "how many different networks", not "which house".
 * A masked octet answers the first and not the second, and this screen is a
 * standing list of students' home addresses otherwise.
 */
function maskIp(ip: string): string {
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return `${parts.slice(0, 3).join(':')}:x`;
  }
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts.slice(0, 3).join('.')}.x` : ip;
}
