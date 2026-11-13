/**
 * USBOXLA Player Pool — keeps a master list of every eligible member,
 * synced from Wild Apricot. Players already in it are verified automatically
 * the moment a team manager adds them to a roster.
 *
 * Part of the USBOXLA Event Registration project (see Setup.gs).
 *
 * Setup is covered in SETUP at the top of Setup.gs. Optional Script Property:
 *        CITY_FIELD_NAME  = your city field name in Wild Apricot, if you have one
 */

const POOL_SHEET = 'Pool';
const POOL_HEADERS = ['Member ID', 'First name', 'Last name', 'DOB', 'Birth year', 'City',
                      'Level', 'Status', 'Valid through', 'Last synced'];
// Statuses where the current membership is paid and in force.
const ELIGIBLE_STATUSES = ['Active', 'PendingRenewal', 'PendingUpgrade'];
const PAGE_SIZE = 100;
const LIST_PAUSE_MS = 1600; // Wild Apricot allows 40 contact-list calls per minute

/** Pulls every eligible member from Wild Apricot and rewrites the Pool tab. */
function syncPool() {
  // Downloading takes minutes, so it runs WITHOUT the script lock (parents and the
  // sheet scan keep working). The lock is held only for the few seconds of writing.
  const cache = CacheService.getScriptCache();
  if (cache.get('pool_sync_running')) { console.log('Sync already running; skipped.'); return; }
  cache.put('pool_sync_running', '1', 600);
  try {
    const cfg = getConfig_();
    const cityField = PropertiesService.getScriptProperties().getProperty('CITY_FIELD_NAME');
    const now = new Date();
    const rows = [];
    const profiles = []; // members who made their player profile public (stats.usboxla.com)
    const seen = {};
    const ccMembers = []; // name + email for Constant Contact
    let calls = 0;

    ELIGIBLE_STATUSES.forEach(function (status) {
      let skip = 0;
      while (true) {
        if (calls++ > 0) Utilities.sleep(LIST_PAUSE_MS);
        const filter = encodeURIComponent("(Status eq '" + status + "')AND(Archived eq false)");
        const data = waGet_('/contacts?$async=false&$top=' + PAGE_SIZE + '&$skip=' + skip + '&$filter=' + filter);
        const list = (data && data.Contacts) || [];
        list.forEach(function (c) {
          if (!c.MembershipEnabled || seen[c.Id]) return;
          seen[c.Id] = true;
          rows.push(poolRow_(c, cfg, cityField, now));
          ccMembers.push({ id: String(c.Id), email: String(c.Email || '').trim(), first: c.FirstName || '', last: c.LastName || '' });
          try { const p = profileFromContact_(c); if (p) profiles.push(p); } catch (err) { console.error(err); }
        });
        if (list.length < PAGE_SIZE) break;
        skip += PAGE_SIZE;
      }
    });

    // Public players who lapsed keep a (locked after 30 days) page – see Profiles.gs › lapsed members.
    try {
      const activeIds = {};
      profiles.forEach(function (p) { activeIds[p.memberId] = true; });
      Object.keys(seen).forEach(function (id) { activeIds[id] = true; });
      carryLapsed_(readProfiles_(), activeIds, function (id) { Utilities.sleep(250); return getContact_(id); }, todayIso_(), LAPSED_CHECKS_PER_SYNC)
        .forEach(function (p) { profiles.push(p); });
    } catch (err) { console.error('Lapsed profiles: ' + err.message); }

    rows.sort(function (a, b) {
      return (a[2] + ' ' + a[1]).toLowerCase() < (b[2] + ' ' + b[1]).toLowerCase() ? -1 : 1;
    });

    withLock_(function () {
      const sheet = poolSheet_();
      const previous = Math.max(0, sheet.getLastRow() - 1);
      // Safety: never wipe a healthy pool because of a bad response.
      if (previous > 20 && rows.length < previous * 0.5) {
        throw new Error('Sync returned ' + rows.length + ' members vs ' + previous +
          ' last time. Pool left unchanged; check Wild Apricot and run syncPool() again.');
      }
      if (previous > 0) sheet.getRange(2, 1, previous, POOL_HEADERS.length).clearContent();
      writeRows_(sheet, 2, rows);
      saveProfiles_(profiles);
    });
    console.log('Pool synced: ' + rows.length + ' eligible members (' + calls + ' API calls).');
    // Families who joined or renewed directly in Wild Apricot get verified within the hour.
    try { rematchUnverified_(); } catch (err) { console.error(err); }
    // New members join the Constant Contact members list (see the Constant Contact section below).
    try {
      const props = PropertiesService.getScriptProperties();
      const all = props.getProperty('CC_CATCHUP') === 'yes';
      ccSyncMembers_(ccMembers, all);
      if (all) props.deleteProperty('CC_CATCHUP');
    } catch (err) { console.error('Constant Contact: ' + err.message); }
  } finally {
    cache.remove('pool_sync_running');
  }
}

/**
 * The "just joined" path: pulls one member straight into the pool without
 * waiting for the hourly sync. Requires a matching DOB, same as the player check.
 */
function addToPoolNow(memberId, dob) {
  const r = checkMember(memberId, dob, todayIso_());
  if (!r.ok) return r;
  const cfg = getConfig_();
  const cityField = PropertiesService.getScriptProperties().getProperty('CITY_FIELD_NAME');
  const contact = getContact_(String(memberId).replace(/\D/g, ''));
  const row = poolRow_(contact, cfg, cityField, new Date());

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = poolSheet_();
    const last = sheet.getLastRow();
    const ids = last > 1 ? sheet.getRange(2, 1, last - 1, 1).getValues().map(function (v) { return String(v[0]); }) : [];
    const at = ids.indexOf(String(row[0]));
    writeRows_(sheet, at === -1 ? last + 1 : at + 2, [row]);
  } finally {
    lock.releaseLock();
  }
  r.addedToPool = true;
  return r;
}

/** Run once: syncs the pool every hour. */
function installSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncPool') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncPool').timeBased().everyHours(1).create();
  console.log('Hourly pool sync installed.');
}

// ---------- internals ----------

function poolRow_(c, cfg, cityField, now) {
  const dob = toIsoDate_(fieldValue_(c, [cfg.dobField])) || '';
  const renewal = toIsoDate_(fieldValue_(c, ['RenewalDue', 'Renewal due'])) || '';
  const city = cityField ? (fieldValue_(c, [cityField]) || '') : '';
  return [
    String(c.Id),
    c.FirstName || '',
    c.LastName || '',
    dob,
    dob ? dob.slice(0, 4) : '',
    String(city),
    c.MembershipLevel ? c.MembershipLevel.Name : '',
    c.Status || '',
    renewal,          // blank = membership level never expires
    Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'),
  ];
}

function poolSheet_() {
  return table_(POOL_SHEET, POOL_HEADERS);
}

/** Pool rows as objects (used for automatic matching). */
function readPool_() {
  const sh = poolSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, POOL_HEADERS.length).getValues().map(function (r) {
    return { id: cellText_(r[0]), first: cellText_(r[1]), last: cellText_(r[2]),
             dob: cellText_(r[3]), validThrough: cellText_(r[8]) };
  });
}

// ---------- Constant Contact: new members join the "USBOXLA Members (auto)" list ----------
// Script Properties (pasted by the account owner): CC_CLIENT_ID, CC_CLIENT_SECRET.
// Run ccConnect() once, open the link it logs, click Allow – that saves CC_REFRESH_TOKEN.
// Every pool sync then adds members it hasn't sent before (name + email only) with one bulk import.
// Imports never re-subscribe someone who unsubscribed in Constant Contact.
// The first run only records today's members as "already sent" unless ccCatchUpNow() is used.

const CC_AUTH = 'https://authz.constantcontact.com/oauth2/default/v1';
const CC_API = 'https://api.cc.email/v3';
const CC_LIST_NAME = 'USBOXLA Members (auto)';
const CC_TABLE = 'CCSync';
const CC_HEADERS = ['MemberID', 'Email', 'Synced'];

// Constant Contact sends the person back to the deployed web app (doGet › ccWebCallback_), which runs as the owner.
const CC_REDIRECT = 'https://script.google.com/macros/s/AKfycbwO5iosoEOy8x8ouwiTt00qKi9A_FHT9sc6TonO_oqt3Rlnk9CxeKDodoDhQ1LpIM_q/exec';
function ccRedirectUri_() { return PropertiesService.getScriptProperties().getProperty('CC_REDIRECT_URI') || CC_REDIRECT; }

/** Run once from the editor: logs the link to connect Constant Contact. */
function ccConnect() {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('CC_CLIENT_ID') || !p.getProperty('CC_CLIENT_SECRET')) throw new Error('Add CC_CLIENT_ID and CC_CLIENT_SECRET in Project Settings › Script Properties first.');
  const state = 'cc-' + Utilities.getUuid();
  CacheService.getScriptCache().put('cc_state', state, 3600);
  const url = CC_AUTH + '/authorize?client_id=' + encodeURIComponent(p.getProperty('CC_CLIENT_ID')) +
    '&redirect_uri=' + encodeURIComponent(ccRedirectUri_()) + '&response_type=code&scope=' +
    encodeURIComponent('contact_data campaign_data offline_access') + '&state=' + encodeURIComponent(state);
  console.log('Open this link, sign in to Constant Contact if asked, and click Allow:\n' + url);
  return url;
}

/** doGet hands Constant Contact's redirect (?code=…&state=cc-…) here. */
function ccWebCallback_(e) {
  const want = CacheService.getScriptCache().get('cc_state');
  if (!want || e.parameter.state !== want) return HtmlService.createHtmlOutput('<p style="font-family:Arial">This connect link has expired – run ccConnect() again.</p>');
  CacheService.getScriptCache().remove('cc_state');
  return ccAuthCallback(e);
}

function ccAuthCallback(req) {
  const code = req.parameter.code;
  if (!code) return HtmlService.createHtmlOutput('Constant Contact did not send a code: ' + (req.parameter.error_description || req.parameter.error || 'unknown'));
  const tok = ccToken_({ grant_type: 'authorization_code', code: code, redirect_uri: ccRedirectUri_() });
  return HtmlService.createHtmlOutput(tok ? '<h2 style="font-family:Arial">Constant Contact connected ✓</h2><p style="font-family:Arial">You can close this tab.</p>'
    : 'Could not finish connecting – check the execution log.');
}

function ccToken_(form) {
  const p = PropertiesService.getScriptProperties();
  const res = UrlFetchApp.fetch(CC_AUTH + '/token', {
    method: 'post', muteHttpExceptions: true, payload: form,
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(p.getProperty('CC_CLIENT_ID') + ':' + p.getProperty('CC_CLIENT_SECRET')) },
  });
  if (res.getResponseCode() !== 200) { console.error('CC token ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300)); return null; }
  const j = JSON.parse(res.getContentText());
  if (j.refresh_token) p.setProperty('CC_REFRESH_TOKEN', j.refresh_token);
  CacheService.getScriptCache().put('cc_access', j.access_token, Math.min(21600, Math.max(60, (j.expires_in || 3600) - 300)));
  return j.access_token;
}

function ccAccess_() {
  const cached = CacheService.getScriptCache().get('cc_access');
  if (cached) return cached;
  const rt = PropertiesService.getScriptProperties().getProperty('CC_REFRESH_TOKEN');
  return rt ? ccToken_({ grant_type: 'refresh_token', refresh_token: rt }) : null;
}

function ccCall_(method, path, body) {
  const t = ccAccess_();
  if (!t) throw new Error('Constant Contact is not connected – run ccConnect().');
  const res = UrlFetchApp.fetch(CC_API + path, {
    method: method, muteHttpExceptions: true, contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + t }, payload: body ? JSON.stringify(body) : undefined,
  });
  const c = res.getResponseCode();
  if (c >= 300) throw new Error('Constant Contact ' + method.toUpperCase() + ' ' + path.split('?')[0] + ' → ' + c + ': ' + res.getContentText().slice(0, 300));
  return c === 204 ? {} : JSON.parse(res.getContentText() || '{}');
}

/** The members list's id (created the first time). */
function ccListId_() {
  const p = PropertiesService.getScriptProperties();
  const saved = p.getProperty('CC_LIST_ID');
  if (saved) return saved;
  const lists = (ccCall_('get', '/contact_lists?limit=1000').lists || []);
  let l = lists.filter(function (x) { return x.name === CC_LIST_NAME; })[0];
  if (!l) l = ccCall_('post', '/contact_lists', { name: CC_LIST_NAME, favorite: true, description: 'Wild Apricot members, added automatically by the USBOXLA system.' });
  p.setProperty('CC_LIST_ID', l.list_id);
  return l.list_id;
}

function ccSheet_() {
  const sh = table_(CC_TABLE, CC_HEADERS);
  if (!sh.isSheetHidden()) sh.hideSheet();
  return sh;
}

/** Called by syncPool with [{id, email, first, last}]. all = also send members recorded earlier as "already there". */
function ccSyncMembers_(members, all) {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('CC_REFRESH_TOKEN')) return;
  const sh = ccSheet_();
  const last = sh.getLastRow();
  const sent = {};
  if (last > 1) sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) { sent[String(r[0]) + '|' + String(r[1]).toLowerCase()] = true; });
  const now = nowText_();
  const fresh = members.filter(function (m) {
    return m.email && /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(m.email) && !sent[m.id + '|' + m.email.toLowerCase()];
  });
  if (!fresh.length) return;
  if (last < 2 && !all) {                                   // first run: today's members are the baseline
    writeRows_(sh, 2, fresh.map(function (m) { return [m.id, m.email, now + ' (baseline)']; }));
    console.log('Constant Contact baseline: ' + fresh.length + ' current members recorded (not sent).');
    return;
  }
  const listId = ccListId_();
  for (let i = 0; i < fresh.length; i += 500) {
    const chunk = fresh.slice(i, i + 500);
    ccCall_('post', '/activities/contacts_json_import', {
      list_ids: [listId],
      import_data: chunk.map(function (m) { return { email: m.email, first_name: m.first || '', last_name: m.last || '' }; }),
    });
    writeRows_(sh, sh.getLastRow() + 1, chunk.map(function (m) { return [m.id, m.email, now]; }));
  }
  console.log('Constant Contact: ' + fresh.length + ' member(s) added to "' + CC_LIST_NAME + '".');
}

/** Admin: sends every current member (incl. the baseline) to the members list once. */
function ccCatchUpNow() {
  const sh = ccSheet_();
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, CC_HEADERS.length).clearContent();
  PropertiesService.getScriptProperties().setProperty('CC_CATCHUP', 'yes');
  console.log('Catch-up queued: the next syncPool run sends every current member. Run syncPool now to do it right away.');
}

// ---------- Constant Contact: "Upcoming sanctioned events" email (created as a DRAFT, never sent) ----------
// ccDraftEventsEmail() builds the branded email from the tournaments on usboxla.com/tourney and saves it in
// Constant Contact as a draft called "Upcoming Sanctioned Events – <month>". Someone reviews it and sends or
// schedules it in Constant Contact. Needs the campaign_data permission (run ccConnect() again once).

const CC_FROM_EMAIL = 'info@usboxla.com';

/** Updates the newest Constant Contact draft whose name matches re (keeps one draft per email). Returns its id, or null if there is none. */
function ccUpdateDraft_(re, act) {
  const drafts = (ccCall_('get', '/emails?limit=50').campaigns || []).filter(function (c) { return re.test(c.name) && c.current_status === 'Draft'; });
  if (!drafts.length) return null;
  const full = ccCall_('get', '/emails/' + drafts[0].campaign_id);
  const primary = (full.campaign_activities || []).filter(function (a) { return a.role === 'primary_email'; })[0];
  const cur = ccCall_('get', '/emails/activities/' + primary.campaign_activity_id);
  Object.keys(act).forEach(function (k) { cur[k] = act[k]; });
  ccCall_('put', '/emails/activities/' + primary.campaign_activity_id, cur);
  console.log('Updated the draft "' + drafts[0].name + '" in Constant Contact.');
  return drafts[0].campaign_id;
}

function ccDraftEventsEmail() {
  const events = upcomingSanctioned_().filter(function (r) { return r.StartDate >= todayIso_(); });
  if (!events.length) { console.log('No upcoming sanctioned events.'); return; }
  const month = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMMM yyyy');
  const html = ccEventsHtml_(events);
  const body = {
    name: 'Upcoming Sanctioned Events – ' + month + ' (' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMM d HH:mm') + ')',
    email_campaign_activities: [{
      format_type: 5, from_name: 'USBOXLA', from_email: CC_FROM_EMAIL, reply_to_email: CC_FROM_EMAIL,
      subject: events.length + ' sanctioned box lacrosse tournaments coming up – find yours',
      preheader: 'Register now: ' + events.slice(0, 3).map(function (e) { return e.Name; }).join(', ') + (events.length > 3 ? ' and more.' : '.'),
      html_content: html,
    }],
  };
  const upd = ccUpdateDraft_(/^Upcoming Sanctioned Events/, body.email_campaign_activities[0]);
  if (upd) return upd;
  const res = ccCall_('post', '/emails', body);
  console.log('Draft created in Constant Contact: "' + res.name + '" (' + events.length + ' events). Review it under Campaigns.');
  return res.campaign_id;
}

function ccEsc_(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function ccShortDates_(r) {
  const m = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const a = r.StartDate, b = r.EndDate || r.StartDate;
  const ma = m[Number(a.slice(5, 7)) - 1], mb = m[Number(b.slice(5, 7)) - 1], da = Number(a.slice(8, 10)), db = Number(b.slice(8, 10));
  return a === b ? ma + ' ' + da : ma === mb ? ma + ' ' + da + '–' + db : ma + ' ' + da + ' – ' + mb + ' ' + db;
}

/** The branded email (600px, table layout, inline styles). */
function ccEventsHtml_(events) {
  // web-safe fonts only: Gmail/Outlook ignore web fonts, so this looks the same everywhere
  const F = "Arial,Helvetica,sans-serif", B = "Arial,Helvetica,sans-serif";
  const TOURNEY = 'https://www.usboxla.com/tourney';
  const shown = events.slice(0, 8);
  const rows = shown.map(function (r, i) {
    const link = r.Website && /^https?:\/\//i.test(r.Website) ? r.Website : TOURNEY;
    const logo = r.LogoUrl || 'https://stats.usboxla.com/assets/usboxla-shield.png';
    const place = [r.City, r.State].filter(Boolean).join(', ').toUpperCase();
    return '<tr><td style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + (i % 2 ? '#F4F6FA' : '#FFFFFF') + ';border-radius:10px"><tr>' +
      '<td width="84" style="padding:14px 0 14px 14px" valign="middle"><img src="' + ccEsc_(logo) + '" width="70" height="70" alt="' + ccEsc_(r.Name) + '" style="display:block;width:70px;height:70px;border-radius:35px;background:#FFFFFF;border:2px solid #E3E7EE"></td>' +
      '<td style="padding:14px 12px" valign="middle"><div style="font-family:' + F + ';font-size:13px;font-weight:700;letter-spacing:1.5px;color:#C8102E">' + ccShortDates_(r) + (place ? ' &nbsp;·&nbsp; ' + ccEsc_(place) : '') + '</div>' +
      '<div style="font-family:' + F + ';font-size:18px;font-weight:800;font-style:italic;text-transform:uppercase;color:#0A1D3F;line-height:1.1;padding-top:2px">' + ccEsc_(r.Name) + '</div></td>' +
      '<td width="124" style="padding:14px 14px 14px 0;white-space:nowrap" align="right" valign="middle"><a href="' + ccEsc_(link) + '" style="display:inline-block;background:#0A1D3F;color:#FFFFFF;font-family:' + F + ';font-size:13px;font-weight:700;letter-spacing:0.5px;text-decoration:none;padding:10px 12px;border-radius:6px;white-space:nowrap">REGISTER</a></td>' +
      '</tr></table></td></tr><tr><td height="10" style="line-height:10px;font-size:10px">&nbsp;</td></tr>';
  }).join('');
  const more = events.length > shown.length ? 'SEE ALL ' + events.length + ' EVENTS →' : 'ALL SANCTIONED EVENTS →';
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="margin:0;padding:0;background:#E9EDF3">[[trackingImage]]' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E9EDF3"><tr><td align="center" style="padding:24px 12px">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;border-radius:12px;overflow:hidden">' +
    // header
    '<tr><td style="background:#0A1D3F;padding:16px 24px;border-bottom:4px solid #C8102E"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td width="56"><img src="https://stats.usboxla.com/assets/usboxla-shield.png" width="46" alt="USBOXLA" style="display:block;width:46px"></td>' +
    '<td style="font-family:' + F + ';font-size:16px;font-weight:800;letter-spacing:2px;color:#FFFFFF">USBOXLA<div style="font-size:11px;font-weight:700;letter-spacing:2.5px;color:#9FB0CC">US BOX LACROSSE ASSOCIATION</div></td>' +
    '<td align="right" style="font-family:' + F + ';font-size:13px;font-weight:700;letter-spacing:1.5px"><a href="' + TOURNEY + '" style="color:#FFFFFF;text-decoration:none">EVENTS</a>&nbsp;&nbsp;&nbsp;<a href="https://stats.usboxla.com" style="color:#FFFFFF;text-decoration:none">STATS</a>&nbsp;&nbsp;&nbsp;<a href="https://membership.usboxla.com" style="color:#FFFFFF;text-decoration:none">JOIN</a></td>' +
    '</tr></table></td></tr>' +
    // hero (photo with navy wash; plain navy where email apps skip background images)
    '<tr><td background="https://stats.usboxla.com/assets/quote-bg/q03.jpg" style="background:#0A1D3F url(\'https://stats.usboxla.com/assets/quote-bg/q03.jpg\') center/cover no-repeat">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:rgba(10,29,63,0.82)"><tr><td style="padding:44px 32px 40px" align="center">' +
    '<div style="font-family:' + F + ';font-size:14px;font-weight:700;letter-spacing:4px;color:#E2B54B">★ OFFICIALLY SANCTIONED EVENTS ★</div>' +
    '<div style="font-family:' + F + ';font-size:35px;font-weight:800;font-style:italic;text-transform:uppercase;color:#FFFFFF;line-height:1;padding:12px 0 14px">Your next tournament<br>starts here</div>' +
    '<div style="font-family:' + B + ';font-size:16px;line-height:1.5;color:#DCE3EE">' + events.length + ' sanctioned box lacrosse tournaments coming up – with stats, All-Tournament Teams and player recaps at every one.</div>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px auto 0"><tr><td style="background:#C8102E;border-radius:8px"><a href="' + TOURNEY + '" style="display:inline-block;padding:14px 34px;font-family:' + F + ';font-size:16px;font-weight:800;font-style:italic;letter-spacing:1px;color:#FFFFFF;text-decoration:none">REGISTER NOW</a></td></tr></table>' +
    '</td></tr></table></td></tr>' +
    // events
    '<tr><td style="padding:30px 24px 14px"><div style="font-family:' + F + ';font-size:13px;font-weight:700;letter-spacing:3px;color:#C8102E">COMING UP</div>' +
    '<div style="font-family:' + F + ';font-size:24px;font-weight:800;font-style:italic;text-transform:uppercase;color:#0A1D3F;line-height:1.1">Sanctioned tournaments</div></td></tr>' + rows +
    '<tr><td align="center" style="padding:6px 24px 30px"><a href="' + TOURNEY + '" style="font-family:' + F + ';font-size:16px;font-weight:700;letter-spacing:1px;color:#005EC4;text-decoration:none">' + more + '</a></td></tr>' +
    // feature
    '<tr><td style="padding:0 24px 30px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0A1D3F;border-radius:12px"><tr><td style="padding:26px 24px">' +
    '<div style="font-family:' + F + ';font-size:13px;font-weight:700;letter-spacing:3px;color:#E2B54B">NEW THIS SEASON</div>' +
    '<div style="font-family:' + F + ';font-size:21px;font-weight:800;font-style:italic;text-transform:uppercase;color:#FFFFFF;line-height:1.1;padding:6px 0 8px">Every player gets a profile</div>' +
    '<div style="font-family:' + B + ';font-size:15px;line-height:1.5;color:#C9D3E3">Stats from select sanctioned events (including Regionals and Nationals), badges, and a shareable recap graphic after each event.</div>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:16px"><tr><td style="border:2px solid #FFFFFF;border-radius:8px"><a href="https://stats.usboxla.com" style="display:inline-block;padding:10px 22px;font-family:' + F + ';font-size:16px;font-weight:700;letter-spacing:1px;color:#FFFFFF;text-decoration:none">SEE THE STATS</a></td></tr></table>' +
    '</td></tr></table></td></tr>' +
    // footer (Constant Contact adds the address and unsubscribe links below)
    '<tr><td style="background:#F4F6FA;padding:22px 24px;border-top:1px solid #E3E7EE" align="center"><div style="font-family:' + F + ';font-size:14px;font-weight:700;letter-spacing:2px;color:#0A1D3F">PLAY BOX. GET BETTER. HAVE FUN.</div>' +
    '<div style="font-family:' + B + ';font-size:12px;color:#6A7891;padding-top:6px">US Box Lacrosse Association · <a href="https://www.usboxla.com" style="color:#6A7891">usboxla.com</a> · <a href="https://membership.usboxla.com" style="color:#6A7891">Membership</a></div></td></tr>' +
    '</table></td></tr></table></body></html>';
}

// ---------- Constant Contact: "Build your player profile" email (DRAFT) ----------
function ccDraftProfileEmail() {
  const act = {
    format_type: 5, from_name: 'USBOXLA', from_email: CC_FROM_EMAIL, reply_to_email: CC_FROM_EMAIL,
    subject: 'Your stats. Your story. Build your USBOXLA player profile',
    preheader: 'Free for members: game stats from select sanctioned events, award badges and a recap graphic.',
    html_content: ccProfileHtml_(),
  };
  const upd = ccUpdateDraft_(/^Build Your Player Profile/, act);
  if (upd) return upd;
  const res = ccCall_('post', '/emails', {
    name: 'Build Your Player Profile (' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMM d HH:mm') + ')',
    email_campaign_activities: [act],
  });
  console.log('Draft created in Constant Contact: "' + res.name + '". Review it under Campaigns.');
  return res.campaign_id;
}

function ccProfileHtml_() {
  // web-safe fonts only: Gmail/Outlook ignore web fonts, so this looks the same everywhere
  const F = "Arial,Helvetica,sans-serif", B = "Arial,Helvetica,sans-serif";
  const JOIN = 'https://membership.usboxla.com', STATS = 'https://stats.usboxla.com', A = 'https://stats.usboxla.com/assets/';
  const btn = function (label, href, bg) {
    return '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px auto 0"><tr><td style="background:' + bg + ';border-radius:8px"><a href="' + href + '" style="display:inline-block;padding:14px 34px;font-family:' + F + ';font-size:16px;font-weight:800;font-style:italic;letter-spacing:1px;color:#FFFFFF;text-decoration:none">' + label + '</a></td></tr></table>';
  };
  const eyebrow = function (t, c) { return '<div style="font-family:' + F + ';font-size:13px;font-weight:700;letter-spacing:3px;color:' + (c || '#C8102E') + '">' + t + '</div>'; };
  const h2 = function (t, c) { return '<div style="font-family:' + F + ';font-size:24px;font-weight:800;font-style:italic;text-transform:uppercase;color:' + (c || '#0A1D3F') + ';line-height:1.1;padding-top:2px">' + t + '</div>'; };
  const tile = function (icon, title, text) {
    return '<td width="50%" valign="top" style="padding:6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6FA;border-radius:10px"><tr><td style="padding:18px 16px">' +
      '<div style="font-size:24px;line-height:1">' + icon + '</div>' +
      '<div style="font-family:' + F + ';font-size:16px;font-weight:800;font-style:italic;text-transform:uppercase;color:#0A1D3F;padding:8px 0 4px">' + title + '</div>' +
      '<div style="font-family:' + B + ';font-size:14px;line-height:1.45;color:#3B4A63">' + text + '</div></td></tr></table></td>';
  };
  const step = function (n, title, text) {
    return '<tr><td style="padding:0 24px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
      '<td width="46" valign="top"><div style="width:36px;height:36px;border-radius:18px;background:#C8102E;color:#FFFFFF;font-family:' + F + ';font-size:16px;font-weight:800;line-height:36px;text-align:center">' + n + '</div></td>' +
      '<td valign="top" style="padding-top:2px"><div style="font-family:' + F + ';font-size:19px;font-weight:800;text-transform:uppercase;color:#0A1D3F">' + title + '</div>' +
      '<div style="font-family:' + B + ';font-size:15px;line-height:1.5;color:#3B4A63">' + text + '</div></td></tr></table></td></tr>';
  };
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="margin:0;padding:0;background:#E9EDF3">[[trackingImage]]' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E9EDF3"><tr><td align="center" style="padding:24px 12px">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;border-radius:12px;overflow:hidden">' +
    // header
    '<tr><td style="background:#0A1D3F;padding:16px 24px;border-bottom:4px solid #C8102E"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td width="56"><img src="' + A + 'usboxla-shield.png" width="46" alt="USBOXLA" style="display:block;width:46px"></td>' +
    '<td style="font-family:' + F + ';font-size:16px;font-weight:800;letter-spacing:2px;color:#FFFFFF">USBOXLA<div style="font-size:11px;font-weight:700;letter-spacing:2.5px;color:#9FB0CC">US BOX LACROSSE ASSOCIATION</div></td>' +
    '<td align="right" style="font-family:' + F + ';font-size:13px;font-weight:700;letter-spacing:1.5px"><a href="https://www.usboxla.com/tourney" style="color:#FFFFFF;text-decoration:none">EVENTS</a>&nbsp;&nbsp;&nbsp;<a href="' + STATS + '" style="color:#FFFFFF;text-decoration:none">STATS</a>&nbsp;&nbsp;&nbsp;<a href="' + JOIN + '" style="color:#FFFFFF;text-decoration:none">JOIN</a></td>' +
    '</tr></table></td></tr>' +
    // hero
    '<tr><td background="' + A + 'quote-bg/q07.jpg" style="background:#0A1D3F url(\'' + A + 'quote-bg/q07.jpg\') center/cover no-repeat">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:rgba(10,29,63,0.84)"><tr><td style="padding:44px 32px 40px" align="center">' +
    eyebrow('★ PLAYER PROFILES ★', '#E2B54B') +
    '<div style="font-family:' + F + ';font-size:40px;font-weight:800;font-style:italic;text-transform:uppercase;color:#FFFFFF;line-height:1;padding:12px 0 14px">Your stats.<br>Your story.</div>' +
    '<div style="font-family:' + B + ';font-size:16px;line-height:1.5;color:#DCE3EE">Every USBOXLA member gets a free player profile at stats.usboxla.com – real stats from select sanctioned events (including Regionals and Nationals), award badges, and a recap graphic made for Instagram.</div>' +
    btn('BUILD YOUR PROFILE', JOIN, '#C8102E') +
    '</td></tr></table></td></tr>' +
    // two pictures
    '<tr><td style="padding:30px 18px 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td width="50%" valign="top" style="padding:0 6px" align="center"><img src="' + A + 'email-sample-profile.jpg" width="270" alt="Sample player profile page" style="display:block;width:100%;max-width:270px;border-radius:10px;border:1px solid #E3E7EE">' +
    '<div style="font-family:' + F + ';font-size:15px;font-weight:700;letter-spacing:1px;color:#0A1D3F;padding-top:8px">YOUR PROFILE PAGE</div></td>' +
    '<td width="50%" valign="top" style="padding:0 6px" align="center"><img src="' + A + 'email-sample-recap.jpg" width="270" alt="Sample event recap graphic" style="display:block;width:100%;max-width:270px;border-radius:10px">' +
    '<div style="font-family:' + F + ';font-size:15px;font-weight:700;letter-spacing:1px;color:#0A1D3F;padding-top:8px">YOUR RECAP AFTER EVERY EVENT</div></td>' +
    '</tr></table><div style="font-family:' + B + ';font-size:12px;color:#8A96AB;text-align:center;padding-top:6px">Samples shown with a made-up player.</div></td></tr>' +
    // what's on it
    '<tr><td style="padding:24px 24px 8px">' + eyebrow('WHAT\'S ON YOUR PROFILE') + h2('More than a stat line') + '</td></tr>' +
    '<tr><td style="padding:4px 18px 10px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
    '<tr>' + tile('📊', 'Game stats', 'Goals, assists and points from the official game sheet at select sanctioned events, including Regionals and Nationals.') +
    tile('🏆', 'Award badges', 'Tournament MVP, All-Tournament Team and Player to Watch – in gold foil.') + '</tr>' +
    '<tr>' + tile('🎧', 'My Picks', 'Pump-up song, favorite movie and why you love box lacrosse.') +
    tile('🎓', 'Recruiting', 'School, grad year, college plans and up to 4 highlight videos.') + '</tr>' +
    '</table></td></tr>' +
    // steps
    '<tr><td style="padding:22px 24px 14px">' + eyebrow('BUILD IT IN 5 MINUTES') + h2('How to set it up') + '</td></tr>' +
    step(1, 'Log in', 'Go to <a href="' + JOIN + '" style="color:#005EC4">membership.usboxla.com</a> and log in. Parents log in for their player.') +
    step(2, 'Switch on your public profile', 'Edit your profile and turn on the player profile. It stays private until you do.') +
    step(3, 'Add a Player Photo', 'A clear headshot for the top of your page and your graphics.') +
    step(4, 'Add an Action Shot', 'A vertical game photo with the player in the top half – it becomes the background of your recap graphic.') +
    step(5, 'Fill in My Picks & school', 'Song, movie, your box lacrosse quote, school and grad year. Changes show up within about an hour.') +
    '<tr><td align="center" style="padding:6px 24px 30px">' + btn('BUILD MY PROFILE', JOIN, '#0A1D3F').replace('margin:22px auto 0', 'margin:6px auto 0') + '</td></tr>' +
    // privacy
    '<tr><td style="padding:0 24px 30px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0A1D3F;border-radius:12px"><tr><td style="padding:22px 24px">' +
    eyebrow('YOU\'RE IN CONTROL', '#E2B54B') +
    '<div style="font-family:' + B + ';font-size:15px;line-height:1.5;color:#DCE3EE;padding-top:6px">Profiles are only public when you switch them on. We never show birth dates, contact details or member numbers.</div>' +
    '<div style="padding-top:12px"><a href="' + STATS + '" style="font-family:' + F + ';font-size:16px;font-weight:700;letter-spacing:1px;color:#FFFFFF">SEE THE LEADERBOARDS →</a></div>' +
    '</td></tr></table></td></tr>' +
    // footer
    '<tr><td style="background:#F4F6FA;padding:22px 24px;border-top:1px solid #E3E7EE" align="center"><div style="font-family:' + F + ';font-size:14px;font-weight:700;letter-spacing:2px;color:#0A1D3F">PLAY BOX. GET BETTER. HAVE FUN.</div>' +
    '<div style="font-family:' + B + ';font-size:12px;color:#6A7891;padding-top:6px">US Box Lacrosse Association · <a href="https://www.usboxla.com" style="color:#6A7891">usboxla.com</a> · <a href="' + JOIN + '" style="color:#6A7891">Membership</a></div></td></tr>' +
    '</table></td></tr></table></body></html>';
}

// ---------- Constant Contact: "Regionals → Nationals in Utica" email (DRAFT) ----------
function ccDraftNationalsEmail() {
  const act = {
    format_type: 5, from_name: 'USBOXLA', from_email: CC_FROM_EMAIL, reply_to_email: CC_FROM_EMAIL,
    subject: 'New York will host the 2027 US Box Lacrosse National Championship',
    preheader: 'Congrats to our 2026 National Champions – and the road to New York starts now. Sept 4–6, 2027.',
    html_content: ccNationalsHtml_(),
  };
  // an existing draft is updated in place (so there's only ever one)
  const drafts = (ccCall_('get', '/emails?limit=50').campaigns || []).filter(function (c) { return /^2027 Nationals in Utica/.test(c.name) && c.current_status === 'Draft'; });
  if (drafts.length) {
    const full = ccCall_('get', '/emails/' + drafts[0].campaign_id);
    const primary = (full.campaign_activities || []).filter(function (a) { return a.role === 'primary_email'; })[0];
    const cur = ccCall_('get', '/emails/activities/' + primary.campaign_activity_id);
    Object.keys(act).forEach(function (k) { cur[k] = act[k]; });
    ccCall_('put', '/emails/activities/' + primary.campaign_activity_id, cur);
    console.log('Updated the draft "' + drafts[0].name + '" in Constant Contact.');
    return drafts[0].campaign_id;
  }
  const res = ccCall_('post', '/emails', {
    name: '2027 Nationals in Utica + Regionals (' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMM d HH:mm') + ')',
    email_campaign_activities: [act],
  });
  console.log('Draft created in Constant Contact: "' + res.name + '". Review it under Campaigns.');
  return res.campaign_id;
}

function ccNationalsHtml_() {
  // web-safe fonts only: Gmail/Outlook ignore web fonts, so this looks the same everywhere
  const F = "Arial,Helvetica,sans-serif", B = "Arial,Helvetica,sans-serif";
  const EV = 'https://events.usboxla.com', A = 'https://stats.usboxla.com/assets/', JOIN = 'https://membership.usboxla.com';
  const links = [[/mid ?west/i, '/events/midwest-qualifier/'], [/north ?east/i, '/events/northeast-regional/'], [/south ?east/i, '/events/southeast-regional/'],
    [/west/i, '/events/western-regional/'], [/six nations/i, '/events/sixnations/']];
  const regionals = upcomingSanctioned_().filter(function (r) { return /regional/i.test(r.Name); });
  const btn = function (label, href, bg) {
    return '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px auto 0"><tr><td style="background:' + bg + ';border-radius:8px"><a href="' + href + '" style="display:inline-block;padding:14px 34px;font-family:' + F + ';font-size:16px;font-weight:800;font-style:italic;letter-spacing:1px;color:#FFFFFF;text-decoration:none">' + label + '</a></td></tr></table>';
  };
  const eyebrow = function (t, c) { return '<div style="font-family:' + F + ';font-size:13px;font-weight:700;letter-spacing:3px;color:' + (c || '#C8102E') + '">' + t + '</div>'; };
  const h2 = function (t, c) { return '<div style="font-family:' + F + ';font-size:24px;font-weight:800;font-style:italic;text-transform:uppercase;color:' + (c || '#0A1D3F') + ';line-height:1.1;padding-top:2px">' + t + '</div>'; };
  const rows = regionals.map(function (r, i) {
    const l = links.filter(function (x) { return x[0].test(r.Name); })[0];
    const href = EV + (l ? l[1] : '/events/');
    const place = [r.City, r.State].filter(Boolean).join(', ').toUpperCase();
    return '<tr><td style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + (i % 2 ? '#F4F6FA' : '#FFFFFF') + ';border-radius:10px"><tr>' +
      '<td width="84" style="padding:14px 0 14px 14px" valign="middle"><img src="' + ccEsc_(r.LogoUrl || A + 'usboxla-shield.png') + '" width="70" height="70" alt="' + ccEsc_(r.Name) + '" style="display:block;width:70px;height:70px;border-radius:35px;background:#FFFFFF;border:2px solid #E3E7EE"></td>' +
      '<td style="padding:14px 12px" valign="middle"><div style="font-family:' + F + ';font-size:13px;font-weight:700;letter-spacing:1.5px;color:#C8102E">' + ccShortDates_(r) + (place ? ' &nbsp;·&nbsp; ' + ccEsc_(place) : '') + '</div>' +
      '<div style="font-family:' + F + ';font-size:18px;font-weight:800;font-style:italic;text-transform:uppercase;color:#0A1D3F;line-height:1.1;padding-top:2px">' + ccEsc_(r.Name) + '</div></td>' +
      '<td width="124" style="padding:14px 14px 14px 0;white-space:nowrap" align="right" valign="middle"><a href="' + href + '" style="display:inline-block;background:#0A1D3F;color:#FFFFFF;font-family:' + F + ';font-size:13px;font-weight:700;letter-spacing:0.5px;text-decoration:none;padding:10px 12px;border-radius:6px;white-space:nowrap">EVENT INFO</a></td>' +
      '</tr></table></td></tr><tr><td height="10" style="line-height:10px;font-size:10px">&nbsp;</td></tr>';
  }).join('');
  const chip = function (t) { return '<span style="display:inline-block;margin:0 6px 8px 0;padding:6px 12px;border:1px solid #3A5482;border-radius:6px;font-family:' + F + ';font-size:15px;font-weight:700;letter-spacing:1px;color:#FFFFFF">' + t + '</span>'; };
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="margin:0;padding:0;background:#E9EDF3">[[trackingImage]]' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E9EDF3"><tr><td align="center" style="padding:24px 12px">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;border-radius:12px;overflow:hidden">' +
    // header
    '<tr><td style="background:#0A1D3F;padding:16px 24px;border-bottom:4px solid #C8102E"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td width="56"><img src="' + A + 'usboxla-shield.png" width="46" alt="USBOXLA" style="display:block;width:46px"></td>' +
    '<td style="font-family:' + F + ';font-size:16px;font-weight:800;letter-spacing:2px;color:#FFFFFF">USBOXLA<div style="font-size:11px;font-weight:700;letter-spacing:2.5px;color:#9FB0CC">US BOX LACROSSE ASSOCIATION</div></td>' +
    '<td align="right" style="font-family:' + F + ';font-size:13px;font-weight:700;letter-spacing:1.5px"><a href="' + EV + '" style="color:#FFFFFF;text-decoration:none">EVENTS</a>&nbsp;&nbsp;&nbsp;<a href="https://stats.usboxla.com" style="color:#FFFFFF;text-decoration:none">STATS</a>&nbsp;&nbsp;&nbsp;<a href="' + JOIN + '" style="color:#FFFFFF;text-decoration:none">JOIN</a></td>' +
    '</tr></table></td></tr>' +
    // hero: the 2027 Champions logo
    '<tr><td background="' + A + 'email/nats26-hero.jpg" style="background:#0A1D3F url(\'' + A + 'email/nats26-hero.jpg\') center top/cover no-repeat">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:rgba(10,29,63,0.62)"><tr><td style="padding:36px 32px 40px" align="center">' +
    eyebrow('★ OFFICIAL ANNOUNCEMENT ★', '#E2B54B') +
    '<img src="' + EV + '/wp-content/uploads/2026/10/NY2027.png" width="340" alt="2027 United States Box Lacrosse Champions – New York" style="display:block;width:100%;max-width:340px;margin:18px auto 10px">' +
    '<div style="font-family:' + F + ';font-size:35px;font-weight:800;font-style:italic;text-transform:uppercase;color:#FFFFFF;line-height:1;padding:8px 0 12px">Nationals are coming<br>to New York</div>' +
    '<div style="font-family:' + F + ';font-size:18px;font-weight:800;letter-spacing:2px;color:#E2B54B">SEPT 4–6, 2027</div>' +
    '<div style="font-family:' + B + ';font-size:15px;line-height:1.5;color:#DCE3EE;padding-top:6px">Nexus Center &amp; NBT Bank Arena at the Utica Memorial Auditorium</div>' +
    btn('2027 NATIONALS INFO', EV + '/nationals/', '#C8102E') +
    '</td></tr></table></td></tr>' +
    ccNationalsChamps_(F, B, A) +
    // road to nationals
    '<tr><td style="padding:30px 24px 6px" align="center">' + eyebrow('THE ROAD TO NEW YORK') + h2('5 Regional Championships.<br>1 National Champion.') +
    '<div style="font-family:' + B + ';font-size:16px;line-height:1.5;color:#3B4A63;padding:10px 0 16px">Only qualified teams play in the ‘AA’ division at the United States Box Lacrosse Championship. Earn your spot at any of the five regionals. Are you in?</div></td></tr>' +
    rows +
    '<tr><td align="center" style="padding:6px 24px 30px"><a href="' + EV + '/rules/" style="font-family:' + F + ';font-size:16px;font-weight:700;letter-spacing:1px;color:#005EC4;text-decoration:none">HOW TO QUALIFY →</a></td></tr>' +
    // divisions
    '<tr><td style="padding:0 24px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0A1D3F;border-radius:12px"><tr><td style="padding:24px">' +
    eyebrow('2027 NATIONALS DIVISIONS', '#E2B54B') +
    '<div style="padding-top:12px">' + chip('BOYS 2035/2036') + chip('BOYS 2033/2034') + chip('BOYS 2031/2032') + chip('BOYS 2029/2030') + chip('GIRLS 2031/2032') + chip('GIRLS 2030/2029/2028') + '</div>' +
    '<div style="font-family:' + B + ';font-size:14px;line-height:1.5;color:#C9D3E3;padding-top:6px">‘A’ and ‘AA’ skill divisions. ‘AA’ is open only to qualified teams; ‘A’ teams may register on a limited basis.</div>' +
    '</td></tr></table></td></tr>' +
    // footer
    '<tr><td style="background:#F4F6FA;padding:22px 24px;border-top:1px solid #E3E7EE" align="center"><div style="font-family:' + F + ';font-size:14px;font-weight:700;letter-spacing:2px;color:#0A1D3F">PLAY BOX. GET BETTER. HAVE FUN.</div>' +
    '<div style="font-family:' + B + ';font-size:12px;color:#6A7891;padding-top:6px">US Box Lacrosse Association · <a href="https://www.usboxla.com" style="color:#6A7891">usboxla.com</a> · <a href="' + EV + '" style="color:#6A7891">events.usboxla.com</a></div></td></tr>' +
    '</table></td></tr></table></body></html>';
}

/** "Congratulations 2026 National Champions" – one photo card per 'AA' champion. */
function ccNationalsChamps_(F, B, A) {
  // [division, gold, photo, silver, bronze] – a blank silver/bronze is left off the card
  const champs = [
    ['2034/2035 \u2018AA\u2019', 'Wolfpack', 'nats26-wolfpack.jpg', '', ''],
    ['2032/2033 \u2018AA\u2019', 'Cali*Lax ALL-STARS', 'nats26-calilax.jpg', '', ''],
    ['2030/2031 \u2018AA\u2019', 'Eastern Door Elite', 'nats26-easterndoor.jpg', '', ''],
    ['2028/2029 \u2018AA\u2019', 'Jr. Bandits', 'nats26-bandits.jpg', '', ''],
  ];
  return '<tr><td style="padding:30px 24px 10px" align="center"><div style="font-family:' + F + ';font-size:13px;font-weight:700;letter-spacing:3px;color:#C8102E">\u2605 FOREVER CHAMPIONS \u2605</div>' +
    '<div style="font-family:' + F + ';font-size:24px;font-weight:800;font-style:italic;text-transform:uppercase;color:#0A1D3F;line-height:1.1;padding-top:2px">Congratulations, 2026<br>National Champions!</div>' +
    '<div style="font-family:' + B + ';font-size:15px;line-height:1.5;color:#3B4A63;padding-top:8px">To every player and coach who earned gold \u2013 you are forever a USBOXLA National Champion.</div></td></tr>' +
    champs.map(function (c) {
      return '<tr><td style="padding:8px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0A1D3F;border-radius:12px;overflow:hidden">' +
        '<tr><td><img src="' + A + 'email/' + c[2] + '" width="552" alt="' + c[1] + ' \u2013 2026 National Champions" style="display:block;width:100%;max-width:552px;height:auto;border-radius:12px 12px 0 0"></td></tr>' +
        '<tr><td style="padding:14px 18px 16px;border-top:4px solid #E2B54B"><div style="font-family:' + F + ';font-size:13px;font-weight:700;letter-spacing:2px;color:#E2B54B">' + c[0] + ' NATIONAL CHAMPIONS</div>' +
        '<div style="font-family:' + F + ';font-size:21px;font-weight:800;font-style:italic;text-transform:uppercase;color:#FFFFFF;line-height:1.1">' + c[1] + '</div>' +
        (c[3] || c[4] ? '<div style="font-family:' + B + ';font-size:14px;line-height:1.6;color:#C9D3E3;padding-top:8px">' +
          (c[3] ? '<span style="color:#D7DCE3;font-weight:600">\uD83E\uDD48 Silver:</span> ' + ccEsc_(c[3]) : '') + (c[3] && c[4] ? ' &nbsp;&nbsp; ' : '') +
          (c[4] ? '<span style="color:#D79A62;font-weight:600">\uD83E\uDD49 Bronze:</span> ' + ccEsc_(c[4]) : '') + '</div>' : '') +
        '</td></tr></table></td></tr>';
    }).join('') + '<tr><td height="10" style="line-height:10px;font-size:10px">&nbsp;</td></tr>';
}
