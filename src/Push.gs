/**
 * Push.gs – sends the public stats feed to stats.usboxla.com every 10 minutes (push.php saves it), so site visitors
 * always get the saved copy instantly and never wait for this script to build the feed.
 * Setup: run installStatsPushTrigger once from the editor. Triggers run the saved code, so no new deployment is needed.
 */
const STATS_PUSH_URL = 'https://stats.usboxla.com/push.php';
const STATS_PUSH_KEY_DEFAULT = '42c71ed09a37050e4bda14d24a57704ef485855f3b637e30';   // must match pushkey.php on the site

function statsPushKey_() {
  return PropertiesService.getScriptProperties().getProperty('STATS_PUSH_KEY') || STATS_PUSH_KEY_DEFAULT;
}

/** Builds the feed (same as ?api=stats) and sends it to the site. */
function pushStatsFeed() {
  const started = Date.now();
  const json = JSON.stringify(publicFeed_());
  // Sent base64-encoded: IONOS's firewall rejects the full feed as plain JSON (HTTP 400). push.php decodes it.
  const body = Utilities.base64Encode(json, Utilities.Charset.UTF_8);
  const res = UrlFetchApp.fetch(STATS_PUSH_URL, {
    method: 'post', contentType: 'text/plain', payload: body,
    headers: { 'X-Push-Key': statsPushKey_() }, muteHttpExceptions: true
  });
  const code = res.getResponseCode(), text = res.getContentText();
  if (code !== 200) throw new Error('Stats push failed: HTTP ' + code + ' ' + text.slice(0, 200));
  console.log('Stats feed pushed in ' + Math.round((Date.now() - started) / 1000) + 's: ' + text);
  return text;
}

/** Run once: saves the key, (re)creates the 10-minute trigger and pushes right away. */
function installStatsPushTrigger() {
  PropertiesService.getScriptProperties().setProperty('STATS_PUSH_KEY', statsPushKey_());
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pushStatsFeed') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('pushStatsFeed').timeBased().everyMinutes(10).create();
  return pushStatsFeed();
}