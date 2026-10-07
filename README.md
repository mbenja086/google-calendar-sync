# calendar-sync

A Google Apps Script that runs in the **work** account. It mirrors busy time from the personal
calendar onto the work calendar as Out of Office events, one per contiguous busy block. It reads
only free/busy, so no personal titles, descriptions, or locations leave the personal account.

Each run reads the next 60 days of personal free/busy, compares it with the OOO events the script
owns (tagged with a private extended property), and creates, moves, or deletes events to match.
The work calendar holds all of the state, so a rerun or a half-finished run is harmless. OOO
events you add by hand are never touched.

## Behaviour to know about

- **All-day events only sync if they're marked Busy.** Google Calendar creates all-day events as
  "Free" by default, and free/busy doesn't report free time. Set Busy on vacation days and similar.
  They come across as midnight-to-midnight OOO blocks, because the API doesn't allow all-day OOO events.
- **Auto-decline** is `declineOnlyNewConflictingInvitations`: invites that arrive later for a
  blocked time are declined, and meetings you've already accepted are left alone.
- **Back-to-back or overlapping personal events become one OOO block.** With free/busy only, the
  script sees busy time, not individual events.

## Setup

1. **Share the personal calendar** with the work account: personal Google Calendar → Settings →
   your calendar → *Share with specific people* → add the work address with
   **See only free/busy (hide details)**.
2. Create your local config, which is gitignored, and set `personalCalendarId` in it:
   ```sh
   cp Config.example.js src/Config.js
   ```
   Also check `timeZone` in `src/appsscript.json`. It only changes how log lines are shown.
3. Signed in as the work account, turn on the Apps Script API at
   <https://script.google.com/home/usersettings>.
4. `npm install && npx clasp login` and sign in with the **work** account.
5. Create a blank project at <https://script.google.com> (work account), name it *Calendar Sync*,
   copy the Script ID from *Project Settings*, and put it in a local (gitignored) `.clasp.json`:
   ```sh
   cp .clasp.json.example .clasp.json   # then paste in the Script ID
   npx clasp push --force
   npm run open
   ```
6. In the editor, run **`checkSetup`** and approve the permissions. It confirms free/busy is
   readable and does a create/find/delete round trip with a test OOO event a year out.
7. Run **`sync`**. `dryRun` is on, so it only logs what it would do. Review that log.
8. Set `dryRun: false` in `src/Config.js`, `npm run push`, run `sync` once, then run
   **`installTrigger`** to schedule it (hourly by default; see `triggerEveryHours`).

## Development

`npm test` runs unit tests for the diff logic, plus tests that run the Apps Script sources against
a fake Calendar service. The tests load `Config.example.js`, so they don't need a local config.

`Config.example.js` sits at the repo root, not in `src/`, because clasp uploads everything in
`src/`, and a second file declaring `CONFIG` would break the script.
