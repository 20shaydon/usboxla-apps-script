/**
 * RosterFeed.gs – Resolute's restricted LeagueApps roster feed (Ohio leagues).
 * The bearer token lives in Script Properties as RESOLUTE_FEED_TOKEN (never in a sheet or in code).
 */
var ROSTER_FEED_URL = 'https://resolute.frontoffice.club/api/partner/v1/rosters';

/** GET the feed; returns parsed JSON or throws with the status. Never logs the token. */
function rosterFeedGet_(programId) {
  var token = PropertiesService.getScriptProperties().getProperty('RESOLUTE_FEED_TOKEN');
  if (!token) throw new Error('RESOLUTE_FEED_TOKEN is not set in Script Properties');
  token = token.replace(/^\s*bearer\s+/i, '').trim();
  var url = ROSTER_FEED_URL + (programId ? '?programId=' + encodeURIComponent(programId) : '');
  var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
  if (r.getResponseCode() !== 200) throw new Error('Roster feed ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 200));
  return JSON.parse(r.getContentText());
}

/**
 * Admin test: shows the feed's shape without any player data. Prints each field's path, how many
 * records have it filled in, and each program's id, name and syncedAt. Reads only; writes nothing.
 */
function rosterFeedTest() {
  var data = rosterFeedGet_();
  var seen = {};
  function walk(v, path) {
    if (Array.isArray(v)) { v.forEach(function (x) { walk(x, path + '[]'); }); return; }
    if (v && typeof v === 'object') { Object.keys(v).forEach(function (k) { walk(v[k], path ? path + '.' + k : k); }); return; }
    var s = seen[path] || (seen[path] = { total: 0, filled: 0, types: {} });
    s.total++;
    if (v !== null && v !== '' && v !== undefined) s.filled++;
    s.types[v === null ? 'null' : typeof v] = true;
  }
  walk(data, '');
  console.log('Fields (filled / total):');
  Object.keys(seen).sort().forEach(function (p) {
    console.log(p + ' – ' + seen[p].filled + ' / ' + seen[p].total + ' (' + Object.keys(seen[p].types).join(',') + ')');
  });
  var programs = Array.isArray(data) ? data : (data.programs || data.data || []);
  console.log('Programs: ' + programs.length);
  programs.forEach(function (p) {
    var summary = {};
    Object.keys(p).forEach(function (k) {
      var v = p[k];
      if (Array.isArray(v)) summary[k] = v.length + ' items';
      else if (v === null || typeof v !== 'object') summary[k] = v;
    });
    console.log(JSON.stringify(summary).slice(0, 400));
  });
}

/** Admin test: team names and counts per program, with no player data. Reads only; writes nothing. */
function rosterFeedTeams() {
  rosterFeedGet_().programs.forEach(function (p) {
    var teams = {}, offerings = {}, waitlist = 0, dob = 0, parent = 0, coach = 0;
    p.players.forEach(function (x) {
      teams[x.team] = (teams[x.team] || 0) + 1;
      offerings[x.offering] = (offerings[x.offering] || 0) + 1;
      if (x.waitlist) waitlist++;
      if (x.birthDate) dob++;
      if (x.parentEmail) parent++;
      if (x.coachEmail) coach++;
    });
    console.log(p.programId + ' ' + p.programName + ': ' + p.players.length + ' players, waitlist ' + waitlist + ', birth dates ' + dob + ', parent emails ' + parent + ', coach emails ' + coach + ', synced ' + p.syncedAt);
    console.log('  Teams: ' + JSON.stringify(teams));
    console.log('  Offerings: ' + JSON.stringify(offerings));
  });
}
