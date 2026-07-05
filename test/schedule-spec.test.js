const test = require('node:test');
const assert = require('node:assert');
const { parseWhen, nextFireAt, describe } = require('../src/schedule-spec');

const MON_10AM = new Date(2026, 6, 6, 10, 0).getTime(); // Mon 2026-07-06 10:00 local

// --- parseWhen: one-shot forms ---

test('parseWhen: absolute "YYYY-MM-DD HH:MM" in the future', () => {
  const spec = parseWhen({ at: '2026-07-10 09:00' }, MON_10AM);
  assert.deepStrictEqual(spec, { type: 'once', at: new Date(2026, 6, 10, 9, 0).getTime() });
});

test('parseWhen: absolute time in the past throws PAST_SCHEDULE', () => {
  assert.throws(() => parseWhen({ at: '2026-07-01 09:00' }, MON_10AM), (e) => e.code === 'PAST_SCHEDULE');
});

test('parseWhen: bare HH:MM later today stays today', () => {
  const spec = parseWhen({ at: '18:30' }, MON_10AM);
  assert.deepStrictEqual(spec, { type: 'once', at: new Date(2026, 6, 6, 18, 30).getTime() });
});

test('parseWhen: bare HH:MM already passed rolls to tomorrow', () => {
  const spec = parseWhen({ at: '09:00' }, MON_10AM);
  assert.deepStrictEqual(spec, { type: 'once', at: new Date(2026, 6, 7, 9, 0).getTime() });
});

test('parseWhen: relative --in 2h / 30m / 1d', () => {
  assert.deepStrictEqual(parseWhen({ in: '2h' }, MON_10AM), { type: 'once', at: MON_10AM + 2 * 3600000 });
  assert.deepStrictEqual(parseWhen({ in: '30m' }, MON_10AM), { type: 'once', at: MON_10AM + 30 * 60000 });
  assert.deepStrictEqual(parseWhen({ in: '1d' }, MON_10AM), { type: 'once', at: MON_10AM + 86400000 });
});

test('parseWhen: bad --in value throws BAD_SCHEDULE', () => {
  for (const bad of ['x', '2w', '-5m', '0h', '']) {
    assert.throws(() => parseWhen({ in: bad }, MON_10AM), (e) => e.code === 'BAD_SCHEDULE', '--in ' + bad);
  }
});

test('parseWhen: --at and --in together throw BAD_SCHEDULE', () => {
  assert.throws(() => parseWhen({ at: '18:30', in: '2h' }, MON_10AM), (e) => e.code === 'BAD_SCHEDULE');
});

// --- parseWhen: recurring forms ---

test('parseWhen: --every day --at 09:00', () => {
  const spec = parseWhen({ every: 'day', at: '09:00' }, MON_10AM);
  assert.deepStrictEqual(spec, { type: 'recurring', every: 'day', hour: 9, minute: 0 });
});

test('parseWhen: --every friday --at 09:00 (case-insensitive)', () => {
  const spec = parseWhen({ every: 'Friday', at: '09:00' }, MON_10AM);
  assert.deepStrictEqual(spec, { type: 'recurring', every: 'friday', hour: 9, minute: 0 });
});

test('parseWhen: --every month --on 31 --at 08:00', () => {
  const spec = parseWhen({ every: 'month', on: 31, at: '08:00' }, MON_10AM);
  assert.deepStrictEqual(spec, { type: 'recurring', every: 'month', on: 31, hour: 8, minute: 0 });
});

test('parseWhen: recurring rejections', () => {
  // --every needs --at HH:MM
  assert.throws(() => parseWhen({ every: 'day' }, MON_10AM), (e) => e.code === 'BAD_SCHEDULE');
  // --every month needs --on 1-31
  assert.throws(() => parseWhen({ every: 'month', at: '08:00' }, MON_10AM), (e) => e.code === 'BAD_SCHEDULE');
  assert.throws(() => parseWhen({ every: 'month', on: 32, at: '08:00' }, MON_10AM), (e) => e.code === 'BAD_SCHEDULE');
  // --on is only for month
  assert.throws(() => parseWhen({ every: 'day', on: 3, at: '08:00' }, MON_10AM), (e) => e.code === 'BAD_SCHEDULE');
  // unknown unit
  assert.throws(() => parseWhen({ every: 'fortnight', at: '08:00' }, MON_10AM), (e) => e.code === 'BAD_SCHEDULE');
  // --in with --every
  assert.throws(() => parseWhen({ every: 'day', in: '2h', at: '08:00' }, MON_10AM), (e) => e.code === 'BAD_SCHEDULE');
});

test('parseWhen: no schedule flags at all throws BAD_SCHEDULE', () => {
  assert.throws(() => parseWhen({}, MON_10AM), (e) => e.code === 'BAD_SCHEDULE');
});

test('parseWhen: malformed times throw BAD_SCHEDULE', () => {
  for (const bad of ['25:00', '09:60', 'nine', '2026-13-01 09:00', '2026-02-30 09:00']) {
    assert.throws(() => parseWhen({ at: bad }, MON_10AM), (e) => e.code === 'BAD_SCHEDULE' || e.code === 'PAST_SCHEDULE', '--at ' + bad);
  }
});

// --- nextFireAt ---

test('nextFireAt: once returns at when future, null when past', () => {
  assert.strictEqual(nextFireAt({ type: 'once', at: MON_10AM + 1000 }, MON_10AM), MON_10AM + 1000);
  assert.strictEqual(nextFireAt({ type: 'once', at: MON_10AM }, MON_10AM), null);
  assert.strictEqual(nextFireAt({ type: 'once', at: MON_10AM - 1 }, MON_10AM), null);
});

test('nextFireAt: daily picks today if still ahead, else tomorrow', () => {
  const spec1030 = { type: 'recurring', every: 'day', hour: 10, minute: 30 };
  assert.strictEqual(nextFireAt(spec1030, MON_10AM), new Date(2026, 6, 6, 10, 30).getTime());
  const spec9 = { type: 'recurring', every: 'day', hour: 9, minute: 0 };
  assert.strictEqual(nextFireAt(spec9, MON_10AM), new Date(2026, 6, 7, 9, 0).getTime());
});

test('nextFireAt: weekly lands on the next matching weekday', () => {
  const spec = { type: 'recurring', every: 'friday', hour: 9, minute: 0 };
  assert.strictEqual(nextFireAt(spec, MON_10AM), new Date(2026, 6, 10, 9, 0).getTime());
  // from exactly the fire instant, advances a full week
  const friday9 = new Date(2026, 6, 10, 9, 0).getTime();
  assert.strictEqual(nextFireAt(spec, friday9), new Date(2026, 6, 17, 9, 0).getTime());
});

test('nextFireAt: monthly on 31 clamps to short months', () => {
  const spec = { type: 'recurring', every: 'month', on: 31, hour: 8, minute: 0 };
  assert.strictEqual(nextFireAt(spec, MON_10AM), new Date(2026, 6, 31, 8, 0).getTime());
  // from Feb 1 2027 → Feb 28 2027 (2027 is not a leap year)
  const feb1 = new Date(2027, 1, 1, 0, 0).getTime();
  assert.strictEqual(nextFireAt(spec, feb1), new Date(2027, 1, 28, 8, 0).getTime());
  // after firing on Feb 28, next is Mar 31
  const feb28after = new Date(2027, 1, 28, 8, 0).getTime();
  assert.strictEqual(nextFireAt(spec, feb28after), new Date(2027, 2, 31, 8, 0).getTime());
});

test('nextFireAt: unrecognized recurring spec returns null instead of looping forever', () => {
  // scheduler.tick() calls nextFireAt on specs loaded verbatim from schedules.json;
  // a hand-edited/corrupt `every` value must not hang the daemon.
  assert.strictEqual(nextFireAt({ type: 'recurring', every: 'fridayy', hour: 9, minute: 0 }, MON_10AM), null);
});

test('nextFireAt: corrupt recurring specs return null and terminate (no daemon hang)', () => {
  // These must return promptly (the test completing at all proves no infinite loop).
  assert.strictEqual(nextFireAt({ type: 'recurring', every: 'monday', hour: 9 }, MON_10AM), null); // missing minute
  assert.strictEqual(nextFireAt({ type: 'recurring', every: 'friday', hour: 'nine', minute: 0 }, MON_10AM), null); // non-numeric hour
  assert.strictEqual(nextFireAt({ type: 'recurring', every: 'day', hour: 24, minute: 0 }, MON_10AM), null); // hour out of range
  assert.strictEqual(nextFireAt({ type: 'recurring', every: 'month', on: 'x', hour: 9, minute: 0 }, MON_10AM), null); // bad on
});

// --- describe ---

test('describe: human strings for previews', () => {
  assert.strictEqual(describe({ type: 'once', at: new Date(2026, 6, 10, 9, 5).getTime() }), 'once at 2026-07-10 09:05');
  assert.strictEqual(describe({ type: 'recurring', every: 'day', hour: 9, minute: 0 }), 'every day at 09:00');
  assert.strictEqual(describe({ type: 'recurring', every: 'friday', hour: 9, minute: 0 }), 'every friday at 09:00');
  assert.strictEqual(describe({ type: 'recurring', every: 'month', on: 1, hour: 8, minute: 30 }), 'every month on day 1 at 08:30');
});
