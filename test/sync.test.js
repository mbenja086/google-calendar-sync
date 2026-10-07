// Runs the Apps Script sources in a VM against fake Calendar/Lock/Utilities services.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const H = 60 * 60 * 1000;
const D = 24 * H;
const NOW = Date.UTC(2026, 9, 7, 15, 0);
const PERSONAL = 'personal@example.com';
const iso = (ms) => new Date(ms).toISOString();

const synced = (id, start, end) => ({
  id,
  eventType: 'outOfOffice',
  start: { dateTime: iso(start) },
  end: { dateTime: iso(end) },
  extendedProperties: { private: { calendarSync: 'personal-busy' } },
});

function load({ busy = [], events = [], freebusyErrors, dryRun = false }) {
  const store = new Map(events.map((e) => [e.id, structuredClone(e)]));
  const queries = [];
  const logs = [];
  let nextId = 1;
  const plain = (o) => JSON.parse(JSON.stringify(o));

  const Calendar = {
    Freebusy: {
      query(req) {
        queries.push(plain(req));
        const id = req.items[0].id;
        if (freebusyErrors) return { calendars: { [id]: { errors: freebusyErrors, busy: [] } } };
        const min = Date.parse(req.timeMin);
        const max = Date.parse(req.timeMax);
        const clipped = busy
          .filter(([s, e]) => s < max && e > min)
          .map(([s, e]) => ({ start: iso(Math.max(s, min)), end: iso(Math.min(e, max)) }));
        return { calendars: { [id]: { busy: clipped } } };
      },
    },
    Events: {
      list(calendarId, opts) {
        const [k, v] = opts.privateExtendedProperty.split('=');
        const min = Date.parse(opts.timeMin);
        const max = Date.parse(opts.timeMax);
        const matches = [...store.values()].filter(
          (e) =>
            e.extendedProperties?.private?.[k] === v &&
            Date.parse(e.end.dateTime) > min &&
            Date.parse(e.start.dateTime) < max,
        );
        // Two per page, to exercise pagination.
        const offset = Number(opts.pageToken || 0);
        const nextPageToken = offset + 2 < matches.length ? String(offset + 2) : undefined;
        return { items: matches.slice(offset, offset + 2), nextPageToken };
      },
      insert(resource) {
        const e = { ...plain(resource), id: `new${nextId++}` };
        store.set(e.id, e);
        return e;
      },
      patch(resource, calendarId, id) {
        Object.assign(store.get(id), plain(resource));
      },
      remove(calendarId, id) {
        store.delete(id);
      },
    },
  };

  const ctx = vm.createContext({
    Calendar,
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: { formatDate: (d) => d.toISOString() },
    Session: { getScriptTimeZone: () => 'UTC' },
    console: { log: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  vm.runInContext(`Date.now = () => ${NOW};`, ctx);
  // The example config, so tests don't depend on (or require) a local src/Config.js.
  for (const file of ['Config.example.js', 'src/Plan.js', 'src/Sync.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ctx, { filename: file });
  }
  vm.runInContext(`CONFIG.personalCalendarId = ${JSON.stringify(PERSONAL)}; CONFIG.dryRun = ${dryRun};`, ctx);
  return { store, queries, logs, sync: () => vm.runInContext('sync()', ctx) };
}

const times = (e) => [Date.parse(e.start.dateTime), Date.parse(e.end.dateTime)];

test('creates a tagged OOO event per busy block', () => {
  const { store, sync } = load({ busy: [[NOW + D, NOW + D + H]] });
  sync();
  const [e] = store.values();
  assert.equal(store.size, 1);
  assert.equal(e.eventType, 'outOfOffice');
  assert.equal(e.summary, 'Out of office');
  assert.equal(e.outOfOfficeProperties.autoDeclineMode, 'declineOnlyNewConflictingInvitations');
  assert.deepEqual(e.extendedProperties, { private: { calendarSync: 'personal-busy' } });
  assert.deepEqual(times(e), [NOW + D, NOW + D + H]);
});

test('updates moved blocks, deletes removed ones, and ignores events it does not own', () => {
  const manual = { ...synced('manual', NOW + 3 * D, NOW + 3 * D + H), extendedProperties: undefined };
  const { store, sync } = load({
    busy: [
      [NOW + D, NOW + D + H], // unchanged
      [NOW + 2 * D, NOW + 2 * D + 2 * H], // extended by an hour
    ],
    events: [
      synced('same', NOW + D, NOW + D + H),
      synced('moved', NOW + 2 * D, NOW + 2 * D + H),
      synced('gone', NOW + 3 * D, NOW + 3 * D + H),
      manual,
    ],
  });
  sync();
  assert.deepEqual([...store.keys()].sort(), ['manual', 'moved', 'same']);
  assert.deepEqual(times(store.get('moved')), [NOW + 2 * D, NOW + 2 * D + 2 * H]);
});

test('a second run changes nothing', () => {
  const { store, logs, sync } = load({ busy: [[NOW + D, NOW + D + H]] });
  sync();
  sync();
  assert.equal(store.size, 1);
  assert.match(logs.at(-1), /^0 to create, 0 to update, 0 to delete, 1 unchanged$/);
});

test('dry run logs the plan without writing', () => {
  const { store, logs, sync } = load({ busy: [[NOW + D, NOW + D + H]], dryRun: true });
  sync();
  assert.equal(store.size, 0);
  assert.match(logs[0], /^\[dry run\] 1 to create/);
});

test('stops without deleting anything when free/busy is unreadable', () => {
  const { store, sync } = load({
    events: [synced('a', NOW + D, NOW + D + H)],
    freebusyErrors: [{ domain: 'global', reason: 'notFound' }],
  });
  assert.throws(sync, /Can't read free\/busy for personal@example.com/);
  assert.deepEqual([...store.keys()], ['a']);
});

test('a block spanning a free/busy chunk edge becomes one event', () => {
  // Chunks start at the lookback edge (NOW - 30d), so one edge falls at NOW + 30d.
  const { store, queries, sync } = load({ busy: [[NOW + 30 * D - H, NOW + 30 * D + H]] });
  sync();
  assert.ok(queries.length > 1);
  assert.equal(store.size, 1);
  assert.deepEqual(times([...store.values()][0]), [NOW + 30 * D - H, NOW + 30 * D + H]);
});

test('leaves a block that started before the lookback edge alone', () => {
  const { store, sync } = load({
    busy: [[NOW - 40 * D, NOW + D + H]], // free/busy truncates this to start at NOW - 30d
    events: [synced('leave', NOW - 40 * D, NOW + D)],
  });
  sync();
  assert.deepEqual([...store.keys()], ['leave']);
  assert.deepEqual(times(store.get('leave')), [NOW - 40 * D, NOW + D]);
});
