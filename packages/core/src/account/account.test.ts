import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { uuidv7 } from 'uuidv7';
import { activeSessions, closeDb, deviceSwitchLog, getDb } from '@edtech/db';
import { getAccountSecurity } from './account.js';
import { cleanup, createUser } from '../testing/fixtures.js';

/**
 * Account screen data (Section 6.3).
 *
 * The counting rule is the part worth pressure: it has to match
 * evaluateDevicePolicy exactly. A student shown "2 of 4 used" who is then
 * blocked has been told something false, and that is a support message plus a
 * refund request rather than a UI nit.
 */

after(async () => {
  await cleanup();
  await closeDb();
});

async function openSession(userId: string, label: string) {
  const id = uuidv7();
  await getDb().insert(activeSessions).values({
    id,
    userId,
    deviceFingerprint: `fp-${id}`,
    deviceLabel: label,
    platform: 'web',
  });
  return id;
}

async function logSwitch(userId: string, fingerprint: string, ageDays = 0) {
  await getDb()
    .insert(deviceSwitchLog)
    .values({
      id: uuidv7(),
      userId,
      fromFingerprint: null,
      toFingerprint: fingerprint,
      createdAt: new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000),
    });
}

describe('account security', () => {
  it('reports the live session and marks it current', async () => {
    const user = await createUser();
    const sessionId = await openSession(user.id, 'Redmi Note 12');

    const account = await getAccountSecurity(user.id, sessionId);

    assert.equal(account.session?.deviceLabel, 'Redmi Note 12');
    assert.equal(account.session?.platform, 'web');
    assert.equal(account.session?.isCurrent, true);
  });

  it('never returns a device fingerprint', async () => {
    // A fingerprint is an internal hash. Handing one back tells anyone probing
    // the account exactly which value to replay.
    const user = await createUser();
    const sessionId = await openSession(user.id, 'Phone');
    await logSwitch(user.id, 'fp-secret-value');

    const account = await getAccountSecurity(user.id, sessionId);

    assert.equal(JSON.stringify(account).includes('fp-secret-value'), false);
    assert.equal(JSON.stringify(account).toLowerCase().includes('fingerprint'), false);
  });

  it('counts distinct devices, not switch events', async () => {
    // Switching back to a device already used is free, so counting rows would
    // show a number the student cannot reconcile with the block they hit.
    const user = await createUser();
    const sessionId = await openSession(user.id, 'Laptop');

    await logSwitch(user.id, 'device-a');
    await logSwitch(user.id, 'device-b');
    await logSwitch(user.id, 'device-a');
    await logSwitch(user.id, 'device-b');

    const account = await getAccountSecurity(user.id, sessionId);
    assert.equal(account.devices.used, 2, 'four switches between two devices is two devices');
    assert.equal(account.devices.remaining, account.devices.limit - 2);
  });

  it('ignores switches older than the rolling window', async () => {
    const user = await createUser();
    const sessionId = await openSession(user.id, 'Laptop');

    await logSwitch(user.id, 'old-device', 45);
    await logSwitch(user.id, 'recent-device', 1);

    const account = await getAccountSecurity(user.id, sessionId);
    assert.equal(account.devices.used, 1, 'the budget is rolling, not lifetime');
  });

  it('reports no session for a signed-out account', async () => {
    const user = await createUser();
    const account = await getAccountSecurity(user.id, uuidv7());
    assert.equal(account.session, null);
    assert.equal(account.devices.used, 0);
  });
});
