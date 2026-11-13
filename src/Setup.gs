/**
 * USBOXLA Event Registration (Google Sheets edition)
 *
 * WHO DOES WHAT
 *  Keelan    Hub sheet › Events tab: add a row per event (copy the last event's
 *            white columns A–F and change the details).
 *  Director  Gets a Director Sheet: one row per team + manager email. Drops
 *            logos into the event's Logos folder.
 *  Manager   Gets a Roster Sheet for their team: pastes players + parent emails.
 *  Parent    Gets an email → branded page → enters USBOXLA Member ID.
 *  Script    Every 10 min builds sheets, verifies players, emails, fills grey
 *            columns. Reminders go out 7 and 2 days before each event.
 *
 * ======================== SETUP (one time, ~30 min) ========================
 * Do all of this signed in to USBOXLA's Google Workspace account.
 *  1. Wild Apricot → Settings → Authorized applications → Authorize application
 *     → Server application, READ-ONLY access. Copy the API key.
 *  2. Create a Google Sheet named "USBOXLA Hub". Share it with Keelan only.
 *     Copy its ID from the URL (the part between /d/ and /edit).
 *  3. script.google.com → New project ("USBOXLA Event Registration").
 *     Add script files: Code, Pool, Store, Events, Mail, Register, Setup
 *     and one HTML file: RegisterPage. Paste each file in.
 *  4. Project Settings (gear) → Script Properties → add:
 *        WA_API_KEY      the Wild Apricot key from step 1          (required)
 *        HUB_SHEET_ID    the Hub sheet ID from step 2              (required)
 *        JOIN_URL        your Wild Apricot join/renew page          (required)
 *        DOB_FIELD_NAME  Wild Apricot's date-of-birth field name (default "Date of birth")
 *        REPLY_TO        where replies to emails go, e.g. Keelan's email
 *        TEST_MEMBER_ID  any real Member ID, for inspectMember()
 *  5. Run testConnection(), then inspectMember(). Approve permissions when asked.
 *     In the log, find the date-of-birth field; make sure DOB_FIELD_NAME matches it.
 *  6. Run setupHub(). It adds the Events tab and a "USBOXLA Events" Drive folder.
 *  7. Run syncPool(), then installTriggers().
 *  8. Deploy → New deployment → Web app. Execute as: Me. Who has access: Anyone.
 *     (This is only the parent registration page; links in emails point to it.)
 *  9. Test: add a fake event with yourself as director, then a team with a
 *     friend as manager, then two players: one real member, one not.
 * ==========================================================================
 */

/** Run once: creates the Events tab and the Drive folder everything lives in. */
function setupHub() {
  const props = PropertiesService.getScriptProperties();
  const ss = hub_();
  ss.setSpreadsheetTimeZone(Session.getScriptTimeZone());

  if (!props.getProperty('ROOT_FOLDER_ID')) {
    const root = DriveApp.createFolder('USBOXLA Events');
    props.setProperty('ROOT_FOLDER_ID', root.getId());
    console.log('Created Drive folder "USBOXLA Events": ' + root.getUrl());
  }

  let sh = ss.getSheetByName(EVENTS_TAB);
  if (!sh) {
    sh = ss.insertSheet(EVENTS_TAB, 0);
    styleSheet_(sh, EVENT_HEADERS, EVENT_INPUTS, [220, 105, 105, 200, 160, 220, 200, 100, 100, 70, 120, 110]);
    sh.getRange(2, 2, sh.getMaxRows() - 1, 2).setDataValidation(
      SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build())
      .setNumberFormat('m/d/yyyy');
    sh.getRange(2, 6, sh.getMaxRows() - 1, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireTextIsEmail().setAllowInvalid(true).build());
    sh.getRange(1, 1).setNote('New event: copy columns A–F from a previous event and change the details. ' +
      'Grey columns fill in automatically within 10 minutes.');
  }
  // Pool and private tables
  poolSheet_();
  Object.keys(TABLES).forEach(function (t) { table_(t); });
  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  console.log('Hub ready.');
}

/** Run once: hourly pool sync, 10-minute scan, daily 8am reminders. */
function installTriggers() {
  const ours = ['syncPool', 'scanAll', 'dailyJobs'];
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (ours.indexOf(tr.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('syncPool').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('scanAll').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('dailyJobs').timeBased().everyDays(1).atHour(8).create();
  console.log('Installed: pool sync hourly, sheet scan every 10 minutes, reminders daily at 8am.');
}

// ---------- shared helpers ----------

function norm_(s) { return String(s || '').toLowerCase().replace(/[^a-z]/g, ''); }

function clean_(s, max) { return String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max); }

function cleanEmail_(s) {
  const e = String(s || '').trim().toLowerCase();
  return /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[a-z]{2,}$/.test(e) ? e : '';
}

function esc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function nowText_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'); }

function prettyRange_(ev) {
  if (!ev.StartDate) return '';
  return !ev.EndDate || ev.StartDate === ev.EndDate ? prettyDate_(ev.StartDate)
    : prettyDate_(ev.StartDate) + '–' + prettyDate_(ev.EndDate);
}

function daysBetween_(fromIso, toIso) {
  const a = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10));
  const b = Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

function hoursSince_(stamp) {
  const re = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/;
  const m = String(stamp).match(re);
  if (!m) return 999;
  const n = nowText_().match(re);
  const t = function (x) { return Date.UTC(+x[1], +x[2] - 1, +x[3], +x[4], +x[5]); };
  return (t(n) - t(m)) / 3600000;
}

/** Exactly one pool member with the same name + DOB, valid through the event. */
function poolMatchIn_(pool, first, last, dob, eventEnd) {
  const f = norm_(first), l = norm_(last);
  const hits = pool.filter(function (m) {
    return m.dob === dob && norm_(m.first) === f && norm_(m.last) === l &&
      (!m.validThrough || m.validThrough >= eventEnd);
  });
  return hits.length === 1 ? { id: hits[0].id, name: hits[0].first + ' ' + hits[0].last } : null;
}

/**
 * A hint (never a verification) when a roster row doesn't match exactly but a
 * member looks close: name spelled differently, a likely DOB typo, or a
 * membership that ends before the event. Returns '' when nothing is close.
 */
function nearMatchNote_(pool, first, last, dob, eventEnd) {
  const f = norm_(first), l = norm_(last);
  if (!f || !l || !dob) return '';
  let expired = null, spelling = null, dobTypo = null;
  pool.forEach(function (m) {
    const mf = norm_(m.first), ml = norm_(m.last);
    const sameName = mf === f && ml === l;
    if (sameName && m.dob === dob) {
      if (m.validThrough && eventEnd && m.validThrough < eventEnd) expired = expired || m;
      return;
    }
    const lastClose = ml === l || (ml.length > 2 && l.length > 2 && (ml.indexOf(l) !== -1 || l.indexOf(ml) !== -1));
    const firstClose = mf === f || (f.length >= 2 && mf.slice(0, 2) === f.slice(0, 2)) ||
      mf.indexOf(f) === 0 || f.indexOf(mf) === 0;
    if (m.dob === dob && lastClose && firstClose) { spelling = spelling || m; return; }
    if (sameName && m.dob && likelyDobTypo_(m.dob, dob)) dobTypo = dobTypo || m;
  });
  if (expired) {
    return 'USBOXLA membership found, but it ends ' + prettyDate_(expired.validThrough) +
      ', before this event. The parent needs to renew.';
  }
  if (spelling) {
    return 'Possible match: ' + spelling.first + ' ' + spelling.last + ' (same birthday). If that’s this ' +
      'player, change the name here to match exactly and they’ll verify automatically.';
  }
  if (dobTypo) {
    return 'Possible match: a member named ' + dobTypo.first + ' ' + dobTypo.last +
      ' has a slightly different date of birth on file. Double-check the DOB.';
  }
  return '';
}

/** Same year, or month and day swapped (3/4 vs 4/3). */
function likelyDobTypo_(a, b) {
  if (a.slice(0, 4) === b.slice(0, 4)) return true;
  return a.slice(5, 7) === b.slice(8, 10) && a.slice(8, 10) === b.slice(5, 7);
}

function markVerified_(reg, memberId, name, via) {
  reg.Status = 'verified';
  reg.MemberID = memberId;
  reg.VerifiedName = name || '';
  reg.VerifiedAt = nowText_();
  reg.VerifiedVia = via;
}
