/**
 * Storage helpers for the private USBOXLA Hub sheet (HUB_SHEET_ID). Every cell is stored as plain text so Google Sheets never
 * turns dates or IDs into something else.
 */

// Private tables in the Hub sheet (hidden tabs). People never edit these.
const TABLES = {
  EventData:     ['EventID', 'FolderID', 'DirectorSheetID', 'RostersFolderID', 'LogosFolderID',
                  'SharedWith', 'LastScan', 'Created', 'GameKey', 'AwardsStage', 'AwardsOpened', 'AwardsRead',
                  'Forfeits', 'ForfeitRead', 'RefPayAt', 'WatchStage', 'WatchOpened', 'WatchRead', 'AwardsClosed', 'WatchClosed', 'ChampFolderID', 'ChampReminded'],
  TeamData:      ['TeamKey', 'EventID', 'TeamName', 'Division', 'RosterSheetID', 'SharedWith', 'Created',
                  'RosterTabID', 'LogoFolderID', 'Tier'],
  Registrations: ['RegID', 'EventID', 'TeamKey', 'RosterSheetID', 'FirstName', 'LastName', 'DOB',
                  'ParentEmail', 'Token', 'Status', 'MemberID', 'VerifiedName', 'VerifiedAt',
                  'VerifiedVia', 'InvitedAt', 'RemindersSent', 'Present', 'Created', 'Num', 'Goalie'],
  TMTeams:       ['EventID', 'TMTeamID', 'TeamName', 'Division', 'Added'],
  GameDocs:      ['EventID', 'Path', 'Json', 'UpdatedAt'],
  Profiles:      ['MemberID', 'Slug', 'Json', 'UpdatedAt'],
  Referees:      ['RefID', 'FirstName', 'LastName', 'Name', 'Completed', 'Member', 'Level', 'Expires', 'Certified', 'UpdatedAt'],
  Awards:        ['EventID', 'TeamKey', 'TeamName', 'Division', 'Tier', 'Place', 'Award', 'Slot', 'RegID',
                  'MemberID', 'FirstName', 'LastName', 'UpdatedAt'],
  Watch:         ['EventID', 'TeamKey', 'TeamName', 'Division', 'Tier', 'RegID', 'MemberID', 'FirstName', 'LastName',
                  'Blurb', 'UpdatedAt'],
  Champions:     ['EventID', 'Group', 'Medal', 'TeamName', 'FileID', 'Ver', 'UpdatedAt'],   // medal team photos (Awards.gs)
  SocialFiles:   ['EventID', 'Path', 'FileID', 'Md5', 'UpdatedAt'],   // graphics copied to the social media Shared Drive
  ProfileMail:   ['EventID', 'MemberID', 'Kind', 'SentAt'],   // player-profile emails already sent (ProfileMail.gs)
  StatLines:     ['EventID', 'GameID', 'GameNo', 'GameDate', 'Tier', 'Division', 'TeamName', 'Opponent',
                  'RegID', 'MemberID', 'FirstName', 'LastName', 'Num', 'Goalie', 'GP', 'G', 'A', 'PTS', 'PIM', 'FinalAt'],
};

function hub_() {
  const id = PropertiesService.getScriptProperties().getProperty('HUB_SHEET_ID');
  if (!id) throw new Error('HUB_SHEET_ID is not set in Script Properties');
  return SpreadsheetApp.openById(id);
}

/** Returns the sheet for a table, creating it with headers if needed. */
function table_(name, headers) {
  headers = headers || TABLES[name];
  const ss = hub_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    writeRows_(sh, 1, [headers]);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (TABLES[name]) sh.hideSheet();
  } else if (sh.getLastColumn() < headers.length) {
    writeRows_(sh, 1, [headers]); // a column was added to this table
  }
  return sh;
}

/** Writes rows as text starting at startRow, growing the sheet if needed. */
function writeRows_(sh, startRow, rows) {
  if (!rows.length) return;
  const width = rows[0].length;
  const need = startRow + rows.length - 1;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  const text = rows.map(function (r) {
    return r.map(function (v) { return v === null || v === undefined ? '' : String(v); });
  });
  sh.getRange(startRow, 1, rows.length, width).setNumberFormat('@').setValues(text);
}

function cellText_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return toIsoDate_(v) || '';
  return v === null || v === undefined ? '' : String(v);
}

function readAll_(name) {
  const cols = TABLES[name];
  const sh = table_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, cols.length).getValues().map(function (r, i) {
    const o = { _row: i + 2 };
    cols.forEach(function (c, j) { o[c] = cellText_(r[j]); });
    return o;
  });
}

function insert_(name, obj) {
  const sh = table_(name);
  obj._row = sh.getLastRow() + 1;
  writeRows_(sh, obj._row, [TABLES[name].map(function (c) { return obj[c]; })]);
  return obj;
}

function update_(name, obj) {
  writeRows_(table_(name), obj._row, [TABLES[name].map(function (c) { return obj[c]; })]);
}

function newId_(prefix) {
  return prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
}

function newToken_() {
  return 'k' + Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}
