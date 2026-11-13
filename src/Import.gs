/**
 * Imports sanctioned events from the USBOXLA Tournament Listing
 * (https://usboxla.sportngin.com/tourney, a SportsEngine page) into the Hub's Events tab.
 * Reads usboxla.sportngin.com, not www: www moves to the WordPress site at launch.
 *
 *  - Reads every season tab on the page, keeps events that haven't ended yet.
 *  - Adds each new event as a row (name, dates, and the full USBOXLA division list –
 *    SANCTIONED_DIVISIONS – since directors add divisions after sanctioning). Director name/email are
 *    left blank: the event waits with "⚠ Fill in: director email" until Keelan adds
 *    them, so nothing is emailed or shared before then.
 *  - Remembers what it imported (hidden "Imports" tab), so a renamed or deleted row
 *    is never re-added.
 *  - When an imported event goes live, its logo is saved into the event's Logos
 *    folder as the tournament logo.
 *
 * Runs every morning with the daily job (8am); run importSanctionedEvents() to import now.
 */

const LISTING_SITE = 'https://usboxla.sportngin.com';
const LISTING_PAGE = LISTING_SITE + '/tourney';
// Every division a sanctioned tournament can offer (the director's team dropdown).
// Birth years are written oldest first (2027/2028), the same way Tourney Machine writes them.
const SANCTIONED_DIVISIONS = ['2035/2036', '2033/2034', '2031/2032', '2029/2030', '2027/2028',
  'GIRLS 2031/2032', 'GIRLS HS A', 'GIRLS HS B'];
const IMPORT_HEADERS = ['ImportKey', 'Name', 'StartDate', 'EndDate', 'City', 'State', 'Website',
  'Divisions', 'LogoUrl', 'Added'];

function importSanctionedEvents() {
  const listed = fetchListedEvents_();
  const today = todayIso_();
  const imports = readImports_();
  const known = {};
  imports.forEach(function (r) { known[r.ImportKey] = true; });

  // Events already on the Events tab (typed by Keelan) are matched by name + start date.
  const existing = {};
  readEventsTab_().forEach(function (e) { existing[norm_(e.name) + '|' + e.start] = true; });

  // Same name + same start in two places (e.g. two Border Wars sites): add the city.
  const counts = {};
  listed.forEach(function (e) { const k = norm_(e.name) + '|' + e.start; counts[k] = (counts[k] || 0) + 1; });

  const added = [];
  withLock_(function () {
    const sh = eventsSheet_();
    listed.forEach(function (e) {
      if (!e.start || (e.end || e.start) < today) return;
      const key = norm_(e.name) + '|' + e.start + '|' + norm_(e.city) + '|' + norm_(e.state);
      if (known[key]) return;
      const name = counts[norm_(e.name) + '|' + e.start] > 1 && e.city ? e.name + ' – ' + e.city : e.name;
      if (!existing[norm_(name) + '|' + e.start]) {
        const row = sh.getLastRow() + 1;
        if (sh.getMaxRows() < row) sh.insertRowsAfter(sh.getMaxRows(), row - sh.getMaxRows());
        sh.getRange(row, 1, 1, EVENT_INPUTS).setValues([[
          name, dateFromIso_(e.start), dateFromIso_(e.end || e.start), SANCTIONED_DIVISIONS.join(', '), '', '',
        ]]);
        added.push(name);
      }
      insertImport_({
        ImportKey: key, Name: name, StartDate: e.start, EndDate: e.end || e.start, City: e.city,
        State: e.state, Website: e.website, Divisions: e.divisions.join(', '), LogoUrl: e.logo,
        Added: nowText_(),
      });
      known[key] = true;
    });
  });
  console.log(listed.length + ' events listed; added ' + added.length + (added.length ? ': ' + added.join('; ') : '.'));
  attachLogosToLiveEvents_();
  return added;
}

/** Saves the imported logo into a live event's Logos folder if it has no tournament logo yet. */
function attachImportedLogo_(ev, logosFolder) {
  const rec = readImports_().filter(function (r) {
    return norm_(r.Name) === norm_(ev.name) && r.StartDate === ev.start && r.LogoUrl;
  })[0];
  if (!rec) return false;
  const files = logosFolder.getFiles();
  while (files.hasNext()) {
    const n = norm_(String(files.next().getName()).replace(/\.[^.]+$/, ''));
    if (n.indexOf('tournament') === 0 || n.indexOf('logo') === 0 || n.indexOf('event') === 0) return false;
  }
  const res = UrlFetchApp.fetch(rec.LogoUrl, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return false;
  const ext = (rec.LogoUrl.match(/\.(png|jpe?g|gif|webp)(\?|$)/i) || [, 'png'])[1].toLowerCase();
  logosFolder.createFile(res.getBlob().setName('tournament.' + ext));
  return true;
}

function attachLogosToLiveEvents_() {
  const data = readAll_('EventData');
  readEventsTab_().forEach(function (ev) {
    const d = ev.id && data.filter(function (x) { return x.EventID === ev.id; })[0];
    if (!d) return;
    try { attachImportedLogo_(ev, DriveApp.getFolderById(d.LogosFolderID)); } catch (err) { console.error(err); }
  });
}

// ---------- reading the SportsEngine listing ----------

/** Returns [{name, start, end, website, divisions[], city, state, logo}] from every season tab. */
function fetchListedEvents_() {
  const page = httpText_(LISTING_PAGE, false);
  const tabRe = /show_layout_tab\?layout_container_id=(\d+)&(?:amp;)?page_node_id=(\d+)&(?:amp;)?tab_element_id=(\d+)/g;
  const seen = {};
  const out = [];
  let m;
  while ((m = tabRe.exec(page))) {
    const tabUrl = LISTING_SITE + '/layout_container/show_layout_tab?layout_container_id=' + m[1] +
      '&page_node_id=' + m[2] + '&tab_element_id=' + m[3];
    if (seen[tabUrl]) continue;
    seen[tabUrl] = true;
    const tabHtml = httpText_(tabUrl, true);
    const elRe = /page_element\/ajax\/(\d+)/g;
    let e;
    while ((e = elRe.exec(tabHtml))) {
      const html = httpText_(LISTING_SITE + '/page_element/ajax/' + e[1] + '?width_percentage=100&page_node_id=' + m[2] + '&subseason=', true);
      parseEventTable_(html).forEach(function (row) { out.push(row); });
    }
  }
  if (!out.length) throw new Error('No events found on ' + LISTING_PAGE + ' – the page layout may have changed.');
  return out;
}

function httpText_(url, ajax) {
  const opts = { muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': 'USBOXLA Event Registration' } };
  if (ajax) opts.headers['X-Requested-With'] = 'XMLHttpRequest';
  const res = UrlFetchApp.fetch(url, opts);
  if (res.getResponseCode() !== 200) throw new Error('Could not read ' + url + ' (HTTP ' + res.getResponseCode() + ')');
  return res.getContentText();
}

/** Parses the listing table by its column headings, so column order can change. */
function parseEventTable_(html) {
  const table = (html.match(/<table[\s\S]*?<\/table>/i) || [])[0];
  if (!table) return [];
  const heads = (table.match(/<th[\s\S]*?<\/th>/gi) || []).map(function (h) { return norm_(htmlText_(h)); });
  const col = function (names) {
    for (let i = 0; i < heads.length; i++) if (names.indexOf(heads[i]) !== -1) return i;
    return -1;
  };
  const iName = col(['name', 'event', 'tournamentname']), iStart = col(['start', 'startdate']);
  const iEnd = col(['end', 'enddate']), iWeb = col(['website', 'url']), iDiv = col(['divisions', 'division']);
  const iCity = col(['citys', 'city']), iState = col(['state']), iLogo = col(['tournament', 'logo']);
  const body = (table.match(/<tbody[\s\S]*?<\/tbody>/i) || [table])[0];
  const rows = body.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  return rows.map(function (tr) {
    const cells = tr.match(/<td[\s\S]*?<\/td>/gi) || [];
    const text = function (i) { return i >= 0 && cells[i] ? htmlText_(cells[i]) : ''; };
    const img = iLogo >= 0 && cells[iLogo] ? (cells[iLogo].match(/<img[^>]+src="([^"]+)"/i) || [])[1] : '';
    return {
      name: clean_(text(iName), 80),
      start: toIsoDate_(text(iStart)),
      end: toIsoDate_(text(iEnd)),
      website: text(iWeb),
      divisions: text(iDiv).split(',').map(function (d) { return clean_(d, 30); }).filter(Boolean),
      city: clean_(text(iCity), 60),
      state: clean_(text(iState), 20),
      // The table shows a 70px icon; the "_crop" version of the same file is 200px.
      logo: img ? decodeEntities_(img).replace(/_crop_icon(\.\w+)(\?|$)/, '_crop$1$2') : '',
    };
  }).filter(function (r) { return r.name; });
}

function htmlText_(s) {
  return decodeEntities_(String(s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeEntities_(s) {
  return String(s).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(Number(n)); });
}

function dateFromIso_(iso) {
  return iso ? new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) : '';
}

// ---------- private Imports tab ----------

function importsSheet_() {
  const sh = table_('Imports', IMPORT_HEADERS);
  if (!sh.isSheetHidden()) sh.hideSheet();
  return sh;
}

function readImports_() {
  const sh = importsSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, IMPORT_HEADERS.length).getValues().map(function (r) {
    const o = {};
    IMPORT_HEADERS.forEach(function (h, j) { o[h] = cellText_(r[j]); });
    return o;
  });
}

function insertImport_(o) {
  const sh = importsSheet_();
  writeRows_(sh, sh.getLastRow() + 1, [IMPORT_HEADERS.map(function (h) { return o[h]; })]);
}


// ---------- website Events list (www.usboxla.com) ----------
// Every upcoming event on the SportsEngine listing also goes onto the WordPress Events list
// (wp-admin → Events), which drives www.usboxla.com/tournaments/, the Events page and the home page.
// Runs in dailyJobs after importSanctionedEvents. Script Properties: WP_USER, WP_APP_PASSWORD
// (an Application Password, revocable under Users → Profile on www.usboxla.com).
// Matching: same start date AND (same name or same city) counts as already listed, so regionals and
// USBOXLA events typed by hand are never duplicated. Each event is added once (hidden WebsiteSync tab),
// so an event deleted on the website is not re-added.

const WP_SITE = 'https://www.usboxla.com';
const WEBSITE_SYNC_HEADERS = ['Key', 'Name', 'StartDate', 'WpId', 'Added'];

function syncWebsiteEvents() { return syncWebsiteEvents_(false); }

/** Admin: lists what syncWebsiteEvents would add, without changing the website. */
function previewWebsiteEvents() { return syncWebsiteEvents_(true); }

function syncWebsiteEvents_(dryRun) {
  const p = PropertiesService.getScriptProperties();
  const user = p.getProperty('WP_USER'), pass = p.getProperty('WP_APP_PASSWORD');
  if (!user || !pass) throw new Error('WP_USER / WP_APP_PASSWORD are not set in Script Properties');
  const auth = 'Basic ' + Utilities.base64Encode(user + ':' + pass.replace(/\s+/g, ''));
  const today = todayIso_();

  const site = wpGetAll_(auth, '/wp-json/wp/v2/usboxla-events?status=any&context=edit');
  const onSite = site.map(function (e) {
    const m = e.meta || {};
    return { name: norm_(e.title && (e.title.raw || e.title.rendered) || ''), start: m._ev_start || '', city: norm_(m._ev_city || '') };
  });
  const done = {};
  readWebsiteSync_().forEach(function (r) { done[r.Key] = true; });

  const listed = fetchListedEvents_();
  const counts = {};
  listed.forEach(function (e) { const k = norm_(e.name) + '|' + e.start; counts[k] = (counts[k] || 0) + 1; });

  const added = [];
  listed.forEach(function (e) {
    if (!e.start || (e.end || e.start) < today) return;
    const key = norm_(e.name) + '|' + e.start + '|' + norm_(e.city) + '|' + norm_(e.state);
    if (done[key]) return;
    const name = counts[norm_(e.name) + '|' + e.start] > 1 && e.city ? e.name + ' – ' + e.city : e.name;
    const exists = onSite.some(function (s) {
      return s.start === e.start && (s.name === norm_(name) || s.name === norm_(e.name) || (s.city && s.city === norm_(e.city)));
    });
    if (exists) {
      if (!dryRun) insertWebsiteSync_({ Key: key, Name: name, StartDate: e.start, WpId: 'already listed', Added: nowText_() });
      return;
    }
    if (dryRun) { added.push(name + ' (' + e.start + ', ' + e.city + ', ' + e.state + ')'); return; }
    let logoId = '';
    try { logoId = e.logo ? wpUploadLogo_(auth, e.logo, name) : ''; } catch (err) { console.error('Logo for ' + name + ': ' + err.message); }
    const post = wpFetch_(auth, 'post', '/wp-json/wp/v2/usboxla-events', {
      title: name, status: 'publish',
      meta: {
        _ev_start: e.start, _ev_end: e.end || e.start, _ev_city: e.city || '', _ev_state: e.state || '',
        _ev_website: e.website || '', _ev_divisions: e.divisions.join(', '), _ev_type: 'sanctioned',
        _ev_logo: logoId ? String(logoId) : '',
      },
    });
    insertWebsiteSync_({ Key: key, Name: name, StartDate: e.start, WpId: post.id, Added: nowText_() });
    onSite.push({ name: norm_(name), start: e.start, city: norm_(e.city) });
    added.push(name + ' (' + e.start + ')');
  });
  console.log((dryRun ? 'Would add ' : 'Added ') + added.length + ' event(s) to www.usboxla.com' + (added.length ? ': ' + added.join('; ') : '.'));
  return added;
}

function wpFetch_(auth, method, path, payload) {
  const opts = { method: method, muteHttpExceptions: true, headers: { Authorization: auth } };
  if (payload) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(payload); }
  const res = UrlFetchApp.fetch(WP_SITE + path, opts);
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('Website ' + method.toUpperCase() + ' ' + path + ' → HTTP ' + code + ': ' + res.getContentText().slice(0, 300));
  return JSON.parse(res.getContentText());
}

function wpGetAll_(auth, path) {
  let out = [], page = 1;
  while (true) {
    const res = UrlFetchApp.fetch(WP_SITE + path + '&per_page=100&page=' + page, { muteHttpExceptions: true, headers: { Authorization: auth } });
    if (res.getResponseCode() === 400 && page > 1) break;
    if (res.getResponseCode() !== 200) throw new Error('Website GET ' + path + ' → HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
    const list = JSON.parse(res.getContentText());
    out = out.concat(list);
    if (list.length < 100) break;
    page++;
  }
  return out;
}

/** Copies the SportsEngine logo into the website's Media Library and returns its ID. */
function wpUploadLogo_(auth, url, name) {
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return '';
  const ext = (url.match(/\.(png|jpe?g|gif|webp)(\?|$)/i) || [, 'png'])[1].toLowerCase();
  const file = norm_(name).slice(0, 60) + '-logo.' + ext;
  const blob = res.getBlob();
  const up = UrlFetchApp.fetch(WP_SITE + '/wp-json/wp/v2/media', {
    method: 'post', muteHttpExceptions: true, payload: blob.getBytes(),
    contentType: blob.getContentType() || ('image/' + (ext === 'jpg' ? 'jpeg' : ext)),
    headers: { Authorization: auth, 'Content-Disposition': 'attachment; filename="' + file + '"' },
  });
  if (up.getResponseCode() < 200 || up.getResponseCode() >= 300) throw new Error('upload HTTP ' + up.getResponseCode() + ': ' + up.getContentText().slice(0, 200));
  const media = JSON.parse(up.getContentText());
  try { wpFetch_(auth, 'post', '/wp-json/wp/v2/media/' + media.id, { alt_text: name + ' logo', title: name + ' logo' }); } catch (err) { console.error(err); }
  return media.id;
}

function websiteSyncSheet_() {
  const sh = table_('WebsiteSync', WEBSITE_SYNC_HEADERS);
  if (!sh.isSheetHidden()) sh.hideSheet();
  return sh;
}

function readWebsiteSync_() {
  const sh = websiteSyncSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, WEBSITE_SYNC_HEADERS.length).getValues().map(function (r) {
    const o = {};
    WEBSITE_SYNC_HEADERS.forEach(function (h, j) { o[h] = cellText_(r[j]); });
    return o;
  });
}

function insertWebsiteSync_(o) {
  const sh = websiteSyncSheet_();
  writeRows_(sh, sh.getLastRow() + 1, [WEBSITE_SYNC_HEADERS.map(function (h) { return o[h]; })]);
}


