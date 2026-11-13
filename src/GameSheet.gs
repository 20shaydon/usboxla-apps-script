/**
 * Tablet game sheet, served by this web app.
 *
 *   …/exec?gs=<EventID>&k=<GameKey>   one private link per event, used by every rink tablet and the
 *                                      Tournament HQ laptop (the Hub shows it in the "Game Sheet" column)
 *
 * The page loads the event day (schedule and rinks from Tourney Machine, teams and verified players
 * from the event's roster sheets, logos from the Drive folders) and keeps games in sync between devices
 * through doPost {action:'gs', …}. Game state lives in the hidden GameDocs tab of the Hub.
 *
 * Only first and last names and membership status leave the server – never dates of birth or contacts.
 */

const GS_COL = 14; // Hub › Events tab column N
const GS_HEADER = 'GAME SHEET SYSTEM';
const GS_TAB = 'GAME SHEET SYSTEM';   // Director Sheet tab with the event's private link
const GS_DOC_PATH = /^(games|teams|rinks|entered|sirseen)\/[A-Za-z0-9:._-]{1,80}$/;
const GS_MAX_DOC = 45000;

// ======================= links =======================

function gameKey_(data) {
  if (!data.GameKey) {
    data.GameKey = newToken_().slice(0, 24);
    update_('EventData', data);
  }
  return data.GameKey;
}

function webAppUrl_() {
  return PropertiesService.getScriptProperties().getProperty('WEBAPP_URL') || ScriptApp.getService().getUrl();
}

function gameSheetUrl_(data) {
  const base = webAppUrl_();
  return base ? base + '?gs=' + encodeURIComponent(data.EventID) + '&k=' + gameKey_(data) : '';
}

/** Hub › Events tab › "GAME SHEET SYSTEM": a link for every live event that has a Tourney Machine ID (also on the Director Sheet). */
function writeGameSheetLink_(ev, data) {
  const sh = ev.sheet;
  if (sh.getMaxColumns() < GS_COL) sh.insertColumnsAfter(sh.getMaxColumns(), GS_COL - sh.getMaxColumns());
  const head = sh.getRange(1, GS_COL);
  if (String(head.getValue()) !== GS_HEADER) {
    head.setValue(GS_HEADER).setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff')
      .setNote('Private link to the GAME SHEET SYSTEM for the rink tablets and the Tournament HQ laptop. ' +
        'The director has it on the GAME SHEET SYSTEM tab of their Director Sheet. Don’t post it publicly.');
    sh.setColumnWidth(GS_COL, 150);
  }
  // Filled in by the system: grey and locked like the other system columns (once).
  if (String(sh.getRange(2, GS_COL).getBackground()).toLowerCase() !== GREY) {
    sh.getRange(2, GS_COL, sh.getMaxRows() - 1, 1).setBackground(GREY);
    lockRange_(sh.getRange(1, GS_COL, sh.getMaxRows(), 1), 'Filled in by USBOXLA');
  }
  const url = ev.tmId ? gameSheetUrl_(data) : '';
  writeIfChanged_(sh.getRange(ev.row, GS_COL), [[url ? linkFormula_(url, 'Open') : '']]);
  try { writeDirectorGsTab_(ev, data, url); } catch (err) { console.error('GAME SHEET SYSTEM tab: ' + err.message); }
}

/** Pure: the Director Sheet's GAME SHEET SYSTEM tab, one cell per row (column A). */
function directorGsLines_(evName, url, pin) {
  return [
    'GAME SHEET SYSTEM – ' + evName,
    '',
    url ? linkFormula_(url, 'Open the GAME SHEET SYSTEM') : 'Your link appears here once the event is connected to Tourney Machine (Hub › Tourney Machine ID).',
    '🔒 Private: don’t post or share this link. Anyone with it can enter scores.',
    '',
    'On game day',
    '1. Each rink tablet: open the link, pick the day and the rink. Add it to the home screen and set the screen to stay awake.',
    '2. Tournament HQ laptop: open the link and choose “Tournament HQ console”.',
    '3. At each game the scorekeeper checks in both teams, picks the referees and scorekeeper, then runs the game and both sign off.',
    '4. HQ enters each final score in Tourney Machine and taps “Mark entered”.',
    '',
    'Rink PIN (to move a tablet to another rink or to HQ): ' + pin,
    '',
    'Games that aren’t played: use “Game not played” on the tablet (you and the Referee-in-Chief are emailed).',
    'A team that forfeits the event: tick “Forfeited” for it on the Teams tab.',
    'Referee pay: the Referee Pay tab fills in as games are signed off.',
  ];
}

function writeDirectorGsTab_(ev, data, url) {
  if (!data.DirectorSheetID) return;
  const ss = SpreadsheetApp.openById(data.DirectorSheetID);
  let sh = ss.getSheetByName(GS_TAB);
  const lines = directorGsLines_(ev.name, url, PropertiesService.getScriptProperties().getProperty('GAMESHEET_PIN') || '1234');
  if (!sh) {
    const teams = ss.getSheetByName('Teams');
    sh = ss.insertSheet(GS_TAB, teams ? teams.getIndex() : 1);
    sh.setColumnWidth(1, 820);
    sh.getRange(1, 1).setFontSize(16).setFontWeight('bold').setFontColor(BRAND_BLUE);
    sh.getRange(3, 1).setFontSize(14).setFontWeight('bold');
    sh.getRange(4, 1).setFontColor('#C8102E').setFontWeight('bold');
    sh.getRange(6, 1).setFontWeight('bold');
    sh.getRange(1, 1, lines.length, 1).setWrap(true);
    lockRange_(sh.getRange(1, 1, lines.length + 5, 1), 'Filled in by USBOXLA');
  }
  writeIfChanged_(sh.getRange(1, 1, lines.length, 1), lines.map(function (l) { return [l]; }));
}

// ======================= web =======================

function gameSheetPage_(e) {
  const p = (e && e.parameter) || {};
  const data = readAll_('EventData').filter(function (d) { return d.EventID === p.gs; })[0];
  if (!data || !data.GameKey || p.k !== data.GameKey) {
    return HtmlService.createHtmlOutput('<p style="font:16px sans-serif;padding:24px">This GAME SHEET SYSTEM link isn’t active. ' +
      'Ask Tournament HQ for the current link.</p>').setTitle('USBOXLA GAME SHEET SYSTEM');
  }
  const tpl = HtmlService.createTemplateFromFile('GameSheetPage');
  tpl.api = webAppUrl_();
  tpl.eventId = data.EventID;
  tpl.key = data.GameKey;
  tpl.shield = usboxlaLogoDataUri_();
  return tpl.evaluate()
    .setTitle('USBOXLA GAME SHEET SYSTEM')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    // Can be framed (e.g. a Wild Apricot page with a credentialless frame) for devices signed into several Google accounts.
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** doPost {action:'gs', op:'day'|'poll'|'put', e:<EventID>, k:<GameKey>, …} */
function gameSheetApi_(req) {
  const data = readAll_('EventData').filter(function (d) { return d.EventID === req.e; })[0];
  if (!data || !data.GameKey || req.k !== data.GameKey) return { error: 'This GAME SHEET SYSTEM link isn’t active.' };
  if (req.op === 'day') return gsDay_(data, !!req.logos);
  if (req.op === 'poll') return gsPoll_(data.EventID, Number(req.since) || 0);
  if (req.op === 'put') return gsPut_(data.EventID, String(req.path || ''), req.doc);
  if (req.op === 'sirAudio') return gsSirAudio_(data, req);
  return { error: 'Unknown request.' };
}

// ======================= the event day =======================

/** The event day. Logos (large) only when asked: each device asks once, then refreshes without them. */
function gsDay_(data, withLogos) {
  const ev = readEventsTab_().filter(function (x) { return x.id === data.EventID; })[0];
  if (!ev) return { error: 'This event is no longer in the Hub.' };
  if (!ev.tmId) return { error: 'Add the Tourney Machine ID for this event in the Hub first.' };
  let t;
  try { t = tmGet_('/Tournaments/' + encodeURIComponent(ev.tmId) + '/false'); }
  catch (err) { return { error: err.code === 403 ? 'The tournament isn’t published in Tourney Machine yet.' : 'Couldn’t reach Tourney Machine – try again.' }; }
  const out = gsBuildDay_(ev, data, t, tmEventSite_(ev), withLogos);
  out.refs = refsForTablet_(readAll_('Referees'), todayIso_());
  if (withLogos) out.event.logo = dataUri_(findLogos_(data, null).event) || gsRemoteLogo_(t.logo);
  return out;
}

/** Pure(ish) builder, separated for testing: Tourney Machine tournament + our teams → the day. */
function gsBuildDay_(ev, data, t, site, withLogos) {
  const divs = t.divisionDictionary || {};
  const tmTeams = t.teamDictionary || {};
  const games = t.gameDictionary || {};
  const facs = t.facilityDictionary || {};

  // Divisions at this site → standard division
  const divOf = {}; // TM division id → standard division
  Object.keys(divs).forEach(function (k) {
    const m = tmStandardDivision_(divs[k].name);
    if (m.division && (!m.site || m.site === site) && ev.divisions.indexOf(m.division) !== -1) divOf[k] = m.division;
  });
  const gameDiv = {};
  Object.keys(divOf).forEach(function (k) { (divs[k].idGames || []).forEach(function (gid) { gameDiv[gid] = k; }); });

  // Our teams and verified players
  const teamData = readAll_('TeamData').filter(function (x) { return x.EventID === data.EventID; });
  const regs = readAll_('Registrations').filter(function (g) { return g.EventID === data.EventID && g.Present === 'yes'; });
  const logoCache = {};
  const teams = {};
  Object.keys(tmTeams).forEach(function (tid) {
    const tm = tmTeams[tid];
    const division = divOf[tm.idDivision];
    if (!division) return;
    const td = matchTeam_(teamData, division, tm.name, tmStandardDivision_((divs[tm.idDivision] || {}).name).tier);
    const players = td ? regs.filter(function (g) { return g.TeamKey === td.TeamKey; }).map(function (g) {
      return { id: g.RegID, first: g.FirstName, last: g.LastName, num: g.Num || '', verified: g.Status === 'verified', goalieDefault: g.Goalie === 'yes' };
    }) : [];
    let logo = '';
    if (td && withLogos) {
      try { logo = logoCache[td.TeamKey] = logoCache[td.TeamKey] || dataUri_(findLogos_(data, td).team); } catch (err) { console.error(err); }
    }
    teams[tid] = { key: tid, name: clean_(tm.name, 80), short: clean_(tm.name, 80), color: gsColor_(tm.name), division: division,
      logo: logo, players: players, roster: !!td };
  });

  // Games at this site, with rinks numbered 1…n
  const gids = Object.keys(gameDiv).filter(function (gid) { return games[gid] && games[gid].s; });
  const facIds = [];
  gids.forEach(function (gid) { const f = games[gid].idf; if (f && facIds.indexOf(f) === -1) facIds.push(f); });
  // Rink number = the number in the rink's name ("Mastrovito Hyundai Rink 1" → 1) when every rink has a different one.
  const nameNum = function (f) { const m = String((facs[f] || {}).name || '').match(/rink\s*#?\s*(\d+)/i); return m ? Number(m[1]) : 0; };
  const nums = facIds.map(nameNum);
  const byName = nums.every(function (n, i) { return n > 0 && nums.indexOf(n) === i; });
  facIds.sort(function (a, b) {
    const fa = facs[a] || {}, fb = facs[b] || {};
    return (byName ? nameNum(a) - nameNum(b) : 0) || (Number(fa.sort) || 0) - (Number(fb.sort) || 0) ||
      String(fa.name || '').localeCompare(String(fb.name || ''), undefined, { numeric: true });
  });
  const rinkNo = function (f) { return byName ? nameNum(f) : facIds.indexOf(f) + 1; };
  const rinks = facIds.map(function (f) { return { n: rinkNo(f), name: (facs[f] || {}).name || 'Rink ' + rinkNo(f) }; });

  // Medal games: bracket games whose winner/loser doesn't feed another game in the division.
  const fed = {};
  gids.forEach(function (gid) {
    const g = games[gid];
    [g.t1, g.t2].forEach(function (s) {
      const m = String(s || '').match(/(?:winner|loser)\s+(?:of\s+)?(?:game\s+)?#?\s*(\S+)/i);
      if (m) fed[gameDiv[gid] + '|' + m[1].toUpperCase()] = true;
    });
  });
  const list = gids.map(function (gid) {
    const g = games[gid];
    const bracket = /^B/i.test(String(g.gn || '')) || /(place|winner|loser|seed)/i.test(String(g.t1 || '') + ' ' + String(g.t2 || ''));
    const side = function (idT, label, n) {
      if (idT && teams[idT]) return idT;
      const key = 'ph:' + gid + ':' + n;
      teams[key] = { key: key, name: clean_(label || 'To be decided', 80), short: clean_(label || 'TBD', 80), color: '#64748B',
        division: divOf[gameDiv[gid]], logo: '', players: [], roster: false, placeholder: true };
      return key;
    };
    const start = String(g.s).slice(0, 16);
    return {
      id: gid, number: String(g.gn || ''), day: start.slice(0, 10), start: start,
      rink: rinkNo(g.idf), division: divOf[gameDiv[gid]],
      home: side(g.idT1, g.t1, 1), away: side(g.idT2, g.t2, 2),
      medal: bracket && !fed[gameDiv[gid] + '|' + String(g.gn || '').toUpperCase()],
    };
  }).sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : a.rink - b.rink; });

  const days = [];
  list.forEach(function (g) { if (days.indexOf(g.day) === -1) days.push(g.day); });
  return {
    event: { id: data.EventID, name: ev.name, place: gsPlace_(t, site), mode: ev.fullStats === false ? 'score' : 'full',
      pin: PropertiesService.getScriptProperties().getProperty('GAMESHEET_PIN') || '1234' },
    days: days, rinks: rinks, teams: teams, games: list, today: todayIso_(),
  };
}

function gsPlace_(t, site) {
  const cx = t.complexDictionary || {};
  const k = Object.keys(cx).filter(function (k) { return !site || String(cx[k].state || '').toUpperCase() === site; })[0] || Object.keys(cx)[0];
  return k ? clean_(cx[k].name || cx[k].city, 80) : '';
}

function gsRemoteLogo_(url) {
  if (!url) return '';
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return '';
    const b = res.getBlob();
    return 'data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes());
  } catch (err) { return ''; }
}

/** A steady colour per team name for the badge when the team has no logo. */
function gsColor_(name) {
  const palette = ['#005EC4', '#C8102E', '#1B7F45', '#7C3AED', '#B45309', '#0E7490', '#9F1239', '#334155', '#A16207', '#4338CA'];
  let h = 0;
  String(name || '').split('').forEach(function (c) { h = (h * 31 + c.charCodeAt(0)) >>> 0; });
  return palette[h % palette.length];
}

// ======================= shared game state =======================

function gsVersionKey_(eventId) { return 'gsv:' + eventId; }

/** Everything changed since `since` (ms). Cheap when nothing changed: answered from the cache. */
function gsPoll_(eventId, since) {
  const cache = CacheService.getScriptCache();
  const v = Number(cache.get(gsVersionKey_(eventId)) || 0);
  if (since && v && v <= since) return { ver: v, docs: [] };
  let ver = since;
  const docs = readAll_('GameDocs').filter(function (r) { return r.EventID === eventId && Number(r.UpdatedAt) > since; })
    .map(function (r) {
      ver = Math.max(ver, Number(r.UpdatedAt));
      return r.Json ? { path: r.Path, doc: JSON.parse(r.Json) } : { path: r.Path, deleted: true };
    });
  if (ver) cache.put(gsVersionKey_(eventId), String(ver), 21600);
  return { ver: ver, docs: docs };
}

function gsPut_(eventId, path, doc) {
  if (!GS_DOC_PATH.test(path)) return { error: 'Bad document.' };
  const json = doc === null || doc === undefined ? '' : JSON.stringify(doc);
  if (json.length > GS_MAX_DOC) return { error: 'This game sheet is too large to save.' };
  let notify = null, sirs = null;
  const out = withLock_(function () {
    const rows = readAll_('GameDocs');
    let ver = Date.now();
    rows.forEach(function (r) { if (r.EventID === eventId) ver = Math.max(ver, Number(r.UpdatedAt) + 1); });
    const row = rows.filter(function (r) { return r.EventID === eventId && r.Path === path; })[0];
    if (row) { row.Json = json; row.UpdatedAt = String(ver); update_('GameDocs', row); }
    else if (json) insert_('GameDocs', { EventID: eventId, Path: path, Json: json, UpdatedAt: String(ver) });
    CacheService.getScriptCache().put(gsVersionKey_(eventId), String(ver), 21600);
    // A signed-off game (or a removed one) updates the player stats.
    if (/^games\//.test(path) && (!doc || doc.final)) recordGameStats_(eventId, path, doc || null);
    if (/^games\//.test(path) && doc && doc.final) notify = gsClaimNotices_(eventId, path.slice(6), doc);
    if (/^games\//.test(path) && doc && doc.sirs) sirs = gsClaimSirs_(eventId, path.slice(6), doc);
    return { ver: ver };
  });
  if (notify) { try { gsNotify_(eventId, doc, notify); } catch (err) { console.error('Game sheet email: ' + err); } }
  if (sirs) { try { gsSendSirs_(eventId, doc, sirs); } catch (err) { console.error('SIR email: ' + err); } }
  return out;
}

// ======================= HQ emails =======================

/**
 * Which emails a final game still needs (claimed once per game, inside the lock):
 *   notPlayed  "Game not played" → the event director and the Referee-in-Chief
 *   uncertified  a referee who isn't on the certified list → the Referee-in-Chief
 */
function gsClaimNotices_(eventId, gid, doc) {
  const props = PropertiesService.getScriptProperties();
  const want = {};
  if (doc.notPlayed) want.np = 'gsmail:np:' + eventId + ':' + gid;
  if (uncertifiedOfficials_(doc.off).length) want.unc = 'gsmail:unc:' + eventId + ':' + gid;
  const claim = {};
  Object.keys(want).forEach(function (k) { if (!props.getProperty(want[k])) { props.setProperty(want[k], nowText_()); claim[k] = true; } });
  return Object.keys(claim).length ? claim : null;
}

/** Names typed in as "Other – not certified". */
function uncertifiedOfficials_(off) {
  off = off || {};
  return ['ref1', 'ref2', 'ref3'].filter(function (s) { return off[s + 'Id'] === 'other' && clean_(off[s], 80); })
    .map(function (s) { return clean_(off[s], 80); });
}

const NP_TEXT = {
  agreed: 'Both teams agreed not to play – recorded 0–0.',
  facility: 'Facility / safety – the Game Play Coordinator decides how it’s scored.',
  other: 'Other – Tournament HQ decides how it’s scored.',
};

/** "Game 12 – Wolfpack vs Monarchs (2031/2032), Rink 2, Sat Dec 19 9:00 AM" */
function gsGameText_(doc) {
  const g = doc.game || {};
  let when = '';
  if (g.start) {
    const m = String(g.start).match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/);
    if (m) {
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      const h = +m[4];
      when = Utilities.formatDate(d, 'UTC', 'EEE MMM d') + ' ' + ((h % 12) || 12) + ':' + m[5] + (h < 12 ? ' AM' : ' PM');
    }
  }
  return (g.number ? 'Game ' + g.number : 'A game') + (g.home ? ' – ' + g.home + ' vs ' + g.away : '') +
    (g.division ? ' (' + g.division + ')' : '') + (g.rink ? ', Rink ' + g.rink : '') + (when ? ', ' + when : '');
}

function gsNotify_(eventId, doc, claim) {
  const ev = readEventsTab_().filter(function (e) { return e.id === eventId; })[0];
  if (!ev) return;
  const data = readAll_('EventData').filter(function (d) { return d.EventID === eventId; })[0] || {};
  const url = data.DirectorSheetID ? 'https://docs.google.com/spreadsheets/d/' + data.DirectorSheetID : gameSheetUrl_(data);
  const g = doc.game || {};
  const what = gsGameText_(doc);
  const logo = (function () { try { return logoForEmail_(data); } catch (err) { return null; } })();
  if (claim.np) {
    const np = doc.notPlayed;
    const names = { home: g.home || 'Home', away: g.away || 'Away' };
    const reason = np.reason === 'forfeit'
      ? names[np.team] + ' forfeited – recorded 1–0 for ' + names[np.team === 'home' ? 'away' : 'home'] + '.'
      : NP_TEXT[np.reason] || NP_TEXT.other;
    const to = [ev.directorEmail, REF_CHIEF_EMAIL].filter(Boolean).filter(function (x, i, a) { return a.indexOf(x) === i; }).join(',');
    sendMail_(to, 'Game not played: ' + what + ' – ' + ev.name, 'Game not played',
      [what + '.', reason, 'Note from the rink: “' + clean_(np.note, 500) + '”',
       'Confirmed by referee ' + clean_(np.ref, 80) + '. Referees are still paid for this game (Referee Pay tab).',
       'Enter the result in Tourney Machine.' + (np.reason === 'forfeit'
         ? ' If the team has forfeited the whole event, tick “Forfeited” for them on the Director Sheet – their games become 1–0 losses and the player stats from them are removed.' : '')],
      'Open Director Sheet', url, logo);
  }
  if (claim.unc) {
    const names = uncertifiedOfficials_(doc.off);
    sendMail_(REF_CHIEF_EMAIL, 'Not-certified referee: ' + names.join(', ') + ' – ' + ev.name, 'A referee who isn’t certified worked a game',
      [what + ' at ' + ev.name + '.',
       names.join(', ') + (names.length === 1 ? ' was' : ' were') + ' entered as “Other – not certified” on the game sheet (not on the academy.usboxla.com certified list, or their membership has lapsed).',
       'They show in red on the Referee Pay tab of the Director Sheet.'],
      'Open Director Sheet', url, logo);
  }
}


// ======================= referees (academy.usboxla.com) =======================
//
// The "USBOXLA Referee Feed" WordPress plugin on the academy lists everyone who passed the USBOXLA
// Referee Certification Course (WP Courseware course 11), with their Paid Memberships Pro membership.
// Certified = course passed AND membership active. Script Properties: ACADEMY_URL (the feed address)
// and ACADEMY_KEY (the key from WordPress › Settings › USBOXLA Referee Feed – treat it like a password).
// Synced every 6 hours from scanAll; run syncReferees() any time for an immediate refresh.

const REF_TAB = 'Certified Referees';
const REF_TAB_HEADERS = ['Referee', 'Course completed', 'Membership', 'Membership expires', 'Can referee',
  'Games refereed (this year)', 'Games as scorekeeper (this year)'];
const REF_SYNC_HOURS = 6;
const REF_DEFAULT_RATE = 55;
const REF_CHIEF_EMAIL = 'a.gardner@usboxla.com';   // Referee-in-Chief: "game not played" and not-certified referee emails
const REFPAY_COL = 16;                               // Hub › Events tab column P
const REFPAY_HEADER = 'Ref Pay Rate';
const BOXPAY_COL = 18; // Hub › Events tab column R
const BOXPAY_HEADER = 'Penalty Box Rate';
const REFPAY_TAB = 'Referee Pay';

function academyUrl_() {
  const u = String(PropertiesService.getScriptProperties().getProperty('ACADEMY_URL') || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  return /\/wp-json\//.test(u) ? u : u + '/wp-json/usboxla/v1/referees';
}

/** Admin tool: refreshes the referee list from the academy now. */
function syncReferees() {
  withLock_(function () { console.log(syncReferees_()); });
}

/** scanAll: refresh the list every few hours (quietly does nothing until ACADEMY_URL / ACADEMY_KEY are set). */
function refereesIfStale_() {
  const props = PropertiesService.getScriptProperties();
  if (!academyUrl_() || !props.getProperty('ACADEMY_KEY')) return;
  if (Date.now() - Number(props.getProperty('REFS_SYNCED') || 0) < REF_SYNC_HOURS * 3600000) return;
  props.setProperty('REFS_SYNCED', String(Date.now()));   // a failing feed is retried next interval, not every scan
  try { console.log(syncReferees_()); } catch (err) { console.error('Referees: ' + err.message); }
}

function syncReferees_() {
  const url = academyUrl_();
  const key = PropertiesService.getScriptProperties().getProperty('ACADEMY_KEY');
  if (!url || !key) throw new Error('Add ACADEMY_URL and ACADEMY_KEY in Project Settings › Script Properties first.');
  const res = UrlFetchApp.fetch(url, { headers: { 'x-usboxla-key': key }, muteHttpExceptions: true, followRedirects: true });
  const code = res.getResponseCode();
  if (code !== 200) {
    throw new Error('The academy answered ' + code + (code === 401 || code === 403 ? ' – check ACADEMY_KEY matches the key in WordPress.'
      : code === 404 ? ' – check ACADEMY_URL and that the USBOXLA Referee Feed plugin is active.' : '.'));
  }
  let body;
  try { body = JSON.parse(res.getContentText()); } catch (err) { throw new Error('The academy didn’t send a referee list – check ACADEMY_URL.'); }
  const rows = refereeRows_(body, nowText_());
  if (!rows.length && readAll_('Referees').length > 5) throw new Error('The academy sent an empty list – kept the old one.');
  rewriteTable_('Referees', rows);
  PropertiesService.getScriptProperties().setProperty('REFS_SYNCED', String(Date.now()));
  try { rebuildRefereeTab_(rows); } catch (err) { console.error('Certified Referees tab: ' + err.message); }
  return 'Referees synced: ' + rows.length + ' passed the course, ' +
    rows.filter(function (r) { return r.Certified === 'yes'; }).length + ' can referee.';
}

/** Pure: the academy feed → Referees table rows. */
function refereeRows_(body, stamp) {
  return ((body && body.referees) || []).filter(function (r) { return r && r.id; }).map(function (r) {
    const name = clean_(r.name || ((r.first || '') + ' ' + (r.last || '')), 80);
    return { RefID: String(r.id), FirstName: clean_(r.first, 40), LastName: clean_(r.last, 40), Name: name,
      Completed: toIsoDate_(r.completed) || '', Member: r.member ? 'yes' : '', Level: clean_(r.level, 60),
      Expires: toIsoDate_(r.expires) || '', Certified: r.certified ? 'yes' : '', UpdatedAt: stamp };
  }).filter(function (r) { return r.Name; });
}

/** Pure: the tablet pick list – names only. ok = can referee today. */
function refsForTablet_(rows, today) {
  let sen = {};
  try { if (typeof raSeniors_ === 'function') sen = raSeniors_().ids; } catch (err) {}   // ★ Senior Officials (RefAvail.gs)
  return rows.filter(function (r) { return r.RefID && r.Name; }).map(function (r) {
    const ok = r.Certified === 'yes' && !(r.Expires && r.Expires < today);
    return { id: 'r' + r.RefID, name: r.Name, ok: ok, why: ok ? '' : 'membership expired', senior: !!sen[String(r.RefID)] };
  });
}

/** Hub › "Certified Referees" (read-only; rebuilt on every sync). */
function rebuildRefereeTab_(rows) {
  const year = todayIso_().slice(0, 4);
  const counts = {};
  readAll_('GameDocs').forEach(function (r) {
    if (!/^games\//.test(r.Path) || !r.Json) return;
    let doc; try { doc = JSON.parse(r.Json); } catch (err) { return; }
    if (!doc.final || !doc.finalAt || new Date(Number(doc.finalAt)).getFullYear() !== Number(year)) return;
    officials_(doc.off).forEach(function (o) {
      const c = counts[o.key] || (counts[o.key] = { ref: 0, sk: 0 });
      c[o.role]++;
    });
  });
  const ss = hub_();
  let sh = ss.getSheetByName(REF_TAB);
  if (!sh) {
    sh = ss.insertSheet(REF_TAB);
    sh.getRange(1, 1, 1, REF_TAB_HEADERS.length).setValues([REF_TAB_HEADERS])
      .setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff').setWrap(true);
    sh.setFrozenRows(1);
    [200, 130, 200, 140, 110, 130, 150].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
    sh.getRange(1, 1).setNote('From academy.usboxla.com: everyone who passed the USBOXLA Referee Certification Course. ' +
      'Can referee = membership active. Rebuilt automatically – edits here are overwritten.');
  }
  const last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, REF_TAB_HEADERS.length).clearContent().setBackground(null);
  let senIds = {};
  try { if (typeof raSeniors_ === 'function') senIds = raSeniors_().ids; } catch (err) {}
  const out = rows.map(function (r) {
    const c = counts['r' + r.RefID] || { ref: 0, sk: 0 };
    return [r.Name + (senIds[String(r.RefID)] ? '  ★ Senior Official' : ''), r.Completed, r.Member ? (r.Level || 'Active') : 'Not active', r.Expires || (r.Member ? 'No expiry' : ''),
      r.Certified === 'yes' ? 'Yes' : 'No – renew', c.ref, c.sk];
  });
  if (out.length) {
    if (sh.getMaxRows() < out.length + 1) sh.insertRowsAfter(sh.getMaxRows(), out.length + 1 - sh.getMaxRows());
    sh.getRange(2, 1, out.length, REF_TAB_HEADERS.length).setValues(out);
    out.forEach(function (r, i) { if (r[4] !== 'Yes') sh.getRange(i + 2, 1, 1, REF_TAB_HEADERS.length).setBackground('#FDECEE'); });
  }
}

/**
 * Pure: who worked a game. [{key, role: 'ref'|'sk', slot, id, name, certified}]
 * key = 'r<id>' for academy referees, 'n:<name>' for anyone typed in. Tournament scorekeepers aren't paid → left out.
 */
function officials_(off) {
  off = off || {};
  const out = [];
  ['ref1', 'ref2', 'ref3'].forEach(function (s) {
    const name = clean_(off[s], 80), id = String(off[s + 'Id'] || '');
    if (!name) return;
    const listed = /^r\d+$/.test(id);
    out.push({ key: listed ? id : 'n:' + norm_(name), role: 'ref', slot: s, id: listed ? id : '', name: name, certified: listed });
  });
  if (off.skType === 'ref' && /^r\d+$/.test(String(off.skId || '')) && clean_(off.sk, 80)) {
    out.push({ key: String(off.skId), role: 'sk', slot: 'sk', id: String(off.skId), name: clean_(off.sk, 80), certified: true });
  }
  return out;
}

// ---------- Hub › Events › "Ref Pay Rate" ----------

function ensureRefPayColumn_(sh) {
  if (sh.getMaxColumns() < REFPAY_COL) sh.insertColumnsAfter(sh.getMaxColumns(), REFPAY_COL - sh.getMaxColumns());
  const head = sh.getRange(1, REFPAY_COL);
  if (String(head.getValue()) === REFPAY_HEADER) return;
  head.setValue(REFPAY_HEADER).setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff')
    .setNote('Pay per game for each referee at this event. Blank = $' + REF_DEFAULT_RATE + '. ' +
      'A referee who runs the penalty box is paid the Penalty Box Rate (column R). Shows on the Referee Pay tab of the Director Sheet.');
  sh.setColumnWidth(REFPAY_COL, 100);
  sh.getRange(2, REFPAY_COL, sh.getMaxRows() - 1, 1).setNumberFormat('$#,##0.00');
}

/** Hub › Events › "Penalty Box Rate" (column R): pay per game for a USBOXLA referee who runs the penalty box / scorekeeps. */
function ensureBoxPayColumn_(sh) {
  if (sh.getMaxColumns() < BOXPAY_COL) sh.insertColumnsAfter(sh.getMaxColumns(), BOXPAY_COL - sh.getMaxColumns());
  const head = sh.getRange(1, BOXPAY_COL);
  if (String(head.getValue()) === BOXPAY_HEADER) return;
  head.setValue(BOXPAY_HEADER).setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff')
    .setNote('Pay per game for a USBOXLA referee who runs the penalty box (picked as scorekeeper on the tablet) at this event. ' +
      'Blank = half the Ref Pay Rate. Tournament scorekeepers are paid by the tournament, not through BILL. Shows on the Referee Pay tab of the Director Sheet.');
  sh.setColumnWidth(BOXPAY_COL, 110);
  sh.getRange(2, BOXPAY_COL, sh.getMaxRows() - 1, 1).setNumberFormat('$#,##0.00');
}

/** Hub › Events › "Director Phone" (column S): the director's cell, typed in by USBOXLA (SportsEngine's phone isn't reliable). Shows on Adam's Overview. */
const DIRPHONE_COL = 19; // Hub › Events tab column S
const DIRPHONE_HEADER = 'Director Phone';
function ensureDirPhoneColumn_(sh) {
  if (sh.getMaxColumns() < DIRPHONE_COL) sh.insertColumnsAfter(sh.getMaxColumns(), DIRPHONE_COL - sh.getMaxColumns());
  const head = sh.getRange(1, DIRPHONE_COL);
  const cur = String(head.getValue()).trim();
  if (cur === DIRPHONE_HEADER) return;
  if (cur) throw new Error('Hub Events column S already holds "' + cur + '" – Director Phone not added.');
  head.setValue(DIRPHONE_HEADER).setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff')
    .setNote('The tournament director\'s cell phone (type it in – the SportsEngine registration phone isn\'t reliable). Shows on the Referee-in-Chief Hub Overview.');
  sh.setColumnWidth(DIRPHONE_COL, 130);
  sh.getRange(2, DIRPHONE_COL, sh.getMaxRows() - 1, 1).setNumberFormat('@');
}

function boxRate_(v, refRate) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  if (s === '') return Math.round((refRate || REF_DEFAULT_RATE) * 50) / 100;   // blank = half the referee rate
  const n = Number(s.replace(/[^0-9.]/g, ''));
  return n >= 0 && isFinite(n) ? n : Math.round((refRate || REF_DEFAULT_RATE) * 50) / 100;
}

function refRate_(v) {
  const n = Number(String(v === null || v === undefined ? '' : v).replace(/[^0-9.]/g, ''));
  return n > 0 ? n : REF_DEFAULT_RATE;
}

// ---------- Director Sheet › "Referee Pay" ----------

/**
 * Pure: pay per referee from the event's final game sheets (cancelled and forfeited games count).
 * docs = [{gid, doc}], info(gid, doc) → {date, time, number, rink, division, matchup}, refs = Referees rows.
 */
function refPay_(docs, info, refs, rate, boxRate) {
  if (boxRate === undefined) boxRate = Math.round(rate * 50) / 100;
  const status = {};
  refs.forEach(function (r) { status['r' + r.RefID] = r.Certified === 'yes' ? 'Certified' : 'Membership lapsed'; });
  const people = {}, detail = [];
  docs.filter(function (d) { return d.doc && d.doc.final; }).forEach(function (d) {
    const offs = officials_(d.doc.off);
    offs.forEach(function (o) {
      const p = people[o.key] || (people[o.key] = { key: o.key, name: o.name, ref: 0, sk: 0,
        status: o.certified ? status[o.key] || 'Not on the academy list' : 'NOT CERTIFIED' });
      p[o.role]++;
    });
    const g = info(d.gid, d.doc);
    const slot = function (s) { const o = offs.filter(function (x) { return x.slot === s; })[0]; return o ? o.name + (o.certified ? '' : ' ⚠') : ''; };
    const off = d.doc.off || {};
    const sk = off.skType === 'ref' ? slot('sk') + ' (referee – penalty box)' : clean_(off.sk, 80) ? clean_(off.sk, 80) + ' (tournament)' : '';
    detail.push({ sort: (g.date || '') + ' ' + (g.time24 || '') + ' ' + ('000' + (g.rink || '')).slice(-3), row: [g.date || '', g.time || '', g.number || '', g.rink || '',
      g.division || '', g.matchup || '', gameResultText_(d.doc), slot('ref1'), slot('ref2'), slot('ref3'), sk] });
  });
  const summary = Object.keys(people).map(function (k) { return people[k]; }).sort(function (a, b) {
    return a.name.localeCompare(b.name);
  }).map(function (p) { p.pay = Math.round((p.ref * rate + p.sk * boxRate) * 100) / 100; return p; });
  detail.sort(function (a, b) { return a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0; });
  return { summary: summary, detail: detail.map(function (d) { return d.row; }) };
}

function gameResultText_(doc) {
  const np = doc.notPlayed;
  if (np && np.reason !== 'forfeit') return np.reason === 'agreed' ? 'Not played (0–0)' : 'Not played – ' + (np.reason === 'facility' ? 'facility / safety' : 'other');
  const s = gameScore_(doc);
  return s.home + '–' + s.away + (np ? ' (forfeit)' : doc.so ? ' (SO)' : (doc.events || []).some(function (e) { return e.period === 'OT'; }) ? ' (OT)' : '');
}

/** scanAll: rebuilds the Director Sheet's Referee Pay tab when a game was finalized or the rate changed. */
function refPayScan_(ev, data, ctx) {
  if (!data.DirectorSheetID) return;
  const docs = [];
  let ver = 0;
  (ctx.gameDocs || (ctx.gameDocs = readAll_('GameDocs'))).forEach(function (r) {
    if (r.EventID !== ev.id || !/^games\//.test(r.Path) || !r.Json) return;
    ver = Math.max(ver, Number(r.UpdatedAt) || 0);
    let doc; try { doc = JSON.parse(r.Json); } catch (err) { return; }
    if (doc.final) docs.push({ gid: r.Path.slice(6), doc: doc });
  });
  if (!docs.length) return;
  const rate = ev.refRate || REF_DEFAULT_RATE;
  const boxRate = ev.boxRate === undefined ? Math.round(rate * 50) / 100 : ev.boxRate;
  const sig = ver + '|' + docs.length + '|' + rate + '|' + boxRate;
  if (data.RefPayAt === sig) return;

  let tm = null;
  try { if (ev.tmId) tm = tmGet_('/Tournaments/' + encodeURIComponent(ev.tmId) + '/false'); } catch (err) { /* game numbers come from the tablet */ }
  const info = function (gid, doc) {
    const g = doc.game || {}, t = tm && (tm.gameDictionary || {})[gid];
    const teamName = function (id, label) { return id && tm.teamDictionary && tm.teamDictionary[id] ? tm.teamDictionary[id].name : label || ''; };
    const start = String((t && t.s) || g.start || '');
    const hh = Number(start.slice(11, 13)), mm = start.slice(14, 16);
    return { date: start.slice(0, 10), time24: start.slice(11, 16), time: start.length >= 16 ? ((hh % 12) || 12) + ':' + mm + (hh < 12 ? ' AM' : ' PM') : '',
      number: String((t && t.gn) || g.number || ''), rink: g.rink || '', division: g.division || '',
      matchup: t ? teamName(t.idT1, t.t1) + ' vs ' + teamName(t.idT2, t.t2) : (g.home ? g.home + ' vs ' + g.away : '') };
  };
  const pay = refPay_(docs, info, readAll_('Referees'), rate, boxRate);
  writeRefPayTab_(data, pay, rate, boxRate);
  data.RefPayAt = sig;
  update_('EventData', data);
}

const REFPAY_SUM_HEADERS = ['Referee', 'Academy status', 'Games refereed', 'Games running the penalty box', 'Pay', 'Paid'];
const REFPAY_DETAIL_HEADERS = ['Date', 'Time', 'Game', 'Rink', 'Division', 'Matchup', 'Result', 'Referee 1', 'Referee 2', 'Referee 3', 'Scorekeeper'];
const REFPAY_FIRST = 4;   // summary header row

function writeRefPayTab_(data, pay, rate, boxRate) {
  if (boxRate === undefined) boxRate = Math.round(rate * 50) / 100;
  const ss = SpreadsheetApp.openById(data.DirectorSheetID);
  let sh = ss.getSheetByName(REFPAY_TAB);
  const paid = {};
  if (!sh) {
    sh = ss.insertSheet(REFPAY_TAB);
    [190, 170, 110, 120, 90, 60, 140, 260, 160, 160, 160].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  } else {
    // Keep the Paid ticks (by referee name) across rebuilds.
    const last = sh.getLastRow();
    if (last > REFPAY_FIRST) {
      sh.getRange(REFPAY_FIRST + 1, 1, last - REFPAY_FIRST, 6).getValues().some(function (r) {
        if (!String(r[0]).trim()) return true;
        if (r[5] === true) paid[String(r[0]).trim().toLowerCase()] = true;
        return false;
      });
    }
    sh.clear();
    sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).clearDataValidations();
  }
  const need = REFPAY_FIRST + pay.summary.length + 5 + pay.detail.length;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  const money = function (n) { return '$' + (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, ''); };
  sh.getRange(1, 1).setValue('Referee pay').setFontWeight('bold').setFontSize(14);
  sh.getRange(2, 1).setValue(money(rate) + ' per game refereed (Hub › Ref Pay Rate), ' + money(boxRate) + ' per game running the penalty box (Hub › Penalty Box Rate). ' +
    'Cancelled and forfeited games count. Tick Paid when you’ve paid someone – everything else here is rebuilt from the game sheets.')
    .setFontColor('#5d6570');
  const sum = pay.summary.map(function (p) {
    return [p.name, p.status, p.ref, p.sk, p.pay, !!paid[p.name.toLowerCase()]];
  });
  const total = pay.summary.reduce(function (t, p) { return t + p.pay; }, 0);
  sh.getRange(REFPAY_FIRST, 1, 1, REFPAY_SUM_HEADERS.length).setValues([REFPAY_SUM_HEADERS])
    .setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff').setWrap(true);
  let row = REFPAY_FIRST + 1;
  if (sum.length) {
    sh.getRange(row, 1, sum.length, REFPAY_SUM_HEADERS.length).setValues(sum);
    sh.getRange(row, 5, sum.length, 1).setNumberFormat('$#,##0.00');
    sh.getRange(row, 6, sum.length, 1).insertCheckboxes();
    sum.forEach(function (r, i) {
      if (r[1] === 'NOT CERTIFIED') sh.getRange(row + i, 1, 1, 2).setFontColor('#C8102E').setFontWeight('bold');
      else if (r[1] !== 'Certified') sh.getRange(row + i, 2).setFontColor('#B45309');
    });
    row += sum.length;
  }
  sh.getRange(row, 1, 1, 5).setValues([['Total', '', pay.summary.reduce(function (t, p) { return t + p.ref; }, 0),
    pay.summary.reduce(function (t, p) { return t + p.sk; }, 0), total]]).setFontWeight('bold');
  sh.getRange(row, 5).setNumberFormat('$#,##0.00');
  row += 3;
  sh.getRange(row - 1, 1).setValue('Game by game').setFontWeight('bold').setFontSize(12);
  sh.getRange(row, 1, 1, REFPAY_DETAIL_HEADERS.length).setValues([REFPAY_DETAIL_HEADERS])
    .setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff');
  if (pay.detail.length) {
    sh.getRange(row + 1, 1, pay.detail.length, REFPAY_DETAIL_HEADERS.length).setNumberFormat('@').setValues(pay.detail);
  }
  sh.setFrozenRows(0);
}


// ======================= Adam's Certified Referees List (daily, 8am) =======================
// Every morning dailyJobs refreshes one Google Sheet of everyone who can referee today (course passed and
// membership current) and emails the link to the Referee-in-Chief. The sheet's ID is kept in Script Property
// ADAM_REF_LIST_ID (made on the first run); ADAM_REF_LIST_SENT stops a second email on a retried daily job.

const ADAM_LIST_SUBJECT = "Adam's Certified Referees List";

function emailCertifiedRefereesList_(force, to) {
  const props = PropertiesService.getScriptProperties();
  const today = todayIso_();
  if (!force && props.getProperty('ADAM_REF_LIST_SENT') === today) return 'Already sent today.';
  const mdy = function (iso) { return iso ? iso.slice(5, 7) + '/' + iso.slice(8, 10) + '/' + iso.slice(0, 4) : ''; };
  const rows = readAll_('Referees').filter(function (r) {
    return r.Name && r.Certified === 'yes' && !(r.Expires && r.Expires < today);
  }).sort(function (a, b) {
    const x = (a.LastName + ' ' + a.FirstName).toLowerCase(), y = (b.LastName + ' ' + b.FirstName).toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
  let ss = null;
  const id = props.getProperty('ADAM_REF_LIST_ID');
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (err) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create(ADAM_LIST_SUBJECT);
    props.setProperty('ADAM_REF_LIST_ID', ss.getId());
    try { ss.addViewer(REF_CHIEF_EMAIL); } catch (err) { console.error('Share list: ' + err.message); }
  }
  const sh = ss.getSheetByName('Certified Referees') || ss.getSheets().filter(function (s) { return s.getName() !== RIC_OVERVIEW_TAB; })[0];
  sh.setName('Certified Referees');
  sh.clear();
  const head = ['First Name', 'Last Name', 'Level', 'Course Completed', 'Membership Expires'];
  const vals = [head].concat(rows.map(function (r) {
    return [r.FirstName || r.Name, r.LastName, r.Level, mdy(r.Completed), mdy(r.Expires)];
  }));
  sh.getRange(1, 1, vals.length, head.length).setNumberFormat('@').setValues(vals);
  sh.getRange(1, 1, 1, head.length).setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff')
    .setNote('Updated ' + mdy(today) + ' at 8am. Everyone here has passed the referee course and has a current membership.');
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, head.length);
  try { console.log(rebuildRefAvailTab_()); } catch (err) { console.error('Referee availability tab: ' + err.message); }
  try { raBuildAllHotelTabs_(); } catch (err) { console.error('Referee hotel tabs: ' + err.message); }
  try { console.log(rebuildApplicantsTab_()); } catch (err) { console.error('Referee applicants tab: ' + err.message); }
  try { console.log(rebuildBillTab_()); } catch (err) { console.error('BILL payment setup tab: ' + err.message); }
  try { console.log(rebuildRefProfilesTab_()); } catch (err) { console.error('Referee Profiles tab: ' + err.message); }
  try { evDaily_(); } catch (err) { console.error('Evaluation emails: ' + err.message); }
  try { raReadinessDaily_(); } catch (err) { console.error('Readiness nudges: ' + err.message); }
  try { console.log(backupToGitHub_()); } catch (err) { console.error('GitHub backup: ' + err.message); }
  try { console.log(rebuildEvalTab_()); } catch (err) { console.error('Evaluations tab: ' + err.message); }
  try { console.log(rebuildBillPaymentsTab_()); } catch (err) { console.error('BILL payments tab: ' + err.message); }
  try { console.log(rebuildOverviewTab_()); } catch (err) { console.error('Hub overview tab: ' + err.message); }
  sendMail_(to || REF_CHIEF_EMAIL, ADAM_LIST_SUBJECT, ADAM_LIST_SUBJECT,
    ['Good morning Adam,',
     rows.length + ' referee' + (rows.length === 1 ? ' is' : 's are') + ' certified and can referee today ' +
       '(referee course passed and USBOXLA membership current).',
     'The sheet is refreshed every morning at 8am, so this link always has the latest list.',
     'The "' + RA_TAB + '" tab shows which refs want to work each upcoming tournament. Refs sign the waiver and fill in their availability in the Ref Room (they log in there): ' + RA_PAGE_URL],
    'Open the list', ss.getUrl(), null, null, { footer: 'Sent automatically every morning at 8am.' });
  if (!to) props.setProperty('ADAM_REF_LIST_SENT', today);
  return 'Certified referees list: ' + rows.length + ' referees, sent to ' + (to || REF_CHIEF_EMAIL) + '.';
}

/** Run by hand: sends today's list to Adam now (even if it already went out). */
function sendAdamRefereesListNow() { console.log(emailCertifiedRefereesList_(true)); }


// ======================= Special Incident Reports =======================
// Written on the rink tablet after a match penalty, an injury or an incident (typed, dictated or a voice memo).
// Each report is emailed once to the event director and the Referee-in-Chief and logged, newest first, on the
// "Special Incident Reports" tab of the Director Sheet and of the Referee-in-Chief Hub (with Adam's Follow-up column).

const SIR_TAB = 'Special Incident Reports';
const SIR_KIND_TEXT = { match: 'Match penalty', injury: 'Injury', incident: 'Incident' };

/** Reports on this game that haven't been sent yet (claimed inside the lock, so each goes out once). */
function gsClaimSirs_(eventId, gid, doc) {
  const props = PropertiesService.getScriptProperties();
  const out = [];
  Object.keys(doc.sirs || {}).forEach(function (k) {
    const r = doc.sirs[k];
    if (!r || !r.id) return;
    const key = 'gsmail:sir:' + eventId + ':' + gid + ':' + clean_(r.id, 40);
    if (props.getProperty(key)) return;
    props.setProperty(key, nowText_());
    out.push(r);
  });
  return out.length ? out : null;
}

/** A voice memo from the tablet → the private "Special Incident Reports" Drive folder, viewable by the director and Adam. */
function gsSirAudio_(data, req) {
  const b64 = String(req.data || '');
  if (!b64) return { error: 'No recording.' };
  if (b64.length > 14000000) return { error: 'The voice memo is too long – keep it under 3 minutes.' };
  const mime = /mp4/.test(req.mime) ? 'audio/mp4' : /ogg/.test(req.mime) ? 'audio/ogg' : 'audio/webm';
  const ext = { 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/webm': 'webm' }[mime];
  const name = 'SIR ' + clean_(data.EventID, 40) + ' game ' + clean_(req.game, 40) + ' ' + clean_(req.sir, 40) + '.' + ext;
  const file = sirFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(b64), mime, name));
  const ev = readEventsTab_().filter(function (e) { return e.id === data.EventID; })[0] || {};
  [ev.directorEmail, REF_CHIEF_EMAIL].filter(Boolean).forEach(function (em) {
    try { file.addViewer(em); } catch (err) { console.error('SIR memo share ' + em + ': ' + err); }
  });
  return { file: file.getId() };
}

function sirFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SIR_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (err) { /* recreate below */ } }
  const f = DriveApp.getFolderById(props.getProperty('ROOT_FOLDER_ID')).createFolder('Special Incident Reports (private)');
  props.setProperty('SIR_FOLDER_ID', f.getId());
  return f;
}

function gsSendSirs_(eventId, doc, list) {
  const ev = readEventsTab_().filter(function (e) { return e.id === eventId; })[0];
  if (!ev) return;
  const data = readAll_('EventData').filter(function (d) { return d.EventID === eventId; })[0] || {};
  const what = gsGameText_(doc);
  const logo = (function () { try { return logoForEmail_(data); } catch (err) { return null; } })();
  const sheetUrl = data.DirectorSheetID ? 'https://docs.google.com/spreadsheets/d/' + data.DirectorSheetID : '';
  const to = [ev.directorEmail, REF_CHIEF_EMAIL].filter(Boolean).filter(function (x, i, a) { return a.indexOf(x) === i; }).join(',');
  const rows = list.map(function (r) {
    const kind = SIR_KIND_TEXT[r.kind] || 'Incident';
    const who = ((r.num ? '#' + clean_(r.num, 5) + ' ' : '') + clean_(r.player, 80)).trim();
    const per = r.period ? (r.period === 'OT' ? 'Overtime' : 'Period ' + clean_(r.period, 4)) : '';
    const memo = r.audio ? 'https://drive.google.com/file/d/' + encodeURIComponent(clean_(r.audio, 100)) + '/view' : '';
    const ref = clean_(r.ref, 80) || '(not named)';
    if (typeof ricText_ === 'function') ricText_('Incident report: ' + kind + (who ? ' ' + who : '') + ' – ' + ev.name + '. Details in your email.');
    sendMail_(to, 'Special Incident Report: ' + kind + (who ? ' – ' + who : '') + ' – ' + ev.name, 'Special Incident Report',
      [what + ' at ' + ev.name + '.',
       kind + (who ? ': ' + who : '') + (r.team ? ' (' + clean_(r.team, 80) + ')' : '') + (per ? ', ' + per : '') +
         (r.pen ? '. Penalty: ' + clean_(r.pen, 80) : '') + '.',
       r.text ? 'Report from referee ' + ref + ': “' + clean_(r.text, 3000) + '”' : 'Referee ' + ref + ' recorded a voice memo.',
       memo ? 'Voice memo (private – only the event director and the Referee-in-Chief can open it): ' + memo : '',
       'Every report is kept on the “' + SIR_TAB + '” tab of the Director Sheet and the Referee-in-Chief Hub.'].filter(Boolean),
      memo ? 'Play the voice memo' : (sheetUrl ? 'Open Director Sheet' : ''), memo || sheetUrl, logo);
    return [new Date(Number(r.at) || Date.now()), ev.name, what, kind, clean_(r.team, 80), clean_(r.player, 80), clean_(r.num, 5),
      per, clean_(r.pen, 80), ref, String(r.text || '').slice(0, 3000), memo];
  });
  sirLog_(PropertiesService.getScriptProperties().getProperty('ADAM_REF_LIST_ID'), rows, true);
  if (data.DirectorSheetID) sirLog_(data.DirectorSheetID, rows, false);
}

/** Newest first. Adam's copy has a Follow-up column he fills in (e.g. "1-game suspension", "closed"). */
function sirLog_(sheetId, rows, followUp) {
  if (!sheetId || !rows.length) return;
  try {
    const ss = SpreadsheetApp.openById(sheetId);
    const heads = ['Reported', 'Event', 'Game', 'Type', 'Team', 'Player', '#', 'Period', 'Penalty', 'Referee', 'Report', 'Voice memo']
      .concat(followUp ? ['Follow-up ✎'] : []);
    let sh = ss.getSheetByName(SIR_TAB);
    if (!sh) {
      sh = ss.insertSheet(SIR_TAB);
      sh.getRange(1, 1, 1, heads.length).setValues([heads]).setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff');
      sh.setFrozenRows(1);
      sh.setColumnWidth(1, 140); sh.setColumnWidth(3, 280); sh.setColumnWidth(11, 420); sh.setColumnWidth(12, 200);
      if (followUp) {
        sh.setColumnWidth(13, 240);
        sh.getRange(1, 13).setNote('Your notes – e.g. "1-game suspension", "spoke to coach", "closed". Kept when new reports arrive.');
      }
    }
    const vals = rows.map(function (r) { return followUp ? r.concat(['']) : r; });
    sh.insertRowsBefore(2, vals.length);
    const rg = sh.getRange(2, 1, vals.length, heads.length);
    rg.setValues(vals).setFontWeight('normal').setBackground(null).setFontColor('#000000').setVerticalAlignment('top');
    sh.getRange(2, 11, vals.length, 1).setWrap(true);
    sh.getRange(2, 1, vals.length, 1).setNumberFormat('m/d/yyyy h:mm am/pm');
    if (followUp) sh.getRange(2, 13, vals.length, 1).setBackground('#FFF8E1');
  } catch (err) { console.error('SIR log ' + sheetId + ': ' + err); }
}

// ======================= practice / demo mode =======================

/**
 * …/exec?gsdemo=1 – the real GAME SHEET SYSTEM page with two made-up teams and made-up referees.
 * Nothing is read from or saved to the Hub: the page's requests are answered in the browser.
 * Used for the referee course screenshots and for scorekeepers and referees to practise.
 */
function gameSheetDemo_(e) {
  return HtmlService.createHtmlOutput(gameSheetDemoHtml_(e && e.parameter && e.parameter.shot))
    .setTitle('USBOXLA GAME SHEET SYSTEM – practice')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Practice mode as one HTML string. Also served raw (doGet ?gsdemoraw=1) to the academy, which hosts it at
 * academy.usboxla.com/gamesheet-practice/ – no Google page in the browser, so no multi-account errors.
 * The visitor's browser fills in today's date and the game times (tokens __TODAY__ / __T1__ / __T2__).
 */
function gameSheetDemoHtml_(shot) {
  shot = String(shot || '').replace(/[^a-z]/g, '');
  const today = '__TODAY__', t1 = '__T1__', t2 = '__T2__';
  const first = ['Alex', 'Ben', 'Cole', 'Drew', 'Eli', 'Finn', 'Gabe', 'Hank', 'Ian', 'Jack', 'Kyle', 'Liam', 'Max', 'Nate'];
  const team = function (pre, lasts, nums) {
    return lasts.map(function (l, i) { return { id: pre + i, first: first[i], last: l, num: String(nums[i]), verified: true, goalieDefault: i === 0 }; });
  };
  const day = {
    event: { id: 'DEMO', name: 'USBOXLA Practice Game Sheet', place: 'Practice mode – nothing is saved', mode: 'full', pin: '1234' },
    days: [today], rinks: [{ n: 1, name: 'Rink 1' }],
    teams: {
      t1: { key: 't1', name: 'Blue Hawks 2032 A', short: 'Blue Hawks 2032 A', color: '#005EC4', division: '2032 A', logo: '', roster: true,
        players: team('h', ['Adams', 'Baker', 'Carter', 'Dalton', 'Evans', 'Fisher', 'Grant', 'Hayes', 'Irwin', 'Jensen', 'Keller', 'Lowry', 'Mason', 'Nolan'], [30, 2, 4, 7, 9, 11, 12, 14, 17, 19, 21, 22, 24, 27]) },
      t2: { key: 't2', name: 'Red Wolves 2032 A', short: 'Red Wolves 2032 A', color: '#C8102E', division: '2032 A', logo: '', roster: true,
        players: team('a', ['Parker', 'Quinn', 'Rhodes', 'Sutton', 'Tanner', 'Upton', 'Vance', 'Walsh', 'Young', 'Zeller', 'Archer', 'Brooks', 'Cross', 'Dunn'], [1, 3, 5, 6, 8, 10, 13, 15, 16, 18, 20, 23, 25, 28]) },
    },
    games: [
      { id: 'demo1', number: '12', day: today, start: today + 'T' + t1, rink: 1, division: '2032 A', home: 't1', away: 't2', medal: false },
      { id: 'demo2', number: '13', day: today, start: today + 'T' + t2, rink: 1, division: '2032 A', home: 't2', away: 't1', medal: false },
    ],
    today: today,
    refs: [{ id: 'r1', name: 'Jordan Sample', ok: true, why: '' }, { id: 'r2', name: 'Casey Example', ok: true, why: '' }, { id: 'r3', name: 'Riley Practice', ok: true, why: '' }],
  };
  const stub = '<script>(function () { try { sessionStorage.removeItem("usboxla-device"); } catch (err) {} var d0 = new Date(), p2 = function (n) { return (n < 10 ? "0" : "") + n; }, TD = d0.getFullYear() + "-" + p2(d0.getMonth() + 1) + "-" + p2(d0.getDate());' +
    'var DAY = JSON.parse(' + JSON.stringify(JSON.stringify(day)) + '.replace(/__TODAY__/g, TD).replace(/__T1__/g, p2(d0.getHours()) + ":00").replace(/__T2__/g, p2((d0.getHours() + 1) % 24) + ":00")), ver = 1, real = window.fetch;' +
    'window.fetch = function (u, o) { if (u !== "DEMO_API") return real.apply(this, arguments);' +
    'var b = JSON.parse(o.body), r = b.op === "day" ? DAY : b.op === "poll" ? { docs: [], ver: ver } : { ok: true, ver: ++ver };' +
    'return Promise.resolve(new Response(JSON.stringify(r), { status: 200, headers: { "Content-Type": "application/json" } })); }; })();<\/script>';

  // ?shot=checkin|goal|live|final|hq walks the page to that step by itself (course screenshots).
  const play = shot ? '<script>(function () { var SHOT = "' + shot + '", order = ["checkin", "goal", "live", "final"];' +
    'var upto = function (s) { return order.indexOf(SHOT) >= order.indexOf(s); };' +
    'var q = function (s) { return document.querySelector(s); }; var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };' +
    'var until = async function (s) { for (var i = 0; i < 100; i++) { var el = q(s); if (el && !el.disabled) return el; await wait(100); } throw new Error("demo: " + s); };' +
    'var STEP = ""; var tap = async function (s) { STEP = s; (await until(s)).click(); await wait(250); };' +
    'var pick = async function (sel, v) { STEP = sel; var el = await until(sel); el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); await wait(200); };' +
    'window.addEventListener("load", async function () { try {' +
    ' if (SHOT === "hq") { await tap("#setup-hq"); return; }' +
    ' await tap("[data-setrink=\'1\']");' +
    ' await pick("#ref1", "r1"); await pick("#ref2", "r2"); await pick("#sk", "tourney");' +
    ' var n = await until("#sk-name"); n.value = "Pat Scorer"; n.dispatchEvent(new Event("input", { bubbles: true })); await wait(200);' +
    ' var c = await until("#ref-count"); if (!c.checked) c.click(); await wait(300); window.scrollTo(0, 0);' +
    ' if (SHOT === "officials") { q(".checkin-foot").scrollIntoView({ block: "end" }); return; }' +
    ' if (SHOT === "guide") { await tap("#help-btn"); await tap("#guide-next"); await tap("#guide-next"); return; }' +
    ' if (SHOT === "incident") { await tap("#start"); await tap("#incident"); await tap("#sheet-body [data-sirk=injury]"); await tap("#sheet-body [data-sirt=home]"); await tap("#sheet-body [data-sirp=h5]");' +
    '   var t = await until("#sir-text"); t.value = "#11 Fisher hit his head on the boards after a check in the 1st period. Trainer checked him, he did not return. Parents told."; t.dispatchEvent(new Event("input", { bubbles: true })); return; }' +
    ' if (!upto("goal")) return;' +
    ' await tap("#start"); await tap("[data-goal=home]"); await tap("#sheet-body [data-pick=h8]");' +
    ' if (!upto("live")) return;' +
    ' await tap("#sheet-body [data-pick=h3]");' +
    ' await tap("[data-goal=away]"); await tap("#sheet-body [data-pick=a4]"); await tap("#sheet-body [data-none]");' +
    ' await tap("[data-goal=home]"); await tap("#sheet-body [data-pick=h4]"); await tap("#sheet-body [data-none]"); window.scrollTo(0, 0);' +
    ' if (!upto("final")) return;' +
    ' await tap("#to-final"); var a = await until("#sign-sk"); a.click(); await wait(200); (await until("#sign-ref")).click(); await wait(300); q("#signoff").scrollIntoView({ block: "end" });' +
    ' } catch (err) { console.error(err); var d = document.createElement("div"); d.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99;background:#000;color:#fff;padding:8px;font:14px sans-serif"; d.textContent = "Practice demo stopped at " + STEP + ": " + err.message; document.body.appendChild(d); } }); })();<\/script>' : '';
  const tpl = HtmlService.createTemplateFromFile('GameSheetPage');
  tpl.api = 'DEMO_API';
  tpl.eventId = 'DEMO';
  tpl.key = 'demo';
  tpl.shield = usboxlaLogoDataUri_();
  return stub + tpl.evaluate().getContent() + play;
}
