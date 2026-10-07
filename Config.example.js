// Copy to src/Config.js (gitignored) and fill in your personal calendar address.
const CONFIG = {
  // Personal calendar, shared with this (work) account as "See only free/busy (hide details)".
  personalCalendarId: 'your.name@gmail.com',

  // Busy blocks starting within this many days are mirrored.
  daysAhead: 60,
  // Ongoing blocks that started within this many days are still kept in sync (e.g. a
  // vacation you extend while on it). Anything older is left as it is.
  lookbackDays: 30,
  // Free/busy is read this far past the horizon so blocks near the edge aren't cut short.
  overhangDays: 30,

  title: 'Out of office',
  // declineNone | declineOnlyNewConflictingInvitations | declineAllConflictingInvitations
  autoDeclineMode: 'declineOnlyNewConflictingInvitations',
  declineMessage: "Sorry, I'm unavailable at this time.",

  // Apps Script accepts 1, 2, 4, 6, 8 or 12.
  triggerEveryHours: 8,

  // Log the plan without writing anything. Set to false once a run's log looks right.
  dryRun: true,
};
