/**
 * The Sheets engine. Runs every 10 minutes (scanAll):
 *
 *  Hub › Events tab (Keelan)      one row per event; copy the last event's row, change details
 *    → creates an event folder with a Director Sheet, a Logos folder and a Team Rosters folder
 *  Director Sheet › Teams tab      one row per team: name, division (dropdown), manager, email
 *    → creates that team's Roster Sheet and shares it with the manager. A club's teams
 *      with the same name AND the same manager email (e.g. Cali*Lax ALL-STARS in several
 *      divisions) share one Roster Sheet, one tab per division. Different clubs never
 *      share a sheet, even with the same manager email.
 *  Roster Sheet › one tab per team one row per player: first, last, DOB, parent email
 *    → verifies from the player pool or emails the parent a registration link
 *
 * Grey columns in every sheet are filled in by this script and locked.
 */

const EVENTS_TAB = 'Events';
const EVENT_HEADERS = ['Event Name', 'Start Date', 'End Date', 'Age Divisions (comma separated)',
  'Director Name', 'Director Email', 'Status', 'Director Sheet', 'Logos Folder', 'Teams',
  'Players Verified', 'Event ID'];
const EVENT_INPUTS = 6;

const TEAM_HEADERS = ['Team Name', 'Division', 'Skill Level', 'Manager Name', 'Manager Email',
  'Roster', 'Players', 'Verified', 'Status'];
const TEAM_INPUTS = 5;
const SKILL_COL = 3;                       // Director Sheet › Teams › column C
const SKILL_LEVELS = ['A', 'AA'];

/**
 * The Director Sheet's Teams tab. Sheets made before Oct 7, 2026 have no Skill Level column – it's inserted
 * after Division the first time the sheet is opened (everything to the right moves over one column).
 */
function teamsSheet_(data) {
  const sh = SpreadsheetApp.openById(data.DirectorSheetID).getSheetByName('Teams');
  if (String(sh.getRange(1, SKILL_COL).getValue()) !== TEAM_HEADERS[SKILL_COL - 1]) {
    sh.insertColumnAfter(SKILL_COL - 1);
    sh.getRange(1, SKILL_COL).setValue(TEAM_HEADERS[SKILL_COL - 1]).setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff');
    sh.getRange(2, SKILL_COL, sh.getMaxRows() - 1, 1).setBackground(null);
  }
  skillColumn_(sh);
  return sh;
}

/** Skill Level: A / AA dropdown (blank = this division isn't split into tiers). */
function skillColumn_(sh) {
  const rule = sh.getRange(2, SKILL_COL).getDataValidation();
  if (rule && (rule.getCriteriaValues()[0] || []).join('|') === SKILL_LEVELS.join('|')) return;
  sh.setColumnWidth(SKILL_COL, 90);
  sh.getRange(1, SKILL_COL).setNote('A or AA. Leave blank if the division isn\u2019t split into skill levels. ' +
    'Filled in from Tourney Machine when the schedule is published if you leave it blank.');
  sh.getRange(2, SKILL_COL, sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(SKILL_LEVELS, true).setAllowInvalid(false).build());
}

/** "aa", " AA " → "AA"; anything else → "". */
function skillLevel_(v) {
  const s = String(v || '').trim().toUpperCase().replace(/[^A]/g, '');
  return s === 'A' || s === 'AA' ? s : '';
}

/** Our team for a Tourney Machine team: same division + name; the skill level decides between same-named teams. */
function matchTeam_(teams, division, name, tier) {
  const c = teams.filter(function (x) { return divKey_(x.Division) === divKey_(division) && norm_(x.TeamName) === norm_(name); });
  if (c.length <= 1) return c[0] || null;
  return c.filter(function (x) { return tier && x.Tier === tier; })[0] || c.filter(function (x) { return !x.Tier; })[0] || c[0];
}

const ROSTER_HEADERS = ['First Name', 'Last Name', 'Date of Birth (MM/DD/YYYY)', 'Parent Email', 'Jersey #', 'Goalie',
  'Status ⏳ updates within 10 min', 'USBOXLA Name', 'Invite Sent', 'Note', 'Member DOB on file'];
const MEMBER_DOB_NOTE = 'When the Note says a member with this name has a slightly different date of birth, ' +
  'this shows the date of birth on that member\u2019s USBOXLA (Wild Apricot) record.';
const STATUS_NOTE = 'Sit tight – new and changed rows are checked automatically every 10 minutes. ' +
  'The Status, USBOXLA Name, Invite Sent and Note columns fill in on their own.';
const ROSTER_INPUTS = 6;
const JERSEY_COL = 5;   // optional: pre-fills the official game sheet
const GOALIE_COL = 6;

const MAX_RUN_MS = 4.5 * 60 * 1000;
const GREY = '#eef0f3';

// ======================= main loop =======================

function scanAll() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) { console.log('Scan already running; skipped.'); return; }
  try {
    const started = Date.now();
    try { ensureTmColumn_(eventsSheet_()); } catch (err) { console.error(err); }
    try { ensureStatsColumn_(eventsSheet_()); } catch (err) { console.error(err); }
    try { ensureRefPayColumn_(eventsSheet_()); } catch (err) { console.error(err); }
    try { ensureTypeColumn_(eventsSheet_()); } catch (err) { console.error(err); }
  try { ensureBoxPayColumn_(eventsSheet_()); } catch (err) { console.error(err); }   // Hub column R "Penalty Box Rate"
  try { ensureDirPhoneColumn_(eventsSheet_()); } catch (err) { console.error(err); }   // Hub column S "Director Phone"
    refereesIfStale_();
    try { academyPeopleIfStale_(); } catch (err) { console.error(err); }   // Coaches.gs: coach/referee list from the academy
    const ctx = loadCtx_();
    readEventsTab_().forEach(function (ev) {
      if (Date.now() - started > MAX_RUN_MS) return; // finish next run
      try {
        processEvent_(ev, ctx);
      } catch (err) {
        console.error(err);
        writeEventStatus_(ev, '⚠ ' + err.message, null, ctx);
      }
    });
  } finally {
    lock.releaseLock();
  }
}

function loadCtx_() {
  return {
    eventData: readAll_('EventData'),
    teams: readAll_('TeamData'),
    regs: readAll_('Registrations'),
    poolCache: null,
    today: todayIso_(),
  };
}

function pool_(ctx) {
  if (!ctx.poolCache) ctx.poolCache = readPool_();
  return ctx.poolCache;
}

// ======================= events (Keelan) =======================

function eventsSheet_() {
  const sh = hub_().getSheetByName(EVENTS_TAB);
  if (!sh) throw new Error('Run setupHub() first.');
  return sh;
}

function readEventsTab_() {
  const sh = eventsSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const width = Math.max(EVENT_HEADERS.length, Math.min(sh.getMaxColumns(), Math.max(TYPE_COL, BOXPAY_COL, DIRPHONE_COL)));
  const values = sh.getRange(2, 1, last - 1, width).getValues();
  const seenIds = {};
  const out = [];
  values.forEach(function (r, i) {
    const name = clean_(r[0], 80);
    if (!name) return;
    let id = cellText_(r[11]);
    // A row copied together with its grey columns carries the old event's ID: treat it as new.
    if (id && seenIds[id]) id = '';
    if (id) seenIds[id] = true;
    out.push({
      row: i + 2, sheet: sh, name: name,
      start: toIsoDate_(r[1]), end: toIsoDate_(r[2]) || toIsoDate_(r[1]),
      divisions: String(r[3] || '').split(',').map(function (d) { return canonDivision_(clean_(d, 30)); }).filter(Boolean),
      directorName: clean_(r[4], 80), directorEmail: cleanEmail_(r[5]),
      directorPhone: clean_(r[DIRPHONE_COL - 1], 40),   // Hub column S "Director Phone"
      id: id,
      tmId: parseTmCell_(r[TM_COL - 1]).id, tmSite: parseTmCell_(r[TM_COL - 1]).site,
      fullStats: fullStatsSetting_(r[STATS_COL - 1], name),
      refRate: refRate_(r[REFPAY_COL - 1]),
      boxRate: boxRate_(r[BOXPAY_COL - 1], refRate_(r[REFPAY_COL - 1])),   // Hub column R "Penalty Box Rate"
      league: isLeagueType_(r[TYPE_COL - 1]),   // Hub column Q "Type" (League.gs)
    });
  });
  return out;
}

function processEvent_(ev, ctx) {
  const missing = [];
  if (!ev.start) missing.push('start date');
  if (!ev.divisions.length) missing.push('age divisions');
  if (!ev.directorEmail) missing.push('director email');
  if (missing.length && !ev.id) {
    writeEventStatus_(ev, '⚠ Fill in: ' + missing.join(', '), null, ctx);
    return;
  }
  if (ev.end && ev.start && ev.end < ev.start) {
    writeEventStatus_(ev, '⚠ End date is before start date', null, ctx);
    return;
  }

  let data = ev.id ? ctx.eventData.filter(function (d) { return d.EventID === ev.id; })[0] : null;
  if (!data) {
    data = createEventFiles_(ev, ctx);
    ev.id = data.EventID;
  }
  const finished = ev.end < ctx.today;
  let tmNote = '', forfeitNote = '';

  if (!finished) {
    shareEventWithDirector_(ev, data);
    syncDivisionDropdown_(ev, data);
    try { tmNote = syncTmTeams_(ev, data, ctx); } catch (err) { console.error(err); tmNote = 'Tourney Machine: ' + err.message; }
    try { writeGameSheetLink_(ev, data); } catch (err) { console.error(err); }
    const scanStarted = new Date();
    const teams = scanDirectorSheet_(ev, data, ctx);
    try { ensureFaqTab_(teamsSheet_(data).getParent(), ev.league ? 'league-director' : 'director'); } catch (err) { console.error('FAQ tab: ' + err.message); }
    try { forfeitNote = forfeitScan_(ev, data, ctx); } catch (err) { console.error(err); }
    scanRosters_(ev, data, teams, ctx);
    try { coachesScan_(ev, data, teams, ctx); } catch (err) { console.error('Coaches: ' + err.message); }   // Coaches.gs
    if (ev.end === ctx.today) {   // last day: All-Star picks open as soon as every final is in
      try { awardsEarlyOpen_(ev, data, ctx); } catch (err) { console.error('All-Star picks: ' + err.message); }
      try { awardsScan_(ev, data, ctx); } catch (err) { console.error(err); }
    }
    try { watchScan_(ev, data, ctx); } catch (err) { console.error('Player to Watch: ' + err.message); }
    data.LastScan = isoUtc_(scanStarted);
    update_('EventData', data);
    writeTeamCounts_(ev, data, teams, ctx);
  }
  if (finished && data.DirectorSheetID) {
    if (daysBetween_(ev.end, ctx.today) <= FORFEIT_RECENT_DAYS) shareWithRefChief_(data);
    try { forfeitNote = forfeitScan_(ev, data, ctx); } catch (err) { console.error(err); }
    try { awardsScan_(ev, data, ctx); } catch (err) { console.error(err); }
  }
  // Referee Pay tab on the Director Sheet (games from the tablets; rebuilt only when something changed).
  if (!finished || daysBetween_(ev.end, ctx.today) <= FORFEIT_RECENT_DAYS) {
    try { refPayScan_(ev, data, ctx); } catch (err) { console.error('Referee pay: ' + err.message); }
  }
  const awardsNote = awardsOpen_(data) ? ' · 🏅 All-Star picks open'
    : data.AwardsStage === 'closed' ? ' · 🏅 All-Stars final' : '';
  const ffNote = forfeitNote ? ' · ⚠ ' + forfeitNote : '';
  writeEventStatus_(ev, finished ? '🏁 Finished' + awardsNote + ffNote : '✅ Live' + watchNote_(data) + ffNote + (tmNote ? ' · ⚠ ' + tmNote : ''), data, ctx);
}

function createEventFiles_(ev, ctx) {
  const root = DriveApp.getFolderById(rootFolderId_());
  const folder = root.createFolder(ev.name + ' (' + prettyDate_(ev.start) + ')');
  const rosters = folder.createFolder('Team Rosters');
  const logos = folder.createFolder('Logos');

  const ss = SpreadsheetApp.create(ev.name + ' – Director Sheet');
  ss.setSpreadsheetTimeZone(Session.getScriptTimeZone());
  DriveApp.getFileById(ss.getId()).moveTo(folder);

  const sh = ss.getSheets()[0].setName('Teams');
  styleSheet_(sh, TEAM_HEADERS, TEAM_INPUTS, [220, 110, 90, 170, 230, 120, 80, 80, 300]);
  sh.getRange(2, 2, sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(ev.divisions, true).setAllowInvalid(false).build());
  skillColumn_(sh);
  sh.getRange(2, 5, sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireTextIsEmail().setAllowInvalid(true).build());

  addHelpTab_(ss, ev.league ? leagueDirectorHelp_(ev, logos.getUrl()) : [
    ev.name + ' – ' + prettyRange_({ StartDate: ev.start, EndDate: ev.end }),
    '',
    '1. On the Teams tab, add one row per team: team name, division, skill level (A / AA – blank if the division isn\u2019t split), manager name and manager email.',
    '   Spell team names the same way as in Tourney Machine so the schedule, game sheets and awards line up.',
    '2. Within about 10 minutes, each manager is emailed their own Roster Sheet for that team.',
    '3. Managers paste in their players. Parents are emailed to register with their USBOXLA membership.',
    '4. Watch the Players and Verified columns fill in. Grey columns fill themselves – you can’t edit them.',
    '5. Game day: the GAME SHEET SYSTEM tab has your private link for the rink tablets and the HQ laptop.',
    '',
    'Logos: drop the tournament logo (name the file "tournament") and each team’s logo',
    '(name the file exactly like the team, e.g. "Wolfpack") into the Logos folder:',
    logos.getUrl(),
    'Once the tournament logo is in, a print-ready 36×48" step & repeat backdrop PDF and a how-to-order sheet appear there within the hour.',
    '',
    'Don’t rename a team after adding it – add a new row instead.',
  ]);

  const data = insert_('EventData', {
    EventID: newId_('E'), FolderID: folder.getId(), DirectorSheetID: ss.getId(),
    RostersFolderID: rosters.getId(), LogosFolderID: logos.getId(),
    SharedWith: '', LastScan: '', Created: nowText_(),
  });
  ctx.eventData.push(data);
  ev.sheet.getRange(ev.row, 12).setValue(data.EventID);
  // Events imported from the Tournament Listing bring their logo along.
  try { attachImportedLogo_(ev, logos); } catch (err) { console.error(err); }
  return data;
}

/** Keeps the director's Division dropdown in step with the Age Divisions on the Events tab. */
function syncDivisionDropdown_(ev, data) {
  const sh = teamsSheet_(data);
  const rule = sh.getRange(2, 2).getDataValidation();
  const current = rule ? (rule.getCriteriaValues()[0] || []).join('|') : '';
  if (current === ev.divisions.join('|')) return;
  sh.getRange(2, 2, sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(ev.divisions, true).setAllowInvalid(false).build());
}

function shareEventWithDirector_(ev, data) {
  shareWithRefChief_(data);
  if (!ev.directorEmail) return;
  const shared = String(data.SharedWith || '').split(',').filter(Boolean);
  if (shared.indexOf(ev.directorEmail) !== -1) return;
  DriveApp.getFileById(data.DirectorSheetID).addEditor(ev.directorEmail);
  DriveApp.getFolderById(data.LogosFolderID).addEditor(ev.directorEmail);
  emailDirector_(ev, data);
  shared.push(ev.directorEmail);
  data.SharedWith = shared.join(',');
  update_('EventData', data);
}

/** The Referee-in-Chief can edit every Director Sheet (for its Referee Pay tab). Done once per event. */
function shareWithRefChief_(data) {
  const shared = String(data.SharedWith || '').split(',').filter(Boolean);
  if (!data.DirectorSheetID || shared.indexOf(REF_CHIEF_EMAIL) !== -1) return;
  try { DriveApp.getFileById(data.DirectorSheetID).addEditor(REF_CHIEF_EMAIL); }
  catch (err) { console.error('Sharing with the Referee-in-Chief: ' + err.message); return; }
  shared.push(REF_CHIEF_EMAIL);
  data.SharedWith = shared.join(',');
  update_('EventData', data);
}

function writeEventStatus_(ev, status, data, ctx) {
  const range = ev.sheet.getRange(ev.row, 7, 1, 5);
  const row = [status, '', '', '', ''];
  if (data) {
    const regs = ctx.regs.filter(function (r) { return r.EventID === data.EventID && r.Present === 'yes'; });
    row[1] = linkFormula_('https://docs.google.com/spreadsheets/d/' + data.DirectorSheetID, 'Open');
    row[2] = linkFormula_('https://drive.google.com/drive/folders/' + data.LogosFolderID, 'Open');
    row[3] = ctx.teams.filter(function (t) { return t.EventID === data.EventID; }).length;
    row[4] = regs.filter(function (r) { return r.Status === 'verified'; }).length + ' / ' + regs.length;
  }
  writeIfChanged_(range, [row]);
}

// ======================= teams (directors) =======================

/** Team names on the Teams tab are matched on letters AND numbers, so "ECE 2031" and "ECE 2032" are different teams. */
function teamNorm_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function scanDirectorSheet_(ev, data, ctx) {
  const sh = teamsSheet_(data);
  const last = sh.getLastRow();
  const out = [];
  if (last < 2) return out;
  const values = sh.getRange(2, 1, last - 1, TEAM_INPUTS).getValues();
  values.forEach(function (r, i) {
    const name = clean_(r[0], 80);
    const division = canonDivision_(clean_(r[1], 30));
    const tier = skillLevel_(r[2]);
    const managerName = clean_(r[3], 80);
    const email = cleanEmail_(r[4]);
    const row = { row: i + 2, name: name, division: division, tier: tier, problem: '' };
    if (!name && !division && !r[4]) { row.blank = true; out.push(row); return; }
    if (!name) row.problem = '⚠ Add a team name';
    else if (ev.divisions.indexOf(division) === -1) row.problem = '⚠ Pick a division';
    else if (!email) row.problem = '⚠ Check the manager email';
    if (row.problem) { out.push(row); return; }

    // Match teams by event + exact division (U11 ≠ U13) + name, ignoring case/spacing. Two same-named teams
    // in one division are told apart by skill level (Wolfpack A / Wolfpack AA).
    const sameTeam = function (t) {
      return t.EventID === data.EventID && divKey_(t.Division) === divKey_(division) && norm_(t.TeamName) === norm_(name) &&
        (!tier || !t.Tier || t.Tier === tier);
    };
    if (out.some(function (o) { return o.team && sameTeam(o.team); })) {
      row.problem = '⚠ Duplicate team';
      out.push(row);
      return;
    }
    const key = data.EventID + '|' + divKey_(division) + '|' + norm_(name) +
      (tier && ctx.teams.some(function (t) { return t.EventID === data.EventID && divKey_(t.Division) === divKey_(division) && norm_(t.TeamName) === norm_(name); }) ? '|' + tier : '');
    let team = ctx.teams.filter(sameTeam)[0];
    if (!team) {
      // Same club name + same manager email as another team at this event: add a tab to
      // that team's Roster Sheet. Different clubs always get separate sheets.
      const host = ctx.teams.filter(function (t) {
        return t.EventID === data.EventID && norm_(t.TeamName) === norm_(name) &&
          String(t.SharedWith || '').split(',').indexOf(email) !== -1;
      })[0];
      let fileId, tabId, logoFolderId;
      if (host) {
        fileId = host.RosterSheetID;
        tabId = addRosterTab_(ev, host, name, division);
        if (!host.LogoFolderID) { host.LogoFolderID = createTeamLogoFolder_(data, host.TeamName).getId(); update_('TeamData', host); }
        logoFolderId = host.LogoFolderID;
      } else {
        const logoFolder = createTeamLogoFolder_(data, name);
        logoFolderId = logoFolder.getId();
        const ss = createRosterSheet_(ev, data, name, division, logoFolder.getUrl());
        fileId = ss.getId();
        tabId = String(ss.getSheets()[0].getSheetId());
        ctx.newRosterFiles = ctx.newRosterFiles || {};
        ctx.newRosterFiles[fileId] = true;
      }
      // Teams added in the same scan as their sheet are covered by the one welcome email;
      // a team added later gets its own email pointing at its new tab.
      const coveredByWelcome = host && ctx.newRosterFiles && ctx.newRosterFiles[fileId];
      team = insert_('TeamData', {
        TeamKey: key, EventID: data.EventID, TeamName: name, Division: division,
        RosterSheetID: fileId, SharedWith: coveredByWelcome ? email : '', Created: nowText_(), RosterTabID: tabId,
        LogoFolderID: logoFolderId, Tier: tier,
      });
      ctx.teams.push(team);
    } else if (tier && team.Tier !== tier) {
      team.Tier = tier;              // the director set or changed the skill level
      update_('TeamData', team);
    }
    const shared = String(team.SharedWith || '').split(',').filter(Boolean);
    if (shared.indexOf(email) === -1) {
      try {
        DriveApp.getFileById(team.RosterSheetID).addEditor(email);
        // The manager can also drop their team logo into the club's own logo folder.
        if (team.LogoFolderID) { try { DriveApp.getFolderById(team.LogoFolderID).addEditor(email); } catch (e) { console.error(e); } }
      } catch (err) {
        console.error('Sharing ' + name + ' ' + division + ' with ' + email + ': ' + err.message);
        row.problem = /limit|too many|rate|quota|invitation/i.test(err.message)
          ? '⏳ Sharing paused by Google’s daily limit – retries automatically'
          : '⚠ Couldn’t share with ' + email + ' (' + String(err.message).slice(0, 80) + ')';
        row.team = team;
        out.push(row);
        return;
      }
      emailManager_(ev, team, managerName, email, data);
      shared.push(email);
      team.SharedWith = shared.join(',');
      update_('TeamData', team);
    }
    row.team = team;
    out.push(row);
  });
  return out;
}

/** One small folder per club inside the event's Logos folder, shared with that club's manager only. */
function createTeamLogoFolder_(data, teamName) {
  return DriveApp.getFolderById(data.LogosFolderID).createFolder(teamName + ' – team logo');
}

function createRosterSheet_(ev, data, teamName, division, logoFolderUrl) {
  const ss = SpreadsheetApp.create(teamName + ' ' + division + ' – ' + ev.name + ' Roster');
  ss.setSpreadsheetTimeZone(Session.getScriptTimeZone());
  ss.setSpreadsheetLocale('en_US'); // dates are read as MM/DD/YYYY
  DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(data.RostersFolderID));
  setupRosterTab_(ss.getSheets()[0].setName('Roster'));
  addHelpTab_(ss, ev.league ? leagueRosterHelp_(ev, teamName, division, logoFolderUrl) : [
    teamName + ' (' + division + ') – ' + ev.name,
    '',
    '1. On your team’s tab, type or paste one row per player: first name, last name, date of birth (MM/DD/YYYY), parent email.',
    ROSTER_HELP_JERSEY,
    '   (If you manage several teams at this event, each team has its own tab in this sheet.)',
    '   (Parent email is only needed for players who aren’t already USBOXLA members.)',
    '2. Sit tight – within about 10 minutes, the grey columns fill in on their own:',
    '     ✅ Verified – the player has a current USBOXLA membership. Nothing else to do.',
    '     ⏳ Waiting on parent – the parent was emailed a link to register.',
    '     ⚠ – something in the row needs fixing (see the Note column).',
    '3. Parents get reminders 7 and 2 days before the event.',
    '',
    'To remove a player, delete their row. Grey columns are filled in by USBOXLA and can’t be edited.',
    '',
    'Team logo: drop your team logo (PNG or JPG) into your team’s logo folder. It appears on the parent',
    'registration page and on the official game sheet:',
    logoFolderUrl || '',
    '',
    'Step & repeat backdrop: once your logo is in that folder, a print-ready 36×48" backdrop PDF and a FedEx Office',
    'ordering cheat sheet appear there within the hour – great for a team media day.',
  ]);
  return ss;
}

const ROSTER_HELP_JERSEY = '   Optional: jersey number and a Goalie tick – they pre-fill the official game sheet at the rink (the scorekeeper can still change them).';

function setupRosterTab_(sh) {
  styleSheet_(sh, ROSTER_HEADERS, ROSTER_INPUTS, [140, 160, 230, 240, 90, 80, 190, 180, 110, 320, 150]);
  dobColumn_(sh);
  sh.getRange(1, ROSTER_INPUTS + 1).setNote(STATUS_NOTE).setWrap(true);
  sh.getRange(2, 4, sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireTextIsEmail().setAllowInvalid(true).build());
  jerseyColumns_(sh);
}

/** Jersey # (kept as text so 00 and 07 stay as typed) and a Goalie checkbox. */
function jerseyColumns_(sh) {
  // Inserted columns copy the column to their left (Parent Email's email rule), so clear it first.
  sh.getRange(2, JERSEY_COL, sh.getMaxRows() - 1, 2).clearDataValidations();
  sh.getRange(2, JERSEY_COL, sh.getMaxRows() - 1, 1).setNumberFormat('@').setHorizontalAlignment('center');
  sh.getRange(1, JERSEY_COL).setNote('Optional. 00 or 0–999. Pre-fills the official game sheet.');
  sh.getRange(2, GOALIE_COL, sh.getMaxRows() - 1, 1).setHorizontalAlignment('center').setDataValidation(
    SpreadsheetApp.newDataValidation().requireCheckbox().build());
  sh.getRange(1, GOALIE_COL).setNote('Optional. Tick your goalie(s) – they’re marked G on the game sheet.');
}

/**
 * Roster tabs made before Oct 8, 2026 have no Jersey # / Goalie columns: they're inserted after
 * Parent Email (the grey columns move two to the right) the first time the tab is scanned.
 */
function rosterColumns_(sh) {
  if (String(sh.getRange(1, JERSEY_COL).getValue()) === ROSTER_HEADERS[JERSEY_COL - 1]) {
    // Tabs migrated on Oct 7 copied Parent Email's "must be an email" rule into Jersey #: remove it once.
    if (sh.getRange(2, JERSEY_COL).getDataValidation()) sh.getRange(2, JERSEY_COL, sh.getMaxRows() - 1, 1).clearDataValidations();
    return;
  }
  if (String(sh.getRange(1, 1).getValue()) !== ROSTER_HEADERS[0]) return;   // not a roster tab
  sh.insertColumnsAfter(4, 2);
  sh.getRange(1, JERSEY_COL, 1, 2).setValues([[ROSTER_HEADERS[JERSEY_COL - 1], ROSTER_HEADERS[GOALIE_COL - 1]]])
    .setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff');
  sh.getRange(2, JERSEY_COL, sh.getMaxRows() - 1, 2).setBackground(null);
  sh.setColumnWidth(JERSEY_COL, 90);
  sh.setColumnWidth(GOALIE_COL, 80);
  jerseyColumns_(sh);
  const help = sh.getParent().getSheetByName('How this works');
  if (help) {
    const n = Math.min(help.getLastRow(), 12);
    const vals = n ? help.getRange(1, 1, n, 1).getValues() : [];
    if (!vals.some(function (r) { return String(r[0]) === ROSTER_HELP_JERSEY; })) {
      const at = vals.findIndex(function (r) { return /^1\. On your team/.test(String(r[0])); });
      if (at !== -1) { help.insertRowAfter(at + 1); help.getRange(at + 2, 1).setValue(ROSTER_HELP_JERSEY); }
    }
  }
}

/** "7", 7, "07", "00" → kept; anything else → null (blank → ''). */
function jerseyNumber_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return v >= 0 && v <= 999 && Math.floor(v) === v ? String(v) : null;
  const t = String(v).trim().replace(/^#/, '');
  if (!t) return '';
  return /^\d{1,3}$/.test(t) ? t : null;   // 00, 07 and 0–999 (kept as typed)
}

/** Date of birth column: shown as MM/DD/YYYY, and anything that isn't a real date is refused. */
function dobColumn_(sh) {
  sh.getRange(2, 3, sh.getMaxRows() - 1, 1).setNumberFormat('MM/dd/yyyy').setDataValidation(
    SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false)
      .setHelpText('Enter the date of birth as MM/DD/YYYY, e.g. 03/14/2015').build());
}

/**
 * One-time update for roster sheets made before Oct 6, 2026: the DOB header says
 * MM/DD/YYYY, the column shows dates that way, typed text that isn't a date is refused,
 * the column is wide enough for the header, and the sheet reads dates US-style. Safe to run again.
 */
function migrateRosterDobFormat() {
  const done = {};
  let tabs = 0;
  readAll_('TeamData').forEach(function (t) {
    if (!t.RosterSheetID || done[t.RosterSheetID]) return;
    done[t.RosterSheetID] = true;
    let ss;
    try { ss = SpreadsheetApp.openById(t.RosterSheetID); } catch (err) { console.error(t.TeamName + ': ' + err); return; }
    if (ss.getSpreadsheetLocale() !== 'en_US') ss.setSpreadsheetLocale('en_US');
    ss.getSheets().forEach(function (sh) {
      if (String(sh.getRange(1, 1).getValue()) !== ROSTER_HEADERS[0]) return;
      sh.getRange(1, 3).setValue(ROSTER_HEADERS[2]);
      if (sh.getColumnWidth(3) < 230) sh.setColumnWidth(3, 230);   // room for the full "(MM/DD/YYYY)" header
      dobColumn_(sh);
      tabs++;
    });
    const help = ss.getSheetByName('How this works');
    if (help) {
      const vals = help.getRange(1, 1, Math.min(help.getLastRow(), 10), 1).getValues();
      vals.forEach(function (r, i) {
        if (/^1\. On your team/.test(String(r[0])) && String(r[0]).indexOf('MM/DD/YYYY') < 0) {
          help.getRange(i + 1, 1).setValue(String(r[0]).replace('date of birth,', 'date of birth (MM/DD/YYYY),'));
        }
      });
    }
  });
  console.log('Updated ' + tabs + ' roster tab(s) in ' + Object.keys(done).length + ' roster sheet(s).');
}

/** Tab label: the division (club + division if the names ever differ). */
function rosterTabName_(host, teamName, division) {
  const label = norm_(host.TeamName) === norm_(teamName) ? division : teamName + ' ' + division;
  return String(label).slice(0, 90);
}

/** Adds a team's tab to an existing Roster Sheet (same manager, same event). Returns the tab ID. */
function addRosterTab_(ev, host, teamName, division) {
  const ss = SpreadsheetApp.openById(host.RosterSheetID);
  const existing = rosterTab_(ss, host);
  if (!existing) throw new Error('The roster tab for ' + host.TeamName + ' ' + host.Division + ' is missing.');
  // The first team's tab was called "Roster"; give it its division name now that there are several.
  if (existing.getName() === 'Roster') {
    existing.setName(uniqueTabName_(ss, rosterTabName_(host, host.TeamName, host.Division)));
    if (!host.RosterTabID) { host.RosterTabID = String(existing.getSheetId()); update_('TeamData', host); }
    ss.rename(host.TeamName + ' – ' + ev.name + ' Rosters');
  }
  const help = ss.getSheetByName('How this works');
  const at = help ? help.getIndex() - 1 : ss.getSheets().length;
  const sh = ss.insertSheet(uniqueTabName_(ss, rosterTabName_(host, teamName, division)), at);
  setupRosterTab_(sh);
  return String(sh.getSheetId());
}

function uniqueTabName_(ss, name) {
  let n = name, i = 2;
  while (ss.getSheetByName(n)) n = name + ' (' + (i++) + ')';
  return n;
}

/** A team's tab in its Roster Sheet (found by ID, so renaming the tab doesn't break anything). */
function rosterTab_(ss, team) {
  if (team.RosterTabID) {
    const id = Number(team.RosterTabID);
    const sh = ss.getSheets().filter(function (s) { return s.getSheetId() === id; })[0];
    if (sh) return sh;
  }
  return ss.getSheetByName('Roster');
}

function rosterUrl_(team) {
  return 'https://docs.google.com/spreadsheets/d/' + team.RosterSheetID +
    (team.RosterTabID ? '/edit#gid=' + team.RosterTabID : '');
}

function writeTeamCounts_(ev, data, teams, ctx) {
  const rows = teams.filter(function (t) { return t.row; });
  if (!rows.length) return;
  const sh = teamsSheet_(data);
  const lastRow = Math.max.apply(null, rows.map(function (t) { return t.row; }));
  const desired = [];
  for (let r = 2; r <= lastRow; r++) {
    const t = rows.filter(function (x) { return x.row === r; })[0];
    if (!t || t.blank) { desired.push(['', '', '', '']); continue; }
    if (!t.team) { desired.push(['', '', '', t.problem]); continue; }
    const regs = ctx.regs.filter(function (g) { return g.TeamKey === t.team.TeamKey && g.Present === 'yes'; });
    const verified = regs.filter(function (g) { return g.Status === 'verified'; }).length;
    const status = t.problem ||
      (!regs.length ? '⏳ Waiting for manager to add players'
        : verified === regs.length ? '✅ All players verified'
        : '⏳ ' + (regs.length - verified) + ' waiting on parents');
    desired.push([linkFormula_(rosterUrl_(t.team), 'Open roster'),
      regs.length, verified, status]);
  }
  writeIfChanged_(sh.getRange(2, TEAM_INPUTS + 1, desired.length, 4), desired);
}

// ======================= players (managers) =======================

function scanRosters_(ev, data, teams, ctx) {
  const changed = {};
  const all = !data.LastScan;
  if (!all) {
    // Only open roster sheets edited recently. The 30-minute overlap covers Drive's
    // search index lagging behind; re-reading an unchanged sheet writes nothing.
    const since = isoUtc_(new Date(new Date(data.LastScan + 'Z').getTime() - 30 * 60 * 1000));
    const it = DriveApp.getFolderById(data.RostersFolderID).searchFiles("modifiedDate > '" + since + "'");
    while (it.hasNext()) changed[it.next().getId()] = true;
  }
  teams.forEach(function (t) {
    if (t.team && (all || changed[t.team.RosterSheetID])) processRoster_(ev, data, t.team, ctx);
  });
}

/** Reads one team's roster, verifies/invites new players, and writes the grey columns. */
/** Copy-pasting a whole block from another sheet can carry the date-of-birth rule into the Parent Email column
 *  ("must be a valid date"). Put the email rule and plain formatting back whenever that happens. */
function repairEmailColumn_(sh) {
  const n = sh.getMaxRows() - 1;
  if (n < 1) return;
  const rng = sh.getRange(2, 4, n, 1);
  const bad = rng.getDataValidations().some(function (r) {
    const dv = r[0];
    return !dv || dv.getCriteriaType() !== SpreadsheetApp.DataValidationCriteria.TEXT_IS_VALID_EMAIL;
  });
  if (!bad) return;
  rng.setDataValidation(SpreadsheetApp.newDataValidation().requireTextIsEmail().setAllowInvalid(true).build());
  rng.setNumberFormat('@');
  console.log('Repaired the Parent Email column on ' + sh.getParent().getName() + ' › ' + sh.getName());
}

function processRoster_(ev, data, team, ctx) {
  const sh = rosterTab_(SpreadsheetApp.openById(team.RosterSheetID), team);
  if (!sh) { console.error('Roster tab missing for ' + team.TeamName + ' ' + team.Division); return; }
  rosterColumns_(sh);
  repairEmailColumn_(sh);
  statusHeader_(sh);
  memberDobHeader_(sh);
  try { ensureFaqTab_(sh.getParent(), ev.league ? 'league-manager' : 'manager'); } catch (err) { console.error('FAQ tab: ' + err.message); }
  const last = sh.getLastRow();
  const numRows = {};   // jersey number → row indexes (to flag two players with one number)
  const teamRegs = ctx.regs.filter(function (g) { return g.TeamKey === team.TeamKey; });
  const present = {};
  const desired = [];
  const evRow = { Name: ev.name, StartDate: ev.start, EndDate: ev.end };

  if (last >= 2) {
    const values = sh.getRange(2, 1, last - 1, ROSTER_INPUTS).getValues();
    values.forEach(function (r) {
      const first = clean_(r[0], 50), lastName = clean_(r[1], 50);
      const dob = toIsoDate_(r[2]);
      const rawEmail = String(r[3] === null || r[3] === undefined ? '' : r[3]).trim();
      const email = cleanEmail_(rawEmail); // optional: only needed if the player isn't already a member
      const num = jerseyNumber_(r[JERSEY_COL - 1]);
      const goalie = r[GOALIE_COL - 1] === true ? 'yes' : '';
      if (!first && !lastName && !r[2] && !rawEmail) { desired.push(['', '', '', '']); return; }
      const fix = !first || !lastName ? 'Add first and last name'
        : !dob ? 'Enter the date of birth as MM/DD/YYYY (e.g. 03/14/2015)'
        : rawEmail && !email ? 'Check the parent email' : '';
      if (fix) { desired.push(['⚠ Fix this row', '', '', fix]); return; }

      const key = norm_(first) + '|' + norm_(lastName) + '|' + dob;
      if (present[key]) { desired.push(['⚠ Duplicate', '', '', 'This player is already listed above']); return; }

      let reg = teamRegs.filter(function (g) { return regKey_(g) === key; })[0];
      if (!reg) {
        reg = insert_('Registrations', {
          RegID: newId_('R'), EventID: data.EventID, TeamKey: team.TeamKey, RosterSheetID: team.RosterSheetID,
          FirstName: first, LastName: lastName, DOB: dob, ParentEmail: email, Token: newToken_(),
          Status: 'waiting', MemberID: '', VerifiedName: '', VerifiedAt: '', VerifiedVia: '',
          InvitedAt: '', RemindersSent: '0', Present: 'yes', Created: nowText_(), Num: num || '', Goalie: goalie,
        });
        ctx.regs.push(reg);
        teamRegs.push(reg);
        const match = poolMatchIn_(pool_(ctx), first, lastName, dob, ev.end);
        if (match) {
          markVerified_(reg, match.id, match.name, 'membership on file');
          update_('Registrations', reg);
        } else if (email) {
          invitePlayer_(reg, team, evRow, data);
        }
      } else {
        let dirty = false;
        if (reg.Present !== 'yes') { reg.Present = 'yes'; dirty = true; }
        if ((reg.Num || '') !== (num || '') || (reg.Goalie || '') !== goalie) { reg.Num = num || ''; reg.Goalie = goalie; dirty = true; }
        if (reg.ParentEmail !== email && reg.Status !== 'verified') {
          reg.ParentEmail = email; reg.InvitedAt = ''; reg.RemindersSent = '0'; dirty = true;
          update_('Registrations', reg);
          if (email) invitePlayer_(reg, team, evRow, data); // new email address: send to it
          dirty = false;
        }
        if (dirty) update_('Registrations', reg);
      }
      present[key] = true;
      const status = rosterStatus_(reg, pool_(ctx), ev.end);
      status.push(/slightly different date of birth/.test(status[3]) ? memberDobOnFile_(pool_(ctx), first, lastName, dob) : '');
      if (num === null) status[3] = '⚠ Jersey # must be 00 or a number from 0 to 999';
      else if (num) (numRows[num] = numRows[num] || []).push({ i: desired.length, name: first + ' ' + lastName });
      desired.push(status);
    });
    // Two players with one number: flag both rows.
    Object.keys(numRows).forEach(function (n) {
      const list = numRows[n];
      if (list.length < 2) return;
      list.forEach(function (x) {
        const others = list.filter(function (y) { return y !== x; }).map(function (y) { return y.name; }).join(', ');
        desired[x.i] = desired[x.i].slice(0, 3).concat(['⚠ Jersey #' + n + ' is also on ' + others], desired[x.i].slice(4));
      });
    });
  }

  // Players deleted from the sheet stop counting and stop getting reminders.
  teamRegs.forEach(function (g) {
    if (!present[regKey_(g)] && g.Present === 'yes') { g.Present = 'no'; update_('Registrations', g); }
  });

  const grey = ROSTER_HEADERS.length - ROSTER_INPUTS;   // Status, USBOXLA Name, Invite Sent, Note, Member DOB on file
  if (desired.length) writeIfChanged_(sh.getRange(2, ROSTER_INPUTS + 1, desired.length, grey),
    desired.map(function (r) { r = r.slice(0, grey); while (r.length < grey) r.push(''); return r; }));
}

/** Division names keep their digits: "U11" and "U13" are different divisions. */
function divKey_(d) { return canonDivision_(d).toLowerCase().replace(/[^a-z0-9]/g, ''); }

/** Birth-year pairs are written oldest first: "2028/2027" → "2027/2028", "GIRLS 2032/2031" → "GIRLS 2031/2032". */
function canonDivision_(d) {
  return String(d || '').replace(/\b(20\d\d)\s*\/\s*(20\d\d)\b/g, function (m, a, b) {
    return Math.min(+a, +b) + '/' + Math.max(+a, +b);
  });
}

/**
 * One-time: rewrites division names oldest year first (2028/2027 → 2027/2028) in the Hub's
 * Events tab, every live Director Sheet's Teams tab and the stored team list, then rescans.
 */
function migrateDivisionOrder() {
  const fix = function (v) { return canonDivision_(v); };
  let n = 0;
  withLock_(function () {
    const sh = eventsSheet_();
    const last = sh.getLastRow();
    if (last >= 2) {
      const rng = sh.getRange(2, 4, last - 1, 1);
      const vals = rng.getValues();
      const out = vals.map(function (r) { return [String(r[0] || '').split(',').map(function (d) { return fix(d.trim()); }).join(', ')]; });
      out.forEach(function (r, i) { if (String(vals[i][0] || '') && r[0] !== String(vals[i][0])) n++; });
      rng.setValues(out);
    }
    readAll_('EventData').forEach(function (d) {
      if (!d.DirectorSheetID) return;
      const t = SpreadsheetApp.openById(d.DirectorSheetID).getSheetByName('Teams');
      if (!t || t.getLastRow() < 2) return;
      const rng = t.getRange(2, 2, t.getLastRow() - 1, 1);
      const vals = rng.getValues();
      const out = vals.map(function (r) { return [fix(r[0])]; });
      if (JSON.stringify(out) !== JSON.stringify(vals)) { rng.clearDataValidations(); rng.setValues(out); n++; }
    });
    readAll_('TeamData').forEach(function (t) {
      const c = fix(t.Division);
      if (c !== t.Division) { t.Division = c; update_('TeamData', t); n++; }
    });
  });
  console.log('Division names updated in ' + n + ' places.');
  scanAll();
}

function regKey_(g) { return norm_(g.FirstName) + '|' + norm_(g.LastName) + '|' + g.DOB; }

function rosterStatus_(reg, pool, eventEnd) {
  if (reg.Status === 'verified') {
    const differs = reg.VerifiedName && norm_(reg.VerifiedName) !== norm_(reg.FirstName + reg.LastName);
    return ['✅ Verified', reg.VerifiedName,
      reg.InvitedAt ? prettyDate_(reg.InvitedAt.slice(0, 10)) : '',
      differs ? '⚠ Registered under a different name – make sure it’s this player'
        : reg.VerifiedVia === 'membership on file' ? 'Already a member – no action needed' : 'Parent registered'];
  }
  const hint = pool ? nearMatchNote_(pool, reg.FirstName, reg.LastName, reg.DOB, eventEnd) : '';
  if (!reg.ParentEmail) {
    return ['⚠ Not verified yet', '', '',
      hint || 'Not found as a current USBOXLA member. Add a parent email to send the registration link.'];
  }
  if (!reg.InvitedAt) return ['⏳ Email queued', '', '', hint || 'Sends automatically within a day'];
  return ['⏳ Waiting on parent', '', prettyDate_(reg.InvitedAt.slice(0, 10)),
    hint || 'Parent was emailed a link to register'];
}

/** Roster tabs made before Nov 11, 2026 have no "Member DOB on file" column: add it (grey, text) once. */
function memberDobHeader_(sh) {
  const col = ROSTER_HEADERS.length;
  if (String(sh.getRange(1, 1).getValue()) !== ROSTER_HEADERS[0]) return;   // not a roster tab
  if (String(sh.getRange(1, col).getValue()) === ROSTER_HEADERS[col - 1]) return;
  if (sh.getMaxColumns() < col) sh.insertColumnsAfter(sh.getMaxColumns(), col - sh.getMaxColumns());
  sh.getRange(1, col).setValue(ROSTER_HEADERS[col - 1]).setNote(MEMBER_DOB_NOTE)
    .setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff');
  sh.getRange(2, col, sh.getMaxRows() - 1, 1).setBackground(GREY).setNumberFormat('@');
  sh.setColumnWidth(col, 150);
}

/** The DOB on file for the same-named member behind a "slightly different date of birth" note (MM/DD/YYYY). */
function memberDobOnFile_(pool, first, last, dob) {
  const f = norm_(first), l = norm_(last);
  const m = (pool || []).filter(function (p) {
    return norm_(p.first) === f && norm_(p.last) === l && p.dob && p.dob !== dob && likelyDobTypo_(p.dob, dob);
  })[0];
  return m ? m.dob.slice(5, 7) + '/' + m.dob.slice(8, 10) + '/' + m.dob.slice(0, 4) : '';
}

/** Roster tabs made before Oct 9, 2026 say just "Status": tell managers the grey columns take up to 10 minutes. */
function statusHeader_(sh) {
  const cell = sh.getRange(1, ROSTER_INPUTS + 1);
  if (String(cell.getValue()) !== 'Status') return;
  cell.setValue(ROSTER_HEADERS[ROSTER_INPUTS]).setNote(STATUS_NOTE).setWrap(true);
}

/** Re-checks one team's sheet right away (used after a parent registers). */
function refreshRoster_(reg) {
  const ctx = loadCtx_();
  const team = ctx.teams.filter(function (t) { return t.TeamKey === reg.TeamKey; })[0];
  const data = ctx.eventData.filter(function (d) { return d.EventID === reg.EventID; })[0];
  const ev = readEventsTab_().filter(function (e) { return e.id === reg.EventID; })[0];
  if (team && data && ev) processRoster_(ev, data, team, ctx);
}

// ======================= sheet helpers =======================

function styleSheet_(sh, headers, inputs, widths) {
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff');
  sh.setFrozenRows(1);
  widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  const greyCols = headers.length - inputs;
  sh.getRange(2, inputs + 1, sh.getMaxRows() - 1, greyCols).setBackground(GREY);
  // Lock the header row and the grey columns: only USBOXLA (the script owner) can edit them.
  lockRange_(sh.getRange(1, 1, 1, headers.length), 'Headers');
  lockRange_(sh.getRange(1, inputs + 1, sh.getMaxRows(), greyCols), 'Filled in by USBOXLA');
}

function lockRange_(range, description) {
  const p = range.protect().setDescription(description);
  p.removeEditors(p.getEditors());
  if (p.canDomainEdit()) p.setDomainEdit(false);
}

function addHelpTab_(ss, lines) {
  const help = ss.insertSheet('How this works');
  help.getRange(1, 1, lines.length, 1).setValues(lines.map(function (l) { return [l]; }));
  help.getRange(1, 1).setFontWeight('bold').setFontSize(14);
  help.setColumnWidth(1, 900);
  try { addLogoToHelp_(help); } catch (err) { console.error(err); }
  ss.setActiveSheet(ss.getSheets()[0]);
}

/** Writes values (and formulas) only if something actually changed, to avoid needless edits. */
function writeIfChanged_(range, desired) {
  const formulas = range.getFormulas();
  const values = range.getValues();
  let differs = false;
  for (let i = 0; i < desired.length && !differs; i++) {
    for (let j = 0; j < desired[i].length; j++) {
      const now = formulas[i][j] || cellText_(values[i][j]);
      if (String(now) !== String(desired[i][j])) { differs = true; break; }
    }
  }
  if (differs) range.setValues(desired);
}

function linkFormula_(url, label) {
  return '=HYPERLINK("' + url + '","' + label + '")';
}

function rootFolderId_() {
  const id = PropertiesService.getScriptProperties().getProperty('ROOT_FOLDER_ID');
  if (!id) throw new Error('Run setupHub() first (ROOT_FOLDER_ID is missing).');
  return id;
}

function isoUtc_(d) { return d.toISOString().slice(0, 19); }

/**
 * One-time repair: moves any team whose club name differs from the first team in its
 * Roster Sheet into its own sheet (players copied over), so clubs never share a sheet.
 */
function splitMixedRosterSheets() {
  withLock_(function () {
    const teams = readAll_('TeamData');
    const regs = readAll_('Registrations');
    const events = readEventsTab_();
    const eventData = readAll_('EventData');
    const byFile = {};
    teams.forEach(function (t) { (byFile[t.RosterSheetID] = byFile[t.RosterSheetID] || []).push(t); });
    Object.keys(byFile).forEach(function (fileId) {
      const group = byFile[fileId];
      const club = norm_(group[0].TeamName);
      const movers = group.filter(function (t) { return norm_(t.TeamName) !== club; });
      if (!movers.length) return;
      const oldSs = SpreadsheetApp.openById(fileId);
      const clubs = {};
      movers.forEach(function (t) { (clubs[norm_(t.TeamName)] = clubs[norm_(t.TeamName)] || []).push(t); });
      Object.keys(clubs).forEach(function (k) {
        const list = clubs[k];
        const ev = events.filter(function (e) { return e.id === list[0].EventID; })[0];
        const data = eventData.filter(function (d) { return d.EventID === list[0].EventID; })[0];
        const ss = createRosterSheet_(ev, data, list[0].TeamName, list[0].Division);
        if (list.length > 1) ss.rename(list[0].TeamName + ' – ' + ev.name + ' Rosters');
        list.forEach(function (t, i) {
          const oldTab = rosterTab_(oldSs, t);
          let tab;
          if (i === 0) {
            tab = ss.getSheets()[0];
            if (list.length > 1) tab.setName(t.Division);
          } else {
            const help = ss.getSheetByName('How this works');
            tab = ss.insertSheet(uniqueTabName_(ss, t.Division), help ? help.getIndex() - 1 : ss.getSheets().length);
            setupRosterTab_(tab);
          }
          if (oldTab && oldTab.getLastRow() >= 2) {
            const vals = oldTab.getRange(2, 1, oldTab.getLastRow() - 1, ROSTER_INPUTS).getValues();
            tab.getRange(2, 1, vals.length, ROSTER_INPUTS).setValues(vals);
          }
          t.RosterSheetID = ss.getId();
          t.RosterTabID = String(tab.getSheetId());
          t.SharedWith = ''; // shared with its manager (and emailed) on the next scan
          update_('TeamData', t);
          regs.filter(function (g) { return g.TeamKey === t.TeamKey; }).forEach(function (g) {
            g.RosterSheetID = ss.getId();
            update_('Registrations', g);
          });
          if (oldTab) oldSs.deleteSheet(oldTab);
          console.log('Moved ' + t.TeamName + ' ' + t.Division + ' to its own sheet.');
        });
      });
      // The original club's sheet: name it after the club again.
      const ev = events.filter(function (e) { return e.id === group[0].EventID; })[0];
      const rest = group.filter(function (t) { return norm_(t.TeamName) === club; });
      if (ev) oldSs.rename(rest.length > 1 ? rest[0].TeamName + ' – ' + ev.name + ' Rosters'
        : rest[0].TeamName + ' ' + rest[0].Division + ' – ' + ev.name + ' Roster');
    });
  });
}

/**
 * Admin tool: starts an event over before it happens. For every event whose name contains `match`
 * (e.g. "Border Wars"): Roster Sheets go to the Drive trash (recoverable for 30 days), the Director Sheet's
 * Teams tab is emptied (headers stay) and its Referee Pay tab removed, and the event's teams, players,
 * game sheets, stats, All-Star picks and forfeits are deleted. The event itself, its Director Sheet,
 * folders, logos and GAME SHEET SYSTEM link stay. Run from the editor: clearEventForRestart('Border Wars').
 */
function clearEventForRestart(match) {
  if (!match || String(match).trim().length < 4) throw new Error('Give part of the event name, e.g. clearEventForRestart("Border Wars").');
  const evs = readEventsTab_().filter(function (e) { return e.id && e.name.toLowerCase().indexOf(String(match).toLowerCase()) !== -1; });
  if (!evs.length) { console.log('No event matches "' + match + '".'); return; }
  withLock_(function () {
    const ids = {};
    evs.forEach(function (e) { ids[e.id] = true; });
    const eventData = readAll_('EventData');
    const teams = readAll_('TeamData').filter(function (t) { return ids[t.EventID]; });
    // Roster Sheets → trash
    const sheets = {};
    teams.forEach(function (t) { if (t.RosterSheetID) sheets[t.RosterSheetID] = t.TeamName; });
    Object.keys(sheets).forEach(function (id) {
      try { DriveApp.getFileById(id).setTrashed(true); } catch (err) { console.error('Roster sheet ' + sheets[id] + ': ' + err.message); }
    });
    // Director Sheets: empty the Teams tab, drop Referee Pay
    evs.forEach(function (e) {
      const data = eventData.filter(function (d) { return d.EventID === e.id; })[0];
      if (!data || !data.DirectorSheetID) return;
      const ss = SpreadsheetApp.openById(data.DirectorSheetID);
      const sh = ss.getSheetByName('Teams');
      if (sh && sh.getMaxRows() > 1) {
        const rng = sh.getRange(2, 1, sh.getMaxRows() - 1, sh.getMaxColumns());
        rng.clearContent(); rng.clearNote();
        sh.getRange(2, SKILL_COL, sh.getMaxRows() - 1, 1).setBackground(null);
      }
      const pay = ss.getSheetByName(REFPAY_TAB);
      if (pay) ss.deleteSheet(pay);
      data.AwardsStage = ''; data.AwardsOpened = ''; data.AwardsRead = '';
      data.Forfeits = ''; data.ForfeitRead = ''; data.RefPayAt = ''; data.LastScan = '';
      update_('EventData', data);
      CacheService.getScriptCache().remove(gsVersionKey_(e.id));
    });
    // Stored data
    const counts = {};
    ['TeamData', 'Registrations', 'TMTeams', 'GameDocs', 'StatLines', 'Awards'].forEach(function (t) {
      const all = readAll_(t);
      const keep = all.filter(function (r) { return !ids[r.EventID]; });
      counts[t] = all.length - keep.length;
      if (counts[t]) rewriteTable_(t, keep);
    });
    rebuildStatsTab_();
    console.log('Cleared ' + evs.map(function (e) { return e.name; }).join(' and ') + ': ' + Object.keys(sheets).length +
      ' roster sheet(s) to the trash; removed ' + counts.TeamData + ' team(s), ' + counts.Registrations + ' player row(s), ' +
      counts.GameDocs + ' game sheet record(s), ' + counts.StatLines + ' stat line(s), ' + counts.Awards + ' All-Star pick(s). ' +
      'The events, Director Sheets and GAME SHEET SYSTEM links stay.');
  });
}

/** Admin (read-only): lists which events match and how much stored data each has. */
function reportEventData(match) {
  match = match || 'Border Wars';
  const evs = readEventsTab_().filter(function (e) { return e.id && e.name.toLowerCase().indexOf(String(match).toLowerCase()) !== -1; });
  evs.forEach(function (e) {
    const out = [];
    ['TeamData', 'Registrations', 'TMTeams', 'GameDocs', 'StatLines', 'Awards', 'Watch', 'ProfileMail', 'Champions', 'SocialFiles'].forEach(function (t) {
      try { const n = readAll_(t).filter(function (r) { return r.EventID === e.id; }).length; out.push(t + ' ' + n); } catch (err) { out.push(t + ' ?'); }
    });
    console.log(e.id + ' | ' + e.name + ' | ' + e.start + ' | ' + out.join(', '));
    console.log('  Event row: ' + JSON.stringify(e));
    const ed = readAll_('EventData').filter(function (d) { return d.EventID === e.id; })[0];
    if (ed && ed.DirectorSheetID) {
      const tsh = SpreadsheetApp.openById(ed.DirectorSheetID).getSheetByName('Teams');
      const vals = tsh.getLastRow() > 1 ? tsh.getRange(2, 1, tsh.getLastRow() - 1, 3).getValues().filter(function (r) { return r[0]; }) : [];
      console.log('  Teams tab now (' + vals.length + '): ' + vals.map(function (r) { return r[0] + ' [' + r[1] + (r[2] ? ' ' + r[2] : '') + ']'; }).join('; '));
      const regs = readAll_('Registrations');
      const shareCount = {};
      readAll_('TeamData').forEach(function (t) { shareCount[t.RosterSheetID] = (shareCount[t.RosterSheetID] || 0) + 1; });
      readAll_('TeamData').filter(function (t) { return t.EventID === e.id; }).forEach(function (t) {
        const onTab = vals.some(function (r) { return divKey_(canonDivision_(String(r[1]))) === divKey_(t.Division) && norm_(r[0]) === norm_(t.TeamName) && (!t.Tier || !skillLevel_(r[2]) || skillLevel_(r[2]) === t.Tier); });
        if (!onTab) console.log('  NOT ON TEAMS TAB: ' + t.TeamName + ' [' + t.Division + (t.Tier ? ' ' + t.Tier : '') + '] players ' +
          regs.filter(function (g) { return g.TeamKey === t.TeamKey; }).length + ', sheet shared by ' + shareCount[t.RosterSheetID] + ' team(s)');
      });
    }
    readAll_('TeamData').filter(function (t) { return t.EventID === e.id; }).forEach(function (t) {
      console.log('  Team: ' + [t.TeamName, t.Division, t.SkillLevel || t.Skill || '', t.ManagerName, t.RosterSheetID ? 'roster sheet ✓' : 'no roster sheet'].join(' | '));
    });
  });
  if (!evs.length) console.log('No event matches "' + match + '".');
}
function reportBorderWarsData() { reportEventData('Border Wars'); }

/** Admin: removes demo/test GAME data only – game sheets, player stats, All-Star picks, final places, forfeits
 *  and the Referee Pay tab – for events whose name contains match. Teams, rosters and memberships stay. */
function clearEventGameData(match) {
  const evs = readEventsTab_().filter(function (e) { return e.id && e.name.toLowerCase().indexOf(String(match).toLowerCase()) !== -1; });
  if (!evs.length) { console.log('No event matches "' + match + '".'); return; }
  withLock_(function () {
    const ids = {};
    evs.forEach(function (e) { ids[e.id] = true; });
    const counts = {};
    ['GameDocs', 'StatLines', 'Awards'].forEach(function (t) {
      const all = readAll_(t);
      const keep = all.filter(function (r) { return !ids[r.EventID]; });
      counts[t] = all.length - keep.length;
      if (counts[t]) rewriteTable_(t, keep);
    });
    const eventData = readAll_('EventData');
    evs.forEach(function (e) {
      const data = eventData.filter(function (d) { return d.EventID === e.id; })[0];
      if (!data) return;
      if (data.DirectorSheetID) {
        const ss = SpreadsheetApp.openById(data.DirectorSheetID);
        const pay = ss.getSheetByName(REFPAY_TAB);
        if (pay) ss.deleteSheet(pay);
        const sh = ss.getSheetByName('Teams');
        if (sh && sh.getLastRow() > 1 && sh.getMaxColumns() >= 11) sh.getRange(2, 10, sh.getLastRow() - 1, 2).clearContent();
      }
      data.AwardsStage = ''; data.AwardsOpened = ''; data.AwardsRead = '';
      data.Forfeits = ''; data.ForfeitRead = ''; data.RefPayAt = '';
      update_('EventData', data);
      CacheService.getScriptCache().remove(gsVersionKey_(e.id));
    });
    rebuildStatsTab_();
    console.log('Cleared game data for ' + evs.map(function (e) { return e.name; }).join(' and ') + ': ' + counts.GameDocs + ' game sheet record(s), ' +
      counts.StatLines + ' stat line(s), ' + counts.Awards + ' All-Star pick(s); final places, forfeits and Referee Pay reset. Teams and rosters untouched.');
  });
}
function clearBorderWarsDemoGames() { clearEventGameData('Border Wars'); }
/** Admin (read-only): prints the Teams tab of a Director Sheet, every column, with notes. */
function dumpDirectorTeams() {
  const ss = SpreadsheetApp.openById('1lu1bEuao31n62xFei3EYosTaGBYJdPKLNi2lyFVVN-c');
  console.log(ss.getName() + ' | tabs: ' + ss.getSheets().map(function (s) { return s.getName() + '#' + s.getSheetId(); }).join(', '));
  const sh = ss.getSheets().filter(function (s) { return s.getSheetId() === 1707949146; })[0] || ss.getSheets()[0];
  console.log('TAB ' + sh.getName());
  ['A','B','C','D','E','F'].forEach(function (c) { [2, 7, 25].forEach(function (rw) { const dv = sh.getRange(c + rw).getDataValidation(); console.log('DV ' + c + rw + ': ' + (dv ? dv.getCriteriaType() + ' ' + JSON.stringify(dv.getCriteriaValues()) + ' help=' + dv.getHelpText() + ' reject=' + !dv.getAllowInvalid() : 'none') + ' | fmt ' + sh.getRange(c + rw).getNumberFormat() + ' | raw ' + JSON.stringify(sh.getRange(c + rw).getValue())); }); });
  return;
  const r = sh.getDataRange();
  const v = r.getDisplayValues(), n = r.getNotes();
  v.forEach(function (row, i) { console.log((i + 1) + ': ' + row.map(function (c, j) { return c + (n[i][j] ? ' {' + n[i][j].replace(/\n/g, ' ') + '}' : ''); }).join(' | ')); });
}

/** Admin, one-time: lines stored teams up with the Teams tab after directors edit names.
 *  - A stored team whose name differs only in numbers (846 BLC → 845 BLC) takes the Teams tab's name.
 *  - A stored team no longer on the Teams tab with NO players is removed, and its empty roster tab deleted. */
function tidyTeamsWithTab(match) {
  const evs = readEventsTab_().filter(function (e) { return e.id && e.name.toLowerCase().indexOf(String(match).toLowerCase()) !== -1; });
  withLock_(function () {
    evs.forEach(function (e) {
      const ed = readAll_('EventData').filter(function (d) { return d.EventID === e.id; })[0];
      if (!ed || !ed.DirectorSheetID) return;
      const tsh = SpreadsheetApp.openById(ed.DirectorSheetID).getSheetByName('Teams');
      const rows = tsh.getLastRow() > 1 ? tsh.getRange(2, 1, tsh.getLastRow() - 1, 3).getValues().filter(function (r) { return r[0]; }).map(function (r) {
        return { name: clean_(r[0], 80), div: canonDivision_(clean_(r[1], 30)), tier: skillLevel_(r[2]), used: false };
      }) : [];
      const teams = readAll_('TeamData').filter(function (t) { return t.EventID === e.id; });
      const regs = readAll_('Registrations');
      const fits = function (r, t) { return divKey_(r.div) === divKey_(t.Division) && (!t.Tier || !r.tier || r.tier === t.Tier); };
      // exact (letters + numbers) first
      teams.forEach(function (t) {
        const r = rows.filter(function (r) { return !r.used && fits(r, t) && teamNorm_(r.name) === teamNorm_(t.TeamName); })[0];
        if (r) { r.used = true; t._ok = true; }
      });
      let renamed = 0, removed = 0;
      teams.forEach(function (t) {
        if (t._ok) return;
        const r = rows.filter(function (r) { return !r.used && fits(r, t) && norm_(r.name) === norm_(t.TeamName); })[0];
        if (r) {
          r.used = true;
          console.log('Renamed ' + t.TeamName + ' [' + t.Division + '] → ' + r.name);
          t.TeamName = r.name; delete t._ok; update_('TeamData', t); renamed++;
          return;
        }
        const players = regs.filter(function (g) { return g.TeamKey === t.TeamKey; }).length;
        if (players) { console.log('Kept (has ' + players + ' players): ' + t.TeamName + ' [' + t.Division + ']'); return; }
        try {
          const ss = SpreadsheetApp.openById(t.RosterSheetID);
          const tab = t.RosterTabID ? ss.getSheets().filter(function (s) { return String(s.getSheetId()) === String(t.RosterTabID); })[0] : null;
          if (tab && tab.getLastRow() <= 1 && ss.getSheets().length > 2) ss.deleteSheet(tab);
        } catch (err) { console.error(err.message); }
        console.log('Removed (not on Teams tab, no players): ' + t.TeamName + ' [' + t.Division + (t.Tier ? ' ' + t.Tier : '') + ']');
        removed++;
        t._drop = true;
      });
      if (removed) rewriteTable_('TeamData', readAll_('TeamData').filter(function (x) {
        return !teams.some(function (t) { return t._drop && t.TeamKey === x.TeamKey && t.EventID === x.EventID; });
      }));
      console.log(e.name + ': ' + renamed + ' renamed, ' + removed + ' removed. Teams tab has ' + rows.length + ' teams.');
    });
  });
}
function tidyBorderWarsUticaTeams() { tidyTeamsWithTab('Toronto Rock \u2013 Utica'); }
/** Clears only Border Wars – Utica (test data) for go-live. */
function clearBorderWarsUticaForRestart() { clearEventForRestart('Toronto Rock \u2013 Utica'); }

/** Run this one from the Run menu: clears both Border Wars events (Utica and Toronto) for a fresh start. */
function clearBorderWarsForRestart() { clearEventForRestart('Border Wars'); }

// ======================= FAQ & Support tab =======================
// A cheat sheet in every Director Sheet and every team Roster Sheet. Written once and rewritten only when
// FAQ_VERSION changes (the version is kept in a note on A1), so existing sheets pick up new answers on the next scan.

const FAQ_TAB = 'FAQ & Support';
const FAQ_VERSION = '2026-10-09b';

/** Rows: ['# Heading'] for a section, ['Q: …', 'answer'] for a question, ['text'] for a plain line. */
function faqManager_() {
  return [
    ['# Quick start'],
    ['1. On your team’s tab, type or paste one row per player: First Name, Last Name, Date of Birth (MM/DD/YYYY), Parent Email.'],
    ['2. Optional: Jersey # (00 or 0–999) and a Goalie tick. They pre-fill the official game sheet on game day.'],
    ['3. Sit tight. Within about 10 minutes the grey columns fill in on their own.'],
    ['# What the Status column means'],
    ['✅ Verified', 'Current USBOXLA member. Nothing else to do.'],
    ['⏳ Waiting on parent', 'The parent was emailed a link to join USBOXLA or enter their Member ID.'],
    ['⏳ Email queued', 'The registration email sends automatically within a day.'],
    ['⚠ Not verified yet', 'Not found as a current member and no parent email yet. Add one and the registration link goes out.'],
    ['⚠ Fix this row', 'A name, date of birth or email needs fixing. The Note column says what.'],
    ['⚠ Duplicate', 'This player is already listed above. Delete the extra row.'],
    ['⚠ Registered under a different name', 'A membership matched, but under another name. Make sure it’s this player.'],
    ['# Common questions'],
    ['Q: A player has a membership but isn’t verified.', 'The name and date of birth must match the USBOXLA membership exactly. Check the spelling and the DOB (MM/DD/YYYY). If the Note shows a possible match, change the row to match it and it verifies on its own. If the Note says the membership ends before the event, the parent needs to renew.'],
    ['Q: The parent never got the email.', 'Ask them to check spam and promotions. Check the address in Parent Email. If you change it, a new email goes to the new address.'],
    ['Q: When do parents get reminders?', '14, 7, 5 and 3 days before the event, then a final reminder 2 days before.'],
    ['Q: What if a player still isn’t registered on game day?', 'They can’t play. The game sheet only lets verified players dress.'],
    ['Q: How do I remove a player?', 'Delete their row. They stop getting reminders.'],
    ['Q: Two players have the same jersey number.', 'Both rows are flagged in the Note column. Change one of them.'],
    ['Q: Why can’t I type in the grey columns?', 'They’re filled in by USBOXLA, so they can’t be edited.'],
    ['Q: I manage more than one team at this event.', 'Each team has its own tab in this sheet.'],
    ['Q: I made a change but nothing happened.', 'Changes are picked up every 10 minutes. Give it a few minutes before trying again.'],
    ['# Picks'],
    ['Players to Watch', '7 days before the event a “Player to Watch” tab appears here. Pick one player with a public USBOXLA profile and write one line about them (60 characters max). Picks lock 2 days before the event at 8am Eastern.'],
    ['All-Star picks', 'As soon as the finals are done an “All-Star Picks” tab appears and you get an email – perfect for the trip home. Pick from the dropdowns of your verified players. Reminders the next two days; picks lock on the 3rd morning after they open.'],
    ['Team logo', 'Drop your team logo (PNG or JPG) into your team’s logo folder (link on the “How this works” tab).'],
    ['Step & repeat backdrop', 'Once your team logo is in your logo folder, a print-ready 36×48" step & repeat backdrop (PDF) and a “How to order” cheat sheet appear in that same folder within the hour. Print it at FedEx Office: poster, 36×48, matte, vertical, no lamination, no mounting (about $69). Great for a team media day at practice.'],
    ['# Support'],
    ['Memberships, Member IDs, registration', 'membership@usboxla.com'],
    ['Schedule, divisions, anything about the event', 'Your tournament director'],
  ];
}

function faqDirector_() {
  return [
    ['# Quick start'],
    ['1. Teams tab: one row per team – Team Name, Division, Skill Level (A / AA, blank if the division isn’t split), Manager Name, Manager Email. Spell team names exactly as in Tourney Machine.'],
    ['2. Within about 10 minutes each manager is emailed their own Roster Sheet.'],
    ['3. Watch the Players and Verified columns fill in. Grey columns fill themselves.'],
    ['4. Game day: the GAME SHEET SYSTEM tab has your private tablet link, the setup steps and the rink PIN.'],
    ['# Before the event'],
    ['Q: A manager didn’t get their roster sheet.', 'Check the Manager Email spelling on the Teams tab. The sheet is shared from player@usboxla.com, so ask them to check spam.'],
    ['Q: I added a team and nothing happened.', 'The system checks every 10 minutes. Sit tight and look at the Status column.'],
    ['Q: Can I rename a team?', 'Don’t rename a team after adding it – add a new row instead.'],
    ['Q: Lots of players aren’t verified.', 'Parents get reminders 14, 7, 5 and 3 days out and a final one 2 days out. Nudge managers whose Verified count is low. The Note column on their roster sheet says why a player isn’t verified.'],
    ['Q: Where do logos go?', 'Tournament logo (file named “tournament”) and team logos (named exactly like the team) go in the Logos folder (link on the “How this works” tab).'],
    ['Q: Step & repeat backdrop?', 'Once the tournament logo is in the Logos folder, a print-ready 36×48" backdrop PDF (your logo + USBOXLA) and a “How to order” cheat sheet appear there within the hour. Print it at FedEx Office (about $69) and hang it near check-in so families can grab a photo. Each team gets its own in its team logo folder.'],
    ['# Game day'],
    ['Q: How do I set up the tablets?', 'Open your link from the GAME SHEET SYSTEM tab on each rink tablet and pick the day and rink. On the HQ laptop choose “Tournament HQ console”.'],
    ['Q: A tablet needs to move to another rink or to HQ.', 'Use the rink PIN on the GAME SHEET SYSTEM tab.'],
    ['Q: A player shows up who isn’t registered.', 'They can’t play. Only verified players can be dressed on the tablet.'],
    ['Q: A game isn’t played (forfeit, cancellation).', 'The scorekeeper taps “Game not played” on the tablet. You and the Referee-in-Chief are emailed.'],
    ['Q: Final scores.', 'HQ enters each final score in Tourney Machine and taps “Mark entered”.'],
    ['Q: A team forfeits the whole event.', 'Tick Forfeited on the Teams tab. Its games count 1–0 for the other teams, its stats are removed and it gets no All-Star picks. Untick to undo. Enter the 1–0 results in Tourney Machine too.'],
    ['# After the event'],
    ['Q: Final Place is wrong.', 'Fix it in the Final Place column as soon as picks open. It decides how many All-Star picks each team gets, and the managers’ pick lists update within minutes.'],
    ['Q: Referee pay.', 'The Referee Pay tab fills in as games are signed off. Tick Paid as you pay each referee.'],
    ['All-Star picks', 'Open right after the finals (once every division has a champion – otherwise 8am the next morning), reminders the next two days, lock on the 3rd morning. Badges and All-Tournament graphics then go live.'],
    ['Players to Watch', 'Picks open 7 days before the event and lock 2 days before at 8am Eastern. Division graphics for Instagram are on the event’s page at stats.usboxla.com.'],
    ['# Support'],
    ['Memberships and registration', 'membership@usboxla.com'],
    ['Referees, assigning and pay', 'Referee-in-Chief – a.gardner@usboxla.com'],
    ['Everything else', 'shaydon@usboxla.com'],
  ];
}

/** Creates or refreshes the FAQ & Support tab (only when FAQ_VERSION changed). */
function ensureFaqTab_(ss, who) {
  let sh = ss.getSheetByName(FAQ_TAB);
  const version = FAQ_VERSION + (who.indexOf('league') === 0 ? '-league' : '');
  if (sh && sh.getRange(1, 1).getNote() === version) return;
  const rows = who === 'director' ? faqDirector_() : who === 'league-director' ? faqLeagueDirector_()
    : who === 'league-manager' ? faqLeagueManager_() : faqManager_();
  const title = 'FAQ & Support – ' + (who === 'director' ? 'Tournament Directors' : who === 'league-director' ? 'League Directors' : 'Team Managers');
  if (!sh) {
    sh = ss.insertSheet(FAQ_TAB, ss.getSheets().length);
    sh.setColumnWidth(1, 330); sh.setColumnWidth(2, 760);
    const p = sh.protect().setDescription('Filled in by USBOXLA');
    p.removeEditors(p.getEditors());
    if (p.canDomainEdit()) p.setDomainEdit(false);
  }
  sh.getRange(1, 1, sh.getMaxRows(), 2).breakApart();
  sh.clear();
  const out = [[title, ''], ['Can’t find your answer? See “Support” at the bottom.', '']];
  rows.forEach(function (r) { out.push(r[0].indexOf('# ') === 0 ? [r[0].slice(2).toUpperCase(), ''] : [r[0], r[1] || '']); });
  if (sh.getMaxRows() < out.length) sh.insertRowsAfter(sh.getMaxRows(), out.length - sh.getMaxRows());
  sh.getRange(1, 1, out.length, 2).setValues(out).setWrap(true).setVerticalAlignment('top').setFontSize(11);
  sh.getRange(1, 1).setFontWeight('bold').setFontSize(16).setNote(version).setWrap(false);
  sh.getRange(2, 1).setFontStyle('italic').setWrap(false);
  rows.forEach(function (r, i) {
    const row = i + 3;
    if (r[0].indexOf('# ') === 0) {
      sh.getRange(row, 1, 1, 2).setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff');
    } else if (r.length === 1) {
      sh.getRange(row, 1, 1, 2).merge();
    } else {
      sh.getRange(row, 1).setFontWeight('bold');
    }
  });
}

/** Admin tool: adds (or refreshes) the FAQ & Support tab in every Director Sheet and Roster Sheet of upcoming events now. */
function installFaqTabsNow() {
  const ctx = loadCtx_();
  let dirs = 0, rosters = 0;
  const done = {};
  readEventsTab_().forEach(function (ev) {
    if (!ev.id || !ev.end || ev.end < ctx.today) return;
    const data = ctx.eventData.filter(function (d) { return d.EventID === ev.id; })[0];
    if (!data || !data.DirectorSheetID) return;
    try { ensureFaqTab_(SpreadsheetApp.openById(data.DirectorSheetID), ev.league ? 'league-director' : 'director'); dirs++; } catch (err) { console.error(ev.name + ': ' + err.message); }
    ctx.teams.filter(function (t) { return t.EventID === ev.id && t.RosterSheetID; }).forEach(function (t) {
      if (done[t.RosterSheetID]) return;
      done[t.RosterSheetID] = true;
      try { ensureFaqTab_(SpreadsheetApp.openById(t.RosterSheetID), ev.league ? 'league-manager' : 'manager'); rosters++; } catch (err) { console.error(t.TeamName + ': ' + err.message); }
    });
  });
  console.log('FAQ & Support tab: ' + dirs + ' Director Sheet(s), ' + rosters + ' Roster Sheet(s).');
}