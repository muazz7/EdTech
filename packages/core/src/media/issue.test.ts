import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, lessons } from '@edtech/db';
import { ApiError } from '@edtech/shared';
import { issuePlayback } from './issue.js';
import { __setVideoProvider } from './vdocipher.js';
import { buildVdocipherAnnotation, maskPhone, sessionHash } from './watermark.js';
import { sanitiseSegment } from './r2.js';
import type {
  PlaybackGrant,
  UploadCredentials,
  VideoDetails,
  VideoProvider,
  WatermarkIdentity,
} from './types.js';
import { cleanup, createCourse, createUser, grantEntitlement } from '../testing/fixtures.js';
import { __resetMemoryLimiter } from '../rate-limit/limiter.js';

/**
 * Section 19.4, test 5: "Signed-URL issuance -- refuses without entitlement."
 *
 * The provider is faked so this needs no VdoCipher account, and so the test
 * asserts on what we control: that a grant is only ever minted after
 * checkLessonAccess passes, and that the watermark carries the requesting
 * account's identity.
 */

const DAY = 24 * 60 * 60 * 1000;

/** Records every call so the test can assert a grant was NOT minted. */
class FakeVideoProvider implements VideoProvider {
  readonly name = 'fake';
  grantCalls: Array<{ videoId: string; watermark: WatermarkIdentity; maxResolution?: number }> = [];

  async createUpload(): Promise<UploadCredentials> {
    return { videoId: 'fake-video', clientPayload: {} };
  }

  async getVideo(): Promise<VideoDetails> {
    return { status: 'ready', durationSeconds: 600 };
  }

  async createPlaybackGrant(
    videoId: string,
    watermark: WatermarkIdentity,
    options?: { ttlSeconds?: number; maxResolution?: number },
  ): Promise<PlaybackGrant> {
    this.grantCalls.push({ videoId, watermark, maxResolution: options?.maxResolution });
    return { otp: 'fake-otp', playbackInfo: 'fake-playback-info', expiresInSeconds: 300 };
  }

  async deleteVideo(): Promise<void> {}
}

let fake: FakeVideoProvider;
let teacher: { id: string };
let course: Awaited<ReturnType<typeof createCourse>>;

/** Marks a lesson as having a ready video, which playback requires. */
async function makePlayable(lessonId: string) {
  await getDb()
    .update(lessons)
    .set({ vdocipherVideoId: `vdo-${lessonId.slice(-8)}`, videoStatus: 'ready' })
    .where(eq(lessons.id, lessonId));
}

before(async () => {
  teacher = await createUser('teacher', 'Media Teacher');
  course = await createCourse({ teacherId: teacher.id, isInAllAccess: true });
  await makePlayable(course.paidLessonId);
  await makePlayable(course.freeLessonId);
});

beforeEach(() => {
  fake = new FakeVideoProvider();
  __setVideoProvider(fake);
  __resetMemoryLimiter();
});

after(async () => {
  __setVideoProvider(undefined);
  await cleanup();
  await closeDb();
});

function ctx(userId: string, platform: 'web' | 'android' = 'web') {
  return { userId, sessionId: '019fe000-0000-7000-8000-000000000001', ip: '203.0.113.9', platform };
}

describe('playback issuance refuses without entitlement', () => {
  it('denies a student with no entitlement and mints nothing', async () => {
    const student = await createUser();

    await assert.rejects(
      () => issuePlayback(ctx(student.id), course.paidLessonId),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 403);
        assert.equal(err.code, 'NO_ENTITLEMENT');
        return true;
      },
    );

    // The important assertion: the vendor was never asked for a grant. A denial
    // that still minted an OTP would be a leak, because the OTP alone is enough
    // to play the video.
    assert.equal(fake.grantCalls.length, 0);
  });

  it('denies an expired subscription and mints nothing', async () => {
    const student = await createUser();
    await grantEntitlement({
      studentId: student.id,
      kind: 'subscription',
      startsAt: new Date(Date.now() - 60 * DAY),
      expiresAt: new Date(Date.now() - DAY),
    });

    await assert.rejects(
      () => issuePlayback(ctx(student.id), course.paidLessonId),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.code, 'ENTITLEMENT_EXPIRED');
        return true;
      },
    );
    assert.equal(fake.grantCalls.length, 0);
  });

  it('denies a revoked entitlement and mints nothing', async () => {
    const student = await createUser();
    await grantEntitlement({
      studentId: student.id,
      kind: 'lifetime_all',
      revoked: true,
    });

    await assert.rejects(() => issuePlayback(ctx(student.id), course.paidLessonId), ApiError);
    assert.equal(fake.grantCalls.length, 0);
  });

  it('denies an unpublished lesson even to an entitled student', async () => {
    const draft = await createCourse({ teacherId: teacher.id, published: false });
    await makePlayable(draft.paidLessonId);

    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    await assert.rejects(
      () => issuePlayback(ctx(student.id), draft.paidLessonId),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.code, 'CONTENT_UNPUBLISHED');
        return true;
      },
    );
    assert.equal(fake.grantCalls.length, 0);
  });
});

describe('playback issuance succeeds when entitled', () => {
  it('mints a grant for an active subscription', async () => {
    const student = await createUser();
    await grantEntitlement({
      studentId: student.id,
      kind: 'subscription',
      expiresAt: new Date(Date.now() + 30 * DAY),
    });

    const grant = await issuePlayback(ctx(student.id), course.paidLessonId);
    assert.equal(grant.otp, 'fake-otp');
    assert.equal(grant.via, 'subscription');
    assert.equal(fake.grantCalls.length, 1);
  });

  it('mints a grant for a free lesson with no entitlement', async () => {
    const student = await createUser();
    const grant = await issuePlayback(ctx(student.id), course.freeLessonId);
    assert.equal(grant.via, 'free');
    assert.equal(fake.grantCalls.length, 1);
  });

  it('carries the requesting account into the watermark', async () => {
    // Section 17.4: attribution is the actual product, because the camera
    // attack is unpreventable. A grant whose watermark does not identify the
    // requester is worse than useless.
    const student = await createUser('student', 'Rahim Uddin');
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    await issuePlayback(ctx(student.id), course.paidLessonId);

    const call = fake.grantCalls[0];
    assert.ok(call);
    assert.equal(call.watermark.name, 'Rahim Uddin');
    assert.equal(call.watermark.ip, '203.0.113.9');
    assert.ok(call.watermark.phone.startsWith('+880'));
    assert.equal(call.watermark.sessionHash.length, 6);
  });

  it('caps desktop web to 720p and leaves mobile uncapped', async () => {
    // Section 17.2: desktop browsers commonly run Widevine L3, which has
    // documented key-extraction tooling. Capping limits what a successful
    // extraction is worth.
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    await issuePlayback(ctx(student.id, 'web'), course.paidLessonId);
    assert.equal(fake.grantCalls[0]?.maxResolution, 720);

    fake.grantCalls.length = 0;
    await issuePlayback(ctx(student.id, 'android'), course.paidLessonId);
    assert.equal(fake.grantCalls[0]?.maxResolution, undefined);
  });

  it('refuses a video that is still transcoding', async () => {
    const pending = await createCourse({ teacherId: teacher.id });
    await getDb()
      .update(lessons)
      .set({ vdocipherVideoId: 'vdo-pending', videoStatus: 'transcoding' })
      .where(eq(lessons.id, pending.paidLessonId));

    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    await assert.rejects(
      () => issuePlayback(ctx(student.id), pending.paidLessonId),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 409);
        return true;
      },
    );
    assert.equal(fake.grantCalls.length, 0);
  });
});

describe('rate limiting is inside the issuance path', () => {
  it('stops an account pulling grants past the hourly cap', async () => {
    // Enforced in issue.ts, not the route handler, so a new endpoint cannot
    // forget it. An account past this cap is ripping the catalog.
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    for (let i = 0; i < 60; i++) {
      await issuePlayback(ctx(student.id), course.paidLessonId);
    }

    await assert.rejects(
      () => issuePlayback(ctx(student.id), course.paidLessonId),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 429);
        return true;
      },
    );
    assert.equal(fake.grantCalls.length, 60);
  });
});

describe('watermark and key helpers', () => {
  it('masks the middle of a phone number', () => {
    const masked = maskPhone('+8801712345678');
    assert.ok(!masked.includes('1234'), 'middle digits should be hidden');
    assert.ok(masked.endsWith('678'));
  });

  it('produces a stable short session hash', () => {
    const a = sessionHash('019fe000-0000-7000-8000-000000000001');
    const b = sessionHash('019fe000-0000-7000-8000-000000000001');
    assert.equal(a, b);
    assert.equal(a.length, 6);
    assert.notEqual(a, sessionHash('019fe000-0000-7000-8000-000000000002'));
  });

  it('builds two moving annotations at different intervals', () => {
    // One annotation can be cropped or blurred out; two at different intervals
    // is materially harder (Section 9.1).
    const payload = JSON.parse(
      buildVdocipherAnnotation({
        name: 'Test',
        phone: '+8801712345678',
        ip: '1.2.3.4',
        sessionHash: 'abc123',
      }),
    ) as Array<{ type: string; alpha: string; interval: string }>;

    assert.equal(payload.length, 2);
    assert.ok(payload.every((a) => a.type === 'rtext'));
    assert.notEqual(payload[0]?.interval, payload[1]?.interval);
    // Alpha must survive re-encoding in a camera recording.
    assert.ok(Number(payload[0]?.alpha) >= 0.4);
  });

  it('strips path traversal from client-supplied filenames', () => {
    // Assert the property, not the exact collapsing: what matters is that no
    // separator or parent-directory sequence survives, so a filename cannot
    // escape its key prefix.
    for (const hostile of [
      '../../etc/passwd',
      '..\\..\\windows\\system32',
      'a/b\\c',
      '....//....//x',
    ]) {
      const safe = sanitiseSegment(hostile);
      assert.ok(!safe.includes('/'), `${safe} still has /`);
      assert.ok(!safe.includes('\\'), `${safe} still has \\`);
      assert.ok(!safe.includes('..'), `${safe} still has ..`);
    }

    assert.equal(sanitiseSegment('note page.pdf'), 'note_page.pdf');
    // Bengali filenames are normal here and must not produce an empty segment.
    assert.ok(sanitiseSegment('অধ্যায়-১.pdf').length > 0);
  });
});
