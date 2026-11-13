/**
 * USBOXLA Player Check — core membership lookup against Wild Apricot.
 *
 * Given a Member ID + date of birth + game/tournament date, returns whether the
 * player is cleared to play (active, paid membership — which includes the
 * waiver — valid through that date, and the DOB matches the record).
 *
 * Setup is covered in SETUP at the top of Setup.gs.
 */

const WA_AUTH_URL = 'https://oauth.wildapricot.org/auth/token';
const WA_API_BASE = 'https://api.wildapricot.org/v2.2';

// ---------- Membership check (used by registration and the pool) ----------

/** Called from the page. Never throws to the browser; returns a result object. */
function checkMember(memberId, dob, eventDate) {
  try {
    return checkMember_(memberId, dob, eventDate);
  } catch (err) {
    console.error(err);
    return result_(false, 'error', 'Could not check right now',
      'The membership system did not respond. Try again in a moment. (' + err.message + ')');
  }
}

// ---------- Core check ----------

function checkMember_(memberId, dob, eventDate) {
  const cfg = getConfig_();
  const id = String(memberId || '').replace(/\D/g, '');
  const dobIso = toIsoDate_(dob);
  const eventIso = toIsoDate_(eventDate) || todayIso_();

  if (!id) return result_(false, 'bad_input', 'Enter a Member ID', '');
  if (!dobIso) return result_(false, 'bad_input', 'Enter a date of birth', '');

  const contact = getContact_(id);
  if (!contact) {
    return withJoin_(result_(false, 'not_found', 'No member with that ID',
      'Member ID ' + id + ' is not in the USBOXLA membership system.'), cfg);
  }

  // DOB must match before we reveal anything about the record.
  const dobOnFile = toIsoDate_(fieldValue_(contact, [cfg.dobField]));
  if (!dobOnFile) {
    return result_(false, 'no_dob', 'Record has no date of birth',
      'This member record is missing a DOB. The USBOXLA office needs to fix it before the player can be cleared.');
  }
  if (dobOnFile !== dobIso) {
    return result_(false, 'mismatch', 'ID and date of birth don’t match',
      'Double-check both. If they’re right, this ID belongs to a different player.');
  }

  const name = [contact.FirstName, contact.LastName].filter(Boolean).join(' ') || contact.DisplayName || '';
  const level = contact.MembershipLevel ? contact.MembershipLevel.Name : '';
  const status = contact.Status || '';
  const renewalIso = toIsoDate_(fieldValue_(contact, ['RenewalDue', 'Renewal due']));

  if (!contact.MembershipEnabled || !status) {
    return withJoin_(named_(result_(false, 'not_member', 'Not a current member',
      'This player has a record but no active membership.'), name, level, renewalIso), cfg);
  }
  if (status === 'Lapsed') {
    return withJoin_(named_(result_(false, 'lapsed', 'Membership expired',
      'Expired' + (renewalIso ? ' on ' + prettyDate_(renewalIso) : '') + '. Renew to play.'), name, level, renewalIso), cfg);
  }
  if (status === 'PendingNew') {
    return withJoin_(named_(result_(false, 'unpaid', 'Membership not paid',
      'Signed up but payment hasn’t gone through yet.'), name, level, renewalIso), cfg);
  }
  // Active, PendingRenewal and PendingUpgrade all mean the current membership is still in force.
  if (renewalIso && renewalIso < eventIso) {
    return withJoin_(named_(result_(false, 'expires_before_event', 'Expires before this game',
      'Membership ends ' + prettyDate_(renewalIso) + ', before ' + prettyDate_(eventIso) + '. Renew to play.'), name, level, renewalIso), cfg);
  }
  return named_(result_(true, 'valid', 'Cleared to play',
    renewalIso ? 'Valid through ' + prettyDate_(renewalIso) + '.' : 'Membership active.'), name, level, renewalIso);
}

// ---------- Wild Apricot API ----------

function getConfig_() {
  const p = PropertiesService.getScriptProperties();
  const apiKey = p.getProperty('WA_API_KEY');
  if (!apiKey) throw new Error('WA_API_KEY is not set in Script Properties');
  return {
    apiKey: apiKey,
    dobField: p.getProperty('DOB_FIELD_NAME') || 'Date of birth',
    joinUrl: p.getProperty('JOIN_URL') || 'https://membership-usboxla.wildapricot.org/',
  };
}

function getAuth_(forceRefresh) {
  const cache = CacheService.getScriptCache();
  if (!forceRefresh) {
    const cached = cache.get('wa_auth');
    if (cached) return JSON.parse(cached);
  }
  const cfg = getConfig_();
  const res = UrlFetchApp.fetch(WA_AUTH_URL, {
    method: 'post',
    headers: { Authorization: 'Basic ' + Utilities.base64Encode('APIKEY:' + cfg.apiKey) },
    payload: { grant_type: 'client_credentials', scope: 'auto' },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Wild Apricot sign-in failed (HTTP ' + res.getResponseCode() + '); check WA_API_KEY');
  }
  const body = JSON.parse(res.getContentText());
  // Wild Apricot's docs show both "Permissions/AccountId" and "permissions/accountId"; accept either.
  const perms = body.Permissions || body.permissions || [];
  const accountId = perms.length ? (perms[0].AccountId || perms[0].accountId) : null;
  if (!body.access_token || !accountId) throw new Error('Wild Apricot sign-in returned no account; check WA_API_KEY');
  const auth = { token: body.access_token, accountId: accountId };
  const ttl = Math.max(60, Math.min((body.expires_in || 1800) - 120, 21600));
  cache.put('wa_auth', JSON.stringify(auth), ttl);
  return auth;
}

function waGet_(path, retried) {
  const auth = getAuth_(retried);
  const res = UrlFetchApp.fetch(WA_API_BASE + '/accounts/' + auth.accountId + path, {
    headers: { Authorization: 'Bearer ' + auth.token, Accept: 'application/json' },
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code === 401 && !retried) return waGet_(path, true); // token expired; refresh once
  if (code === 404) return null;
  if (code !== 200) throw new Error('Wild Apricot returned HTTP ' + code);
  return JSON.parse(res.getContentText());
}

function getContact_(id) {
  return waGet_('/contacts/' + encodeURIComponent(id));
}

/** Finds a field by its name or system code, case-insensitive. */
function fieldValue_(contact, names) {
  const wanted = names.map(function (n) { return String(n).toLowerCase(); });
  const fields = contact.FieldValues || [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (wanted.indexOf(String(f.FieldName || '').toLowerCase()) !== -1 ||
        wanted.indexOf(String(f.SystemCode || '').toLowerCase()) !== -1) {
      return f.Value;
    }
  }
  return null;
}

// ---------- Helpers ----------

function result_(ok, code, title, detail) {
  return { ok: ok, code: code, title: title, detail: detail };
}

function named_(r, name, level, renewalIso) {
  r.name = name;
  r.level = level;
  r.renewalDue = renewalIso;
  return r;
}

function withJoin_(r, cfg) {
  r.joinUrl = cfg.joinUrl;
  return r;
}

/** Accepts 2012-04-15, 2012-04-15T00:00:00, 4/15/2012, or a Date. Returns YYYY-MM-DD or null. */
function toIsoDate_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v) ? null : Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return realDate_(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/); // MM/DD/YYYY
  if (m) return realDate_(m[3], m[1], m[2]);
  return null;
}

function pad_(n) { return ('0' + n).slice(-2); }

/** "yyyy-MM-dd" if year/month/day is a real calendar date (so 14/03/2015 is refused), else null. */
function realDate_(y, mo, d) {
  y = Number(y); mo = Number(mo); d = Number(d);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return y + '-' + pad_(mo) + '-' + pad_(d);
}

function todayIso_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function prettyDate_(iso) {
  const p = iso.split('-');
  return Number(p[1]) + '/' + Number(p[2]) + '/' + p[0];
}

// ---------- Admin tools (run from the editor) ----------

/** Confirms the API key works. */
function testConnection() {
  const auth = getAuth_(true);
  console.log('Connected to Wild Apricot account ' + auth.accountId);
}

/** Lists every field on one member's record, so you can find the exact DOB field name. */
function inspectMember() {
  const id = PropertiesService.getScriptProperties().getProperty('TEST_MEMBER_ID');
  if (!id) throw new Error('Set TEST_MEMBER_ID in Script Properties first');
  const c = getContact_(id);
  if (!c) { console.log('No contact with ID ' + id); return; }
  console.log('Name: ' + c.FirstName + ' ' + c.LastName + ' | Status: ' + c.Status +
    ' | Level: ' + (c.MembershipLevel ? c.MembershipLevel.Name : '(none)'));
  (c.FieldValues || []).forEach(function (f) {
    console.log(f.FieldName + ' [' + f.SystemCode + ']: ' + JSON.stringify(f.Value));
  });
}
