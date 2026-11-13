/**
 * Step & repeat backdrops: a print-ready 36×48" poster PDF (USBOXLA shield + the team's or tournament's logo, repeated)
 * plus a one-page "how to order at FedEx Office" cheat sheet, saved straight into Drive:
 *   - Team: the team's own logo folder ("<team> – team logo", already shared with the team manager).
 *   - Tournament: the event's Logos folder (already shared with the director).
 * stats.usboxla.com/backdrop.php draws the PDF from the logo we send it. A backdrop appears within the hour after a logo
 * lands, and is remade if the logo file changes (the old PDF goes to the trash). Only events that haven't ended yet.
 * Run installBackdropTrigger() once; makeBackdropsNow() runs it straight away.
 */

const BACKDROP_URL = 'https://stats.usboxla.com/backdrop.php';
const BACKDROP_SHEET_URL = 'https://stats.usboxla.com/assets/backdrop-cheat-sheet.pdf';
const BACKDROP_SHEET_NAME = 'How to order your backdrop (FedEx Office).pdf';
const BACKDROP_TAG = 'usboxla-backdrop:';    // file description = tag + logo version, so we know when to remake it

/** Run once from the editor: installs the hourly trigger. */
function installBackdropTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'backdropsHourly') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('backdropsHourly').timeBased().everyHours(1).create();
  console.log('Hourly step-and-repeat backdrops installed.');
}

/** Admin: make any missing backdrops now and list what was made. */
function makeBackdropsNow() { backdropsHourly(true); }

function backdropsHourly(verbose) {
  verbose = verbose === true;   // a trigger passes its own event object here
  // one run at a time (a manual run during the hourly one would make duplicates); not the script lock, which the sheet scan needs
  const cache = CacheService.getScriptCache();
  if (cache.get('backdrops_running')) { console.log('Backdrops are already being made – try again in a few minutes.'); return; }
  cache.put('backdrops_running', '1', 360);
  try { backdropsRun_(verbose); } finally { cache.remove('backdrops_running'); }
}

function backdropsRun_(verbose) {
  const until = Date.now() + 4.5 * 60 * 1000;
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const events = {};
  readEventsTab_().forEach(function (ev) { if (ev.id) events[ev.id] = ev; });
  const live = readAll_('EventData').filter(function (d) {
    const ev = events[d.EventID];
    return ev && d.LogosFolderID && (ev.end || ev.start || '9999') >= today;
  });
  if (!live.length) { if (verbose) console.log('No upcoming events.'); return; }
  const teams = readAll_('TeamData');
  const staffLogos = backdropStaffLogos_();
  let sheet;
  const cheatSheet = function () {
    if (sheet === undefined) {
      const r = UrlFetchApp.fetch(BACKDROP_SHEET_URL, { muteHttpExceptions: true });
      sheet = r.getResponseCode() === 200 ? r.getBlob().setName(BACKDROP_SHEET_NAME) : null;
    }
    return sheet;
  };
  live.forEach(function (d) {
    if (Date.now() > until) return;
    const ev = events[d.EventID];
    try {
      const own = findLogos_(d, null).event;
      if (own) backdropInto_(DriveApp.getFolderById(d.LogosFolderID), own, ev.name, cheatSheet, verbose);
      else if (verbose) console.log('· ' + ev.name + ': no tournament logo yet');
    } catch (err) { console.error('Backdrop ' + ev.name + ': ' + err.message); }
    const seen = {};
    teams.forEach(function (t) {
      if (t.EventID !== d.EventID || !t.LogoFolderID || seen[t.LogoFolderID] || Date.now() > until) return;
      seen[t.LogoFolderID] = true;   // clubs with several divisions share one logo folder
      try {
        const logo = staffLogos[norm_(t.TeamName)] || findLogos_(d, t).team;
        if (logo) backdropInto_(DriveApp.getFolderById(t.LogoFolderID), logo, t.TeamName, cheatSheet, verbose);
        else if (verbose) console.log('· ' + t.TeamName + ' (' + ev.name + '): no team logo yet');
      } catch (err) { console.error('Backdrop ' + t.TeamName + ' (' + ev.name + '): ' + err.message); }
    });
  });
}

/** Logos USBOXLA staff put in the Team Logos folder (named like the team) – they win, same as on the stats site. */
function backdropStaffLogos_() {
  const out = {};
  try {
    const it = teamLogoFolder_().getFiles();
    while (it.hasNext()) {
      const f = it.next();
      if (String(f.getMimeType()).indexOf('image/') === 0) out[norm_(String(f.getName()).replace(/\.[^.]+$/, ''))] = f;
    }
  } catch (err) { console.error(err); }
  return out;
}

/** Makes (or keeps) the backdrop PDF for this logo in this folder, plus the cheat sheet. */
function backdropInto_(folder, logo, name, cheatSheet, verbose) {
  let step = 'reading the folder';
  try {
    backdropSteps_(folder, logo, name, cheatSheet, verbose, function (s) { step = s; });
  } catch (err) {
    throw new Error(err.message + ' (while ' + step + '; logo "' + logo.getName() + '", ' + Math.round(logo.getSize() / 1024) + ' KB)');
  }
}

function backdropSteps_(folder, logo, name, cheatSheet, verbose, at) {
  const ver = BACKDROP_TAG + shortHash_('headshot-panel-3|' + logo.getId() + '|' + logo.getLastUpdated().getTime());
  const old = [];
  let current = false, hasSheet = false;
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    const desc = String(f.getDescription() || '');
    if (desc === ver && !current) current = true;
    else if (desc === ver) old.push(f);   // a duplicate of the current one
    else if (desc.indexOf(BACKDROP_TAG) === 0 || String(f.getName()).indexOf('USBOXLA Step and Repeat – ') === 0) old.push(f);   // older or half-saved copies
    if (f.getName() === BACKDROP_SHEET_NAME) { if (hasSheet) old.push(f); hasSheet = true; }
  }
  at('adding the cheat sheet');
  if (!hasSheet && cheatSheet()) folder.createFile(cheatSheet().copyBlob()).setName(BACKDROP_SHEET_NAME);
  if (current) {
    old.forEach(function (f) { try { f.setTrashed(true); } catch (err) { console.error(err); } });
    if (verbose) console.log('= ' + name + ': backdrop is up to date');
    return;
  }
  at('reading the logo');
  // very big logo files: send Drive's 2000px copy instead (plenty for a 3.4" logo)
  const logoBlob = logo.getSize() > 8 * 1024 * 1024 ? (driveImage_(logo, 2000) || logo.getThumbnail()) : logo.getBlob();
  at('making the PDF');

  const r = UrlFetchApp.fetch(BACKDROP_URL, {
    method: 'post', muteHttpExceptions: true,
    payload: { f: 'pdf', name: name, logo: logoBlob }
  });
  const h = r.getHeaders(), type = String(h['Content-Type'] || h['content-type'] || '');
  if (r.getResponseCode() !== 200 || type.indexOf('pdf') === -1) {
    console.error('Backdrop ' + name + ': ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 160));
    return;
  }
  at('saving the PDF');
  const safe = String(name).replace(/[\/\\:*?"<>|]/g, '-');
  folder.createFile(r.getBlob().setName('USBOXLA Step and Repeat – ' + safe + ' (36x48 print).pdf')).setDescription(ver);
  old.forEach(function (f) { try { f.setTrashed(true); } catch (err) { console.error(err); } });
  if (verbose) console.log('✓ ' + name + ' → ' + folder.getName());
}
