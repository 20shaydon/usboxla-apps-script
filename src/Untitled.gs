function aaRefLaunchTest() { refLaunchTest(); }

/**
 * Sanctioned Tournament Referee Availability (Nov 12, 2026).
 *
 * Adam sends refs the link www.usboxla.com/referee-availability/. The page lists every upcoming sanctioned
 * TOURNAMENT on the Hub (leagues left out) and asks, for each one: interested (yes/no), days available,
 * hotel nights needed (the tournament provides rooms; Adam requests them from the director),
 * schedule restrictions and comments. It also asks name, email, phone and where they're travelling from.
 *
 * Level 1 certification and membership are looked up from the academy (AcademyPeople table, matched on the
 * keyed email fingerprint) – refs don't fill those in.
 *
 * Answers are appended to the hidden RefAvail table (newest answer per email + event wins), and the tab
 * "Sanctioned Tournament Referee Availability" in Adam's daily referee sheet is rebuilt after every answer
 * and every morning.
 *
 * The page talks to the web app's doPost with action 'ra-data' / 'ra-lookup' / 'ra-submit'.
 */

const RA_TAB = 'Sanctioned Tournament Referee Availability';
const RA_PAGE_URL = 'https://academy.usboxla.com/ref-room/';   // the Ref Room (academy mu-plugin usboxla-ref-room.php)
const RA_WAIVER_SINCE = '2026-10-23';   // the current referee waiver was last updated on this date; agreements before it don't count
const RA_COLS = ['Key', 'EventID', 'EventName', 'Name', 'Email', 'Phone', 'From', 'Interested', 'Days', 'Hotel',
  'Restrictions', 'Comments', 'UpdatedAt'];
const RA_APPROVAL_COLS = ['Key', 'EventID', 'Approved', 'Room', 'EmailedAt', 'UpdatedAt'];
const RA_SETTING_COLS = ['EventID', 'Needed', 'HotelNotes', 'UpdatedAt'];
const RA_HOTEL_TAB = 'Referee Hotel Rooms';
const RA_W = 17;        // visible columns on Adam's tab
const RA_KEY_COL = 18;  // hidden column R: row key (S|eventId for summary rows, D|eventId|email for answer rows)

function raTable_() {
  if (!TABLES.RefAvail) TABLES.RefAvail = RA_COLS;
  if (!TABLES.RefApprovals) TABLES.RefApprovals = RA_APPROVAL_COLS;
  if (!TABLES.RefEventSettings) TABLES.RefEventSettings = RA_SETTING_COLS;
  return table_('RefAvail');
}

// ======================= events =======================

/** Upcoming sanctioned tournaments (not leagues), soonest first: [{id, name, start, end, label, days:[{iso,label}], nights:[{iso,label}]}]. */
function raEvents_(today) {
  today = today || todayIso_();
  return readEventsTab_().filter(function (e) {
    return e.start && !e.league && (e.end || e.start) >= today;
  }).sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; }).map(function (e) {
    const days = raDayList_(e.start, e.end || e.start);
    return { id: e.id || raPendingKey_(e), hubId: e.id, name: e.name, start: e.start, end: e.end || e.start, label: raRange_(e.start, e.end || e.start),
      location: raLocation_(e), directorName: e.directorName || '', directorEmail: e.directorEmail || '', directorPhone: e.directorPhone || '',
      days: days.map(function (d) { return { iso: d, label: raDay_(d) }; }),
      // nights: the night before the first day through the night before the last day
      nights: [raAddDays_(e.start, -1)].concat(days.slice(0, -1)).map(function (d) { return { iso: d, label: raDay_(d) + ' night' }; }) };
  });
}

/**
 * Tournaments on the Hub without a director yet have no Event ID. They still go on the form under a key made from
 * their name + start date; once the event gets its ID, answers/approvals saved under that key are read as the real ID
 * (raAlias_) and rewritten with it the next time they're saved.
 */
function raPendingKey_(e) {
  const d = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(e.name).toLowerCase().trim() + '|' + e.start);
  return 'P' + d.slice(0, 6).map(function (b) { const h = ((b + 256) % 256).toString(16); return h.length === 1 ? '0' + h : h; }).join('');
}

function raAlias_() {
  if (raAlias_.map) return raAlias_.map;
  const map = {};
  readEventsTab_().forEach(function (e) { if (e.id && e.start) map[raPendingKey_(e)] = e.id; });
  return (raAlias_.map = map);
}

function raAddDays_(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function raDayList_(start, end) {
  const out = [];
  for (let d = start; d <= end && out.length < 14; d = raAddDays_(d, 1)) out.push(d);
  return out;
}

const RA_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RA_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Fri Dec 18" */
function raDay_(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return RA_DOW[d.getUTCDay()] + ' ' + RA_MON[d.getUTCMonth()] + ' ' + d.getUTCDate();
}

/** "Dec 18–20, 2026" / "Dec 31, 2026 – Jan 2, 2027" */
function raRange_(start, end) {
  const a = new Date(start + 'T12:00:00Z'), b = new Date(end + 'T12:00:00Z');
  const ma = RA_MON[a.getUTCMonth()], mb = RA_MON[b.getUTCMonth()];
  if (start === end) return ma + ' ' + a.getUTCDate() + ', ' + a.getUTCFullYear();
  if (a.getUTCFullYear() !== b.getUTCFullYear()) {
    return ma + ' ' + a.getUTCDate() + ', ' + a.getUTCFullYear() + ' – ' + mb + ' ' + b.getUTCDate() + ', ' + b.getUTCFullYear();
  }
  if (ma === mb) return ma + ' ' + a.getUTCDate() + '–' + b.getUTCDate() + ', ' + a.getUTCFullYear();
  return ma + ' ' + a.getUTCDate() + ' – ' + mb + ' ' + b.getUTCDate() + ', ' + a.getUTCFullYear();
}

// ======================= academy status =======================

/** Level 1 referee course + membership for an email: {found, certified, progress, member, expires, text, memberText}. */
function raAcademyStatus_(email, today) {
  today = today || todayIso_();
  coachTables_();
  const key = PropertiesService.getScriptProperties().getProperty('ACADEMY_KEY');
  const hash = emailHash_(email, key);
  const p = hash ? readAll_('AcademyPeople').filter(function (r) { return r.Role === 'ref' && r.EmailHash === hash; })[0] : null;
  const mdy = function (iso) { return iso ? Number(iso.slice(5, 7)) + '/' + Number(iso.slice(8, 10)) + '/' + iso.slice(0, 4) : ''; };
  if (!p) {
    return { found: false, certified: false, progress: 0, member: false, expires: '', waiver: false,
      text: 'Not on the Level 1 referee list', memberText: 'No referee membership found', waiverText: 'Not signed' };
  }
  const progress = Number(p.Progress) || 0;
  const member = p.Member === 'yes' && !(p.Expires && p.Expires < today);
  const done = progress >= 100;
  const waiver = !!p.Waiver && p.Waiver >= RA_WAIVER_SINCE;
  return {
    found: true, certified: done && member, progress: progress, member: member, expires: p.Expires,
    waiver: waiver, waiverText: waiver ? '✓ ' + mdy(p.Waiver) : (p.Waiver ? 'Old waiver (' + mdy(p.Waiver) + ') – needs the new one' : 'Not signed'),
    text: done ? (member ? '✓ Certified Level 1' : 'Level 1 course complete – membership needed')
      : 'Level 1 course ' + progress + '% complete – not certified yet',
    memberText: member ? 'Active' + (p.Expires ? ' (renews ' + mdy(p.Expires) + ')' : '') : (p.Expires ? 'Expired ' + mdy(p.Expires) : 'Not active'),
  };
}

// ======================= answers =======================

/** Newest answer per email + event: {key: {eventId: row}}. */
function raLatest_() {
  raTable_();
  const by = {};
  const alias = raAlias_();
  readAll_('RefAvail').forEach(function (r) {
    if (!r.Key || !r.EventID) return;
    if (alias[r.EventID]) r.EventID = alias[r.EventID];
    const m = by[r.Key] || (by[r.Key] = {});
    if (!m[r.EventID] || String(r.UpdatedAt) >= String(m[r.EventID].UpdatedAt)) m[r.EventID] = r;
  });
  return by;
}

// ======================= page API (doPost) =======================

/** Checks a Ref Room token (signed on the academy with the referee feed key). → {uid, email, name, phone} or null. */
function raVerifyToken_(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const key = PropertiesService.getScriptProperties().getProperty('ACADEMY_KEY');
  if (!key) return null;
  const sig = Utilities.computeHmacSha256Signature(parts[0], key).map(function (b) {
    const h = ((b + 256) % 256).toString(16); return h.length === 1 ? '0' + h : h;
  }).join('');
  if (sig !== parts[1]) return null;
  let data;
  try {
    let b64 = parts[0].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    data = JSON.parse(Utilities.newBlob(Utilities.base64Decode(b64)).getDataAsString());
  } catch (err) { return null; }
  if (!data || !data.exp || data.exp * 1000 < Date.now()) return null;
  const email = cleanEmail_(data.email);
  if (!email) return null;
  return { uid: String(data.uid || ''), email: email, name: clean_(data.name, 80), phone: clean_(data.phone, 30) };
}

/** Ref Room: the tournaments, this ref's answers and the events Adam has approved them for. */
function raRoomData_(t) {
  const events = raEvents_();
  const mine = raLatest_()[t.email] || {};
  const apps = raApprovals_();
  const chats = raChats_();
  const any = Object.keys(mine).map(function (k) { return mine[k]; })[0];
  const answers = {};
  Object.keys(mine).forEach(function (id) {
    const r = mine[id];
    if (r.Interested === 'Removed') return;
    answers[id] = { interested: r.Interested, days: r.Days ? r.Days.split(', ') : [], hotel: r.Hotel ? r.Hotel.split(', ') : [],
      restrictions: r.Restrictions, comments: r.Comments };
  });
  const approved = events.filter(function (e) { const a = apps[e.id + '|' + t.email]; return a && a.Approved === 'yes'; })
    .map(function (e) { return { id: e.id, name: e.name, label: e.label, location: e.location, hotel: mine[e.id] ? mine[e.id].Hotel : '', chat: chats[e.id] || '' }; });
  return { ok: true, events: events.map(function (e) { return { id: e.id, name: e.name, label: e.label, location: e.location, days: e.days, nights: e.nights }; }),
    answers: answers, approved: approved, senior: !!raSeniors_().emails[t.email], evaluations: evForRef_(t.email), evAreas: EV_AREAS.map(function (x) { return x[1]; }), generalChat: chats._general || '', name: (any && any.Name) || t.name || '', phone: (any && any.Phone) || t.phone || '', from: (any && any.From) || '' };
}

function refAvailApi_(req) {
  const action = String(req.action || '');
  if (action === 'rr-evdata' || action === 'rr-evsave') return evApi_(req);
  if (action === 'rf-apply') return rapApply_(req);
  if (action === 'rr-bill') {
    const tb = raVerifyToken_(req.token);
    if (!tb) return { ok: false, error: 'Your Ref Room session has expired – please refresh the page.' };
    return { ok: true, bill: billStatus_(tb.email, tb.name) };
  }
  if (action === 'rr-profile') {
    const tp = raVerifyToken_(req.token);
    if (!tp) return { ok: false, error: 'Your Ref Room session has expired – please refresh the page.' };
    try { return { ok: true, msg: rebuildRefProfilesTab_() }; } catch (err) { return { ok: false, error: err.message }; }
  }
  if (action === 'rr-data' || action === 'rr-submit') {
    const t = raVerifyToken_(req.token);
    if (!t) return { ok: false, error: 'Your Ref Room session has expired – please refresh the page.' };
    if (action === 'rr-data') return raRoomData_(t);
    return raSubmit_(t.email, { name: clean_(req.name, 80) || t.name || t.email, phone: req.phone, from: req.from, answers: req.answers });
  }
  if (action === 'ra-lookup' || action === 'ra-submit') {
    return { ok: false, error: 'The availability form has moved to the Ref Room. Log in at academy.usboxla.com/ref-room.' };
  }
  if (action === 'ra-data') {
    return { ok: true, events: raEvents_().map(function (e) { return { id: e.id, name: e.name, label: e.label, days: e.days, nights: e.nights }; }) };
  }
  const email = cleanEmail_(req.email);
  if (!email) return { ok: false, error: 'Please enter a valid email address.' };
  if (action === 'ra-lookup') {
    const st = raAcademyStatus_(email);
    const mine = raLatest_()[email] || {};
    const ids = Object.keys(mine);
    const any = ids.length ? mine[ids[0]] : null;
    const ans = {};
    ids.forEach(function (id) {
      const r = mine[id];
      ans[id] = { interested: r.Interested, days: r.Days ? r.Days.split(', ') : [], hotel: r.Hotel ? r.Hotel.split(', ') : [],
        restrictions: r.Restrictions, comments: r.Comments };
    });
    return { ok: true, status: st.text, membership: st.memberText, certified: st.certified, found: st.found,
      name: any ? any.Name : '', from: any ? any.From : '',
      phoneOnFile: any && any.Phone ? '•••' + String(any.Phone).replace(/\D/g, '').slice(-4) : '',
      answers: ans };
  }
  if (action === 'ra-submit') return raSubmit_(email, req);
  return { ok: false, error: 'Unknown request.' };
}

function raSubmit_(email, req) {
  const name = clean_(req.name, 80);
  if (!name) return { ok: false, error: 'Please enter your name.' };
  const mine = raLatest_()[email] || {};
  const prevPhone = Object.keys(mine).map(function (k) { return mine[k].Phone; }).filter(Boolean)[0] || '';
  const phone = clean_(req.phone, 30) || prevPhone;
  if (!phone) return { ok: false, error: 'Please enter your phone number.' };
  const from = clean_(req.from, 80);
  const events = raEvents_();
  const byId = {};
  events.forEach(function (e) { byId[e.id] = e; });
  const answers = req.answers || {};
  const stamp = nowText_();
  const rows = [];
  Object.keys(answers).forEach(function (id) {
    const ev = byId[id];
    const a = answers[id] || {};
    if (!ev) return;
    if (a.interested === 'clear') {   // "Not sure – remove my answer": newest row wins, so a Removed row hides the old answer
      if (mine[id]) rows.push([email, id, ev.name, name, email, phone, from, 'Removed', '', '', '', '', stamp]);
      return;
    }
    const interested = a.interested === 'yes' ? 'Yes' : a.interested === 'no' ? 'No' : '';
    if (!interested) return;
    const okDays = ev.days.map(function (d) { return d.label; });
    const okNights = ev.nights.map(function (d) { return d.label; });
    const pick = function (list, allowed) { return (Array.isArray(list) ? list : []).map(String).filter(function (x) { return allowed.indexOf(x) !== -1; }); };
    const yes = interested === 'Yes';
    rows.push([email, id, ev.name, name, email, phone, from, interested,
      yes ? pick(a.days, okDays).join(', ') : '', yes ? pick(a.hotel, okNights).join(', ') : '',
      yes ? clean_(a.restrictions, 300) : '', clean_(a.comments, 500), stamp]);
  });
  if (!rows.length) return { ok: false, error: 'Answer Yes or No for at least one tournament.' };
  // (a ref who only removed answers still gets saved: rows holds their Removed rows)
  const sh = raTable_();
  writeRows_(sh, sh.getLastRow() + 1, rows);
  try { rebuildRefAvailTab_(); } catch (err) { console.error('Referee availability tab: ' + err.message); }
  const st = raAcademyStatus_(email);
  return { ok: true, saved: rows.length, status: st.text, certified: st.certified };
}

// ======================= locations (www.usboxla.com events list) =======================

/** City, ST for a Hub event, from the website's event list (public REST, cached 6 hours). '' if no match. */
function raLocation_(ev) {
  const site = raSiteEvents_();
  const words = function (s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(function (w) {
      return w.length > 2 && ['the', 'usboxla', 'box', 'lacrosse', 'presented', 'and'].indexOf(w) === -1;
    });
  };
  const tail = function (s) { const p = String(s || '').split(/\s[–-]\s/); return p.length > 1 ? p[p.length - 1].trim().toLowerCase() : ''; };
  const mine = words(ev.name), myTail = tail(ev.name);
  let best = null, bestScore = 0;
  site.forEach(function (s) {
    if (s.start !== ev.start) return;
    const theirs = words(s.name);
    let score = theirs.filter(function (w) { return mine.indexOf(w) !== -1; }).length;
    if (myTail && tail(s.name) && myTail === tail(s.name)) score += 10;
    if (score > bestScore) { best = s; bestScore = score; }
  });
  return best ? [best.city, best.state].filter(Boolean).join(', ') : '';
}

function raSiteEvents_() {
  if (raSiteEvents_.cache) return raSiteEvents_.cache;
  const cache = CacheService.getScriptCache();
  const hit = cache.get('ra-site-events');
  if (hit) return (raSiteEvents_.cache = JSON.parse(hit));
  let list = [];
  try {
    const res = UrlFetchApp.fetch('https://www.usboxla.com/wp-json/wp/v2/usboxla-events?per_page=100', { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) {
      list = JSON.parse(res.getContentText()).map(function (p) {
        const m = p.meta || {};
        return { name: String((p.title && p.title.rendered) || '').replace(/&#8211;/g, '–').replace(/&amp;/g, '&'),
          start: String(m._ev_start || ''), city: String(m._ev_city || ''), state: String(m._ev_state || '') };
      });
      cache.put('ra-site-events', JSON.stringify(list), 21600);
    }
  } catch (err) { console.error('Website events: ' + err.message); }
  return (raSiteEvents_.cache = list);
}

// ======================= approvals and settings =======================

function raApprovals_() {
  raTable_();
  const by = {};
  const alias = raAlias_();
  readAll_('RefApprovals').forEach(function (r) {
    if (!r.Key || !r.EventID) return;
    if (alias[r.EventID]) r.EventID = alias[r.EventID];
    by[r.EventID + '|' + r.Key] = r;
  });
  return by;
}

function raSettings_() {
  raTable_();
  const by = {};
  const alias = raAlias_();
  readAll_('RefEventSettings').forEach(function (r) {
    if (!r.EventID) return;
    if (alias[r.EventID]) r.EventID = alias[r.EventID];
    by[r.EventID] = r;
  });
  return by;
}

function raSaveApproval_(apps, eventId, key, patch) {
  const k = eventId + '|' + key;
  const r = apps[k];
  const sh = table_('RefApprovals');
  const cols = TABLES.RefApprovals;
  if (r) {
    Object.keys(patch).forEach(function (c) { r[c] = patch[c]; });
    r.UpdatedAt = nowText_();
    writeRows_(sh, r._row, [cols.map(function (c) { return r[c] || ''; })]);
  } else {
    const n = { Key: key, EventID: eventId, Approved: '', Room: '', EmailedAt: '', UpdatedAt: nowText_() };
    Object.keys(patch).forEach(function (c) { n[c] = patch[c]; });
    n._row = sh.getLastRow() + 1;
    writeRows_(sh, n._row, [cols.map(function (c) { return n[c] || ''; })]);
    apps[k] = n;
  }
}

function raSaveSetting_(sets, eventId, patch) {
  const r = sets[eventId];
  const sh = table_('RefEventSettings');
  const cols = TABLES.RefEventSettings;
  if (r) {
    Object.keys(patch).forEach(function (c) { r[c] = patch[c]; });
    r.UpdatedAt = nowText_();
    writeRows_(sh, r._row, [cols.map(function (c) { return r[c] || ''; })]);
  } else {
    const n = { EventID: eventId, Needed: '', HotelNotes: '', UpdatedAt: nowText_() };
    Object.keys(patch).forEach(function (c) { n[c] = patch[c]; });
    n._row = sh.getLastRow() + 1;
    writeRows_(sh, n._row, [cols.map(function (c) { return n[c] || ''; })]);
    sets[eventId] = n;
  }
}

// ======================= GroupMe chat links (Nov 12, 2026) =======================
// One general ref chat (every ref in the Ref Room) + one chat per tournament (only refs Adam approved for it).
// Adam pastes the GroupMe share links on his availability tab; they're kept in the Script Property RA_CHATS.

const RA_CHAT_PROP = 'RA_CHATS';
function raChats_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(RA_CHAT_PROP) || '{}') || {}; } catch (err) { return {}; }
}
function raSaveChats_(c) { PropertiesService.getScriptProperties().setProperty(RA_CHAT_PROP, JSON.stringify(c)); }
/** Only GroupMe share links (https://groupme.com/join_group/…). Anything else is ignored. */
function raCleanChat_(v) {
  // Accepts the link with or without https:// / www. (a pasted 'groupme.com/join_group/…' works too) and stores it as https://groupme.com/…
  const m = String(v || '').match(/(?:https?:\/\/)?(?:www\.|web\.|app\.)?groupme\.com\/([^\s"'<>]+)/i);
  return m ? ('https://groupme.com/' + m[1]).slice(0, 300) : '';
}

/** Emails every ref already approved for a tournament when Adam first adds (or changes) its chat link. */
function raNotifyChat_(eventId, url) {
  const ev = raEvents_().filter(function (e) { return e.id === eventId; })[0];
  if (!ev) return 0;
  const apps = raApprovals_(), latest = raLatest_();
  let sent = 0;
  Object.keys(apps).forEach(function (k) {
    const a = apps[k];
    if (a.EventID !== eventId || a.Approved !== 'yes') return;
    const r = latest[a.Key] && latest[a.Key][eventId];
    const first = r ? String(r.Name).split(' ')[0] : '';
    const ok = sendMail_(a.Key, 'Join the ' + ev.name + ' referee chat', 'Your event ref chat is open', [
      'Hi' + (first ? ' ' + first : '') + ',',
      'The referees approved for ' + ev.name + ' (' + ev.label + ') now have their own GroupMe chat – use it for carpools, hotel, arrival times and anything on the weekend.',
      'It\u2019s just for the refs approved for this tournament – please don\u2019t share the link.',
    ], 'Join the ref chat', url, null, null,
      { replyTo: REF_CHIEF_EMAIL, footer: 'Sent by USBOXLA on behalf of Adam Gardner, Referee-in-Chief.' });
    if (ok) sent++;
  });
  return sent;
}

// ======================= Adam's tab =======================

/** Builds everything shown for each tournament: answers with status + approval, counts, hotel rooms. */
function raModel_(today) {
  today = today || todayIso_();
  const events = raEvents_(today);
  const latest = raLatest_();
  const apps = raApprovals_();
  const sets = raSettings_();
  const chats = raChats_();
  const evRaw = evRaw_();
  const statusCache = {};
  const status = function (email) { return statusCache[email] || (statusCache[email] = raAcademyStatus_(email, today)); };
  return events.map(function (ev) {
    const rows = [];
    Object.keys(latest).forEach(function (email) {
      const r = latest[email][ev.id];
      if (!r) return;
      const a = apps[ev.id + '|' + email] || {};
      if (r.Interested === 'Removed' && a.Approved !== 'yes') return;
      rows.push({ r: r, st: status(email), approved: a.Approved === 'yes', room: String(a.Room || '').trim() });
    });
    rows.sort(function (a, b) {
      return ((a.approved ? 0 : 1) - (b.approved ? 0 : 1)) ||
        ((a.r.Interested === 'Yes' ? 0 : 1) - (b.r.Interested === 'Yes' ? 0 : 1)) ||
        ((a.st.certified ? 0 : 1) - (b.st.certified ? 0 : 1)) || a.r.Name.localeCompare(b.r.Name);
    });
    const s = sets[ev.id] || {};
    return { ev: ev, rows: rows, needed: String(s.Needed || ''), notes: String(s.HotelNotes || ''), chat: chats[ev.id] || '', evaluators: evRaw[ev.id] || '', rooms: raRooms_(ev, rows) };
  });
}

/**
 * Rooms per night for approved refs who asked for that night. Refs with the same Room # share; everyone else is
 * paired 2 per room in name order. → [{night, rooms:[{label, names:[]}]}]
 */
function raRooms_(ev, rows) {
  const approved = rows.filter(function (x) { return x.approved && x.r.Hotel; });
  return ev.nights.map(function (n) {
    const here = approved.filter(function (x) { return x.r.Hotel.split(', ').indexOf(n.label) !== -1; });
    const byRoom = {}, loose = [];
    here.forEach(function (x) {
      if (x.room) (byRoom[x.room] = byRoom[x.room] || []).push(x.r.Name);
      else loose.push(x.r.Name);
    });
    const rooms = Object.keys(byRoom).sort(function (a, b) { return (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b); })
      .map(function (k) { return { label: 'Room ' + k, names: byRoom[k] }; });
    loose.sort();
    let next = 1;
    const used = {};
    Object.keys(byRoom).forEach(function (k) { used[k] = true; });
    for (let i = 0; i < loose.length; i += 2) {
      while (used[String(next)]) next++;
      used[String(next)] = true;
      rooms.push({ label: 'Room ' + next, names: loose.slice(i, i + 2) });
    }
    return { night: n.label, rooms: rooms, refs: here.length };
  }).filter(function (x) { return x.refs; });
}

function raSummaryValues_(m) {
  const yes = m.rows.filter(function (x) { return x.r.Interested === 'Yes'; });
  const approved = m.rows.filter(function (x) { return x.approved; }).length;
  const roomNights = m.rooms.reduce(function (t, n) { return t + n.rooms.length; }, 0);
  const row = [m.ev.name, m.ev.label, m.needed,
    m.needed ? approved + ' of ' + m.needed : String(approved), m.ev.location || '',
    yes.filter(function (x) { return !x.approved; }).length,
    yes.filter(function (x) { return x.st.certified; }).length,
    m.rows.length - yes.length,
    roomNights ? roomNights + ' (' + m.rooms.map(function (n) { return n.night.replace(' night', '') + ': ' + n.rooms.length; }).join(' · ') + ')' : '—',
    m.notes, m.chat || '', m.evaluators || ''];
  while (row.length < RA_W) row.push('');
  return row;
}

function raSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('ADAM_REF_LIST_ID');
  if (!id) return null;
  const ss = SpreadsheetApp.openById(id);
  let sh = ss.getSheetByName(RA_TAB);
  if (!sh) sh = ss.insertSheet(RA_TAB, ss.getNumSheets());
  return sh;
}

/** Rebuilds "Sanctioned Tournament Referee Availability" in Adam's referee sheet. Returns a short summary. */
function rebuildRefAvailTab_() {
  const sh = raSheet_();
  if (!sh) return 'Adam\'s referee sheet doesn\'t exist yet.';
  try { raHarvest_(sh); } catch (err) { console.error('Referee availability (saving Adam\'s edits): ' + err.message); }
  const today = todayIso_();
  const model = raModel_(today);
  const oldFilter = sh.getFilter();
  let keepCrit = null;   // Adam's Tournament pick survives the rebuild
  let keepInt = null;
  const props = PropertiesService.getScriptProperties();
  const firstDefault = props.getProperty('RA_FILTER_V') !== '2';
  if (oldFilter) { try { keepCrit = oldFilter.getColumnFilterCriteria(1); keepInt = oldFilter.getColumnFilterCriteria(6); } catch (err) {} oldFilter.remove(); }
  if (!oldFilter || firstDefault) keepInt = SpreadsheetApp.newFilterCriteria().setHiddenValues(['No']).build();   // default: Interested = Yes only
  props.setProperty('RA_FILTER_V', '2');
  sh.clear();
  sh.clearConditionalFormatRules();
  sh.getRange(1, 1, sh.getMaxRows(), RA_KEY_COL).clearDataValidations();
  const blank = function (first) { const r = [first || '']; while (r.length < RA_W) r.push(''); return r; };
  const out = [], keys = [], fmt = [];
  const push = function (row, key, kind) { out.push(row); keys.push([key || '']); if (kind) fmt.push([out.length, kind]); };

  push(blank('Sanctioned Tournament Referee Availability'), '', 'title');
  push(blank('Refs answer in the Ref Room (log in): ' + RA_PAGE_URL + '   ·   Updated ' + prettyDate_(today) + ' at 8am and after every answer'));
  push(blank('Fill in "Refs needed" for each tournament. Use ▼ on the Tournament column below to show one event (or sort any column). "No" answers are hidden – ▼ on Interested to show them. Tick Approve on a ref to approve them – they get an email right away. ' +
    'Room #: refs with the same number share a hotel room (blank = paired automatically). Hotel notes go on the director\'s "' + RA_HOTEL_TAB + '" tab.'));
  const chats = raChats_();
  const genRow = blank('General ref GroupMe link ✎ – paste it in the yellow cell →'); genRow[1] = chats._general || '';
  push(genRow, 'G', 'gen');
  push(blank());
  const sumHead = ['Tournament', 'Dates', 'Refs needed ✎', 'Approved', 'Location', 'Interested (not approved)', 'Certified & interested',
    'Not interested', 'Hotel rooms (approved refs)', 'Hotel notes for director ✎', 'Event GroupMe link ✎ (approved refs only)', 'Evaluators ✎ (Senior Official first, then up to 2 helpers – names or emails)'];
  while (sumHead.length < RA_W) sumHead.push('');
  push(sumHead, '', 'head');
  const sumStart = out.length + 1;
  model.forEach(function (m) { push(raSummaryValues_(m), 'S|' + m.ev.id); });
  if (!model.length) push(blank('No upcoming sanctioned tournaments on the Hub.'));
  push(blank());

  const head = ['Tournament', 'Dates', 'Approve ✎', 'Room # ✎', 'Referee', 'Interested', 'Level 1 status', 'Membership', 'Waiver', 'Email', 'Phone',
    'Travelling from', 'Days available', 'Hotel nights', 'Schedule restrictions', 'Comments', 'Approval email'];
  push(head, '', 'head');
  const detailStart = out.length + 1;
  const detail = [];
  model.forEach(function (m) {
    m.rows.forEach(function (x) {
      detail.push(x);
      push([m.ev.name, m.ev.label, '', x.room, x.r.Name, x.r.Interested, x.st.text, x.st.memberText, x.st.waiverText, x.r.Email, x.r.Phone, x.r.From,
        x.r.Days || (x.r.Interested === 'Yes' ? 'All days' : ''), x.r.Hotel || (x.r.Interested === 'Yes' ? 'None' : ''),
        x.r.Restrictions, x.r.Comments, ''], 'D|' + m.ev.id + '|' + x.r.Key);
    });
  });
  if (!detail.length) push(blank('No answers yet.'));

  sh.getRange(1, 1, out.length, RA_W).setNumberFormat('@').setValues(out.map(function (r) {
    return r.map(function (v) { return v === null || v === undefined ? '' : String(v); });
  }));
  sh.getRange(1, RA_KEY_COL, keys.length, 1).setValues(keys);
  fmt.forEach(function (f) {
    const rg = sh.getRange(f[0], 1, 1, RA_W);
    if (f[1] === 'title') rg.setFontWeight('bold').setFontSize(14);
    else if (f[1] === 'gen') { sh.getRange(f[0], 1).setFontWeight('bold'); sh.getRange(f[0], 2).setBackground('#FFFBE6'); }
    else rg.setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff').setWrap(true);
  });
  sh.getRange(2, 1, 2, 1).setFontColor('#555555');
  if (model.length) {
    sh.getRange(sumStart, 3, model.length, 1).setBackground('#FFFBE6');
    sh.getRange(sumStart, 10, model.length, 3).setBackground('#FFFBE6').setWrap(true);
    model.forEach(function (m, i) { raColorSummary_(sh, sumStart + i, m); });
  }
  if (detail.length) {
    const apps = raApprovals_();
    sh.getRange(detailStart, 3, detail.length, 1).setNumberFormat('General').insertCheckboxes();
    sh.getRange(detailStart, 3, detail.length, 1).setValues(detail.map(function (x) { return [x.approved]; }));
    sh.getRange(detailStart, 4, detail.length, 1).setBackground('#FFFBE6');
    sh.getRange(detailStart, 1, detail.length, RA_W).setVerticalAlignment('top').setWrap(true);
    detail.forEach(function (x, i) {
      const r = detailStart + i;
      const a = apps[keys[r - 1][0].split('|')[1] + '|' + x.r.Key] || {};
      sh.getRange(r, 17).setValue(a.EmailedAt ? 'Sent ' + a.EmailedAt : '');
      sh.getRange(r, 9).setBackground(x.st.waiver ? '#D4EDDA' : '#FFF3CD');
      if (x.approved) sh.getRange(r, 5, 1, RA_W - 4).setBackground('#E3F4E8');
      else if (x.r.Interested !== 'Yes') sh.getRange(r, 1, 1, RA_W).setFontColor('#888888');
      sh.getRange(r, 7).setBackground(x.st.certified ? '#D4EDDA' : '#FFF3CD');
      if (x.approved && !x.st.certified) sh.getRange(r, 7).setNote('Approved but not certified yet – the approval email asked them to finish Level 1 before the event.');
      if (x.approved && !x.st.waiver) sh.getRange(r, 9).setNote('Approved but the current waiver isn\'t signed – the approval email asked them to sign it in the Ref Room.');
    });
  }
  [210, 115, 90, 90, 150, 95, 210, 140, 130, 220, 220, 140, 160, 160, 200, 220, 130].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  // Filter on the referee rows: Adam can pick one tournament (▼ on Tournament) or sort any column. The hidden key column R is
  // inside the filter, so his ticks and Room #s stay with the right ref when rows move.
  if (detail.length) {
    const f = sh.getRange(detailStart - 1, 1, detail.length + 1, RA_KEY_COL).createFilter();
    if (keepCrit) { try { f.setColumnFilterCriteria(1, keepCrit); } catch (err) {} }
    if (keepInt) { try { f.setColumnFilterCriteria(6, keepInt); } catch (err) {} }
  }
  sh.hideColumns(RA_KEY_COL);
  return 'Referee availability: ' + model.length + ' tournaments, ' + detail.length + ' answers.';
}

/** Approved count turns green when it reaches Refs needed, red when short. */
function raColorSummary_(sh, row, m) {
  const approved = m.rows.filter(function (x) { return x.approved; }).length;
  const need = Number(m.needed) || 0;
  const cell = sh.getRange(row, 4);
  if (!need) cell.setBackground(null).setFontColor('#000000').setFontWeight('normal');
  else if (approved >= need) cell.setBackground('#D4EDDA').setFontColor('#155724').setFontWeight('bold');
  else cell.setBackground('#F8D7DA').setFontColor('#721C24').setFontWeight('bold');
}

/**
 * Reads Adam's editable cells (Approve, Room #, Refs needed, Hotel notes) and saves any changes.
 * Newly approved refs get the approval email (once per ref per tournament). Returns the event IDs that changed.
 */
function raHarvest_(sh) {
  const last = sh.getLastRow();
  if (last < 2 || sh.getMaxColumns() < RA_KEY_COL) return [];
  const vals = sh.getRange(1, 1, last, RA_KEY_COL).getValues();
  const apps = raApprovals_();
  const sets = raSettings_();
  const changed = {};
  const chats = raChats_(), newChats = [];
  let chatsDirty = false;
  const evRaws = evRaw_();
  let evDirty = false;
  vals.forEach(function (r) {
    const key = String(r[RA_KEY_COL - 1] || '');
    if (!key) return;
    const p = key.split('|');
    if (p[0] === 'G') {
      const g = raCleanChat_(r.slice(0, RA_W).join(' '));   // pasted anywhere on the row (A or B) counts
      if (g !== (chats._general || '')) { chats._general = g; chatsDirty = true; }
      return;
    }
    if (p[0] === 'S') {
      const c = raCleanChat_(r[10]);
      const evText = clean_(r[11], 300);
      if (evText !== String(evRaws[p[1]] || '')) { evRaws[p[1]] = evText; evDirty = true; }
      if (c !== (chats[p[1]] || '')) { chats[p[1]] = c; chatsDirty = true; if (c) newChats.push([p[1], c]); }
      const need = String(r[2] === '' || r[2] === null ? '' : r[2]).replace(/[^0-9]/g, '');
      const notes = clean_(r[9], 1000);
      const s = sets[p[1]] || {};
      if (need !== String(s.Needed || '') || notes !== String(s.HotelNotes || '')) {
        raSaveSetting_(sets, p[1], { Needed: need, HotelNotes: notes });
        changed[p[1]] = true;
      }
    } else if (p[0] === 'D') {
      const eventId = p[1], email = p.slice(2).join('|');
      const approved = r[2] === true || String(r[2]).toUpperCase() === 'TRUE';
      const room = clean_(r[3], 10);
      const a = apps[eventId + '|' + email] || {};
      if (approved !== (a.Approved === 'yes') || room !== String(a.Room || '')) {
        raSaveApproval_(apps, eventId, email, { Approved: approved ? 'yes' : '', Room: room });
        changed[eventId] = true;
      }
    }
  });
  if (evDirty) {
    evSaveRaw_(evRaws);
    try { evDaily_(); } catch (err) { console.error('Evaluator invites: ' + err.message); }
    try { rebuildEvalTab_(); } catch (err) { console.error('Evaluations tab: ' + err.message); }
  }
  if (chatsDirty) {
    raSaveChats_(chats);
    newChats.forEach(function (x) { try { raNotifyChat_(x[0], x[1]); } catch (err) { console.error('Chat email ' + x[0] + ': ' + err.message); } });
  }
  const ids = Object.keys(changed);
  if (ids.length) raSendApprovals_(apps);
  return ids;
}

/** Sends the approval email to every approved ref who hasn't had one for that tournament yet. */
function raSendApprovals_(apps) {
  const pending = Object.keys(apps).map(function (k) { return apps[k]; }).filter(function (a) { return a.Approved === 'yes' && !a.EmailedAt; });
  if (!pending.length) return 0;
  const events = {};
  raEvents_().forEach(function (e) { events[e.id] = e; });
  const latest = raLatest_();
  let sent = 0;
  pending.forEach(function (a) {
    const ev = events[a.EventID];
    const r = latest[a.Key] && latest[a.Key][a.EventID];
    if (!ev || !r) return;
    const st = raAcademyStatus_(a.Key);
    const first = String(r.Name).split(' ')[0];
    const where = ev.location ? ' in ' + ev.location : '';
    const paras = [
      'Hi ' + first + ',',
      'Adam Gardner, USBOXLA Referee-in-Chief, has approved you to referee ' + ev.name + ', ' + ev.label + where + '.',
      'Please confirm with Adam to go over the logistics: travel, hotel and your game schedule. Just reply to this email, or contact Adam at ' + REF_CHIEF_EMAIL + '.',
    ];
    if (r.Hotel) paras.push('Hotel nights you asked for: ' + r.Hotel + '. Adam will request the room from the tournament director.');
    if (!st.certified) {
      paras.push('Before the event, please finish your USBOXLA Level 1 referee certification and make sure your referee membership is active. Right now your status is: ' +
        st.text + ' · membership ' + st.memberText.toLowerCase() + '.');
    }
    if (!st.waiver) paras.push('Before the event, please also sign the current USBOXLA referee waiver in the Ref Room.');
    const chat = raChats_()[a.EventID];
    if (chat) paras.push('Join the ' + ev.name + ' referee chat on GroupMe (approved refs only – carpools, hotel, arrival times): ' + chat);
    paras.push('Your approved events and your availability are always in the Ref Room: ' + RA_PAGE_URL);
    const ok = sendMail_(a.Key, 'You\'re approved to referee ' + ev.name + ' (' + ev.label + ')', 'You\'re approved to referee', paras,
      'Open the Ref Room', RA_PAGE_URL, null, null,
      { replyTo: REF_CHIEF_EMAIL, footer: 'Sent by USBOXLA on behalf of Adam Gardner, Referee-in-Chief.' });
    if (ok) {
      raSaveApproval_(apps, a.EventID, a.Key, { EmailedAt: nowText_() });
      sent++;
    }
  });
  return sent;
}

// ======================= Adam edits (installable onEdit trigger on his sheet) =======================

/** Runs when Adam edits his referee sheet: saves approvals / room numbers / refs needed / notes, sends approval emails. */
function raOnEdit(e) {
  try {
    const sh = e && e.range ? e.range.getSheet() : null;
    if (!sh) return;
    if (sh.getName() === BILL_TAB) { billHarvest_(sh); return; }
    if (sh.getName() === EV_TAB) { evHarvest_(sh); return; }
    if (sh.getName() === RAP_TAB) {
      const lk = LockService.getUserLock();
      if (!lk.tryLock(25000)) return;
      try { if (rapHarvest_(sh)) rapRefresh_(sh); } finally { lk.releaseLock(); }
      return;
    }
    if (sh.getName() !== RA_TAB) return;
    const lock = LockService.getUserLock();
    if (!lock.tryLock(25000)) return;   // the next edit or the 8am rebuild picks it up
    try {
      const ids = raHarvest_(sh);
      if (!ids.length) return;
      raRefreshSummary_(sh, ids);
      ids.forEach(function (id) { try { raBuildHotelTab_(id); } catch (err) { console.error('Hotel tab ' + id + ': ' + err.message); } });
    } finally { lock.releaseLock(); }
  } catch (err) { console.error('raOnEdit: ' + err.message); }
}

/** Updates the summary rows (and the email column) in place, without rebuilding the tab under Adam. */
function raRefreshSummary_(sh, ids) {
  const model = raModel_();
  const byId = {};
  model.forEach(function (m) { byId[m.ev.id] = m; });
  const last = sh.getLastRow();
  const keys = sh.getRange(1, RA_KEY_COL, last, 1).getValues();
  const apps = raApprovals_();
  keys.forEach(function (k, i) {
    const p = String(k[0] || '').split('|');
    if (p[0] === 'S' && ids.indexOf(p[1]) !== -1 && byId[p[1]]) {
      const v = raSummaryValues_(byId[p[1]]);
      sh.getRange(i + 1, 4, 1, 1).setValues([[v[3]]]);
      sh.getRange(i + 1, 6, 1, 4).setValues([v.slice(5, 9)]);
      raColorSummary_(sh, i + 1, byId[p[1]]);
    } else if (p[0] === 'D' && ids.indexOf(p[1]) !== -1) {
      const a = apps[p[1] + '|' + p.slice(2).join('|')] || {};
      sh.getRange(i + 1, 17).setValue(a.EmailedAt ? 'Sent ' + a.EmailedAt : '');
      sh.getRange(i + 1, 5, 1, RA_W - 4).setBackground(a.Approved === 'yes' ? '#E3F4E8' : null);
    }
  });
}

// ======================= Director Sheet: Referee Hotel Rooms =======================

/** Builds the "Referee Hotel Rooms" tab on a tournament's Director Sheet (approved refs only, names only). */
function raBuildHotelTab_(eventId) {
  const m = raModel_().filter(function (x) { return x.ev.id === eventId; })[0];
  if (!m) return 'Not an upcoming tournament.';
  const data = readAll_('EventData').filter(function (d) { return d.EventID === eventId; })[0];
  if (!data || !data.DirectorSheetID) return 'No Director Sheet yet.';
  const ss = SpreadsheetApp.openById(data.DirectorSheetID);
  let sh = ss.getSheetByName(RA_HOTEL_TAB);
  const total = m.rooms.reduce(function (t, n) { return t + n.rooms.length; }, 0);
  if (!sh && !total && !m.notes) return 'Nothing to show yet.';
  if (!sh) sh = ss.insertSheet(RA_HOTEL_TAB, ss.getNumSheets());
  sh.clear();
  try { sh.getRange(1, 1, sh.getMaxRows(), 3).breakApart(); } catch (err) { /* nothing merged */ }
  const out = [];
  const fmt = [];
  const row = function (a, b, c, kind) { out.push([a || '', b || '', c || '']); if (kind) fmt.push([out.length, kind]); };
  row('Referee Hotel Rooms – ' + m.ev.name, '', '', 'title');
  row(m.ev.label + (m.ev.location ? ' · ' + m.ev.location : '') + '   ·   Requested by Adam Gardner, USBOXLA Referee-in-Chief (' + REF_CHIEF_EMAIL + ')');
  row('Updated ' + nowText_() + '. Rooms are 2 referees per room. This tab updates automatically when Adam approves referees.');
  row('');
  row('Notes from Adam', '', '', 'head');
  row(m.notes || '—', '', '', 'notes');
  row('');
  row('Night', 'Rooms needed', 'Referees', 'head');
  m.rooms.forEach(function (n) { row(n.night, String(n.rooms.length), n.refs + ' referee' + (n.refs === 1 ? '' : 's')); });
  if (!m.rooms.length) row('No hotel rooms requested yet.');
  if (total) row('Total', total + ' room-night' + (total === 1 ? '' : 's'), '', 'bold');
  row('');
  row('Night', 'Room', 'Referees', 'head');
  m.rooms.forEach(function (n) { n.rooms.forEach(function (r) { row(n.night, r.label, r.names.join(' & ') + (r.names.length === 1 ? ' (single)' : '')); }); });
  sh.getRange(1, 1, out.length, 3).setNumberFormat('@').setValues(out);
  fmt.forEach(function (f) {
    const rg = sh.getRange(f[0], 1, 1, 3);
    if (f[1] === 'title') rg.setFontWeight('bold').setFontSize(14);
    else if (f[1] === 'head') rg.setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff');
    else if (f[1] === 'notes') { rg.merge().setWrap(true).setBackground('#FFFBE6').setVerticalAlignment('top'); sh.setRowHeight(f[0], 60); }
    else rg.setFontWeight('bold');
  });
  sh.getRange(2, 1, 2, 1).setFontColor('#555555');
  sh.setColumnWidth(1, 200); sh.setColumnWidth(2, 140); sh.setColumnWidth(3, 380);
  return 'Hotel rooms for ' + m.ev.name + ': ' + total + ' room-nights.';
}

/** Rebuilds the hotel tab on every upcoming tournament that has approvals or notes (run from the daily job). */
function raBuildAllHotelTabs_() {
  raModel_().forEach(function (m) {
    if (!m.rows.some(function (x) { return x.approved; }) && !m.notes) return;
    try { raBuildHotelTab_(m.ev.id); } catch (err) { console.error('Hotel tab ' + m.ev.name + ': ' + err.message); }
  });
}

// ======================= setup / admin =======================

/** One time: lets Adam edit his sheet and installs the edit trigger that saves approvals and sends the emails. */
function setupRefAvailApprovals() {
  const id = PropertiesService.getScriptProperties().getProperty('ADAM_REF_LIST_ID');
  if (!id) throw new Error('Adam\'s referee sheet doesn\'t exist yet – run sendAdamRefereesListNow first.');
  const ss = SpreadsheetApp.openById(id);
  ss.addEditor(REF_CHIEF_EMAIL);
  const have = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'raOnEdit'; });
  if (!have) ScriptApp.newTrigger('raOnEdit').forSpreadsheet(ss).onEdit().create();
  console.log(rebuildRefAvailTab_());
  console.log('Adam can edit ' + ss.getUrl() + '; edit trigger ' + (have ? 'already installed' : 'installed') + '.');
}

/** Admin: rebuild Adam's availability tab and the directors' hotel tabs now. */
function rebuildRefAvailNow() { console.log(rebuildRefAvailTab_()); raBuildAllHotelTabs_(); }

/** Admin test: what the page would show and what a lookup returns. */
function testRefAvail() {
  console.log(JSON.stringify(raEvents_().map(function (e) { return e.name + ' – ' + e.label + ' – ' + (e.location || '(no location)'); })));
  console.log(JSON.stringify(refAvailApi_({ action: 'ra-lookup', email: 'pbluvol@wscloud.org' })));
  console.log(rebuildRefAvailTab_());
}


// ======================= Referee applicants (Nov 12, 2026) =======================
/*
 * Anyone can apply to become a USBOXLA referee on academy.usboxla.com/become-a-referee (academy mu-plugin usboxla-ref-room.php,
 * shortcode [usboxla_ref_apply]). Applications land in the hidden RefApplicants table and the "Referee Applicants" tab of
 * Adam's referee sheet, where Adam sets a Status for each applicant:
 *   New → Contacted (no email) → Approved (emails the personal invite link) or Declined (emails a polite note).
 * The invite goes to the referee membership checkout (?level=6&invite=CODE). The academy only lets new referee members check
 * out with a matching invite code (first 16 hex of HMAC-SHA256(lowercase email, ACADEMY_KEY)); renewals and discount codes still work.
 */

const RAP_TAB = 'Referee Applicants';
const RAP_COLS = ['AppID', 'Email', 'FirstName', 'LastName', 'Phone', 'City', 'State', 'Adult', 'Years', 'Experience', 'Certs',
  'OtherSports', 'Travel', 'Reference', 'Heard', 'Notes', 'Submitted', 'Approved', 'InvitedAt', 'UpdatedAt', 'Status', 'AdamNotes', 'DeclinedAt'];
const RAP_STATUSES = ['New', 'Contacted', 'Approved', 'Declined'];
const RAP_W = 18;        // visible columns on Adam's applicants tab
const RAP_KEY_COL = 19;  // hidden column S: AppID
const RAP_NOTES_COL = 16;
const RAP_SENT_COL = 17;
const RAP_CHECKOUT = 'https://academy.usboxla.com/membership-account/membership-checkout/?level=6';

function rapTable_() {
  if (!TABLES.RefApplicants) TABLES.RefApplicants = RAP_COLS;
  return table_('RefApplicants');
}

function rapStatus_(a) { return a.Status || (a.Approved === 'yes' ? 'Approved' : 'New'); }

/** The applicant's personal invite code (the academy checks the same code). */
function rapInviteCode_(email) {
  const key = PropertiesService.getScriptProperties().getProperty('ACADEMY_KEY');
  return emailHash_(email, key).slice(0, 16);
}

function rapInviteUrl_(email) {
  return RAP_CHECKOUT + '&invite=' + rapInviteCode_(email) + '&ie=' + encodeURIComponent(email);
}

/** Public: a new application from the academy page. */
function rapApply_(req) {
  const email = cleanEmail_(req.email);
  const first = clean_(req.first, 40), last = clean_(req.last, 40);
  if (!first || !last) return { ok: false, error: 'Please enter your first and last name.' };
  if (!email) return { ok: false, error: 'Please enter a valid email address.' };
  const phone = clean_(req.phone, 30);
  if (!phone) return { ok: false, error: 'Please enter your phone number.' };
  if (clean_(req.website, 50)) return { ok: true };   // honeypot: bots fill every field
  rapTable_();
  const existing = readAll_('RefApplicants').filter(function (r) { return r.Email === email; })[0];
  const list = function (v, n) { return (Array.isArray(v) ? v : [v]).map(function (x) { return clean_(x, 60); }).filter(Boolean).join(', ').slice(0, n); };
  const rec = { AppID: existing ? existing.AppID : 'A' + Utilities.getUuid().replace(/-/g, '').slice(0, 10), Email: email,
    FirstName: first, LastName: last, Phone: phone, City: clean_(req.city, 60), State: clean_(req.state, 40),
    Adult: req.adult === 'yes' ? 'Yes' : req.adult === 'no' ? 'No' : '', Years: clean_(req.years, 20),
    Experience: list(req.experience, 400), Certs: clean_(req.certs, 300), OtherSports: clean_(req.otherSports, 200),
    Travel: clean_(req.travel, 200), Reference: clean_(req.reference, 200), Heard: clean_(req.heard, 100), Notes: clean_(req.notes, 1000),
    Submitted: nowText_(), Approved: existing ? existing.Approved : '', InvitedAt: existing ? existing.InvitedAt : '', UpdatedAt: nowText_(),
    Status: existing ? rapStatus_(existing) : 'New', AdamNotes: existing ? existing.AdamNotes : '', DeclinedAt: existing ? existing.DeclinedAt : '' };
  const sh = table_('RefApplicants');
  const row = existing ? existing._row : sh.getLastRow() + 1;
  writeRows_(sh, row, [RAP_COLS.map(function (c) { return rec[c] || ''; })]);
  try { rebuildApplicantsTab_(); } catch (err) { console.error('Applicants tab: ' + err.message); }
  try {
    sendMail_(REF_CHIEF_EMAIL, 'New referee applicant: ' + first + ' ' + last, 'New referee applicant',
      [first + ' ' + last + (rec.City ? ' from ' + rec.City + (rec.State ? ', ' + rec.State : '') : '') + ' applied to become a USBOXLA referee.',
       'Experience: ' + (rec.Years || '–') + (rec.Experience ? ' · ' + rec.Experience : ''),
       'Set their Status on the "' + RAP_TAB + '" tab: Contacted, Approved (sends their invite) or Declined (sends a polite note).'],
      'Open the applicants', raSheetUrl_(), null, null, { footer: 'Sent automatically when someone applies.' });
  } catch (err) { console.error('Applicant email: ' + err.message); }
  return { ok: true };
}

function raSheetUrl_() {
  const id = PropertiesService.getScriptProperties().getProperty('ADAM_REF_LIST_ID');
  return id ? 'https://docs.google.com/spreadsheets/d/' + id + '/edit' : 'https://docs.google.com/';
}

function rapSentText_(a) {
  return a.InvitedAt ? 'Invite sent ' + a.InvitedAt : a.DeclinedAt ? 'Decline sent ' + a.DeclinedAt : '';
}

function rapRowColor_(status) {
  return status === 'Approved' ? '#E3F4E8' : status === 'Declined' ? '#EEEEEE' : status === 'Contacted' ? '#E8F0FB' : null;
}

/** Rebuilds Adam's "Referee Applicants" tab (newest first). */
function rebuildApplicantsTab_() {
  const id = PropertiesService.getScriptProperties().getProperty('ADAM_REF_LIST_ID');
  if (!id) return 'No referee sheet yet.';
  const ss = SpreadsheetApp.openById(id);
  let sh = ss.getSheetByName(RAP_TAB);
  if (!sh) sh = ss.insertSheet(RAP_TAB, ss.getNumSheets());
  try { rapHarvest_(sh); } catch (err) { console.error('Applicants (saving Adam\'s changes): ' + err.message); }
  rapTable_();
  const apps = readAll_('RefApplicants').sort(function (a, b) { return String(b.Submitted).localeCompare(String(a.Submitted)); });
  sh.clear();
  sh.getRange(1, 1, sh.getMaxRows(), Math.min(sh.getMaxColumns(), RAP_KEY_COL)).clearDataValidations();
  const head = ['Status ✎', 'Applied', 'Name', 'Email', 'Phone', 'City', '18+', 'Years reffing', 'Experience', 'Certifications',
    'Other sports', 'Can travel to', 'Reference', 'Heard about us', 'Anything else', 'Adam\'s notes ✎', 'Emails sent', 'Academy progress'];
  sh.getRange(1, 1, 2, 1).setValues([['Referee Applicants'],
    ['Set a Status for each applicant: Contacted (no email), Approved (emails their personal link to join – referee membership $45/yr – sign the waiver and start the Level 1 course) or Declined (emails a polite note). Adam\'s notes are private. Applications come from academy.usboxla.com/become-a-referee']]);
  sh.getRange(1, 1).setFontWeight('bold').setFontSize(14);
  sh.getRange(2, 1).setFontColor('#555555');
  sh.getRange(4, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff').setWrap(true);
  if (!apps.length) { sh.getRange(5, 1).setValue('No applications yet.'); return 'Applicants: 0'; }
  const rows = apps.map(function (a) {
    const st = raAcademyStatus_(a.Email);
    const progress = !st.found ? (a.InvitedAt ? 'No account yet' : '') :
      (st.certified ? '✓ Certified' : 'Course ' + st.progress + '% · membership ' + (st.member ? 'active' : 'not active')) + (st.waiver ? ' · waiver ✓' : ' · no waiver');
    return [rapStatus_(a), a.Submitted, a.FirstName + ' ' + a.LastName, a.Email, a.Phone, [a.City, a.State].filter(Boolean).join(', '), a.Adult,
      a.Years, a.Experience, a.Certs, a.OtherSports, a.Travel, a.Reference, a.Heard, a.Notes, a.AdamNotes, rapSentText_(a), progress];
  });
  sh.getRange(5, 1, rows.length, head.length).setNumberFormat('@').setValues(rows).setVerticalAlignment('top').setWrap(true);
  sh.getRange(5, 1, rows.length, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(RAP_STATUSES, true).setAllowInvalid(false).build())
    .setFontWeight('bold');
  sh.getRange(5, RAP_NOTES_COL, rows.length, 1).setBackground('#FFFBE6');
  sh.getRange(5, RAP_KEY_COL, rows.length, 1).setValues(apps.map(function (a) { return [a.AppID]; }));
  apps.forEach(function (a, i) {
    const c = rapRowColor_(rapStatus_(a));
    if (c) sh.getRange(5 + i, 2, 1, RAP_NOTES_COL - 2).setBackground(c);
    if (a.Adult === 'No') sh.getRange(5 + i, 7).setBackground('#FFF3CD');
  });
  [110, 120, 150, 200, 115, 140, 50, 90, 220, 200, 140, 160, 180, 120, 240, 220, 150, 220].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.setFrozenRows(4);
  sh.hideColumns(RAP_KEY_COL);
  return 'Applicants: ' + apps.length;
}

/** Saves Adam's Status and notes, and sends the invite (Approved) or decline (Declined) email once. Returns true if anything changed. */
function rapHarvest_(sh) {
  const last = sh.getLastRow();
  if (last < 5 || sh.getMaxColumns() < RAP_KEY_COL) return false;
  const vals = sh.getRange(5, 1, last - 4, RAP_KEY_COL).getValues();
  rapTable_();
  const byId = {};
  readAll_('RefApplicants').forEach(function (a) { byId[a.AppID] = a; });
  const tsh = table_('RefApplicants');
  let changed = false;
  vals.forEach(function (r) {
    const a = byId[String(r[RAP_KEY_COL - 1] || '')];
    if (!a) return;
    const status = RAP_STATUSES.indexOf(String(r[0])) !== -1 ? String(r[0]) : rapStatus_(a);
    const notes = clean_(r[RAP_NOTES_COL - 1], 1000);
    if (status === rapStatus_(a) && notes === String(a.AdamNotes || '')) return;
    a.Status = status;
    a.AdamNotes = notes;
    a.Approved = status === 'Approved' ? 'yes' : '';
    if (status === 'Approved' && !a.InvitedAt && rapSendInvite_(a)) a.InvitedAt = nowText_();
    if (status === 'Declined' && !a.DeclinedAt && !a.InvitedAt && rapSendDecline_(a)) a.DeclinedAt = nowText_();
    a.UpdatedAt = nowText_();
    writeRows_(tsh, a._row, [RAP_COLS.map(function (c) { return a[c] || ''; })]);
    changed = true;
  });
  return changed;
}

function rapSendInvite_(a) {
  return sendMail_(a.Email, 'You\'re approved to become a USBOXLA referee', 'Welcome to USBOXLA officiating',
    ['Hi ' + a.FirstName + ',',
     'Adam Gardner, USBOXLA Referee-in-Chief, has approved your application to become a USBOXLA referee.',
     'Here\'s how to get started:',
     '1. Use the button below to create your USBOXLA Academy account and join as a referee member ($45 per year). Please use this email address (' + a.Email + ') – the link only works with it.',
     '2. Sign the referee waiver in the Ref Room.',
     '3. Complete the USBOXLA Referee Certification Course Level 1 online, at your own pace.',
     'Once you\'re certified you can tell Adam which sanctioned tournaments you\'d like to work, right in the Ref Room: ' + RA_PAGE_URL,
     'Questions? Just reply to this email.'],
    'Join as a USBOXLA referee', rapInviteUrl_(a.Email), null, null,
    { replyTo: REF_CHIEF_EMAIL, footer: 'Sent by USBOXLA on behalf of Adam Gardner, Referee-in-Chief.' });
}

function rapSendDecline_(a) {
  return sendMail_(a.Email, 'Your USBOXLA referee application', 'Thank you for applying',
    ['Hi ' + a.FirstName + ',',
     'Thank you for your interest in officiating with the US Box Lacrosse Association, and for taking the time to apply.',
     'We aren\'t able to move your application forward right now.',
     'You\'re welcome to apply again in the future, and if you have any questions you can reply to this email.',
     'All the best,',
     'Adam Gardner, USBOXLA Referee-in-Chief'],
    null, null, null, null,
    { replyTo: REF_CHIEF_EMAIL, footer: 'Sent by USBOXLA on behalf of Adam Gardner, Referee-in-Chief.' });
}

/** After Adam's edit: update the "Emails sent" cells and row colours in place. */
function rapRefresh_(sh) {
  const last = sh.getLastRow();
  if (last < 5) return;
  rapTable_();
  const byId = {};
  readAll_('RefApplicants').forEach(function (a) { byId[a.AppID] = a; });
  sh.getRange(5, RAP_KEY_COL, last - 4, 1).getValues().forEach(function (k, i) {
    const a = byId[String(k[0] || '')];
    if (!a) return;
    sh.getRange(5 + i, RAP_SENT_COL).setValue(rapSentText_(a));
    sh.getRange(5 + i, 2, 1, RAP_NOTES_COL - 2).setBackground(rapRowColor_(rapStatus_(a)));
  });
}


// ======================= Referee-in-Chief Hub: Overview tab (Nov 12, 2026) =======================
// Adam's sheet is "USBOXLA Referee-in-Chief Hub" (renamed Nov 12; the 8am email subject stays "Adam's Certified Referees List").

const RIC_HUB_NAME = 'USBOXLA Referee-in-Chief Hub';
const RIC_OVERVIEW_TAB = 'Overview';

/** Front tab: quick counts, links, and one row per upcoming tournament with refs needed/approved and its Director Sheet. */
function rebuildOverviewTab_() {
  try { ensureDirPhoneColumn_(eventsSheet_()); } catch (err) { console.error(err); }   // Hub column S "Director Phone"
  const id = PropertiesService.getScriptProperties().getProperty('ADAM_REF_LIST_ID');
  if (!id) return 'No hub yet.';
  const ss = SpreadsheetApp.openById(id);
  if (ss.getName() !== RIC_HUB_NAME) ss.rename(RIC_HUB_NAME);
  let sh = ss.getSheetByName(RIC_OVERVIEW_TAB);
  if (!sh) sh = ss.insertSheet(RIC_OVERVIEW_TAB, 0);
  if (sh.getIndex() !== 1) { ss.setActiveSheet(sh); ss.moveActiveSheet(1); }
  sh.clear();
  const today = todayIso_();
  const certified = readAll_('Referees').filter(function (r) { return r.Name && r.Certified === 'yes' && !(r.Expires && r.Expires < today); }).length;
  rapTable_();
  const apps = readAll_('RefApplicants');
  const newApps = apps.filter(function (a) { return rapStatus_(a) === 'New'; }).length;
  const model = raModel_(today);
  const short = model.filter(function (m) { const n = Number(m.needed) || 0; return n && m.rows.filter(function (x) { return x.approved; }).length < n; }).length;
  const noNeed = model.filter(function (m) { return !m.needed; }).length;
  const dirSheet = {};
  readAll_('EventData').forEach(function (d) { if (d.DirectorSheetID) dirSheet[d.EventID] = 'https://docs.google.com/spreadsheets/d/' + d.DirectorSheetID + '/edit'; });

  const out = [];
  const fmt = [];
  const W = 10;
  const row = function (cells, kind) { while (cells.length < W) cells.push(''); out.push(cells); if (kind) fmt.push([out.length, kind]); };
  row([RIC_HUB_NAME], 'title');
  row(['Updated ' + prettyDate_(today) + ' at 8am (and whenever refs answer). New here? The "' + RIC_GUIDE_TAB + '" tab explains every tab.'], 'sub');
  row(['']);
  row(['At a glance'], 'head');
  row(['Certified referees (course passed, membership current)', String(certified)]);
  row(['New referee applicants waiting for a Status', String(newApps)], newApps ? 'alert' : '');
  row(['Upcoming sanctioned tournaments', String(model.length)]);
  row(['Tournaments short on approved refs', String(short)], short ? 'alert' : '');
  row(['Tournaments without "Refs needed" filled in', String(noNeed)]);
  let toReview = 0;
  try { toReview = evAll_().filter(function (r) { return r.Reviewed !== 'yes'; }).length; } catch (err) {}
  row(['Evaluations waiting for your review (Evaluations tab)', String(toReview)], toReview ? 'alert' : '');
  row(['']);
  row(['Links'], 'head');
  row(['New here? Read the "' + RIC_GUIDE_TAB + '" tab – what every tab is for and what you tick', '→ second tab']);
  row(['Ref Room (refs log in: waiver, course, availability, approved events)', RA_PAGE_URL]);
  row(['Become a USBOXLA Referee (public application)', 'https://academy.usboxla.com/become-a-referee/']);
  row(['Game Sheet practice mode (new refs and tournament scorekeepers)', 'https://academy.usboxla.com/gamesheet-practice/']);
  try { const gc = raChats_()._general; if (gc) row(['General ref GroupMe (message board)', gc]); } catch (err) {}
  row(['Referee course on the academy', 'https://academy.usboxla.com/course/referee-certification-course-level-1']);
  row(['BILL payment setup form (send to refs; also in the course and the Ref Room)', BILL_FORM_URL]);
  row(['BILL payment form responses (see the "' + BILL_TAB + '" tab)', 'https://docs.google.com/spreadsheets/d/' + BILL_SHEET_ID + '/edit']);
  row(['']);
  row(['Tournament', 'Dates', 'Location', 'Refs needed', 'Approved', 'Hotel rooms', 'Director', 'Director email', 'Director phone', 'Director Sheet (Referee Pay, Hotel Rooms, Game Sheet links)'], 'head');
  const firstEv = out.length + 1;
  model.forEach(function (m) {
    const v = raSummaryValues_(m);
    row([m.ev.name, m.ev.label, m.ev.location || '', m.needed || '—', v[3], v[8], m.ev.directorName || '—', m.ev.directorEmail || '—', m.ev.directorPhone || '—', dirSheet[m.ev.id] || (m.ev.hubId ? '' : 'No director yet')]);
  });
  sh.getRange(1, 1, out.length, W).setNumberFormat('@').setValues(out);
  fmt.forEach(function (f) {
    const rg = sh.getRange(f[0], 1, 1, W);
    if (f[1] === 'title') rg.setFontWeight('bold').setFontSize(16);
    else if (f[1] === 'sub') rg.setFontColor('#555555');
    else if (f[1] === 'head') rg.setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff');
    else if (f[1] === 'alert') sh.getRange(f[0], 2).setFontWeight('bold').setBackground('#F8D7DA').setFontColor('#721C24');
  });
  model.forEach(function (m, i) {
    const approved = m.rows.filter(function (x) { return x.approved; }).length, need = Number(m.needed) || 0;
    if (need) sh.getRange(firstEv + i, 5).setFontWeight('bold').setBackground(approved >= need ? '#D4EDDA' : '#F8D7DA').setFontColor(approved >= need ? '#155724' : '#721C24');
  });
  sh.getRange(firstEv, 1, Math.max(1, model.length), W).setVerticalAlignment('top').setWrap(true);
  [300, 130, 150, 95, 95, 220, 150, 220, 120, 330].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.setFrozenRows(1);
  return 'Overview: ' + model.length + ' tournaments, ' + certified + ' certified refs, ' + newApps + ' new applicants.';
}

/** Admin: rename the hub and build the Overview tab now. */
function rebuildOverviewNow() { console.log(rebuildOverviewTab_()); }




// ======================= BILL payment setup (Ref Room step 4) =======================
// Refs fill in the "USBOXLA Referee Payment Setup" Google Form once (linked responses sheet below).
// Adam imports them into BILL and ticks "BILL active" on the "BILL Payment Setup" tab of his Hub.
// The Ref Room shows: Not set up → Details received (watch for the BILL invite) → ✓ Set up.

const BILL_SHEET_ID = '1JgM7YT76leDSQNON_CegFt8ctpUfjOC18chD5-0qPn0';   // responses of form 1jX91JaG54q9S6Qdl_W2bkGAguvlvrHbIogXfPH4dw1I
const BILL_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSd2V5aOvN1SluZKOxqGGPmBr5Mhe_kYiqnyegRtBjueB0badA/viewform';
const BILL_TAB = 'BILL Payment Setup';
const BILL_PROP = 'BILL_ACTIVE';   // JSON { "<lowercase BILL email>" or "name:<lowercase name>": "yyyy-mm-dd" }

const billNorm_ = function (s) { return String(s || '').toLowerCase().replace(/[^a-z]/g, ''); };

/** Form responses: [{at, name, email, phone, city, state}], newest answer per email wins. */
function billResponses_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('bill:responses');
  if (hit) return JSON.parse(hit);
  const sh = SpreadsheetApp.openById(BILL_SHEET_ID).getSheets()[0];
  const vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];
  const head = vals[0].map(function (h) { return String(h).toLowerCase(); });
  const col = function (re) { for (let i = 0; i < head.length; i++) if (re.test(head[i])) return i; return -1; };
  const cT = col(/timestamp/), cN = col(/name/), cE = col(/bill.*email|email.*bill/), cE2 = col(/email/), cP = col(/phone/), cC = col(/city/), cS = col(/state/);
  const byKey = {};
  vals.slice(1).forEach(function (r) {
    const email = cleanEmail_(r[cE >= 0 ? cE : cE2]);
    const name = clean_(r[cN], 80);
    if (!email && !name) return;
    const at = r[cT] instanceof Date ? Utilities.formatDate(r[cT], Session.getScriptTimeZone(), 'yyyy-MM-dd') : clean_(r[cT], 20);
    byKey[email || 'name:' + billNorm_(name)] = { at: at, name: name, email: email, phone: clean_(r[cP], 30), city: clean_(r[cC], 60), state: clean_(r[cS], 30) };
  });
  const out = Object.keys(byKey).map(function (k) { return byKey[k]; }).sort(function (a, b) { return a.at < b.at ? 1 : -1; });
  try { cache.put('bill:responses', JSON.stringify(out), 300); } catch (err) { /* too big to cache */ }
  return out;
}

function billActive_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(BILL_PROP) || '{}'); } catch (err) { return {}; }
}

/** For the Ref Room: none | received | active. Matched on the academy email, else on the name. */
function billStatus_(email, name) {
  email = cleanEmail_(email);
  const active = billActive_();
  const nn = billNorm_(name);
  let resp = null;
  try {
    resp = billResponses_().filter(function (x) { return (email && x.email === email) || (nn && billNorm_(x.name) === nn); })[0] || null;
  } catch (err) { console.error('BILL responses: ' + err.message); }
  const on = (email && active[email]) || (nn && active['name:' + nn]) || (resp && resp.email && active[resp.email]);
  if (on) return { state: 'active', at: on };
  if (resp) return { state: 'received', at: resp.at, form: BILL_FORM_URL };
  return { state: 'none', form: BILL_FORM_URL };
}

/** Adam's "BILL Payment Setup" tab: everyone who filled in the form, then certified refs who haven't. */
function rebuildBillTab_() {
  const id = PropertiesService.getScriptProperties().getProperty('ADAM_REF_LIST_ID');
  if (!id) return 'No referee sheet yet.';
  const ss = SpreadsheetApp.openById(id);
  let sh = ss.getSheetByName(BILL_TAB);
  if (!sh) sh = ss.insertSheet(BILL_TAB, ss.getNumSheets());
  else billHarvest_(sh);
  CacheService.getScriptCache().remove('bill:responses');
  const active = billActive_();
  const resp = billResponses_();
  const seen = {};
  resp.forEach(function (x) { seen[billNorm_(x.name)] = true; });
  const refs = readAll_('Referees').filter(function (r) { return r.Name && r.Certified === 'yes' && !seen[billNorm_(r.Name)]; })
    .sort(function (a, b) { return String(a.Name).localeCompare(String(b.Name)); });
  const W = 8;
  const rows = [['BILL payment setup', '', 'Payment form (send to refs):', BILL_FORM_URL, '', '', '', ''],
    ['Refs fill in the payment form once (it\'s in the Level 1 course and the Ref Room). Import them into BILL, then tick "BILL active" – their Ref Room shows ✓ Set up. Updated ' + nowText_() + '.', '', '', '', '', '', '', ''],
    ['Submitted', 'Name to be paid', 'BILL email', 'Phone', 'City', 'State', 'BILL active ✎', 'key']];
  resp.forEach(function (x) {
    const key = x.email || 'name:' + billNorm_(x.name);
    rows.push([x.at, x.name, x.email, x.phone, x.city, x.state, !!active[key], key]);
  });
  const sepRow = rows.length + 1;
  if (refs.length) {
    rows.push(['', 'Certified referees who haven\'t filled in the form – tick if they\'re already set up in BILL', '', '', '', '', '', '']);
    refs.forEach(function (r) { const key = 'name:' + billNorm_(r.Name); rows.push(['–', r.Name, '', '', '', '', !!active[key], key]); });
  }
  sh.clear(); sh.clearConditionalFormatRules();
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).clearDataValidations();
  if (sh.getMaxColumns() < W) sh.insertColumnsAfter(sh.getMaxColumns(), W - sh.getMaxColumns());
  if (sh.getMaxRows() < rows.length + 5) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 5 - sh.getMaxRows());
  sh.getRange(1, 1, rows.length, W).setValues(rows);
  sh.getRange(1, 1).setFontWeight('bold').setFontSize(14);
  sh.getRange(2, 1).setFontColor('#5d6570');
  sh.getRange(3, 1, 1, W).setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff');
  if (rows.length > 3) {
    const n = rows.length - 3;
    sh.getRange(4, 7, n, 1).insertCheckboxes();
    if (refs.length) {
      sh.getRange(sepRow, 1, 1, W).setValue('').setBackground('#eef0f3');
      sh.getRange(sepRow, 2).setValue('Certified referees who haven\'t filled in the form – tick if they\'re already set up in BILL').setFontWeight('bold');
      sh.getRange(sepRow, 7).removeCheckboxes();
    }
    for (let i = 4; i <= rows.length; i++) if (rows[i - 1][6] === true) sh.getRange(i, 1, 1, 7).setBackground('#E3F4E8');
  }
  sh.setFrozenRows(3);
  [95, 200, 220, 120, 130, 70, 110].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.hideColumns(8);
  return resp.length + ' form responses, ' + refs.length + ' certified refs not on the form';
}

/** Saves Adam's "BILL active" ticks. */
function billHarvest_(sh) {
  const last = sh.getLastRow();
  if (last < 4) return;
  const vals = sh.getRange(4, 7, last - 3, 2).getValues();
  const active = billActive_();
  let changed = false;
  vals.forEach(function (v, i) {
    const key = String(v[1] || ''); if (!key) return;
    if (v[0] === true && !active[key]) { active[key] = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); changed = true; sh.getRange(i + 4, 1, 1, 7).setBackground('#E3F4E8'); }
    else if (v[0] !== true && active[key]) { delete active[key]; changed = true; sh.getRange(i + 4, 1, 1, 7).setBackground(null); }
  });
  if (changed) PropertiesService.getScriptProperties().setProperty(BILL_PROP, JSON.stringify(active));
}

function rebuildBillTabNow() { console.log(rebuildBillTab_()); }


// ======================= BILL payments export (Adam's Hub › "BILL Payments") =======================
// For every event with signed-off games: what each referee is owed (same numbers as the Director Sheet's
// Referee Pay tab), matched to their BILL vendor name from the payment form, plus a CSV per event in BILL's
// "Import bills" format (Vendor Name, Invoice #, Invoice Date, Due Date, Description, Bill Line Item Amount)
// with only the refs not yet ticked Paid. Adam: BILL › Settings › Import/Export › Import Bills › upload the CSV.

const BILLPAY_TAB = 'BILL Payments';
const BILLPAY_DUE_DAYS = 14;

function billExportFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('BILL_EXPORT_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (err) { /* recreate */ } }
  const f = DriveApp.getFolderById(props.getProperty('ROOT_FOLDER_ID')).createFolder('BILL payment exports (referee pay)');
  [REF_CHIEF_EMAIL, 'shaydon@usboxla.com'].forEach(function (em) { try { f.addEditor(em); } catch (err) { console.error('BILL export folder share ' + em + ': ' + err.message); } });
  props.setProperty('BILL_EXPORT_FOLDER_ID', f.getId());
  return f;
}

/** Paid ticks (by referee name) on the event's Director Sheet › Referee Pay tab. */
function billPaidOnDirectorSheet_(data) {
  const paid = {};
  if (!data.DirectorSheetID) return paid;
  try {
    const sh = SpreadsheetApp.openById(data.DirectorSheetID).getSheetByName(REFPAY_TAB);
    if (!sh || sh.getLastRow() <= REFPAY_FIRST) return paid;
    sh.getRange(REFPAY_FIRST + 1, 1, sh.getLastRow() - REFPAY_FIRST, 6).getValues().some(function (r) {
      if (!String(r[0]).trim()) return true;
      if (r[5] === true) paid[String(r[0]).trim().toLowerCase()] = true;
      return false;
    });
  } catch (err) { console.error('Paid ticks ' + data.EventID + ': ' + err.message); }
  return paid;
}

function rebuildBillPaymentsTab_() {
  const hubId = PropertiesService.getScriptProperties().getProperty('ADAM_REF_LIST_ID');
  if (!hubId) return 'No hub yet.';
  const evs = readEventsTab_().filter(function (e) { return e.id; });
  const dataById = {};
  readAll_('EventData').forEach(function (d) { dataById[d.EventID] = d; });
  const docsBy = {};
  readAll_('GameDocs').forEach(function (r) {
    if (!/^games\//.test(r.Path) || !r.Json) return;
    let doc; try { doc = JSON.parse(r.Json); } catch (err) { return; }
    if (doc.final) (docsBy[r.EventID] = docsBy[r.EventID] || []).push({ gid: r.Path.slice(6), doc: doc });
  });
  let resp = [];
  try { resp = billResponses_(); } catch (err) { console.error('BILL responses: ' + err.message); }
  const vendorFor = {};
  resp.forEach(function (x) { vendorFor[billNorm_(x.name)] = x.name; });
  const refs = readAll_('Referees');
  const tz = Session.getScriptTimeZone();
  const mdY = function (iso) { const p = String(iso || '').split('-'); return p.length === 3 ? p[1] + '/' + p[2] + '/' + p[0] : ''; };
  const plusDays = function (iso, n) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); };
  const money = function (n) { return '$' + (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, ''); };

  const W = 7, out = [], fmt = [];
  const row = function (vals, kind) { while (vals.length < W) vals.push(''); out.push(vals); if (kind) fmt.push([out.length, kind]); };
  row(['BILL payments – referee pay by event'], 'title');
  row(['Same amounts as each Director Sheet\'s Referee Pay tab. "Download for BILL" is a CSV of the refs not yet ticked Paid there: BILL › Settings › Import/Export › Import Bills › upload it, then pay the bills in BILL and tick Paid on the Director Sheet. Updated ' + nowText_() + '.'], 'sub');
  let events = 0, owed = 0;
  evs.sort(function (a, b) { return a.start < b.start ? 1 : -1; }).forEach(function (ev) {
    const docs = docsBy[ev.id], data = dataById[ev.id] || {};
    if (!docs || !docs.length) return;
    const rate = ev.refRate || REF_DEFAULT_RATE;
    const boxRate = ev.boxRate === undefined ? Math.round(rate * 50) / 100 : ev.boxRate;
    const pay = refPay_(docs, function () { return {}; }, refs, rate, boxRate);
    const paid = billPaidOnDirectorSheet_(data);
    const invDate = ev.end || ev.start, inv = 'USBOXLA REF ' + ev.id;
    const csv = [['Vendor Name', 'Invoice #', 'Invoice Date', 'Due Date', 'Description', 'Bill Line Item Amount']];
    const lines = [];
    pay.summary.forEach(function (p) {
      if (!p.pay) return;
      const vendor = vendorFor[billNorm_(p.name)] || '';
      const isPaid = !!paid[p.name.toLowerCase()];
      const desc = 'Referee fees – ' + ev.name + ': ' + p.ref + ' game' + (p.ref === 1 ? '' : 's') + ' × ' + money(rate) +
        (p.sk ? ', ' + p.sk + ' penalty box × ' + money(boxRate) : '');
      let note = isPaid ? 'Paid' : !vendor ? 'Not on the BILL payment form – BILL vendor name assumed to be the referee\'s name' : '';
      if (p.status === 'NOT CERTIFIED') note = (note ? note + ' · ' : '') + 'NOT CERTIFIED – check with the director';
      lines.push([p.name, vendor || p.name, p.ref, p.sk, p.pay, isPaid ? 'Yes' : 'No', note]);
      if (!isPaid) { csv.push([vendor || p.name, inv, mdY(invDate), mdY(plusDays(invDate, BILLPAY_DUE_DAYS)), desc, (Math.round(p.pay * 100) / 100).toFixed(2)]); owed += p.pay; }
    });
    if (!lines.length) return;
    events++;
    let link = 'Everyone is paid';
    if (csv.length > 1) {
      const name = 'BILL import – ' + ev.name + ' (' + ev.id + ').csv';
      const body = csv.map(function (r) { return r.map(function (v) { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','); }).join('\r\n');
      const folder = billExportFolder_();
      const old = folder.getFilesByName(name);
      let file;
      if (old.hasNext()) { file = old.next(); file.setContent(body); } else file = folder.createFile(name, body, MimeType.CSV);
      link = 'https://drive.google.com/uc?export=download&id=' + file.getId();
    }
    row(['']);
    row([ev.name + ' · ' + (ev.start || '') + (ev.end && ev.end !== ev.start ? ' to ' + ev.end : ''), '', '', '', 'Download for BILL (unpaid):', link], 'event');
    row(['Referee (game sheet)', 'BILL vendor name', 'Games refereed', 'Penalty box games', 'Amount', 'Paid (Director Sheet)', 'Note'], 'head');
    lines.forEach(function (l) { row(l, l[5] === 'Yes' ? 'paid' : l[6] ? 'warn' : ''); });
  });
  if (!events) row(['No signed-off games yet. Each event appears here once its first game is finalized on the Game Sheet System.']);

  const ss = SpreadsheetApp.openById(hubId);
  let sh = ss.getSheetByName(BILLPAY_TAB);
  if (!sh) sh = ss.insertSheet(BILLPAY_TAB, ss.getNumSheets());
  sh.clear();
  if (sh.getMaxRows() < out.length + 5) sh.insertRowsAfter(sh.getMaxRows(), out.length + 5 - sh.getMaxRows());
  sh.getRange(1, 1, out.length, W).setValues(out);
  fmt.forEach(function (f) {
    const rg = sh.getRange(f[0], 1, 1, W);
    if (f[1] === 'title') rg.setFontWeight('bold').setFontSize(16);
    else if (f[1] === 'sub') sh.getRange(f[0], 1).setFontColor('#555555');
    else if (f[1] === 'event') rg.setFontWeight('bold').setBackground('#eef0f3');
    else if (f[1] === 'head') rg.setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff');
    else if (f[1] === 'paid') rg.setBackground('#E3F4E8');
    else if (f[1] === 'warn') sh.getRange(f[0], 7).setFontColor('#9b1c2c');
  });
  for (let i = 1; i <= out.length; i++) if (out[i - 1][4] !== '' && typeof out[i - 1][4] === 'number') sh.getRange(i, 5).setNumberFormat('$#,##0.00');
  [230, 220, 110, 130, 110, 330, 380].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.setFrozenRows(2);
  return events + ' events, ' + money(owed) + ' unpaid';
}

function rebuildBillPaymentsNow() { console.log(rebuildBillPaymentsTab_()); }


// ======================= "How this Hub works" (Adam's guide tab) =======================

const RIC_GUIDE_TAB = 'How this Hub works';

function rebuildGuideTab_() {
  const id = PropertiesService.getScriptProperties().getProperty('ADAM_REF_LIST_ID');
  if (!id) return 'No hub yet.';
  const ss = SpreadsheetApp.openById(id);
  let sh = ss.getSheetByName(RIC_GUIDE_TAB);
  if (!sh) sh = ss.insertSheet(RIC_GUIDE_TAB, 1);
  sh.clear();
  sh.getRange(1, 1, sh.getMaxRows(), 3).breakApart();
  const tabs = [
    ['Overview', 'Counts at a glance (certified refs, new applicants, tournaments short on refs), the key links, and every upcoming tournament with refs needed / approved, its director (name, email and phone – type the phone in Hub column S) and its Director Sheet.', 'Start here each day. Red numbers need attention.'],
    ['Certified Referees', 'Everyone who can referee today: Level 1 course passed and referee membership current. Senior Officials show "★ Senior Official" after their name.', 'Nothing – read only. It’s also the referee list on the rink tablets (Senior Officials show with a ★ there too).'],
    ['Sanctioned Tournament Referee Availability', 'Row 4: the general ref GroupMe link. Top table: one row per tournament – refs needed, approved "7 of 8" (red/green), hotel rooms, your notes, the event’s GroupMe link and its evaluators. Below: one row per ref per tournament with their Ref Room answers (days, hotel nights, restrictions, waiver, certification). "No" answers are hidden – ▼ on Interested shows them.', '✎ Refs needed. ✎ Tick Approve – the ref gets your approval email once (with the event chat link if there is one). ✎ Room # to pair roommates (blank = paired by name). ✎ Hotel notes for the director. ✎ Row 4: general GroupMe link. ✎ Column K: event GroupMe link – refs already approved get an email with it. ✎ Column L: Evaluators (Senior Official first, then up to 2 helpers – names or emails). Use ▼ on Tournament to show one event.'],
    ['Referee Hotel Rooms (on each Director Sheet)', 'Approved refs only, 2 per room, per night – the tournament director books them.', 'Nothing – it follows your Approve ticks and Room #s.'],
    ['Referee Applicants', 'Everyone who applied at academy.usboxla.com/become-a-referee, newest first, with their experience and academy progress.', '✎ Status: Contacted (no email), Approved (emails them a personal link to join – $45/yr – sign the waiver and take Level 1), Declined (emails a polite note). ✎ Notes.'],
    ['Referee Profiles', 'Each ref’s headshot and optional answers from the Ref Room (hometown, years officiating, other leagues, Indigenous heritage, why they ref, best ref story, Instagram / X / TikTok).', 'Nothing – refs update their own. Use it to put faces to names before an event.'],
    ['Evaluations', 'Private to you. Each evaluator’s personal link and progress per tournament (plus your own link, to enter evaluations from memory), each ref’s average, and every evaluation: 7 areas rated 1–4, strengths, work on, ready for medal games.', '✎ Tick Reviewed – only then does the ref see it in the Ref Room (never with the evaluator’s name). ✎ Your private notes. You get an email when every approved ref at an event has an evaluation.'],
    ['BILL Payment Setup', 'Everyone who filled in the BILL payment form, then certified refs who haven’t. The form link is at the top.', '✎ Tick BILL active once a ref is set up in BILL – their Ref Room then shows ✓ Set up. Send the form to anyone missing.'],
    ['BILL Payments', 'For each event with signed-off games: what each ref is owed (games × Ref Pay Rate + penalty box games × Penalty Box Rate), their BILL vendor name, and a "Download for BILL" CSV of everyone not yet paid.', 'After an event: download the CSV › BILL › Settings › Import/Export › Import Bills › upload › pay the bills in BILL › tick Paid on the event’s Director Sheet (Referee Pay tab).'],
    ['Special Incident Reports', 'Every report a ref sends from the rink tablet (match penalties, injuries, incidents), newest first – you and the event director also get each one by email.', '✎ Follow-up: what was decided (e.g. "1-game suspension", "spoke to coach", "closed").'],
  ];
  const more = [
    ['Where refs go', 'academy.usboxla.com/ref-room – waiver, Level 1 course, membership, BILL status, tournament availability (they can also remove an answer), approved events with each event’s chat, My profile (headshot + questions), My evaluations, and the ref message board.', 'Point every ref there. New refs apply at academy.usboxla.com/become-a-referee.'],
    ['Ref chats (GroupMe)', 'One general message board for every ref in the Ref Room (rules, rulings, game situations, news from you), plus one chat per tournament for the refs approved for it (travel, rides, hotel, social plans).', 'Accept join requests on the general group. For each tournament: create a GroupMe (Hidden), paste its link in column K, delete it after the event, and remove anyone you un-approve.'],
    ['Senior Officials & evaluations', 'Whoever you name first in a tournament’s Evaluators column is its Senior Official (★ in their Ref Room, on Certified Referees and on the tablets). Each evaluator gets their link by email right away, a reminder on the event’s last day and another 2 days after (only if refs are left). One evaluation per ref per event.', 'Name evaluators before each event. Read and tick Reviewed after.'],
    ['Readiness emails', 'A week before each tournament and again 2 days before: every approved ref who still has something to finish (waiver, Level 1 course, membership, BILL setup) gets one email listing exactly what\u2019s left. You get a readiness summary for the event at the same times – who isn\u2019t ready, refs still needed, and whether evaluators and the event GroupMe are set.', 'Nothing – just read your summary and follow up with anyone still not ready.'],
    ['Pay rates', 'Set per event on the main Hub (Events tab): Ref Pay Rate (blank = $55) and Penalty Box Rate (blank = half the ref rate). Tournament scorekeepers are paid by the tournament, not through BILL.', 'Tell Shaydon/Keelan if an event pays differently.'],
    ['At the rink', 'Refs pick their name on the tablet (certified list). Pre-game at Game Sheet System events: count each bench against the dressed players, check numbers and goalies, check the officials. After every goal the Trail Official reports the scorer and 1 assist (penalty shot goals never have an assist). Incident / injury reports are post-game reports – the tablet strongly reminds refs about any match penalty without one. Referee 1 signs off each game. The yellow "? Help" button teaches new scorekeepers.', 'Remind refs before each event.'],
    ['Training', 'Referee Certification Course Level 1 on the academy, including the Game Sheet System unit (Module 2 › Pre-Game: The Game Sheet and Referee Duties). Practice mode anyone can try: academy.usboxla.com/gamesheet-practice/ (made-up teams, nothing saved).', 'Send new refs and volunteer scorekeepers to practice mode before their first event.'],
  ];
  const rows = [
    ['How your Referee-in-Chief Hub works', '', ''],
    ['Everything here updates by itself every morning at 8am (and right after refs or you make changes). Columns marked ✎ are yours to fill in – everything else is filled in for you. Questions: Shaydon. Updated ' + prettyDate_(todayIso_()) + '.', '', ''],
    ['', '', ''],
    ['Tab', 'What it shows', 'What you do'],
  ].concat(tabs).concat([['', '', '']]).concat(more);
  sh.getRange(1, 1, rows.length, 3).setValues(rows).setWrap(true).setVerticalAlignment('top');
  sh.getRange(1, 1, 1, 3).merge().setWrap(false);
  sh.getRange(1, 1).setFontWeight('bold').setFontSize(16);
  sh.getRange(2, 1, 1, 3).merge().setFontColor('#555555');
  sh.getRange(4, 1, 1, 3).setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff');
  sh.getRange(5, 1, tabs.length, 1).setFontWeight('bold');
  const moreStart = 5 + tabs.length + 1;
  sh.getRange(moreStart, 1, more.length, 1).setFontWeight('bold');
  sh.getRange(moreStart, 1, more.length, 3).setBackground('#eef0f3');
  sh.setColumnWidth(1, 230); sh.setColumnWidth(2, 460); sh.setColumnWidth(3, 460);
  sh.setFrozenRows(4);
  return 'Guide tab written';
}
function rebuildGuideNow() { console.log(rebuildGuideTab_()); console.log(rebuildOverviewTab_()); }



// ======================= Referee Profiles (Ref Room "My profile") =======================
// The ref fills in a headshot and optional questions in the Ref Room (academy add-on). The add-on serves them at
// …/wp-json/usboxla/v1/ref-profiles (same key as the referee feed); this writes them to Adam's "Referee Profiles" tab.

const RP_TAB = 'Referee Profiles';

function refProfilesUrl_() {
  const u = academyUrl_();
  return u ? u.replace(/\/[^\/]+\/?$/, '/ref-profiles') : '';
}

function refProfilesFetch_() {
  const url = refProfilesUrl_();
  const key = PropertiesService.getScriptProperties().getProperty('ACADEMY_KEY');
  if (!url || !key) throw new Error('ACADEMY_URL / ACADEMY_KEY not set.');
  const res = UrlFetchApp.fetch(url, { headers: { 'x-usboxla-key': key }, muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() !== 200) throw new Error('The academy answered ' + res.getResponseCode() + ' for ref-profiles (upload the new Ref Room add-on?).');
  const body = JSON.parse(res.getContentText());
  return (body && body.profiles) || [];
}

function rebuildRefProfilesTab_() {
  const id = PropertiesService.getScriptProperties().getProperty('ADAM_REF_LIST_ID');
  if (!id) return 'No hub yet.';
  const list = refProfilesFetch_();
  const latest = raLatest_();
  const nameFor = function (p) {
    const mine = latest[String(p.email || '').toLowerCase()];
    const any = mine && mine[Object.keys(mine)[0]];
    return (any && any.Name) || p.name || p.email;
  };
  const link = function (base, h) { return h ? '=HYPERLINK("' + base + h + '","@' + h + '")' : ''; };
  const rows = list.map(function (p) {
    return [p.photo ? '=IMAGE("' + p.photo + '")' : '', nameFor(p), p.email, p.hometown || '', p.years || '', p.leagues || '',
      p.indigenous === 'Yes' ? 'Yes' + (p.nation ? ' – ' + p.nation : '') : (p.indigenous || ''),
      p.why || '', p.story || '', link('https://instagram.com/', p.instagram), link('https://x.com/', p.x), link('https://www.tiktok.com/@', p.tiktok), p.updated || ''];
  }).sort(function (a, b) { return String(a[1]).localeCompare(String(b[1])); });
  const ss = SpreadsheetApp.openById(id);
  let sh = ss.getSheetByName(RP_TAB);
  if (!sh) sh = ss.insertSheet(RP_TAB, Math.min(ss.getSheets().length, 5));
  sh.clear();
  const head = ['Photo', 'Name', 'Email', 'Hometown', 'Years officiating', 'Other leagues / associations', 'Indigenous heritage', 'Why I ref', 'Best ref story', 'Instagram', 'X', 'TikTok', 'Updated'];
  sh.getRange(1, 1).setValue('Referee profiles from the Ref Room (My profile) – refs fill these in themselves; everything is optional except the headshot. Updated ' + nowText_() + '.')
    .setFontStyle('italic').setFontColor('#5b6577');
  sh.getRange(2, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#0A1D3F').setFontColor('#ffffff');
  sh.setFrozenRows(2);
  if (rows.length) {
    sh.getRange(3, 1, rows.length, head.length).setValues(rows).setVerticalAlignment('middle').setWrap(true);
    sh.setRowHeights(3, rows.length, 80);
  } else {
    sh.getRange(3, 1).setValue('No profiles yet – refs add them in the Ref Room.');
  }
  sh.setColumnWidth(1, 84); sh.setColumnWidth(2, 170); sh.setColumnWidth(3, 210); sh.setColumnWidths(4, 4, 150);
  sh.setColumnWidths(8, 2, 260); sh.setColumnWidths(10, 3, 120); sh.setColumnWidth(13, 120);
  return RP_TAB + ': ' + rows.length + ' profiles.';
}
function rebuildRefProfilesNow() { console.log(rebuildRefProfilesTab_()); }






// ======================= Referee evaluations (Nov 12, 2026) =======================
// Adam names evaluators per tournament on his availability tab (column L: Senior Official first, then up to 2 helpers –
// names or emails). Each gets a personal link to academy.usboxla.com/ref-evaluate/ (a page on the academy that talks to
// this web app with rr-evdata / rr-evsave – no Google page, so no multi-account errors). One evaluation per ref per event
// per evaluator: 7 areas rated 1–4, strengths, work on, ready for medal/championship games. Adam sees everything on his
// private "Evaluations" tab and ticks Reviewed ✎; only then does the ref see it (without the evaluator's name) in the Ref Room.
// Emails: the invite as soon as Adam names someone, a nudge on the event's last day and a final reminder 2 days after
// (only to evaluators with refs left), and a note to Adam once every approved ref has an evaluation.

const EV_TAB = 'Evaluations';
const EV_PAGE_URL = 'https://academy.usboxla.com/ref-evaluate/';
const EV_AREAS = [['pos', 'Positioning & mechanics'], ['sig', 'Signals & whistle'], ['rules', 'Rules knowledge'], ['mgmt', 'Game management'],
  ['sheet', 'Game sheet duties'], ['fit', 'Fitness & hustle'], ['pro', 'Professionalism']];
const EV_SCALE = ['', 'Needs work', 'Developing', 'Solid', 'Excellent'];
const EV_COLS = ['ID', 'EventID', 'EventName', 'RefEmail', 'RefName', 'EvaluatorEmail', 'EvaluatorName', 'Game', 'pos', 'sig', 'rules', 'mgmt', 'sheet',
  'fit', 'pro', 'Ready', 'Strengths', 'WorkOn', 'Reviewed', 'ReviewedAt', 'AdamNotes', 'CreatedAt', 'UpdatedAt'];
const EV_PROP = 'RA_EVALUATORS';
const EV_W = 18;          // visible columns on Adam's Evaluations tab
const EV_KEY_COL = 26;    // hidden column Z: row key (V|id)

function evTable_() { if (!TABLES.RefEvals) TABLES.RefEvals = EV_COLS; return table_('RefEvals'); }
function evAll_() { evTable_(); return readAll_('RefEvals'); }
function evRaw_() { try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(EV_PROP) || '{}') || {}; } catch (err) { return {}; } }
function evSaveRaw_(o) { PropertiesService.getScriptProperties().setProperty(EV_PROP, JSON.stringify(o)); }
function evHex_(bytes) { return bytes.map(function (b) { const h = ((b + 256) % 256).toString(16); return h.length === 1 ? '0' + h : h; }).join(''); }
function evSig_(eventId, email) {
  const key = PropertiesService.getScriptProperties().getProperty('ACADEMY_KEY') || '';
  return evHex_(Utilities.computeHmacSha256Signature('ev|' + eventId + '|' + String(email).toLowerCase(), key)).slice(0, 24);
}
function evLink_(eventId, email) {
  return EV_PAGE_URL + '?ev=' + encodeURIComponent(eventId) + '&e=' + encodeURIComponent(String(email).toLowerCase()) + '&k=' + evSig_(eventId, email);
}
function evAddDays_(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function evAdamEmail_() { return String(REF_CHIEF_EMAIL).toLowerCase(); }
function evHubUrl_() { return 'https://docs.google.com/spreadsheets/d/' + PropertiesService.getScriptProperties().getProperty('ADAM_REF_LIST_ID'); }

/** Every tournament (past ones too – evaluations come in after the event): { id: {id, name, start, end, label} } */
function evEventsById_() {
  const by = {};
  readEventsTab_().forEach(function (e) {
    if (!e.start || e.league) return;
    const id = e.id || raPendingKey_(e);
    by[id] = { id: id, name: e.name, start: e.start, end: e.end || e.start, label: raRange_(e.start, e.end || e.start) };
  });
  return by;
}

/** Refs Adam approved for a tournament: [{email, name}] */
function evApprovedRefs_(eventId) {
  const apps = raApprovals_(), latest = raLatest_(), out = [];
  Object.keys(apps).forEach(function (k) {
    const a = apps[k];
    if (a.EventID !== eventId || a.Approved !== 'yes') return;
    const r = latest[a.Key] && latest[a.Key][eventId];
    out.push({ email: String(a.Key).toLowerCase(), name: (r && r.Name) || a.Key });
  });
  return out.sort(function (x, y) { return x.name.localeCompare(y.name); });
}

/** Adam's text "Jordan Sample, casey@x.com" → { list: [{email, name, lead}], bad: [names it couldn't match] } */
function evParse_(eventId, raw) {
  const refs = evApprovedRefs_(eventId), latest = raLatest_();
  const nameOf = function (em) { const m = latest[em]; const any = m && m[Object.keys(m)[0]]; return any ? any.Name : ''; };
  const out = [], bad = [];
  String(raw || '').split(/[,;\n]+/).map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 3).forEach(function (s, i) {
    let email = cleanEmail_(s), name = '';
    if (email) {
      const r = refs.filter(function (x) { return x.email === email; })[0];
      name = r ? r.name : nameOf(email);
    } else {
      const low = s.toLowerCase();
      let r = refs.filter(function (x) { return x.name.toLowerCase() === low; })[0];
      if (!r) Object.keys(latest).some(function (em) { const n = nameOf(em); if (n && n.toLowerCase() === low) { r = { email: em, name: n }; return true; } return false; });
      if (r) { email = r.email; name = r.name; }
    }
    if (email && !out.some(function (x) { return x.email === email; })) out.push({ email: email, name: name || email, lead: out.length === 0 });
    else if (!email) bad.push(s);
  });
  return { list: out, bad: bad };
}

/** The evaluator behind a link, or null. Adam's own link always works; others only while Adam lists them. */
function evAuth_(req) {
  const ev = String(req.ev || ''), email = cleanEmail_(req.e), k = String(req.k || '');
  if (!ev || !email || !k || k !== evSig_(ev, email)) return null;
  const event = evEventsById_()[ev];
  if (!event) return null;
  const isAdam = email === evAdamEmail_();
  const me = evParse_(ev, evRaw_()[ev]).list.filter(function (x) { return x.email === email; })[0];
  if (!me && !isAdam) return null;
  return { event: event, email: email, name: me ? me.name : 'Adam Gardner', isAdam: isAdam, lead: !!(me && me.lead) };
}

function evAvg_(r) {
  const v = EV_AREAS.map(function (x) { return Number(r[x[0]]) || 0; }).filter(function (n) { return n > 0; });
  return v.length ? Math.round(v.reduce(function (a, b) { return a + b; }, 0) / v.length * 10) / 10 : '';
}

/** Web app actions rr-evdata / rr-evsave (from academy.usboxla.com/ref-evaluate/). */
function evApi_(req) {
  const a = evAuth_(req);
  if (!a) return { ok: false, error: 'This evaluation link isn’t active – ask Adam Gardner (a.gardner@usboxla.com) for a new one.' };
  const refs = evApprovedRefs_(a.event.id).filter(function (r) { return r.email !== a.email; });
  const mine = {};
  evAll_().forEach(function (r) { if (r.EventID === a.event.id && r.EvaluatorEmail === a.email) mine[r.RefEmail] = r; });
  const pack = function (m) {
    return m ? { game: m.Game, scores: EV_AREAS.map(function (x) { return Number(m[x[0]]) || 0; }), ready: m.Ready, strengths: m.Strengths, workon: m.WorkOn } : null;
  };
  if (req.action === 'rr-evdata') {
    return { ok: true, event: { name: a.event.name, label: a.event.label }, evaluator: a.name, lead: a.lead, isAdam: a.isAdam,
      areas: EV_AREAS.map(function (x) { return x[1]; }), scale: EV_SCALE,
      refs: refs.map(function (r) { return { email: r.email, name: r.name, ev: pack(mine[r.email]) }; }) };
  }
  const refEmail = cleanEmail_(req.ref);
  const ref = refs.filter(function (r) { return r.email === refEmail; })[0];
  if (!ref) return { ok: false, error: 'That referee isn’t on this tournament’s approved list.' };
  const scores = Array.isArray(req.scores) ? req.scores : [];
  const vals = EV_AREAS.map(function (x, i) { const n = Math.round(Number(scores[i]) || 0); return n >= 1 && n <= 4 ? String(n) : ''; });
  if (!vals.some(Boolean)) return { ok: false, error: 'Rate at least one area.' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'Busy – please press Save again.' };
  try {
    const old = mine[refEmail];
    const r = old || { ID: newId_('EV'), CreatedAt: nowText_(), Reviewed: '', ReviewedAt: '', AdamNotes: '' };
    const before = old ? JSON.stringify([old.Game, EV_AREAS.map(function (x) { return old[x[0]]; }), old.Ready, old.Strengths, old.WorkOn]) : '';
    r.EventID = a.event.id; r.EventName = a.event.name; r.RefEmail = refEmail; r.RefName = ref.name;
    r.EvaluatorEmail = a.email; r.EvaluatorName = a.name; r.Game = clean_(req.game, 120);
    EV_AREAS.forEach(function (x, i) { r[x[0]] = vals[i]; });
    r.Ready = req.ready === 'yes' ? 'Yes' : req.ready === 'no' ? 'Not yet' : '';
    r.Strengths = clean_(req.strengths, 1000); r.WorkOn = clean_(req.workon, 1000); r.UpdatedAt = nowText_();
    const after = JSON.stringify([r.Game, EV_AREAS.map(function (x) { return r[x[0]]; }), r.Ready, r.Strengths, r.WorkOn]);
    if (old && before !== after && r.Reviewed === 'yes') { r.Reviewed = ''; r.ReviewedAt = ''; }   // changed after Adam reviewed: he reviews again
    if (old) update_('RefEvals', r); else insert_('RefEvals', r);
  } finally { lock.releaseLock(); }
  evQueue_();   // Adam's tab + the "all in" check run a minute later, so the evaluator isn't kept waiting
  return { ok: true };
}

/** Reviewed evaluations for one ref (Ref Room "My evaluations"), newest first – no evaluator names. */
function evForRef_(email) {
  try {
    const byId = evEventsById_();
    return evAll_().filter(function (r) { return r.RefEmail === email && r.Reviewed === 'yes'; }).map(function (r) {
      return { event: r.EventName, label: (byId[r.EventID] || {}).label || '', scores: EV_AREAS.map(function (x) { return Number(r[x[0]]) || 0; }),
        avg: evAvg_(r), ready: r.Ready, strengths: r.Strengths, workon: r.WorkOn, start: (byId[r.EventID] || {}).start || '' };
    }).sort(function (x, y) { return x.start < y.start ? 1 : x.start > y.start ? -1 : 0; });
  } catch (err) { console.error('evForRef_: ' + err.message); return []; }
}

function evMailEvaluator_(eventId, who, kind, left) {
  const props = PropertiesService.getScriptProperties();
  const flag = 'evmail:' + eventId + ':' + who.email + ':' + kind;
  if (props.getProperty(flag)) return false;
  const ev = evEventsById_()[eventId];
  if (!ev) return false;
  const first = String(who.name).split(' ')[0];
  const role = who.lead ? 'the Senior Official' : 'an evaluator';
  const names = (left || []).map(function (r) { return r.name; }).join(', ');
  let subject, heading, paras;
  if (kind === 'invite') {
    subject = 'You’re ' + (who.lead ? 'Senior Official' : 'an evaluator') + ' for ' + ev.name;
    heading = 'Referee evaluations';
    paras = ['Hi ' + first + ',',
      'Adam Gardner, USBOXLA Referee-in-Chief, has named you ' + role + ' for ' + ev.name + ' (' + ev.label + ').',
      'During the event, please watch each referee working it and fill in one short evaluation per referee: 7 areas rated 1 to 4, what they do well, what to work on, and whether they’re ready for medal and championship games. About 2 minutes per referee on your phone – you can come back and change it until Adam reviews it.',
      'Referees only see an evaluation after Adam reviews it, and they never see who wrote it.',
      'The button below is your personal link – please don’t share it.'];
  } else if (kind === 'lastday') {
    subject = 'Today: finish your referee evaluations – ' + ev.name;
    heading = 'Evaluations – last day';
    paras = ['Hi ' + first + ',', 'Today is the last day of ' + ev.name + '. Please finish your evaluations while the games are fresh.', 'Still to do: ' + names + '.'];
  } else {
    subject = 'Reminder: referee evaluations for ' + ev.name;
    heading = 'Evaluations reminder';
    paras = ['Hi ' + first + ',', 'A few evaluations from ' + ev.name + ' are still missing: ' + names + '.', 'Please finish them today if you can – Adam uses them to assign medal and championship games.'];
  }
  const ok = sendMail_(who.email, subject, heading, paras, 'Open my evaluation page', evLink_(eventId, who.email), null, null,
    { replyTo: REF_CHIEF_EMAIL, footer: 'Sent by USBOXLA on behalf of Adam Gardner, Referee-in-Chief.' });
  if (ok) props.setProperty(flag, nowText_());
  return ok;
}

/** Emails Adam once when every approved ref for a tournament has at least one evaluation. */
function evCheckComplete_(eventId) {
  const refs = evApprovedRefs_(eventId);
  if (!refs.length) return;
  const done = {};
  evAll_().forEach(function (r) { if (r.EventID === eventId) done[r.RefEmail] = true; });
  if (!refs.every(function (r) { return done[r.email]; })) return;
  const props = PropertiesService.getScriptProperties(), flag = 'evmail:' + eventId + ':complete';
  if (props.getProperty(flag)) return;
  const ev = evEventsById_()[eventId];
  if (!ev) return;
  const ok = sendMail_(REF_CHIEF_EMAIL, 'Evaluations are in: ' + ev.name, 'Evaluations are in', [
    'Every referee approved for ' + ev.name + ' (' + ev.label + ') now has at least one evaluation.',
    'Open the Evaluations tab on your Hub to read them and tick Reviewed ✎ – referees only see an evaluation after you review it.'],
    'Open my Hub', evHubUrl_(), null, null, {});
  if (ok) props.setProperty(flag, nowText_());
}

/** Daily (and after Adam edits the Evaluators column): invites, last-day nudge, final reminder, completion note. */
function evDaily_() {
  const raw = evRaw_(), today = todayIso_(), byId = evEventsById_();
  let all = null;
  Object.keys(raw).forEach(function (id) {
    const ev = byId[id];
    if (!ev || !raw[id] || today > evAddDays_(ev.end, 7)) return;
    const refs = evApprovedRefs_(id);
    const list = evParse_(id, raw[id]).list;
    if (!list.length) return;
    all = all || evAll_();
    const done = {};
    all.forEach(function (r) { if (r.EventID === id) (done[r.EvaluatorEmail] = done[r.EvaluatorEmail] || {})[r.RefEmail] = true; });
    list.forEach(function (w) {
      const left = refs.filter(function (r) { return r.email !== w.email && !(done[w.email] || {})[r.email]; });
      try {
        evMailEvaluator_(id, w, 'invite');
        if (today === ev.end && left.length) evMailEvaluator_(id, w, 'lastday', left);
        if (today >= evAddDays_(ev.end, 2) && left.length) evMailEvaluator_(id, w, 'final', left);
      } catch (err) { console.error('Evaluation email ' + id + ' ' + w.email + ': ' + err.message); }
    });
    try { evCheckComplete_(id); } catch (err) { console.error('Evaluations complete ' + id + ': ' + err.message); }
  });
}

/** Saves Adam's Reviewed ✎ ticks and notes from the Evaluations tab. */
function evHarvest_(sh) {
  const last = sh.getLastRow();
  if (last < 2 || sh.getMaxColumns() < EV_KEY_COL) return 0;
  const vals = sh.getRange(1, 1, last, EV_KEY_COL).getValues();
  const by = {};
  evAll_().forEach(function (r) { by[r.ID] = r; });
  let n = 0;
  vals.forEach(function (row) {
    const key = String(row[EV_KEY_COL - 1] || '');
    if (key.indexOf('V|') !== 0) return;
    const r = by[key.slice(2)];
    if (!r) return;
    const rev = row[0] === true || String(row[0]).toUpperCase() === 'TRUE' ? 'yes' : '';
    const notes = clean_(row[16], 1000);
    if (rev !== (r.Reviewed || '') || notes !== (r.AdamNotes || '')) {
      if (rev !== (r.Reviewed || '')) r.ReviewedAt = rev ? nowText_() : '';
      r.Reviewed = rev; r.AdamNotes = notes;
      update_('RefEvals', r);
      n++;
    }
  });
  return n;
}

/** Adam's private "Evaluations" tab: evaluator links, averages per ref, every evaluation (Reviewed ✎ / notes ✎). */
function rebuildEvalTab_() {
  const hubId = PropertiesService.getScriptProperties().getProperty('ADAM_REF_LIST_ID');
  if (!hubId) return 'No hub yet.';
  const ss = SpreadsheetApp.openById(hubId);
  let sh = ss.getSheetByName(EV_TAB);
  if (!sh) sh = ss.insertSheet(EV_TAB, Math.min(ss.getSheets().length, 3));
  try { evHarvest_(sh); } catch (err) { console.error('Evaluations (saving Adam’s ticks): ' + err.message); }
  const byId = evEventsById_(), raw = evRaw_(), all = evAll_(), today = todayIso_();
  const out = [], keys = [], fmt = [];
  const blank = function (first) { const r = [first || '']; while (r.length < EV_W) r.push(''); return r; };
  const push = function (row, key, kind) { while (row.length < EV_W) row.push(''); out.push(row); keys.push([key || '']); if (kind) fmt.push([out.length, kind]); };

  push(blank('Referee Evaluations (private – only you see this tab)'), '', 'title');
  push(blank('Name evaluators per tournament in the "Evaluators ✎" column on the availability tab (Senior Official first, then up to 2 helpers). They get their personal link by email right away.'));
  push(blank('Tick Reviewed ✎ when you’ve read an evaluation – only then does the ref see it in the Ref Room (scores, strengths, work on – never the evaluator’s name).'));
  push(blank());

  // A. Links
  push(['Tournament', 'Dates', 'Evaluator', 'Role', 'Refs evaluated', 'Personal evaluation link'], '', 'head');
  const evIds = Object.keys(byId).filter(function (id) {
    const e = byId[id];
    return today <= evAddDays_(e.end, 30) && e.start <= evAddDays_(today, 60) && (raw[id] || evApprovedRefs_(id).length);
  }).sort(function (x, y) { return byId[x].start < byId[y].start ? -1 : 1; });
  if (!evIds.length) push(blank('No tournaments with approved refs or evaluators yet.'));
  evIds.forEach(function (id) {
    const e = byId[id], refs = evApprovedRefs_(id), p = evParse_(id, raw[id]);
    const count = function (em) { return all.filter(function (r) { return r.EventID === id && r.EvaluatorEmail === em; }).length; };
    p.list.forEach(function (w) { push([e.name, e.label, w.name, w.lead ? 'Senior Official' : 'Helper', count(w.email) + ' of ' + refs.filter(function (r) { return r.email !== w.email; }).length, evLink_(id, w.email)]); });
    if (p.bad.length) push([e.name, e.label, 'Couldn’t match: ' + p.bad.join(', '), 'Use their email instead', '', '']);
    push([e.name, e.label, 'You (Adam) – enter from memory', 'Referee-in-Chief', count(evAdamEmail_()) + ' of ' + refs.length, evLink_(id, evAdamEmail_())]);
  });
  push(blank());

  // B. Averages per ref
  push(['Referee', 'Email', 'Evaluations', 'Average (1–4)', 'Ready for medal games? (latest)', 'Latest tournament'], '', 'head');
  const per = {};
  all.forEach(function (r) {
    const p = per[r.RefEmail] || (per[r.RefEmail] = { name: r.RefName, email: r.RefEmail, n: 0, sum: 0, cnt: 0, ready: '', last: '', lastStart: '' });
    p.n++;
    EV_AREAS.forEach(function (x) { const v = Number(r[x[0]]) || 0; if (v) { p.sum += v; p.cnt++; } });
    const st = (byId[r.EventID] || {}).start || '';
    if (st >= p.lastStart) { p.lastStart = st; p.last = r.EventName; if (r.Ready) p.ready = r.Ready; }
  });
  const perList = Object.keys(per).map(function (k) { return per[k]; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  if (!perList.length) push(blank('No evaluations yet.'));
  perList.forEach(function (p) { push([p.name, p.email, String(p.n), p.cnt ? String(Math.round(p.sum / p.cnt * 10) / 10) : '', p.ready, p.last]); });
  push(blank());

  // C. Every evaluation
  const head = ['Reviewed ✎', 'Tournament', 'Referee', 'Evaluator'].concat(EV_AREAS.map(function (x) { return x[1]; }))
    .concat(['Average', 'Ready for medal games?', 'Game watched', 'Strengths', 'Work on', 'Your notes ✎ (private)', 'Updated']);
  push(head.slice(0, EV_W), '', 'head');
  const start = out.length + 1;
  const list = all.slice().sort(function (a, b) { return String(b.UpdatedAt).localeCompare(String(a.UpdatedAt)); });
  list.forEach(function (r) {
    push(['', r.EventName, r.RefName, r.EvaluatorName].concat(EV_AREAS.map(function (x) { return r[x[0]] ? r[x[0]] + ' ' + EV_SCALE[Number(r[x[0]])] : ''; }))
      .concat([String(evAvg_(r)), r.Ready, r.Game, r.Strengths, r.WorkOn, r.AdamNotes, r.UpdatedAt]).slice(0, EV_W), 'V|' + r.ID);
  });
  if (!list.length) push(blank('No evaluations yet.'));

  const old = sh.getFilter(); if (old) old.remove();
  sh.clear();
  sh.getRange(1, 1, sh.getMaxRows(), Math.min(sh.getMaxColumns(), EV_KEY_COL)).clearDataValidations();
  if (sh.getMaxColumns() < EV_KEY_COL) sh.insertColumnsAfter(sh.getMaxColumns(), EV_KEY_COL - sh.getMaxColumns());
  sh.getRange(1, 1, out.length, EV_W).setNumberFormat('@').setValues(out.map(function (r) { return r.map(function (v) { return v === null || v === undefined ? '' : String(v); }); }));
  sh.getRange(1, EV_KEY_COL, keys.length, 1).setValues(keys);
  fmt.forEach(function (f) {
    const rg = sh.getRange(f[0], 1, 1, EV_W);
    if (f[1] === 'title') rg.setFontWeight('bold').setFontSize(14);
    else rg.setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff').setWrap(true);
  });
  sh.getRange(2, 1, 2, 1).setFontColor('#555555');
  if (list.length) {
    sh.getRange(start, 1, list.length, 1).setNumberFormat('General').insertCheckboxes();
    sh.getRange(start, 1, list.length, 1).setValues(list.map(function (r) { return [r.Reviewed === 'yes']; }));
    sh.getRange(start, 17, list.length, 1).setBackground('#FFFBE6');
    sh.getRange(start, 1, list.length, EV_W).setVerticalAlignment('top').setWrap(true);
    list.forEach(function (r, i) { if (r.Reviewed !== 'yes') sh.getRange(start + i, 1, 1, 4).setBackground('#FFF3CD'); });
  }
  [110, 200, 150, 150, 110, 110, 110, 110, 110, 110, 110, 70, 110, 140, 240, 240, 200, 130].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.hideColumns(EV_KEY_COL);
  sh.setFrozenRows(0);
  return EV_TAB + ': ' + list.length + ' evaluations.';
}
function rebuildEvalTabNow() { evDaily_(); console.log(rebuildEvalTab_()); }


// ======================= Senior Officials (Nov 12, 2026) =======================
// A Senior Official is anyone Adam names first in a tournament's "Evaluators ✎" column. Shown as "★ Senior Official" in
// their Ref Room, on the Hub's Certified Referees tab and in the rink tablet's referee picker. (Public profile badges later.)
let RA_SENIORS_MEMO = null;
function raSeniors_() {
  if (RA_SENIORS_MEMO) return RA_SENIORS_MEMO;
  const raw = evRaw_(), emails = {}, ids = {};
  Object.keys(raw).forEach(function (id) { const lead = evParse_(id, raw[id]).list[0]; if (lead) emails[lead.email] = true; });
  const list = Object.keys(emails);
  if (list.length) {
    try {
      coachTables_();
      const key = PropertiesService.getScriptProperties().getProperty('ACADEMY_KEY');
      const byHash = {};
      readAll_('AcademyPeople').forEach(function (r) { if (r.Role === 'ref' && r.EmailHash) byHash[r.EmailHash] = r.AcademyID; });
      list.forEach(function (em) { const h = emailHash_(em, key); if (h && byHash[h]) ids[String(byHash[h])] = true; });
    } catch (err) { console.error('Senior Officials: ' + err.message); }
  }
  RA_SENIORS_MEMO = { emails: emails, ids: ids };
  return RA_SENIORS_MEMO;
}


/** Schedules evDeferred about a minute from now (once – later saves ride along). */
function evQueue_() {
  try {
    const has = ScriptApp.getProjectTriggers().some(function (tr) { return tr.getHandlerFunction() === 'evDeferred'; });
    if (!has) ScriptApp.newTrigger('evDeferred').timeBased().after(60 * 1000).create();
  } catch (err) { console.error('evQueue_: ' + err.message); }
}
/** Rebuilds Adam's Evaluations tab and checks which tournaments now have every ref evaluated. */
function evDeferred() {
  ScriptApp.getProjectTriggers().forEach(function (tr) { if (tr.getHandlerFunction() === 'evDeferred') ScriptApp.deleteTrigger(tr); });
  try { console.log(rebuildEvalTab_()); } catch (err) { console.error('Evaluations tab: ' + err.message); }
  const seen = {};
  evAll_().forEach(function (r) { seen[r.EventID] = true; });
  Object.keys(seen).forEach(function (id) { try { evCheckComplete_(id); } catch (err) { console.error('Evaluations complete ' + id + ': ' + err.message); } });
}


// ======================= Pre-event readiness nudges (Nov 12, 2026) =======================
// About a week before each tournament, and again 2 days before, every approved ref who still has something to finish
// (waiver, Level 1 course, membership, BILL setup) gets one email listing exactly what's left. Adam gets a readiness
// summary for the event at the same two checkpoints (who's not ready, refs still needed, evaluators not named yet).
// Each email is sent once per ref per event per checkpoint (Script Properties rn:<event>:<email>:<checkpoint>).

const RN_CHECKPOINTS = [7, 2];   // days before the start

function raReadiness_(email, name) {
  const st = raAcademyStatus_(email);
  const mdy = function (iso) { return iso ? Number(iso.slice(5, 7)) + '/' + Number(iso.slice(8, 10)) + '/' + iso.slice(0, 4) : ''; };
  const need = [], pay = [];
  if (!st.waiver) need.push(['waiver', 'Sign the current referee waiver (in the Ref Room)']);
  if ((Number(st.progress) || 0) < 100) need.push(['course', 'Finish the Level 1 referee course (' + (Number(st.progress) || 0) + '% done)']);
  if (!st.member) need.push(['membership', st.expires ? 'Renew your referee membership (expired ' + mdy(st.expires) + ')' : 'Activate your referee membership']);
  let bill = null;
  try { bill = billStatus_(email, name); } catch (err) { console.error('Readiness BILL: ' + err.message); }
  if (bill && bill.state === 'none') pay.push(['BILL', 'Set up how you get paid: fill in the BILL payment form (' + BILL_FORM_URL + ')']);
  return { need: need, pay: pay, all: need.concat(pay) };
}

function raReadinessDaily_() {
  const today = todayIso_(), props = PropertiesService.getScriptProperties();
  const sets = raSettings_();
  const dayMs = 86400000;
  raEvents_(today).forEach(function (ev) {
    const days = Math.round((new Date(ev.start + 'T12:00:00Z') - new Date(today + 'T12:00:00Z')) / dayMs);
    if (days < 0 || days > RN_CHECKPOINTS[0]) return;
    const cp = days > RN_CHECKPOINTS[1] ? RN_CHECKPOINTS[0] : RN_CHECKPOINTS[1];   // which checkpoint we're in
    const refs = evApprovedRefs_(ev.id);
    const notReady = [];
    refs.forEach(function (r) {
      let rd;
      try { rd = raReadiness_(r.email, r.name); } catch (err) { console.error('Readiness ' + r.email + ': ' + err.message); return; }
      if (!rd.all.length) return;
      notReady.push({ r: r, rd: rd });
      const flag = 'rn:' + ev.id + ':' + r.email + ':' + cp;
      if (props.getProperty(flag)) return;
      const first = String(r.name).split(' ')[0];
      const paras = ['Hi ' + first + ',',
        'You’re approved to referee ' + ev.name + ' (' + ev.label + ')' + (days === 0 ? ', which starts today.' : ', which starts in ' + days + ' day' + (days === 1 ? '' : 's') + '.')];
      if (rd.need.length) { paras.push('To work your games, please finish:'); rd.need.forEach(function (x) { paras.push('• ' + x[1]); }); }
      if (rd.pay.length) { paras.push(rd.need.length ? 'And so you get paid after the event:' : 'One thing left so you get paid after the event:'); rd.pay.forEach(function (x) { paras.push('• ' + x[1]); }); }
      paras.push('Everything is in the Ref Room. Questions: reply to this email, or call/text Adam Gardner at 647-454-0342.');
      const ok = sendMail_(r.email, 'Before ' + ev.name + ': ' + rd.all.length + ' thing' + (rd.all.length === 1 ? '' : 's') + ' to finish', 'Get ready for ' + ev.name, paras,
        'Open the Ref Room', RA_PAGE_URL, null, null, { replyTo: REF_CHIEF_EMAIL, footer: 'Sent by USBOXLA on behalf of Adam Gardner, Referee-in-Chief.' });
      if (ok) props.setProperty(flag, nowText_());
    });
    // Adam's summary for this checkpoint (sent even with no approved refs yet, so a short event doesn't slip by)
    const af = 'rn:' + ev.id + ':adam:' + cp;
    if (props.getProperty(af)) return;
    const need = Number((sets[ev.id] || {}).Needed) || 0;
    const paras = [ev.name + ' (' + ev.label + (ev.location ? ', ' + ev.location : '') + ') starts ' + (days === 0 ? 'today' : 'in ' + days + ' day' + (days === 1 ? '' : 's')) + '.',
      'Approved referees: ' + refs.length + (need ? ' of ' + need + ' needed' + (refs.length < need ? ' – SHORT ' + (need - refs.length) : ' ✓') : ' (Refs needed isn’t filled in)') + '. Ready: ' + (refs.length - notReady.length) + '.'];
    if (notReady.length) {
      paras.push('Not ready yet – each has been emailed exactly what to finish:');
      notReady.forEach(function (n) { paras.push('• ' + n.r.name + ' – ' + n.rd.all.map(function (x) { return x[0]; }).join(', ')); });
    } else if (refs.length) {
      paras.push('Everyone approved is ready: waiver signed, Level 1 complete, membership active and BILL set up.');
    }
    if (!evRaw_()[ev.id]) paras.push('No evaluators named yet – add the Senior Official (and up to 2 helpers) in the Evaluators column on your availability tab.');
    if (!raChats_()[ev.id]) paras.push('No event GroupMe yet – paste its link in column K and the approved refs get it by email.');
    const ok = sendMail_(REF_CHIEF_EMAIL, 'Referee readiness: ' + ev.name + (days === 0 ? ' starts today' : ' in ' + days + ' day' + (days === 1 ? '' : 's')), 'Referee readiness', paras,
      'Open my Hub', evHubUrl_(), null, null, {});
    if (ok) props.setProperty(af, nowText_());
  });
}


// ======================= Text alerts to Adam (Nov 12, 2026) =======================
// Adam is on TELUS: email-to-text through 10digits@msg.telus.com. TELUS calls this gateway unsupported (it has gone quiet
// at times), so texts are a heads-up only – the full details always go by email too. Change or switch off with the Script
// Property RIC_SMS (blank = off). Used for Special Incident Reports.
const RIC_SMS_DEFAULT = '6474540342@msg.telus.com';
function ricText_(msg) {
  try {
    const p = PropertiesService.getScriptProperties().getProperty('RIC_SMS');
    const to = p === null ? RIC_SMS_DEFAULT : String(p).trim();
    if (!to || MailApp.getRemainingDailyQuota() < 1) return false;
    MailApp.sendEmail({ to: to, subject: 'USBOXLA', body: String(msg).replace(/\s+/g, ' ').slice(0, 140) });
    return true;
  } catch (err) { console.error('Text alert: ' + err.message); return false; }
}



// ======================= GitHub backup (Nov 12, 2026) =======================
// Every day (8am job) the whole project – every .gs file, GameSheetPage.html and the manifest – is copied to the
// private repo github.com/20shaydon/usboxla-apps-script as one commit. A commit is made only when something changed.
// Needs Script Property GITHUB_TOKEN (fine-grained token: that repo only, Contents read/write – Shaydon adds it himself).
// The code is read with Drive's Apps Script export (uses the project's existing Drive permission).
const GH_REPO = '20shaydon/usboxla-apps-script';
const GH_BRANCH = 'main';

function ghApi_(method, path, body) {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('No GITHUB_TOKEN Script Property yet.');
  const res = UrlFetchApp.fetch('https://api.github.com/repos/' + GH_REPO + path, {
    method: method, contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    payload: body ? JSON.stringify(body) : undefined,
  });
  const code = res.getResponseCode();
  if (code >= 300) throw new Error('GitHub ' + method + ' ' + path + ' → ' + code + ': ' + res.getContentText().slice(0, 300));
  return JSON.parse(res.getContentText() || '{}');
}

/** The project's files from Drive: [{path, content}]. */
function ghProjectFiles_() {
  const url = 'https://www.googleapis.com/drive/v3/files/' + ScriptApp.getScriptId() + '/export?mimeType=' + encodeURIComponent('application/vnd.google-apps.script+json');
  const res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Drive export → ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  const ext = { server_js: '.gs', html: '.html', json: '.json' };
  return JSON.parse(res.getContentText()).files.map(function (f) {
    return { path: (f.type === 'json' ? f.name : 'src/' + f.name) + (ext[f.type] || '.txt'), content: f.source };
  });
}

/** Commit the current code to GitHub if anything changed. Returns a short status line. */
function backupToGitHub_() {
  const files = ghProjectFiles_();
  const ref = ghApi_('get', '/git/ref/heads/' + GH_BRANCH);
  const baseCommit = ghApi_('get', '/git/commits/' + ref.object.sha);
  const readme = '# USBOXLA Apps Script backup\n\nDaily copy of the "USBOXLA Event Registration" Apps Script project (script ID ' + ScriptApp.getScriptId() + ').\n' +
    'The live code is in Apps Script – edit it there. This repo is the history and an off-Google backup.\n' +
    'GameSheetPage.html is the source of the rink tablet page (the old gamesheet.src.html build is retired).\n';
  const tree = files.map(function (f) { return { path: f.path, mode: '100644', type: 'blob', content: f.content }; });
  tree.push({ path: 'README.md', mode: '100644', type: 'blob', content: readme });
  // Full tree (no base_tree) so files deleted in Apps Script disappear here too.
  const newTree = ghApi_('post', '/git/trees', { tree: tree });
  if (newTree.sha === baseCommit.tree.sha) return 'GitHub backup: no changes.';
  const when = Utilities.formatDate(new Date(), 'America/New_York', 'MMM d, yyyy h:mm a');
  const commit = ghApi_('post', '/git/commits', { message: 'Apps Script backup – ' + when + ' (' + files.length + ' files)', tree: newTree.sha, parents: [ref.object.sha] });
  ghApi_('patch', '/git/refs/heads/' + GH_BRANCH, { sha: commit.sha });
  return 'GitHub backup: committed ' + files.length + ' files (' + commit.sha.slice(0, 7) + ').';
}

/** Admin: back up to GitHub now. */
function backupToGitHubNow() { console.log(backupToGitHub_()); }


// ======================= Ref Room launch email (Nov 12, 2026) =======================
// One-time email to every referee member on the academy (active + lapsed since 2020), signed by Adam.
// refLaunchTest() sends one copy to Shaydon. refLaunchSendAll() sends the rest in batches (re-run is safe:
// each address is flagged rl:<email> once sent). Remove this section after the launch.
const RL_SUBJECT = 'The USBOXLA Ref Room is open – get set for the season';
const RL_FROM_NAME = 'Adam Gardner – USBOXLA Referee-in-Chief';
const RL_REPLY_TO = 'a.gardner@usboxla.com';

function rlFirst_(f) {
  f = String(f || '').trim().split(' ')[0];
  if (f.length < 2) return '';
  return f.charAt(0).toUpperCase() + f.slice(1).toLowerCase();
}

function rlHtml_(first) {
  const hi = first ? 'Hi ' + first + ',' : 'Hi there,';
  const step = function (n, b, t) {
    return '<tr><td valign="top" width="34" style="padding:0 10px 12px 0"><div style="width:28px;height:28px;line-height:28px;border-radius:14px;background:#0A1D3F;color:#fff;text-align:center;font-weight:bold">' + n + '</div></td>' +
      '<td style="padding:3px 0 12px;font-size:15px;line-height:1.45"><b>' + b + '</b> ' + t + '</td></tr>';
  };
  const li = function (t) {
    return '<tr><td valign="top" style="padding:0 10px 10px 0;color:#C8102E;font-weight:bold">&#9733;</td><td style="padding:0 0 10px;font-size:15px;line-height:1.45">' + t + '</td></tr>';
  };
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F3F5F9;font-family:Arial,Helvetica,sans-serif;color:#1d2430">' +
    '<tr><td align="center" style="padding:24px 12px">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden">' +
    '<tr><td style="background:#0A1D3F;padding:22px 24px"><img src="https://stats.usboxla.com/assets/usboxla-shield.png" alt="USBOXLA" width="44" height="44" style="display:inline-block;vertical-align:middle;border:0">' +
      '<span style="display:inline-block;vertical-align:middle;margin-left:10px;color:#ffffff;font-size:13px;font-weight:bold;letter-spacing:2px;text-transform:uppercase">USBOXLA Referees</span></td></tr>' +
    '<tr><td style="background:#C8102E;height:5px;line-height:5px;font-size:0">&nbsp;</td></tr>' +
    '<tr><td style="padding:28px 28px 6px">' +
      '<h1 style="margin:0 0 14px;font-size:26px;line-height:1.2;color:#0A1D3F">The Ref Room is open</h1>' +
      '<p style="margin:0 0 14px;font-size:16px;line-height:1.5">' + hi + '</p>' +
      '<p style="margin:0 0 14px;font-size:16px;line-height:1.5">Everything you need as a USBOXLA referee now lives in one place: your <b>Ref Room</b> at ' +
        '<a href="https://academy.usboxla.com/ref-room/" style="color:#0A1D3F">academy.usboxla.com/ref-room</a>. Log in with your academy account and you\'ll see four boxes:</p>' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">' +
        step(1, 'Waiver –', 'we updated the Referee and Coach waiver. Please sign the new one (even if you signed before).') +
        step(2, 'Level 1 course –', 'finish (or renew) your online certification for the 2027 rule book. There are a few changes, so get prepared for the upcoming season.') +
        step(3, 'Referee membership –', 'keep it active. If yours has lapsed, the Ref Room has a renew link.') +
        step(4, 'Get paid (BILL) –', 'fill in the short payment form once so we can pay you electronically.') +
      '</table></td></tr>' +
    '<tr><td style="padding:4px 28px 0"><h2 style="margin:0 0 10px;font-size:19px;color:#0A1D3F">Then when you\'re in the Ref Room you can:</h2>' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0">' +
        li('Select which <b>sanctioned tournaments</b> you\'d like to work this season.') +
        li('Add a <b>headshot</b> and fill in your profile so we all know who\'s who on the floor.') +
        li('Join the <b>ref message board</b> on GroupMe. Each tournament you\'re approved for also gets its own chat.') +
        li('New to the USBOXLA Game Sheet System? Try <a href="https://academy.usboxla.com/gamesheet-practice/" style="color:#0A1D3F"><b>practice mode</b></a>.') +
      '</table></td></tr>' +
    '<tr><td align="center" style="padding:14px 28px 24px"><a href="https://academy.usboxla.com/ref-room/" style="display:inline-block;background:#C8102E;color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;padding:14px 32px;border-radius:6px">Open the Ref Room</a></td></tr>' +
    '<tr><td style="padding:0 28px 26px;font-size:15px;line-height:1.5">Questions? Reply to this email, or call/text me at <b>647-454-0342</b>.<br><br>' +
      'Adam Gardner<br><span style="color:#5d6570">USBOXLA Referee-in-Chief</span></td></tr>' +
    '</table></td></tr></table>';
}

function rlText_(first) {
  return (first ? 'Hi ' + first + ',' : 'Hi there,') + '\n\n' +
    'Everything you need as a USBOXLA referee now lives in one place: your Ref Room at https://academy.usboxla.com/ref-room/. Log in with your academy account and you\'ll see four boxes:\n\n' +
    '1. Waiver – we updated the Referee and Coach waiver. Please sign the new one (even if you signed before).\n' +
    '2. Level 1 course – finish (or renew) your online certification for the 2027 rule book. There are a few changes, so get prepared for the upcoming season.\n' +
    '3. Referee membership – keep it active. If yours has lapsed, the Ref Room has a renew link.\n' +
    '4. Get paid (BILL) – fill in the short payment form once so we can pay you electronically.\n\n' +
    'Then when you\'re in the Ref Room you can:\n- Select which sanctioned tournaments you\'d like to work this season.\n' +
    '- Add a headshot and fill in your profile so we all know who\'s who on the floor.\n' +
    '- Join the ref message board on GroupMe. Each tournament you\'re approved for also gets its own chat.\n' +
    '- New to the USBOXLA Game Sheet System? Try practice mode: https://academy.usboxla.com/gamesheet-practice/\n\n' +
    'Open the Ref Room: https://academy.usboxla.com/ref-room/\n\n' +
    'Questions? Reply to this email, or call/text me at 647-454-0342.\n\nAdam Gardner\nUSBOXLA Referee-in-Chief';
}

function rlSend_(to, first) {
  MailApp.sendEmail({ to: to, subject: RL_SUBJECT, htmlBody: rlHtml_(first), body: rlText_(first), name: RL_FROM_NAME, replyTo: RL_REPLY_TO });
}

/** Admin: one test copy to Shaydon. */
function refLaunchTest() { rlSend_('shaydon@usboxla.com', 'Shaydon'); console.log('Test sent to shaydon@usboxla.com'); }

/** Admin: send to everyone on REF_LAUNCH_LIST not yet sent. Safe to re-run; stops after ~5 minutes or when the mail quota runs low. */
function refLaunchSendAll() {
  const props = PropertiesService.getScriptProperties(), start = Date.now();
  let sent = 0, skipped = 0, failed = [];
  for (let i = 0; i < REF_LAUNCH_LIST.length; i++) {
    const e = String(REF_LAUNCH_LIST[i][0]).trim().toLowerCase(), key = 'rl:' + e;
    if (props.getProperty(key)) { skipped++; continue; }
    if (Date.now() - start > 300000 || MailApp.getRemainingDailyQuota() < 20) break;
    try { rlSend_(e, rlFirst_(REF_LAUNCH_LIST[i][1])); props.setProperty(key, new Date().toISOString()); sent++; }
    catch (err) { failed.push(e + ': ' + err.message); }
  }
  const left = REF_LAUNCH_LIST.filter(function (r) { return !props.getProperty('rl:' + String(r[0]).trim().toLowerCase()); }).length;
  console.log('Sent ' + sent + ', already sent ' + skipped + ', failed ' + failed.length + ', still to send ' + left + ', quota left ' + MailApp.getRemainingDailyQuota());
  if (failed.length) console.log(failed.join('\n'));
}
const REF_LAUNCH_LIST = [];   // filled in after the test is approved
