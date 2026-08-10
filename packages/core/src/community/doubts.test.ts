import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import { closeDb, doubtReplies, doubtReports, doubtThreads, getDb } from '@edtech/db';
import { ApiError } from '@edtech/shared';
import {
  createThread,
  getThread,
  hidePost,
  listLessonThreads,
  listOpenReports,
  listTeacherDoubts,
  replyToThread,
  reportPost,
  setThreadPinned,
  setThreadResolved,
} from './doubts.js';
import type { Actor } from '../content/ownership.js';
import { cleanup, createCourse, createUser, grantEntitlement } from '../testing/fixtures.js';

/**
 * Doubt threads (Section 12).
 *
 * Public-by-default is the design, so the assertions worth having are about the
 * exceptions: a private thread stays between its author and the teacher, a
 * hidden one disappears without being destroyed, and `is_teacher_answer` cannot
 * be claimed by a student.
 */

let teacher: Actor;
let teacherId: string;
let course: Awaited<ReturnType<typeof createCourse>>;

async function entitledStudent(name = 'Doubt Student') {
  const student = await createUser('student', name);
  await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });
  return student;
}

before(async () => {
  const user = await createUser('teacher', 'Doubt Teacher');
  teacherId = user.id;
  teacher = { userId: user.id, role: 'teacher' };
  course = await createCourse({ teacherId: user.id, isInAllAccess: true });
});

after(async () => {
  const db = getDb();
  const threads = await db
    .select({ id: doubtThreads.id })
    .from(doubtThreads)
    .where(eq(doubtThreads.courseId, course.courseId));

  for (const thread of threads) {
    await db.delete(doubtReports).where(eq(doubtReports.threadId, thread.id));
    await db.delete(doubtReplies).where(eq(doubtReplies.threadId, thread.id));
  }
  await db.delete(doubtThreads).where(eq(doubtThreads.courseId, course.courseId));

  await cleanup();
  await closeDb();
});

describe('asking and answering', () => {
  it('lets an entitled student ask and everyone entitled read it', async () => {
    const asker = await entitledStudent('Asker');
    const reader = await entitledStudent('Reader');

    const thread = await createThread(asker.id, course.paidLessonId, {
      title: 'Why does the sign flip here?',
      body: 'In step three the minus disappears and I cannot see why.',
      isPublic: true,
    });

    const seen = await listLessonThreads(reader.id, course.paidLessonId);
    assert.ok(seen.some((row) => row.id === thread.id), 'a public thread is for everyone');
  });

  it('refuses a student with no access to the lesson', async () => {
    const outsider = await createUser();

    await assert.rejects(
      () =>
        createThread(outsider.id, course.paidLessonId, {
          title: 'Can I ask anyway?',
          body: 'Trying to post without paying.',
          isPublic: true,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 403);
        return true;
      },
    );
  });

  it('flags the teacher answer from the live role, not the request', async () => {
    // This flag renders a reply as authoritative, so a student must not be able
    // to claim it.
    const asker = await entitledStudent();
    const thread = await createThread(asker.id, course.paidLessonId, {
      title: 'Which formula applies?',
      body: 'Between the two on page 40.',
      isPublic: true,
    });

    const studentReply = await replyToThread(asker.id, thread.id, { body: 'I think it is the second.' });
    assert.equal(studentReply.isTeacherAnswer, false);

    const teacherReply = await replyToThread(teacherId, thread.id, { body: 'The second one.' });
    assert.equal(teacherReply.isTeacherAnswer, true);
  });

  it('keeps the reply count in step with the replies', async () => {
    const asker = await entitledStudent();
    const thread = await createThread(asker.id, course.paidLessonId, {
      title: 'Counting replies',
      body: 'Testing the denormalised count.',
      isPublic: true,
    });

    await replyToThread(teacherId, thread.id, { body: 'One.' });
    await replyToThread(teacherId, thread.id, { body: 'Two.' });

    const full = await getThread(asker.id, thread.id);
    assert.equal(full.replies.length, 2);

    const listed = await listLessonThreads(asker.id, course.paidLessonId);
    assert.equal(listed.find((row) => row.id === thread.id)?.replyCount, 2);
  });
});

describe('private threads', () => {
  it('hides a private thread from other students', async () => {
    const asker = await entitledStudent('Private Asker');
    const nosy = await entitledStudent('Nosy Student');

    const thread = await createThread(asker.id, course.paidLessonId, {
      title: 'I do not understand anything',
      body: 'Embarrassed to ask in public.',
      isPublic: false,
    });

    const theirs = await listLessonThreads(nosy.id, course.paidLessonId);
    assert.equal(theirs.some((row) => row.id === thread.id), false);

    // 404, not 403: a link must not confirm the thread exists.
    await assert.rejects(
      () => getThread(nosy.id, thread.id),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        return true;
      },
    );
  });

  it('still shows it to the author and the teacher', async () => {
    const asker = await entitledStudent('Private Asker');
    const thread = await createThread(asker.id, course.paidLessonId, {
      title: 'Private question',
      body: 'For the teacher only.',
      isPublic: false,
    });

    assert.ok(await getThread(asker.id, thread.id));
    assert.ok(await getThread(teacherId, thread.id));
  });

  it('refuses a stranger replying to a private thread', async () => {
    const asker = await entitledStudent('Private Asker');
    const nosy = await entitledStudent('Nosy Student');

    const thread = await createThread(asker.id, course.paidLessonId, {
      title: 'Private again',
      body: 'Between me and the teacher.',
      isPublic: false,
    });

    await assert.rejects(
      () => replyToThread(nosy.id, thread.id, { body: 'Butting in.' }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        return true;
      },
    );
  });
});

describe('moderation', () => {
  it('hides a thread without destroying it', async () => {
    // A student whose question was taken down will ask why, and the record has
    // to survive that conversation.
    const asker = await entitledStudent();
    const reader = await entitledStudent('Reader');

    const thread = await createThread(asker.id, course.paidLessonId, {
      title: 'Something inappropriate',
      body: 'To be hidden.',
      isPublic: true,
    });

    await hidePost(teacher, { threadId: thread.id }, 'Off topic');

    const visible = await listLessonThreads(reader.id, course.paidLessonId);
    assert.equal(visible.some((row) => row.id === thread.id), false);

    const row = await getDb().query.doubtThreads.findFirst({
      where: eq(doubtThreads.id, thread.id),
    });
    assert.ok(row, 'the row must survive');
    assert.ok(row.hiddenAt);
    assert.equal(row.hiddenReason, 'Off topic');
  });

  it('refuses replies to a hidden thread', async () => {
    const asker = await entitledStudent();
    const thread = await createThread(asker.id, course.paidLessonId, {
      title: 'Closing this',
      body: 'To be hidden.',
      isPublic: true,
    });
    await hidePost(teacher, { threadId: thread.id }, 'Closed');

    await assert.rejects(() => replyToThread(asker.id, thread.id, { body: 'Still here?' }));
  });

  it('keeps one teacher out of another teacher\'s threads', async () => {
    const asker = await entitledStudent();
    const thread = await createThread(asker.id, course.paidLessonId, {
      title: 'Not yours to moderate',
      body: 'Belongs to another course.',
      isPublic: true,
    });

    const outsiderUser = await createUser('teacher', 'Other Teacher');
    const outsider: Actor = { userId: outsiderUser.id, role: 'teacher' };

    await assert.rejects(
      () => setThreadResolved(outsider, thread.id, true),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        return true;
      },
    );

    const inbox = await listTeacherDoubts(outsider);
    assert.equal(inbox.some((row) => row.id === thread.id), false);
  });

  it('puts pinned and unresolved threads first', async () => {
    const asker = await entitledStudent();

    const old = await createThread(asker.id, course.freeLessonId, {
      title: 'Older question',
      body: 'Asked first.',
      isPublic: true,
    });
    const pinned = await createThread(asker.id, course.freeLessonId, {
      title: 'The one worth reading',
      body: 'Pinned by the teacher.',
      isPublic: true,
    });

    await setThreadResolved(teacher, old.id, true);
    await setThreadPinned(teacher, pinned.id, true);

    const listed = await listLessonThreads(asker.id, course.freeLessonId);
    assert.equal(listed[0]?.id, pinned.id, 'pinned comes first');
  });
});

describe('reporting', () => {
  it('records a report and shows it to the teacher', async () => {
    const asker = await entitledStudent();
    const reporter = await entitledStudent('Reporter');

    const thread = await createThread(asker.id, course.paidLessonId, {
      title: 'Reported thread',
      body: 'Something worth flagging.',
      isPublic: true,
    });

    await reportPost(reporter.id, { threadId: thread.id }, 'Rude');

    const reports = await listOpenReports(teacher);
    assert.ok(reports.some((row) => row.threadId === thread.id));
  });

  it('counts one report per student, however many times they press it', async () => {
    // A report is a signal to a teacher, not a vote.
    const asker = await entitledStudent();
    const reporter = await entitledStudent('Reporter');

    const thread = await createThread(asker.id, course.paidLessonId, {
      title: 'Double reported',
      body: 'Pressed twice.',
      isPublic: true,
    });

    await reportPost(reporter.id, { threadId: thread.id }, 'Rude');
    const second = await reportPost(reporter.id, { threadId: thread.id }, 'Rude again');
    assert.deepEqual(second, { reported: true }, 'a duplicate is not an error');

    const rows = await getDb()
      .select({ id: doubtReports.id })
      .from(doubtReports)
      .where(eq(doubtReports.threadId, thread.id));
    assert.equal(rows.length, 1);
  });

  it('closes the reports when the post is hidden', async () => {
    const asker = await entitledStudent();
    const reporter = await entitledStudent('Reporter');

    const thread = await createThread(asker.id, course.paidLessonId, {
      title: 'Hidden after report',
      body: 'Reported then hidden.',
      isPublic: true,
    });
    await reportPost(reporter.id, { threadId: thread.id }, 'Spam');
    await hidePost(teacher, { threadId: thread.id }, 'Spam');

    const open = await listOpenReports(teacher);
    assert.equal(open.some((row) => row.threadId === thread.id), false);
  });

  it('refuses a report from someone who cannot see the thread', async () => {
    const asker = await entitledStudent();
    const outsider = await createUser();

    const thread = await createThread(asker.id, course.paidLessonId, {
      title: 'Not visible to outsiders',
      body: 'Paid course.',
      isPublic: true,
    });

    await assert.rejects(() => reportPost(outsider.id, { threadId: thread.id }, 'Nonsense'));
  });
});
