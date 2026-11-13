/**
 * Player stats from the official game sheet.
 *
 * Every time a game is signed off (finalized) on a rink tablet, its scorers, assists and penalties
 * become one stat line per dressed player in the hidden StatLines table, and the Hub's
 * "Player Stats" tab is rebuilt: one row per player per event, with games played, goals,
 * assists, points and penalty minutes. Shootout goals are never credited (Rule 18.10).
 *
 * Tier comes from the event name: "National…" → National, "…Regional…" → Regional,
 * anything else → Sanctioned. The player profile pages weight National > Regional > Sanctioned.
 */

const STATS_TAB = 'Player Stats';
const STATS_COL = 15; // Hub › Events tab column O: "Full Stats" Yes / No
const STATS_COL_HEADER = 'Full Stats';
const STATS_HEADERS = ['Player', 'Member ID', 'Team', 'Division', 'Event', 'Tier', 'GP', 'G', 'A', 'PTS', 'PIM', 'Goalie'];
const STAT_PIM = 2; // every penalty serves 2 minutes
const TIER_ORDER = { National: 0, Regional: 1, Sanctioned: 2, League: 3 };

function eventTier_(name) {
  const n = String(name || '');
  if (/national/i.test(n)) return 'National';
  if (/regional/i.test(n)) return 'Regional';
  return 'Sanctioned';
}

/**
 * Tiers: Nationals = Tier 1, Regionals = Tier 2, every other sanctioned event = Tier 3; leagues (Hub "Type" = League)
 * have their own "Leagues" heading. The full package – Players to Watch, the Division MVP, headshot All-Tournament
 * graphics, graphics delivered to the USBOXLA social media team – goes to Tier 1–2, leagues, and USBOXLA's own VIP
 * events listed in Script Property PREMIUM_EVENTS (comma-separated name words; default "Border Wars" – still labelled
 * Tier 3). Other Tier 3 events: no Players to Watch, no MVP, text-only All-Tournament graphic, and their graphics go
 * to the director (a "Social Media Graphics" folder in the event folder).
 */
const PREMIUM_EVENTS_DEFAULT = 'Border Wars';
function premiumEvent_(ev) {
  if (!ev) return false;
  if (ev.league) return !seLeague_(ev);          // SportsEngine-run leagues (no stats) have no Players to Watch
  if (eventTier_(ev.name) !== 'Sanctioned') return true;
  const list = PropertiesService.getScriptProperties().getProperty('PREMIUM_EVENTS') || PREMIUM_EVENTS_DEFAULT;
  const n = String(ev.name || '').toLowerCase();
  return list.split(',').map(function (w) { return w.trim().toLowerCase(); }).filter(Boolean)
    .some(function (w) { return n.indexOf(w) !== -1; });
}

/**
 * Hub › Events › "Full Stats" (column O): Yes = the game sheet records scorers, assists and penalties
 * and the games count toward player stats; No = final score only. Left blank, it's filled in on the
 * next scan: Yes for Regionals and Nationals, No for other sanctioned events – change it any time
 * before the event (e.g. Yes to track stats at a sanctioned event you run).
 */
function fullStatsSetting_(cell, eventName) {
  const v = String(cell === null || cell === undefined ? '' : cell).trim().toLowerCase();
  if (v === 'yes' || v === 'true') return true;
  if (v === 'no' || v === 'false') return false;
  return eventTier_(eventName) !== 'Sanctioned';
}

function ensureStatsColumn_(sh) {
  if (sh.getMaxColumns() < STATS_COL) sh.insertColumnsAfter(sh.getMaxColumns(), STATS_COL - sh.getMaxColumns());
  const head = sh.getRange(1, STATS_COL);
  if (String(head.getValue()) !== STATS_COL_HEADER) {
    head.setValue(STATS_COL_HEADER).setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff')
      .setNote('Yes = the GAME SHEET SYSTEM records scorers, assists and penalties, and the games count toward player ' +
        'stats and profiles. No = final scores only. Filled in automatically (Yes for Regionals and Nationals); ' +
        'change it before the event starts.');
    sh.setColumnWidth(STATS_COL, 90);
    sh.getRange(2, STATS_COL, sh.getMaxRows() - 1, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(['Yes', 'No'], true).setAllowInvalid(false).build());
  }
  // Fill the default for any event row that's blank.
  const last = sh.getLastRow();
  if (last < 2) return;
  const names = sh.getRange(2, 1, last - 1, 1).getValues();
  const cells = sh.getRange(2, STATS_COL, last - 1, 1);
  const vals = cells.getValues();
  let changed = false;
  const out = vals.map(function (r, i) {
    if (String(r[0]).trim() || !String(names[i][0]).trim()) return [r[0]];
    changed = true;
    return [fullStatsSetting_('', names[i][0]) ? 'Yes' : 'No'];
  });
  if (changed) cells.setValues(out);
}

/**
 * Turns one finalized game (the game sheet's saved state) into stat lines. Pure: no sheet access,
 * so it can be tested. regs = Registrations rows, teams = TeamData rows, info = { number, date },
 * forfeits = {TeamKey: true} for teams the director marked Forfeited (their games count for nobody).
 * A game recorded as "not played" has no stats.
 */
function statLinesForGame_(eventId, eventName, gameId, doc, regs, teams, info, forfeits) {
  if (!doc || !doc.final || !doc.roster || doc.notPlayed) return [];
  const regById = {}, teamByKey = {};
  regs.forEach(function (r) { if (r.EventID === eventId) regById[r.RegID] = r; });
  teams.forEach(function (t) { teamByKey[t.TeamKey] = t; });
  const events = doc.events || [];
  const sideTeam = function (side) {
    const p = (doc.roster[side] || []).filter(function (x) { return regById[x.id]; })[0];
    return p ? teamByKey[regById[p.id].TeamKey] || null : null;
  };
  // A side with no rostered player on the sheet: find the team by the name the tablet showed.
  const named = function (side) {
    const g = doc.game || {};
    if (!g[side] || !g.division) return null;
    return matchTeam_(teams.filter(function (t) { return t.EventID === eventId; }), canonDivision_(g.division), g[side], '');
  };
  const teamOf = { home: sideTeam('home') || named('home'), away: sideTeam('away') || named('away') };
  if (forfeits && ((teamOf.home && forfeits[teamOf.home.TeamKey]) || (teamOf.away && forfeits[teamOf.away.TeamKey]))) return [];
  const finalAt = doc.finalAt ? new Date(Number(doc.finalAt)) : null;
  const date = info.date || (finalAt ? Utilities.formatDate(finalAt, Session.getScriptTimeZone(), 'yyyy-MM-dd') : '');
  const tier = eventTier_(eventName);
  const lines = [];
  ['home', 'away'].forEach(function (side) {
    const team = teamOf[side], opp = teamOf[side === 'home' ? 'away' : 'home'];
    (doc.roster[side] || []).forEach(function (p) {
      if (!p.dressed) return; // only players who dressed played the game
      const reg = regById[p.id] || {};
      const g = events.filter(function (e) { return e.type === 'goal' && e.scorer === p.id; }).length;
      const a = events.filter(function (e) { return e.type === 'goal' && e.a1 === p.id; }).length;
      const pim = events.filter(function (e) { return e.type === 'pen' && e.player === p.id; }).length * STAT_PIM;
      lines.push({
        EventID: eventId, GameID: String(gameId), GameNo: info.number || '', GameDate: date, Tier: tier,
        Division: team ? team.Division : '', TeamName: team ? team.TeamName : '', Opponent: opp ? opp.TeamName : '',
        RegID: p.id, MemberID: reg.MemberID || '', FirstName: reg.FirstName || p.first || '', LastName: reg.LastName || p.last || '',
        Num: p.num || '', Goalie: p.goalie ? 'yes' : '', GP: '1', G: String(g), A: String(a), PTS: String(g + a),
        PIM: String(pim), FinalAt: finalAt ? finalAt.toISOString() : '',
      });
    });
  });
  return lines;
}

/** Called after a game sheet document is saved: records (or clears) that game's stat lines. Never throws. */
function recordGameStats_(eventId, path, doc) {
  try {
    const m = String(path).match(/^games\/(.+)$/);
    if (!m) return;
    const gameId = m[1];
    const existing = readAll_('StatLines');
    const had = existing.some(function (l) { return l.EventID === eventId && l.GameID === gameId; });
    if (!(doc && doc.final) && !had) return; // nothing to record yet
    let lines = [];
    const ev = readEventsTab_().filter(function (e) { return e.id === eventId; })[0] || {};
    if (doc && doc.final && ev.fullStats !== false) { // score-only events don't count toward player stats
      lines = statLinesForGame_(eventId, ev.name, gameId, doc, readAll_('Registrations'), readAll_('TeamData'), gameInfo_(ev, gameId),
        forfeitsOf_(eventId));
    }
    if (!lines.length && !had) return;
    const keep = existing.filter(function (l) { return !(l.EventID === eventId && l.GameID === gameId); });
    rewriteTable_('StatLines', keep.concat(lines));
    rebuildStatsTab_();
    console.log('Stats: game ' + gameId + ' → ' + lines.length + ' player line(s).');
  } catch (err) {
    console.error('Stats not recorded for ' + path + ': ' + err);
  }
}

/** Game number and date from Tourney Machine (best effort). */
function gameInfo_(ev, gameId) {
  try {
    if (!ev.tmId) return {};
    const g = (tmGet_('/Tournaments/' + encodeURIComponent(ev.tmId) + '/false').gameDictionary || {})[gameId];
    return g ? { number: String(g.gn || ''), date: String(g.s || '').slice(0, 10) } : {};
  } catch (err) {
    return {};
  }
}

function rewriteTable_(name, rows) {
  const sh = table_(name);
  const cols = TABLES[name];
  const last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, cols.length).clearContent();
  writeRows_(sh, 2, rows.map(function (r) { return cols.map(function (c) { return r[c]; }); }));
}

/** Totals per player per event. Pure, for testing. */
function statTotals_(lines, eventNames) {
  const by = {};
  lines.forEach(function (l) {
    const who = l.MemberID || 'reg:' + l.RegID;
    const k = l.EventID + '|' + l.TeamName + '|' + who; // a player on two teams at one event gets a row per team
    const t = by[k] || (by[k] = { player: (l.FirstName + ' ' + l.LastName).trim(), memberId: l.MemberID, team: l.TeamName,
      division: l.Division, event: eventNames[l.EventID] || l.EventID, tier: l.Tier, gp: 0, g: 0, a: 0, pim: 0, goalie: false });
    t.gp += Number(l.GP) || 0; t.g += Number(l.G) || 0; t.a += Number(l.A) || 0; t.pim += Number(l.PIM) || 0;
    if (l.Goalie === 'yes') t.goalie = true;
  });
  return Object.keys(by).map(function (k) { return by[k]; }).sort(function (x, y) {
    return (TIER_ORDER[x.tier] - TIER_ORDER[y.tier]) || ((y.g + y.a) - (x.g + x.a)) || (y.g - x.g) ||
      x.player.localeCompare(y.player);
  });
}

/** The Hub's visible "Player Stats" tab (read-only for people; rebuilt after every final). */
function rebuildStatsTab_() {
  const names = {};
  readEventsTab_().forEach(function (e) { if (e.id) names[e.id] = e.name; });
  const totals = statTotals_(readAll_('StatLines'), names);
  const ss = hub_();
  let sh = ss.getSheetByName(STATS_TAB);
  if (!sh) {
    sh = ss.insertSheet(STATS_TAB);
    sh.getRange(1, 1, 1, STATS_HEADERS.length).setValues([STATS_HEADERS])
      .setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff');
    sh.setFrozenRows(1);
    [200, 110, 200, 140, 300, 100, 60, 60, 60, 60, 60, 70].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
    sh.getRange(1, 1).setNote('Filled in automatically from signed-off game sheets. Edits here are overwritten.');
  }
  const last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, STATS_HEADERS.length).clearContent();
  const rows = totals.map(function (t) {
    return [t.player, t.memberId, t.team, t.division, t.event, t.tier, t.gp, t.g, t.a, t.g + t.a, t.pim, t.goalie ? 'G' : ''];
  });
  if (rows.length) {
    if (sh.getMaxRows() < rows.length + 1) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 1 - sh.getMaxRows());
    sh.getRange(2, 1, rows.length, STATS_HEADERS.length).setValues(rows);
  }
}

/** {TeamKey: true} for the teams the director marked Forfeited at this event. */
function forfeitsOf_(eventId, eventData) {
  const d = (eventData || readAll_('EventData')).filter(function (x) { return x.EventID === eventId; })[0] || {};
  const out = {};
  String(d.Forfeits || '').split(',').filter(Boolean).forEach(function (k) { out[k] = true; });
  return out;
}

/** Stat lines from the saved game sheets – every event, or just `onlyEvent`. No lock (callers hold it). */
function statLinesFromDocs_(onlyEvent) {
  const evs = readEventsTab_();
  const regs = readAll_('Registrations'), teams = readAll_('TeamData'), eventData = readAll_('EventData');
  const tmCache = {}, forfeits = {};
  let lines = [];
  readAll_('GameDocs').forEach(function (r) {
    if (onlyEvent && r.EventID !== onlyEvent) return;
    const m = String(r.Path).match(/^games\/(.+)$/);
    if (!m || !r.Json) return;
    const doc = JSON.parse(r.Json);
    if (!doc.final) return;
    const ev = evs.filter(function (e) { return e.id === r.EventID; })[0] || {};
    if (ev.fullStats === false) return; // score-only event
    let info = {};
    try {
      if (ev.tmId) {
        const t = tmCache[ev.tmId] || (tmCache[ev.tmId] = tmGet_('/Tournaments/' + encodeURIComponent(ev.tmId) + '/false'));
        const g = (t.gameDictionary || {})[m[1]];
        if (g) info = { number: String(g.gn || ''), date: String(g.s || '').slice(0, 10) };
      }
    } catch (err) { /* game number is optional */ }
    const ff = forfeits[r.EventID] || (forfeits[r.EventID] = forfeitsOf_(r.EventID, eventData));
    lines = lines.concat(statLinesForGame_(r.EventID, ev.name, m[1], doc, regs, teams, info, ff));
  });
  return lines;
}

/** One event's stat lines again (e.g. after the director ticks or unticks Forfeited). No lock (scanAll holds it). */
function rebuildEventStats_(eventId) {
  const keep = readAll_('StatLines').filter(function (l) { return l.EventID !== eventId; });
  const lines = statLinesFromDocs_(eventId);
  rewriteTable_('StatLines', keep.concat(lines));
  rebuildStatsTab_();
  console.log('Stats rebuilt for ' + eventId + ': ' + lines.length + ' line(s).');
}

/** Admin tool: rebuilds every stat line from the saved game sheets (e.g. after clearing test games). */
function rebuildAllStats() {
  withLock_(function () {
    const lines = statLinesFromDocs_(null);
    rewriteTable_('StatLines', lines);
    rebuildStatsTab_();
    console.log('Rebuilt ' + lines.length + ' stat line(s).');
  });
}
