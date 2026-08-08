import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatMarks, parseMarks, percentOf, sumMarks } from '@edtech/shared';

/**
 * Decimal-safe marks arithmetic.
 *
 * Pure functions, no database. They exist because a quiz total that is 0.01 off
 * decides pass/fail, and pass/fail decides whether a certificate is issued.
 */

describe('marks arithmetic', () => {
  it('does not lose the cent that float addition loses', () => {
    // 0.1 + 0.2 === 0.30000000000000004 as JavaScript numbers. Three questions
    // worth 0.1 each must total exactly 0.30.
    const total = sumMarks(['0.1', '0.2']);
    assert.equal(formatMarks(total), '0.30');
    assert.equal(formatMarks(sumMarks(['0.1', '0.1', '0.1'])), '0.30');
  });

  it('round-trips database numeric strings', () => {
    for (const value of ['0', '1', '2.5', '12.34', '100.00', '0.05']) {
      assert.equal(parseMarks(formatMarks(parseMarks(value))), parseMarks(value));
    }
  });

  it('treats a missing score as zero rather than NaN', () => {
    // An ungraded answer has a null awarded_marks. NaN here would be written
    // back to the database as a null total.
    assert.equal(parseMarks(null), 0);
    assert.equal(parseMarks(undefined), 0);
  });

  it('refuses a value that is not marks', () => {
    assert.throws(() => parseMarks('twelve'));
    assert.throws(() => parseMarks(''));
  });

  it('lands exactly on a pass boundary', () => {
    // 12.3 out of 30 is 41%, and a quiz with a 41% pass mark must pass. Float
    // division here is what makes that flaky.
    assert.equal(percentOf(parseMarks('12.30'), parseMarks('30.00')), 41);
    assert.equal(percentOf(parseMarks('20'), parseMarks('40')), 50);
    assert.equal(percentOf(parseMarks('0'), parseMarks('40')), 0);
  });

  it('does not divide by zero on an empty quiz', () => {
    assert.equal(percentOf(0, 0), 0);
  });
});
