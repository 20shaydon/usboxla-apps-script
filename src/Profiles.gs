/**
 * Public player profiles for stats.usboxla.com.
 *
 * Wild Apricot holds the profile (Membership fields: "Public Player Profile Stats Page", Player Photo,
 * Header Photo, Position, Shot, Height, Grad Year, Box Lacrosse Team, GPA (Weighted), "I like box lacrosse because:",
 * hometown from the participant City + State/Prov fields,
 * Instagram, TikTok, Video 1–4).
 * The hourly pool sync already downloads every eligible member, so it also keeps the hidden Profiles
 * table up to date – only members who chose "Yes" (and not "No") are kept. Lapsed members drop off.
 *
 * Public endpoints (no key – they only ever return opted-in players):
 *   …/exec?api=stats              → JSON feed: events + opted-in players with their stats
 *   …/exec?api=photo&p=SLUG&k=photo|header → {mime, b64} of that player's picture
 *   …/exec?api=logo&e=EVENTID          → {mime, b64} of that event's tournament logo (Logos folder)
 *   …/exec?api=teamlogo&t=KEY          → {mime, b64} of a team's logo (Team Logos folder, else the event's team logo)
 * The team shown on a profile always comes from official rosters (game sheets), never from the member's own profile.
 * Never public: date of birth, email, address, Member ID, parent details.
 */

const PROFILE_FIELDS = {
  optIn: 'Public Player Profile Stats Page',
  // Photos: a File attachment field keeps the full-size original; old Picture fields only keep 110px.
  photo: /^player\s*photo/i, header: /^header\s*photo/i, action: /^action\s*shot/i,
  position: 'Position', shot: 'Shot', height: 'Height', grad: ['HS Grad Year', 'Grad Year'],
  instagram: 'Instagram', tiktok: 'TikTok', video1: 'Video 1', video2: 'Video 2', video3: 'Video 3', video4: 'Video 4',
  hometown: ['Hometown', 'Home Town'], gpa: ['GPA (Weighted)', 'GPA Weighted', 'Weighted GPA', 'GPA'],
  // Recruiting (added Nov 6, 2026): optional; shown only when filled in and in range.
  gpaU: [/^gpa\s*\(?\s*unweighted/i, /^unweighted\s*gpa/i], sat: [/^sat\b/i], act: [/^act\b/i], psat: [/^psat/i],
  ncaa: [/^ncaa\s*eligibility/i, /^ncaa\b.*registered/i],
  statement: [/^i like box lacrosse because/i, /^personal statement$/i],
  city: [/^participant\s*city$/i, /participant.*city/i, /^city$/i],
  state: [/^participant\s*(state|prov)/i, /participant.*(state|prov)/i, /^(state|province|state\s*\/\s*prov)/i],
  // Academics: the school the player attends now, and the college they're committed to / playing at.
  school: [/^current\s*(high\s*)?school/i, /^high\s*school(\s*name)?$/i, /^school$/i],
  // "MENS - If you are attending or committed what college?" / "WOMENS - …" dropdowns, gated by the Yes/No radio
  // "Are you currently in college or a committed athlete?".
  college: [/^(wo)?mens\b.*college/i, /what college/i, /^college$/i],
  collegeGate: /^are you.*(college|committed)/i,
  // "My Picks" – the player's own corner of the page.
  song: [/pump.?up\s*song/i, /walk.?up\s*song/i], movie: [/^favou?rite\s*movie/i],
  // Indigenous heritage: shown only when the family picks Yes; the Nation is optional free text.
  heritage: [/^indigenous\s*heritage/i, /^native\s*american/i], nation: [/^nation\b/i, /^first\s*nation\b/i, /^tribe\b/i],
  quote: [/^favou?rite\s*sports?\s*quote/i, /^sports?\s*quote/i], quoteBy: [/^quote\s*by/i, /^who\s*said\s*it/i],
};

/** The college picked in the MENS/WOMENS dropdown – only when the Yes/No question says Yes (blank counts as yes). */
function collegeOf_(c) {
  const fields = c.FieldValues || [];
  const gate = fields.filter(function (f) { return PROFILE_FIELDS.collegeGate.test(String(f.FieldName || '').trim()); })[0];
  if (gate && /^no\b/i.test(waText_(gate.Value).trim())) return '';
  for (let i = 0; i < PROFILE_FIELDS.college.length; i++) {
    for (let j = 0; j < fields.length; j++) {
      const n = String(fields[j].FieldName || '').trim();
      if (!PROFILE_FIELDS.college[i].test(n) || PROFILE_FIELDS.collegeGate.test(n)) continue;
      const v = clean_(waText_(fields[j].Value), 90);
      if (v && !/^(none|n\/?a|no|not\b|undecided|uncommitted|select|choose|other|-+)$/i.test(v)) return v;
    }
  }
  return '';
}

/** First field whose name matches the patterns, tried in order (so the best match wins). */
function fieldMatching_(c, patterns) {
  const fields = c.FieldValues || [];
  for (let i = 0; i < patterns.length; i++) {
    for (let j = 0; j < fields.length; j++) {
      const v = fields[j].Value;
      if (patterns[i].test(String(fields[j].FieldName || '').trim()) && waText_(v).trim()) return v;
    }
  }
  return null;
}

/** "Utica, NY": the Hometown field if there is one, else the participant's city + state/province. */
/** 'CA' when the member's address is in Canada (a Country field, or a Canadian province), else ''. */
const CA_PROVINCE_NAMES = /\b(ontario|qu[ée]bec|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland|labrador|prince edward island|yukon|nunavut|northwest territories)\b/i;
const CA_PROVINCE_CODES = /^(ON|QC|BC|AB|MB|SK|NS|NB|NL|PE|PEI|YT|NU|NT)$/i;
function countryOf_(c) {
  const country = waText_(fieldMatching_(c, [/country/i])).trim();
  if (country) return /^(canada|ca|can)$/i.test(country) ? 'CA' : '';
  const state = waText_(fieldMatching_(c, PROFILE_FIELDS.state)).trim();
  if (state) return CA_PROVINCE_NAMES.test(state) || CA_PROVINCE_CODES.test(state) ? 'CA' : '';
  const own = waText_(fieldValue_(c, PROFILE_FIELDS.hometown));
  const tail = (own.split(',').pop() || '').trim();
  return /\bcanada\b/i.test(own) || CA_PROVINCE_NAMES.test(tail) || CA_PROVINCE_CODES.test(tail) ? 'CA' : '';
}

function hometownOf_(c) {
  const own = clean_(waText_(fieldValue_(c, PROFILE_FIELDS.hometown)), 60);
  if (own) return own;
  const cityName = PropertiesService.getScriptProperties().getProperty('CITY_FIELD_NAME');
  const city = clean_(waText_((cityName && fieldValue_(c, [cityName])) || fieldMatching_(c, PROFILE_FIELDS.city)), 40);
  const state = clean_(waText_(fieldMatching_(c, PROFILE_FIELDS.state)), 30);
  return [city, state].filter(Boolean).join(', ');
}

// ---------- reading a Wild Apricot contact ----------

/** Text of any field value: plain text, a choice ({Label}), or a list of choices. */
function waText_(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(waText_).filter(Boolean).join(', ');
  if (typeof v === 'object') return String(v.Label || v.Value || v.Name || '');
  return String(v);
}

/** The opt-in: a "Yes …" choice is checked and no "No …" choice is. */
function profileOptedIn_(v) {
  const labels = (Array.isArray(v) ? v : v ? [v] : []).map(function (x) { return waText_(x).trim().toLowerCase(); });
  return labels.some(function (l) { return /^yes\b/.test(l); }) && !labels.some(function (l) { return /^no\b/.test(l); });
}

/** A picture or file-attachment value → {v: version key, url, id, file: true for attachments} or null. */
function waPicture_(v) {
  if (Array.isArray(v)) v = v[0];
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' || /^\d+$/.test(String(typeof v === 'object' ? '' : v))) v = { Id: v, attachment: true };
  if (typeof v !== 'object') {
    const s = String(v);
    return /^https?:\/\//.test(s) ? { v: shortHash_('full|' + s), url: s, id: '' } : null;
  }
  const url = String(v.Url || v.url || v.Href || '');
  const id = String(v.Id || v.id || '');
  if (!url && !id) return null;
  // A picture field's link points at /Pictures/; anything else (an attachment id) is a File attachment field.
  const file = !!v.attachment || !/\/pictures\//i.test(url) && /^\d+$/.test(id);
  return { v: shortHash_((file ? 'file|' : 'full|') + id + '|' + url), url: file ? '' : url, id: id, file: file };
}

/** The best photo among the fields named like the pattern: a full-size File attachment wins over a Picture. */
function photoField_(c, pattern) {
  let best = null;
  (c.FieldValues || []).forEach(function (f) {
    if (!pattern.test(String(f.FieldName || '').trim())) return;
    const pic = waPicture_(f.Value);
    if (pic && (!best || (pic.file && !best.file))) best = pic;
  });
  return best;
}

function shortHash_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(s))
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('').slice(0, 10);
}

/** Multi-line text: keeps paragraph breaks, trims extra blank lines and spaces. */
function cleanParagraphs_(v, max) {
  return String(v || '').replace(/\r\n?/g, '\n').split('\n')
    .map(function (l) { return l.replace(/[ \t]+/g, ' ').trim(); }).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

function cleanUrl_(v) {
  const s = String(v || '').trim();
  return /^https?:\/\/[^\s<>"']+$/i.test(s) ? s.slice(0, 300) : '';
}

/** "@handle", "handle" or a full link → profile link. */
function socialUrl_(v, base) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return cleanUrl_(s);
  const h = s.replace(/^@/, '').replace(/[^A-Za-z0-9._]/g, '').slice(0, 40);
  return h ? base + h : '';
}

/** A whole-number test score, or '' when blank or outside the test's range (typos stay off the page). */
function scoreInRange_(v, lo, hi) {
  const m = String(v || '').replace(/,/g, '').match(/\d+/);
  const n = m ? Number(m[0]) : NaN;
  return n >= lo && n <= hi ? String(n) : '';
}

/** Unweighted GPA 0.00–5.00 shown with two decimals, else ''. */
function gpaValue_(v) {
  const m = String(v || '').match(/\d+(\.\d+)?/);
  const n = m ? Number(m[0]) : NaN;
  return n > 0 && n <= 5 ? n.toFixed(2) : '';
}

/** Public part of one contact, or null if they haven't opted in. */
function profileFromContact_(c) {
  const f = function (name) { return fieldValue_(c, [].concat(name)); };
  if (!profileOptedIn_(f(PROFILE_FIELDS.optIn))) return null;
  const clip = function (v, n) { return clean_(waText_(v), n); };
  return {
    memberId: String(c.Id),
    first: clean_(c.FirstName, 40), last: clean_(c.LastName, 40),
    position: clip(f(PROFILE_FIELDS.position), 40), shot: clip(f(PROFILE_FIELDS.shot), 20),
    height: clip(f(PROFILE_FIELDS.height), 20), grad: clip(PROFILE_FIELDS.grad.map(f).filter(function (v) { return waText_(v).trim(); })[0], 10),
    hometown: hometownOf_(c), country: countryOf_(c),
    indigenous: profileOptedIn_(fieldMatching_(c, PROFILE_FIELDS.heritage)),
    nation: (function (n) { return n && !pickWordFlag_(n) ? n : ''; })(clean_(waText_(fieldMatching_(c, PROFILE_FIELDS.nation)), 60)),
    gpa: clip(f(PROFILE_FIELDS.gpa), 10),
    gpaU: gpaValue_(waText_(fieldMatching_(c, PROFILE_FIELDS.gpaU))),
    sat: scoreInRange_(waText_(fieldMatching_(c, PROFILE_FIELDS.sat)), 400, 1600),
    act: scoreInRange_(waText_(fieldMatching_(c, PROFILE_FIELDS.act)), 1, 36),
    psat: scoreInRange_(waText_(fieldMatching_(c, PROFILE_FIELDS.psat)), 320, 1520),
    ncaa: profileOptedIn_(fieldMatching_(c, PROFILE_FIELDS.ncaa)),
    school: clean_(waText_(fieldMatching_(c, PROFILE_FIELDS.school)), 80), college: collegeOf_(c),
    statement: cleanParagraphs_(waText_(fieldMatching_(c, PROFILE_FIELDS.statement)), 1500),
    instagram: socialUrl_(waText_(f(PROFILE_FIELDS.instagram)), 'https://www.instagram.com/'),
    tiktok: socialUrl_(waText_(f(PROFILE_FIELDS.tiktok)), 'https://www.tiktok.com/@'),
    videos: [PROFILE_FIELDS.video1, PROFILE_FIELDS.video2, PROFILE_FIELDS.video3, PROFILE_FIELDS.video4]
      .map(function (n) { return cleanUrl_(waText_(f(n))); }).filter(Boolean),
    photo: photoField_(c, PROFILE_FIELDS.photo), header: photoField_(c, PROFILE_FIELDS.header),
    action: photoField_(c, PROFILE_FIELDS.action),   // portrait action shot for the shareable recap graphics
    songUrl: clean_(waText_(fieldMatching_(c, PROFILE_FIELDS.song)), 300),
    movie: clean_(waText_(fieldMatching_(c, PROFILE_FIELDS.movie)), 80),
    quote: clean_(waText_(fieldMatching_(c, PROFILE_FIELDS.quote)).replace(/^["“”'‘’\s]+|["“”'‘’\s]+$/g, ''), 140),
    quoteBy: clean_(waText_(fieldMatching_(c, PROFILE_FIELDS.quoteBy)).replace(/^[-–—\s]+/, ''), 60),
    renewalDue: toIsoDate_(fieldValue_(c, ['RenewalDue', 'Renewal due'])) || '',
  };
}

// ---------- lapsed members ----------
// A public player whose membership lapses keeps their page: for LAPSE_GRACE_DAYS nothing changes except a
// "renewal due" note; after that the page is locked (stats stay; awards and recruiting details are hidden)
// until they renew. Archived/deleted contacts and anyone who switches the profile to "No" are removed.
const LAPSE_GRACE_DAYS = 30;
const LAPSED_CHECKS_PER_SYNC = 40;   // lapsed profiles re-read from Wild Apricot each hourly sync (oldest first)

function isEligibleContact_(c) {
  return !!(c && c.MembershipEnabled && !c.Archived && ELIGIBLE_STATUSES.indexOf(c.Status) !== -1);
}

/** Public profile for a contact whose membership isn't active, or null (archived, not a member, or not opted in). */
function lapsedProfile_(c, prev, today) {
  if (!c || c.Archived) return null;
  const p = profileFromContact_(c);
  if (!p) return null;
  p.lapsed = (prev && prev.lapsed) || (p.renewalDue && p.renewalDue < today ? p.renewalDue : today);
  p.checked = today;
  return p;
}

/** 'active' | 'grace' | 'inactive'. Pure. */
function membershipState_(p, today) {
  // Still Active / Pending – Renewal in Wild Apricot but past the renewal date (unpaid renewal):
  // counts from the renewal date, so the 30-day "renewal due" note shows before the page locks.
  const from = p.lapsed || (p.renewalDue && p.renewalDue < today ? p.renewalDue : '');
  if (!from) return 'active';
  const days = (Date.parse(today + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000;
  return days <= LAPSE_GRACE_DAYS ? 'grace' : 'inactive';
}

/**
 * Pure-ish: public players from earlier syncs who aren't active any more. Re-reads up to `limit` of them
 * (least recently checked first) with getOne(id); the rest keep their last saved profile.
 */
function carryLapsed_(previous, activeIds, getOne, today, limit) {
  const out = [];
  const gone = previous.filter(function (p) { return p.memberId && !activeIds[p.memberId]; })
    .sort(function (a, b) { return String(a.checked || '') < String(b.checked || '') ? -1 : 1; });
  gone.forEach(function (prev, i) {
    if (i >= limit) { out.push(prev); return; }
    let c = null;
    try { c = getOne(prev.memberId); } catch (err) { console.error(err); out.push(prev); return; }
    if (isEligibleContact_(c)) { const p = profileFromContact_(c); if (p) out.push(p); return; }   // renewed meanwhile
    const p = lapsedProfile_(c, prev, today);
    if (p) out.push(p);
  });
  return out;
}

// ---------- the Profiles table ----------

/** Stable public ID for a member: "morgan-santos-3f9a1c" (the Member ID itself is never shown). */
function profileSlug_(p) {
  const props = PropertiesService.getScriptProperties();
  let salt = props.getProperty('PROFILE_SALT');
  if (!salt) { salt = Utilities.getUuid(); props.setProperty('PROFILE_SALT', salt); }
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + p.memberId)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('').slice(0, 6);
  const name = (p.first + '-' + p.last).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return (name ? name + '-' : '') + hash;
}

/** Replaces the Profiles table with this sync's opted-in members. */
function saveProfiles_(profiles) {
  try { applyPicks_(profiles, readProfiles_(), profiles); } catch (err) { console.error('My Picks: ' + err.message); }
  const now = nowText_();
  const rows = profiles.map(function (p) {
    return { MemberID: p.memberId, Slug: profileSlug_(p), Json: JSON.stringify(p), UpdatedAt: now };
  });
  rewriteTable_('Profiles', rows);
  console.log('Public profiles: ' + rows.length + ' opted-in member(s).');
}

function readProfiles_() {
  return readAll_('Profiles').map(function (r) {
    const p = JSON.parse(r.Json || '{}');
    p.slug = r.Slug;
    return p;
  });
}

// ---------- the public feed ----------

function seasonOf_(iso) {
  if (!iso) return '';
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7));
  const start = m >= 8 ? y : y - 1; // seasons run August–July
  return start + '/' + String((start + 1) % 100).padStart(2, '0');
}

/** Pure: the public feed from profiles, stat lines and events (for testing). */
function buildPublicFeed_(profiles, lines, events, logos, awards, allstars, teamLogos, today, watch, champs) {
  today = today || todayIso_();
  const byMember = {};
  profiles.forEach(function (p) { byMember[p.memberId] = p; });
  const evById = {};
  events.forEach(function (e) { if (e.id) evById[e.id] = e; });
  const used = {};
  const players = profiles.map(function (p) {
    const mine = lines.filter(function (l) { return l.MemberID === p.memberId; });
    const groups = {};
    mine.forEach(function (l) {
      const k = l.EventID + '|' + l.TeamName;
      const g = groups[k] || (groups[k] = { event: l.EventID, team: l.TeamName, division: l.Division,
        tier: evById[l.EventID] && evById[l.EventID].league ? 'League' : l.Tier,   // leagues get their own heading
        gp: 0, g: 0, a: 0, pts: 0, pim: 0, goalie: false, games: [] });
      g.gp += Number(l.GP) || 0; g.g += Number(l.G) || 0; g.a += Number(l.A) || 0; g.pim += Number(l.PIM) || 0;
      g.pts = g.g + g.a;
      if (l.Goalie === 'yes') g.goalie = true;
      g.games.push({ date: l.GameDate, no: l.GameNo, opp: l.Opponent, g: Number(l.G) || 0, a: Number(l.A) || 0, pim: Number(l.PIM) || 0 });
      used[l.EventID] = true;
    });
    const myAwards = ((awards && awards[p.memberId]) || []).map(function (a) {
      used[a.event] = true;
      return { event: a.event, award: a.award, division: a.division, tier: a.tier || '', team: a.team };
    });
    const stats = Object.keys(groups).map(function (k) {
      const g = groups[k];
      g.games.sort(function (x, y) { return x.date < y.date ? -1 : x.date > y.date ? 1 : 0; });
      return g;
    });
    const state = membershipState_(p, today);
    const locked = state === 'inactive';   // lapsed past the grace period: recruiting details stay private until renewal
    return {
      slug: p.slug, first: p.first, last: p.last, position: p.position, shot: p.shot,
      height: p.height, grad: p.grad, hometown: locked ? '' : p.hometown || '', gpa: locked ? '' : p.gpa || '',
      gpaU: locked ? '' : p.gpaU || '', sat: locked ? '' : p.sat || '', act: locked ? '' : p.act || '', psat: locked ? '' : p.psat || '',
      ncaa: !locked && !!p.ncaa,
      statement: locked ? '' : p.statement || '', school: locked ? '' : p.school || '', college: locked ? '' : p.college || '',
      instagram: locked ? '' : p.instagram, tiktok: locked ? '' : p.tiktok, videos: locked ? [] : p.videos || [],
      photo: p.photo ? p.photo.v : '', header: locked || !p.header ? '' : p.header.v, stats: stats, awards: locked ? [] : myAwards,
      picks: locked ? null : p.picks || null, action: locked || !p.action ? '' : p.action.v,
      country: p.country || '', indigenous: !!p.indigenous, nation: p.indigenous ? p.nation || '' : '',
      membership: state, renewBy: state === 'grace' ? (p.lapsed || p.renewalDue) : '',
    };
  });
  Object.keys(allstars || {}).forEach(function (id) { used[id] = true; });
  Object.keys(watch || {}).forEach(function (id) { used[id] = true; });
  Object.keys(champs || {}).forEach(function (id) { used[id] = true; });
  const evOut = Object.keys(used).map(function (id) {
    const e = evById[id] || { name: id };
    return { id: id, name: e.name, tier: e.league ? 'League' : eventTier_(e.name), premium: premiumEvent_(e), start: e.start || '', end: e.end || '', season: seasonOf_(e.start || ''),
      logo: (logos && logos[id] && logos[id].v) || '', allstars: (allstars && allstars[id]) || [], watch: (watch && watch[id]) || [],
      champs: (champs && champs[id]) || [] };
  }).sort(function (a, b) { return a.start < b.start ? -1 : 1; });
  const teams = [];
  Object.keys(teamLogos || {}).forEach(function (k) { teams.push({ key: k, name: teamLogos[k].name, logo: teamLogos[k].v }); });
  return { updated: new Date().toISOString(), events: evOut, players: players, teams: teams };
}

function publicFeed_() {
  const lines = readAll_('StatLines');
  const awards = publicAwards_();
  const profiles = readProfiles_();
  const allstars = publicAllStars_(profiles);
  const watch = publicWatch_(profiles);
  const ids = {};
  lines.forEach(function (l) { ids[l.EventID] = true; });
  Object.keys(awards).forEach(function (m) { awards[m].forEach(function (a) { ids[a.event] = true; }); });
  Object.keys(allstars).forEach(function (id) { ids[id] = true; });
  Object.keys(watch).forEach(function (id) { ids[id] = true; });
  const champs = publicChamps_();
  Object.keys(champs).forEach(function (id) { ids[id] = true; });
  return attachLeagueWeeks_(buildPublicFeed_(profiles, lines, readEventsTab_(), eventLogos_(Object.keys(ids)), awards, allstars,
    teamLogos_(lines.concat(watchLogoLines_(), seLeagueLogoLines_())), undefined, watch, champs), lines, profiles);
}

// ---------- team logos ----------
// 1) The "Team Logos" folder (USBOXLA staff): file named exactly like the team, e.g. "ECE HS.png" – always wins.
// 2) Otherwise the logo the team's manager / the director put in that event's Logos folder (latest event first).

function teamLogoKey_(name) { return shortHash_('team|' + norm_(name)); }

function teamLogoFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('TEAM_LOGOS_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (err) { console.error(err); } }
  const folder = DriveApp.getFolderById(rootFolderId_()).createFolder('Team Logos');
  props.setProperty('TEAM_LOGOS_FOLDER_ID', folder.getId());
  return folder;
}

/** {key: {name, v, file}} for the teams in these stat lines that have a logo. Pass onlyKey to look up just one. */
function teamLogos_(lines, onlyKey) {
  if (!onlyKey) {   // the feed asks often; Drive lookups are slow, so remember the answer for 10 minutes
    const cache = CacheService.getScriptCache();
    const hit = cache.get('team_logos');
    if (hit) {
      const saved = JSON.parse(hit), out = {};
      Object.keys(saved).forEach(function (k) { out[k] = { name: saved[k].name, v: saved[k].v }; });
      return out;
    }
    const fresh = teamLogosUncached_(lines);
    const slim = {};
    Object.keys(fresh).forEach(function (k) { slim[k] = { name: fresh[k].name, v: fresh[k].v }; });
    try { cache.put('team_logos', JSON.stringify(slim), 600); } catch (err) { console.error(err); }
    return fresh;
  }
  return teamLogosUncached_(lines, onlyKey);
}

function teamLogosUncached_(lines, onlyKey) {
  const latest = {};   // norm name → {name, events: [eventId…] newest first}
  lines.slice().sort(function (a, b) { return String(b.GameDate) < String(a.GameDate) ? -1 : 1; }).forEach(function (l) {
    const n = norm_(l.TeamName);
    if (!n || (onlyKey && teamLogoKey_(l.TeamName) !== onlyKey)) return;
    const t = latest[n] || (latest[n] = { name: l.TeamName, events: [] });
    if (t.events.indexOf(l.EventID) === -1) t.events.push(l.EventID);
  });
  const names = Object.keys(latest);
  const out = {};
  if (!names.length) return out;
  const found = function (n, f) {
    out[teamLogoKey_(latest[n].name)] = { name: latest[n].name, v: shortHash_(f.getId() + '|' + f.getLastUpdated().getTime()), file: f };
  };
  try {
    const it = teamLogoFolder_().getFiles();
    while (it.hasNext()) {
      const f = it.next();
      const n = norm_(String(f.getName()).replace(/\.[^.]+$/, ''));
      if (latest[n] && !out[teamLogoKey_(latest[n].name)] && String(f.getMimeType()).indexOf('image/') === 0) found(n, f);
    }
  } catch (err) { console.error(err); }
  const eventData = {}, teamData = readAll_('TeamData');
  readAll_('EventData').forEach(function (d) { eventData[d.EventID] = d; });
  names.forEach(function (n) {
    if (out[teamLogoKey_(latest[n].name)]) return;
    latest[n].events.some(function (evId) {
      const team = teamData.filter(function (t) { return t.EventID === evId && norm_(t.TeamName) === n; })[0];
      if (!team || !eventData[evId]) return false;
      try { const f = findLogos_(eventData[evId], team).team; if (f) { found(n, f); return true; } } catch (err) { console.error(err); }
      return false;
    });
  });
  return out;
}

/** {v, mime, b64} for one team's logo. */
function publicTeamLogo_(key) {
  if (!/^[a-f0-9]{10}$/.test(key)) return { error: 'not found' };
  const l = teamLogos_(readAll_('StatLines').concat(watchLogoLines_()), key)[key];
  if (!l) return { error: 'not found' };
  let blob = l.file.getSize() <= 1500000 ? l.file.getBlob() : driveImage_(l.file, 800);
  if (!blob) blob = l.file.getThumbnail();
  const mime = String(blob.getContentType() || '');
  if (!/^image\/(jpeg|png|gif|webp)$/i.test(mime)) return { error: 'not an image' };
  return { v: l.v, mime: mime, b64: Utilities.base64Encode(blob.getBytes()) };
}

/** Admin: makes (or finds) the Team Logos folder and lists which teams have a logo. */
function setupTeamLogos() {
  console.log('Team Logos folder: ' + teamLogoFolder_().getUrl());
  console.log('Name each file exactly like the team on the roster, e.g. "ECE HS.png". It replaces any logo from an event.');
  const lines = readAll_('StatLines');
  const logos = teamLogosUncached_(lines);
  const all = {};
  lines.forEach(function (l) { if (l.TeamName) all[l.TeamName] = true; });
  Object.keys(all).sort().forEach(function (n) { console.log((logos[teamLogoKey_(n)] ? '✓ ' : '· no logo  ') + n); });
}

/** {eventId: {v, file}} – the tournament logo in each event's Logos folder (same file the emails use). */
function eventLogos_(ids) {
  const out = {};
  readAll_('EventData').forEach(function (d) {
    if (ids.indexOf(d.EventID) === -1) return;
    try {
      const f = findLogos_(d, null).event;
      if (f) out[d.EventID] = { v: shortHash_(f.getId() + '|' + f.getLastUpdated().getTime()), file: f };
    } catch (err) { console.error(err); }
  });
  return out;
}

/** {v, mime, b64} for one event's logo – big files come as an 800px copy made by Drive. */
function publicLogo_(eventId) {
  const l = eventLogos_([eventId])[eventId];
  if (!l) return { error: 'not found' };
  let blob = l.file.getSize() <= 1500000 ? l.file.getBlob() : driveImage_(l.file, 800);
  if (!blob) blob = l.file.getThumbnail();
  const mime = String(blob.getContentType() || '');
  if (!/^image\/(jpeg|png|gif|webp)$/i.test(mime)) return { error: 'not an image' };
  return { v: l.v, mime: mime, b64: Utilities.base64Encode(blob.getBytes()) };
}

/** A copy of a Drive image at most px wide/high, made by Drive (or null). */
function driveImage_(file, px) {
  try {
    const auth = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
    const meta = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + file.getId() + '?fields=thumbnailLink',
      { headers: auth, muteHttpExceptions: true });
    const link = meta.getResponseCode() === 200 ? JSON.parse(meta.getContentText()).thumbnailLink : '';
    if (!link) return null;
    const img = UrlFetchApp.fetch(link.replace(/=s\d+$/, '') + '=s' + px, { headers: auth, muteHttpExceptions: true });
    return img.getResponseCode() === 200 ? img.getBlob() : null;
  } catch (err) {
    console.error(err);
    return null;
  }
}

/** {mime, b64} for one opted-in player's picture. */
function publicPhoto_(slug, kind) {
  const p = readProfiles_().filter(function (x) { return x.slug === slug; })[0];
  const pic = p && (kind === 'header' ? p.header : kind === 'action' ? p.action : p.photo);
  if (!pic || (kind !== 'photo' && membershipState_(p, todayIso_()) === 'inactive')) return { error: 'not found' };
  const auth = getAuth_();
  let url;
  if (pic.file) {
    url = WA_API_BASE + '/accounts/' + auth.accountId + '/attachments/' + encodeURIComponent(pic.id);  // the original upload
  } else {
    const base = pic.url || (WA_API_BASE + '/accounts/' + auth.accountId + '/pictures/' + encodeURIComponent(pic.id));
    url = base + (base.indexOf('?') === -1 ? '?' : '&') + 'fullSize=true';
  }
  const res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + auth.token }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return { error: 'picture unavailable (' + res.getResponseCode() + ')' };
  const bytes = res.getContent();
  const mime = imageType_(bytes) || String(res.getBlob().getContentType() || '');
  if (!/^image\/(jpeg|png|gif|webp)$/i.test(mime)) return { error: 'not an image' };
  if (bytes.length > 20 * 1024 * 1024) return { error: 'image too large' };
  return { v: pic.v, mime: mime, b64: Utilities.base64Encode(bytes) };
}

/** Image type from the file's first bytes (attachments don't always say). */
function imageType_(b) {
  const u = function (i) { return b[i] & 255; };
  if (b.length < 12) return '';
  if (u(0) === 0xFF && u(1) === 0xD8) return 'image/jpeg';
  if (u(0) === 0x89 && u(1) === 0x50 && u(2) === 0x4E && u(3) === 0x47) return 'image/png';
  if (u(0) === 0x47 && u(1) === 0x49 && u(2) === 0x46) return 'image/gif';
  if (u(0) === 0x52 && u(1) === 0x49 && u(8) === 0x57 && u(9) === 0x45) return 'image/webp';
  return '';
}

/** doGet for ?api=… (public, read-only). */
function publicApi_(e) {
  const p = e.parameter;
  let out;
  try {
    if (p.api === 'stats') out = publicFeed_();
    else if (p.api === 'photo') out = publicPhoto_(String(p.p || ''), String(p.k || 'photo'));
    else if (p.api === 'logo') out = publicLogo_(String(p.e || ''));
    else if (p.api === 'teamlogo') out = publicTeamLogo_(String(p.t || ''));
    else if (p.api === 'sanctioned') out = publicSanctioned_();
    else if (p.api === 'champphoto') out = publicChampPhoto_(String(p.e || ''), String(p.d || ''), String(p.m || ''));
    else if (p.api === 'leaguephoto') out = publicLeaguePhoto_(String(p.id || ''));
    else if (p.api === 'me') out = publicMyProfile_(String(p.id || ''));   // "View my profile" button on Wild Apricot
    else out = { error: 'unknown' };
  } catch (err) {
    console.error(err);
    out = { error: 'temporarily unavailable' };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * "View my profile" button on the Wild Apricot site: the logged-in member's public profile link.
 * Only answers for profiles that are already public (findable by name on stats.usboxla.com anyway);
 * anyone else – not opted in, not a member, unknown ID – gets the same {public:false}, so it reveals nothing new.
 */
function publicMyProfile_(id) {
  id = String(id || '').replace(/\D/g, '').slice(0, 12);
  if (!id) return { public: false };
  const row = readAll_('Profiles').filter(function (r) { return String(r.MemberID) === id; })[0];
  if (!row || !row.Slug) return { public: false };
  const p = JSON.parse(row.Json || '{}');
  return { public: true, url: 'https://stats.usboxla.com/player.php?p=' + encodeURIComponent(row.Slug),
    first: p.first || '', state: membershipState_(p, todayIso_()) };
}

/**
 * The "View my profile" box shown on the Wild Apricot My profile page, as a small page for an iframe.
 * (Wild Apricot's security policy blocks direct data calls to Google, so the box is framed – same as /register.)
 * It reports its height to the Wild Apricot page so the frame fits.
 */
function myProfileFrame_(id) {
  const r = publicMyProfile_(id);
  const esc = function (s) { return String(s || '').replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  let body;
  if (r.public) {
    const who = r.first ? esc(r.first) + '\u2019s' : 'Your';
    let note = 'See what coaches and fans see on stats.usboxla.com. Changes you save here show up on the profile within about an hour.';
    if (r.state === 'grace') note = '<b>Membership renewal due.</b> Renew to keep the photo, academics and highlight videos public. ' + note;
    if (r.state === 'inactive') note = '<b>Membership lapsed:</b> stats still show, but award badges, the photo, academics and videos are hidden until you renew.';
    body = '<div class="box"><div class="t"><p class="k">USBOXLA Player Profile</p><p class="h">' + who + ' public player profile is live</p>' +
      '<p class="p">' + note + '</p></div><a class="b" href="' + esc(r.url) + '" target="_blank" rel="noopener">View my profile &rarr;</a></div>';
  } else {
    body = '<div class="box off"><div class="t"><p class="k">USBOXLA Player Profile</p><p class="h">Your player profile isn\u2019t public yet</p>' +
      '<p class="p">To turn it on, click <b>Edit profile</b>, set <b>Public Player Profile Stats Page</b> to <b>Yes</b> and save. ' +
      'It appears on <a class="l" href="https://stats.usboxla.com/players.php" target="_blank" rel="noopener">stats.usboxla.com</a> within about an hour. ' +
      'Profiles are for active USBOXLA player members.</p></div></div>';
  }
  const html = '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0;background:transparent;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}' +
    '.box{display:flex;align-items:center;gap:18px;flex-wrap:wrap;padding:18px 22px;background:#0a1d3f;color:#fff;border-radius:8px;border-left:6px solid #c8102e;box-sizing:border-box}' +
    '.t{flex:1 1 300px;min-width:0}' +
    '.k{font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#9fc3ff;margin:0 0 4px}' +
    '.h{font-size:20px;font-weight:700;line-height:1.25;margin:0 0 4px}' +
    '.p{font-size:14px;line-height:1.45;margin:0;color:#dfe7f5}.p b{color:#fff}' +
    'a.b{display:inline-block;flex:0 0 auto;background:#c8102e;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 20px;border-radius:6px;white-space:nowrap}' +
    'a.b:hover{background:#a50d26}a.l{color:#9fc3ff;font-weight:600}' +
    '.off{background:#f3f6fb;color:#0a1d3f;border:1px solid #dde3ee;border-left:6px solid #005ec4}' +
    '.off .p{color:#3c4b66}.off .p b{color:#0a1d3f}.off .k{color:#005ec4}.off a.l{color:#005ec4}' +
    '</style></head><body>' + body +
    '<script>function h(){try{window.top.postMessage({usbxMpHeight:document.documentElement.scrollHeight},"*")}catch(e){}}' +
    'window.addEventListener("load",h);window.addEventListener("resize",h);if(window.ResizeObserver)new ResizeObserver(h).observe(document.body);h();<\/script>' +
    '</body></html>';
  return HtmlService.createHtmlOutput(html).setTitle('USBOXLA')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Upcoming tournaments from usboxla.com/tourney, for the "Now Sanctioned" post (public listing data only). */
function publicSanctioned_() {
  return { events: upcomingSanctioned_().map(function (r) {
    return { k: r.k, name: r.Name, start: r.StartDate, end: r.EndDate || r.StartDate,
      place: [r.City, r.State].filter(Boolean).join(', '), logo: r.LogoUrl || '' };
  }) };
}

/** Admin tool: logs every profile field shape for the first opted-in member (to check photo values). */
function inspectProfiles() {
  const list = readProfiles_();
  console.log(list.length + ' opted-in profile(s).');
  list.forEach(function (p) {
    console.log(p.first + ' ' + p.last + ': hometown "' + (p.hometown || '') + '", grad "' + (p.grad || '') + '", GPA "' + (p.gpa || '') +
      '", school "' + (p.school || '') + '", college "' + (p.college || '') + '", statement ' + (p.statement ? p.statement.length + ' chars' : 'none'));
  });
}

/** Admin: lists the Wild Apricot fields for school, college, grad year and GPA, and every college choice. */
function inspectCollegeFields() {
  const fields = waGet_('/contactfields') || [];
  fields.filter(function (f) { return /school|college|university|commit|grad|gpa/i.test(f.FieldName || ''); }).forEach(function (f) {
    const vals = (f.AllowedValues || []).map(function (v) { return v.Label || v.Value || ''; }).filter(Boolean);
    console.log('FIELD "' + f.FieldName + '" · ' + f.Type + ' · ' + (f.IsBuiltIn ? 'built-in' : f.MemberOnly ? 'member-only' : 'custom') + ' · ' + vals.length + ' choice(s)');
    for (let i = 0; i < vals.length; i += 60) console.log('  ' + vals.slice(i, i + 60).join(' | '));
  });
}

// ---------- instant updates: Wild Apricot webhook ----------
// Wild Apricot calls  …/exec?wa=KEY  whenever a contact's profile changes (Settings › Integration › Webhooks).
// We re-read just that member and update their public profile within seconds, instead of waiting for the hourly sync.

/** The contact ID inside a Wild Apricot webhook message (any of the shapes it uses). Pure, for testing. */
function webhookContactId_(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const look = [msg, msg.Parameters || {}, msg.parameters || {}];
  for (let i = 0; i < look.length; i++) {
    const keys = Object.keys(look[i]);
    for (let j = 0; j < keys.length; j++) {
      if (/^(contact\.?id|contactid)$/i.test(keys[j]) && /^\d+$/.test(String(look[i][keys[j]]))) return String(look[i][keys[j]]);
    }
  }
  return '';
}

/** doPost for ?wa=KEY. Returns a small JSON answer; never reveals anything about the member. */
function waWebhook_(e) {
  const key = PropertiesService.getScriptProperties().getProperty('WEBHOOK_KEY');
  if (!key || String(e.parameter.wa || '') !== key) return { ok: false };
  let msg = {};
  try { msg = JSON.parse((e.postData && e.postData.contents) || '{}'); } catch (err) { /* ignore */ }
  const id = webhookContactId_(msg);
  if (!id) return { ok: true, skipped: 'no contact' };
  // Wild Apricot can send several messages for one save; handle each member at most once per 20 seconds.
  const cache = CacheService.getScriptCache();
  if (cache.get('wh_' + id)) return { ok: true, skipped: 'recent' };
  cache.put('wh_' + id, '1', 20);
  refreshProfile_(id);
  return { ok: true };
}

/** Re-reads one member from Wild Apricot and updates (or removes) their public profile. */
function refreshProfile_(id) {
  const c = getContact_(id);
  const prev = readProfiles_().filter(function (x) { return String(x.memberId) === String(id); })[0];
  const p = isEligibleContact_(c) ? profileFromContact_(c) : lapsedProfile_(c, prev, todayIso_());
  // Most changes are to members without a public profile – nothing to do unless they just switched it off.
  if (!p && !prev) return;
  withLock_(function () {
    const rows = readAll_('Profiles').filter(function (r) { return String(r.MemberID) !== String(id); });
    if (p) {
      try {
        const others = rows.map(function (r) { const x = JSON.parse(r.Json || '{}'); x.slug = r.Slug; return x; });
        applyPicks_([p], prev ? [prev] : [], others.concat([p]));
      } catch (err) { console.error('My Picks: ' + err.message); }
    }
    if (p) rows.push({ MemberID: p.memberId, Slug: profileSlug_(p), Json: JSON.stringify(p), UpdatedAt: nowText_() });
    rewriteTable_('Profiles', rows);
  });
  console.log('Profile ' + (p ? 'updated' : 'removed/not public') + ' for one member (webhook).');
}

/**
 * Admin tool – run once: makes the private webhook key (if there isn't one) and logs the address to
 * paste into Wild Apricot › Settings › Integration › Webhooks. Treat that address like a password.
 */
function setupProfileWebhook() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('WEBHOOK_KEY');
  if (!key) { key = Utilities.getUuid().replace(/-/g, ''); props.setProperty('WEBHOOK_KEY', key); }
  const base = props.getProperty('WEBAPP_URL') || ScriptApp.getService().getUrl();
  console.log('Paste this into Wild Apricot (Webhooks › Add › URL), notification type: Contact:\n' + base + '?wa=' + key);
}

// ======================= My Picks: pump-up song, favourite movie, sports quote =======================
//
// Wild Apricot fields (text boxes, member-editable): "Favorite Pump Up Song" (a Spotify or Apple Music song link),
// "Favorite Movie", "Favorite Sports Quote", "Quote By".
//   • Song: no keys needed. Apple Music links are checked with Apple's free lookup. Spotify links: the song name and
//     artist come from the public Spotify page, then Apple's catalogue says whether the song has explicit lyrics
//     (any explicit or "clean edit" version → hidden, to be safe). Songs we can't match wait in Profile Review.
//     The page plays it with the service's own embed (cover art + preview).
//   • Movie: shown as a title card (no posters – those need a licence).
//   • Text (movie, quote, who said it) goes live straight away unless the word filter flags it; flagged text
//     waits in the Hub's "Profile Review" tab until someone ticks Approve.

const PICKS_REVIEW_TAB = 'Profile Review';
const PICKS_REVIEW_HEADERS = ['Player', 'Field', 'Text', 'Why', 'Approve', 'Key', 'Fix: paste a song link or type Song – Artist', 'Member'];
const PICKS_FIX_COL = 7, PICKS_MEMBER_COL = 8;
const SONG_LOOKUP_VERSION = 4;   // cached song results older than this are checked again
const SONG_RECHECK_DAYS = 30;

/** Fills p.song (cached lookup), p.flags and p.picks for each profile, then rebuilds the review tab from `all`. */
function applyPicks_(profiles, previous, all) {
  const prevById = {};
  (previous || []).forEach(function (x) { prevById[String(x.memberId)] = x; });
  const approved = readPickApprovals_();
  const fixes = readPickFixes_();   // Profile Review › Fix column: an admin's song link or "Song – Artist" for a member
  let lookups = 0;
  profiles.forEach(function (p) {
    const prev = prevById[String(p.memberId)];
    const fix = fixes[String(p.memberId)] || '';
    const src = fix || p.songUrl;
    let song = prev && prev.song && prev.song.src === src ? prev.song : null;
    const stale = song && ((song.checked && (Date.now() - Date.parse(song.checked)) > SONG_RECHECK_DAYS * 86400000) ||
      ((song.v || 1) < SONG_LOOKUP_VERSION && song.status !== 'ok') || (!!fix !== !!song.byAdmin));   // a fix added or removed: look again
    if (src && (!song || stale || song.status === 'retry') && lookups < 60) {
      lookups++;
      try { song = lookupSongAny_(src, !!fix); } catch (err) { song = { src: src, status: 'retry', why: String(err.message).slice(0, 80) }; }
    }
    p.song = src ? song : null;
    p.songFix = fix;
    pickResult_(p, approved);
  });
  try { writePickReview_(all || profiles); } catch (err) { console.error('Profile Review tab: ' + err.message); }
}

/** Pure: p.flags (text waiting for approval / song notes) and p.picks (what the public page shows). */
function pickResult_(p, approved) {
  const flags = [], picks = {};
  [['movie', 'Favorite Movie'], ['quote', 'Favorite Sports Quote'], ['quoteBy', 'Quote By']].forEach(function (f) {
    const text = p[f[0]];
    if (!text) return;
    const hit = pickWordFlag_(text);
    const key = p.memberId + '|' + f[0] + '|' + shortHash_(text);
    if (hit && !approved[key]) { flags.push({ field: f[1], text: text, why: 'Word filter: “' + hit + '”', key: key }); return; }
    picks[f[0]] = text;
  });
  if (picks.quoteBy && !picks.quote) delete picks.quoteBy;
  const s = p.song;
  const songKey = s ? p.memberId + '|song|' + s.kind + ':' + s.id : '';
  if (s && !s.explicit && (s.status === 'ok' || (s.status === 'review' && approved[songKey]))) {
    picks.song = { kind: s.kind, id: s.id, title: s.title, artist: s.artist, path: s.path || '' };
  } else if (s && s.status === 'review') {
    flags.push({ field: 'Pump Up Song', text: s.title + ' – ' + s.artist, key: songKey,
      why: s.guessed ? 'Matched from the song name they typed (“' + clean_(s.src, 60) + '”) – listen, then tick Approve'
        : 'Couldn’t confirm it’s clean – listen, then tick Approve' });
  } else if (s) {
    const why = s.explicit ? 'Explicit song – hidden' : s.status === 'not_song' ? 'Not a Spotify or Apple Music song link – add a fix'
      : s.status === 'not_found' ? 'Song not found' : 'Couldn’t check yet – tries again next sync';
    flags.push({ field: 'Pump Up Song', text: (s.title ? s.title + ' – ' + s.artist : s.src), why: why, key: '', info: true });
  }
  p.flags = flags;
  p.picks = Object.keys(picks).length ? picks : null;
}

/** Pure: the first word that trips the filter, or ''. Catches s3pl1ng, sp.a.c.i.n.g and stretched letters. */
function pickWordFlag_(text) {
  const norm = String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[0@4]/g, function (ch) { return ch === '0' ? 'o' : 'a'; }).replace(/[1!|]/g, 'i').replace(/3/g, 'e')
    .replace(/[5$]/g, 's').replace(/7/g, 't');
  const words = norm.split(/[^a-z*]+/).filter(Boolean);
  const squeeze = function (w) { return w.replace(/(.)\1+/g, '$1'); };
  const joined = norm.replace(/[^a-z]/g, '');
  const STEMS = ['fuck', 'fuk', 'fck', 'shit', 'sht', 'bitch', 'cunt', 'puss', 'nigg', 'nigga', 'fagg', 'whore', 'slut', 'retard',
    'dildo', 'porn', 'jizz', 'asshole', 'bastard', 'motherf', 'wtf', 'stfu', 'goddam', 'bullshit', 'horny', 'tranny', 'wetback'];
  const WORDS = ['ass', 'asses', 'dick', 'dicks', 'cock', 'cocks', 'cum', 'fag', 'fags', 'hell', 'damn', 'sex', 'sexy', 'tit', 'tits',
    'titty', 'boob', 'boobs', 'coon', 'spic', 'kike', 'gook', 'dyke', 'rape', 'raped', 'rapist', 'kys', 'nazi', 'homo', 'penis',
    'vagina', 'piss', 'pissed', 'crap', 'weed', 'stoned', 'beaner', 'chink', 'jackass', 'dumbass', 'smartass', 'badass'];
  for (let i = 0; i < words.length; i++) {
    const w = words[i], q = squeeze(w);
    if (/\*/.test(w) && w.replace(/\*/g, '').length >= 1) return w;   // f**k, s***
    for (let j = 0; j < STEMS.length; j++) if (w.indexOf(STEMS[j]) === 0 || q.indexOf(STEMS[j]) === 0) return w;
    if (WORDS.indexOf(w) !== -1 || WORDS.indexOf(q) !== -1) return w;
  }
  // Spaced-out words ("f u c k") – only the strongest ones, to avoid false alarms.
  const runs = (norm.match(/\b(?:[a-z][^a-z]+){2,}[a-z]\b/g) || []).map(function (r) { return r.replace(/[^a-z]/g, ''); });
  for (const bad of ['fuck', 'shit', 'bitch', 'cunt', 'dick', 'cock', 'nigger', 'nigga', 'faggot']) {
    if (runs.some(function (r) { return r.indexOf(bad) !== -1; })) return bad;
    if ((bad === 'nigger' || bad === 'faggot') && joined.indexOf(bad) !== -1) return bad;
  }
  return '';
}

/** Pure: {kind:'spotify'|'apple', id, cc?, path?} from a song link, or {kind:'short'} / null. */
function parseSongLink_(url) {
  let u = String(url || '').trim();
  const inText = u.match(/(https?:\/\/[^\s"'<>]+|spotify:track:[A-Za-z0-9]{22})/i);   // a link with words or invisible characters around it
  if (inText) u = inText[1].replace(/[),.;]+$/, '');
  let m = u.match(/^spotify:track:([A-Za-z0-9]{22})$/);
  if (m) return { kind: 'spotify', id: m[1] };
  m = u.match(/^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?track\/([A-Za-z0-9]{22})/i);
  if (m) return { kind: 'spotify', id: m[1] };
  if (/^https?:\/\/(spotify\.link|spotify\.app\.link)\//i.test(u)) return { kind: 'short' };
  m = u.match(/^https?:\/\/(?:embed\.)?music\.apple\.com\/([a-z]{2})\/(album|song)\/([^?#]+?)\/?(?:\?([^#]*))?(?:#.*)?$/i);
  if (m) {
    const cc = m[1].toLowerCase(), q = m[4] || '';
    const i = (q.match(/(?:^|&)i=(\d+)/) || [])[1];
    const tail = m[3].split('/');
    if (m[2] === 'song') { const id = tail[tail.length - 1]; if (/^\d+$/.test(id)) return { kind: 'apple', id: id, cc: cc, path: cc + '/song/' + m[3] }; }
    if (m[2] === 'album' && i) return { kind: 'apple', id: i, cc: cc, path: cc + '/album/' + m[3] + '?i=' + i };
    return { kind: 'apple_album' };
  }
  return null;
}

/** Looks a song link up. Returns {src, kind, id, title, artist, explicit, status, checked}. */
function lookupSong_(url) {
  let link = parseSongLink_(url);
  if (link && link.kind === 'short') {   // spotify.link short links: follow to the real track page
    const res = UrlFetchApp.fetch(url, { followRedirects: false, muteHttpExceptions: true });
    const loc = String((res.getAllHeaders() || {}).Location || (res.getAllHeaders() || {}).location || '');
    link = parseSongLink_(loc) || parseSongLink_(((res.getContentText() || '').match(/https:\/\/open\.spotify\.com\/track\/[A-Za-z0-9]{22}/) || [])[0]);
  }
  const base = { src: url, checked: new Date().toISOString() };
  if (!link || link.kind === 'apple_album' || link.kind === 'short') return Object.assign(base, { status: 'not_song' });
  if (link.kind === 'spotify') {
    const meta = spotifyMeta_(link.id);
    if (!meta) return Object.assign(base, { status: 'not_found', kind: 'spotify', id: link.id });
    const ex = appleExplicit_(meta.title, meta.artist);   // true | false | null (no match)
    return Object.assign(base, { status: ex === null ? 'review' : 'ok', kind: 'spotify', id: link.id,
      title: meta.title, artist: meta.artist, explicit: ex === true });
  }
  const res = UrlFetchApp.fetch('https://itunes.apple.com/lookup?id=' + link.id + '&country=' + (link.cc || 'us') + '&entity=song',
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return Object.assign(base, { status: 'retry', kind: 'apple', id: link.id });
  const r = ((JSON.parse(res.getContentText()) || {}).results || []).filter(function (x) { return x.wrapperType === 'track'; })[0];
  if (!r) return Object.assign(base, { status: 'not_found', kind: 'apple', id: link.id });
  return Object.assign(base, { status: 'ok', kind: 'apple', id: link.id, path: link.path, title: clean_(r.trackName, 80),
    artist: clean_(r.artistName, 80), explicit: r.trackExplicitness === 'explicit' });
}

/** Song name + artist from Spotify's public track page (no keys). null if it isn't a real track. */
function spotifyMeta_(id) {
  const res = UrlFetchApp.fetch('https://open.spotify.com/track/' + id, { muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; USBOXLA profiles)', 'Accept-Language': 'en' } });
  if (res.getResponseCode() !== 200) return null;
  const html = res.getContentText();
  const meta = function (prop) {
    const m = html.match(new RegExp('<meta[^>]+(?:property|name)="' + prop + '"[^>]+content="([^"]*)"', 'i'));
    return m ? m[1].replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').trim() : '';
  };
  const title = meta('og:title');
  // og:description looks like "AC/DC · The Razors Edge · Song · 1990"
  const artist = (meta('og:description').split(' · ')[0] || '').trim();
  if (!title || !artist) return null;
  return { title: clean_(title, 80), artist: clean_(artist, 80) };
}

/** Pure: loose match key for song titles / artists ("Thunderstruck (Live)" → "thunderstruck"). */
function songKey_(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s*[\(\[].*?[\)\]]\s*/g, ' ').replace(/\s+-\s+.*$/, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
}

/** Does Apple's catalogue have this song with explicit lyrics? true / false, or null when it can't find the song. */
function appleExplicit_(title, artist) {
  const res = UrlFetchApp.fetch('https://itunes.apple.com/search?media=music&entity=song&limit=50&country=us&term=' +
    encodeURIComponent(title + ' ' + artist), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Apple lookup HTTP ' + res.getResponseCode());
  const t = songKey_(title), a = songKey_(artist.split(',')[0]);
  const hits = ((JSON.parse(res.getContentText()) || {}).results || []).filter(function (r) {
    return songKey_(r.trackName) === t && (songKey_(r.artistName).indexOf(a) !== -1 || a.indexOf(songKey_(r.artistName)) !== -1);
  });
  if (!hits.length) return null;
  return hits.some(function (r) { return r.trackExplicitness === 'explicit' || r.trackExplicitness === 'cleaned'; });
}

/** A song link, or a typed song name ("Iron Man by Black Sabbath"): names are matched in Apple's catalogue. */
function lookupSongAny_(src, byAdmin) {
  const link = parseSongLink_(src);
  const out = link || /https?:\/\//i.test(src) ? lookupSong_(src) : songFromText_(src, byAdmin);   // a non-song link (playlist, album) stays "not a song link"
  out.v = SONG_LOOKUP_VERSION;
  // A song an admin put in the Fix column is published as chosen: no Approve tick and no explicit filter
  // (they pick the clean version). Only a link that isn't a song, or a song that can't be found, stays off.
  if (byAdmin && (out.status === 'review' || out.status === 'ok')) { out.status = 'ok'; out.explicit = false; out.byAdmin = true; }
  return out;
}

/** Typed song name → the best Apple Music match. A member's guess waits for Approve; an admin's fix shows straight away. */
function songFromText_(text, byAdmin) {
  const base = { src: text, checked: new Date().toISOString() };
  const q = String(text || '').replace(/\s+(by|ft\.?|feat\.?)\s+/gi, ' ').replace(/[–—\-:|\/]+/g, ' ')
    .replace(/[^\p{L}\p{N}'& ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (q.length < 2) return Object.assign(base, { status: 'not_song' });
  const res = UrlFetchApp.fetch('https://itunes.apple.com/search?media=music&entity=song&limit=5&country=us&term=' +
    encodeURIComponent(q), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return Object.assign(base, { status: 'retry' });
  const r = ((JSON.parse(res.getContentText()) || {}).results || []).filter(function (x) { return x.wrapperType === 'track' && x.trackId; })[0];
  if (!r) return Object.assign(base, { status: 'not_found' });
  const link = parseSongLink_(String(r.trackViewUrl || '').replace(/[?&]uo=\d+/, ''));
  return Object.assign(base, { status: byAdmin ? 'ok' : 'review', guessed: !byAdmin, kind: 'apple', id: String(r.trackId),
    path: link && link.path ? link.path : '', title: clean_(r.trackName, 80), artist: clean_(r.artistName, 80),
    // a member's typed name: any explicit or clean-edit version of the song hides it, the same as a link
    explicit: !byAdmin && (r.trackExplicitness === 'explicit' || r.trackExplicitness === 'cleaned' ||
      appleExplicit_(clean_(r.trackName, 80), clean_(r.artistName, 80)) === true) });
}

// Admin song fixes are kept in the Hub's "Song Fixes" tab, so a fixed player drops off Profile Review (which then only
// lists what still needs work). Delete a row there to undo a fix. A fix ends by itself when the player changes their
// own song in Wild Apricot (their new song is checked from scratch).
const SONGFIX_TAB = 'Song Fixes';
const SONGFIX_HEADERS = ['Player', 'Fix (song link or Song – Artist)', 'Showing on the profile', 'What they entered', 'Updated', 'Member'];

/** Song Fixes tab → { memberId: { fix, their, updated } }. */
function readSongFixStore_() {
  const sh = hub_().getSheetByName(SONGFIX_TAB);
  const out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, SONGFIX_HEADERS.length).getValues().forEach(function (r) {
    const id = String(r[5] || '').trim(), fix = clean_(r[1], 300);
    if (id && fix) out[id] = { fix: fix, their: String(r[3] || ''), updated: String(r[4] || '') };
  });
  return out;
}

/** Rewrites the Song Fixes tab. byId: memberId → profile (for the name and what's showing). */
function writeSongFixTab_(store, byId) {
  const ss = hub_();
  let sh = ss.getSheetByName(SONGFIX_TAB);
  const ids = Object.keys(store);
  if (!sh) {
    if (!ids.length) return;
    sh = ss.insertSheet(SONGFIX_TAB);
    sh.getRange(1, 1, 1, SONGFIX_HEADERS.length).setValues([SONGFIX_HEADERS])
      .setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff');
    sh.setFrozenRows(1);
    [180, 320, 300, 300, 110, 60].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
    sh.hideColumns(6);
    sh.getRange(1, 1).setNote('Pump-up songs you fixed in Profile Review. They show on the player profiles as you chose them. ' +
      'Change the Fix cell to pick a different song, or delete the row to undo. A fix ends by itself if the player ' +
      'changes their own song in Wild Apricot.');
  }
  const rows = ids.map(function (id) {
    const p = byId[id] || {};
    const s = p.song;
    const showing = p.picks && p.picks.song ? p.picks.song.title + ' – ' + p.picks.song.artist
      : s && s.status === 'not_song' ? '⚠ Not a single-song link – check the fix'
      : s && s.status === 'not_found' ? '⚠ Song not found – check the fix' : 'Updating…';
    return [clean_((p.first || '') + ' ' + (p.last || ''), 80) || id, store[id].fix, showing, store[id].their || p.songUrl || '',
      store[id].updated || nowText_(), id];
  }).sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
  const last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, SONGFIX_HEADERS.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, SONGFIX_HEADERS.length).setNumberFormat('@').setValues(rows);
}

/** Admin fixes by member: the Song Fixes tab, plus anything typed into Profile Review's Fix column since the last sync
 *  (a Fix cell cleared on a listed row removes that player's fix). Saves the merged list back to Song Fixes. */
function readPickFixes_() {
  const store = readSongFixStore_();
  let changed = false;
  const sh = hub_().getSheetByName(PICKS_REVIEW_TAB);
  if (sh && sh.getLastRow() >= 2 && sh.getLastColumn() >= PICKS_MEMBER_COL) {
    sh.getRange(2, 2, sh.getLastRow() - 1, PICKS_MEMBER_COL - 1).getValues().forEach(function (r) {
      const fix = clean_(r[PICKS_FIX_COL - 2], 300), id = String(r[PICKS_MEMBER_COL - 2] || '').trim();
      if (!id || String(r[0]) !== 'Pump Up Song') return;   // the Fix column is for song rows only
      // a new or changed Fix is saved; a blank cell changes nothing (undo = delete the row in Song Fixes)
      if (fix && (!store[id] || store[id].fix !== fix)) { store[id] = { fix: fix, their: '', updated: nowText_() }; changed = true; }
    });
  }
  if (changed) { try { writeSongFixTab_(store, {}); } catch (err) { console.error('Song Fixes tab: ' + err.message); } }
  const out = {};
  Object.keys(store).forEach(function (id) { out[id] = store[id].fix; });
  return out;
}

/** Keys ticked "Approve" in the Hub's Profile Review tab. */
function readPickApprovals_() {
  const sh = hub_().getSheetByName(PICKS_REVIEW_TAB);
  const out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, PICKS_REVIEW_HEADERS.length).getValues().forEach(function (r) {
    if (r[4] === true && r[5]) out[String(r[5])] = true;
  });
  return out;
}

/** Hub › "Profile Review": flagged text (tick Approve to show it) and songs that can't be shown. Approved rows stay. */
function writePickReview_(profiles) {
  const ss = hub_();
  let sh = ss.getSheetByName(PICKS_REVIEW_TAB);
  const approved = readPickApprovals_();
  const sheetFixes = readPickFixes_();
  const rows = [];
  profiles.forEach(function (p) {
    const name = clean_((p.first || '') + ' ' + (p.last || ''), 80);
    const id = String(p.memberId || '');
    const fix = sheetFixes[id] || p.songFix || '';
    (p.flags || []).forEach(function (f) {
      rows.push([name, f.field, f.text, f.why, false, f.key || '', f.field === 'Pump Up Song' ? fix : '', id]);
    });
    // a song fixed by an admin and now showing leaves this list: it's kept in the Song Fixes tab
    // keep approved text visible in the list (ticked) so it can be un-approved later
    ['movie', 'quote', 'quoteBy'].forEach(function (k) {
      if (!p[k] || !p.picks || p.picks[k] !== p[k]) return;
      const key = p.memberId + '|' + k + '|' + shortHash_(p[k]);
      if (approved[key]) rows.push([name, { movie: 'Favorite Movie', quote: 'Favorite Sports Quote', quoteBy: 'Quote By' }[k], p[k], 'Approved', true, key, '', id]);
    });
    const s = p.song;
    if (s && s.status === 'review' && p.picks && p.picks.song) rows.push([name, 'Pump Up Song', s.title + ' – ' + s.artist, 'Approved', true, p.memberId + '|song|' + s.kind + ':' + s.id, fix, id]);
  });
  if (!sh) {
    if (!rows.length) return;
    sh = ss.insertSheet(PICKS_REVIEW_TAB);
    sh.getRange(1, 1, 1, PICKS_REVIEW_HEADERS.length).setValues([PICKS_REVIEW_HEADERS])
      .setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff');
    sh.setFrozenRows(1);
    [180, 160, 360, 240, 80, 60, 320, 60].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
    sh.hideColumns(6);
    sh.hideColumns(PICKS_MEMBER_COL);
    sh.getRange(1, 1).setNote('Player profile "My Picks" that the word filter caught. Tick Approve to show the text on the ' +
      'player page (within the hour). Songs we couldn’t confirm are clean can be approved after a listen; songs marked ' +
      '"Explicit", "Not a … song link" or "Song not found" can’t be shown – nothing to do. ' +
      'Rebuilt automatically – only the Approve ticks are kept.');
  }
  pickReviewFixColumn_(sh);
  // Song Fixes: drop a fix when the player has since changed their own song; remember what they had entered.
  try {
    const store = readSongFixStore_(), byId = {};
    profiles.forEach(function (p) { byId[String(p.memberId)] = p; });
    Object.keys(store).forEach(function (id) {
      const p = byId[id];
      if (!p) return;
      if (store[id].their && p.songUrl !== store[id].their) { console.log('Song fix ended (player changed their song): ' + id); delete store[id]; }
      else if (!store[id].their) store[id].their = p.songUrl || '';
    });
    writeSongFixTab_(store, byId);
  } catch (err) { console.error('Song Fixes tab: ' + err.message); }
  // Fixes typed while this sync was running: read them again right before the rebuild so none are lost.
  try {
    const latest = readPickFixes_();
    rows.forEach(function (r) { if (r[1] === 'Pump Up Song' && !r[6] && latest[r[7]]) r[6] = latest[r[7]]; });
  } catch (err) { console.error('Song fixes (late read): ' + err.message); }
  const last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, PICKS_REVIEW_HEADERS.length).clearContent().clearDataValidations().setBackground(null);
  rows.sort(function (a, b) { return (a[4] === b[4] ? 0 : a[4] ? 1 : -1) || (a[5] ? 0 : 1) - (b[5] ? 0 : 1); });
  if (!rows.length) return;
  if (sh.getMaxRows() < rows.length + 1) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 1 - sh.getMaxRows());
  sh.getRange(2, 1, rows.length, PICKS_REVIEW_HEADERS.length).setValues(rows);
  rows.forEach(function (r, i) {
    const row = i + 2;
    if (r[5]) sh.getRange(row, 5).insertCheckboxes().setValue(r[4]);
    else sh.getRange(row, 5).setValue('—');
    if (r[5] && !r[4]) sh.getRange(row, 1, 1, 4).setBackground('#FFF4D6');
  });
}

/** Profile Review tabs made before Nov 11, 2026: add the Fix column (and the hidden Member column) once. */
function pickReviewFixColumn_(sh) {
  if (String(sh.getRange(1, PICKS_FIX_COL).getValue()) === PICKS_REVIEW_HEADERS[PICKS_FIX_COL - 1]) return;
  if (sh.getMaxColumns() < PICKS_MEMBER_COL) sh.insertColumnsAfter(sh.getMaxColumns(), PICKS_MEMBER_COL - sh.getMaxColumns());
  sh.getRange(1, PICKS_FIX_COL, 1, 2).setValues([[PICKS_REVIEW_HEADERS[PICKS_FIX_COL - 1], PICKS_REVIEW_HEADERS[PICKS_MEMBER_COL - 1]]])
    .setFontWeight('bold').setBackground(BRAND_BLUE).setFontColor('#ffffff');
  sh.getRange(1, PICKS_FIX_COL).setNote('Type the right song for this player – a Spotify or Apple Music song link, or the song name ' +
    'and artist (e.g. "Iron Man – Black Sabbath"). It replaces what they entered and shows on their profile within the hour ' +
    '(explicit songs stay hidden). Your fix is kept when this tab rebuilds. Clear the cell to undo.');
  sh.setColumnWidth(PICKS_FIX_COL, 320);
  sh.hideColumns(PICKS_MEMBER_COL);
}

/** Admin tool: checks the Spotify keys and the word filter. Logs only – changes nothing. */
function testMyPicks() {
  let m = null; try { m = spotifyMeta_('57bgtoPSgt236HzfBOd8kj'); } catch (err) { m = { error: err.message }; }
  console.log('Spotify page read: ' + JSON.stringify(m));
  [['Thunderstruck', 'AC/DC'], ['Lose Yourself', 'Eminem'], ['Eye of the Tiger', 'Survivor']].forEach(function (x) {
    let r; try { r = appleExplicit_(x[0], x[1]); } catch (err) { r = 'error ' + err.message; }
    console.log(x[0] + ' – ' + x[1] + ': ' + (r === true ? 'explicit/clean edit → hidden' : r === false ? 'clean → shown' : r === null ? 'not found → review' : r));
  });
  ['Hard work beats talent when talent doesn’t work hard.', 'Pain is temporary, quitting lasts forever', 'what the h3ll', 'f u c k', 'Assist king', 'Hellcats'].forEach(function (t) {
    console.log('"' + t + '" → ' + (pickWordFlag_(t) || 'OK'));
  });
}


/** Admin test for the "View my profile" button: checks the live web app for one public player and one unknown ID. */
function testMyProfileLookup() {
  const url = PropertiesService.getScriptProperties().getProperty('WEBAPP_URL') || ScriptApp.getService().getUrl();
  const row = readAll_('Profiles').filter(function (r) { return /^taylor-santos-/.test(r.Slug); })[0];
  [row ? row.MemberID : '', '1'].forEach(function (id, i) {
    const res = UrlFetchApp.fetch(url + '?api=me&id=' + encodeURIComponent(id), { muteHttpExceptions: true });
    console.log((i ? 'Unknown ID' : 'Taylor') + ' → HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  });
  console.log('Taylor member ID (for the Wild Apricot test): ' + (row ? row.MemberID : 'not found'));
}
