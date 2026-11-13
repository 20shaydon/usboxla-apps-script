/**
 * Ohio High School Box Lacrosse league (Resolute): LeagueApps import.
 * The key lives in Script Properties as LA_API_KEY (never in a sheet).
 */
var LA_SITE_ID = 20088;
var LA_BASE = 'https://public.leagueapps.io/v1/sites/' + LA_SITE_ID;
var LA_PROGRAMS = { 'CinDay OHBLL': 5179295, 'Winter Box Columbus': 5121486 };

/** GET a LeagueApps public endpoint; returns parsed JSON or throws with the status. */
function laGet_(path) {
  var key = PropertiesService.getScriptProperties().getProperty('LA_API_KEY');
  if (!key) throw new Error('LA_API_KEY is not set in Script Properties');
  var url = LA_BASE + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'x-api-key=' + encodeURIComponent(key);
  var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'x-api-key': key } });
  if (r.getResponseCode() !== 200) throw new Error('LeagueApps ' + r.getResponseCode() + ' for ' + path + ': ' + r.getContentText().slice(0, 200));
  return JSON.parse(r.getContentText());
}

/** Admin test: checks the key works and shows what the league's schedule data looks like. */
function laTest() {
  var progs = laGet_('/programs/current');
  var mine = progs.filter(function (p) { return /OHBLL|Winter Box|CinDay/i.test(p.name) || [5179295, 5179296, 5121486, 5121487, 5121488, 5175282, 5180939].indexOf(Number(p.programId)) >= 0; });
  console.log('League programs found: ' + mine.length + ' of ' + progs.length);
  mine.forEach(function (p) { console.log(JSON.stringify(p).slice(0, 700)); });
  [5179295, 5179296, 5121486, 5121487, 5121488, 5175282].forEach(function (id) {
    try {
      var s = laGet_('/programs/' + id + '/schedule');
      var games = s.games || [];
      console.log(id + ': keys ' + JSON.stringify(Object.keys(s)) + ', games ' + games.length);
      if (games.length) console.log('Sample game: ' + JSON.stringify(games[0]).slice(0, 1500));
    } catch (err) { console.log(id + ': ' + err.message.slice(0, 160)); }
  });
}

// ======================= Leagues on the Hub =======================
// Hub › Events tab › column Q "Type": Tournament (blank) or League. A league row runs the same Director Sheet,
// roster sheets and verification as a tournament, with league wording.

var TYPE_COL = 17;                 // Hub › Events tab column Q
var TYPE_HEADER = 'Type';

function ensureTypeColumn_(sh) {
  if (sh.getMaxColumns() < TYPE_COL) sh.insertColumnsAfter(sh.getMaxColumns(), TYPE_COL - sh.getMaxColumns());
  var head = sh.getRange(1, TYPE_COL);
  if (String(head.getValue()) === TYPE_HEADER) return;
  head.setValue(TYPE_HEADER).setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff')
    .setNote('Tournament (or blank) for a weekend event. League for a season league (e.g. Ohio High School Box Lacrosse): ' +
      'league wording in the director and manager emails, help and FAQ tabs.');
  sh.setColumnWidth(TYPE_COL, 110);
  sh.getRange(2, TYPE_COL, sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Tournament', 'League'], true).setAllowInvalid(false).build());
}

function isLeagueType_(v) { return /^league/i.test(String(v || '').trim()); }

function seasonRange_(ev) { return prettyRange_({ StartDate: ev.start, EndDate: ev.end }); }

/** Director Sheet › "How this works" for a league. */
function leagueDirectorHelp_(ev, logosUrl) {
  return [
    ev.name + ' – ' + seasonRange_(ev),
    '',
    '1. On the Teams tab, add one row per team: team name, division, manager name and manager email (leave Skill Level blank).',
    '   Spell team names exactly as they are in LeagueApps so the schedule, game sheets and awards line up.',
    '2. Within about 10 minutes, each manager is emailed their own Roster Sheet for that team.',
    '3. Managers paste in their players. Parents of anyone who isn\u2019t a USBOXLA member yet are emailed a link to register.',
    '4. Watch the Players and Verified columns fill in. Grey columns fill themselves – you can\u2019t edit them.',
    '5. Game nights: the GAME SHEET SYSTEM tab has your private link for the rink tablets.',
    '',
    'Logos: drop the league logo (name the file "logo") and each team\u2019s logo',
    '(name the file exactly like the team, e.g. "Upper Arlington") into the Logos folder:',
    logosUrl,
    'Once the league logo is in, a print-ready 36×48" step & repeat backdrop PDF and a how-to-order sheet appear there within the hour.',
    '',
    'Don\u2019t rename a team after adding it – add a new row instead.',
  ];
}

/** Roster Sheet › "How this works" for a league team. */
function leagueRosterHelp_(ev, teamName, division, logoFolderUrl) {
  return [
    teamName + ' (' + division + ') – ' + ev.name,
    '',
    '1. On your team\u2019s tab, type or paste one row per player: first name, last name, date of birth (MM/DD/YYYY), parent email.',
    ROSTER_HELP_JERSEY,
    '   (If you manage several teams in this league, each team has its own tab in this sheet.)',
    '   (Parent email is only needed for players who aren\u2019t already USBOXLA members.)',
    '2. Sit tight – within about 10 minutes, the grey columns fill in on their own:',
    '     ✅ Verified – the player has a current USBOXLA membership. Nothing else to do.',
    '     ⏳ Waiting on parent – the parent was emailed a link to register.',
    '     ⚠ – something in the row needs fixing (see the Note column).',
    '3. Parents get reminders before the season starts. Players who aren\u2019t verified can\u2019t play.',
    '',
    'To remove a player, delete their row. Grey columns are filled in by USBOXLA and can\u2019t be edited.',
    '',
    'Team logo: drop your team logo (PNG or JPG) into your team\u2019s logo folder. It appears on the parent',
    'registration page and on the official game sheet:',
    logoFolderUrl || '',
    '',
    'Step & repeat backdrop: once your logo is in that folder, a print-ready 36×48" backdrop PDF and a FedEx Office',
    'ordering cheat sheet appear there within the hour – great for a team media day.',
  ];
}

function emailLeagueDirector_(ev, data) {
  return sendMail_(ev.directorEmail, 'Set up your teams for ' + ev.name,
    ev.name + ': your Director Sheet',
    ['Hi' + (ev.directorName ? ' ' + ev.directorName.split(' ')[0] : '') + ',',
     'Your Director Sheet for ' + ev.name + ' (' + seasonRange_(ev) + ') is ready. Add one row per team with the ' +
     'team manager\u2019s name and email, and spell team names the same way as in LeagueApps. Each manager automatically ' +
     'gets a roster sheet for their team, and every player must be a verified USBOXLA member before they play.',
     'Drop the league logo and team logos into the Logos folder (also shared with you). They show on the page parents ' +
     'use to register, and the league logo also gets you a print-ready 36×48" step & repeat backdrop (PDF) in that folder.',
     'The "How this works" and "FAQ & Support" tabs in the sheet walk through the rest.'],
    'Open Director Sheet', 'https://docs.google.com/spreadsheets/d/' + data.DirectorSheetID, logoForEmail_(data));
}

function emailLeagueManager_(ev, team, managerName, email, data) {
  return sendMail_(email, team.TeamName + ' ' + team.Division + ' – your ' + ev.name + ' roster',
    team.TeamName + ' (' + team.Division + ') – ' + ev.name,
    ['Hi' + (managerName ? ' ' + managerName : '') + ',',
     'Your roster sheet is ready. Type or paste each player\u2019s first name, last name and date of birth. ' +
     'Players with a current USBOXLA membership are verified automatically. For anyone who isn\u2019t, add a ' +
     'parent\u2019s email and they\u2019ll get a link to register.',
     'The grey columns show who\u2019s done. Season: ' + seasonRange_(ev) + '. Every player must be verified before they play.',
     'If you manage more than one ' + team.TeamName + ' team in this league, they\u2019re all in this same sheet – one tab per division.',
     'Add your team logo: the "How this works" tab in your roster sheet has a link to your team\u2019s logo folder. ' +
     'Within the hour we\u2019ll add a print-ready 36×48" step & repeat backdrop with your logo to that folder – perfect for a team media day.',
     'You\u2019ll need to be signed in to a Google account to open the sheet.'],
    'Open roster sheet', rosterUrl_(team), logoForEmail_(data));
}

/** FAQ & Support for a league team manager: the manager FAQ with league wording. */
function faqLeagueManager_() {
  var swap = {
    'Q: When do parents get reminders?': ['Q: When do parents get reminders?', '14, 7, 5 and 3 days before the season starts, then a final reminder 2 days before.'],
    'Q: I manage more than one team at this event.': ['Q: I manage more than one team in this league.', 'Each team has its own tab in this sheet.'],
    'All-Star picks': ['All-League picks', 'After the last game of the season an \u201cAll-Star Picks\u201d tab appears here and you get an email. ' +
      'Pick your All-League players from the dropdowns of your verified players. Reminders follow for two days, then picks lock.'],
    'Schedule, divisions, anything about the event': ['Schedule, divisions, anything about the league', 'Your league director'],
  };
  return faqManager_().map(function (r) {
    if (swap[r[0]]) return swap[r[0]];
    return r.map(function (t) { return String(t).replace(/before the event/g, 'before the season').replace(/the event/g, 'the season'); });
  });
}

function faqLeagueDirector_() {
  return [
    ['# Quick start'],
    ['1. Teams tab: one row per team – Team Name, Division, Manager Name, Manager Email (leave Skill Level blank). Spell team names exactly as in LeagueApps.'],
    ['2. Within about 10 minutes each manager is emailed their own Roster Sheet.'],
    ['3. Watch the Players and Verified columns fill in. Grey columns fill themselves.'],
    ['4. Game nights: the GAME SHEET SYSTEM tab has your private tablet link, the setup steps and the rink PIN.'],
    ['# Before the season'],
    ['Players to Watch', 'Picks open 7 days before the season and lock 2 days before at 8am Eastern. Each team picks one player with a public USBOXLA profile.'],
    ['Q: A manager didn\u2019t get their roster sheet.', 'Check the Manager Email spelling on the Teams tab. The sheet is shared from player@usboxla.com, so ask them to check spam.'],
    ['Q: I added a team and nothing happened.', 'The system checks every 10 minutes. Sit tight and look at the Status column.'],
    ['Q: Can I rename a team?', 'Don\u2019t rename a team after adding it – add a new row instead.'],
    ['Q: Lots of players aren\u2019t verified.', 'Parents get reminders 14, 7, 5 and 3 days before the season starts and a final one 2 days before. Nudge managers whose Verified count is low. The Note column on their roster sheet says why a player isn\u2019t verified.'],
    ['Q: Where do logos go?', 'The league logo (file named \u201clogo\u201d) and team logos (named exactly like the team) go in the Logos folder (link on the \u201cHow this works\u201d tab).'],
    ['Q: Step & repeat backdrop?', 'Once the league logo is in the Logos folder, a print-ready 36×48" backdrop PDF (your logo + USBOXLA) and a \u201cHow to order\u201d cheat sheet appear there within the hour. Print it at FedEx Office (about $69). Each team gets its own in its team logo folder.'],
    ['# Game nights'],
    ['Q: How do I set up the tablets?', 'Open your link from the GAME SHEET SYSTEM tab on each rink tablet and pick the day and rink.'],
    ['Q: A tablet needs to move to another rink.', 'Use the rink PIN on the GAME SHEET SYSTEM tab.'],
    ['Q: A player shows up who isn\u2019t registered.', 'They can\u2019t play. Only verified players can be dressed on the tablet.'],
    ['Q: A game isn\u2019t played (forfeit, cancellation).', 'The scorekeeper taps \u201cGame not played\u201d on the tablet. You and the Referee-in-Chief are emailed.'],
    ['Q: A team drops out of the league.', 'Tick Forfeited on the Teams tab. Its games count 1–0 for the other teams, its stats are removed and it gets no All-League picks. Untick to undo.'],
    ['# End of the season'],
    ['Q: Final Place is wrong.', 'Fix it in the Final Place column as soon as picks open. It decides the medal teams and how many All-League picks each team gets.'],
    ['All-League picks', 'Managers pick the All-League teams, Honorable Mention and the division MVP after the last game of the season. Reminders go out over the next two days, then picks lock.'],
    ['Champion photos', 'Upload each medal team\u2019s photo from the Champion Photos tab. The champions graphic is made from it.'],
    ['Q: Referee pay.', 'The Referee Pay tab fills in as games are signed off. Tick Paid as you pay each referee.'],
    ['# Support'],
    ['Memberships and registration', 'membership@usboxla.com'],
    ['Referees, assigning and pay', 'Referee-in-Chief – a.gardner@usboxla.com'],
    ['Everything else', 'shaydon@usboxla.com'],
  ];
}

/** One-time: adds the two Ohio High School Box Lacrosse leagues to the Hub (skips any already there). */
function addOhioLeagues() {
  var sh = eventsSheet_();
  ensureStatsColumn_(sh); ensureRefPayColumn_(sh); ensureBoxPayColumn_(sh); ensureTypeColumn_(sh);
  var have = readEventsTab_().map(function (ev) { return ev.name; });
  var rows = [
    ['Winter Box Columbus 2026-27', new Date(2026, 10, 29), new Date(2027, 1, 4), 'Varsity, JV, Middle School'],
    ['CinDay OHBLL 2026-27', new Date(2026, 10, 22), new Date(2027, 1, 7), 'Varsity'],
  ];
  rows.forEach(function (r) {
    if (have.indexOf(r[0]) !== -1) { console.log('Already on the Hub: ' + r[0]); return; }
    var row = sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, 6).setValues([[r[0], r[1], r[2], r[3], 'Greg Bice', 'GregB@resolutelacrosse.com']]);
    sh.getRange(row, STATS_COL).setValue('Yes');
    sh.getRange(row, TYPE_COL).setValue('League');
    console.log('Added ' + r[0] + ' (row ' + row + ')');
  });
  console.log('The next scan (within 10 minutes) builds each Director Sheet and emails Greg.');
}

/** Admin: shows what the Hub built for the Ohio leagues (status, sharing, tabs). */
function checkOhioLeagues() {
  var data = readAll_('EventData');
  readEventsTab_().filter(function (ev) { return ev.league; }).forEach(function (ev) {
    var row = ev.sheet.getRange(ev.row, 1, 1, TYPE_COL).getDisplayValues()[0];
    console.log(ev.name + ' | ' + row.slice(1, 7).join(' | ') + ' | status: ' + row[6] + ' | id ' + ev.id + ' | type ' + row[TYPE_COL - 1]);
    var d = data.filter(function (x) { return x.EventID === ev.id; })[0];
    if (!d) { console.log('  no event files yet'); return; }
    var ss = SpreadsheetApp.openById(d.DirectorSheetID);
    console.log('  Director Sheet: ' + ss.getUrl());
    console.log('  Tabs: ' + ss.getSheets().map(function (s) { return s.getName(); }).join(', '));
    var faq = ss.getSheetByName(FAQ_TAB); if (faq) console.log('  FAQ title: ' + faq.getRange(1, 1).getValue());
    var help = ss.getSheetByName('How this works'); if (help) console.log('  Help line 3: ' + help.getRange(3, 1).getValue());
    console.log('  Shared with: ' + d.SharedWith + ' | editors: ' + ss.getEditors().map(function (u) { return u.getEmail(); }).join(', '));
  });
}


// ======================= Weekly league graphics =======================
/**
 * After each league night's last game, Top Performers and Final Scores for every division go into the
 * USBOXLA Social Media drive: "<yyyy-mm> <league>/Week 1 – Varsity/", with Captions.txt, and Dallas gets one email.
 *
 * Until the LeagueApps schedule import exists there is no list of "the last game", so each division has a
 * cutoff: its game day plus an hour in Eastern time. Late game sheets are picked up by the refresh and the
 * graphic in the folder is replaced, for LEAGUE_REFRESH_DAYS after the cutoff.
 *
 * Only players with a public USBOXLA profile are named. Anyone else shows as "<Team> player".
 * Runs on its own hourly trigger: installLeagueSocialTrigger(). It does not depend on PROFILE_EMAILS_LIVE.
 */
const LEAGUE_REFRESH_DAYS = 3;
const LEAGUE_POST_RULES = [                                 // first match wins; offset = days after that week's Monday
  { league: /columbus/i, division: /middle/i, offset: 6, hour: 20 },   // Columbus Middle School: Sunday 8pm
  { league: /columbus/i, division: /./, offset: 2, hour: 23 },         // Columbus Varsity and JV: Wednesday 11pm
  { league: /./, division: /./, offset: 6, hour: 16 },                 // CinDay: Sunday 4pm (games are 9am–3pm)
];

function leagueRule_(leagueName, division) {
  return LEAGUE_POST_RULES.filter(function (r) { return r.league.test(leagueName) && r.division.test(division); })[0];
}

/** Monday (yyyy-MM-dd) of the week holding this date. */
function leagueMonday_(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function leagueAddDays_(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "Nov 22", "Dec 1–2", "Nov 30–Dec 2". */
function leagueDates_(days) {
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const a = days[0], b = days[days.length - 1];
  const txt = function (s) { return M[Number(s.slice(5, 7)) - 1] + ' ' + Number(s.slice(8, 10)); };
  if (a === b) return txt(a);
  return a.slice(0, 7) === b.slice(0, 7) ? txt(a) + '–' + Number(b.slice(8, 10)) : txt(a) + '–' + txt(b);
}

/**
 * Pure. One entry per division per week that had a final game. Week numbers count weeks with games, per
 * division, so a holiday break doesn't skip a number.
 * docs = [{gid, doc}] final game sheets; lines = this league's StatLines; publicName(memberId) = name or ''.
 * dateOf(doc) = yyyy-MM-dd of the game.
 */
function leagueWeeksData_(leagueName, docs, lines, publicName, dateOf) {
  const byDiv = {};
  docs.forEach(function (d) {
    const doc = d.doc || {}, g = doc.game || {};
    if (!doc.final || !g.division) return;
    if (doc.notPlayed && doc.notPlayed.reason !== 'forfeit') return;
    const date = dateOf(doc); if (!date) return;
    const s = gameScore_(doc);
    const note = doc.notPlayed ? 'Forfeit' : doc.so ? 'SO' : (doc.events || []).some(function (e) { return e.period === 'OT'; }) ? 'OT' : '';
    const division = canonDivision_(g.division), monday = leagueMonday_(date);
    const wk = ((byDiv[division] = byDiv[division] || {})[monday] = byDiv[division][monday] || { days: {}, games: [] });
    wk.days[date] = true;
    wk.games.push({ date: date, home: g.home || '', away: g.away || '', hs: s.home, as: s.away, note: note });
  });
  const out = [];
  Object.keys(byDiv).forEach(function (division) {
    Object.keys(byDiv[division]).sort().forEach(function (monday, i) {
      const wk = byDiv[division][monday], rule = leagueRule_(leagueName, division);
      const stats = {};
      lines.forEach(function (l) {
        if (canonDivision_(l.Division) !== division || leagueMonday_(String(l.GameDate || '1970-01-05')) !== monday) return;
        const k = l.RegID || (l.TeamName + '|' + l.FirstName + '|' + l.LastName);
        const s = (stats[k] = stats[k] || { name: publicName(l.MemberID) || (l.TeamName + ' player'), team: l.TeamName, g: 0, a: 0, pts: 0 });
        s.g += Number(l.G) || 0; s.a += Number(l.A) || 0; s.pts += Number(l.PTS) || 0;
      });
      const top = Object.keys(stats).map(function (k) { return stats[k]; }).filter(function (s) { return s.pts > 0; })
        .sort(function (a, b) { return b.pts - a.pts || b.g - a.g || (a.name < b.name ? -1 : 1); }).slice(0, 5);
      out.push({ key: shortHash_(division + '|' + monday), week: i + 1, division: division, monday: monday,
        dates: leagueDates_(Object.keys(wk.days).sort()), cutoff: leagueAddDays_(monday, rule.offset) + ' ' + ('0' + rule.hour).slice(-2),
        top: top, games: wk.games.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }) });
    });
  });
  return out.sort(function (a, b) { return a.monday < b.monday ? -1 : a.monday > b.monday ? 1 : a.division < b.division ? -1 : 1; });
}

/** {images, captions} for one division's week. */
function leagueWeekItems_(ev, w) {
  const base = STATS_SITE + '/leaguecard.php?e=' + encodeURIComponent(ev.id) + '&w=' + encodeURIComponent(w.key);
  const name = 'Week ' + w.week + ' ' + w.division;
  const images = [], lines = ['🥍 ' + ev.name.toUpperCase() + ' – ' + w.division.toUpperCase() + ' – WEEK ' + w.week + ' (' + w.dates + ')', ''];
  if (w.top.length) {
    images.push({ name: name + ' Top Performers.jpg', url: base + '&f=top' });
    lines.push('Top Performers caption:', '🔥 Week ' + w.week + ' Top Performers – ' + w.division + ', ' + ev.name);
    w.top.forEach(function (p, i) { lines.push((i + 1) + '. ' + p.name + ' (' + p.team + ') ' + p.g + 'G ' + p.a + 'A ' + p.pts + 'PTS'); });
    lines.push(eventTag_(ev) + ' #TopPerformers', '');
  }
  const parts = Math.max(1, Math.ceil(w.games.length / 6));
  for (let pg = 1; pg <= parts; pg++) images.push({ name: name + ' Final Scores' + (parts > 1 ? ' ' + pg + ' of ' + parts : '') + '.jpg', url: base + '&f=scores&pg=' + pg });
  lines.push('Final Scores caption:', '📊 Week ' + w.week + ' final scores – ' + w.division + ', ' + ev.name);
  w.games.forEach(function (g) { lines.push(g.home + ' ' + g.hs + ', ' + g.away + ' ' + g.as + (g.note ? ' (' + g.note + ')' : '')); });
  lines.push(eventTag_(ev) + ' #FinalScores');
  if (w.top.length) lines.push('', 'Names are shown only for players with a public USBOXLA profile; others are listed by team.');
  return { images: images, captions: lines.join('\n') };
}

function leagueDocs_(eventId, rows) {
  const docs = [];
  rows.forEach(function (r) {
    if (r.EventID !== eventId || !/^games\//.test(r.Path) || !r.Json) return;
    let doc; try { doc = JSON.parse(r.Json); } catch (err) { return; }
    if (doc.final) docs.push({ gid: r.Path.slice(6), doc: doc });
  });
  return docs;
}

function leagueGameDate_(doc) {
  const start = String((doc.game || {}).start || '').slice(0, 10);
  if (/^\d{4}-\d\d-\d\d$/.test(start)) return start;
  return doc.finalAt ? Utilities.formatDate(new Date(Number(doc.finalAt)), 'America/New_York', 'yyyy-MM-dd') : '';
}

/** The league's weeks, or [] when it has no final games. */
function leagueWeeks_(ev, docRows, statLines, publicByMember) {
  const docs = leagueDocs_(ev.id, docRows);
  if (!docs.length) return [];
  const lines = statLines.filter(function (l) { return l.EventID === ev.id; });
  return leagueWeeksData_(ev.name, docs, lines, function (m) { return publicByMember[m] || ''; }, leagueGameDate_);
}

function publicNames_(profiles) {
  const by = {};
  profiles.forEach(function (p) { if (p.memberId) by[p.memberId] = socialName_(p); });
  return by;
}

/** Called by publicFeed_: adds leagueWeeks to each league that's in the feed, for leaguecard.php. */
function attachLeagueWeeks_(feed, lines, profiles) {
  const leagues = {};
  readEventsTab_().forEach(function (ev) { if (ev.id && ev.league) leagues[ev.id] = ev; });
  seLeagueFeedEvents_(feed);
  const list = feed.events.filter(function (e) { return leagues[e.id]; });
  if (!list.length) return feed;
  const rows = readAll_('GameDocs'), names = publicNames_(profiles);
  list.forEach(function (e) {
    if (seLeague_(leagues[e.id])) {
      try { e.leagueWeeks = seLeagueWeeks_(leagues[e.id]); } catch (err) { console.error('SportsEngine scores: ' + err.message); e.leagueWeeks = []; }
      return;
    }
    e.leagueWeeks = leagueWeeks_(leagues[e.id], rows, lines, names);
    leagueAttachShots_(leagues[e.id], e.leagueWeeks);
  });
  return feed;
}

/** Hourly: fills the week's folders once each division's cutoff has passed. */
function leagueSocialHourly() {
  const root = socialRoot_();
  if (!root) return;
  const now = easternNow_(), today = now.slice(0, 10);
  const leagues = readEventsTab_().filter(function (ev) { return ev.id && ev.league && ev.start && leagueAddDays_(ev.start, -LEAGUE_SHOTS_LEAD_DAYS) <= today && leagueAddDays_(ev.end || ev.start, LEAGUE_REFRESH_DAYS) >= today; });
  if (!leagues.length) return;
  const ctx = loadCtx_();
  const log = {};
  readAll_('SocialFiles').forEach(function (r) { log[r.EventID + '|' + r.Path] = r; });
  const rows = readAll_('GameDocs'), lines = readAll_('StatLines'), names = publicNames_(readProfiles_());
  leagues.forEach(function (ev) {
    try {
      leagueShareSocial_(ev, root);
      const weeks = seLeague_(ev) ? seLeagueWeeks_(ev) : leagueWeeks_(ev, rows, lines, names);
      if (today <= (ev.end || ev.start)) leagueEnsureShots_(ev, ctx.eventData.filter(function (d) { return d.EventID === ev.id; })[0], weeks, now);
      weeks.forEach(function (w) {
        if (now < w.cutoff || now.slice(0, 10) > leagueAddDays_(w.cutoff.slice(0, 10), LEAGUE_REFRESH_DAYS)) return;
        socialStage_(root, ev, 'Week ' + w.week + ' – ' + w.division, leagueWeekItems_(ev, w), log, false, null);
      });
    } catch (err) { console.error('League social ' + ev.name + ': ' + err.message); }
  });
}

/** Run once. */
function installLeagueSocialTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'leagueSocialHourly') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('leagueSocialHourly').timeBased().everyHours(1).create();
  console.log('Hourly league graphics installed.');
}


// ---------- end of season ----------
/** {images, captions} for a league's All-League Teams and Honorable Mentions, in the league look. */
function leagueAllTeamItems_(ev, rows, bySlug) {
  const base = STATS_SITE + '/leaguecard.php?e=' + encodeURIComponent(ev.id);
  const groups = {};
  rows.forEach(function (a) { (groups[a.division] = groups[a.division] || []).push(a); });
  const order = ['mvp', 'first_team', 'goalie', 'second_team', 'goalie2'];
  const words = { mvp: 'Division MVP', first_team: '1st Team', goalie: '1st Team Goalie', second_team: '2nd Team', goalie2: '2nd Team Goalie' };
  const images = [], lines = ['🏆 ALL-LEAGUE TEAMS – ' + ev.name.toUpperCase(), ''];
  const honors = { hs: false, ms: false };                  // Middle School has its own logo, so its Honorable Mentions are separate
  Object.keys(groups).sort().forEach(function (d) {
    const main = groups[d].filter(function (a) { return a.award !== 'honors'; });
    if (main.length < groups[d].length) honors[/middle|\bms\b/i.test(d) ? 'ms' : 'hs'] = true;
    if (!main.length) return;
    images.push({ name: d.replace(/\//g, '-') + ' All-League Team.jpg', url: base + '&f=allteam&d=' + encodeURIComponent(d) });
    lines.push('— ' + d + ' — caption:', '🏆 ' + ev.name + ' ' + d + ' All-League Team, picked by the coaches.');
    order.forEach(function (k) {
      const who = main.filter(function (a) { return a.award === k; }).sort(function (a, b) { return a.slot - b.slot; })
        .map(function (a) { const n = socialName_(bySlug[a.slug]); return n ? n + ' (' + a.team + ')' : a.team + ' player'; });
      if (who.length) lines.push(words[k] + ': ' + who.join(', '));
    });
    lines.push(eventTag_(ev) + ' #AllLeague', '');
  });
  ['hs', 'ms'].forEach(function (g) {
    if (!honors[g]) return;
    const label = g === 'ms' ? 'Middle School ' : '';
    for (let pg = 1; pg <= 6; pg++) images.push({ name: label + 'Honorable Mention ' + pg + '.jpg', url: base + '&f=honors&pg=' + pg + (g === 'ms' ? '&g=ms' : ''), optional: pg > 1 });
    lines.push(label + 'Honorable Mention caption:', 'Congratulations to every ' + ev.name + ' ' + label + 'Honorable Mention! 👏', eventTag_(ev), '');
  });
  lines.push('Names are shown only for players with a public USBOXLA profile; others are listed by team.');
  return { images: images, captions: lines.join('\n') };
}

/** {images, captions} for a league's medal teams, in the league look. */
function leagueChampItems_(ev, rows) {
  const out = champItems_(ev, rows);
  const base = STATS_SITE + '/leaguecard.php?e=' + encodeURIComponent(ev.id) + '&f=champ';
  out.images.forEach(function (im) { im.url = im.url.replace(STATS_SITE + '/champcard.php?e=' + encodeURIComponent(ev.id), base); });
  return out;
}


// ---------- weekly action shots ----------
// Each league's Drive folder gets "Weekly Action Shots High School" (and Middle School for Columbus), with Week 1, Week 2…
// folders. The next week's folder appears once the current week's cutoff passes. Noah uploads photos; each weekly
// graphic uses a different one, and any graphic without a photo uses the stock photos.
const LEAGUE_MEDIA_EMAIL_DEFAULT = 'NoahB@resolutelacrosse.com';
const LEAGUE_SHOTS_NAMES = { hs: 'Weekly Action Shots High School', ms: 'Weekly Action Shots Middle School' };
const LEAGUE_SHOTS_LEAD_DAYS = 14;                          // Week 1 is ready this many days before the season

function leagueMediaEmail_() {
  return PropertiesService.getScriptProperties().getProperty('LEAGUE_MEDIA_EMAIL') || LEAGUE_MEDIA_EMAIL_DEFAULT;
}

/** Lets the league's media contact open its folder in the social drive (once per league; everything inside comes with it). */
function leagueShareSocial_(ev, root) {
  const se = seLeague_(ev), who = se ? se.media : leagueMediaEmail_();   // the Ohio media contact only gets Ohio's folders
  if (!who) return;
  const props = PropertiesService.getScriptProperties(), key = 'LEAGUE_SOCIAL_SHARED_' + ev.id;
  if (props.getProperty(key)) return;
  try {
    childFolder_(root, ev.start.slice(0, 7) + ' ' + ev.name).addViewer(who);
    props.setProperty(key, 'yes');
  } catch (err) { console.error('League social share ' + ev.name + ': ' + err.message); }
}

/** League wording for text written for tournaments: All-League, league page, season. Tournaments are unchanged. */
function leagueWords_(ev, text) {
  if (!ev || !ev.league) return text;
  return String(text).replace(/All-Stars/g, 'All-League players').replace(/All-Star|All-Tournament/g, 'All-League')
    .replace(/the tournament page/g, 'the league page').replace(/\bthe event\b/g, 'the season').replace(/\bAfter the event\b/g, 'After the season');
}

function leagueGroup_(division) { return /middle|\bms\b/i.test(division) ? 'ms' : 'hs'; }
function leagueGroups_(ev) { return /columbus/i.test(ev.name) ? ['hs', 'ms'] : ['hs']; }

function leagueShotRoots_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('LEAGUE_SHOT_ROOTS') || '{}'); } catch (err) { return {}; }
}

/** The group's folder in the league's Drive folder, shared with the media contact and the director. */
function leagueShotsRoot_(ev, data, group) {
  const roots = leagueShotRoots_();
  const key = ev.id + '|' + group;
  if (roots[key]) { try { return DriveApp.getFolderById(roots[key]); } catch (err) { /* removed: make it again */ } }
  const parent = DriveApp.getFolderById(data.FolderID);
  const folder = childFolder_(parent, LEAGUE_SHOTS_NAMES[group]);
  [leagueMediaEmail_(), ev.directorEmail].forEach(function (who) { if (who) { try { folder.addEditor(who); } catch (err) { console.error(err); } } });
  roots[key] = folder.getId();
  PropertiesService.getScriptProperties().setProperty('LEAGUE_SHOT_ROOTS', JSON.stringify(roots));
  return folder;
}

/** Pure: the highest week whose folder should exist for this group. */
function leagueShotsWeek_(weeks, group, now) {
  let done = 0;
  weeks.forEach(function (w) { if (leagueGroup_(w.division) === group && now >= w.cutoff) done = Math.max(done, w.week); });
  return done + 1;
}

function leagueEnsureShots_(ev, data, weeks, now) {
  if (!data || !data.FolderID || seLeague_(ev)) return;          // SportsEngine leagues use the stock photos
  leagueGroups_(ev).forEach(function (group) {
    const root = leagueShotsRoot_(ev, data, group), last = leagueShotsWeek_(weeks, group, now);
    for (let n = 1; n <= last; n++) childFolder_(root, 'Week ' + n);
  });
}

/** Pure: gives each graphic its own photo, in order, reusing them if there are too few. */
function leagueAssignShots_(weeks, ids) {
  if (!ids.length) return;
  let i = 0;
  weeks.slice().sort(function (a, b) { return a.division < b.division ? -1 : 1; }).forEach(function (w) {
    if (w.top.length) w.photoTop = ids[i++ % ids.length];
    w.photoScores = [];
    for (let pg = 0; pg < Math.max(1, Math.ceil(w.games.length / 6)); pg++) w.photoScores.push(ids[i++ % ids.length]);
  });
}

/** Adds the photos to weeks that can still be redrawn. Never stops the feed. */
function leagueAttachShots_(ev, weeks) {
  const now = easternNow_(), roots = leagueShotRoots_();
  const open = weeks.filter(function (w) { return now.slice(0, 10) <= leagueAddDays_(w.cutoff.slice(0, 10), LEAGUE_REFRESH_DAYS); });
  const byGroupWeek = {};
  open.forEach(function (w) { const k = leagueGroup_(w.division) + '|' + w.week; (byGroupWeek[k] = byGroupWeek[k] || []).push(w); });
  Object.keys(byGroupWeek).forEach(function (k) {
    try {
      const parts = k.split('|'), id = roots[ev.id + '|' + parts[0]];
      if (!id) return;
      const folders = DriveApp.getFolderById(id).getFoldersByName('Week ' + parts[1]);
      if (!folders.hasNext()) return;
      const files = folders.next().getFiles(), list = [];
      while (files.hasNext()) { const f = files.next(); if (/^image\//.test(f.getMimeType())) list.push({ id: f.getId(), name: f.getName() }); }
      list.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
      leagueAssignShots_(byGroupWeek[k], list.map(function (f) { return f.id; }));
    } catch (err) { console.error('League photos: ' + err.message); }
  });
}

/** ?api=leaguephoto&id=FILE – one action shot (at most 2000px). Only files inside a Weekly Action Shots week folder. */
function publicLeaguePhoto_(id) {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(id)) return { error: 'not found' };
  const file = DriveApp.getFileById(id);
  const weeks = file.getParents();
  if (!weeks.hasNext()) return { error: 'not found' };
  const up = weeks.next().getParents();
  if (!up.hasNext() || !/^Weekly Action Shots /.test(up.next().getName())) return { error: 'not found' };
  let blob = driveImage_(file, 2000);
  if (!blob) blob = file.getSize() <= 1500000 ? file.getBlob() : file.getThumbnail();
  const mime = String(blob.getContentType() || '');
  if (!/^image\/(jpeg|png|gif|webp)$/i.test(mime)) return { error: 'not an image' };
  return { mime: mime, b64: Utilities.base64Encode(blob.getBytes()) };
}

/** Run once: makes the folders now and shares them, without waiting for the hourly job. */
function setupLeagueShotsNow() {
  const ctx = loadCtx_(), now = easternNow_();
  readEventsTab_().forEach(function (ev) {
    if (!ev.id || !ev.league) return;
    const data = ctx.eventData.filter(function (d) { return d.EventID === ev.id; })[0];
    leagueEnsureShots_(ev, data, [], now);
    const social = socialRoot_();
    if (social) leagueShareSocial_(ev, social);
    console.log(ev.name + ': shared social folder ' + (PropertiesService.getScriptProperties().getProperty('LEAGUE_SOCIAL_SHARED_' + ev.id) || 'no') + '; ' + leagueGroups_(ev).map(function (g) { return LEAGUE_SHOTS_NAMES[g]; }).join(', '));
  });
}


// ======================= SportsEngine-run leagues =======================
/**
 * Leagues that run their schedule and scores in SportsEngine (not our game sheets), e.g. the
 * TC USBOXLA League (Twin Cities Lacrosse, Minnesota). No player stats: the weekly graphic is
 * Final Scores only, built from the scores the league enters in SportsEngine.
 *
 *  - Teams, logos and scores come from SportsEngine's public season-microsite API
 *    (se-api.sportsengine.com/v3/microsites/…?program_id=…), cached 20 minutes.
 *  - Team names: the SportsEngine name, plus the division when the same name is used in more than
 *    one division ("Northstar HS A"), the same names used on the Director Sheet and in Team Logos.
 *  - These leagues have no Players to Watch, no Ohio media contact, and no Weekly Action Shots
 *    folders (the stock photos are used). Graphics go to the USBOXLA Social Media drive like Ohio's.
 */
const SE_LEAGUES = [
  { match: /^tc usboxla league/i, program: '6ae20300d31d3400a21d1686', offset: 6, hour: 17,   // Sunday 5pm Eastern
    media: 'rward@truelacrosse.com',
    refCode: 'TCREF26', coachCode: 'TCCOACH26',           // academy.usboxla.com codes under Ryan's account (referee: full $45, coach: free)                    // the league director gets the folder + the "graphics are ready" emails
    divisions: { 'novice': 'Novice (3/4 Grade)', 'pee wee': 'Pee Wee (5/6 Grade)', 'bantam': 'Bantam (7/8 Grade)',
      'girls': 'Girls', 'hs b': 'HS B', 'hs a': 'HS A' } },
];
const SE_API = 'https://se-api.sportsengine.com/v3/microsites/';

/** The SportsEngine config for this Hub event, or null. */
function seLeague_(ev) {
  if (!ev || !ev.league) return null;
  return SE_LEAGUES.filter(function (c) { return c.match.test(String(ev.name || '')); })[0] || null;
}

function seGet_(path) {
  const cache = CacheService.getScriptCache(), key = 'se|' + shortHash_(path);
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const res = UrlFetchApp.fetch(SE_API + path, { muteHttpExceptions: true, headers: { Accept: 'application/json' } });
  if (res.getResponseCode() !== 200) throw new Error('SportsEngine ' + path + ' → HTTP ' + res.getResponseCode());
  const out = JSON.parse(res.getContentText()).result || [];
  try { cache.put(key, JSON.stringify(out), 1200); } catch (err) { /* too big to cache */ }
  return out;
}

function seDivision_(cfg, name) {
  const k = String(name || '').trim().toLowerCase();
  return cfg.divisions[k] || String(name || '').trim();
}

/** {teamServiceId: {name, division, logo}} with the Director Sheet names. */
function seTeams_(cfg) {
  const list = seGet_('teams?program_id=' + cfg.program + '&per_page=100');
  const count = {};
  list.forEach(function (t) { const n = String(t.name || '').trim(); count[n] = (count[n] || 0) + 1; });
  const out = {};
  list.forEach(function (t) {
    const n = String(t.name || '').trim(), d = String(t.flight_name || '').trim();
    out[t.team_service_id] = {
      name: count[n] > 1 ? n + ' ' + d : n,
      division: seDivision_(cfg, d),
      logo: t.logo && t.logo.image_urls ? t.logo.image_urls.large_uncropped : '',
    };
  });
  return out;
}

/** Every game with a final score: [{date, division, home, away, hs, as}]. */
function seGames_(cfg) {
  const teams = seTeams_(cfg);
  let all = [], page = 1;
  while (page < 20) {
    const list = seGet_('events?page=' + page + '&per_page=100&program_id=' + cfg.program + '&order_by=starts_at&direction=asc');
    all = all.concat(list);
    if (list.length < 100) break;
    page++;
  }
  const out = [];
  all.forEach(function (e) {
    if (e.event_type !== 'game') return;
    const x = (e.source && e.source.extended_attributes) || {};
    const hs = String(x.home_team_score == null ? '' : x.home_team_score).trim();
    const as = String(x.away_team_score == null ? '' : x.away_team_score).trim();
    if (hs === '' || as === '' || !/^\d+$/.test(hs) || !/^\d+$/.test(as)) return;
    if (/cancel|postpon|scheduled/i.test(String(x.status || e.status || '')) && !/final|complete/i.test(String(x.status || ''))) {
      if (Number(hs) === 0 && Number(as) === 0) return;          // a 0–0 that's still "scheduled" hasn't been played
    }
    const home = teams[x.home_team_id], away = teams[x.away_team_id];
    if (!home || !away) return;
    const date = Utilities.formatDate(new Date(e.start_date_time), e.local_timezone || 'America/Chicago', 'yyyy-MM-dd');
    out.push({ date: date, division: home.division, home: home.name, away: away.name, hs: Number(hs), as: Number(as) });
  });
  return out;
}

/** Same shape as leagueWeeksData_ (no Top Performers). */
function seLeagueWeeks_(ev) {
  const cfg = seLeague_(ev);
  if (!cfg) return [];
  const byDiv = {};
  seGames_(cfg).forEach(function (g) {
    const monday = leagueMonday_(g.date);
    const wk = ((byDiv[g.division] = byDiv[g.division] || {})[monday] = byDiv[g.division][monday] || { days: {}, games: [] });
    wk.days[g.date] = true;
    wk.games.push({ date: g.date, home: g.home, away: g.away, hs: g.hs, as: g.as, note: '' });
  });
  const out = [];
  Object.keys(byDiv).forEach(function (division) {
    Object.keys(byDiv[division]).sort().forEach(function (monday, i) {
      const wk = byDiv[division][monday];
      out.push({ key: shortHash_(division + '|' + monday), week: i + 1, division: division, monday: monday,
        dates: leagueDates_(Object.keys(wk.days).sort()), cutoff: leagueAddDays_(monday, cfg.offset) + ' ' + ('0' + cfg.hour).slice(-2),
        top: [], games: wk.games.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }) });
    });
  });
  return out.sort(function (a, b) { return a.monday < b.monday ? -1 : a.monday > b.monday ? 1 : a.division < b.division ? -1 : 1; });
}

/** For teamLogos_: one line per SportsEngine league team, so its Team Logos file goes into the feed. */
function seLeagueLogoLines_() {
  const out = [];
  readEventsTab_().forEach(function (ev) {
    const cfg = ev.id && seLeague_(ev);
    if (!cfg) return;
    try {
      const teams = seTeams_(cfg);
      Object.keys(teams).forEach(function (k) { out.push({ EventID: ev.id, TeamName: teams[k].name, GameDate: ev.start || '' }); });
    } catch (err) { console.error('SE teams ' + ev.name + ': ' + err.message); }
  });
  return out;
}

/** The feed only lists events with stats or awards; SportsEngine leagues are added so leaguecard.php can find them. */
function seLeagueFeedEvents_(feed) {
  const have = {};
  feed.events.forEach(function (e) { have[e.id] = true; });
  readEventsTab_().forEach(function (ev) {
    if (!ev.id || !seLeague_(ev) || have[ev.id]) return;
    feed.events.push({ id: ev.id, name: ev.name, tier: 'League', premium: false, start: ev.start || '', end: ev.end || '',
      season: seasonOf_(ev.start || ''), logo: '', allstars: [], watch: [], champs: [] });
  });
  return feed;
}

/** Admin: the weeks and final scores the graphics would use right now (changes nothing). */
function testSeLeague() {
  readEventsTab_().forEach(function (ev) {
    const cfg = seLeague_(ev);
    if (!cfg) return;
    const teams = seTeams_(cfg);
    console.log(ev.name + ' (' + (ev.id || 'not live') + '): ' + Object.keys(teams).length + ' teams');
    const weeks = seLeagueWeeks_(ev);
    console.log(weeks.length + ' division-week(s) with final scores');
    weeks.forEach(function (w) {
      console.log('Week ' + w.week + ' ' + w.division + ' (' + w.dates + ', posts after ' + w.cutoff + ' ET): ' +
        w.games.map(function (g) { return g.home + ' ' + g.hs + '–' + g.as + ' ' + g.away; }).join('; '));
    });
  });
}

/** Admin: takes the Ohio media contact off any SportsEngine league folder they were added to before the guard. */
function seLeagueUnshareMedia() {
  const props = PropertiesService.getScriptProperties(), media = leagueMediaEmail_(), root = socialRoot_();
  readEventsTab_().forEach(function (ev) {
    if (!ev.id || !seLeague_(ev)) return;
    if (root) {
      try {
        const f = childFolder_(root, ev.start.slice(0, 7) + ' ' + ev.name);
        if (f.getViewers().concat(f.getEditors()).some(function (u) { return u.getEmail().toLowerCase() === media.toLowerCase(); })) {
          f.removeViewer(media); console.log(ev.name + ': removed ' + media + ' from the social folder');
        }
      } catch (err) { console.error(err); }
    }
    props.deleteProperty('LEAGUE_SOCIAL_SHARED_' + ev.id);
    const roots = leagueShotRoots_();
    Object.keys(roots).forEach(function (k) {
      if (k.indexOf(ev.id + '|') !== 0) return;
      try {
        const f = DriveApp.getFolderById(roots[k]);
        try { f.removeEditor(media); } catch (err) { /* not shared */ }
        f.setTrashed(true);
        console.log(ev.name + ': removed the Weekly Action Shots folder');
      } catch (err) { console.error(err); }
      delete roots[k];
    });
    props.setProperty('LEAGUE_SHOT_ROOTS', JSON.stringify(roots));
  });
}
