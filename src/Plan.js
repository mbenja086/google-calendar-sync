// Pure sync logic with no Apps Script services, so it can be unit tested in Node.
// Intervals are { start, end } in epoch milliseconds, end exclusive.

/** Sorts and merges overlapping or back-to-back intervals, dropping empty ones. */
function mergeIntervals(intervals) {
  const merged = [];
  intervals
    .filter((i) => i.end > i.start)
    .map((i) => ({ start: i.start, end: i.end }))
    .sort((a, b) => a.start - b.start)
    .forEach((i) => {
      const last = merged[merged.length - 1];
      if (last && i.start <= last.end) {
        last.end = Math.max(last.end, i.end);
      } else {
        merged.push(i);
      }
    });
  return merged;
}

/**
 * Keeps the intervals this sync is responsible for: not yet ended, starting before the
 * horizon, and starting after the lookback edge. A block that began at or before the
 * lookback edge may have been truncated by the free/busy query, so it is left alone on
 * both sides rather than "corrected" to a wrong start time.
 */
function selectWindow(intervals, bounds) {
  return intervals.filter(
    (i) => i.start > bounds.lookbackStart && i.start < bounds.horizon && i.end > bounds.now,
  );
}

/**
 * Diffs the busy blocks we want against the OOO events we already own.
 *
 * Exact matches are left alone. An existing event that overlaps an unmatched block is moved
 * onto it, so a rescheduled or extended personal event updates its OOO in place instead of
 * deleting and recreating it. Whatever is left over is created or deleted.
 */
function planChanges(desired, existing) {
  const key = (i) => `${i.start}|${i.end}`;
  const byKey = new Map();
  const leftover = [];
  existing.forEach((e) => {
    if (byKey.has(key(e))) {
      leftover.push(e); // duplicate copy of the same block
    } else {
      byKey.set(key(e), e);
    }
  });

  const unmatched = [];
  desired.forEach((d) => {
    // delete() returns true when an exact match existed.
    if (!byKey.delete(key(d))) unmatched.push(d);
  });
  leftover.push(...byKey.values());
  leftover.sort((a, b) => a.start - b.start);

  const creates = [];
  const updates = [];
  unmatched.forEach((d) => {
    const idx = leftover.findIndex((e) => e.start < d.end && d.start < e.end);
    if (idx === -1) {
      creates.push(d);
    } else {
      const [e] = leftover.splice(idx, 1);
      updates.push({ id: e.id, start: d.start, end: d.end, previous: { start: e.start, end: e.end } });
    }
  });

  return { creates, updates, deletes: leftover, unchanged: desired.length - unmatched.length };
}

if (typeof module !== 'undefined') module.exports = { mergeIntervals, selectWindow, planChanges };
