/**
 * Coaches.gs – coach certification on the Roster Sheets and a "Coaches & Referees" tab on every Director Sheet.
 *
 *  Roster Sheet › "Coaches Certification"   the team's own coach link (free – included in the team's registration)
 *    and a copy-and-paste message; the manager lists the coaching staff (name, email, role). Each coach is emailed
 *    the link and shows ✅ Verified once they finish the USBOXLA Coach Certification Course with an active membership.
 *  Director Sheet › "Coaches & Referees"      every team's coaches with their status, the event's own referee link
 *    (for local referees the director recruits), and the referees signed up through it or working the event's games.
 *
 * Data comes from the academy feed (/wp-json/usboxla/v1/certified, plugin v1.3): course progress, membership, waiver,
 * the team/event link each person signed up through, and a keyed fingerprint of their email (never the email).
 * Coach certification is ENCOURAGED, not required: nothing here blocks a game.
 *
 * Off until switched on: Script Property COACH_CERT_LIVE = yes (every event) or part of an event name, e.g.
 * "Border Wars" (several: comma separated). Admin tools: syncAcademyPeople, coachesNow, coachCertStatus.
 */

const COACH_TAB = 'Coaches Certification';
const COACH_DIR_TAB = 'Coaches & Referees';
const COACH_HEADERS = ['Coach Name', 'Email', 'Role', 'Status ⏳ updates within 30 min', 'Course', 'Invite Sent', 'Note'];
const COACH_INPUTS = 3;
const COACH_ROLES = ['Head Coach', 'Assistant Coach'];
const COACH_LEVEL = 7;                       // USBOXLA Coach Membership (Paid Memberships Pro)
const REF_LEVEL = 6;                         // USBOXLA Referee Membership
const COACH_DISCOUNT = 'TEAMCOACH';          // 100% off the Coach level: coach certification is included in the team's registration
const ACADEMY_CHECKOUT = 'https://academy.usboxla.com/membership-account/membership-checkout';
const ACADEMY_PEOPLE_MINUTES = 30;           // how often the coach/referee feed is re-read
const COACH_REMINDER_DAYS = 7;               // one friendly reminder this many days before the event

function coachTables_() {
  if (!TABLES.Coaches) {
    TABLES.Coaches = ['CoachID', 'EventID', 'RosterSheetID', 'Club', 'Name', 'Email', 'Role', 'InvitedAt', 'RemindersSent',
      'Present', 'Status', 'AcademyID', 'UpdatedAt'];
  }
  if (!TABLES.AcademyPeople) {
    TABLES.AcademyPeople = ['Role', 'AcademyID', 'Name', 'EmailHash', 'Progress', 'Completed', 'Member', 'Expires', 'Waiver',
      'Certified', 'Tags', 'UpdatedAt'];
  }
}

// ======================= switch =======================

function coachCertLive_(ev) {
  const v = String(PropertiesService.getScriptProperties().getProperty('COACH_CERT_LIVE') || '').trim();
  if (!v) return false;
  if (/^(yes|true|on|all)$/i.test(v)) return true;
  const name = String(ev && ev.name || '').toLowerCase();
  return v.split(',').some(function (p) { p = p.trim().toLowerCase(); return p && name.indexOf(p) !== -1; });
}

// ======================= academy feed =======================

function academyPeopleUrl_() {
  const u = academyUrl_();   // GameSheet.gs: …/wp-json/usboxla/v1/referees
  return u ? u.replace(/\/referees$/, '/certified') : '';
}

/** Admin tool: re-reads coaches and referees from the academy now. */
function syncAcademyPeople() {
  withLock_(function () { console.log(syncAcademyPeople_()); });
}

/** scanAll: refresh every ACADEMY_PEOPLE_MINUTES (does nothing until ACADEMY_URL / ACADEMY_KEY are set). */
function academyPeopleIfStale_() {
  const props = PropertiesService.getScriptProperties();
  if (!academyPeopleUrl_() || !props.getProperty('ACADEMY_KEY')) return;
  if (!String(props.getProperty('COACH_CERT_LIVE') || '').trim()) return;   // nothing uses it yet
  if (Date.now() - Number(props.getProperty('ACADEMY_PEOPLE_SYNCED') || 0) < ACADEMY_PEOPLE_MINUTES * 60000) return;
  props.setProperty('ACADEMY_PEOPLE_SYNCED', String(Date.now()));
  try { console.log(syncAcademyPeople_()); } catch (err) { console.error('Academy coaches/referees: ' + err.message); }
}

function syncAcademyPeople_() {
  coachTables_();
  const url = academyPeopleUrl_();
  const key = PropertiesService.getScriptProperties().getProperty('ACADEMY_KEY');
  if (!url || !key) throw new Error('Add ACADEMY_URL and ACADEMY_KEY in Project Settings › Script Properties first.');
  const res = UrlFetchApp.fetch(url, { headers: { 'x-usboxla-key': key }, muteHttpExceptions: true, followRedirects: true });
  const code = res.getResponseCode();
  if (code === 404) throw new Error('The academy has no coach feed yet – update the USBOXLA Referee Feed plugin to version 1.3.');
  if (code !== 200) throw new Error('The academy answered ' + code + '.');
  let body;
  try { body = JSON.parse(res.getContentText()); } catch (err) { throw new Error('The academy didn’t send a coach/referee list.'); }
  const rows = academyPeopleRows_(body, nowText_());
  if (!rows.length && readAll_('AcademyPeople').length > 5) throw new Error('The academy sent an empty list – kept the old one.');
  rewriteTable_('AcademyPeople', rows);
  PropertiesService.getScriptProperties().setProperty('ACADEMY_PEOPLE_SYNCED', String(Date.now()));
  PropertiesService.getScriptProperties().setProperty('ACADEMY_PEOPLE_VERSION', String(Date.now()));
  const n = function (role, cert) { return rows.filter(function (r) { return r.Role === role && (!cert || r.Certified === 'yes'); }).length; };
  return 'Academy: ' + n('coach') + ' coaches (' + n('coach', true) + ' certified), ' + n('ref') + ' referees (' + n('ref', true) + ' certified).';
}

/** Pure: feed → AcademyPeople rows. */
function academyPeopleRows_(body, stamp) {
  const out = [];
  [['coach', body && body.coaches], ['ref', body && body.referees]].forEach(function (pair) {
    (pair[1] || []).forEach(function (p) {
      if (!p || !p.id) return;
      const name = clean_(p.name || ((p.first || '') + ' ' + (p.last || '')), 80);
      if (!name) return;
      out.push({ Role: pair[0], AcademyID: String(p.id), Name: name, EmailHash: String(p.email_hash || ''),
        Progress: String(Math.max(0, Math.min(100, Number(p.progress) || 0))), Completed: toIsoDate_(p.completed) || '',
        Member: p.member ? 'yes' : '', Expires: toIsoDate_(p.expires) || '', Waiver: toIsoDate_(p.waiver) || '',
        Certified: p.certified ? 'yes' : '', Tags: JSON.stringify((p.tags || []).map(function (t) {
          return { e: String(t.event || ''), t: String(t.team || ''), at: String(t.at || '') };
        })), UpdatedAt: stamp });
    });
  });
  return out;
}

/** Keyed fingerprint of an email – the same HMAC-SHA256 the academy plugin uses. */
function emailHash_(email, key) {
  const e = String(email || '').toLowerCase().trim();
  if (!e || !key) return '';
  return Utilities.computeHmacSha256Signature(e, key).map(function (b) {
    const h = ((b + 256) % 256).toString(16);
    return h.length === 1 ? '0' + h : h;
  }).join('');
}

// ======================= links =======================

/** Short code for a club's Roster Sheet at an event (goes in the link). */
function clubCode_(rosterSheetId) {
  return 'c' + Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(rosterSheetId)).map(function (b) {
    const h = ((b + 256) % 256).toString(16); return h.length === 1 ? '0' + h : h;
  }).join('').slice(0, 10);
}

/** The event's own academy codes, if it has any (TC USBOXLA League: SE_LEAGUES refCode / coachCode). */
function eventCodes_(eventId) {
  if (!eventCodes_.memo) {
    eventCodes_.memo = {};
    try { readEventsTab_().forEach(function (ev) { const c = ev.id && seLeague_(ev); if (c) eventCodes_.memo[ev.id] = c; }); } catch (err) { console.error(err); }
  }
  return eventCodes_.memo[eventId] || {};
}

function coachLink_(eventId, club) {
  return ACADEMY_CHECKOUT + '?pmpro_level=' + COACH_LEVEL + '&discount_code=' + (eventCodes_(eventId).coachCode || COACH_DISCOUNT) +
    '&usbx_r=coach&usbx_e=' + encodeURIComponent(eventId) + '&usbx_t=' + encodeURIComponent(club);
}

function refLink_(eventId) {
  const code = eventCodes_(eventId).refCode;
  return ACADEMY_CHECKOUT + '?pmpro_level=' + REF_LEVEL + (code ? '&discount_code=' + code : '') + '&usbx_r=ref&usbx_e=' + encodeURIComponent(eventId);
}

// ======================= status (pure) =======================

/**
 * One person's status from their academy record (or null): [status, course, note].
 * today = YYYY-MM-DD. invited = invite already sent.
 */
function coachStatus_(p, today, invited) {
  if (!p) return [invited ? '⏳ Invited – not started' : '⏳ Not started', '', ''];
  const prog = Number(p.Progress) || 0;
  const expired = p.Expires && p.Expires < today;
  const waiver = p.Waiver ? 'Waiver accepted ' + p.Waiver : 'Waiver asked at next renewal';
  if (p.Certified === 'yes' && !expired) return ['✅ Verified', 'Finished' + (p.Completed ? ' ' + p.Completed : ''), waiver];
  if (prog >= 100) return ['⚠ Membership not active', 'Finished' + (p.Completed ? ' ' + p.Completed : ''),
    p.Role === 'ref' ? 'Renew the referee membership at academy.usboxla.com' : 'Renew through the team’s coach link (free)'];
  if (prog > 0) return ['📘 In progress', prog + '% done', waiver];
  return ['📘 Signed up – not started', '0% done', waiver];
}

/** Picks the coach's academy record: by email fingerprint, else by name among people who used this club's link. */
function findCoach_(people, hash, name, eventId, club) {
  if (hash) {
    const byHash = people.filter(function (p) { return p.EmailHash && p.EmailHash === hash; });
    if (byHash.length) return bestPerson_(byHash);
  }
  const n = norm_(name);
  if (!n) return null;
  const byName = people.filter(function (p) { return norm_(p.Name) === n && tagsOf_(p).some(function (t) { return t.e === eventId && t.t === club; }); });
  return byName.length ? bestPerson_(byName) : null;
}

function bestPerson_(list) {
  return list.slice().sort(function (a, b) {
    return (b.Certified === 'yes') - (a.Certified === 'yes') || (Number(b.Progress) || 0) - (Number(a.Progress) || 0);
  })[0];
}

function tagsOf_(p) {
  if (!p._tags) { try { p._tags = JSON.parse(p.Tags || '[]'); } catch (err) { p._tags = []; } }
  return p._tags;
}

// ======================= main pass (from processEvent_) =======================

/**
 * Called from processEvent_ every 10 minutes for live events. Does the full pass only when a roster sheet changed
 * or the academy list was refreshed since this event's last pass.
 */
function coachesScan_(ev, data, teams, ctx) {
  if (!coachCertLive_(ev)) return;
  coachTables_();
  const props = PropertiesService.getScriptProperties();
  const passKey = 'COACH_PASS_' + data.EventID;
  const lastPass = Number(props.getProperty(passKey) || 0);
  const academyVer = Number(props.getProperty('ACADEMY_PEOPLE_VERSION') || 0);
  const sheets = {};
  teams.forEach(function (t) { if (t.team && t.team.RosterSheetID) sheets[t.team.RosterSheetID] = sheets[t.team.RosterSheetID] || t.team; });
  const ids = Object.keys(sheets);
  if (!ids.length) return;

  let todo = ids;
  if (lastPass && academyVer <= lastPass) {
    const since = isoUtc_(new Date(lastPass - 30 * 60 * 1000));
    const changed = {};
    const it = DriveApp.getFolderById(data.RostersFolderID).searchFiles("modifiedDate > '" + since + "'");
    while (it.hasNext()) changed[it.next().getId()] = true;
    todo = ids.filter(function (id) { return changed[id]; });
    if (!todo.length) return;
  }
  const started = Date.now();
  const people = readAll_('AcademyPeople');
  const coaches = people.filter(function (p) { return p.Role === 'coach'; });
  const key = props.getProperty('ACADEMY_KEY') || '';
  const rows = readAll_('Coaches');
  todo.forEach(function (id) {
    if (Date.now() - started > 3 * 60 * 1000) return;   // the rest next run
    try { coachRosterSheet_(ev, data, sheets[id], coaches, rows, key, ctx); }
    catch (err) { console.error('Coaches tab (' + sheets[id].TeamName + '): ' + err.message); }
  });
  try { coachDirectorTab_(ev, data, sheets, people, rows, ctx); } catch (err) { console.error('Coaches & Referees tab: ' + err.message); }
  props.setProperty(passKey, String(Date.now()));
}

/** One club's Roster Sheet: make sure the tab exists, read the staff list, invite/remind, write the grey columns. */
function coachRosterSheet_(ev, data, team, coaches, rows, key, ctx) {
  const ss = SpreadsheetApp.openById(team.RosterSheetID);
  const club = clubCode_(team.RosterSheetID);
  const link = coachLink_(data.EventID, club);
  const sh = ensureCoachTab_(ss, ev, team, link);
  const last = sh.getLastRow();
  const mine = rows.filter(function (r) { return r.EventID === data.EventID && r.RosterSheetID === team.RosterSheetID; });
  const present = {};
  const desired = [];
  const listedIds = {};
  const daysOut = daysBetween_(ctx.today, ev.start);

  if (last >= 2) {
    sh.getRange(2, 1, last - 1, COACH_INPUTS).getValues().forEach(function (r) {
      const name = clean_(r[0], 80);
      const raw = String(r[1] === null || r[1] === undefined ? '' : r[1]).trim();
      const email = cleanEmail_(raw);
      const role = COACH_ROLES.indexOf(String(r[2])) !== -1 ? String(r[2]) : '';
      if (!name && !raw) { desired.push(['', '', '', '']); return; }
      if (!name) { desired.push(['⚠ Add the coach’s name', '', '', '']); return; }
      if (raw && !email) { desired.push(['⚠ Check the email', '', '', '']); return; }
      const rowKey = email || 'n:' + norm_(name);
      if (present[rowKey]) { desired.push(['⚠ Duplicate', '', '', 'This coach is already listed above']); return; }
      present[rowKey] = true;

      let rec = mine.filter(function (x) { return (x.Email || 'n:' + norm_(x.Name)) === rowKey; })[0];
      if (!rec) {
        rec = insert_('Coaches', { CoachID: newId_('C'), EventID: data.EventID, RosterSheetID: team.RosterSheetID, Club: club,
          Name: name, Email: email, Role: role, InvitedAt: '', RemindersSent: '0', Present: 'yes', Status: '', AcademyID: '',
          UpdatedAt: nowText_() });
        rows.push(rec); mine.push(rec);
      }
      const p = findCoach_(coaches, emailHash_(email, key), name, data.EventID, club);
      if (p) listedIds[p.AcademyID] = true;
      const verified = p && p.Certified === 'yes' && !(p.Expires && p.Expires < ctx.today);

      // Invite once (only coaches who aren't verified yet and have an email), one reminder a week out.
      let dirty = false;
      if (email && !verified && !rec.InvitedAt && daysOut >= 0) {
        if (sendCoachInvite_(ev, data, team, name, email, link, false)) { rec.InvitedAt = nowText_(); dirty = true; }
      } else if (email && !verified && rec.InvitedAt && rec.RemindersSent === '0' && daysOut >= 0 &&
                 daysOut <= COACH_REMINDER_DAYS && hoursSince_(rec.InvitedAt) >= 48 && !(p && Number(p.Progress) >= 100)) {
        if (sendCoachInvite_(ev, data, team, name, email, link, true)) { rec.RemindersSent = '1'; dirty = true; }
      }
      const st = coachStatus_(p, ctx.today, !!rec.InvitedAt);
      const changed = rec.Name !== name || rec.Role !== role || rec.Present !== 'yes' || rec.Status !== st[0] ||
        rec.AcademyID !== (p ? p.AcademyID : '');
      rec.Name = name; rec.Role = role; rec.Present = 'yes'; rec.Status = st[0]; rec.AcademyID = p ? p.AcademyID : '';
      if (changed || dirty) { rec.UpdatedAt = nowText_(); update_('Coaches', rec); }
      desired.push([st[0], st[1], rec.InvitedAt ? rec.InvitedAt.slice(0, 10) : (email ? '' : 'No email – share the link'), st[2]]);
    });
  }
  mine.forEach(function (x) {
    if (x.Present === 'yes' && !present[x.Email || 'n:' + norm_(x.Name)]) { x.Present = 'no'; update_('Coaches', x); }
  });
  if (desired.length) writeIfChanged_(sh.getRange(2, COACH_INPUTS + 1, desired.length, 4), desired);

  // Side panel: coaches who signed up through this team's link but aren't on the list yet.
  const viaLink = coaches.filter(function (p) {
    return !listedIds[p.AcademyID] && tagsOf_(p).some(function (t) { return t.e === data.EventID && t.t === club; });
  }).map(function (p) { return [p.Name + ' – ' + coachStatus_(p, ctx.today, false)[0]]; });
  const panel = viaLink.length ? viaLink : [['(none yet)']];
  const box = sh.getRange(10, 9, 15, 1);
  const want = panel.slice(0, 15).concat(Array(Math.max(0, 15 - panel.length)).fill(['']));
  writeIfChanged_(box, want);
}

function coachMessage_(ev, link) {
  return 'Hi Coach! USBOXLA coach certification is included with our team’s registration for the ' + ev.name +
    '. Sign up free and take the course online, at your own pace: ' + link +
    ' – once you finish, you’ll show as ✅ Verified on our team sheet.';
}

/** Creates the Coaches Certification tab the first time (with the team's link and a copy-and-paste message). */
function ensureCoachTab_(ss, ev, team, link) {
  let sh = ss.getSheetByName(COACH_TAB);
  if (sh) {
    const msg = coachMessage_(ev, link);
    writeIfChanged_(sh.getRange(2, 9, 1, 1), [[link]]);
    writeIfChanged_(sh.getRange(5, 9, 1, 1), [[msg]]);
    return sh;
  }
  const help = ss.getSheetByName('How this works');
  sh = ss.insertSheet(COACH_TAB, help ? help.getIndex() - 1 : ss.getSheets().length);
  styleSheet_(sh, COACH_HEADERS, COACH_INPUTS, [170, 230, 130, 200, 130, 100, 230]);
  sh.getRange(2, 2, sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireTextIsEmail().setAllowInvalid(true).build());
  sh.getRange(2, 3, sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(COACH_ROLES, true).setAllowInvalid(false).build());
  sh.getRange(1, COACH_INPUTS + 1).setNote('Sit tight – the grey columns fill in on their own (within about 30 minutes ' +
    'of a coach signing up or finishing a course section).').setWrap(true);
  sh.setColumnWidth(8, 24);
  sh.setColumnWidth(9, 420);
  const panel = [
    ['Your team’s coach link (free – included in your team’s registration)'],
    [link],
    ['Give it to your coaching staff, or add them on the left and we’ll email it for you.'],
    ['Message you can copy and paste:'],
    [coachMessage_(ev, link)],
    [''],
    ['✅ Verified = finished the USBOXLA Coach Certification Course with an active membership.'],
    ['Coach certification is encouraged, not required, to coach at USBOXLA sanctioned events.'],
    ['Coaches who signed up through your link but aren’t listed on the left:'],
  ];
  sh.getRange(1, 9, panel.length, 1).setValues(panel).setWrap(true).setVerticalAlignment('top');
  sh.getRange(1, 9).setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff');
  sh.getRange(2, 9).setFontColor(BRAND_BLUE).setFontWeight('bold');
  sh.getRange(4, 9).setFontWeight('bold');
  sh.getRange(5, 9).setBackground('#f3f5f9');
  sh.getRange(9, 9).setFontWeight('bold');
  sh.getRange(10, 9, 15, 1).setBackground(GREY);
  lockRange_(sh.getRange(1, 9, 30, 1), 'Filled in by USBOXLA');
  return sh;
}

function sendCoachInvite_(ev, data, team, name, email, link, reminder) {
  const first = String(name).split(' ')[0];
  return sendMail_(email,
    (reminder ? 'Reminder: ' : '') + 'Your free USBOXLA coach certification – ' + team.TeamName + ' at the ' + ev.name,
    reminder ? 'Finish your coach certification before the ' + ev.name : 'Get certified to coach ' + team.TeamName,
    ['Hi ' + first + ',',
     team.TeamName + ' added you to its coaching staff for the ' + ev.name + ' (' + prettyRange_({ StartDate: ev.start, EndDate: ev.end }) + ').',
     'USBOXLA coach certification is included with your team’s registration – no charge. Sign up with the button below and take the ' +
       'USBOXLA Coach Certification Course online, at your own pace. When you finish, you’ll show as ✅ Verified on your team’s sheet.',
     reminder ? 'The event is coming up – if you’ve already started, just log in and pick up where you left off.'
       : 'Already certified? Nothing to do – you’ll show as verified automatically.'],
    reminder ? 'Finish my certification' : 'Start my free certification', link, logoForEmail_(data),
    null, { footer: 'This link is for ' + team.TeamName + ' coaches.' });
}

// ======================= Director Sheet tab =======================

function coachDirectorTab_(ev, data, sheets, people, rows, ctx) {
  const ss = SpreadsheetApp.openById(data.DirectorSheetID);
  let sh = ss.getSheetByName(COACH_DIR_TAB);
  if (!sh) {
    sh = ss.insertSheet(COACH_DIR_TAB);
    [180, 200, 130, 210, 150, 200, 200].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
    lockRange_(sh.getRange(1, 1, sh.getMaxRows(), 8), 'Filled in by USBOXLA');
  }
  const today = ctx.today;
  const out = [];
  const W = 7;
  const row = function (a) { while (a.length < W) a.push(''); out.push(a.slice(0, W)); };
  row(['Coaches & Referees – ' + ev.name]);
  row(['Updated ' + nowText_() + '. Coach certification is encouraged, not required. ✅ Verified = finished the course with an active membership.']);
  const codes = eventCodes_(data.EventID);
  if (codes.refCode || codes.coachCode) {
    row(['Your academy.usboxla.com codes: Referee ' + (codes.refCode || '–') + ' (Referee Level 1 Certification, $45/yr – no discount) · Coach ' +
      (codes.coachCode || COACH_DISCOUNT) + ' (free). The links on this tab and on each team’s Coaches Certification tab already include them.']);
  }
  row(['']);
  row(['COACHES']);
  row(['Team', 'Coach', 'Role', 'Status', 'Course', 'Waiver', 'How they joined']);
  const coaches = people.filter(function (p) { return p.Role === 'coach'; });
  const byId = {};
  coaches.forEach(function (p) { byId[p.AcademyID] = p; });
  const shown = {};
  const clubName = {};
  Object.keys(sheets).forEach(function (id) { clubName[clubCode_(id)] = sheets[id].TeamName; });
  let nCoach = 0, nVerified = 0;
  Object.keys(sheets).forEach(function (id) {
    const club = clubCode_(id);
    rows.filter(function (r) { return r.EventID === data.EventID && r.RosterSheetID === id && r.Present === 'yes'; }).forEach(function (r) {
      const p = r.AcademyID ? byId[r.AcademyID] : null;
      if (p) shown[p.AcademyID + '|' + club] = true;
      const st = coachStatus_(p, today, !!r.InvitedAt);
      nCoach++; if (st[0].indexOf('✅') === 0) nVerified++;
      row([sheets[id].TeamName, r.Name, r.Role, st[0], st[1], p ? (p.Waiver ? 'Accepted ' + p.Waiver : 'At next renewal') : '', 'Listed by manager']);
    });
  });
  coaches.forEach(function (p) {
    tagsOf_(p).forEach(function (t) {
      if (t.e !== data.EventID || shown[p.AcademyID + '|' + t.t]) return;
      shown[p.AcademyID + '|' + t.t] = true;
      const st = coachStatus_(p, today, false);
      nCoach++; if (st[0].indexOf('✅') === 0) nVerified++;
      row([clubName[t.t] || '(team link)', p.Name, '', st[0], st[1], p.Waiver ? 'Accepted ' + p.Waiver : 'At next renewal', 'Team link']);
    });
  });
  if (!nCoach) row(['(No coaches yet – each team manager has a Coaches Certification tab with their team’s free link.)']);
  row(['']);
  row(['REFEREES']);
  row(['Your event’s referee link (for local referees you recruit – USBOXLA Referee Membership, $45):']);
  row([refLink_(data.EventID)]);
  row(['Message: "We use USBOXLA certified referees. Sign up and take the USBOXLA Referee Certification Course here: ' + refLink_(data.EventID) + '"']);
  row(['Referee', 'Status', 'Course', 'Membership expires', 'How they joined']);
  const refs = people.filter(function (p) { return p.Role === 'ref'; });
  const refShown = {};
  let nRef = 0;
  refs.forEach(function (p) {
    if (!tagsOf_(p).some(function (t) { return t.e === data.EventID; })) return;
    refShown[p.AcademyID] = true; nRef++;
    row([p.Name, coachStatus_(p, today, false)[0], coachStatus_(p, today, false)[1], p.Expires || (p.Member ? 'No end date' : ''), 'Event referee link']);
  });
  eventOfficials_(data.EventID).forEach(function (o) {
    const id = o.id ? o.id.replace(/^r/, '') : '';
    if (id && refShown[id]) return;
    if (id) refShown[id] = true;
    const p = id ? refs.filter(function (x) { return x.AcademyID === id; })[0] : null;
    nRef++;
    row([o.name, o.certified ? (p ? coachStatus_(p, today, false)[0] : '✅ Verified') : '⚠ Not on the certified list', p ? coachStatus_(p, today, false)[1] : '',
      p ? (p.Expires || '') : '', 'Worked ' + o.games + ' game' + (o.games === 1 ? '' : 's')]);
  });
  if (!nRef) row(['(No referees yet – referees appear here once they sign up through your link or work a game.)']);
  out[1][0] = 'Updated ' + nowText_() + ' · Coaches: ' + nVerified + ' of ' + nCoach + ' verified · Referees: ' + nRef +
    '. Coach certification is encouraged, not required.';

  // Write (only if changed), clearing any leftover rows from a longer earlier version.
  const prev = sh.getLastRow();
  const height = Math.max(prev, out.length);
  const block = out.concat(Array(Math.max(0, height - out.length)).fill(null).map(function () { return Array(W).fill(''); }));
  if (sh.getMaxRows() < height) sh.insertRowsAfter(sh.getMaxRows(), height - sh.getMaxRows());
  writeIfChanged_(sh.getRange(1, 1, height, W), block);
  // light formatting for the section headers (cheap; only on first build or when the layout grows)
  if (prev !== out.length) {
    sh.getRange(1, 1, height, W).setFontWeight('normal').setBackground(null).setFontColor(null);
    sh.getRange(1, 1).setFontWeight('bold').setFontSize(14);
    out.forEach(function (r, i) {
      if (r[0] === 'COACHES' || r[0] === 'REFEREES') sh.getRange(i + 1, 1, 1, W).setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff');
      if (r[0] === 'Team' && r[1] === 'Coach' || r[0] === 'Referee' && r[1] === 'Status') sh.getRange(i + 1, 1, 1, W).setFontWeight('bold').setBackground('#e8eef8');
    });
  }
}

/** Referees on this event's game sheets: [{id: 'r123' | '', name, certified, games}]. */
function eventOfficials_(eventId) {
  const by = {};
  readAll_('GameDocs').forEach(function (r) {
    if (r.EventID !== eventId || !/^games\//.test(r.Path) || !r.Json) return;
    let doc; try { doc = JSON.parse(r.Json); } catch (err) { return; }
    officials_(doc.off).forEach(function (o) {
      if (o.role !== 'ref') return;
      const x = by[o.key] || (by[o.key] = { id: o.id, name: o.name, certified: o.certified, games: 0 });
      x.games++;
    });
  });
  return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
}

// ======================= admin tools =======================

/** Admin tool: runs the coach pass for every live event now (ignores the "only when something changed" check). */
function coachesNow() {
  withLock_(function () {
    try { console.log(syncAcademyPeople_()); } catch (err) { console.error(err.message); }
    const ctx = loadCtx_();
    readEventsTab_().forEach(function (ev) {
      if (!ev.id || ev.end < ctx.today || !coachCertLive_(ev)) return;
      const data = ctx.eventData.filter(function (d) { return d.EventID === ev.id; })[0];
      if (!data) return;
      PropertiesService.getScriptProperties().deleteProperty('COACH_PASS_' + data.EventID);
      const teams = ctx.teams.filter(function (t) { return t.EventID === ev.id; }).map(function (t) { return { team: t }; });
      coachesScan_(ev, data, teams, ctx);
      console.log('Coach pass done: ' + ev.name);
    });
  });
}

/** Admin tool: shows the switch and the academy numbers. */
function coachCertStatus() {
  coachTables_();
  const props = PropertiesService.getScriptProperties();
  const people = readAll_('AcademyPeople');
  console.log('COACH_CERT_LIVE = "' + (props.getProperty('COACH_CERT_LIVE') || '') + '" · feed: ' + (academyPeopleUrl_() || '(ACADEMY_URL not set)') +
    ' · coaches: ' + people.filter(function (p) { return p.Role === 'coach'; }).length +
    ' · referees: ' + people.filter(function (p) { return p.Role === 'ref'; }).length);
}


