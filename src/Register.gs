/**
 * The parent-facing registration page (the deployed web app).
 * Each parent's email link carries a private token for one player.
 */

function doGet(e) {
  if (e && e.parameter && e.parameter.gsdemoraw) {   // practice mode for the academy to host (raw HTML, fetched server-to-server)
    return ContentService.createTextOutput('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
      gameSheetDemoHtml_(e.parameter.shot) + '</html>');
  }
  if (e && e.parameter && e.parameter.gsdemo) return gameSheetDemo_(e); // practice mode: made-up teams, nothing saved
  if (e && e.parameter && e.parameter.gs) return gameSheetPage_(e);
  if (e && e.parameter && e.parameter.api) return publicApi_(e); // stats.usboxla.com feed
  if (e && e.parameter && e.parameter.me) return myProfileFrame_(String(e.parameter.me)); // "View my profile" box on Wild Apricot
  if (e && e.parameter && /^cc-/.test(String(e.parameter.state || ''))) return ccWebCallback_(e); // Constant Contact connect
  const t = e && e.parameter && e.parameter.t;
  const reg = t ? regByToken_(t) : null;
  if (!reg) {
    return HtmlService.createHtmlOutput(
      '<p style="font:16px sans-serif;padding:24px">This registration link isn’t active. ' +
      'Ask your team manager to check the roster, or contact USBOXLA.</p>').setTitle('USBOXLA')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  const tpl = HtmlService.createTemplateFromFile('RegisterPage');
  tpl.token = t;
  tpl.usboxlaLogo = usboxlaLogoDataUri_();
  return tpl.evaluate()
    .setTitle('USBOXLA Player Registration')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    // Allows the page to be embedded on the USBOXLA Wild Apricot site.
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * JSON endpoint used by the registration page hosted on the Wild Apricot site.
 * The page POSTs {action:'data'|'submit', t, memberId, dob} as plain text, which
 * avoids Google's multiple-signed-in-accounts error that the Google-hosted page hits.
 */
function doPost(e) {
  let out;
  if (e && e.parameter && e.parameter.wa) {          // Wild Apricot webhook: instant profile updates
    try { out = waWebhook_(e); } catch (err) { console.error(err); out = { ok: false }; }
    return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
  }
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (req.action === 'data') out = registerData(req.t);
    else if (req.action === 'submit') out = registerSubmit(req.t, req.memberId, req.dob);
    else if (req.action === 'gs') out = gameSheetApi_(req);
    else if (/^(ra|rr|rf)-/.test(String(req.action))) {   // Ref Room, availability and referee applications (RefAvail.gs)
      try { out = refAvailApi_(req); } catch (err) { console.error(err); out = { ok: false, error: 'Something went wrong – please try again.' }; }
    }
    else out = { error: 'Unknown request.' };
  } catch (err) {
    out = { error: 'Bad request.' };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function regByToken_(t) {
  if (!t || String(t).length < 20) return null;
  return readAll_('Registrations').filter(function (g) { return g.Token === t && g.Present === 'yes'; })[0] || null;
}

function regContext_(t) {
  const reg = regByToken_(t);
  if (!reg) throw new Error('This registration link isn’t active anymore.');
  const ev = readEventsTab_().filter(function (e) { return e.id === reg.EventID; })[0];
  const team = readAll_('TeamData').filter(function (x) { return x.TeamKey === reg.TeamKey; })[0];
  const data = readAll_('EventData').filter(function (d) { return d.EventID === reg.EventID; })[0];
  if (!ev || !team || !data) throw new Error('This event is no longer open for registration.');
  return { reg: reg, ev: ev, team: team, data: data };
}

/** Page data, including logos as images (so the logo files never need public sharing). */
function registerData(t) {
  try {
    const c = regContext_(t);
    const logos = findLogos_(c.data, c.team);
    return {
      event: { name: c.ev.name, dates: prettyRange_({ StartDate: c.ev.start, EndDate: c.ev.end }) },
      team: { name: c.team.TeamName, division: c.team.Division },
      player: { first: c.reg.FirstName, last: c.reg.LastName },
      verified: c.reg.Status === 'verified',
      finished: c.ev.end < todayIso_(),
      joinUrl: getConfig_().joinUrl,
      eventLogo: dataUri_(logos.event),
      teamLogo: dataUri_(logos.team),
    };
  } catch (err) {
    return { error: err.message };
  }
}

function registerSubmit(t, memberId, dob) {
  try {
    const c = regContext_(t);
    if (c.reg.Status === 'verified') return { ok: true, title: 'Already registered', detail: '' };
    const r = checkMember(memberId, dob, c.ev.end);
    if (!r.ok) return r;
    withLock_(function () {
      const reg = regByToken_(t);
      markVerified_(reg, String(memberId).replace(/\D/g, ''), r.name, 'parent registration');
      update_('Registrations', reg);
      try { refreshRoster_(reg); } catch (err) { console.error(err); } // sheet catches up on the next scan anyway
    });
    r.title = 'You’re registered!';
    r.detail = (r.name || c.reg.FirstName) + ' is verified for the ' + c.ev.name + '. ' + r.detail;
    return r;
  } catch (err) {
    return { ok: false, title: 'Something went wrong', detail: err.message };
  }
}

// ---------- logos ----------

/** Tournament logo: an image named "tournament…" (or "logo…"). Team logo: named like the team. */
function findLogos_(data, team) {
  const out = { event: null, team: null };
  if (!data || !data.LogosFolderID) return out;
  const teamNames = team ? [norm_(team.TeamName), norm_(team.TeamName + team.Division)] : [];
  // A logo the team manager uploaded to the club's own logo folder wins.
  if (team && team.LogoFolderID) {
    try {
      const own = DriveApp.getFolderById(team.LogoFolderID).getFiles();
      while (own.hasNext() && !out.team) {
        const f = own.next();
        if (String(f.getMimeType()).indexOf('image/') === 0) out.team = f;
      }
    } catch (err) { console.error(err); }
  }
  const files = DriveApp.getFolderById(data.LogosFolderID).getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (String(f.getMimeType()).indexOf('image/') !== 0) continue;
    const base = norm_(String(f.getName()).replace(/\.[^.]+$/, ''));
    if (!out.event && (base.indexOf('tournament') === 0 || base.indexOf('logo') === 0 || base.indexOf('event') === 0)) out.event = f;
    else if (!out.team && teamNames.indexOf(base) !== -1) out.team = f;
  }
  return out;
}

/** A ~240px copy of an image in Drive (Drive's own preview), or null if Drive can't make one. */
function smallLogoBlob_(file) {
  try {
    const auth = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
    const meta = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + file.getId() + '?fields=thumbnailLink',
      { headers: auth, muteHttpExceptions: true });
    const link = meta.getResponseCode() === 200 ? JSON.parse(meta.getContentText()).thumbnailLink : '';
    if (!link) return null;
    const img = UrlFetchApp.fetch(link.replace(/=s\d+$/, '') + '=s240', { headers: auth, muteHttpExceptions: true });
    return img.getResponseCode() === 200 ? img.getBlob().setName('logo.png') : null;
  } catch (err) {
    console.error(err);
    return null;
  }
}

/** Admin tool: shows how big each live event's email logo is (sends nothing). */
function checkEmailLogos() {
  readAll_('EventData').forEach(function (d) {
    const ev = readEventsTab_().filter(function (e) { return e.id === d.EventID; })[0];
    if (!ev) return;
    const b = logoForEmail_(d);
    console.log(ev.name + ': ' + (b ? Math.round(b.getBytes().length / 1024) + ' KB (' + b.getContentType() + ')' : 'no logo'));
  });
}

function logoBlob_(file) {
  if (!file) return null;
  try {
    return file.getSize() <= 1500000 ? file.getBlob() : file.getThumbnail();
  } catch (err) {
    return null;
  }
}

function dataUri_(file) {
  const blob = logoBlob_(file);
  return blob ? 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) : '';
}

const emailLogoCache_ = {};

/** Tournament logo for emails, looked up once per run per event. */
function logoForEmail_(data) {
  if (!data) return null;
  if (!(data.EventID in emailLogoCache_)) {
    try {
      // Big logo files are sent as a small (240px) copy made by Drive, so emails stay light.
      const f = findLogos_(data, null).event;
      emailLogoCache_[data.EventID] = !f ? null : f.getSize() <= 300000 ? f.getBlob() : smallLogoBlob_(f) || f.getThumbnail();
    } catch (err) {
      emailLogoCache_[data.EventID] = null;
    }
  }
  return emailLogoCache_[data.EventID];
}
