// Mirrors busy time on a personal calendar onto this account's primary calendar as
// Out of Office events. Only free/busy is read, so no personal event details reach here.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Free/busy is fetched in chunks so one long query can't run into a range limit;
// mergeIntervals rejoins any block split at a chunk edge.
const FREEBUSY_CHUNK_MS = 30 * DAY_MS;
// Tags the events this script owns, so it never touches OOO events added by hand.
const MARKER = { key: 'calendarSync', value: 'personal-busy' };

/** Entry point for the time-driven trigger. Safe to run any number of times. */
function sync() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    console.warn('Previous sync is still running; skipping this run.');
    return;
  }
  try {
    runSync_();
  } finally {
    lock.releaseLock();
  }
}

/** Replaces any existing sync trigger with one that runs every CONFIG.triggerEveryHours. */
function installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'sync')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sync').timeBased().everyHours(CONFIG.triggerEveryHours).create();
  console.log(`sync() will run every ${CONFIG.triggerEveryHours} hour(s).`);
}

/**
 * Run once before going live: confirms the personal calendar's free/busy is readable, and
 * that an OOO event created here can be found again by its marker.
 */
function checkSetup() {
  const now = Date.now();
  const busy = fetchBusy_(now, now + 7 * DAY_MS);
  console.log(`Free/busy OK: ${busy.length} busy block(s) in the next 7 days.`);

  // A throwaway one-hour block a year out, with auto-decline off so it can't affect anything.
  const probeStart = now + 365 * DAY_MS;
  const probe = Calendar.Events.insert(
    oooEvent_({ start: probeStart, end: probeStart + HOUR_MS }, 'declineNone'),
    'primary',
  );
  try {
    const found = listSynced_(probeStart - HOUR_MS, probeStart + 2 * HOUR_MS).some((e) => e.id === probe.id);
    if (!found) throw new Error('Created a test OOO event but could not find it by its sync marker.');
    console.log('OOO create/find OK.');
  } finally {
    Calendar.Events.remove('primary', probe.id);
  }
}

function runSync_() {
  const now = Date.now();
  const bounds = {
    lookbackStart: now - CONFIG.lookbackDays * DAY_MS,
    now,
    horizon: now + CONFIG.daysAhead * DAY_MS,
  };
  const busy = fetchBusy_(bounds.lookbackStart, bounds.horizon + CONFIG.overhangDays * DAY_MS);
  const desired = selectWindow(mergeIntervals(busy), bounds);
  const existing = selectWindow(listSynced_(bounds.now, bounds.horizon), bounds);
  const plan = planChanges(desired, existing);

  console.log(
    `${CONFIG.dryRun ? '[dry run] ' : ''}${plan.creates.length} to create, ${plan.updates.length} to update, ` +
      `${plan.deletes.length} to delete, ${plan.unchanged} unchanged`,
  );
  plan.creates.forEach((i) => console.log(`+ ${describe_(i)}`));
  plan.updates.forEach((u) => console.log(`~ ${describe_(u.previous)}  =>  ${describe_(u)}`));
  plan.deletes.forEach((i) => console.log(`- ${describe_(i)}`));
  if (CONFIG.dryRun) return;

  // A failure partway through is fine: the next run diffs against whatever was written.
  plan.creates.forEach((i) => Calendar.Events.insert(oooEvent_(i), 'primary'));
  plan.updates.forEach((u) =>
    Calendar.Events.patch({ start: dateTime_(u.start), end: dateTime_(u.end) }, 'primary', u.id),
  );
  plan.deletes.forEach((i) => Calendar.Events.remove('primary', i.id));
}

/** Busy intervals on the personal calendar between two epoch-ms instants. */
function fetchBusy_(from, to) {
  const id = CONFIG.personalCalendarId;
  const busy = [];
  for (let chunkStart = from; chunkStart < to; chunkStart += FREEBUSY_CHUNK_MS) {
    const res = Calendar.Freebusy.query({
      timeMin: new Date(chunkStart).toISOString(),
      timeMax: new Date(Math.min(chunkStart + FREEBUSY_CHUNK_MS, to)).toISOString(),
      items: [{ id }],
    });
    const cal = res.calendars && res.calendars[id];
    // An unshared or misspelled calendar comes back with errors and no busy times. Treating
    // that as "nothing scheduled" would delete every synced block, so stop instead.
    if (!cal || (cal.errors && cal.errors.length)) {
      throw new Error(`Can't read free/busy for ${id}: ${JSON.stringify(cal ? cal.errors : res)}`);
    }
    (cal.busy || []).forEach((b) => busy.push({ start: Date.parse(b.start), end: Date.parse(b.end) }));
  }
  return busy;
}

/** OOO events owned by this script that end after timeMin and start before timeMax. */
function listSynced_(timeMin, timeMax) {
  const events = [];
  let pageToken;
  do {
    const options = {
      timeMin: new Date(timeMin).toISOString(),
      timeMax: new Date(timeMax).toISOString(),
      privateExtendedProperty: `${MARKER.key}=${MARKER.value}`,
      singleEvents: true,
      maxResults: 250,
    };
    if (pageToken) options.pageToken = pageToken;
    const res = Calendar.Events.list('primary', options);
    (res.items || []).forEach((e) => {
      if (e.eventType !== 'outOfOffice' || !e.start.dateTime) return;
      events.push({ id: e.id, start: Date.parse(e.start.dateTime), end: Date.parse(e.end.dateTime) });
    });
    pageToken = res.nextPageToken;
  } while (pageToken);
  return events;
}

function oooEvent_(interval, autoDeclineMode = CONFIG.autoDeclineMode) {
  return {
    summary: CONFIG.title,
    eventType: 'outOfOffice',
    start: dateTime_(interval.start),
    end: dateTime_(interval.end),
    outOfOfficeProperties: { autoDeclineMode, declineMessage: CONFIG.declineMessage },
    extendedProperties: { private: { [MARKER.key]: MARKER.value } },
  };
}

function dateTime_(ms) {
  return { dateTime: new Date(ms).toISOString() };
}

function describe_(i) {
  const fmt = (ms) => Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'EEE MMM d HH:mm');
  return `${fmt(i.start)} – ${fmt(i.end)}`;
}
