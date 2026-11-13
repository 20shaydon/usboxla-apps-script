/**
 * InvoiceCleanup.gs – one-time clean-up of old unpaid Wild Apricot invoices (Nov 6, 2026).
 *
 * listOldOpenInvoices()  READ-ONLY. Writes every unpaid invoice to the Hub tab "Invoice Cleanup"
 *                        with a Plan column: VOID or KEEP (with the reason). Changes nothing in Wild Apricot.
 *
 * Plan rules: VOID only if ALL are true –
 *   membership invoice (application, renewal or level change), nothing paid on it,
 *   more than 90 days old, and $100 or less. Everything else is KEEP.
 */
const IC_SHEET = 'Invoice Cleanup';
const IC_HEADERS = ['Invoice ID', 'Number', 'Date', 'Age (days)', 'Contact', 'Contact ID', 'Type', 'Amount', 'Paid', 'Balance', 'Plan', 'Reason', 'Result'];
const IC_MEMBERSHIP_TYPES = ['MembershipApplication', 'MembershipRenewal', 'MembershipLevelChange'];

function icFetchUnpaid_() {
  const all = [];
  let skip = 0;
  while (true) {
    const data = waGet_('/invoices?unpaidOnly=true&$top=100&$skip=' + skip);
    const list = Array.isArray(data) ? data : ((data && data.Invoices) || []);
    list.forEach(function (x) { all.push(x); });
    if (list.length < 100) break;
    skip += 100;
    Utilities.sleep(400);
    if (skip > 20000) break;
  }
  return all;
}

function listOldOpenInvoices() {
  const inv = icFetchUnpaid_();
  if (!inv.length) { console.log('No unpaid invoices returned.'); return; }
  console.log('First invoice fields: ' + Object.keys(inv[0]).join(', '));
  const today = new Date();
  const seen = {};
  const rows = [];
  const sum = { VOID: [0, 0], KEEP: [0, 0] };
  const reasons = {};
  inv.forEach(function (x) {
    if (seen[x.Id]) return; seen[x.Id] = true;
    const date = x.DocumentDate ? new Date(x.DocumentDate) : null;
    const age = date ? Math.floor((today - date) / 86400000) : '';
    const amount = Number(x.Value || 0);
    const paid = Number(x.PaidAmount || 0);
    const bal = Math.round((amount - paid) * 100) / 100;
    const type = x.OrderType || '';
    let reason = '';
    if (IC_MEMBERSHIP_TYPES.indexOf(type) === -1) reason = 'not a membership invoice';
    else if (paid > 0) reason = 'partly paid';
    else if (age === '' || age <= 90) reason = '90 days old or newer';
    else if (amount > 100) reason = 'over $100 – review';
    const plan = reason ? 'KEEP' : 'VOID';
    sum[plan][0]++; sum[plan][1] += bal;
    if (reason) reasons[reason] = (reasons[reason] || 0) + 1;
    rows.push([x.Id, x.DocumentNumber || '', date ? toIsoDate_(date) : '', age, (x.Contact && x.Contact.Name) || '',
      (x.Contact && x.Contact.Id) || '', type, amount.toFixed(2), paid.toFixed(2), bal.toFixed(2), plan, reason, '']);
  });
  rows.sort(function (a, b) { return a[10] === b[10] ? String(a[2]).localeCompare(String(b[2])) : (a[10] === 'VOID' ? -1 : 1); });
  const ss = hub_();
  let sh = ss.getSheetByName(IC_SHEET);
  if (sh) sh.clear(); else sh = ss.insertSheet(IC_SHEET);
  writeRows_(sh, 1, [IC_HEADERS]);
  sh.getRange(1, 1, 1, IC_HEADERS.length).setFontWeight('bold');
  sh.setFrozenRows(1);
  writeRows_(sh, 2, rows);
  console.log('Unpaid invoices: ' + rows.length);
  console.log('VOID: ' + sum.VOID[0] + ' invoice(s), $' + sum.VOID[1].toFixed(2));
  console.log('KEEP: ' + sum.KEEP[0] + ' invoice(s), $' + sum.KEEP[1].toFixed(2) + ' – ' + JSON.stringify(reasons));
  const types = {}; rows.forEach(function (r) { types[r[6]] = (types[r[6]] || 0) + 1; });
  console.log('By type: ' + JSON.stringify(types));
}

// ---------- voiding (only rows marked VOID with an empty Result) ----------
// voidOneOldInvoiceTest()  voids just the first VOID row, as a test.
// voidOldOpenInvoices()    voids the rest, about 5 minutes per run; run again until it logs "All done".
// Each row's Result column shows "voided <time>" or the error. Voiding can't be undone, but the invoice stays on file.

function icVoid_(invoiceId, retried) {
  const auth = getAuth_(retried);
  const res = UrlFetchApp.fetch('https://api.wildapricot.org/v2.2/rpc/' + auth.accountId + '/VoidInvoice?invoiceId=' + encodeURIComponent(invoiceId), {
    method: 'post', headers: { Authorization: 'Bearer ' + auth.token, Accept: 'application/json' }, muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if ((code === 401 || code === 403) && !retried) return icVoid_(invoiceId, true); // token may predate the access change
  if (code !== 200) throw new Error('HTTP ' + code + ' ' + res.getContentText().slice(0, 200));
}

function icRun_(limit) {
  const sh = hub_().getSheetByName(IC_SHEET);
  if (!sh) throw new Error('Run listOldOpenInvoices first.');
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, IC_HEADERS.length).getValues();
  const todo = [];
  rows.forEach(function (r, i) { if (r[10] === 'VOID' && String(r[12]).indexOf('voided') !== 0) todo.push(i); });
  const start = Date.now();
  let done = 0, failed = 0, pos = 0;
  let auth = getAuth_(true);
  while (pos < todo.length && done + failed < limit && Date.now() - start < 300000) {
    const chunk = todo.slice(pos, pos + Math.min(10, limit - done - failed));
    const reqs = chunk.map(function (i) {
      return { url: 'https://api.wildapricot.org/v2.2/rpc/' + auth.accountId + '/VoidInvoice?invoiceId=' + encodeURIComponent(rows[i][0]),
        method: 'post', headers: { Authorization: 'Bearer ' + auth.token, Accept: 'application/json' }, muteHttpExceptions: true };
    });
    const res = UrlFetchApp.fetchAll(reqs);
    if (res.some(function (x) { return x.getResponseCode() === 429; })) { Utilities.sleep(10000); auth = getAuth_(true); continue; }
    if (res.some(function (x) { return x.getResponseCode() === 401; })) { auth = getAuth_(true); continue; }
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    res.forEach(function (x, k) {
      const i = chunk[k];
      const ok = x.getResponseCode() === 200;
      const out = ok ? 'voided ' + stamp : 'ERROR HTTP ' + x.getResponseCode() + ' ' + x.getContentText().slice(0, 150);
      if (ok) done++; else { failed++; console.log('Invoice ' + rows[i][0] + ': ' + out); }
      rows[i][12] = out;
      sh.getRange(i + 2, 13).setValue(out);
    });
    pos += chunk.length;
    if (failed >= 20 && done === 0) { console.log('Stopping: too many errors.'); break; }
  }
  const left = todo.length - pos;
  console.log('Voided ' + done + ', errors ' + failed + ', still to do ' + left + '.' + (left ? ' Run voidOldOpenInvoices again.' : ' All done.'));
}

function voidOneOldInvoiceTest() { icRun_(1); }
function voidOldOpenInvoices() { icRun_(100000); }

/** Shaydon approved (Nov 6) voiding Ben Prepchuk's $5,000 open invoice. Marks that row VOID for the next run. */
function approvePrepchukInvoice() {
  const sh = hub_().getSheetByName(IC_SHEET);
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, IC_HEADERS.length).getValues();
  let n = 0;
  rows.forEach(function (r, i) {
    if (/prepchuk/i.test(r[4]) && Number(r[9]) === 5000 && r[10] === 'KEEP') {
      sh.getRange(i + 2, 11, 1, 2).setValues([['VOID', 'approved by Shaydon Nov 6']]); n++;
      console.log('Marked invoice ' + r[0] + ' (' + r[4] + ', $' + r[9] + ', ' + r[6] + ', ' + r[2] + ') to void.');
    }
  });
  if (!n) console.log('No matching Prepchuk $5,000 row found.');
}


/** Shaydon approved (Nov 6, 8:36 PM) voiding the three review invoices: DeCock $500, Chambers $500, Hyatt $225. Marks and voids them. */
function voidReviewInvoices() {
  const sh = hub_().getSheetByName(IC_SHEET);
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, IC_HEADERS.length).getValues();
  const want = [[/decock/i, 500], [/chambers/i, 500], [/hyatt/i, 225]];
  let n = 0;
  rows.forEach(function (r, i) {
    const hit = want.some(function (w) { return w[0].test(r[4]) && Number(r[9]) === w[1]; });
    if (hit && r[10] === 'KEEP') {
      sh.getRange(i + 2, 11, 1, 2).setValues([['VOID', 'approved by Shaydon Nov 6 (review)']]); n++;
      console.log('Marked invoice ' + r[0] + ' (' + r[4] + ', $' + r[9] + ', ' + r[6] + ', ' + r[2] + ') to void.');
    }
  });
  console.log('Marked ' + n + ' of 3.');
  if (n) icRun_(n);
}
