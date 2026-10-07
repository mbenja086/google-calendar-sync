const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeIntervals, selectWindow, planChanges } = require('../src/Plan.js');

// Hours as the unit keeps the cases readable.
const H = 60 * 60 * 1000;
const iv = (start, end) => ({ start: start * H, end: end * H });
const ev = (id, start, end) => ({ id, ...iv(start, end) });

test('mergeIntervals sorts, merges overlapping and touching blocks, and drops empty ones', () => {
  assert.deepEqual(mergeIntervals([iv(5, 6), iv(1, 2), iv(2, 3), iv(1.5, 2.5), iv(4, 4)]), [iv(1, 3), iv(5, 6)]);
});

test('selectWindow keeps ongoing and upcoming blocks only', () => {
  const bounds = { lookbackStart: 0, now: 10 * H, horizon: 100 * H };
  const kept = selectWindow([iv(0, 20), iv(5, 9), iv(5, 12), iv(50, 60), iv(100, 110)], bounds);
  // iv(0, 20) may be truncated at the lookback edge; iv(5, 9) has ended; iv(100, 110) is past the horizon.
  assert.deepEqual(kept, [iv(5, 12), iv(50, 60)]);
});

test('planChanges leaves exact matches alone', () => {
  assert.deepEqual(planChanges([iv(1, 2)], [ev('a', 1, 2)]), { creates: [], updates: [], deletes: [], unchanged: 1 });
});

test('planChanges creates new blocks and deletes ones with no overlap', () => {
  const plan = planChanges([iv(1, 2)], [ev('a', 5, 6)]);
  assert.deepEqual(plan.creates, [iv(1, 2)]);
  assert.deepEqual(plan.deletes, [ev('a', 5, 6)]);
  assert.deepEqual(plan.updates, []);
});

test('planChanges moves an overlapping event instead of recreating it', () => {
  const plan = planChanges([iv(1, 3)], [ev('a', 1, 2)]);
  assert.deepEqual(plan.updates, [{ id: 'a', ...iv(1, 3), previous: iv(1, 2) }]);
  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.deletes, []);
});

test('planChanges deletes duplicate copies of a block', () => {
  const plan = planChanges([iv(1, 2)], [ev('a', 1, 2), ev('b', 1, 2)]);
  assert.deepEqual(plan.deletes, [ev('b', 1, 2)]);
  assert.equal(plan.unchanged, 1);
});

test('planChanges handles a block splitting in two', () => {
  const plan = planChanges([iv(1, 2), iv(3, 4)], [ev('a', 1, 4)]);
  assert.deepEqual(plan.updates, [{ id: 'a', ...iv(1, 2), previous: iv(1, 4) }]);
  assert.deepEqual(plan.creates, [iv(3, 4)]);
});

test('planChanges handles two blocks merging into one', () => {
  const plan = planChanges([iv(1, 4)], [ev('a', 1, 2), ev('b', 3, 4)]);
  assert.deepEqual(plan.updates, [{ id: 'a', ...iv(1, 4), previous: iv(1, 2) }]);
  assert.deepEqual(plan.deletes, [ev('b', 3, 4)]);
});
