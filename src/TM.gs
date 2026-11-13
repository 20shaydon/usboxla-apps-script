/**
 * Tourney Machine (SportsEngine Tourney) – read-only public API.
 * The token lives in Script Properties as TM_API_TOKEN (expires Oct 6, 2027; Tourney Machine issues a new one).
 * Rate limit: 500 requests per 10 seconds. A tournament can only be read once it's published.
 *
 * Hub › Events tab › "Tourney Machine ID" (column M): paste the tournament's ID or its Tourney Machine link.
 * Every scan then adds that tournament's teams to the event's Director Sheet (right division, manager
 * email left for the director). For a two-site event, divisions ending in ON / NY go to the event in that
 * state; the state comes from the usboxla.com listing, or type it after the ID (e.g. "h2026…941 NY").
 */

const TM_BASE = 'https://api.tourneymachine.com/public/v1';
const TM_COL = 13; // Hub › Events tab column M
const TM_HEADER = 'Tourney Machine ID';

function tmToken_() {
  const t = PropertiesService.getScriptProperties().getProperty('TM_API_TOKEN');
  if (!t) throw new Error('Add TM_API_TOKEN in Project Settings → Script Properties.');
  return t.trim();
}

function tmGet_(path) {
  const res = UrlFetchApp.fetch(TM_BASE + path, {
    headers: { Authorization: 'Bearer ' + tmToken_(), Accept: 'application/json' },
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code !== 200) {
    const err = new Error('Tourney Machine returned ' + code + ' for ' + path + ': ' + res.getContentText().slice(0, 300));
    err.code = code;
    throw err;
  }
  return JSON.parse(res.getContentText());
}

/** The Tourney Machine account the token belongs to (read from the token itself; not secret). */
function tmAccountId_() {
  let part = tmToken_().split('.')[1] || '';
  while (part.length % 4) part += '=';
  const payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(part)).getDataAsString());
  return payload.Account;
}

// ======================= Hub column + team sync =======================

/** "h2026…941", a Tourney Machine link containing it, optionally followed by a site (NY / ON …). */
function parseTmCell_(v) {
  const s = String(v || '').trim();
  const id = (s.match(/h\d{8,}[0-9a-f]+/i) || [''])[0];
  const after = id ? s.slice(s.indexOf(id) + id.length) : '';
  const site = (after.match(/\b([A-Za-z]{2})\b\s*$/) || ['', ''])[1].toUpperCase();
  return { id: id, site: site };
}

/** Adds the "Tourney Machine ID" column to the Hub's Events tab if it isn't there yet. */
function ensureTmColumn_(sh) {
  if (sh.getMaxColumns() < TM_COL) sh.insertColumnsAfter(sh.getMaxColumns(), TM_COL - sh.getMaxColumns());
  const head = sh.getRange(1, TM_COL);
  if (String(head.getValue()) === TM_HEADER) return;
  head.setValue(TM_HEADER).setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff')
    .setNote('Optional. Paste the Tourney Machine tournament ID or link – its teams are added to the ' +
      'Director Sheet automatically. Two-site event? Divisions ending in ON / NY go to the matching event.');
  sh.setColumnWidth(TM_COL, 260);
}

/** State (NY, ON …) for an event: typed after the ID, else from the usboxla.com listing. */
function tmEventSite_(ev) {
  if (ev.tmSite) return ev.tmSite;
  const rec = readImports_().filter(function (r) {
    return norm_(r.Name) === norm_(ev.name) && r.StartDate === ev.start;
  })[0];
  return rec ? String(rec.State || '').trim().toUpperCase() : '';
}

/**
 * Adds the tournament's teams to the Director Sheet. Each Tourney Machine team is added once
 * (remembered in the hidden TMTeams tab), so a row the director deletes doesn't come back.
 * Returns a short note for the Hub status, or '' when all is well.
 */
function syncTmTeams_(ev, data, ctx) {
  if (!ev.tmId) return '';
  ctx.tm = ctx.tm || {};
  let t = ctx.tm[ev.tmId];
  if (!t) {
    try {
      t = ctx.tm[ev.tmId] = tmGet_('/Tournaments/' + encodeURIComponent(ev.tmId) + '/false');
    } catch (err) {
      console.error(err);
      return err.code === 403 || err.code === 404
        ? 'Tourney Machine: not published yet, or wrong ID'
        : 'Tourney Machine: couldn’t reach it (will retry)';
    }
  }
  const divs = t.divisionDictionary || {};
  const teams = t.teamDictionary || {};
  const site = tmEventSite_(ev);
  // A two-site tournament needs to know which site this event is, or it would mix both sites' teams.
  if (!site && Object.keys(divs).some(function (k) { return tmStandardDivision_(divs[k].name).site; })) {
    return 'Tourney Machine: two-site tournament – type NY or ON after the ID in column M';
  }

  const seen = {};
  readAll_('TMTeams').forEach(function (r) { if (r.EventID === data.EventID) seen[r.TMTeamID] = true; });

  const sh = teamsSheet_(data);
  const last = sh.getLastRow();
  const sheetRows = [];   // {row, key, tier}
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, SKILL_COL).getValues().forEach(function (r, i) {
      if (!clean_(r[0], 80)) return;
      sheetRows.push({ row: i + 2, key: divKey_(canonDivision_(clean_(r[1], 30))) + '|' + norm_(r[0]), tier: skillLevel_(r[SKILL_COL - 1]) });
    });
  }
  const YELLOW = '#FFF2B3';
  const rows = [];
  let unmapped = 0, unmatched = 0, mismatched = 0;
  Object.keys(teams).forEach(function (tid) {
    const team = teams[tid];
    const map = tmStandardDivision_((divs[team.idDivision] || {}).name);
    if (map.site && map.site !== site) return; // the other site's team
    if (!map.division || ev.divisions.indexOf(map.division) === -1) { unmapped++; return; }
    const name = clean_(team.name, 80);
    if (!name) return;
    const key = divKey_(map.division) + '|' + norm_(name);
    const same = sheetRows.filter(function (r) { return r.key === key; });
    const hit = same.filter(function (r) { return map.tier && r.tier === map.tier; })[0] ||
      same.filter(function (r) { return !r.tier; })[0] || (same.length === 1 ? same[0] : null);
    if (hit) {
      const cell = sh.getRange(hit.row, SKILL_COL);
      if (!hit.tier && map.tier) {               // blank skill level: take Tourney Machine's
        cell.setValue(map.tier).setNote('Skill level from Tourney Machine.');
        hit.tier = map.tier;
      } else if (hit.tier && map.tier && hit.tier !== map.tier) {
        mismatched++;
        cell.setBackground(YELLOW).setNote('Tourney Machine has this team in ' + map.tier + '. Check which is right – ' +
          'the skill level decides the All-Star picks.');
      } else if (String(cell.getNote()).indexOf('Tourney Machine has this team') === 0) {
        cell.setBackground(null).setNote('');      // fixed since the last scan
      }
      if (!seen[tid]) {
        insert_('TMTeams', { EventID: data.EventID, TMTeamID: tid, TeamName: name, Division: map.division, Added: nowText_() });
        seen[tid] = true;
      }
      return;
    }
    if (seen[tid]) { unmatched++; return; }   // added before (or deleted by the director): never re-added
    insert_('TMTeams', { EventID: data.EventID, TMTeamID: tid, TeamName: name, Division: map.division, Added: nowText_() });
    seen[tid] = true;
    unmatched++;
    sheetRows.push({ row: -1, key: key, tier: map.tier });
    rows.push([name, map.division, map.tier, '', '']);
  });
  if (rows.length) {
    const start = Math.max(sh.getLastRow(), 1) + 1;
    if (sh.getMaxRows() < start + rows.length - 1) sh.insertRowsAfter(sh.getMaxRows(), start + rows.length - 1 - sh.getMaxRows());
    sh.getRange(start, 1, rows.length, 5).setValues(rows);
    sh.getRange(start, 1, rows.length, 2).setBackground(YELLOW);
    sh.getRange(start, 1, rows.length, 1).setNote('Added from Tourney Machine – no team on this sheet matched this name. ' +
      'If it\u2019s the same team as one above, make the names match and delete this row; ' +
      'otherwise add the manager\u2019s name and email.');
    console.log(ev.name + ': added ' + rows.length + ' team(s) from Tourney Machine.');
  }
  const notes = [];
  if (unmatched) notes.push(unmatched + ' team name(s) don\u2019t match the Director Sheet (yellow rows)');
  if (mismatched) notes.push(mismatched + ' skill level(s) differ from Tourney Machine (yellow cells)');
  if (unmapped) notes.push(unmapped + ' team(s) in a division that isn\u2019t on this event');
  return notes.length ? 'Tourney Machine: ' + notes.join('; ') : '';
}

// ======================= divisions =======================

/**
 * Maps a Tourney Machine division name to USBOXLA's standard division.
 * The birth years are the division, written oldest first (2028/2027 → 2027/2028). A / AA tiers are
 * ignored (tournament directors split teams into tiers in Tourney Machine; teams don't register
 * as A or AA). A trailing ON / NY says which site of a two-site event the division belongs to.
 * Returns { division: '2027/2028' or '' if no match, tier: 'AA' | 'A' | '', site: 'ON' | 'NY' | '' }.
 */
function tmStandardDivision_(tmName) {
  const s = String(tmName || '').toUpperCase().replace(/['’]/g, '');
  const girls = /GIRL/.test(s);
  const yrs = (s.match(/20\d\d/g) || []).map(Number);
  const tier = /\bAA\b/.test(s) ? 'AA' : /\bA\b/.test(s) && !/HS\s*A\b/.test(s) ? 'A' : '';
  const site = /\bON\b/.test(s) ? 'ON' : /\bNY\b/.test(s) ? 'NY' : '';
  let division = '';
  if (yrs.length === 2) {
    const c = (girls ? 'GIRLS ' : '') + Math.min(yrs[0], yrs[1]) + '/' + Math.max(yrs[0], yrs[1]);
    if (SANCTIONED_DIVISIONS.indexOf(c) >= 0) division = c;
  } else if (girls && /HS\s*A\b/.test(s)) division = 'GIRLS HS A';
  else if (girls && /HS\s*B\b/.test(s)) division = 'GIRLS HS B';
  return { division: division, tier: tier, site: site };
}

// ======================= tools to run by hand =======================

/** Lists the tournaments the token can read. */
function tmListMyTournaments() {
  const data = tmGet_('/Tournaments/account/' + encodeURIComponent(tmAccountId_()));
  const list = Array.isArray(data) ? data : (data && (data.tournaments || data.Tournaments || data.items)) || [];
  console.log('Tournaments on this account: ' + list.length);
  list.forEach(function (t) {
    console.log([t.idTournament, t.name, t.startDate, t.endDate, t.status].join(' | '));
  });
}

/** Shows how every live event's Tourney Machine divisions map (division · tier · site). */
function tmDivisionMap() {
  readEventsTab_().filter(function (ev) { return ev.tmId; }).forEach(function (ev) {
    const t = tmGet_('/Tournaments/' + encodeURIComponent(ev.tmId) + '/false');
    const divs = t.divisionDictionary || {};
    console.log('== ' + ev.name + ' (site ' + (tmEventSite_(ev) || 'any') + ')');
    Object.keys(divs).forEach(function (k) {
      const r = tmStandardDivision_(divs[k].name);
      console.log('MAP ' + divs[k].name + ' → ' + (r.division || '✗ NO MATCH') + (r.tier ? ' · tier ' + r.tier : '') + (r.site ? ' · site ' + r.site : ''));
    });
  });
}

/** Logs a tournament's divisions, rinks and games (team names only). */
function tmSchedule(id) {
  id = id || (readEventsTab_().filter(function (ev) { return ev.tmId; })[0] || {}).tmId;
  const t = tmGet_('/Tournaments/' + encodeURIComponent(id) + '/false');
  console.log('NAME ' + t.name + ' | ' + t.displayDate + ' | ' + t.displayLocation);
  const divs = t.divisionDictionary || {}, facs = t.facilityDictionary || {};
  Object.keys(facs).forEach(function (k) { console.log('RINK ' + facs[k].name); });
  const games = t.gameDictionary || {};
  Object.keys(games).forEach(function (k) {
    const g = games[k];
    console.log('GAME ' + g.gn + ' | ' + g.s + ' | ' + ((facs[g.idf] || {}).name || '') + ' | ' + (g.t1 || '?') + ' vs ' + (g.t2 || '?'));
  });
}
