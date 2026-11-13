/**
 * Access requests ("X is requesting access to the following spreadsheet")
 *
 * Google sends these to player@usboxla.com when someone opens one of our sheets while signed in to
 * an account it isn't shared with – usually a team manager on a second Gmail. Every 10 minutes:
 *
 *  Team Roster Sheet, event upcoming or running, under the cap → shared automatically (edit access,
 *     plus the team's logo folder), the team manager(s) on file get a heads-up, the email is archived
 *     with the label USBOXLA-access-done, and the access is removed 7 days after the event ends.
 *  Someone who already has access (any file or folder) → the email is simply archived.
 *  Team logo folder → shared with that team's manager or anyone already on its roster sheet.
 *  Anything else – Director Sheets, the Hub, a finished event, more than 3 extra people on one roster,
 *     or a sharing error → left in the inbox with the label USBOXLA-access-you for Shaydon to decide.
 *
 * Once a day (after 8am) a summary goes to ACCESS_REPORT_TO (Script Property; default shaydon@usboxla.com):
 * who was given access, who was removed, and the requests waiting for you.
 *
 * Setup: run installAccessTrigger() once from the editor (it asks to allow Gmail access the first time).
 */

TABLES.AccessGrants = ['RosterSheetID', 'EventID', 'Email', 'Name', 'GrantedAt', 'ExpiresOn', 'RemovedAt', 'Note'];

const ACCESS_MAX_PER_SHEET = 3;      // extra people auto-approved per roster sheet
const ACCESS_EXPIRE_DAYS = 7;        // days after the event ends that auto-approved access is removed
const ACCESS_DONE_LABEL = 'USBOXLA-access-done';
const ACCESS_YOU_LABEL = 'USBOXLA-access-you';
const ACCESS_REPORT_DEFAULT = 'shaydon@usboxla.com';

/** Trigger handler (every 10 minutes). */
function accessRequests() {
  // The sheet scan and pool sync can hold the lock for minutes. If they're busy, wait up to 4 minutes (scanAll can run that long), then skip: this runs again in 10 minutes.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(240000)) { console.log('Another job is running – access requests will be checked on the next run.'); return; }
  try {
    accessScanInbox_();
    const props = PropertiesService.getScriptProperties();
    const hour = Number(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'H'));
    if (props.getProperty('ACCESS_DAILY') !== todayIso_() && hour >= 8) {
      accessDaily_();
      props.setProperty('ACCESS_DAILY', todayIso_());
    }
  } finally {
    lock.releaseLock();
  }
}

/** Admin: run the inbox check now (e.g. right after setup). */
function accessRequestsNow() { withLock_(accessScanInbox_); }

/** Admin: send the daily summary / run expiry now. */
function accessDailyNow() { withLock_(accessDaily_); }

/** Admin: installs the 10-minute trigger (leaves the other triggers alone). */
function installAccessTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'accessRequests') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('accessRequests').timeBased().everyMinutes(10).create();
  accessLabel_(ACCESS_DONE_LABEL); accessLabel_(ACCESS_YOU_LABEL); table_('AccessGrants');
  console.log('Access requests: checked every 10 minutes. Running the first check now…');
  accessRequestsNow();
}

// ---------------------------------------------------------------------------------------------

function accessScanInbox_() {
  const done = accessLabel_(ACCESS_DONE_LABEL), you = accessLabel_(ACCESS_YOU_LABEL);
  // Requests left for you are looked at again each run (they're approved as soon as they qualify).
  const threads = GmailApp.search('("requesting access" OR "requests access" OR subject:"Share request") newer_than:60d -label:' + ACCESS_DONE_LABEL +
    ' -in:trash', 0, 50).filter(function (th) {
    return th.isInInbox() || th.getLabels().every(function (l) { return l.getName() !== ACCESS_YOU_LABEL; });
  });
  if (!threads.length) return;
  const ctx = loadCtx_();
  const events = {};
  readEventsTab_().forEach(function (e) { if (e.id) events[e.id] = e; });
  const grants = readAll_('AccessGrants');

  threads.forEach(function (th) {
    let verdict = 'done';
    th.getMessages().forEach(function (msg) {
      if (!/@(google\.com|docs\.google\.com)>?$/i.test(String(msg.getFrom()).trim())) { verdict = 'skip'; return; }
      const req = accessParse_(msg);
      if (!req) { verdict = 'you'; return; }
      const r = accessDecide_(req, ctx, events, grants);
      console.log('Access request: ' + req.email + ' → ' + req.fileId + ': ' + r.result + (r.note ? ' (' + r.note + ')' : ''));
      if (r.result !== 'granted' && r.result !== 'already') verdict = 'you';
    });
    if (verdict === 'skip') return;  // not a Google access request: leave it alone
    if (verdict === 'you') {
      th.addLabel(you);              // stays in the inbox for Shaydon
    } else {
      th.removeLabel(you);
      th.addLabel(done);
      th.markRead();
      th.moveToArchive();
    }
  });
}

/** {email, name, fileId} from a Google access-request email, or null. */
function accessParse_(msg) {
  const text = msg.getPlainBody() || '';
  const html = msg.getBody() || '';
  const both = text + '\n' + html;
  const oldWording = /([^\n<>()]{0,80}?)\s*\(([^()\s<>]+@[^()\s<>]+)\)\s*is requesting access/i;
  const m = text.match(oldWording) || both.replace(/<[^>]+>/g, ' ').match(oldWording);
  let email = m ? cleanEmail_(m[2]) : '';
  if (!email) {
    // Google's newer plain-text emails say "someone@x.com requests access to an item", and the share link carries the address.
    const inv = both.replace(/&amp;/g, '&').match(/[?&]userstoinvite=([^&\s"'<>]+)/i);
    const said = text.match(/^\s*([^\s<>()]+@[^\s<>()]+)\s+requests access/im);
    if (inv) { try { email = cleanEmail_(decodeURIComponent(inv[1])); } catch (e) { email = cleanEmail_(inv[1]); } }
    if (!email && said) email = cleanEmail_(said[1]);
  }
  if (!email) return null;

  const f = both.match(/\/(?:spreadsheets|document|presentation|file|forms)\/d\/([a-zA-Z0-9_-]{20,})/);
  const fo = both.match(/\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]{20,})/);
  let fileId = f ? f[1] : (fo ? fo[1] : '');
  let isFolder = !f && !!fo;
  if (!fileId) {
    // Some of Google's emails only name the file: Share request for "Team – Event Rosters"
    const s = String(msg.getSubject()).match(/Share request for\s+["“](.+)["”]\s*$/i) ||
              (text.match(/requesting access to the following \w+:\s*\n?\s*(.+)/i) || []);
    const title = s && s[1] ? s[1].trim() : '';
    if (title) {
      const files = DriveApp.getFilesByName(title);
      while (files.hasNext() && !fileId) {
        const file = files.next();
        try { if (file.getOwner() && file.getOwner().getEmail() === Session.getEffectiveUser().getEmail()) fileId = file.getId(); }
        catch (e) { /* shared-drive files have no owner */ }
      }
      if (!fileId) {
        const folders = DriveApp.getFoldersByName(title);
        if (folders.hasNext()) { fileId = folders.next().getId(); isFolder = true; }
      }
    }
  }
  if (!fileId) return null;
  const from = String(msg.getFrom()).match(/^"?(.+?)\s*\(via Google/i);
  const name = m ? m[1] : (from ? from[1] : '');
  return { email: email, name: clean_(name, 80), fileId: fileId, isFolder: isFolder };
}

/** True when the person can already open this file or folder (edit or view). */
function accessHasAccess_(req) {
  try {
    const item = req.isFolder ? DriveApp.getFolderById(req.fileId) : DriveApp.getFileById(req.fileId);
    return item.getEditors().concat(item.getViewers()).some(function (u) { return cleanEmail_(u.getEmail()) === req.email; });
  } catch (e) {
    console.error(e);
    return false;
  }
}

/** A team logo folder: shared only with that team's manager or someone who already has its roster sheet. */
function accessDecideFolder_(req, ctx, events) {
  const teams = ctx.teams.filter(function (t) { return t.LogoFolderID === req.fileId; });
  if (!teams.length) return { result: 'you', note: 'not a team logo folder' };
  const live = teams.filter(function (t) { return events[t.EventID] && events[t.EventID].end >= ctx.today; });
  if (!live.length) return { result: 'you', note: 'event is over' };
  const allowed = live.some(function (t) {
    if (managerEmails_(t).indexOf(req.email) !== -1) return true;
    try {
      return DriveApp.getFileById(t.RosterSheetID).getEditors().some(function (u) { return cleanEmail_(u.getEmail()) === req.email; });
    } catch (e) { return false; }
  });
  if (!allowed) return { result: 'you', note: 'not a manager or on this team’s roster sheet' };
  try {
    DriveApp.getFolderById(req.fileId).addEditor(req.email);
  } catch (err) {
    return { result: 'you', note: 'Google wouldn’t share: ' + String(err.message).slice(0, 80) };
  }
  return { result: 'already', note: 'logo folder shared' };
}

/** Decides and (when allowed) shares. Returns {result: granted|already|you, note}. */
function accessDecide_(req, ctx, events, grants) {
  // Already shared by hand or by an earlier run: nothing to decide, so the request can be filed away.
  if (accessHasAccess_(req)) return { result: 'already', note: 'already has access' };
  if (req.isFolder) return accessDecideFolder_(req, ctx, events);

  const teams = ctx.teams.filter(function (t) { return t.RosterSheetID === req.fileId; });
  if (!teams.length) return { result: 'you', note: 'not a team roster sheet' };
  const ev = events[teams[0].EventID];
  if (!ev) return { result: 'you', note: 'event not found' };
  if (ev.end < ctx.today) return { result: 'you', note: 'event is over' };

  const active = grants.filter(function (g) { return g.RosterSheetID === req.fileId && !g.RemovedAt; });
  if (active.some(function (g) { return g.Email === req.email; })) return { result: 'already' };
  const isManager = teams.some(function (t) { return managerEmails_(t).indexOf(req.email) !== -1; });
  if (!isManager && active.length >= ACCESS_MAX_PER_SHEET) return { result: 'you', note: 'more than ' + ACCESS_MAX_PER_SHEET + ' extra people on this roster' };

  try {
    DriveApp.getFileById(req.fileId).addEditor(req.email);
  } catch (err) {
    return { result: 'you', note: 'Google wouldn’t share: ' + String(err.message).slice(0, 80) };
  }
  teams.forEach(function (t) {
    if (t.LogoFolderID) { try { DriveApp.getFolderById(t.LogoFolderID).addEditor(req.email); } catch (e) { console.error(e); } }
  });
  if (isManager) return { result: 'already', note: 'manager on file – re-shared' };

  const g = insert_('AccessGrants', {
    RosterSheetID: req.fileId, EventID: ev.id, Email: req.email, Name: req.name, GrantedAt: nowText_(),
    ExpiresOn: addDaysIso_(ev.end, ACCESS_EXPIRE_DAYS), RemovedAt: '', Note: teams.map(function (t) { return t.TeamName + ' ' + t.Division; }).join('; '),
  });
  grants.push(g);
  accessTellManagers_(req, teams, ev, ctx);
  return { result: 'granted' };
}

function accessTellManagers_(req, teams, ev, ctx) {
  const data = ctx.eventData.filter(function (d) { return d.EventID === ev.id; })[0];
  let logo = null;
  try { logo = data ? logoForEmail_(data) : null; } catch (e) { /* logo is optional */ }
  const who = req.name ? req.name + ' (' + req.email + ')' : req.email;
  const teamText = teams.map(function (t) { return t.TeamName + ' ' + t.Division; }).join(', ');
  const sent = {};
  teams.forEach(function (t) {
    managerEmails_(t).forEach(function (to) {
      if (sent[to] || to === req.email) return;
      sent[to] = true;
      sendMail_(to, 'Roster access: ' + req.email + ' – ' + teamText + ' (' + ev.name + ')',
        'Someone was added to your roster sheet',
        ['Hi Coach,',
         who + ' asked for access to your ' + ev.name + ' roster sheet (' + teamText + ') and was given edit access automatically.',
         'If this is one of your staff, there’s nothing to do. If you don’t know them, just reply to this email and USBOXLA will remove them right away.',
         'Their access ends automatically ' + ACCESS_EXPIRE_DAYS + ' days after the event.'],
        'Open roster sheet', rosterUrl_(t), logo, null,
        { replyTo: accessReportTo_(), footer: 'Sent automatically when someone requests access to a roster sheet.' });
    });
  });
}

/** Daily: removes expired access and emails the summary. */
function accessDaily_() {
  const props = PropertiesService.getScriptProperties();
  const since = props.getProperty('ACCESS_SUMMARY_AT') || '';
  const today = todayIso_();
  const teams = readAll_('TeamData');
  const grants = readAll_('AccessGrants');
  const removed = [];
  grants.forEach(function (g) {
    if (g.RemovedAt || !g.ExpiresOn || g.ExpiresOn >= today) return;
    const onSheet = teams.filter(function (t) { return t.RosterSheetID === g.RosterSheetID; });
    const isManager = onSheet.some(function (t) { return managerEmails_(t).indexOf(g.Email) !== -1; });
    if (!isManager) {
      try { DriveApp.getFileById(g.RosterSheetID).removeEditor(g.Email); } catch (e) { console.error(e); }
      onSheet.forEach(function (t) {
        if (t.LogoFolderID) { try { DriveApp.getFolderById(t.LogoFolderID).removeEditor(g.Email); } catch (e) { /* already gone */ } }
      });
    }
    g.RemovedAt = nowText_();
    update_('AccessGrants', g);
    removed.push(g);
  });

  const granted = grants.filter(function (g) { return g.GrantedAt && g.GrantedAt > since; });
  const waiting = GmailApp.search('label:' + ACCESS_YOU_LABEL + ' in:inbox', 0, 30).map(function (th) {
    const req = accessParse_(th.getMessages()[0]);
    let file = '';
    if (req) { try { file = (req.isFolder ? DriveApp.getFolderById(req.fileId) : DriveApp.getFileById(req.fileId)).getName(); } catch (e) { file = 'a file'; } }
    return req ? req.email + ' → ' + file : th.getFirstMessageSubject();
  });
  props.setProperty('ACCESS_SUMMARY_AT', nowText_());
  if (!granted.length && !removed.length && !waiting.length) return;

  const lines = [];
  if (granted.length) lines.push('Given access (' + granted.length + '): ' + granted.map(function (g) { return g.Email + ' – ' + g.Note; }).join(' · '));
  if (removed.length) lines.push('Access removed after the event (' + removed.length + '): ' + removed.map(function (g) { return g.Email + ' – ' + g.Note; }).join(' · '));
  if (waiting.length) lines.push('Waiting for you in player@usboxla.com (label ' + ACCESS_YOU_LABEL + '): ' + waiting.join(' · '));
  lines.push('Roster sheets for upcoming events are approved automatically (up to ' + ACCESS_MAX_PER_SHEET +
    ' extra people per roster) and the team manager is told. Director Sheets, the Hub and finished events always wait for you.');
  sendMail_(accessReportTo_(), 'Sheet access requests – daily summary', 'Sheet access requests', lines,
    'Open player@usboxla.com inbox', 'https://mail.google.com/mail/u/0/#label/' + ACCESS_YOU_LABEL, null, null,
    { footer: 'Daily summary from the USBOXLA event system.' });
}

function accessReportTo_() {
  return PropertiesService.getScriptProperties().getProperty('ACCESS_REPORT_TO') || ACCESS_REPORT_DEFAULT;
}

function accessLabel_(name) { return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name); }
