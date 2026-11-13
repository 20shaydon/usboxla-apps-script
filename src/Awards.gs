/**
 * All-Star picks and player awards (badges on stats.usboxla.com).
 *
 * Per Tourney Machine division (skill tier):
 *   AA (or a division with no A/AA split):
 *     1st place: 3 × All-Tournament 1st Team, Goalie 1st Team, Division MVP, 2 × All-Tournament 2nd Team
 *     2nd place: 2 × 1st Team, 2 × 2nd Team, Goalie 2nd Team
 *     3rd place: 1 × 1st Team, 1 × 2nd Team
 *     4th place: 1 × 2nd Team
 *   Every team in every tier picks 1 × All-Tournament Honorable Mention.
 *
 * How it runs:
 *   • As soon as every division has a champion on the event's last day (scan), or else the morning after
 *     (dailyJobs): final places are worked out from the medal games
 *     (championship + 3rd-place game) and written into a "Final Place" column on the Director Sheet,
 *     which the director can correct. Each team gets an "All-Star Picks" tab in its roster sheet with
 *     dropdowns of its own verified players, and each manager gets an email.
 *   • Every scan while picks are open: director corrections and managers' picks are read back.
 *   • Day 2: reminder to managers with unfinished picks. Day 3: final reminder. Day 4: picks lock and the badges go live.
 *     (Day 1 = the day picks open – usually right after the finals, while teams travel home.)
 */

const AWARDS_FROM = '2026-10-07';   // events that ended before this date never get All-Star emails
const AWARD_TAB = 'All-Star Picks';
const PLACE_COL = 10;               // Director Sheet › Teams › column J (after Skill Level was added in C)
const PLACE_HEADER = 'Final Place';
const PLACE_LABELS = ['1st', '2nd', '3rd', '4th'];
const PICK_DAYS = 3;          // picks lock 3 days after they open (day 4)
const PICK_REMIND_DAYS = [1, 2]; // reminders 1 and 2 days after they open (days 2 and 3)

/** True while All-Star picks are open (before and after the reminders). */
function awardsOpen_(data) { return ['open', 'reminded', 'reminded2'].indexOf(data.AwardsStage) !== -1; }
const AWARD_NAMES = {
  mvp: 'Division MVP',
  first_team: 'All-Tournament 1st Team',
  goalie: 'Goalie – 1st Team',
  second_team: 'All-Tournament 2nd Team',
  goalie2: 'Goalie – 2nd Team',
  honors: 'All-Tournament Honorable Mention',
};
const AWARD_ORDER = ['first_team', 'mvp', 'goalie', 'second_team', 'goalie2', 'honors'];  // the MVP comes from the 1st Team
const PICK_FIRST_ROW = 5;

// ======================= rules (pure) =======================

/** What a team picks: [{award, n}]. tier 'A' = lower skill tier; 'AA' or '' (no split) = top tier.
 *  premium = false (Tier 3 sanctioned events, see premiumEvent_): no Division MVP. */
function awardQuota_(tier, place, premium) {
  const top = String(tier || '').toUpperCase() !== 'A';
  const q = [];
  if (top && place === 1) {
    q.push({ award: 'first_team', n: 3 }, { award: 'goalie', n: 1 });
    if (premium !== false) q.push({ award: 'mvp', n: 1 });
    q.push({ award: 'second_team', n: 2 });
  }
  else if (top && place === 2) q.push({ award: 'first_team', n: 2 }, { award: 'second_team', n: 2 }, { award: 'goalie2', n: 1 });
  else if (top && place === 3) q.push({ award: 'first_team', n: 1 }, { award: 'second_team', n: 1 });
  else if (top && place === 4) q.push({ award: 'second_team', n: 1 });
  q.push({ award: 'honors', n: 1 });
  return q;
}

function placeLabel_(p) { return PLACE_LABELS[p - 1] || ''; }
function placeFromText_(v) { const m = String(v || '').match(/^\s*([1-4])/); return m ? Number(m[1]) : 0; }

/** Final score of a saved game sheet: goals per side, +1 to the shootout winner. "Not played": forfeit 1–0, else 0–0. */
function gameScore_(doc) {
  if (doc.notPlayed) {
    const f = doc.notPlayed.reason === 'forfeit' ? doc.notPlayed.team : '';
    return { home: f === 'away' ? 1 : 0, away: f === 'home' ? 1 : 0 };
  }
  const goals = function (side) { return (doc.events || []).filter(function (e) { return e.type === 'goal' && e.team === side; }).length; };
  return { home: goals('home') + (doc.so === 'home' ? 1 : 0), away: goals('away') + (doc.so === 'away' ? 1 : 0) };
}

/**
 * Pure: {tmTeamId: place 1–4} from a Tourney Machine tournament and the final game sheets ({gameId: doc}).
 * Per division, the medal games are bracket games that don't feed another game. The one between two
 * "Loser of …" teams is the 3rd-place game; the other is the championship. Anything unclear is left
 * out for the director to fill in. forfeitTids = {tmTeamId: true} for teams marked Forfeited.
 */
function medalPlaces_(t, docs, forfeitTids) {
  forfeitTids = forfeitTids || {};
  const divs = (t && t.divisionDictionary) || {};
  const games = (t && t.gameDictionary) || {};
  const out = {};
  Object.keys(divs).forEach(function (dk) {
    const gids = (divs[dk].idGames || []).filter(function (gid) { return games[gid]; });
    const fed = {};
    gids.forEach(function (gid) {
      [games[gid].t1, games[gid].t2].forEach(function (s) {
        const m = String(s || '').match(/(?:winner|loser)\s+(?:of\s+)?(?:game\s+)?#?\s*(\S+)/i);
        if (m) fed[m[1].toUpperCase()] = true;
      });
    });
    const medal = gids.filter(function (gid) {
      const g = games[gid];
      const bracket = /^B/i.test(String(g.gn || '')) || /(place|winner|loser|seed)/i.test(String(g.t1 || '') + ' ' + String(g.t2 || ''));
      return bracket && !fed[String(g.gn || '').toUpperCase()];
    });
    const losersGame = function (gid) { return /loser/i.test(games[gid].t1 || '') && /loser/i.test(games[gid].t2 || ''); };
    let finals = medal.filter(function (gid) { return !losersGame(gid); });
    let thirds = medal.filter(losersGame);
    if (finals.length === 2 && !thirds.length) {          // no labels to go by: the later game is the final
      finals.sort(function (a, b) { return String(games[a].s) < String(games[b].s) ? -1 : 1; });
      thirds = [finals[0]]; finals = [finals[1]];
    }
    if (finals.length !== 1 || thirds.length > 1) return;
    const result = function (gid) {
      const g = games[gid], d = docs[gid];
      if (!g.idT1 || !g.idT2) return null;
      // A team the director marked Forfeited loses every game 1–0.
      if (forfeitTids[g.idT1] && !forfeitTids[g.idT2]) return { w: g.idT2, l: g.idT1 };
      if (forfeitTids[g.idT2] && !forfeitTids[g.idT1]) return { w: g.idT1, l: g.idT2 };
      if (!d || !d.final) return null;
      const s = gameScore_(d);
      if (s.home === s.away) return null;
      return s.home > s.away ? { w: g.idT1, l: g.idT2 } : { w: g.idT2, l: g.idT1 };
    };
    const f = result(finals[0]);
    if (f) { out[f.w] = 1; out[f.l] = 2; }
    if (thirds.length) { const r = result(thirds[0]); if (r) { out[r.w] = 3; out[r.l] = 4; } }
  });
  return out;
}

/** Dropdown names for a team's verified players (a birth year is added when two share a name). */
function pickLabels_(regs) {
  const base = function (g) { return (String(g.FirstName || '').trim() + ' ' + String(g.LastName || '').trim()).trim(); };
  const counts = {};
  regs.forEach(function (g) { const k = base(g).toLowerCase(); counts[k] = (counts[k] || 0) + 1; });
  return regs.map(function (g) {
    const b = base(g);
    return { label: counts[b.toLowerCase()] > 1 ? b + ' (' + String(g.DOB || '').slice(0, 4) + ')' : b, reg: g };
  });
}

/**
 * Pure: checks the picked names. rows = [{award, pick}], labels = [{label, reg}].
 * Returns [{status, reg|null}] in the same order.
 */
function checkPicks_(rows, labels) {
  const byLabel = {};
  labels.forEach(function (x) { byLabel[x.label] = x.reg; });
  const seen = {};
  const firstTeam = {}, secondTeam = {};
  rows.forEach(function (r) {
    if (r.award === 'first_team' && byLabel[r.pick]) firstTeam[r.pick] = true;
    if (r.award === 'second_team' && byLabel[r.pick]) secondTeam[r.pick] = true;
  });
  return rows.map(function (r) {
    const pick = String(r.pick || '').trim();
    if (!pick) return { status: '⚠ Choose a player', reg: null };
    const reg = byLabel[pick];
    if (!reg) return { status: '⚠ Not on your verified roster', reg: null };
    const k = r.award + '|' + pick;
    if (seen[k]) return { status: '⚠ Already picked for this award', reg: null };
    seen[k] = true;
    if (r.award === 'mvp' && !firstTeam[pick]) return { status: '⚠ Pick your MVP from your 1st Team picks', reg: null };
    if (r.award === 'second_team' && firstTeam[pick]) return { status: '⚠ Already on the 1st Team – pick someone else', reg: null };
    if (r.award === 'honors' && (firstTeam[pick] || secondTeam[pick])) {
      return { status: '⚠ Already on the ' + (firstTeam[pick] ? '1st' : '2nd') + ' Team – pick someone else', reg: null };
    }
    return { status: '✓ Saved', reg: reg };
  });
}

// ======================= event data =======================

/**
 * Every team at the event with what it picks: [{team, tier, group, place, regs, labels, quota}].
 * Final places: the director's "Final Place" column wins; blanks are filled from the medal games.
 */
function awardTeams_(ev, data, ctx, fillPlaces) {
  const teams = ctx.teams.filter(function (t) { return t.EventID === ev.id; });
  const forfeits = forfeitsOf_(ev.id, [data]);
  const tierOf = {}, autoPlace = {};
  if (ev.tmId) {
    try {
      const t = tmGet_('/Tournaments/' + encodeURIComponent(ev.tmId) + '/false');
      const site = tmEventSite_(ev);
      const docs = {};
      readAll_('GameDocs').forEach(function (r) {
        if (r.EventID !== ev.id || !/^games\//.test(r.Path) || !r.Json) return;
        try { docs[r.Path.slice(6)] = JSON.parse(r.Json); } catch (err) { /* skip */ }
      });
      const divs = t.divisionDictionary || {};
      const ours = {}, forfeitTids = {};
      Object.keys(t.teamDictionary || {}).forEach(function (tid) {
        const tmTeam = t.teamDictionary[tid];
        const d = divs[tmTeam.idDivision];
        if (!d) return;
        const m = tmStandardDivision_(d.name);
        if (!m.division || (m.site && site && m.site !== site)) return;
        const td = matchTeam_(teams, m.division, tmTeam.name, m.tier);
        if (!td) return;
        tierOf[td.TeamKey] = m.tier;
        ours[tid] = td;
        if (forfeits[td.TeamKey]) forfeitTids[tid] = true;
      });
      const places = medalPlaces_(t, docs, forfeitTids);
      Object.keys(ours).forEach(function (tid) { if (places[tid]) autoPlace[ours[tid].TeamKey] = places[tid]; });
    } catch (err) { console.error('Awards: Tourney Machine – ' + err.message); }
  }

  // Director Sheet "Final Place" column (filled where blank; the director's entries always win)
  const sh = teamsSheet_(data);
  ensurePlaceColumn_(sh);
  const last = sh.getLastRow();
  const rowOf = {}, placeOf = {};
  if (last >= 2) {
    const vals = sh.getRange(2, 1, last - 1, PLACE_COL).getValues();
    vals.forEach(function (r, i) {
      const division = canonDivision_(clean_(r[1], 30));
      const td = matchTeam_(teams, division, clean_(r[0], 80), skillLevel_(r[SKILL_COL - 1]));
      if (!td || rowOf[td.TeamKey]) return;          // first row for a team wins (later ones are duplicates)
      rowOf[td.TeamKey] = i + 2;
      if (skillLevel_(r[SKILL_COL - 1])) tierOf[td.TeamKey] = skillLevel_(r[SKILL_COL - 1]);   // the director's skill level wins
      placeOf[td.TeamKey] = placeFromText_(r[PLACE_COL - 1]);
    });
  }
  teams.forEach(function (td) {
    if (fillPlaces && !placeOf[td.TeamKey] && autoPlace[td.TeamKey] && rowOf[td.TeamKey]) {
      placeOf[td.TeamKey] = autoPlace[td.TeamKey];
      sh.getRange(rowOf[td.TeamKey], PLACE_COL).setValue(placeLabel_(autoPlace[td.TeamKey])).setNote(AUTO_PLACE_NOTE);
    }
  });

  const premium = premiumEvent_(ev);
  return teams.map(function (td) {
    const regs = ctx.regs.filter(function (g) { return g.TeamKey === td.TeamKey && g.Present === 'yes' && g.Status === 'verified'; });
    const tier = tierOf[td.TeamKey] || td.Tier || '';
    const place = placeOf[td.TeamKey] || 0;
    return { team: td, tier: tier, group: td.Division + (tier ? ' ' + tier : ''), place: place, forfeited: !!forfeits[td.TeamKey],
      regs: regs, labels: pickLabels_(regs), quota: awardQuota_(tier, place, premium), auto: autoPlace[td.TeamKey] || 0 };
  });
}

const AUTO_PLACE_NOTE = 'Filled in from the medal games.';

// ======================= forfeits =======================
//
// Director Sheet › Teams › "Forfeited" (column K, a checkbox). Ticking it for a team:
//   • every game that team played counts as a 1–0 win for the other team (Final Place / medal games),
//   • the player stats from all of that team's games are removed – for both teams,
//   • the team gets no All-Star picks, and Final Places filled in from the medal games are worked out again.
// Unticking puts everything back. The Hub's Status column shows "Forfeit applied: …".
const FORFEIT_COL = 11;
const FORFEIT_HEADER = 'Forfeited';
const FORFEIT_RECENT_DAYS = 60;   // finished events are checked for changes this long after they end

function ensureForfeitColumn_(sh) {
  if (sh.getMaxColumns() < FORFEIT_COL) sh.insertColumnsAfter(sh.getMaxColumns(), FORFEIT_COL - sh.getMaxColumns());
  const head = sh.getRange(1, FORFEIT_COL);
  if (String(head.getValue()) === FORFEIT_HEADER) {
    // Sheets set up on Oct 7 got FALSE in every row; clear the unticked ones once.
    const rows = sh.getMaxRows() - 1;
    if (sh.getRange(sh.getMaxRows(), FORFEIT_COL).getValue() === false) {
      const rng = sh.getRange(2, FORFEIT_COL, rows, 1);
      rng.setValues(rng.getValues().map(function (r) { return [r[0] === true ? true : '']; }));
      forfeitCheckboxes_(sh);
    }
    return;
  }
  head.setValue(FORFEIT_HEADER).setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff')
    .setNote('Tick only if this team forfeits the event. All of its games then count as 1–0 wins for the other teams, ' +
      'the player stats from those games are removed (for both teams), and the team gets no All-Star picks. ' +
      'Untick to undo. Enter the 1–0 results in Tourney Machine too.');
  sh.setColumnWidth(FORFEIT_COL, 90);
  forfeitCheckboxes_(sh);
}

/** Checkbox rule only (blank = unticked), so the column doesn't fill the sheet with FALSE values. */
function forfeitCheckboxes_(sh) {
  sh.getRange(2, FORFEIT_COL, sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireCheckbox().build());
}

/**
 * scanAll: reads the Forfeited ticks. When they changed, rebuilds the event's stats and places.
 * Returns the Hub status note ('' when no team forfeited).
 */
function forfeitScan_(ev, data, ctx) {
  const teams = ctx.teams.filter(function (t) { return t.EventID === ev.id; });
  const finished = ev.end < ctx.today;
  if (finished) {
    if (daysBetween_(ev.end, ctx.today) > FORFEIT_RECENT_DAYS) return forfeitNote_(data, teams);
    const since = data.ForfeitRead ? new Date(data.ForfeitRead + 'Z') : new Date(0);
    if (DriveApp.getFileById(data.DirectorSheetID).getLastUpdated() <= since) return forfeitNote_(data, teams);
  }
  const sh = teamsSheet_(data);
  ensureForfeitColumn_(sh);
  const keys = [];
  const last = sh.getLastRow();
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, FORFEIT_COL).getValues().forEach(function (r) {
      if (r[FORFEIT_COL - 1] !== true) return;
      const td = matchTeam_(teams, canonDivision_(clean_(r[1], 30)), clean_(r[0], 80), skillLevel_(r[SKILL_COL - 1]));
      if (td && keys.indexOf(td.TeamKey) === -1) keys.push(td.TeamKey);
    });
  }
  keys.sort();
  const now = keys.join(',');
  data.ForfeitRead = isoUtc_(new Date());
  const changed = now !== (data.Forfeits || '');
  data.Forfeits = now;
  update_('EventData', data);
  if (changed) {
    console.log('Forfeits for ' + ev.name + ': ' + (now || 'none'));
    rebuildEventStats_(ev.id);
    // Final places worked out from the medal games are worked out again (the director's own entries stay).
    const lastRow = sh.getLastRow();
    if (lastRow >= 2 && String(sh.getRange(1, PLACE_COL).getValue()) === PLACE_HEADER) {
      const cells = sh.getRange(2, PLACE_COL, lastRow - 1, 1);
      const notes = cells.getNotes();
      notes.forEach(function (n, i) { if (n[0] === AUTO_PLACE_NOTE) sh.getRange(i + 2, PLACE_COL).clearContent().setNote(''); });
    }
    if (awardsOpen_(data)) collectAwards_(ev, data, ctx, { fillPlaces: true });
  }
  return forfeitNote_(data, teams);
}

function forfeitNote_(data, teams) {
  const keys = String(data.Forfeits || '').split(',').filter(Boolean);
  if (!keys.length) return '';
  const names = keys.map(function (k) {
    const t = teams.filter(function (x) { return x.TeamKey === k; })[0];
    return t ? t.TeamName + ' (' + t.Division + (t.Tier ? ' ' + t.Tier : '') + ')' : k;
  });
  return 'Forfeit applied: ' + names.join(', ') + ' – enter their games as 1–0 in Tourney Machine';
}

function ensurePlaceColumn_(sh) {
  const head = sh.getRange(1, PLACE_COL);
  if (String(head.getValue()) === PLACE_HEADER) return;
  head.setValue(PLACE_HEADER).setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff')
    .setNote('Filled in after the event from the championship and 3rd-place games. Change it if it’s wrong – ' +
      'it decides how many All-Star picks each team gets.');
  sh.setColumnWidth(PLACE_COL, 110);
  sh.getRange(2, PLACE_COL, sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(PLACE_LABELS, true).setAllowInvalid(false).build());
}

// ======================= the All-Star Picks tab =======================

function awardTabName_(info, ctx) {
  const shared = ctx.teams.filter(function (t) { return t.RosterSheetID === info.team.RosterSheetID; }).length > 1;
  return shared ? AWARD_TAB + ' – ' + info.team.Division : AWARD_TAB;
}

/** Creates/updates the team's tab and returns its picks [{award, slot, status, reg}]. */
function syncAwardTab_(ev, info, ctx, lockDate, locked) {
  const ss = SpreadsheetApp.openById(info.team.RosterSheetID);
  const name = awardTabName_(info, ctx);
  let sh = ss.getSheetByName(name);
  const fresh = !sh;
  if (fresh) {
    sh = ss.insertSheet(name);
    sh.setColumnWidth(1, 260); sh.setColumnWidth(2, 260); sh.setColumnWidth(3, 320);
    sh.hideColumns(4);
    sh.setFrozenRows(PICK_FIRST_ROW - 1);
  }
  // Picks already made, by award + slot (kept when the quota changes)
  const prev = {};
  const lastRow = sh.getLastRow();
  if (!fresh && lastRow >= PICK_FIRST_ROW) {
    sh.getRange(PICK_FIRST_ROW, 1, lastRow - PICK_FIRST_ROW + 1, 4).getValues().forEach(function (r) {
      if (r[3]) prev[String(r[3])] = String(r[1] || '');
    });
  }
  const rows = [];
  AWARD_ORDER.forEach(function (award) {
    const q = info.quota.filter(function (x) { return x.award === award; })[0];
    if (!q) return;
    for (let i = 1; i <= q.n; i++) {
      rows.push({ award: award, slot: i, key: award + '#' + i, pick: prev[award + '#' + i] || '',
        label: leagueWords_(ev, AWARD_NAMES[award]) + (q.n > 1 ? ' (' + i + ' of ' + q.n + ')' : '') + (award === 'mvp' ? ' – from your 1st Team' : '') });
    }
  });
  const checked = checkPicks_(rows, info.labels);

  const where = info.place && info.place <= 4 && String(info.tier).toUpperCase() !== 'A'
    ? 'You finished ' + placeLabel_(info.place) + ' in ' + info.group + ' – congratulations!'
    : 'Thanks for playing in ' + info.group + '.';
  const header = [
    [AWARD_TAB + ' – ' + info.team.TeamName + ' (' + info.team.Division + ') – ' + ev.name, '', '', ''],
    [where + ' Choose from your verified players in the dropdowns. Selected players get a badge on their USBOXLA player profile.', '', '', ''],
    [locked ? '🔒 Picks are locked.' : ('Picks lock on ' + prettyDate_(lockDate) + '.' + ' Your picks save within about 10 minutes – the Status column shows ✓ Saved once they’re in.'), '', '', ''],
    ['Award', 'Player', 'Status', 'key'],
  ];
  writeIfChanged_(sh.getRange(1, 1, 4, 4), header);
  if (fresh) {
    sh.getRange(1, 1).setFontWeight('bold').setFontSize(14);
    sh.getRange(2, 1, 2, 1).setWrap(false);
    sh.getRange(4, 1, 1, 3).setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff');
  }
  const body = rows.map(function (r, i) { return [r.label, r.pick, (locked ? '🔒 ' : '') + checked[i].status, r.key]; });
  const have = Math.max(0, sh.getLastRow() - PICK_FIRST_ROW + 1);
  if (have > body.length) sh.getRange(PICK_FIRST_ROW + body.length, 1, have - body.length, 4).clearContent().clearDataValidations();
  if (body.length) {
    writeIfChanged_(sh.getRange(PICK_FIRST_ROW, 1, body.length, 4), body);
    sh.getRange(PICK_FIRST_ROW, 3, body.length, 1).setBackground(GREY);
    const names = info.labels.map(function (x) { return x.label; });
    const pickRange = sh.getRange(PICK_FIRST_ROW, 2, body.length, 1);
    if (names.length) {
      pickRange.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(names, true).setAllowInvalid(true).build());
    }
  }
  if (fresh) lockRange_(sh.getRange(1, 1, sh.getMaxRows(), 1), 'Filled in by USBOXLA');
  if (fresh) lockRange_(sh.getRange(1, 3, sh.getMaxRows(), 2), 'Filled in by USBOXLA');
  if (locked && !sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) {
    const p = sh.protect().setDescription('All-Star picks are locked');
    p.removeEditors(p.getEditors());
    if (p.canDomainEdit()) p.setDomainEdit(false);
  }
  return { url: 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/edit#gid=' + sh.getSheetId(),
    picks: rows.map(function (r, i) { return { award: r.award, slot: r.slot, status: checked[i].status, reg: checked[i].reg }; }) };
}

/** Reads every team's picks into the Awards table. Returns [{info, url, picks}]. */
function collectAwards_(ev, data, ctx, opts) {
  const lockDate = addDaysIso_(data.AwardsOpened || ctx.today, PICK_DAYS);
  // A team marked Forfeited gets no All-Star picks.
  const infos = awardTeams_(ev, data, ctx, !!opts.fillPlaces).filter(function (x) { return x.regs.length && !x.forfeited; });
  const out = [];
  const rows = [];
  infos.forEach(function (info) {
    try {
      const r = syncAwardTab_(ev, info, ctx, lockDate, !!opts.lock);
      out.push({ info: info, url: r.url, picks: r.picks });
      r.picks.forEach(function (p) {
        if (!p.reg) return;
        rows.push({ EventID: ev.id, TeamKey: info.team.TeamKey, TeamName: info.team.TeamName, Division: info.team.Division,
          Tier: info.tier, Place: String(info.place || ''), Award: p.award, Slot: String(p.slot), RegID: p.reg.RegID,
          MemberID: p.reg.MemberID || '', FirstName: p.reg.FirstName, LastName: p.reg.LastName, UpdatedAt: nowText_() });
      });
    } catch (err) { console.error('Awards: ' + info.team.TeamName + ' – ' + err.message); }
  });
  const keep = readAll_('Awards').filter(function (r) { return r.EventID !== ev.id; });
  rewriteTable_('Awards', keep.concat(rows));
  data.AwardsRead = isoUtc_(new Date());
  update_('EventData', data);
  return out;
}

function addDaysIso_(iso, n) {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) + n * 86400000);
  return d.toISOString().slice(0, 10);
}

function managerEmails_(team) { return String(team.SharedWith || '').split(',').filter(Boolean); }

function quotaText_(quota) {
  return quota.map(function (q) { return q.n + ' × ' + AWARD_NAMES[q.award]; }).join(', ');
}

// ======================= stages =======================

function openAwards_(ev, data, ctx, send) {
  data.AwardsStage = 'open';
  data.AwardsOpened = ctx.today;
  update_('EventData', data);
  const res = collectAwards_(ev, data, ctx, { fillPlaces: true });
  if (!send) return res;
  const lockDate = addDaysIso_(ctx.today, PICK_DAYS);
  res.forEach(function (r) {
    const info = r.info;
    const top = info.place && info.place <= 4 && String(info.tier).toUpperCase() !== 'A';
    managerEmails_(info.team).forEach(function (to) {
      sendMail_(to, leagueWords_(ev, 'All-Star picks: ') + info.team.TeamName + ' (' + info.team.Division + ') – ' + ev.name,
        leagueWords_(ev, 'Pick your All-Stars – ') + info.team.TeamName,
        ['Hi Coach,',
         (top ? 'Congratulations on finishing ' + placeLabel_(info.place) + ' in ' + info.group + ' at ' + ev.name + '! '
              : 'Thanks for bringing ' + info.team.TeamName + ' to ' + ev.name + '. ') +
           leagueWords_(ev, 'Please choose your team’s All-Star selections: ' + quotaText_(info.quota) + '.'),
         'Open the "' + awardTabName_(info, ctx) + '" tab in your roster sheet and pick from the dropdowns – ' +
           'they list your verified players, so there’s nothing to type.',
         'Picks lock on ' + prettyDate_(lockDate) + '. Selected players get a badge on their USBOXLA player profile at stats.usboxla.com.'],
        'Make your picks', r.url, logoForEmail_(data));
    });
  });
  if (ev.directorEmail) {
    const lines = res.slice().sort(function (a, b) {
      return a.info.group < b.info.group ? -1 : a.info.group > b.info.group ? 1 : (a.info.place || 9) - (b.info.place || 9);
    }).map(function (r) { return r.info.group + ': ' + (r.info.place ? placeLabel_(r.info.place) : '–') + ' ' + r.info.team.TeamName; });
    sendMail_(ev.directorEmail, leagueWords_(ev, 'All-Star picks are open – ') + ev.name, leagueWords_(ev, 'All-Star picks are open'),
      ['Hi' + (ev.directorName ? ' ' + ev.directorName : '') + ',',
       leagueWords_(ev, 'Team managers have been asked for their All-Star picks. Final places (from the championship and 3rd-place games):')]
       .concat(lines.length ? lines : ['No final places found yet.']).concat([
       'If a place is wrong or missing, change the "Final Place" column on your Director Sheet – the managers’ pick ' +
         'lists update within minutes. Picks lock on ' + prettyDate_(lockDate) + '.']),
      'Open Director Sheet', 'https://docs.google.com/spreadsheets/d/' + data.DirectorSheetID, logoForEmail_(data));
  }
  return res;
}

function remindAwards_(ev, data, ctx, last) {
  const res = collectAwards_(ev, data, ctx, {});
  const lockDate = addDaysIso_(data.AwardsOpened, PICK_DAYS);
  res.forEach(function (r) {
    const missing = r.picks.filter(function (p) { return !p.reg; }).length;
    if (!missing) return;
    managerEmails_(r.info.team).forEach(function (to) {
      sendMail_(to, (last ? 'Final reminder' : 'Reminder') + leagueWords_(ev, ': All-Star picks for ') + r.info.team.TeamName + ' – ' + ev.name,
        leagueWords_(ev, last ? 'All-Star picks lock tomorrow' : 'Your All-Star picks aren’t finished'),
        ['Hi Coach,', missing + leagueWords_(ev, ' All-Star pick') + (missing === 1 ? ' is' : 's are') + ' still open for ' + r.info.team.TeamName +
          ' (' + r.info.team.Division + '). Picks lock on ' + prettyDate_(lockDate) + '.'],
        'Make your picks', r.url, logoForEmail_(data));
    });
  });
  data.AwardsStage = last ? 'reminded2' : 'reminded';
  update_('EventData', data);
}

function closeAwards_(ev, data, ctx) {
  collectAwards_(ev, data, ctx, { lock: true });
  data.AwardsStage = 'closed';
  data.AwardsClosed = nowText_();   // the recap emails wait a couple of hours after this (ProfileMail.gs)
  update_('EventData', data);
  console.log('All-Star picks closed for ' + ev.name + '.');
}

/** dailyJobs: opens picks the morning after an event (day 1), reminds on days 2 and 3, locks on day 4. */
function awardsDaily_(ctx) {
  readEventsTab_().forEach(function (ev) {
    if (!ev.id || !ev.end || ev.end >= ctx.today || ev.end < AWARDS_FROM) return;
    const data = ctx.eventData.filter(function (d) { return d.EventID === ev.id; })[0];
    if (!data || !data.DirectorSheetID) return;
    try {
      const stage = data.AwardsStage || '';
      if (!stage) openAwards_(ev, data, ctx, true);
      else if (awardsOpen_(data)) {
        const d = daysBetween_(data.AwardsOpened, ctx.today);
        if (d >= PICK_DAYS) closeAwards_(ev, data, ctx);
        else if (d >= PICK_REMIND_DAYS[1] && stage !== 'reminded2') remindAwards_(ev, data, ctx, true);
        else if (d >= PICK_REMIND_DAYS[0] && stage === 'open') remindAwards_(ev, data, ctx, false);
      }
    } catch (err) { console.error('Awards ' + ev.name + ': ' + err.message); }
  });
}

/**
 * scanAll, on an event's last day: opens All-Star picks (and emails managers) as soon as every division
 * has a champion from its final, so coaches can pick on the trip home. Otherwise dailyJobs opens them the next morning.
 */
function awardsEarlyOpen_(ev, data, ctx) {
  if (data.AwardsStage || ev.end !== ctx.today || ev.end < AWARDS_FROM || !data.DirectorSheetID) return;
  const groups = {};
  awardTeams_(ev, data, ctx, false).forEach(function (x) {
    if (!x.regs.length || x.forfeited) return;
    const g = groups[x.group] || (groups[x.group] = { champ: false });
    if (x.place === 1 || x.auto === 1) g.champ = true;
  });
  const keys = Object.keys(groups);
  if (!keys.length || keys.some(function (k) { return !groups[k].champ; })) return;
  console.log('Every division has a champion – opening All-Star picks for ' + ev.name + '.');
  openAwards_(ev, data, ctx, true);
}

/** scanAll: while picks are open, re-read director corrections and picks when a sheet changed. */
function awardsScan_(ev, data, ctx) {
  if (!awardsOpen_(data)) return;
  const since = data.AwardsRead ? new Date(data.AwardsRead + 'Z') : new Date(0);
  let changed = DriveApp.getFileById(data.DirectorSheetID).getLastUpdated() > since;
  if (!changed) {
    const q = "modifiedDate > '" + isoUtc_(new Date(since.getTime() - 5 * 60 * 1000)) + "'";
    changed = DriveApp.getFolderById(data.RostersFolderID).searchFiles(q).hasNext();
  }
  if (changed) collectAwards_(ev, data, ctx, {});
}

// ======================= public feed =======================

/** {memberId: [{event, award, division, tier, team}]} for events whose picks are locked. */
function publicAwards_() {
  const closed = {};
  readAll_('EventData').forEach(function (d) { if (d.AwardsStage === 'closed') closed[d.EventID] = true; });
  const out = {};
  readAll_('Awards').forEach(function (a) {
    if (!closed[a.EventID] || !a.MemberID) return;
    (out[a.MemberID] = out[a.MemberID] || []).push({ event: a.EventID, award: a.Award, division: a.Division, tier: a.Tier, team: a.TeamName });
  });
  return out;
}

/**
 * {eventId: [{division, tier, award, slot, team, slug}]} for locked events – the All-Tournament teams.
 * slug is set only for players with a public profile; everyone else stays anonymous (team only).
 */
function publicAllStars_(profiles) {
  const closed = {};
  readAll_('EventData').forEach(function (d) { if (d.AwardsStage === 'closed') closed[d.EventID] = true; });
  const slugOf = {};
  profiles.forEach(function (p) { if (p.memberId) slugOf[p.memberId] = p.slug; });
  const out = {};
  readAll_('Awards').forEach(function (a) {
    if (!closed[a.EventID]) return;
    (out[a.EventID] = out[a.EventID] || []).push({ division: a.Division, tier: a.Tier || '', award: a.Award,
      slot: Number(a.Slot) || 1, team: a.TeamName, slug: (a.MemberID && slugOf[a.MemberID]) || '' });
  });
  return out;
}

// ======================= admin tools =======================

/** Admin tool: opens All-Star picks now for the event whose name contains `match` (no emails unless send=true). */
function openAllStarPicksNow(match, send) {
  const ev = readEventsTab_().filter(function (e) { return e.id && e.name.indexOf(match || 'Utica') !== -1; })[0];
  if (!ev) { console.log('No event matches ' + (match || 'Utica')); return; }
  const ctx = loadCtx_();
  const data = ctx.eventData.filter(function (d) { return d.EventID === ev.id; })[0];
  const res = openAwards_(ev, data, ctx, !!send);
  res.forEach(function (r) {
    console.log(r.info.group + ' · ' + r.info.team.TeamName + ' · place ' + (r.info.place || '–') + ' · ' + quotaText_(r.info.quota) + '\n   picks: ' + r.url);
  });
  console.log('Director Sheet (Final Place column): https://docs.google.com/spreadsheets/d/' + data.DirectorSheetID);
  console.log('Opened All-Star picks for ' + ev.name + (send ? ' and emailed managers.' : ' (no emails sent).'));
}

/** Admin tool: locks All-Star picks now (badges go live on the next feed refresh). */
function closeAllStarPicksNow(match) {
  const ev = readEventsTab_().filter(function (e) { return e.id && e.name.indexOf(match || 'Utica') !== -1; })[0];
  if (!ev) { console.log('No event matches ' + (match || 'Utica')); return; }
  const ctx = loadCtx_();
  const data = ctx.eventData.filter(function (d) { return d.EventID === ev.id; })[0];
  closeAwards_(ev, data, ctx);
}

/** Admin tool: undoes a test run – removes the All-Star tabs, saved picks and Final Places for the event. */
function resetAllStarPicks(match) {
  const ev = readEventsTab_().filter(function (e) { return e.id && e.name.indexOf(match || 'Utica') !== -1; })[0];
  if (!ev) { console.log('No event matches ' + (match || 'Utica')); return; }
  const ctx = loadCtx_();
  const data = ctx.eventData.filter(function (d) { return d.EventID === ev.id; })[0];
  ctx.teams.filter(function (t) { return t.EventID === ev.id; }).forEach(function (t) {
    try {
      const ss = SpreadsheetApp.openById(t.RosterSheetID);
      ss.getSheets().filter(function (s) { return s.getName().indexOf(AWARD_TAB) === 0; }).forEach(function (s) { ss.deleteSheet(s); });
    } catch (err) { console.error(err); }
  });
  rewriteTable_('Awards', readAll_('Awards').filter(function (r) { return r.EventID !== ev.id; }));
  const sh = teamsSheet_(data);
  if (sh.getLastRow() >= 2 && String(sh.getRange(1, PLACE_COL).getValue()) === PLACE_HEADER) {
    sh.getRange(2, PLACE_COL, sh.getLastRow() - 1, 1).clearContent();
  }
  data.AwardsStage = ''; data.AwardsOpened = ''; data.AwardsRead = '';
  update_('EventData', data);
  console.log('All-Star picks reset for ' + ev.name + '.');
}

// ======================= Players to Watch =======================
//
// Before an event, every team manager picks one Player to Watch from their verified roster, plus one line
// about them (60 characters max). Only players with a public USBOXLA player profile can be picked.
//   • 7 days out (dailyJobs): a "Player to Watch" tab appears in each roster sheet and managers get an email.
//   • 4 days out: a reminder to managers who haven’t picked.
//   • 2 days out at 8am Eastern (scan): picks lock. The players go up on the tournament page at
//     stats.usboxla.com (stats.usboxla.com/watch.php?e=EVENTID) with Instagram post/story graphics.
// WATCH_LIVE = true: picks open on their own 7 days before premium events (Regionals, Nationals, Border Wars). Set false to pause.

const WATCH_LIVE = true;
const WATCH_TAB = 'Player to Watch';
const WATCH_OPEN_DAYS = 7;
const WATCH_REMIND_DAYS = 4;
const WATCH_LOCK_DAYS = 2;
const WATCH_LOCK_HOUR = '08';          // Eastern
const WATCH_BLURB_MAX = 60;
const WATCH_ROW = 5;

/** 'YYYY-MM-DD HH' when picks lock for an event (2 days before it starts, 8am Eastern). */
function watchLockAt_(ev) { return addDaysIso_(ev.start, -WATCH_LOCK_DAYS) + ' ' + WATCH_LOCK_HOUR; }
function easternNow_() { return Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM-dd HH'); }
function watchLockText_(ev) { return prettyDate_(addDaysIso_(ev.start, -WATCH_LOCK_DAYS)) + ' at 8am Eastern'; }

/** Pure: checks one pick. labels = [{label, reg}] of eligible players. Returns {status, reg, blurb}. */
function checkWatch_(pick, blurb, labels) {
  pick = String(pick || '').trim();
  const line = String(blurb || '').replace(/\s+/g, ' ').trim();
  if (!labels.length) return { status: '⚠ No players with a public profile yet', reg: null, blurb: '' };
  if (!pick) return { status: '⚠ Choose a player', reg: null, blurb: '' };
  const hit = labels.filter(function (x) { return x.label === pick; })[0];
  if (!hit) return { status: '⚠ Pick from the list (players with a public profile)', reg: null, blurb: '' };
  if (line.length > WATCH_BLURB_MAX) {
    return { status: '⚠ Saved – but shorten the line to ' + WATCH_BLURB_MAX + ' characters (now ' + line.length + ')', reg: hit.reg, blurb: '' };
  }
  return { status: line ? '✓ Saved' : '✓ Saved – add one line about them', reg: hit.reg, blurb: line };
}

/** Teams at the event that have verified players: [{team, tier, group, regs, labels}] (labels: public profiles only). */
function watchTeams_(ev, ctx) {
  const today = ctx.today;
  const publicIds = {};
  readProfiles_().forEach(function (p) { if (p.memberId && membershipState_(p, today) !== 'inactive') publicIds[p.memberId] = true; });
  return ctx.teams.filter(function (t) { return t.EventID === ev.id; }).map(function (td) {
    const regs = ctx.regs.filter(function (g) { return g.TeamKey === td.TeamKey && g.Present === 'yes' && g.Status === 'verified'; });
    const eligible = regs.filter(function (g) { return g.MemberID && publicIds[g.MemberID]; });
    const tier = td.Tier || '';
    return { team: td, tier: tier, group: td.Division + (tier ? ' ' + tier : ''), regs: regs, labels: pickLabels_(eligible) };
  }).filter(function (x) { return x.regs.length; });
}

function watchTabName_(info, ctx) {
  const shared = ctx.teams.filter(function (t) { return t.RosterSheetID === info.team.RosterSheetID; }).length > 1;
  return shared ? WATCH_TAB + ' – ' + info.team.Division : WATCH_TAB;
}

/** Creates/updates the team's tab and returns {url, check}. */
function syncWatchTab_(ev, info, ctx, locked) {
  const ss = SpreadsheetApp.openById(info.team.RosterSheetID);
  const name = watchTabName_(info, ctx);
  let sh = ss.getSheetByName(name);
  const fresh = !sh;
  if (fresh) {
    sh = ss.insertSheet(name);
    sh.setColumnWidth(1, 160); sh.setColumnWidth(2, 240); sh.setColumnWidth(3, 420); sh.setColumnWidth(4, 340);
    sh.setFrozenRows(WATCH_ROW - 1);
  }
  const cur = sh.getRange(WATCH_ROW, 2, 1, 2).getValues()[0];
  const check = checkWatch_(cur[0], cur[1], info.labels);
  const how = info.labels.length
    ? 'Choose one player from the dropdown and add one line about them (' + WATCH_BLURB_MAX + ' characters max), e.g. “Lefty sniper – led the team in goals last season”. ' +
      'They’ll be featured on the ' + (ev.league ? 'league' : 'tournament') + ' page at stats.usboxla.com and on USBOXLA’s Instagram before the ' + (ev.league ? 'season' : 'event') + '.'
    : 'None of your verified players has a public USBOXLA player profile yet, so there’s no one to pick. ' +
      'A player can turn on “Public Player Profile Stats Page” in their USBOXLA membership – they’ll show up here within the hour.';
  const header = [
    [WATCH_TAB + ' – ' + info.team.TeamName + ' (' + info.team.Division + ') – ' + ev.name, '', '', ''],
    [how, '', '', ''],
    [locked ? '🔒 Picks are locked.' : ('Picks lock on ' + watchLockText_(ev) + '.' + ' Your pick saves within about 10 minutes – the Status column shows ✓ Saved once they’re in.'), '', '', ''],
    ['', 'Player', 'One line about them (' + WATCH_BLURB_MAX + ' characters max)', 'Status'],
  ];
  writeIfChanged_(sh.getRange(1, 1, 4, 4), header);
  writeIfChanged_(sh.getRange(WATCH_ROW, 1, 1, 4), [['⭐ Player to Watch', cur[0], cur[1], (locked ? '🔒 ' : '') + check.status]]);
  if (fresh) {
    sh.getRange(1, 1).setFontWeight('bold').setFontSize(14);
    sh.getRange(2, 1, 2, 1).setWrap(false);
    sh.getRange(4, 1, 1, 4).setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff');
    sh.getRange(WATCH_ROW, 1).setFontWeight('bold');
    sh.getRange(WATCH_ROW, 4).setBackground(GREY);
    lockRange_(sh.getRange(1, 1, sh.getMaxRows(), 1), 'Filled in by USBOXLA');
    lockRange_(sh.getRange(1, 4, sh.getMaxRows(), 1), 'Filled in by USBOXLA');
    lockRange_(sh.getRange(1, 2, WATCH_ROW - 1, 2), 'Filled in by USBOXLA');
  }
  const names = info.labels.map(function (x) { return x.label; });
  if (names.length) {
    sh.getRange(WATCH_ROW, 2).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(names, true).setAllowInvalid(true).build());
  }
  if (locked && !sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) {
    const p = sh.protect().setDescription('Player to Watch is locked');
    p.removeEditors(p.getEditors());
    if (p.canDomainEdit()) p.setDomainEdit(false);
  }
  return { url: 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/edit#gid=' + sh.getSheetId(), check: check };
}

/** Reads every team's pick into the Watch table. Returns [{info, url, check}]. */
function collectWatch_(ev, data, ctx, opts) {
  const out = [], rows = [];
  watchTeams_(ev, ctx).forEach(function (info) {
    try {
      const r = syncWatchTab_(ev, info, ctx, !!opts.lock);
      out.push({ info: info, url: r.url, check: r.check });
      const g = r.check.reg;
      if (g) rows.push({ EventID: ev.id, TeamKey: info.team.TeamKey, TeamName: info.team.TeamName, Division: info.team.Division,
        Tier: info.tier, RegID: g.RegID, MemberID: g.MemberID || '', FirstName: g.FirstName, LastName: g.LastName,
        Blurb: r.check.blurb, UpdatedAt: nowText_() });
    } catch (err) { console.error('Player to Watch: ' + info.team.TeamName + ' – ' + err.message); }
  });
  const keep = readAll_('Watch').filter(function (r) { return r.EventID !== ev.id; });
  rewriteTable_('Watch', keep.concat(rows));
  data.WatchRead = isoUtc_(new Date());
  update_('EventData', data);
  return out;
}

function watchEmail_(ev, data, ctx, r, reminder) {
  const t = r.info.team;
  managerEmails_(t).forEach(function (to) {
    if (reminder) {
      sendMail_(to, 'Reminder: pick your Player to Watch – ' + t.TeamName + ' – ' + ev.name,
        'Who’s your Player to Watch?',
        ['Hi Coach,', t.TeamName + ' (' + t.Division + ') hasn’t picked a Player to Watch for ' + ev.name + ' yet. ' +
          'It takes a minute: one player from the dropdown and one line about them.',
         'Picks lock on ' + watchLockText_(ev) + ' – right when players are traveling and on their phones.'],
        'Pick your player', r.url, logoForEmail_(data));
    } else {
      sendMail_(to, 'Pick your Player to Watch: ' + t.TeamName + ' (' + t.Division + ') – ' + ev.name,
        'Who’s your Player to Watch?',
        ['Hi Coach,',
         'Before ' + ev.name + ', every team picks one Player to Watch. We feature them on the ' + (ev.league ? 'league' : 'tournament') + ' page at ' +
           'stats.usboxla.com and on USBOXLA’s Instagram in the days before the ' + (ev.league ? 'season' : 'event') + '.',
         'Open the "' + watchTabName_(r.info, ctx) + '" tab in your roster sheet, choose a player from the dropdown and add ' +
           'one line about them (' + WATCH_BLURB_MAX + ' characters max) – e.g. “Lefty sniper – led the team in goals last season”.',
         'Only players with a public USBOXLA player profile are in the list.',
         'Picks lock on ' + watchLockText_(ev) + '.'],
        'Pick your player', r.url, logoForEmail_(data));
    }
  });
}

function openWatch_(ev, data, ctx, send) {
  data.WatchStage = 'open';
  data.WatchOpened = ctx.today;
  update_('EventData', data);
  const res = collectWatch_(ev, data, ctx, {});
  if (send) res.forEach(function (r) { if (r.info.labels.length) watchEmail_(ev, data, ctx, r, false); });
  return res;
}

function remindWatch_(ev, data, ctx) {
  const res = collectWatch_(ev, data, ctx, {});
  res.forEach(function (r) { if (!r.check.reg && r.info.labels.length) watchEmail_(ev, data, ctx, r, true); });
  data.WatchStage = 'reminded';
  update_('EventData', data);
}

function closeWatch_(ev, data, ctx) {
  collectWatch_(ev, data, ctx, { lock: true });
  data.WatchStage = 'closed';
  data.WatchClosed = nowText_();   // the "you're a Player to Watch" emails go out about an hour after this (Mail.gs)
  update_('EventData', data);
  console.log('Players to Watch locked for ' + ev.name + '.');
}

/** dailyJobs: opens picks 7 days before an event and reminds 4 days out (only when WATCH_LIVE). */
function watchDaily_(ctx) {
  if (!WATCH_LIVE) return;
  readEventsTab_().forEach(function (ev) {
    if (!ev.id || !premiumEvent_(ev) || !ev.start || ev.start <= ctx.today) return;   // Tier 3 events have no Players to Watch
    const data = ctx.eventData.filter(function (d) { return d.EventID === ev.id; })[0];
    if (!data) return;
    const daysOut = daysBetween_(ctx.today, ev.start);
    if (daysOut > WATCH_OPEN_DAYS || easternNow_() >= watchLockAt_(ev)) return;
    try {
      const stage = data.WatchStage || '';
      if (!stage) openWatch_(ev, data, ctx, true);
      else if (stage === 'open' && daysOut <= WATCH_REMIND_DAYS && daysBetween_(data.WatchOpened, ctx.today) >= 2) remindWatch_(ev, data, ctx);
    } catch (err) { console.error('Player to Watch ' + ev.name + ': ' + err.message); }
  });
}

/** scanAll (events not yet finished): re-reads picks when a roster sheet changed; locks 2 days out at 8am Eastern. */
function watchScan_(ev, data, ctx) {
  if (data.WatchStage !== 'open' && data.WatchStage !== 'reminded') return;
  if (easternNow_() >= watchLockAt_(ev)) { closeWatch_(ev, data, ctx); return; }
  const since = data.WatchRead ? new Date(data.WatchRead + 'Z') : new Date(0);
  const q = "modifiedDate > '" + isoUtc_(new Date(since.getTime() - 5 * 60 * 1000)) + "'";
  if (DriveApp.getFolderById(data.RostersFolderID).searchFiles(q).hasNext()) collectWatch_(ev, data, ctx, {});
}

function watchNote_(data) {
  return data.WatchStage === 'open' || data.WatchStage === 'reminded' ? ' · ⭐ Player to Watch picks open'
    : data.WatchStage === 'closed' ? ' · ⭐ Players to Watch set' : '';
}

/**
 * {eventId: [{division, tier, team, slug, blurb}]} for locked events. Only players who still have a public
 * profile are listed (the slug is the link to it); nothing else about the player is public.
 */
function publicWatch_(profiles) {
  const closed = {};
  readAll_('EventData').forEach(function (d) { if (d.WatchStage === 'closed') closed[d.EventID] = true; });
  const slugOf = {};
  profiles.forEach(function (p) { if (p.memberId) slugOf[p.memberId] = p.slug; });
  const out = {};
  readAll_('Watch').forEach(function (w) {
    const slug = w.MemberID && slugOf[w.MemberID];
    if (!closed[w.EventID] || !slug) return;
    (out[w.EventID] = out[w.EventID] || []).push({ division: w.Division, tier: w.Tier || '', team: w.TeamName, slug: slug, blurb: w.Blurb || '' });
  });
  return out;
}

// ---------- admin tools ----------

function watchEvent_(match) {
  const ev = readEventsTab_().filter(function (e) { return e.id && e.name.indexOf(match || 'Border Wars') !== -1; })[0];
  if (!ev) { console.log('No event matches ' + (match || 'Border Wars')); return null; }
  const ctx = loadCtx_();
  return { ev: ev, ctx: ctx, data: ctx.eventData.filter(function (d) { return d.EventID === ev.id; })[0] };
}

/** Admin tool: opens Player to Watch picks now (no emails unless send=true). */
function openPlayerToWatchNow(match, send) {
  const w = watchEvent_(match); if (!w) return;
  const res = openWatch_(w.ev, w.data, w.ctx, !!send);
  res.forEach(function (r) {
    console.log(r.info.group + ' · ' + r.info.team.TeamName + ' · ' + r.info.labels.length + ' player(s) with a public profile · ' +
      r.check.status + '\n   tab: ' + r.url);
  });
  console.log('Opened Player to Watch picks for ' + w.ev.name + (send ? ' and emailed managers.' : ' (no emails sent).') +
    ' Picks lock ' + watchLockText_(w.ev) + '.');
}

/** Admin tool: locks Player to Watch picks now (they go public on the next feed refresh). */
function lockPlayerToWatchNow(match) {
  const w = watchEvent_(match); if (!w) return;
  closeWatch_(w.ev, w.data, w.ctx);
  console.log('Tournament page: https://stats.usboxla.com/watch.php?e=' + w.ev.id);
}

/** Admin tool: undoes a test run – removes the Player to Watch tabs and saved picks for the event. */
function resetPlayerToWatch(match) {
  const w = watchEvent_(match); if (!w) return;
  w.ctx.teams.filter(function (t) { return t.EventID === w.ev.id; }).forEach(function (t) {
    try {
      const ss = SpreadsheetApp.openById(t.RosterSheetID);
      ss.getSheets().filter(function (s) { return s.getName().indexOf(WATCH_TAB) === 0; }).forEach(function (s) { ss.deleteSheet(s); });
    } catch (err) { console.error(err); }
  });
  rewriteTable_('Watch', readAll_('Watch').filter(function (r) { return r.EventID !== w.ev.id; }));
  w.data.WatchStage = ''; w.data.WatchOpened = ''; w.data.WatchRead = '';
  update_('EventData', w.data);
  console.log('Player to Watch reset for ' + w.ev.name + '.');
}

/** Players to Watch teams may not have played yet: stat-line-shaped rows so their logos are found in that event's Logos folder. */
function watchLogoLines_() {
  const start = {};
  readEventsTab_().forEach(function (e) { if (e.id) start[e.id] = e.start || ''; });
  return readAll_('Watch').map(function (w) { return { EventID: w.EventID, TeamName: w.TeamName, GameDate: start[w.EventID] || '' }; });
}

// ======================= champion team photos =======================
//
// Each event gets a "Champion Photos" folder (shared with the director) with one folder per division and
// "1 Gold", "2 Silver", "3 Bronze" inside. The Director Sheet's "Champion Photos" tab links to each one and
// ticks off what's uploaded. When a photo lands, the medal team comes from the Final Places and the stats
// site draws an Instagram graphic (stats.usboxla.com/champcard.php), which is copied to the social media drive.
// On the event's last day at 7pm the director is reminded about any division still missing its gold photo.

const CHAMP_TAB = 'Champion Photos';
const CHAMP_MEDALS = [['gold', 1, '1 Gold'], ['silver', 2, '2 Silver'], ['bronze', 3, '3 Bronze']];
const CHAMP_DAYS_AFTER = 14;          // photos are picked up this long after the event
const CHAMP_REMIND_HOUR = 19;

function champGroups_(ev, ctx) {
  const seen = {};
  ctx.teams.filter(function (t) { return t.EventID === ev.id; }).forEach(function (t) {
    seen[(t.Division + (t.Tier ? ' ' + t.Tier : '')).trim()] = true;
  });
  return Object.keys(seen).sort();
}

/** Runs hourly (from profileEmailsHourly): folders, the Director Sheet tab, new photos, the reminder. */
function champHourly_(ctx) {
  const hour = Number(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'H'));
  readEventsTab_().forEach(function (ev) {
    if (!ev.id || !ev.start || ev.start > ctx.today || daysBetween_(ev.end, ctx.today) > CHAMP_DAYS_AFTER) return;
    if (ev.end < PROFILE_MAIL_FROM) return;
    const data = ctx.eventData.filter(function (d) { return d.EventID === ev.id; })[0];
    if (!data || !data.DirectorSheetID || !data.FolderID) return;
    try {
      const groups = champGroups_(ev, ctx);
      if (!groups.length) return;
      const folders = champFolders_(ev, data, groups);
      const found = champScan_(ev, data, ctx, groups, folders);
      champSheet_(data, groups, folders, found);
      if (ctx.today === ev.end && hour >= CHAMP_REMIND_HOUR && !data.ChampReminded) {
        const missing = groups.filter(function (g) { return !found[g + '|gold']; });
        if (missing.length && ev.directorEmail) champReminder_(ev, data, missing);
        data.ChampReminded = nowText_();
        update_('EventData', data);
      }
    } catch (err) { console.error('Champion photos ' + ev.name + ': ' + err.message); }
  });
}

/** {group: {gold: Folder, silver: Folder, bronze: Folder}}, creating whatever is missing. */
function champFolders_(ev, data, groups) {
  let root = null;
  if (data.ChampFolderID) { try { root = DriveApp.getFolderById(data.ChampFolderID); } catch (err) { root = null; } }
  if (!root) {
    root = DriveApp.getFolderById(data.FolderID).createFolder('Champion Photos');
    if (ev.directorEmail) { try { root.addEditor(ev.directorEmail); } catch (err) { console.error(err); } }
    data.ChampFolderID = root.getId();
    update_('EventData', data);
  }
  const out = {};
  groups.forEach(function (g) {
    const gf = childFolder_(root, g.replace(/\//g, '-'));
    out[g] = {};
    CHAMP_MEDALS.forEach(function (m) { out[g][m[0]] = childFolder_(gf, m[2]); });
  });
  return out;
}

/** Newest photo in each medal folder → the Champions table. Returns {group|medal: row}. */
function champScan_(ev, data, ctx, groups, folders) {
  const rows = readAll_('Champions');
  const mine = {};
  rows.forEach(function (r) { if (r.EventID === ev.id) mine[r.Group + '|' + r.Medal] = r; });
  let places = null;
  const teamFor = function (group, place) {
    if (!places) {
      places = {};
      try {
        awardTeams_(ev, data, ctx, false).forEach(function (x) { if (x.place) places[x.group.trim() + '|' + x.place] = x.team.TeamName; });
      } catch (err) { console.error('Champion photos – places: ' + err.message); }
    }
    return places[group + '|' + place] || '';
  };
  const found = {};
  groups.forEach(function (g) {
    CHAMP_MEDALS.forEach(function (m) {
      let newest = null;
      const it = folders[g][m[0]].getFiles();
      while (it.hasNext()) {
        const f = it.next();
        if (!/^image\//.test(f.getMimeType())) continue;
        if (!newest || f.getLastUpdated() > newest.getLastUpdated()) newest = f;
      }
      const key = g + '|' + m[0];
      const prev = mine[key];
      if (!newest) return;
      const ver = shortHash_(newest.getId() + '|' + newest.getLastUpdated().getTime());
      const team = teamFor(g, m[1]) || (prev && prev.TeamName) || '';
      found[key] = { team: team };
      if (prev && prev.Ver === ver && prev.TeamName === team) return;
      const row = { EventID: ev.id, Group: g, Medal: m[0], TeamName: team, FileID: newest.getId(), Ver: ver, UpdatedAt: nowText_() };
      if (prev) { row._row = prev._row; update_('Champions', row); } else insert_('Champions', row);
    });
  });
  return found;
}

/** The Director Sheet tab: one row per division, a link per medal folder, ✓ once a photo is in. */
function champSheet_(data, groups, folders, found) {
  const ss = SpreadsheetApp.openById(data.DirectorSheetID);
  let sh = ss.getSheetByName(CHAMP_TAB);
  if (!sh) {
    sh = ss.insertSheet(CHAMP_TAB, ss.getSheets().length);
    sh.getRange(1, 1).setValue('After each final, drop the medal team’s photo into the matching folder (tap the link). ' +
      'Landscape team photos work best. USBOXLA turns each one into an Instagram graphic.').setFontWeight('bold').setWrap(true);
    sh.getRange(1, 1, 1, 4).merge();
    sh.setRowHeight(1, 48);
    sh.getRange(2, 1, 1, 4).setValues([['Division', '🥇 Gold', '🥈 Silver', '🥉 Bronze']]).setFontWeight('bold').setBackground('#0A1D3F').setFontColor('#FFFFFF');
    sh.setColumnWidth(1, 160); [2, 3, 4].forEach(function (c) { sh.setColumnWidth(c, 170); });
    sh.setFrozenRows(2);
  }
  const values = groups.map(function (g) {
    return [g].concat(CHAMP_MEDALS.map(function (m) {
      const f = found[g + '|' + m[0]];
      return linkFormula_(folders[g][m[0]].getUrl(), f ? '✓ Uploaded' + (f.team ? ' – ' + f.team.replace(/"/g, '') : '') : 'Upload photo');
    }));
  });
  writeIfChanged_(sh.getRange(3, 1, values.length, 4), values);
}

function champReminder_(ev, data, missing) {
  const ss = 'https://docs.google.com/spreadsheets/d/' + data.DirectorSheetID + '/edit#gid=' +
    SpreadsheetApp.openById(data.DirectorSheetID).getSheetByName(CHAMP_TAB).getSheetId();
  sendMail_(ev.directorEmail, 'Champion photos for the ' + ev.name + ' – ' + missing.length + ' division' + (missing.length > 1 ? 's' : '') + ' to go',
    ev.name + ': champion photos',
    ['Hi' + (ev.directorName ? ' ' + ev.directorName : '') + ',',
     'Thanks for a great event! We don’t have a champion team photo yet for: ' + missing.join(', ') + '.',
     'Open the "Champion Photos" tab in your Director Sheet and drop each photo into the Gold folder for that division ' +
       '(silver and bronze photos are welcome too). USBOXLA turns each one into an Instagram graphic for the team.'],
    'Open Champion Photos', ss, logoForEmail_(data));
}

/** {eventId: [{division, medal, team, v}]} – champion photos that are in. */
function publicChamps_() {
  const out = {};
  readAll_('Champions').forEach(function (r) {
    if (!r.FileID || !r.TeamName) return;
    (out[r.EventID] = out[r.EventID] || []).push({ division: r.Group, medal: r.Medal, team: r.TeamName, v: r.Ver });
  });
  return out;
}

/** ?api=champphoto&e=EVENT&d=DIVISION&m=gold – the photo itself (at most 2000px). */
function publicChampPhoto_(eventId, group, medal) {
  const r = readAll_('Champions').filter(function (x) { return x.EventID === eventId && x.Group === group && x.Medal === medal && x.FileID; })[0];
  if (!r) return { error: 'not found' };
  const file = DriveApp.getFileById(r.FileID);
  let blob = file.getSize() <= 1500000 ? file.getBlob() : driveImage_(file, 2000);
  if (!blob) blob = file.getThumbnail();
  const mime = String(blob.getContentType() || '');
  if (!/^image\/(jpeg|png|gif|webp)$/i.test(mime)) return { error: 'not an image' };
  return { v: r.Ver, mime: mime, b64: Utilities.base64Encode(blob.getBytes()) };
}
