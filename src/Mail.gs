/**
 * Emails (sent from USBOXLA's Workspace account) and the daily job:
 * auto-verify families who joined on their own, send queued invites,
 * reminders 7 and 2 days out, and a full re-check of every roster.
 */

// Reminder emails go out this many days before the event; the last one (2 days out) is the FINAL REMINDER.
// A player rostered late gets one catch-up reminder, not a burst of them.
const REMINDER_DAYS = [14, 7, 5, 3, 2];
const FINAL_REMINDER_DAYS = 2;

const DAILY_LOCK_WAIT_MS = 120000;     // short enough to leave the job its full run time
const DAILY_RETRY_MINUTES = 15;
const DAILY_RETRY_MAX = 6;              // gives up for the day after this many tries; tomorrow's run still happens

/** Another job held the lock all morning's first try: run the daily job again soon instead of losing the day. */
function scheduleDailyRetry_() {
  const props = PropertiesService.getScriptProperties();
  const today = todayIso_();
  const saved = String(props.getProperty('DAILY_RETRY') || '').split('|');
  const tries = saved[0] === today ? Number(saved[1]) || 0 : 0;
  if (tries >= DAILY_RETRY_MAX) { console.error('dailyJobs: gave up after ' + tries + ' retries today.'); return; }
  props.setProperty('DAILY_RETRY', today + '|' + (tries + 1));
  ScriptApp.newTrigger('dailyJobsRetry').timeBased().after(DAILY_RETRY_MINUTES * 60 * 1000).create();
  console.log('dailyJobs: another job is running; retry ' + (tries + 1) + ' in ' + DAILY_RETRY_MINUTES + ' minutes.');
}

/** One-off retry: clears its own trigger, then runs the daily job. */
function dailyJobsRetry() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyJobsRetry') ScriptApp.deleteTrigger(t);
  });
  dailyJobs();
}

function dailyJobs() {
  // New sanctioned events from usboxla.com/tourney (they wait for Keelan to add a director).
  try { importSanctionedEvents(); } catch (err) { console.error(err); }
  // …and onto the website's Events list (www.usboxla.com/tournaments/).
  try { syncWebsiteEvents(); } catch (err) { console.error(err); }
  // Adam's Certified Referees List: refreshed sheet + email to the Referee-in-Chief.
  try { console.log(emailCertifiedRefereesList_()); } catch (err) { console.error(err); }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(DAILY_LOCK_WAIT_MS)) { scheduleDailyRetry_(); return; }   // another job is running: try again shortly
  try {
    const started = Date.now();
    const ctx = loadCtx_();
    const pool = pool_(ctx);
    const events = readEventsTab_().filter(function (ev) { return ev.id && ev.end >= ctx.today; });
    events.forEach(function (ev) {
      const data = ctx.eventData.filter(function (d) { return d.EventID === ev.id; })[0];
      if (!data) return;
      const evRow = { Name: ev.name, StartDate: ev.start, EndDate: ev.end };
      const daysOut = daysBetween_(ctx.today, ev.start);

      ctx.regs.filter(function (g) {
        return g.EventID === ev.id && g.Present === 'yes' && g.Status !== 'verified';
      }).forEach(function (g) {
        const team = ctx.teams.filter(function (t) { return t.TeamKey === g.TeamKey; })[0];
        if (!team) return;
        const match = poolMatchIn_(pool, g.FirstName, g.LastName, g.DOB, ev.end);
        if (match) { markVerified_(g, match.id, match.name, 'membership on file'); update_('Registrations', g); return; }
        if (!g.ParentEmail) return;                                          // no email yet: nothing to send
        if (!g.InvitedAt) { invitePlayer_(g, team, evRow, data); return; }   // was held back by email quota
        if (hoursSince_(g.InvitedAt) < 20 || daysOut < 0) return;          // just invited / event underway
        const due = REMINDER_DAYS.filter(function (d) { return daysOut <= d; }).length;
        if (due > Number(g.RemindersSent || 0) && remindPlayer_(g, team, evRow, data, daysOut)) {
          g.RemindersSent = String(due);
          update_('Registrations', g);
        }
      });

      // Safety net: re-read every roster once a day (and write any status changes back).
      ctx.teams.filter(function (t) { return t.EventID === ev.id; }).forEach(function (t) {
        if (Date.now() - started < MAX_RUN_MS) processRoster_(ev, data, t, ctx);
      });
    });
    // All-Star picks: open the morning after an event (day 1), remind on days 2 and 3, lock on day 4.
    try { awardsDaily_(ctx); } catch (err) { console.error(err); }
    // Players to Watch: open 7 days before an event, remind 4 days out (they lock in the scan, 2 days out at 8am Eastern).
    try { watchDaily_(ctx); } catch (err) { console.error(err); }
  } finally {
    lock.releaseLock();
  }
}

/** Runs after each pool sync: verifies roster players who have since become members. */
function rematchUnverified_() {
  withLock_(function () {
    const ctx = loadCtx_();
    const pool = pool_(ctx);
    let count = 0;
    readEventsTab_().filter(function (ev) { return ev.id && ev.end >= ctx.today; }).forEach(function (ev) {
      const data = ctx.eventData.filter(function (d) { return d.EventID === ev.id; })[0];
      if (!data) return;
      const touched = {};
      ctx.regs.filter(function (g) {
        return g.EventID === ev.id && g.Present === 'yes' && g.Status !== 'verified';
      }).forEach(function (g) {
        const match = poolMatchIn_(pool, g.FirstName, g.LastName, g.DOB, ev.end);
        if (!match) return;
        markVerified_(g, match.id, match.name, 'membership on file');
        update_('Registrations', g);
        touched[g.TeamKey] = true;
        count++;
      });
      ctx.teams.filter(function (t) { return touched[t.TeamKey]; })
        .forEach(function (t) { processRoster_(ev, data, t, ctx); });
    });
    if (count) console.log('Verified ' + count + ' player(s) who joined or renewed since they were rostered.');
  });
}

// ---------- messages ----------

function emailDirector_(ev, data) {
  if (ev.league) return emailLeagueDirector_(ev, data);
  return sendMail_(ev.directorEmail, 'Set up your teams for the ' + ev.name,
    ev.name + ': your Director Sheet',
    ['Hi' + (ev.directorName ? ' ' + ev.directorName : '') + ',',
     'Your Director Sheet for the ' + ev.name + ' (' + prettyRange_({ StartDate: ev.start, EndDate: ev.end }) +
     ') is ready. Add one row per team with the team manager’s email. Each manager automatically gets a ' +
     'roster sheet for their team, and every player must be a verified USBOXLA member before the event.',
     'Drop the tournament logo and team logos into the Logos folder (also shared with you). ' +
     'They appear on the page parents use to register, and the tournament logo also gets you a print-ready ' +
     '36×48" step & repeat backdrop (PDF) in that folder for a photo spot at the event.'],
    'Open Director Sheet', 'https://docs.google.com/spreadsheets/d/' + data.DirectorSheetID, logoForEmail_(data));
}

function emailManager_(ev, team, managerName, email, data) {
  if (ev.league) return emailLeagueManager_(ev, team, managerName, email, data);
  return sendMail_(email, team.TeamName + ' ' + team.Division + ' – your ' + ev.name + ' roster',
    team.TeamName + ' (' + team.Division + ') – ' + ev.name,
    ['Hi' + (managerName ? ' ' + managerName : '') + ',',
     'Your roster sheet is ready. Type or paste each player’s first name, last name and date of birth. ' +
     'Players with a current USBOXLA membership are verified automatically. For anyone who isn’t, add a ' +
     'parent’s email and they’ll get a link to register.',
     'The grey columns show who’s done. Event dates: ' + prettyRange_({ StartDate: ev.start, EndDate: ev.end }) + '.',
     'If you manage more than one ' + team.TeamName + ' team at this event, they’re all in this same sheet – one tab per division.',
     'Add your team logo: the "How this works" tab in your roster sheet has a link to your team’s logo folder. ' +
     'Within the hour we’ll add a print-ready 36×48" step & repeat backdrop with your logo to that folder – perfect for a team media day.',
     'You’ll need to be signed in to a Google account to open the sheet.'],
    'Open roster sheet', rosterUrl_(team), logoForEmail_(data));
}

const MEMBERSHIP_PRICE = '$45';

/** The parent invite: subject, heading, text and the player-profile showcase. Shared with sendTestEmail. */
function inviteParts_(first, last, teamName, division, evRow) {
  return {
    subject: 'Register ' + first + ' for the ' + evRow.Name + ' + claim ' + first + '’s player profile',
    heading: first + ' is on the roster. Let’s get ' + first + ' registered.',
    paragraphs: [
      first + ' ' + last + ' is on the ' + teamName + ' (' + division + ') roster for the ' + evRow.Name +
        ' (' + prettyRange_(evRow) + ').',
      'Every player needs a USBOXLA membership to play. It takes about two minutes and includes the player waiver. ' +
        'Already a member? Just enter your Member ID.',
      'Players who aren’t registered can’t play.'],
    button: 'Register ' + first,
    showcase: profileShowcase_(first),
  };
}

/**
 * "What membership gets you": the player profile pitch with a picture of a sample profile.
 * Returns { html, images } for sendMail_, placed under the main button.
 */
function profileShowcase_(first) {
  const li = function (b, t) {
    return '<tr><td valign="top" style="padding:0 10px 10px 0;color:#C8102E;font-weight:bold;font-size:16px">★</td>' +
      '<td style="padding:0 0 10px;line-height:1.45"><b>' + esc_(b) + '</b> ' + esc_(t) + '</td></tr>';
  };
  const html =
    '<div style="margin:24px -18px 0;padding:22px 18px 4px;background:#F3F5F9;border-top:4px solid ' + BRAND_BLUE + '">' +
    '<p style="margin:0 0 4px;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#C8102E">' +
      'Included with your membership</p>' +
    '<h3 style="margin:0 0 12px;font-size:22px;line-height:1.2;color:#0A1D3F">' + esc_(first) + '’s own player profile page</h3>' +
    '<p style="margin:0 0 14px;line-height:1.45">Every USBOXLA member gets a profile page on stats.usboxla.com to share with ' +
      'college coaches, teammates and family:</p>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 6px">' +
      li('Game stats from select sanctioned events, including the Regional and National Championships,', 'game by game, posted as soon as the official game sheet is signed off.') +
      li('All-Tournament and MVP awards', 'picked by the tournament’s coaches.') +
      li('Headshot, cover photo and college commitment', 'front and center.') +
      li('Academics, highlight videos and social links', 'all in one place.') +
    '</table>' +
    (emailPicture_('email-sample-profile.jpg') ? '<img src="cid:sample" alt="Sample USBOXLA player profile" width="524" ' +
      'style="display:block;width:100%;max-width:524px;height:auto;border:1px solid #d9dde3;border-radius:8px">' : '') +
    '<p style="margin:8px 0 16px;font-size:12px;color:#5d6570">Sample profile. You choose whether ' + esc_(first) +
      '’s profile is public, and you can add the photo, school and college any time in your member profile.</p>' +
    '<h3 style="margin:22px 0 8px;font-size:19px;line-height:1.2;color:#0A1D3F">Share it with one text</h3>' +
    '<p style="margin:0 0 12px;line-height:1.45">Every profile has its own link. Text it to family and friends or post it, ' +
      'and it shows up as a player card with ' + esc_(first) + '’s photo, team, college and awards.</p>' +
    (emailPicture_('email-share-by-text.jpg') ? '<img src="cid:share" alt="A player profile link shared by text" width="420" ' +
      'style="display:block;width:100%;max-width:420px;height:auto;margin:0 auto 16px;border-radius:8px">' : '') +
    '</div>';
  const images = {};
  const sample = emailPicture_('email-sample-profile.jpg'), share = emailPicture_('email-share-by-text.jpg');
  if (sample) images.sample = sample;
  if (share) images.share = share;
  return { html: html, images: images };
}

// Pictures for the parent invite live on the stats site (stats.usboxla.com/assets), fetched once per run.
const emailPictureCache_ = {};
function emailPicture_(name) {
  if (!(name in emailPictureCache_)) {
    try {
      const r = UrlFetchApp.fetch('https://stats.usboxla.com/assets/' + name, { muteHttpExceptions: true });
      emailPictureCache_[name] = r.getResponseCode() === 200 ? r.getBlob().setName(name) : null;
    } catch (err) { console.error(err); emailPictureCache_[name] = null; }
  }
  return emailPictureCache_[name];
}

function invitePlayer_(reg, team, evRow, data) {
  const m = inviteParts_(reg.FirstName, reg.LastName, team.TeamName, team.Division, evRow);
  const ok = sendMail_(reg.ParentEmail, m.subject, m.heading, m.paragraphs,
    m.button, registerLink_(reg), logoForEmail_(data), m.showcase);
  if (ok) { reg.InvitedAt = nowText_(); update_('Registrations', reg); }
  return ok;
}

function remindPlayer_(reg, team, evRow, data, daysOut) {
  const when = daysOut === 0 ? 'today' : daysOut === 1 ? 'tomorrow' : 'in ' + daysOut + ' days';
  const final = daysOut <= FINAL_REMINDER_DAYS;
  const subject = final
    ? 'FINAL REMINDER: Register ' + reg.FirstName + ' or ' + reg.FirstName + ' CANNOT PLAY in the ' + evRow.Name
    : 'Reminder: ' + reg.FirstName + ' isn’t registered for the ' + evRow.Name;
  const heading = final
    ? 'Final reminder: ' + reg.FirstName + ' cannot play in the ' + evRow.Name + ' without a USBOXLA membership'
    : reg.FirstName + ' still needs to register';
  return sendMail_(reg.ParentEmail, subject, heading,
    ['The ' + evRow.Name + ' starts ' + when + ' and ' + reg.FirstName + ' (' + team.TeamName + ', ' +
     team.Division + ') isn’t registered yet.',
     final ? 'This is the final reminder. Players without a verified USBOXLA membership will not be allowed to ' +
       'play – the referee checks every player against the official game sheet before each game.'
       : 'It takes about two minutes: enter your Member ID, or join USBOXLA if you don’t have one yet.',
     final ? 'Register now so ' + reg.FirstName + ' is cleared to play.' : 'Players without a verified USBOXLA membership can’t play.'],
    'Register ' + reg.FirstName, registerLink_(reg), logoForEmail_(data),
    final ? null : profileShowcase_(reg.FirstName));
}

/** Address of the parent registration page, with this player's private token. */
function registerLink_(reg) {
  const p = PropertiesService.getScriptProperties();
  // REGISTER_PAGE_URL = the registration page on the Wild Apricot site (preferred);
  // WEBAPP_URL = the Google-hosted page (fallback).
  const base = p.getProperty('REGISTER_PAGE_URL') || p.getProperty('WEBAPP_URL') || ScriptApp.getService().getUrl();
  return base + '?t=' + encodeURIComponent(reg.Token);
}

// ---------- sending ----------

function sendMail_(to, subject, heading, paragraphs, buttonText, url, logo, extra, opt) {
  opt = opt || {};
  if (MailApp.getRemainingDailyQuota() < 1) return false;
  // USBOXLA shield on the left of every email; the tournament logo on the right when there is one.
  // (A table keeps the two apart in Gmail, Outlook and phone mail apps.)
  const tile = function (img) {
    return '<span style="display:inline-block;background:#fff;border-radius:10px;padding:6px">' + img + '</span>';
  };
  const top =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
    'style="background:' + BRAND_BLUE + ';border-radius:10px 10px 0 0"><tr>' +
    '<td style="padding:14px 18px" align="left" valign="middle">' +
    tile('<img src="cid:usboxla" alt="USBOXLA" width="58" height="60" style="display:block">') + '</td>' +
    (logo ? '<td style="padding:14px 18px" align="right" valign="middle">' +
      tile('<img src="cid:logo" alt="Tournament logo" height="60" style="display:block;height:60px;width:auto;max-width:180px">') +
      '</td>' : '') +
    '</tr></table>';
  const body =
    '<div style="font-family:Arial,sans-serif;max-width:560px;color:#15181d;border:1px solid #d9dde3;border-radius:10px">' + top +
    '<div style="padding:18px">' +
    '<h2 style="margin:0 0 12px;font-size:20px">' + esc_(heading) + '</h2>' +
    paragraphs.map(function (p) { return '<p style="margin:0 0 12px;line-height:1.45">' + esc_(p) + '</p>'; }).join('') +
    '<p style="margin:20px 0"><a href="' + esc_(url) + '" style="background:' + BRAND_BLUE + ';color:#fff;text-decoration:none;' +
    'padding:12px 20px;border-radius:6px;font-weight:bold;display:inline-block">' + esc_(buttonText) + '</a></p>' +
    (extra ? extra.html +
      '<p style="margin:20px 0"><a href="' + esc_(url) + '" style="background:#C8102E;color:#fff;text-decoration:none;' +
      'padding:12px 20px;border-radius:6px;font-weight:bold;display:inline-block">' + esc_(buttonText) + '</a></p>' : '') +
    '<p style="font-size:12px;color:#5d6570">US Box Lacrosse Association. ' + esc_(opt.footer || 'This link is just for you; please don’t forward it.') + '</p>' +
    '</div></div>';
  const opts = { to: to, subject: subject, htmlBody: body, name: opt.name || 'USBOXLA' };
  opts.inlineImages = { usboxla: usboxlaLogoBlob_() };
  if (logo) opts.inlineImages.logo = logo;
  if (extra && extra.images) Object.keys(extra.images).forEach(function (k) { opts.inlineImages[k] = extra.images[k]; });
  const replyTo = opt.replyTo || PropertiesService.getScriptProperties().getProperty('REPLY_TO');
  if (replyTo) opts.replyTo = replyTo;
  MailApp.sendEmail(opts);
  return true;
}

/**
 * Admin tool (run from the editor): sends a sample parent registration email for the first live
 * event whose name contains `match`, so you can check the header logos. Nothing is saved.
 */
function sendTestEmail(to, match) {
  to = to || 'shaydonsantos@gmail.com';
  match = (match || 'Utica').toLowerCase();
  const ev = readEventsTab_().filter(function (e) { return String(e.name).toLowerCase().indexOf(match) !== -1; })[0];
  if (!ev) throw new Error('No event in the Hub matches "' + match + '".');
  const data = readAll_('EventData').filter(function (d) { return d.EventID === ev.id; })[0];
  const logo = logoForEmail_(data);
  const evRow = { Name: ev.name, StartDate: ev.start, EndDate: ev.end };
  const m = inviteParts_('Doug', 'Locker', 'ECE HS', '2027/2028', evRow);
  sendMail_(to, '[TEST] ' + m.subject, m.heading,
    m.paragraphs.concat(['This is a test email – the buttons below aren’t a real registration link.']),
    m.button, registerLink_({ Token: 'test' }), logo, m.showcase);
  console.log('Sent to ' + to + ' – tournament logo: ' + (logo ? Math.round(logo.getBytes().length / 1024) + ' KB' : 'none found'));
}

// ======================= player-profile emails =======================
/**
 * Player-profile emails to parents, sent automatically by an hourly trigger (installProfileEmailTrigger):
 *
 *  1. "Get ready" – the day before an event, to each rostered (verified) player whose public profile is
 *     missing something (not public yet, no Player Photo, no Action Shot, no My Picks). A checklist of
 *     exactly what's missing, with a sample recap graphic.
 *  1b. "Player to Watch" – about an hour after the Player to Watch picks lock (2 days before the event), to
 *     every picked player: congratulations, their own Player to Watch graphic, and – if their profile is
 *     missing a Player Photo, Action Shot or My Picks – what to add so we can feature them properly.
 *     Picked players skip the day-before "get ready" email.
 *  2. "Snap some photos" – on the first day of the event, to players with no Action Shot yet (or no public
 *     profile): take pictures at the rink, upload one as the Action Shot. Play box, get better, have fun!
 *  3. "Your recap is ready" – once the event's All-Star picks are locked and the badges are live, to every
 *     player who played (has a stat line, an award or was a Player to Watch): their stats, their badges and
 *     a link to their Share button. Public players see their own recap graphic in the email.
 *
 * Each player gets each email once per event (the ProfileMail table). Nothing goes to families until the
 * Script Property PROFILE_EMAILS_LIVE is "yes"; until then the job only logs who it would email.
 * Emails go to the address on the member's Wild Apricot record (or the parent email from the roster).
 */

const PROFILE_MAIL_HOUR = 9;              // don't send before 9am (script time zone)
const PROFILE_MAIL_PER_RUN = 150;         // emails per hourly run (the rest go next hour)
const WATCH_MAIL_WAIT_HOURS = 1;         // after Player to Watch picks lock, let the site draw the graphics
const RECAP_WAIT_HOURS = 2;               // after picks lock, give the stats site time to show the badges
const RECAP_NO_AWARDS_DAYS = 5;           // events without All-Star picks: send this many days after the end
const RECAP_MAX_AGE_DAYS = 21;            // never send recaps for events older than this
const PROFILE_MAIL_FROM = '2026-10-11';    // events that ended before this never get recap emails (no surprise emails for old events)
const OPTOUT_TAB = 'Email Opt-outs';      // Hub tab: one email address per row in column A – those families get no profile emails
const PROFILE_MAIL_REPLY_TO_DEFAULT = 'membership@usboxla.com';
const STATS_SITE = 'https://stats.usboxla.com';
const PROFILE_EDIT = 'https://membership-usboxla.wildapricot.org/Sys/Profile';

/** Run once from the editor: installs the hourly trigger. */
function installProfileEmailTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'profileEmailsHourly') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('profileEmailsHourly').timeBased().everyHours(1).create();
  console.log('Hourly player-profile emails installed. Live sending: ' + profileMailLive_());
}

function profileMailLive_() {
  return PropertiesService.getScriptProperties().getProperty('PROFILE_EMAILS_LIVE') === 'yes';
}

function profileEmailsHourly() {
  const hour = Number(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'H'));
  if (hour < PROFILE_MAIL_HOUR || hour >= 21) return;
  const started = Date.now();
  const budget = { left: PROFILE_MAIL_PER_RUN, until: started + 4 * 60 * 1000 };
  const ctx = loadCtx_();
  const sent = {};
  readAll_('ProfileMail').forEach(function (r) { sent[r.EventID + '|' + r.MemberID + '|' + r.Kind] = true; });
  const profiles = {};
  const profileList = readProfiles_();
  profileList.forEach(function (p) { if (p.memberId) profiles[p.memberId] = p; });
  try { champHourly_(ctx); } catch (err) { console.error('Champion photos: ' + err.message); }
  try { socialHourly_(ctx, profileList); } catch (err) { console.error('Social folders: ' + err.message); }
  readEventsTab_().forEach(function (ev) {
    if (!ev.id || !ev.start || budget.left <= 0 || Date.now() > budget.until) return;
    const data = ctx.eventData.filter(function (d) { return d.EventID === ev.id; })[0];
    if (!data) return;
    try {
      if (data.WatchStage === 'closed' && ev.start > ctx.today && data.WatchClosed && hoursSince_(data.WatchClosed) >= WATCH_MAIL_WAIT_HOURS)
        sendWatchPicked_(ev, data, ctx, profiles, sent, budget);
      if (daysBetween_(ctx.today, ev.start) === 1) sendGetReady_(ev, data, ctx, profiles, sent, budget);
      if (ctx.today === ev.start) sendAtEvent_(ev, data, ctx, profiles, sent, budget);
      if (recapDue_(ev, data, ctx.today)) sendRecaps_(ev, data, ctx, profiles, sent, budget);
    } catch (err) { console.error('Profile emails ' + ev.name + ': ' + err.message); }
  });
}

/** True once the badges are live (picks locked a little while ago), or a few days after an event without picks. */
function recapDue_(ev, data, today) {
  if (!ev.end || ev.end >= today || ev.end < PROFILE_MAIL_FROM || daysBetween_(ev.end, today) > RECAP_MAX_AGE_DAYS) return false;
  if (data.AwardsStage === 'closed') return !!data.AwardsClosed && hoursSince_(data.AwardsClosed) >= RECAP_WAIT_HOURS;
  if (data.AwardsStage) return false;                          // picks still open: wait for the badges
  return !data.DirectorSheetID || ev.end < AWARDS_FROM ? daysBetween_(ev.end, today) >= RECAP_NO_AWARDS_DAYS : false;
}

// ---------- 1. the day before: "get the page ready" ----------

/** What a player's profile is still missing, in the order a parent should do it. [] = complete. */
function profileGaps_(p) {
  if (!p || p.lapsed) return ['public'];
  const gaps = [];
  if (!p.photo) gaps.push('photo');
  if (!p.action) gaps.push('action');
  if (!p.songUrl && !p.movie && !p.statement) gaps.push('picks');
  return gaps;
}

function sendGetReady_(ev, data, ctx, profiles, sent, budget) {
  const seen = {};
  const picked = {};
  if (data.WatchStage === 'closed') readAll_('Watch').forEach(function (w) { if (w.EventID === ev.id && w.MemberID) picked[w.MemberID] = true; });
  ctx.regs.filter(function (g) {
    return g.EventID === ev.id && g.Present === 'yes' && g.Status === 'verified' && g.MemberID;
  }).forEach(function (g) {
    if (budget.left <= 0 || Date.now() > budget.until || seen[g.MemberID]) return;
    seen[g.MemberID] = true;
    if (sent[ev.id + '|' + g.MemberID + '|ready'] || picked[g.MemberID]) return;   // Players to Watch got their own email
    const p = profiles[g.MemberID];
    const gaps = profileGaps_(p);
    if (!gaps.length) return;                                   // all set: no email
    const first = (p && p.first) || g.FirstName;
    if (!profileMailLive_()) { console.log('[not live] would send "ready" for ' + ev.name + ' to member ' + g.MemberID + ' (missing: ' + gaps.join(', ') + ')'); return; }
    const to = parentEmail_(g);
    if (!to) return;
    const m = getReadyParts_(first, ev, gaps, p);
    if (deliverProfileMail_(to, m, data, ev, g.MemberID, 'ready', sent)) budget.left--;
  });
}

function getReadyParts_(first, ev, gaps, p) {
  const isPublic = gaps[0] !== 'public';
  const evRow = { Name: ev.name, StartDate: ev.start, EndDate: ev.end };
  const items = {
    public: ['Turn on ' + first + '’s public player profile', 'so stats, badges and the recap graphic can appear on stats.usboxla.com.'],
    photo: ['Add a Player Photo', '(a headshot) for the top of the page.'],
    action: ['Add an Action Shot', '– a vertical game photo with ' + first + ' in the top half. It becomes the background of the Instagram recap graphic.'],
    picks: ['Fill in My Picks:', 'pump-up song, favorite movie and “I like box lacrosse because…”.'],
  };
  const list = (isPublic ? gaps : ['public', 'photo', 'action', 'picks']).map(function (k) { return items[k]; });
  return {
    subject: first + '’s player page for the ' + ev.name + ' – a few minutes to finish it',
    heading: 'Get ' + first + '’s player page ready for the ' + ev.name,
    paragraphs: [
      'The ' + ev.name + ' starts tomorrow (' + prettyRange_(evRow) + '). Stats go live on ' + first + '’s USBOXLA player page during the event.',
      leagueWords_(ev, 'Once the coaches pick the All-Tournament teams and MVP, every player gets a shareable recap graphic ') +
        'with their stats and badges, sized for Instagram.',
      isPublic ? 'A few things are still missing from ' + first + '’s page:' : first + '’s profile isn’t public yet. Here’s how to set it up:'],
    button: 'Update ' + first + '’s profile',
    url: PROFILE_EDIT,
    extra: checklistHtml_(list, 'Updates appear on the site within about an hour. You choose what’s public, and you can change it any time.'),
  };
}

// ---------- Players to Watch: "you were picked" ----------

function sendWatchPicked_(ev, data, ctx, profiles, sent, budget) {
  readAll_('Watch').forEach(function (w) {
    if (w.EventID !== ev.id || !w.MemberID || budget.left <= 0 || Date.now() > budget.until) return;
    if (sent[ev.id + '|' + w.MemberID + '|watch']) return;
    const p = profiles[w.MemberID];
    if (!p || p.lapsed) return;                                  // only public players can be picked
    if (!profileMailLive_()) { console.log('[not live] would send "watch" for ' + ev.name + ' to member ' + w.MemberID); return; }
    const reg = ctx.regs.filter(function (g) { return g.EventID === ev.id && g.MemberID === w.MemberID; })[0] || { MemberID: w.MemberID };
    const to = parentEmail_(reg);
    if (!to) return;
    const m = watchPickedParts_(p, w, ev, profileGaps_(p), watchCardBlob_(p.slug, ev.id));
    if (deliverProfileMail_(to, m, data, ev, w.MemberID, 'watch', sent)) budget.left--;
  });
}

function watchPickedParts_(p, w, ev, gaps, card) {
  const first = p.first;
  const items = {
    photo: ['Add a Player Photo', '(a clear headshot). This is the picture on ' + first + '’s Player to Watch graphic – right now it shows a blank silhouette.'],
    action: ['Add an Action Shot', '– a vertical game photo with ' + first + ' in the top half. It becomes the background of the recap graphic after the event.'],
    picks: ['Fill in My Picks:', 'pump-up song, favorite movie and “I like box lacrosse because…”.'],
  };
  const evRow = { Name: ev.name, StartDate: ev.start, EndDate: ev.end };
  const paragraphs = [
    'Congratulations! ' + first + '’s coach picked ' + first + ' as a Player to Watch for the ' + ev.name + ' (' + prettyRange_(evRow) + ').',
    leagueWords_(ev, 'USBOXLA features every Player to Watch on the tournament page and on social media.')];
  if (w.Blurb) paragraphs.splice(1, 0, 'Coach’s note: “' + w.Blurb + '”');
  const fix = gaps.length
    ? '<p style="margin:0 0 10px;line-height:1.45"><b>We want to feature ' + esc_(first) + ', but ' + esc_(first) + '’s player profile is missing ' +
        (gaps.length === 1 ? 'something' : 'a few things') + '.</b> Please add:</p>' +
      checklistHtml_(gaps.map(function (k) { return items[k]; }), 'Updates appear within about an hour, and ' + first + '’s Player to Watch graphic updates on its own.', true).html
    : '<p style="margin:0 0 12px;line-height:1.45">' + esc_(first) + '’s profile is all set. Share it with family and friends!</p>';
  return {
    subject: first + ' is a Player to Watch at the ' + ev.name + '!',
    heading: first + ' is a Player to Watch at the ' + ev.name + '!',
    paragraphs: paragraphs,
    button: gaps.length ? 'Update ' + first + '’s profile' : 'See ' + first + '’s profile',
    url: gaps.length ? PROFILE_EDIT : STATS_SITE + '/player.php?p=' + encodeURIComponent(p.slug),
    extra: {
      html: fix +
        (card ? '<img src="cid:watch" alt="' + esc_(first) + ' – Player to Watch" width="400" style="display:block;width:100%;max-width:400px;height:auto;margin:10px auto 10px;border-radius:8px">' : '') +
        '<p style="margin:0 0 6px;line-height:1.45">See all the Players to Watch: <a href="' + esc_(STATS_SITE + '/watch.php?e=' + encodeURIComponent(ev.id)) + '" style="color:' + BRAND_BLUE + '">' +
        esc_(STATS_SITE.replace('https://', '') + '/watch.php') + '</a></p>',
      images: card ? { watch: card } : {},
    },
  };
}

/** The player's Player to Watch graphic (Instagram post) from the stats site, or null. */
function watchCardBlob_(slug, eventId) {
  try {
    const r = UrlFetchApp.fetch(STATS_SITE + '/watchcard.php?e=' + encodeURIComponent(eventId) + '&p=' + encodeURIComponent(slug) + '&f=post',
      { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) return null;
    const b = r.getBlob();
    return /^image\//.test(b.getContentType()) ? b.setName('watch.jpg') : null;
  } catch (err) { console.error(err); return null; }
}

// ---------- during the event: "snap some photos" ----------

function sendAtEvent_(ev, data, ctx, profiles, sent, budget) {
  const seen = {};
  ctx.regs.filter(function (g) {
    return g.EventID === ev.id && g.Present === 'yes' && g.Status === 'verified' && g.MemberID;
  }).forEach(function (g) {
    if (budget.left <= 0 || Date.now() > budget.until || seen[g.MemberID]) return;
    seen[g.MemberID] = true;
    if (sent[ev.id + '|' + g.MemberID + '|photos']) return;
    const p = profiles[g.MemberID];
    const gaps = profileGaps_(p);
    if (gaps.indexOf('public') === -1 && gaps.indexOf('action') === -1) return;   // already has an Action Shot
    if (!profileMailLive_()) { console.log('[not live] would send "photos" for ' + ev.name + ' to member ' + g.MemberID); return; }
    const to = parentEmail_(g);
    if (!to) return;
    const m = atEventParts_((p && p.first) || g.FirstName, ev, gaps[0] !== 'public');
    if (deliverProfileMail_(to, m, data, ev, g.MemberID, 'photos', sent)) budget.left--;
  });
}

function atEventParts_(first, ev, isPublic) {
  const tips = [
    ['Hold the phone upright', '– vertical photos fit the recap graphic best.'],
    ['Keep ' + first + ' in the top half', 'of the picture. The name and stats go across the bottom.'],
    ['Game action or a warm-up shot', 'in uniform both work great. Close and in focus beats far away.'],
    ['Upload it as the Action Shot', 'in your member profile' + (isPublic ? '' : ' and switch on ' + first + '’s public profile') + '. It shows up within about an hour.'],
  ];
  return {
    subject: 'Game day at the ' + ev.name + ': grab a photo of ' + first,
    heading: 'Game day! Grab a great photo of ' + first,
    paragraphs: [
      'The ' + ev.name + ' is underway. While you’re at the rink, take a few pictures of ' + first + ' and upload your favorite to ' +
        first + '’s player profile as the Action Shot.',
      leagueWords_(ev, 'After the event, it becomes the background of ') + first + leagueWords_(ev, '’s recap graphic with their stats and any All-Tournament badges, ready to post on Instagram.'),
      'Play box, get better and have fun!'],
    button: 'Upload ' + first + '’s Action Shot',
    url: PROFILE_EDIT,
    extra: checklistHtml_(tips, 'Only upload photos you took or have permission to use.'),
  };
}

// ---------- 2. after the badges are live: "your recap is ready" ----------

function sendRecaps_(ev, data, ctx, profiles, sent, budget) {
  const players = eventPlayers_(ev.id);
  Object.keys(players).forEach(function (memberId) {
    if (budget.left <= 0 || Date.now() > budget.until) return;
    if (sent[ev.id + '|' + memberId + '|recap']) return;
    const x = players[memberId];
    if (!profileMailLive_()) { console.log('[not live] would send "recap" for ' + ev.name + ' to member ' + memberId); return; }
    const reg = ctx.regs.filter(function (g) { return g.EventID === ev.id && g.MemberID === memberId; })[0] || {};
    const to = parentEmail_(reg.MemberID ? reg : { MemberID: memberId });
    if (!to) return;
    const p = profiles[memberId];
    const m = recapParts_(x, ev, p && !p.lapsed ? p : null);
    if (deliverProfileMail_(to, m, data, ev, memberId, 'recap', sent)) budget.left--;
  });
}

/** {memberId: {first, team, division, gp, g, a, pts, awards:[], watch}} for everyone who played at an event. */
function eventPlayers_(eventId) {
  const out = {};
  const get = function (id, first, team, division) {
    return out[id] || (out[id] = { first: first, team: team, division: division, gp: 0, g: 0, a: 0, pts: 0, awards: [], watch: false });
  };
  readAll_('StatLines').forEach(function (s) {
    if (s.EventID !== eventId || !s.MemberID || !(Number(s.GP) > 0)) return;
    const x = get(s.MemberID, s.FirstName, s.TeamName, s.Division);
    x.gp += Number(s.GP) || 0; x.g += Number(s.G) || 0; x.a += Number(s.A) || 0;
    x.pts += (Number(s.G) || 0) + (Number(s.A) || 0);
  });
  readAll_('Awards').forEach(function (a) {
    if (a.EventID !== eventId || !a.MemberID) return;
    get(a.MemberID, a.FirstName, a.TeamName, a.Division).awards.push(a.Award);
  });
  readAll_('Watch').forEach(function (w) {
    if (w.EventID !== eventId || !w.MemberID) return;
    get(w.MemberID, w.FirstName, w.TeamName, w.Division).watch = true;
  });
  return out;
}

function recapParts_(x, ev, p) {
  const first = (p && p.first) || x.first;
  const order = ['mvp', 'first_team', 'goalie', 'second_team', 'goalie2', 'honors'];
  const badges = x.awards.slice().sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); })
    .map(function (a) { return leagueWords_(ev, AWARD_NAMES[a] || a); });
  if (x.watch) badges.push('Player to Watch');
  const line = x.gp ? x.gp + ' GP · ' + x.g + ' G · ' + x.a + ' A · ' + x.pts + ' PTS' : '';
  const brag = badges.length ? first + ' earned: ' + badges.join(', ') + '.' : '';
  const card = p ? recapCardBlob_(p.slug, ev.id) : null;
  const statsHtml =
    '<div style="margin:4px 0 16px;padding:14px 16px;background:#0A1D3F;border-radius:10px;color:#fff">' +
    '<div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#C9D3E3">' + esc_(x.team + (x.division ? ' · ' + x.division : '')) + '</div>' +
    (line ? '<div style="font-size:24px;font-weight:bold;margin-top:4px">' + esc_(line) + '</div>' : '') +
    (badges.length ? '<div style="margin-top:8px">' + badges.map(function (b) {
      return '<span style="display:inline-block;margin:4px 6px 0 0;padding:5px 10px;border-radius:6px;font-weight:bold;font-size:13px;' +
        (b === AWARD_NAMES.mvp ? 'background:#E2B54B;color:#0A1D3F' : b === 'Player to Watch' ? 'background:#C8102E;color:#fff' : 'background:' + BRAND_BLUE + ';color:#fff') +
        '">' + esc_(b) + '</span>';
    }).join('') + '</div>' : '') + '</div>';
  if (p) {
    return {
      subject: first + '’s ' + ev.name + ' recap is ready to share',
      heading: first + '’s ' + ev.name + ' recap is ready',
      paragraphs: [leagueWords_(ev, 'The All-Tournament teams are set and ') + first + '’s stats and badges are live on stats.usboxla.com.',
        brag || 'Thanks for playing in the ' + ev.name + '!'].filter(Boolean),
      button: 'Get ' + first + '’s recap graphic',
      url: STATS_SITE + '/player.php?p=' + encodeURIComponent(p.slug) + '#share',
      extra: {
        html: statsHtml +
          (card ? '<img src="cid:recap" alt="' + esc_(first) + '’s recap graphic" width="400" style="display:block;width:100%;max-width:400px;height:auto;margin:0 auto 10px;border-radius:8px">' : '') +
          '<p style="margin:0 0 6px;line-height:1.45">On the profile, tap <b>Share</b>, pick the event and save the picture. ' +
          (p.action ? '' : 'Add an <b>Action Shot</b> to your member profile and it becomes the background (allow about an hour). ') +
          'Post it, text it to family, or send it to coaches.</p>',
        images: card ? { recap: card } : {},
      },
    };
  }
  const sample = emailPicture_('email-sample-recap.jpg');
  return {
    subject: first + '’s ' + ev.name + ' stats are in',
    heading: first + '’s ' + ev.name + ' stats are in',
    paragraphs: [leagueWords_(ev, 'The All-Tournament teams are set. Here’s how ') + first + ' did:'],
    button: 'Turn on ' + first + '’s profile',
    url: PROFILE_EDIT,
    extra: {
      html: statsHtml +
        '<p style="margin:0 0 12px;line-height:1.45">' + esc_(first) + '’s player profile isn’t public, so these stats and badges ' +
        'aren’t on stats.usboxla.com yet. Turn it on in your member profile and ' + esc_(first) + ' gets a page with every game, ' +
        'every award, and a shareable recap graphic like this one:</p>' +
        (sample ? '<img src="cid:sample" alt="Sample recap graphic" width="400" style="display:block;width:100%;max-width:400px;height:auto;margin:0 auto 10px;border-radius:8px">' : '') +
        '<p style="margin:0 0 6px;font-size:12px;color:#5d6570">Sample graphic. Updates appear within about an hour. You choose what’s public.</p>',
      images: sample ? { sample: sample } : {},
    },
  };
}

/** The player's own recap graphic from the stats site, or null. */
function recapCardBlob_(slug, eventId) {
  try {
    const r = UrlFetchApp.fetch(STATS_SITE + '/recapcard.php?p=' + encodeURIComponent(slug) + '&e=' + encodeURIComponent(eventId),
      { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) return null;
    const b = r.getBlob();
    return /^image\//.test(b.getContentType()) ? b.setName('recap.jpg') : null;
  } catch (err) { console.error(err); return null; }
}

// ---------- shared ----------

/** Checklist block (red stars), plus the sample recap graphic. */
function checklistHtml_(items, note, noSample) {
  const sample = noSample ? null : emailPicture_('email-sample-recap.jpg');
  const html =
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px">' +
    items.map(function (it) {
      return '<tr><td valign="top" style="padding:0 10px 10px 0;color:#C8102E;font-weight:bold;font-size:16px">★</td>' +
        '<td style="padding:0 0 10px;line-height:1.45"><b>' + esc_(it[0]) + '</b> ' + esc_(it[1]) + '</td></tr>';
    }).join('') + '</table>' +
    '<p style="margin:0 0 14px;font-size:13px;color:#5d6570">' + esc_(note) + '</p>' +
    (sample ? '<p style="margin:0 0 6px;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#C8102E">What players get after the event</p>' +
      '<img src="cid:sample" alt="Sample recap graphic" width="400" style="display:block;width:100%;max-width:400px;height:auto;margin:0 auto 6px;border-radius:8px">' +
      '<p style="margin:0 0 6px;font-size:12px;color:#5d6570">Sample graphic.</p>' : '');
  return { html: html, images: sample ? { sample: sample } : {} };
}

/** Where to send: the roster's parent email, else the email on the member's Wild Apricot record. */
function parentEmail_(reg) {
  const fromRoster = cleanEmail_(reg && reg.ParentEmail);
  if (fromRoster) return fromRoster;
  if (!reg || !reg.MemberID) return '';
  try { const c = getContact_(reg.MemberID); return cleanEmail_(c && c.Email); } catch (err) { console.error(err); return ''; }
}

/** Sends one email and records it so it never goes twice. */
function deliverProfileMail_(to, m, data, ev, memberId, kind, sent) {
  const key = ev.id + '|' + memberId + '|' + kind;
  if (optedOut_()[to]) { sent[key] = true; return false; }
  const ok = sendMail_(to, m.subject, m.heading, m.paragraphs, m.button, m.url, logoForEmail_(data), m.extra, profileMailOpts_());
  if (ok) {
    insert_('ProfileMail', { EventID: ev.id, MemberID: memberId, Kind: kind, SentAt: nowText_() });
    sent[key] = true;
  }
  return ok;
}

/** {email: true} from the Hub's "Email Opt-outs" tab (created on first use; staff add addresses there). */
let optOutCache_ = null;
function optedOut_() {
  if (optOutCache_) return optOutCache_;
  optOutCache_ = {};
  try {
    const ss = hub_();
    let sh = ss.getSheetByName(OPTOUT_TAB);
    if (!sh) {
      sh = ss.insertSheet(OPTOUT_TAB);
      sh.getRange(1, 1, 1, 2).setValues([['Email', 'Families listed here get no player-profile emails (Player to Watch, get ready, game day, recap).']]).setFontWeight('bold');
    }
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) {
      const e = cleanEmail_(r[0]); if (e) optOutCache_[e] = true;
    });
  } catch (err) { console.error(err); }
  return optOutCache_;
}

function profileMailOpts_() {
  const p = PropertiesService.getScriptProperties();
  return { name: 'USBOXLA Membership', replyTo: p.getProperty('PROFILE_MAIL_REPLY_TO') || PROFILE_MAIL_REPLY_TO_DEFAULT,
    footer: 'You’re receiving this because your player is a USBOXLA member on a roster for this event. ' +
      'Don’t want these player-profile emails? Reply with “stop” and we’ll take you off the list.' };
}

/**
 * Admin tool (run from the editor): sends sample copies of all five emails to `to` (default: Shaydon),
 * using made-up player "Gus" and the first event whose name contains `match`. Nothing is saved.
 */
function sendProfileEmailTests(to, match) {
  to = to || 'shaydonsantos@gmail.com';
  match = (match || 'Border Wars').toLowerCase();
  const ev = readEventsTab_().filter(function (e) { return String(e.name).toLowerCase().indexOf(match) !== -1; })[0];
  if (!ev) throw new Error('No event in the Hub matches "' + match + '".');
  const data = readAll_('EventData').filter(function (d) { return d.EventID === ev.id; })[0] || {};
  const logo = logoForEmail_(data);
  const opts = profileMailOpts_();
  const send = function (m) {
    sendMail_(to, '[TEST] ' + m.subject, m.heading, m.paragraphs.concat(['(Test email with a made-up player – the button goes to the real page.)']),
      m.button, m.url, logo, m.extra, opts);
  };
  send(getReadyParts_('Gus', ev, ['action', 'picks'], { first: 'Gus' }));
  send(watchPickedParts_({ first: 'Gus', slug: 'gus-sanchez' }, { Blurb: 'Quick hands, never stops working' }, ev, ['photo', 'action'], null));
  send(atEventParts_('Gus', ev, true));
  const x = { first: 'Gus', team: 'California Ballers', division: '2028/2027', gp: 5, g: 9, a: 7, pts: 16, awards: ['mvp'], watch: true };
  const m2 = recapParts_(x, ev, { first: 'Gus', slug: 'gus-sanchez', action: 'x' });
  m2.url = STATS_SITE + '/players.php';
  const sample = emailPicture_('email-sample-recap.jpg');               // stands in for Gus's own graphic
  if (sample) { m2.extra.html = m2.extra.html.replace(/<p style="margin:0 0 6px;line-height/, '<img src="cid:recap" alt="Recap graphic" width="400" style="display:block;width:100%;max-width:400px;height:auto;margin:0 auto 10px;border-radius:8px"><p style="margin:0 0 6px;line-height'); m2.extra.images = { recap: sample }; }
  send(m2);
  send(recapParts_(x, ev, null));
  console.log('Sent 5 test emails to ' + to + ' for ' + ev.name + ' (sample picture: ' + (sample ? 'yes' : 'not uploaded yet') + ').');
}

// ======================= social media folders (for Dallas) =======================
/**
 * Fills a Shared Drive (Script Property SOCIAL_DRIVE_ID) with each event's Instagram graphics, so the
 * social media team can post straight from it:
 *   2026-12 Border Wars/1 Players to Watch/   – when Player to Watch picks lock (player posts + stories, roundups)
 *   2026-12 Border Wars/2 All-Tournament Teams/ – when All-Star picks lock (one per division + Honorable Mention)
 * plus a Captions.txt in each folder. Graphics are re-checked every few hours while they can still change
 * (a parent adds a photo, say) and replaced when they do. The social media contact (SOCIAL_EMAIL, default
 * Dallas) gets one email when each folder first fills. Only players with a public profile are named.
 */
const SOCIAL_EMAIL_DEFAULT = 'eliuk35@usboxla.com';
const SOCIAL_REFRESH_HOURS = 3;

function socialRoot_() {
  const id = PropertiesService.getScriptProperties().getProperty('SOCIAL_DRIVE_ID');
  return id ? DriveApp.getFolderById(id) : null;
}

/** Runs from profileEmailsHourly. */
function socialHourly_(ctx, profileList) {
  const root = socialRoot_();
  if (!root) return;
  const log = {};
  readAll_('SocialFiles').forEach(function (r) { log[r.EventID + '|' + r.Path] = r; });
  const watch = publicWatch_(profileList), stars = publicAllStars_(profileList);
  const champs = publicChamps_();
  const bySlug = {};
  profileList.forEach(function (p) { if (p.slug) bySlug[p.slug] = p; });
  readEventsTab_().forEach(function (ev) {
    if (!ev.id || !ev.start) return;
    const data = ctx.eventData.filter(function (d) { return d.EventID === ev.id; })[0];
    if (!data) return;
    // Tier 3 events: graphics go to the director (event folder › Social Media Graphics), not the USBOXLA social drive.
    const premium = premiumEvent_(ev);
    if (!premium && (!data.FolderID || !ev.directorEmail)) return;
    let destCache = null;
    const dest = premium ? null : { get folder() { return (destCache = destCache || directorSocialDest_(ev, data)).folder; },
      email: ev.directorEmail, name: ev.directorName || '' };
    try {
      if (data.WatchStage === 'closed' && data.WatchClosed && hoursSince_(data.WatchClosed) >= WATCH_MAIL_WAIT_HOURS &&
          ev.end >= ctx.today && watch[ev.id]) socialStage_(root, ev, '1 Players to Watch', watchItems_(ev, watch[ev.id], bySlug), log, false, dest);
      if (data.AwardsStage === 'closed' && data.AwardsClosed && hoursSince_(data.AwardsClosed) >= RECAP_WAIT_HOURS &&
          ev.end >= PROFILE_MAIL_FROM && daysBetween_(ev.end, ctx.today) <= RECAP_MAX_AGE_DAYS && stars[ev.id])
        socialStage_(root, ev, ev.league ? '2 All-League Teams' : '2 All-Tournament Teams', (ev.league ? leagueAllTeamItems_ : allStarItems_)(ev, stars[ev.id], bySlug), log, false, dest);
      if (champs[ev.id] && ev.end <= ctx.today && daysBetween_(ev.end, ctx.today) <= CHAMP_DAYS_AFTER)
        socialStage_(root, ev, '3 Champions', (ev.league ? leagueChampItems_ : champItems_)(ev, champs[ev.id]), log, false, dest);
    } catch (err) { console.error('Social ' + ev.name + ': ' + err.message); }
  });
  try { sanctionedSocial_(root, log, false); } catch (err) { console.error('Sanctioned posts: ' + err.message); }
}

// ---------- "Now Sanctioned" posts ----------
// When a tournament first appears on usboxla.com/tourney (the daily import), its "Now Sanctioned" Instagram post
// (stats.usboxla.com/sanctioncard.php: the tournament logo, the sanctioned-event shield, name, dates, place) goes into
// the social drive under "<yyyy-mm> <event>/0 Sanctioned" with a caption, and social gets one email.
// Only tournaments imported after SANCTION_POST_FROM get one automatically; makeSanctionedPostsNow() does the rest.
const SANCTION_POST_FROM = '2026-10-11 19:00';
const SANCTION_STAGE = '0 Sanctioned';

/** Makes the posts that are due; returns [{name, folder}]. all = every upcoming tournament, not just new ones. */
/**
 * Upcoming tournaments from the Imports table, one per start date + city: a listing that was renamed on
 * usboxla.com/tourney shows up there twice, so keep its newest name (and remember when it was first added).
 * r.k is the stable key used by the graphic.
 */
function upcomingSanctioned_() {
  const today = todayIso_();
  const by = {};
  readImports_().forEach(function (r) {
    if (!r.Name || !r.StartDate || (r.EndDate || r.StartDate) < today) return;
    const key = r.StartDate + '|' + norm_(r.City) + '|' + norm_(r.State);
    const prev = by[key];
    const first = prev && String(prev.FirstAdded) < String(r.Added) ? prev.FirstAdded : r.Added;
    if (!prev || String(r.Added) >= String(prev.Added)) by[key] = r;
    by[key].FirstAdded = first;
    by[key].k = shortHash_(key);
  });
  return Object.keys(by).map(function (key) { return by[key]; })
    .sort(function (a, b) { return a.StartDate < b.StartDate ? -1 : a.StartDate > b.StartDate ? 1 : 0; });
}

function sanctionedSocial_(root, log, all, refresh) {
  const made = [];
  upcomingSanctioned_().forEach(function (r) {
    if (!all && String(r.FirstAdded) < SANCTION_POST_FROM) return;
    const k = r.k;
    const ev = { id: 'S-' + k, name: r.Name, start: r.StartDate, end: r.EndDate || r.StartDate };
    const doneKey = ev.id + '|' + SANCTION_STAGE + '/_done';
    if (log[doneKey] && !refresh) return;                               // one post per tournament
    if (log[doneKey]) log[doneKey] = Object.assign({}, log[doneKey], { UpdatedAt: '2000-01-01 00:00' });   // rebuild now
    try {
      const folder = socialStage_(root, ev, SANCTION_STAGE, sanctionItems_(r, k), log, true);
      if (folder) made.push({ name: r.Name, folder: folder });
    } catch (err) { console.error('Sanctioned ' + r.Name + ': ' + err.message); }
  });
  if (made.length && !refresh) notifySanctioned_(made, root);
  return made;
}

function sanctionItems_(r, k) {
  const place = [r.City, r.State].filter(Boolean).join(', ');
  const when = prettyRange_({ StartDate: r.StartDate, EndDate: r.EndDate || r.StartDate });
  const site = r.Website && /^https?:\/\//i.test(r.Website) ? r.Website : 'usboxla.com/tourney';
  const lines = [
    '🚨 NOW SANCTIONED: ' + r.Name.toUpperCase(),
    '📅 ' + when + (place ? '  📍 ' + place : ''),
    '',
    r.Name + ' is officially a USBOXLA Sanctioned Event! Get your team registered and make sure every player\'s USBOXLA membership is current.',
    '',
    'Register now 👉 ' + site,
    'All sanctioned events: usboxla.com/tourney',
    '',
    '#USBOXLA #boxlacrosse #SanctionedEvent #' + String(r.Name).replace(/[^A-Za-z0-9]/g, ''),
  ];
  return {
    images: [{ name: r.Name.replace(/[\/\\:*?"<>|]/g, '-') + ' – Now Sanctioned.jpg', url: STATS_SITE + '/sanctioncard.php?k=' + k }],
    captions: lines.join('\n'),
  };
}

function notifySanctioned_(made, root) {
  const to = PropertiesService.getScriptProperties().getProperty('SOCIAL_EMAIL') || SOCIAL_EMAIL_DEFAULT;
  const one = made.length === 1;
  sendMail_(to, one ? made[0].name + ' – Now Sanctioned post is ready' : made.length + ' Now Sanctioned posts are ready',
    one ? made[0].name + ' is now sanctioned' : 'New sanctioned tournaments',
    [(one ? 'A new tournament was' : made.length + ' tournaments were') + ' added to usboxla.com/tourney. The "Now Sanctioned" Instagram post and a ready-to-paste caption (Captions.txt) are in the USBOXLA Social Media drive:',
     made.map(function (m) { return m.name; }).join(' · '),
     'Each is in that event\'s folder under "' + SANCTION_STAGE + '". Post it whenever it fits the schedule.'],
    'Open the folder', (one ? made[0].folder : root).getUrl(), null, null, { name: 'USBOXLA Stats', footer: 'Automatic message from the USBOXLA stats system.' });
}

/** Admin: rebuilds every upcoming tournament's "Now Sanctioned" post after a design change (replaces the file, no email). */
function refreshSanctionedPostsNow() {
  const root = socialRoot_();
  if (!root) throw new Error('Set the SOCIAL_DRIVE_ID script property first.');
  const log = {};
  readAll_('SocialFiles').forEach(function (r) { log[r.EventID + '|' + r.Path] = r; });
  const made = sanctionedSocial_(root, log, true, true);
  console.log(made.length + ' post(s) checked: ' + made.map(function (m) { return m.name; }).join('; '));
}

/** Admin: makes a "Now Sanctioned" post for every upcoming tournament on usboxla.com/tourney that doesn't have one yet (one summary email). */
function makeSanctionedPostsNow() {
  const root = socialRoot_();
  if (!root) throw new Error('Set the SOCIAL_DRIVE_ID script property first.');
  const log = {};
  readAll_('SocialFiles').forEach(function (r) { log[r.EventID + '|' + r.Path] = r; });
  const made = sanctionedSocial_(root, log, true);
  console.log(made.length + ' post(s) made' + (made.length ? ': ' + made.map(function (m) { return m.name; }).join('; ') : '.'));
}

function socialName_(p) { return p ? (p.first + ' ' + p.last).trim() : ''; }
function eventTag_(ev) { return '#USBOXLA #boxlacrosse #' + String(ev.name).replace(/[^A-Za-z0-9]/g, ''); }

/** {images: [{name, url}], captions: text} for an event's Players to Watch. */
function watchItems_(ev, rows, bySlug) {
  const base = STATS_SITE + '/watchcard.php?e=' + encodeURIComponent(ev.id);
  const groups = {};
  rows.forEach(function (w) { const d = (w.division + ' ' + (w.tier || '')).trim(); (groups[d] = groups[d] || []).push(w); });
  const images = [], lines = ['⭐ PLAYERS TO WATCH – ' + ev.name.toUpperCase() + ' (' + prettyRange_({ StartDate: ev.start, EndDate: ev.end }) + ')', ''];
  Object.keys(groups).sort().forEach(function (d) {
    const list = groups[d].sort(function (a, b) { return a.team < b.team ? -1 : 1; });
    const parts = Math.max(1, Math.ceil(list.length / 20));
    for (let pg = 1; pg <= parts; pg++) ['post', 'story'].forEach(function (s) {
      images.push({ name: d.replace(/\//g, '-') + ' roundup' + (parts > 1 ? ' ' + pg + ' of ' + parts : '') + ' – ' + s + '.jpg',
        url: base + '&f=roundup&d=' + encodeURIComponent(d) + (s === 'story' ? '&s=story' : '') + (parts > 1 ? '&pg=' + pg : '') });
    });
    lines.push('— ' + d + ' — roundup caption:');
    lines.push('Meet the ' + d + ' Players to Watch at the ' + ev.name + '! Picked by their coaches. 👀');
    list.forEach(function (w) { lines.push('• ' + socialName_(bySlug[w.slug]) + ' – ' + w.team); });
    lines.push(eventTag_(ev) + ' #PlayersToWatch', '');
    list.forEach(function (w) {
      const n = socialName_(bySlug[w.slug]);
      ['post', 'story'].forEach(function (s) {
        images.push({ name: n + ' (' + w.team + ') – ' + s + '.jpg', url: base + '&p=' + encodeURIComponent(w.slug) + '&f=' + s });
      });
      lines.push(n + ' – single post caption:');
      lines.push('⭐ Player to Watch: ' + n + ' (' + w.team + ', ' + d + ') at the ' + ev.name + '.' + (w.blurb ? ' Coach says: “' + w.blurb + '”' : ''));
      lines.push(eventTag_(ev) + ' #PlayersToWatch', '');
    });
  });
  lines.push('Full list: ' + STATS_SITE.replace('https://', '') + '/watch.php?e=' + ev.id);
  return { images: images, captions: lines.join('\n') };
}

/** {images, captions} for an event's All-Tournament Teams. */
function allStarItems_(ev, rows, bySlug) {
  const base = STATS_SITE + '/allstarcard.php?e=' + encodeURIComponent(ev.id);
  const groups = {};
  rows.forEach(function (a) { const d = (a.division + ' ' + (a.tier || '')).trim(); (groups[d] = groups[d] || []).push(a); });
  const order = ['mvp', 'first_team', 'goalie', 'second_team', 'goalie2', 'honors'];
  const images = [], lines = ['🏆 ALL-TOURNAMENT TEAMS – ' + ev.name.toUpperCase(), ''];
  let honors = false;
  Object.keys(groups).sort().forEach(function (d) {
    images.push({ name: d.replace(/\//g, '-') + ' All-Tournament Team.jpg', url: base + '&d=' + encodeURIComponent(d) });
    lines.push('— ' + d + ' — caption:');
    lines.push('🏆 ' + ev.name + ' ' + d + ' All-Tournament Team, picked by the coaches.');
    order.forEach(function (k) {
      const who = groups[d].filter(function (a) { return a.award === k; }).sort(function (a, b) { return a.slot - b.slot; })
        .map(function (a) { const n = socialName_(bySlug[a.slug]); return n ? n + ' (' + a.team + ')' : a.team; });
      if (!who.length) return;
      if (k === 'honors') { honors = true; return; }
      lines.push((AWARD_NAMES[k] || k).replace('All-Tournament ', '') + ': ' + who.join(', '));
    });
    lines.push(eventTag_(ev) + ' #AllTournament', '');
  });
  if (honors) {
    for (let pg = 1; pg <= 6; pg++) images.push({ name: 'Honorable Mention ' + pg + '.jpg', url: base + '&hm=1&pg=' + pg, optional: pg > 1 });
    lines.push('Honorable Mention caption:', 'Congratulations to every All-Tournament Honorable Mention at the ' + ev.name + '! 👏', eventTag_(ev), '');
  }
  lines.push('Names are shown only for players with a public USBOXLA profile; others are listed by team.');
  return { images: images, captions: lines.join('\n') };
}

/** {images, captions} for an event's medal teams. */
function champItems_(ev, rows) {
  const base = STATS_SITE + '/champcard.php?e=' + encodeURIComponent(ev.id);
  const order = { gold: 1, silver: 2, bronze: 3 };
  const words = { gold: ['Champions', '🏆'], silver: ['Silver Medalists', '🥈'], bronze: ['Bronze Medalists', '🥉'] };
  const images = [], lines = ['🏆 MEDAL TEAMS – ' + ev.name.toUpperCase(), ''];
  rows.slice().sort(function (a, b) { return a.division < b.division ? -1 : a.division > b.division ? 1 : order[a.medal] - order[b.medal]; })
    .forEach(function (c) {
      const w = words[c.medal] || words.gold;
      images.push({ name: c.division.replace(/\//g, '-') + ' ' + w[0] + ' – ' + c.team + '.jpg',
        url: base + '&d=' + encodeURIComponent(c.division) + '&m=' + c.medal });
      lines.push('— ' + c.division + ' ' + w[0] + ' — caption:');
      lines.push(w[1] + ' Congratulations to ' + c.team + ', ' + c.division + ' ' + w[0] + ' at the ' + ev.name + '!');
      lines.push(eventTag_(ev) + ' #Champions', '');
    });
  return { images: images, captions: lines.join('\n') };
}

/** Makes sure one stage folder has every image (replacing any that changed) and the captions; emails the first time. */
function socialStage_(root, ev, stage, items, log, quiet, dest) {
  const doneKey = ev.id + '|' + stage + '/_done';
  const done = log[doneKey];
  if (done && hoursSince_(done.UpdatedAt) < SOCIAL_REFRESH_HOURS) return;
  const evFolder = dest ? dest.folder : childFolder_(root, ev.start.slice(0, 7) + ' ' + ev.name);
  const folder = childFolder_(evFolder, stage);
  let count = 0, seenMd5 = {};
  items.images.forEach(function (it) {
    let r;
    try { r = UrlFetchApp.fetch(it.url, { muteHttpExceptions: true }); } catch (err) { console.error(err); return; }
    if (r.getResponseCode() !== 200 || !/^image\//.test(String(r.getHeaders()['Content-Type'] || r.getBlob().getContentType()))) return;
    const bytes = r.getContent();
    const md5 = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes));
    if (it.optional && seenMd5[md5]) return;                     // past the last Honorable Mention page
    seenMd5[md5] = true;
    count++;
    const key = ev.id + '|' + stage + '/' + it.name;
    const prev = log[key];
    if (prev && prev.Md5 === md5) return;                        // unchanged
    if (prev && prev.FileID) { try { DriveApp.getFileById(prev.FileID).setTrashed(true); } catch (err) { /* already gone */ } }
    const file = folder.createFile(Utilities.newBlob(bytes, 'image/jpeg', it.name));
    socialLog_(log, key, { EventID: ev.id, Path: stage + '/' + it.name, FileID: file.getId(), Md5: md5 });
  });
  const capKey = ev.id + '|' + stage + '/Captions.txt';
  const cap = log[capKey];
  let capFile = null;
  try { capFile = cap && cap.FileID ? DriveApp.getFileById(cap.FileID) : null; } catch (err) { capFile = null; }
  if (capFile) capFile.setContent(items.captions);
  else socialLog_(log, capKey, { EventID: ev.id, Path: stage + '/Captions.txt', FileID: folder.createFile('Captions.txt', items.captions, MimeType.PLAIN_TEXT).getId(), Md5: '' });
  if (!done && count && !quiet) { if (dest) notifyDirectorSocial_(ev, stage, count, folder, dest); else notifySocial_(ev, stage, count, folder); }
  if (count) socialLog_(log, doneKey, { EventID: ev.id, Path: stage + '/_done', FileID: folder.getId(), Md5: String(count) });
  return count ? folder : null;
}

function childFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function socialLog_(log, key, row) {
  row.UpdatedAt = nowText_();
  const prev = log[key];
  if (prev) { row._row = prev._row; update_('SocialFiles', row); } else insert_('SocialFiles', row);
  log[key] = row;
}

/** Tier 3 events: {folder} – the "Social Media Graphics" folder inside the event's Drive folder, shared with the director (made the first time). */
const DIRECTOR_SOCIAL_FOLDER = 'Social Media Graphics';
function directorSocialDest_(ev, data) {
  const parent = DriveApp.getFolderById(data.FolderID);
  const it = parent.getFoldersByName(DIRECTOR_SOCIAL_FOLDER);
  let folder;
  if (it.hasNext()) folder = it.next();
  else {
    folder = parent.createFolder(DIRECTOR_SOCIAL_FOLDER);
    try { folder.addEditor(ev.directorEmail); } catch (err) { console.error(err); }
  }
  return { folder: folder };
}

function notifyDirectorSocial_(ev, stage, count, folder, dest) {
  const what = stage.replace(/^\d+ /, '');
  sendMail_(dest.email, ev.name + ' – your ' + what + ' graphics are ready (' + count + ')', ev.name + ': ' + what + ' graphics are ready',
    [(dest.name ? 'Hi ' + dest.name.split(' ')[0] + ',' : 'Hi,'),
     count + ' branded graphics for your ' + ev.name + ' ' + what + ' are ready to post, with ready-to-paste captions in Captions.txt.',
     'Post them on your event\'s social media and tag @usboxla. If a family updates a photo, the graphic in the folder is replaced automatically within a few hours – grab the newest file when you post.'],
    'Open the folder', folder.getUrl(), null, null, { name: 'USBOXLA Stats', footer: 'Automatic message from the USBOXLA stats system.' });
}

function notifySocial_(ev, stage, count, folder) {
  const list = [PropertiesService.getScriptProperties().getProperty('SOCIAL_EMAIL') || SOCIAL_EMAIL_DEFAULT];
  if (ev.league) { const se = seLeague_(ev); if (!se || se.media) list.push(se ? se.media : leagueMediaEmail_()); }   // the league's own media contact (TC: the director)
  const what = stage.replace(/^\d+ /, '');
  list.forEach(function (to) {
    sendMail_(to, ev.name + ' – ' + what + ' graphics are ready (' + count + ')', ev.name + ': ' + what + ' graphics are ready',
      [count + ' graphics for the ' + ev.name + ' ' + what + ' are in the USBOXLA Social Media drive, with ready-to-paste captions in Captions.txt.',
       'If a family updates a photo, the graphic in the folder is replaced automatically within a few hours – grab the newest file when you post.'],
      'Open the folder', folder.getUrl(), null, null, { name: 'USBOXLA Stats', footer: 'Automatic message from the USBOXLA stats system.' });
  });
}
